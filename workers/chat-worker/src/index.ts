import { DurableObject } from 'cloudflare:workers';

export interface Env {
	CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
	TURNSTILE_SECRET?: string;
	TURNSTILE_HOSTNAMES?: string;
	CHAT_ADMIN_TOKEN?: string;
	// Shared with the app: signs short-lived chat identities (uid + display name).
	CHAT_IDENTITY_SECRET?: string;
}

export interface ChatMessage {
	id: string;
	ts: number;
	name: string;
	content: string;
	userId: string | null;
	gif?: GifMedia | null;
	reactions?: Record<string, number>;
	my?: string[];
	/** True when this connection authored the message (per-connection). */
	mine?: boolean;
	/** True for soft-deleted messages (admin moderation view only). */
	deleted?: boolean;
	/** Moment in the episode recording, in seconds. */
	atSeconds?: number | null;
	/** Root comment when this message is a reply. */
	parentId?: string | null;
}

/** A Giphy GIF attached to a chat message (URLs only — no bytes stored). */
export interface GifMedia {
	url: string;
	preview?: string | null;
	width?: number | null;
	height?: number | null;
}

interface ConnectionMeta {
	name: string;
	uid: string | null;
	pid: string | null;
	lastTs: number;
}

interface IdentityPayload {
	uid: string;
	name: string;
	exp: number;
}

const HISTORY_LIMIT = 299;
const MAX_STORED = 10000;
const RATE_LIMIT_MS = 500;
const MAX_CONTENT_LENGTH = 500;
const MAX_NAME_LENGTH = 40;
const MAX_GIF_URL_LENGTH = 2048;
const MAX_AT_SECONDS = 24 * 60 * 60;

/** Rooms are `main` or an episode key minted by the app. */
function isValidRoom(room: string): boolean {
	return room === 'main' || /^episode:[A-Za-z0-9_-]+:\d{4}-\d{2}-\d{2}$/.test(room);
}

/** Validate a comment's episode position. */
function parseAt(raw: unknown): number | null {
	const n = typeof raw === 'number' ? raw : Number(raw);
	if (!Number.isFinite(n) || n < 0 || n > MAX_AT_SECONDS) return null;
	return Math.floor(n);
}

/**
 * Per-room chat: WebSockets + SQLite persistence. One instance per room (named
 * via `env.CHAT_ROOM.getByName(room)`), so message history is co-located with
 * the live connections that write it.
 */
export class ChatRoom extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => this.migrate());
	}

	/**
	 * SQLite schema lives in the DO's own storage. `PRAGMA user_version` is not
	 * supported in DO SQLite, so track applied migrations in a table instead.
	 */
	private migrate() {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
				id INTEGER PRIMARY KEY,
				applied_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
		const { version } = this.ctx.storage.sql
			.exec<{ version: number }>(
				'SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations'
			)
			.one();
		if (version < 1) {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS messages (
					id TEXT PRIMARY KEY,
					ts INTEGER NOT NULL,
					name TEXT NOT NULL,
					content TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages (ts);
				INSERT INTO _sql_schema_migrations (id) VALUES (1);
			`);
		}
		if (version < 2) {
			this.ctx.storage.sql.exec(`
				ALTER TABLE messages ADD COLUMN user_id TEXT;
				CREATE INDEX IF NOT EXISTS idx_messages_user ON messages (user_id);
				INSERT INTO _sql_schema_migrations (id) VALUES (2);
			`);
		}
		if (version < 3) {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS chat_meta (
					key TEXT PRIMARY KEY,
					value INTEGER NOT NULL
				);
				INSERT INTO _sql_schema_migrations (id) VALUES (3);
			`);
		}
		if (version < 4) {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS reactions (
					message_id TEXT NOT NULL,
					user_key TEXT NOT NULL,
					emoji TEXT NOT NULL DEFAULT 'heart',
					created_at INTEGER NOT NULL,
					PRIMARY KEY (message_id, user_key, emoji)
				);
				CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions (message_id);
				INSERT INTO _sql_schema_migrations (id) VALUES (4);
			`);
		}
		if (version < 5) {
			this.ctx.storage.sql.exec(`
				ALTER TABLE messages ADD COLUMN gif_url TEXT;
				ALTER TABLE messages ADD COLUMN gif_preview TEXT;
				ALTER TABLE messages ADD COLUMN gif_width INTEGER;
				ALTER TABLE messages ADD COLUMN gif_height INTEGER;
				INSERT INTO _sql_schema_migrations (id) VALUES (5);
			`);
		}
		if (version < 6) {
			// pid: anonymous ownership key. deleted_*: soft-delete (tombstone) trail.
			this.ctx.storage.sql.exec(`
				ALTER TABLE messages ADD COLUMN pid TEXT;
				ALTER TABLE messages ADD COLUMN deleted_at INTEGER;
				ALTER TABLE messages ADD COLUMN deleted_by TEXT;
				CREATE INDEX IF NOT EXISTS idx_messages_pid ON messages (pid);
				CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages (deleted_at);
				INSERT INTO _sql_schema_migrations (id) VALUES (6);
			`);
		}
		if (version < 7) {
			// Author names must never expose email addresses. Older app identities
			// fell back to the account email when no display name was set; rewrite
			// those already-stored messages (signed-in rows only — anonymous
			// handles are left alone). Idempotent, so a re-run is harmless.
			this.ctx.storage.sql.exec(`
				UPDATE messages SET name = 'Listener'
				WHERE user_id IS NOT NULL AND instr(name, '@') > 0;
				INSERT INTO _sql_schema_migrations (id) VALUES (7);
			`);
		}
		if (version < 8) {
			// Episode comments: timestamp in the recording + one-level replies.
			this.ctx.storage.sql.exec(`
				ALTER TABLE messages ADD COLUMN at_seconds INTEGER;
				ALTER TABLE messages ADD COLUMN parent_id TEXT;
				CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages (parent_id);
				INSERT INTO _sql_schema_migrations (id) VALUES (8);
			`);
		}
	}

	/** Allocate the next anonymous handle: `Listener N` (per room, sequential). */
	private nextListenerName(): string {
		const row = this.ctx.storage.sql
			.exec<{ value: number }>(
				`INSERT INTO chat_meta (key, value) VALUES ('seq', 1)
				 ON CONFLICT(key) DO UPDATE SET value = value + 1
				 RETURNING value`
			)
			.one();
		return `Listener ${row.value}`;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const upgrade = request.headers.get('Upgrade');

		if (upgrade === 'websocket') {
			// Gate the handshake with a Turnstile token when configured.
			if (this.env.TURNSTILE_SECRET) {
				const ok = await verifyTurnstile(
					url.searchParams.get('turnstile'),
					this.env.TURNSTILE_SECRET,
					this.env.TURNSTILE_HOSTNAMES,
					request.headers.get('CF-Connecting-IP')
				);
				if (!ok) {
					return new Response('Forbidden', { status: 403 });
				}
			}
			const token = url.searchParams.get('token');
			let name = (url.searchParams.get('name') || '').slice(0, MAX_NAME_LENGTH);
			let uid: string | null = null;
			if (token) {
				const identity = await this.verifyIdentity(token);
				if (!identity) return new Response('Unauthorized', { status: 401 });
				uid = identity.uid;
				// Belt and braces: never persist/broadcast an email as a name, even
				// if a token was minted before the app stopped sending them.
				name = identity.name.slice(0, MAX_NAME_LENGTH);
				if (name.includes('@')) name = 'Listener';
			} else if (!name && url.searchParams.get('anonymous') === '1') {
				name = this.nextListenerName();
			}
			if (!name) name = 'Listener';
			const pid = (url.searchParams.get('pid') || '').slice(0, 64) || null;
			const pair = new WebSocketPair();
			pair[1].serializeAttachment({ name, uid, pid, lastTs: 0 } satisfies ConnectionMeta);
			this.ctx.acceptWebSocket(pair[1]);
			pair[1].send(JSON.stringify({ type: 'history', messages: this.recent(HISTORY_LIMIT, uid, pid) }));
			pair[1].send(JSON.stringify({ type: 'name', name }));
			return new Response(null, { status: 101, webSocket: pair[0] });
		}

		// Plain HTTP: health check or history snapshot.
		if (url.pathname === '/api/health') {
			return Response.json({ ok: true });
		}
		if (url.pathname === '/api/history') {
			return Response.json({ messages: this.recent(HISTORY_LIMIT, null, null) });
		}

		// Admin moderation (bearer token shared with the app).
		const adminOk = this.env.CHAT_ADMIN_TOKEN
			? request.headers.get('authorization') === `Bearer ${this.env.CHAT_ADMIN_TOKEN}`
			: false;
		if (!adminOk) return new Response('Unauthorized', { status: 401 });

		// Admin moderation view: newest-first, includes soft-deleted, keyset-paged.
		if (request.method === 'GET' && url.pathname === '/api/admin/history') {
			const rawLimit = Number(url.searchParams.get('limit') ?? '100');
			const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 100;
			return Response.json(
				this.adminHistory(limit, url.searchParams.get('beforeTs'), url.searchParams.get('beforeId'))
			);
		}

		const del = url.pathname.match(/^\/api\/messages\/([A-Za-z0-9-]+)$/);
		if (request.method === 'DELETE' && del) {
			const id = decodeURIComponent(del[1]);
			const target = this.ctx.storage.sql
				.exec<{ parent_id: string | null }>('SELECT parent_id FROM messages WHERE id = ?', id)
				.toArray()[0];
			if (!target) return Response.json({ ok: true, deleted: 0 });
			// Deleting a top-level comment also removes its replies.
			const ids =
				target.parent_id === null
					? this.ctx.storage.sql
							.exec<{ id: string }>('SELECT id FROM messages WHERE id = ? OR parent_id = ?', id, id)
							.toArray()
							.map((r) => String(r.id))
					: [id];
			let deleted = 0;
			for (const rowId of ids) {
				const cursor = this.ctx.storage.sql.exec(
					'UPDATE messages SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL',
					Date.now(),
					'admin',
					rowId
				);
				cursor.toArray();
				if (cursor.rowsWritten > 0) {
					deleted++;
					this.broadcast({ type: 'deleted', id: rowId });
				}
			}
			return Response.json({ ok: true, deleted });
		}

		if (request.method === 'POST' && url.pathname === '/api/messages/purge') {
			let name = '';
			let userId = '';
			try {
				const body = (await request.json()) as { name?: unknown; userId?: unknown };
				name = String(body.name ?? '').trim();
				userId = String(body.userId ?? '').trim();
			} catch {
				// ignore malformed bodies
			}
			if (userId) {
				this.ctx.storage.sql.exec(
					'DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE user_id = ?)',
					userId
				);
				this.ctx.storage.sql.exec('DELETE FROM messages WHERE user_id = ?', userId);
				this.broadcast({ type: 'purged', userId });
				return Response.json({ ok: true, deleted: 1 });
			}
			if (!name) return Response.json({ ok: false, deleted: 0 }, { status: 400 });
			this.ctx.storage.sql.exec(
				'DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE name = ?)',
				name
			);
			this.ctx.storage.sql.exec('DELETE FROM messages WHERE name = ?', name);
			this.broadcast({ type: 'purged', name });
			return Response.json({ ok: true, deleted: 1 });
		}

		return new Response('Not found', { status: 404 });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		let data: {
			type?: string;
			content?: unknown;
			gif?: unknown;
			id?: unknown;
			emoji?: unknown;
			at?: unknown;
			parentId?: unknown;
		};
		try {
			data = JSON.parse(String(message));
		} catch {
			return;
		}

		const meta =
			(ws.deserializeAttachment() as ConnectionMeta | null) ?? { name: 'Listener', uid: null, pid: null, lastTs: 0 };

		if (data.type === 'react') {
			this.handleReaction(ws, meta, data);
			return;
		}
		if (data.type === 'delete') {
			this.handleDelete(ws, meta, data.id);
			return;
		}
		if (data.type !== 'message') return;

		const content = String(data.content ?? '')
			.trim()
			.slice(0, MAX_CONTENT_LENGTH);
		const gif = sanitizeGif(data.gif);
		if (!content && !gif) return;
		const now = Date.now();
		if (now - meta.lastTs < RATE_LIMIT_MS) {
			ws.send(JSON.stringify({ type: 'error', message: 'Slow down a little.' }));
			return;
		}

		let atSeconds = parseAt(data.at);
		let parentId: string | null = null;
		if (typeof data.parentId === 'string' && /^[\w-]{1,64}$/.test(data.parentId)) {
			const parent = this.ctx.storage.sql
				.exec<{ id: string; parent_id: string | null; at_seconds: number | null; deleted_at: number | null }>(
					'SELECT id, parent_id, at_seconds, deleted_at FROM messages WHERE id = ?',
					data.parentId
				)
				.toArray()[0];
			if (!parent || parent.deleted_at !== null) {
				ws.send(JSON.stringify({ type: 'error', message: 'That comment is no longer available.' }));
				return;
			}
			// One level only: a reply to a reply attaches to the root.
			parentId = parent.parent_id ?? parent.id;
			atSeconds = parent.at_seconds == null ? null : Number(parent.at_seconds);
		}

		ws.serializeAttachment({ ...meta, lastTs: now });

		const chatMessage = this.insert(meta.name, content, meta.uid, gif, meta.pid, atSeconds, parentId);
		this.broadcastMessage(chatMessage, meta);
	}

	async webSocketClose(_ws: WebSocket) {
		// Hibernation API: the connection is removed automatically on close.
	}

	/** Toggle a reaction (heart) on a message; broadcasts the new count. */
	private handleReaction(ws: WebSocket, meta: ConnectionMeta, data: { id?: unknown; emoji?: unknown }) {
		const id = String(data.id ?? '').slice(0, 64);
		const emoji = String(data.emoji ?? 'heart').slice(0, 16);
		if (!id || !/^[\w-]{1,64}$/.test(id)) return;
		const key = meta.uid ?? meta.pid;
		if (!key) return;

		const existing = this.ctx.storage.sql
			.exec('SELECT 1 FROM reactions WHERE message_id = ? AND user_key = ? AND emoji = ?', id, key, emoji)
			.toArray();
		if (existing.length > 0) {
			this.ctx.storage.sql.exec(
				'DELETE FROM reactions WHERE message_id = ? AND user_key = ? AND emoji = ?',
				id,
				key,
				emoji
			);
		} else {
			this.ctx.storage.sql.exec(
				'INSERT INTO reactions (message_id, user_key, emoji, created_at) VALUES (?, ?, ?, ?)',
				id,
				key,
				emoji,
				Date.now()
			);
		}
		const count = Number(
			this.ctx.storage.sql
				.exec('SELECT count(*) AS c FROM reactions WHERE message_id = ? AND emoji = ?', id, emoji)
				.one().c
		);
		this.broadcast({ type: 'reacted', id, emoji, count });
	}

	private insert(
		name: string,
		content: string,
		userId: string | null,
		gif: GifMedia | null,
		pid: string | null,
		atSeconds: number | null,
		parentId: string | null
	): ChatMessage {
		const msg: ChatMessage = {
			id: crypto.randomUUID(),
			ts: Date.now(),
			name,
			content,
			userId,
			...(gif ? { gif } : {}),
			...(atSeconds === null ? {} : { atSeconds }),
			...(parentId === null ? {} : { parentId })
		};
		this.ctx.storage.sql.exec(
			'INSERT INTO messages (id, ts, name, content, user_id, pid, gif_url, gif_preview, gif_width, gif_height, at_seconds, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
			msg.id,
			msg.ts,
			msg.name,
			msg.content,
			msg.userId,
			pid,
			gif?.url ?? null,
			gif?.preview ?? null,
			gif?.width ?? null,
			gif?.height ?? null,
			atSeconds,
			parentId
		);
		// Keep stored history bounded; delete oldest beyond the cap.
		this.ctx.storage.sql.exec(
			`DELETE FROM messages WHERE id IN (
				SELECT id FROM messages ORDER BY ts DESC LIMIT -1 OFFSET ?
			)`,
			MAX_STORED
		);
		return msg;
	}

	/** Author ownership: signed-in by uid; anonymous by pid (never crossed). */
	private ownsRow(
		uid: string | null,
		pid: string | null,
		owner: { user_id: string | null; pid: string | null }
	): boolean {
		if (uid) return owner.user_id === uid;
		if (!pid) return false;
		return owner.user_id === null && owner.pid === pid;
	}

	private recent(limit: number, uid: string | null, pid: string | null): ChatMessage[] {
		const rows = this.ctx.storage.sql
			.exec<Record<string, string | number | null>>(
				`SELECT id, ts, name, content, user_id, pid, gif_url, gif_preview, gif_width, gif_height, at_seconds, parent_id
				 FROM messages WHERE deleted_at IS NULL ORDER BY ts DESC LIMIT ?`,
				limit
			)
			.toArray()
			.reverse();

		const counts: Record<string, Record<string, number>> = {};
		const mine: Record<string, string[]> = {};
		if (rows.length > 0) {
			// Windowed join binds the same LIMIT rather than one parameter per id,
			// so this stays well under the 100-bound-parameter ceiling even at
			// large HISTORY_LIMIT.
			const reactionRows = this.ctx.storage.sql
				.exec<Record<string, number | string | null>>(
					`SELECT r.message_id, r.emoji, count(*) AS c,
					        SUM(CASE WHEN r.user_key = ? THEN 1 ELSE 0 END) AS m
					 FROM reactions r
					 JOIN (SELECT id FROM messages WHERE deleted_at IS NULL ORDER BY ts DESC LIMIT ?) m
					   ON m.id = r.message_id
					 GROUP BY r.message_id, r.emoji`,
					uid ?? pid,
					limit
				)
				.toArray();
			for (const row of reactionRows) {
				const mid = String(row.message_id);
				const emoji = String(row.emoji);
				(counts[mid] ??= {})[emoji] = Number(row.c);
				if (Number(row.m) > 0) (mine[mid] ??= []).push(emoji);
			}
		}

		return rows.map((row) => {
			const message = rowToPublicMessage(row);
			return {
				...message,
				mine: this.ownsRow(uid, pid, {
					user_id: row.user_id == null ? null : String(row.user_id),
					pid: row.pid == null ? null : String(row.pid)
				}),
				reactions: counts[message.id] ?? {},
				...(mine[message.id] ? { my: mine[message.id] } : {})
			};
		});
	}

	/** Admin moderation view: newest-first, includes soft-deleted, keyset-paged. */
	private adminHistory(
		limit: number,
		beforeTs: string | null,
		beforeId: string | null
	): { messages: ChatMessage[]; hasMore: boolean; nextCursor: { ts: number; id: string } | null } {
		const useCursor =
			beforeTs !== null && beforeId !== null && beforeTs !== '' && Number.isFinite(Number(beforeTs));
		const where = useCursor ? 'WHERE ts < ? OR (ts = ? AND id < ?)' : '';
		const bindings: (number | string)[] = useCursor
			? [Number(beforeTs), Number(beforeTs), beforeId]
			: [];
		const rows = this.ctx.storage.sql
			.exec<Record<string, string | number | null>>(
				`SELECT id, ts, name, content, user_id, deleted_at, gif_url, gif_preview, gif_width, gif_height, at_seconds, parent_id
				 FROM messages ${where}
				 ORDER BY ts DESC, id DESC
				 LIMIT ?`,
				...bindings,
				limit + 1
			)
			.toArray();
		const hasMore = rows.length > limit;
		const page = rows.slice(0, limit).map((row) => ({
			...rowToPublicMessage(row),
			...(row.deleted_at == null ? {} : { deleted: true })
		}));
		const last = page[page.length - 1];
		return {
			messages: page,
			hasMore,
			nextCursor: hasMore && last ? { ts: last.ts, id: last.id } : null
		};
	}

	/** Author self-delete: soft-delete (tombstone) when the caller owns the message. */
	private handleDelete(ws: WebSocket, meta: ConnectionMeta, rawId: unknown) {
		const id = String(rawId ?? '').slice(0, 64);
		if (!/^[\w-]{1,64}$/.test(id)) return;
		const row = this.ctx.storage.sql
			.exec<{ user_id: string | null; pid: string | null; parent_id: string | null }>(
				'SELECT user_id, pid, parent_id FROM messages WHERE id = ?',
				id
			)
			.toArray()[0];
		if (!row) return;
		if (
			!this.ownsRow(meta.uid, meta.pid, {
				user_id: row.user_id ?? null,
				pid: row.pid ?? null
			})
		) {
			ws.send(JSON.stringify({ type: 'error', message: 'You can only delete your own messages.' }));
			return;
		}

		// Deleting a top-level comment removes its replies with it.
		const ids =
			row.parent_id === null
				? this.ctx.storage.sql
						.exec<{ id: string }>('SELECT id FROM messages WHERE id = ? OR parent_id = ?', id, id)
						.toArray()
						.map((r) => String(r.id))
				: [id];
		let removed = 0;
		for (const target of ids) {
			const cursor = this.ctx.storage.sql.exec(
				'UPDATE messages SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL',
				Date.now(),
				meta.uid ?? meta.pid ?? 'unknown',
				target
			);
			cursor.toArray();
			if (cursor.rowsWritten > 0) {
				removed++;
				this.broadcast({ type: 'deleted', id: target });
			}
		}
		if (removed === 0) return;
	}

	/**
	 * Verify an app-issued chat identity token: `payload.sig` with
	 * payload = base64url(JSON{uid,name,exp}). HMAC-SHA256 over the payload
	 * using the shared CHAT_IDENTITY_SECRET.
	 */
	private async verifyIdentity(token: string): Promise<IdentityPayload | null> {
		const secret = this.env.CHAT_IDENTITY_SECRET;
		if (!secret) return null;
		const dot = token.lastIndexOf('.');
		if (dot <= 0) return null;
		const payload = token.slice(0, dot);
		const sig = token.slice(dot + 1);
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
		const macHex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
		if (macHex.length !== sig.length) return null;
		let same = 0;
		for (let i = 0; i < macHex.length; i++) same |= macHex.charCodeAt(i) ^ sig.charCodeAt(i);
		if (same !== 0) return null;
		try {
			const data = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as IdentityPayload;
			if (
				typeof data?.uid !== 'string' ||
				typeof data?.name !== 'string' ||
				typeof data?.exp !== 'number'
			)
				return null;
			if (data.exp * 1000 < Date.now()) return null;
			return data;
		} catch {
			return null;
		}
	}

	private broadcast(payload: unknown) {
		const data = JSON.stringify(payload);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(data);
			} catch {
				// Connection already closed; ignore.
			}
		}
	}

	/** Broadcast a new message, tagging each recipient's own copy with `mine`. */
	private broadcastMessage(msg: ChatMessage, owner: ConnectionMeta) {
		for (const ws of this.ctx.getWebSockets()) {
			const meta = ws.deserializeAttachment() as ConnectionMeta | null;
			const mine = meta
				? this.ownsRow(meta.uid, meta.pid, { user_id: owner.uid, pid: owner.pid })
				: false;
			try {
				ws.send(JSON.stringify({ type: 'message', message: { ...msg, mine } }));
			} catch {
				// Connection already closed; ignore.
			}
		}
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// Route all requests (WS upgrades + HTTP) to the named room's DO.
		const url = new URL(request.url);
		const room = url.searchParams.get('room') || 'main';
		if (!isValidRoom(room)) return new Response('Invalid room', { status: 400 });
		return env.CHAT_ROOM.getByName(room).fetch(request);
	}
};

/** Map a stored message row to the public message shape (never exposes `pid`). */
function rowToPublicMessage(row: Record<string, string | number | null>): ChatMessage {
	const gif =
		row.gif_url === undefined || row.gif_url === null
			? null
			: {
					url: String(row.gif_url),
					preview: row.gif_preview == null ? null : String(row.gif_preview),
					width: row.gif_width == null ? null : Number(row.gif_width),
					height: row.gif_height == null ? null : Number(row.gif_height)
				};
	return {
		id: String(row.id),
		ts: Number(row.ts),
		name: String(row.name),
		content: String(row.content),
		userId: row.user_id === undefined || row.user_id === null ? null : String(row.user_id),
		...(gif ? { gif } : {}),
		...(row.at_seconds === undefined || row.at_seconds === null
			? {}
			: { atSeconds: Number(row.at_seconds) }),
		...(row.parent_id === undefined || row.parent_id === null
			? {}
			: { parentId: String(row.parent_id) })
	};
}

/**
 * Validate an incoming GIF payload: https + provider host allowlist only, so
 * users can't smuggle arbitrary URLs into messages. Returns null to reject.
 */
function sanitizeGif(raw: unknown): GifMedia | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const g = raw as { url?: unknown; preview?: unknown; width?: unknown; height?: unknown };
	const url = typeof g.url === 'string' ? g.url.trim().slice(0, MAX_GIF_URL_LENGTH) : '';
	if (!url) return null;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'https:') return null;
	if (!parsed.hostname.endsWith('.giphy.com')) return null;
	const preview =
		typeof g.preview === 'string' ? g.preview.trim().slice(0, MAX_GIF_URL_LENGTH) : null;
	const width = typeof g.width === 'number' && Number.isFinite(g.width) ? g.width : null;
	const height = typeof g.height === 'number' && Number.isFinite(g.height) ? g.height : null;
	return { url, preview, width, height };
}

/**
 * Verify a Turnstile token server-side. Fails closed.
 */
async function verifyTurnstile(
	token: string | null,
	secret: string,
	hostnames: string | undefined,
	remoteip: string | null
): Promise<boolean> {
	if (!token || token.length === 0 || token.length > 2048) return false;
	const expected = new Set((hostnames ?? '').split(',').map((h) => h.trim()).filter(Boolean));
	if (expected.size === 0) return false;
	try {
		const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			signal: AbortSignal.timeout(10_000),
			body: new URLSearchParams({
				secret,
				response: token,
				...(remoteip ? { remoteip } : {})
			})
		});
		if (!res.ok) return false;
		const result = (await res.json()) as { success?: boolean; hostname?: string };
		return result.success === true && expected.has(result.hostname ?? '');
	} catch {
		return false;
	}
}
