<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import { Button, Text } from '@svar-ui/svelte-core';
	import Turnstile from '$lib/components/Turnstile.svelte';
	import GifPicker from '$lib/components/GifPicker.svelte';
	import { displayNameFor, needsDisplayName } from '$lib/displayName';
	import { formatTrackTime } from '$lib/trackTime';
	import type { ChatMessage, GifMedia } from '$lib/chat';

	let {
		room,
		chatUrl,
		siteKey,
		giphyKey,
		user,
		mode = 'chat',
		initialMessages = [],
		position = null,
		onseek = null,
		onMessages = null,
		onPosted = null,
		focusNonce = 0,
		replyRequest = null
	}: {
		room: string;
		chatUrl: string;
		siteKey: string;
		giphyKey: string;
		user: App.User | null;
		mode?: 'chat' | 'comments';
		initialMessages?: ChatMessage[];
		/** Current replay position for the composer, when this is an episode. */
		position?: number | null;
		onseek?: ((seconds: number) => void) | null;
		onMessages?: ((messages: ChatMessage[]) => void) | null;
		onPosted?: (() => void) | null;
		focusNonce?: number;
		/** Ask the composer to reply to a comment (from a waveform pin). */
		replyRequest?: { comment: { id: string; name: string }; nonce: number } | null;
	} = $props();

	// Keep no more than the worker's history window (HISTORY_LIMIT = 299 + the
	// newest incoming message) so nothing is silently dropped on each append.
	const MAX_CLIENT_MESSAGES = 300;

	function getPid(): string {
		try {
			let pid = localStorage.getItem('vr-chat-pid');
			if (!pid) {
				pid = crypto.randomUUID();
				localStorage.setItem('vr-chat-pid', pid);
			}
			return pid;
		} catch {
			return 'anon';
		}
	}

	const myHearts = new Set<string>();
	const isComments = $derived(mode === 'comments');

	function heartCount(msg: ChatMessage): number {
		return msg.reactions?.heart ?? 0;
	}

	function heartActive(msg: ChatMessage): boolean {
		return myHearts.has(msg.id);
	}

	function toggleHeart(msg: ChatMessage) {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		if (myHearts.has(msg.id)) {
			myHearts.delete(msg.id);
		} else {
			myHearts.add(msg.id);
		}
		msg.reactions = {
			...(msg.reactions ?? {}),
			heart: Math.max(0, heartCount(msg) + (heartActive(msg) ? 1 : -1))
		};
		ws.send(JSON.stringify({ type: 'react', id: msg.id, emoji: 'heart' }));
	}

	let ws = $state<WebSocket | null>(null);
	// Non-reactive in-flight guard (see connect()): prevents overlapping connects
	// from opening duplicate sockets, whose duplicate broadcasts crash the list.
	let connecting = false;
	let messages = $state<ChatMessage[]>(untrack(() => sortMessages(initialMessages)));
	let input = $state('');
	let connected = $state(false);
	let error = $state('');
	let closed = false;
	let gifPickerOpen = $state(false);
	let turnstileToken = $state('');
	let scrollEl: HTMLDivElement | undefined = $state();
	let identity = $state<{ token: string; name: string } | null>(null);
	// Session-level cache: skip the identity fetch on reconnects within 4min.
	let identityCache: { token: string; name: string; exp: number } | null = null;
	// Custom handle chosen by an anonymous user (only persisted when they set it).
	let handle = $state(
		typeof localStorage !== 'undefined' ? (localStorage.getItem('vr-chat-handle') ?? '') : ''
	);
	let handleInput = $state('');
	// Name assigned by the worker for this session (Listener N or account name).
	let assignedName = $state('');
	let replyTo = $state<ChatMessage | null>(null);
	let composerEl: HTMLFormElement | undefined = $state();
	let lastFocusNonce = 0;
	let lastReplyNonce = 0;

	const displayName = $derived(
		user ? displayNameFor(user) : assignedName || handle || 'Listener'
	);

	/** Sort for the current surface. Comments read in episode order. */
	function sortMessages(list: ChatMessage[]): ChatMessage[] {
		const sorted = [...list];
		if (mode === 'comments') {
			sorted.sort((a, b) => {
				const av = a.atSeconds ?? Number.MAX_SAFE_INTEGER;
				const bv = b.atSeconds ?? Number.MAX_SAFE_INTEGER;
				return av - bv || a.ts - b.ts || a.id.localeCompare(b.id);
			});
		} else {
			sorted.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
		}
		return sorted;
	}

	function repliesFor(id: string): ChatMessage[] {
		return messages
			.filter((m) => m.parentId === id)
			.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
	}

	/** Parent lookup for inline reply quotes in the live chat. */
	const byId = $derived.by(() => new Map(messages.map((m) => [m.id, m])));

	const roots = $derived.by(() => {
		if (!isComments) return sortMessages(messages);
		const ids = new Set(messages.map((m) => m.id));
		return sortMessages(messages.filter((m) => !m.parentId || !ids.has(m.parentId)));
	});

	$effect(() => {
		// Comments are read in timeline order; only the live chat pins to the newest.
		if (!isComments && scrollEl && messages.length) {
			scrollEl.scrollTop = scrollEl.scrollHeight;
		}
	});

	$effect(() => {
		onMessages?.(messages);
	});

	$effect(() => {
		if (focusNonce > lastFocusNonce) {
			lastFocusNonce = focusNonce;
			// Let the browser do its native focus scroll; programmatic scrolling
			// here fights the mobile keyboard and can leave the input hidden.
			composerEl?.querySelector('input')?.focus();
		}
	});

	$effect(() => {
		// Reply requested from outside (a waveform pin). The nonce makes a repeat
		// reply to the same comment re-trigger, including on first mount.
		const request = replyRequest;
		if (!request || request.nonce === lastReplyNonce) return;
		lastReplyNonce = request.nonce;
		if (!isComments) return;
		const match = messages.find((m) => m.id === request.comment.id);
		replyTo = match ?? ({
			id: request.comment.id,
			name: request.comment.name,
			ts: 0,
			content: ''
		} satisfies ChatMessage);
		// Wait for the reply banner to render before taking focus.
		setTimeout(() => composerEl?.querySelector('input')?.focus(), 0);
	});

	$effect(() => {
		// Connect once a Turnstile token is available.
		if (turnstileToken && !ws && !closed && chatUrl) {
			connect();
		}
	});

	function onTurnstileToken(token: string) {
		turnstileToken = token;
		error = '';
	}

	function onTurnstileExpire() {
		turnstileToken = '';
		ws?.close();
	}

	async function connect() {
		// One socket at a time: concurrent connects (the connect effect racing a
		// fresh Turnstile token, etc.) would open duplicate sockets, and their
		// duplicate broadcasts crash the keyed message list.
		if (closed || connecting) return;
		const current = ws;
		if (
			current &&
			(current.readyState === WebSocket.CONNECTING || current.readyState === WebSocket.OPEN)
		) {
			return;
		}
		connecting = true;
		try {
			if (user) {
				const cached = identityCache;
				if (cached && cached.exp * 1000 - Date.now() > 240_000) {
					identity = { token: cached.token, name: cached.name };
				} else {
					try {
						const res = await fetch('/api/chat/identity');
						if (res.ok) {
							const fresh = (await res.json()) as { token: string; name: string };
							identity = fresh;
							const payload = fresh.token.split('.')[0];
							const exp = Number(
								JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).exp
							);
							identityCache = {
								token: fresh.token,
								name: fresh.name,
								exp: Number.isFinite(exp) ? exp : 0
							};
						}
					} catch {
						identity = null;
					}
				}
			}
			const params = new URLSearchParams({
				room,
				turnstile: turnstileToken,
				pid: getPid()
			});
			if (identity || user) {
				params.set('name', displayName);
			} else if (handle) {
				params.set('name', handle);
			} else if (assignedName) {
				params.set('name', assignedName);
			} else {
				params.set('anonymous', '1');
			}
			if (identity) params.set('token', identity.token);
			const base = chatUrl.replace(/^http/, 'ws');
			const url = `${base}/api/chat/ws?${params.toString()}`;
			const socket = new WebSocket(url);

			socket.onopen = () => {
				if (ws !== socket) {
					socket.close();
					return;
				}
				connected = true;
				error = '';
			};
			socket.onclose = () => {
				// Ignore closes from sockets that are no longer the active one.
				if (ws !== socket) return;
				connected = false;
				ws = null;
				// Turnstile tokens are single-use: drop the consumed one and let the
				// widget mount again so the reconnect uses a fresh token.
				if (siteKey) turnstileToken = '';
			};
			socket.onerror = () => socket.close();
			socket.onmessage = (e: MessageEvent) => {
				let frame: {
					type?: string;
					messages?: ChatMessage[];
					message?: ChatMessage | string;
					id?: string;
					name?: string;
					emoji?: string;
					count?: number;
				};
				try {
					frame = JSON.parse(String(e.data));
				} catch {
					return;
				}
				if (frame.type === 'history' && frame.messages) {
					// Merge by id instead of replacing: a late history frame (from a
					// reconnect) must not wipe messages already appended locally.
					const merged = new Map<string, ChatMessage>();
					for (const m of frame.messages) merged.set(m.id, m);
					for (const m of messages) if (!merged.has(m.id)) merged.set(m.id, m);
					const all = [...merged.values()];
					const trimmed =
						all.length > MAX_CLIENT_MESSAGES
							? all.sort((a, b) => a.ts - b.ts).slice(-MAX_CLIENT_MESSAGES)
							: all;
					messages = sortMessages(trimmed);
					for (const m of frame.messages) {
						if (m.my?.includes('heart')) myHearts.add(m.id);
					}
				} else if (frame.type === 'reacted' && frame.id) {
					const msg = messages.find((m) => m.id === frame.id);
					if (msg) {
						msg.reactions = { ...(msg.reactions ?? {}), heart: frame.count ?? 0 };
					}
				} else if (frame.type === 'name' && frame.name) {
					assignedName = frame.name;
					if (!handle) handleInput = frame.name;
				} else if (frame.type === 'message' && frame.message) {
					const incoming = frame.message as ChatMessage;
					if (!messages.some((m) => m.id === incoming.id)) {
						messages = sortMessages(
							[...messages, incoming].slice(-MAX_CLIENT_MESSAGES)
						);
					}
				} else if (frame.type === 'deleted' && frame.id) {
					messages = messages.filter((m) => m.id !== frame.id);
					if (replyTo?.id === frame.id) replyTo = null;
				} else if (frame.type === 'purged' && frame.name) {
					messages = messages.filter((m) => m.name !== frame.name);
					if (replyTo?.name === frame.name) replyTo = null;
				} else if (frame.type === 'error') {
					error = String(frame.message ?? '');
				}
			};

			ws = socket;
		} finally {
			connecting = false;
		}
	}

	onMount(() => {
		if (!siteKey) {
			// No Turnstile configured — connect directly.
			turnstileToken = 'unverified';
			connect();
		}
	});
	onDestroy(() => {
		closed = true;
		ws?.close();
	});

	function sendFrame(content: string, gif?: GifMedia): boolean {
		if (!ws || ws.readyState !== WebSocket.OPEN) return false;
		const frame: Record<string, unknown> = { type: 'message', content };
		if (gif) frame.gif = gif;
		if (replyTo) {
			frame.parentId = replyTo.id;
		} else if (isComments && position !== null && Number.isFinite(position)) {
			frame.at = Math.max(0, Math.floor(position));
		}
		ws.send(JSON.stringify(frame));
		return true;
	}

	function send() {
		const content = input.trim();
		if (!content) return;
		const wasReply = !!replyTo;
		if (!sendFrame(content)) return;
		input = '';
		replyTo = null;
		if (isComments && !wasReply) onPosted?.();
	}

	function deleteMessage(msg: ChatMessage) {
		if (!msg.mine || !ws || ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify({ type: 'delete', id: msg.id }));
		messages = messages.filter((m) => m.id !== msg.id && m.parentId !== msg.id);
		if (replyTo?.id === msg.id) replyTo = null;
	}

	function onPickGif(gif: GifMedia) {
		gifPickerOpen = false;
		const wasReply = !!replyTo;
		if (!sendFrame('', gif)) {
			error = 'Still reconnecting — try the GIF again in a moment.';
			return;
		}
		replyTo = null;
		if (isComments && !wasReply) onPosted?.();
	}

	function saveHandle() {
		const value = handleInput.trim().slice(0, 40);
		if (!value) return;
		handle = value;
		assignedName = '';
		try {
			localStorage.setItem('vr-chat-handle', value);
		} catch {
			// storage unavailable; handle still applies for this session
		}
		ws?.close();
	}
</script>

<div class="chat-panel" class:compact={isComments}>
	{#if !chatUrl}
		<div class="notice bad">Chat isn't configured yet (missing PUBLIC_CHAT_URL).</div>
	{:else}
		<div class="chat-card">
			<div class="chat-head mono">
				<span class="status" class:online={connected}></span>
				<span>{connected ? 'Connected' : siteKey ? 'Verify to join' : 'Reconnecting…'}</span>
				{#if isComments && position !== null}
					<span class="head-at">at {formatTrackTime(position)}</span>
				{/if}
			</div>
			<div class="messages" class:compact={isComments} bind:this={scrollEl}>
				{#if messages.length === 0}
					<p class="empty">
						{isComments ? 'No comments yet. Start the conversation.' : 'No messages yet. Say hello!'}
					</p>
				{/if}
				{#each roots as msg (msg.id)}
					{@render messageBlock(msg, false)}
					{#if isComments}
						{@const replies = repliesFor(msg.id)}
						{#if replies.length > 0}
							<div class="replies">
								<span class="reply-count mono"
									>{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</span
								>
								{#each replies as reply (reply.id)}
									{@render messageBlock(reply, true)}
								{/each}
							</div>
						{/if}
					{/if}
				{/each}
			</div>

			{#if siteKey && !connected}
				<div class="verify-box">
					<p class="verify-text">
						{isComments
							? 'Verify you’re human to comment.'
							: 'Verify you’re human to join the chat.'}
					</p>
					<Turnstile siteKey={siteKey} action="chat" onToken={onTurnstileToken} onExpire={onTurnstileExpire} />
				</div>
			{/if}

			{#if user && needsDisplayName(user)}
				<a class="name-nudge" href="/account">
					You're chatting as “Listener”. Set a display name
					<span aria-hidden="true">→</span>
				</a>
			{/if}

			{#if replyTo}
				<div class="reply-context">
					<span>Replying to <strong>{replyTo.name}</strong></span>
					<button type="button" class="reply-cancel" onclick={() => (replyTo = null)}>
						Cancel
					</button>
				</div>
			{/if}

			<form
				class="composer"
				bind:this={composerEl}
				onsubmit={(e) => {
					e.preventDefault();
					send();
				}}
			>
				{#if giphyKey}
					<button
						type="button"
						class="gif-btn"
						class:active={gifPickerOpen}
						disabled={!connected}
						onclick={() => (gifPickerOpen = !gifPickerOpen)}
						aria-label="Add a GIF"
						title="Add a GIF"
						aria-expanded={gifPickerOpen}
					>
						<span class="gif-btn-label">GIF</span>
					</button>
				{/if}
				<div class="composer-input">
					<Text
						bind:value={input}
						placeholder={replyTo
							? `Reply to ${replyTo.name}…`
							: isComments
								? 'Add a comment…'
								: 'Say something…'}
						css="vr-input chat-input"
					/>
				</div>
				{#if isComments && !replyTo}
					<span class="comment-at mono" class:muted={position === null}>
						{position === null ? 'No timestamp' : `at ${formatTrackTime(position)}`}
					</span>
				{/if}
				<button class="send" type="submit" disabled={!connected}>
					{isComments ? 'Comment' : 'Send'}
				</button>
			</form>
			{#if gifPickerOpen && giphyKey}
				<GifPicker
					giphyKey={giphyKey}
					onSelect={onPickGif}
					onClose={() => (gifPickerOpen = false)}
				/>
			{/if}
			{#if error}
				<div class="notice bad">{error}</div>
			{/if}
		</div>

		{#if isComments}
			<p class="as-line mono">
				Commenting as <strong>{displayName}</strong>
				{#if user}
					(signed in)
				{:else if !handle}
					· <a href="/login">sign in</a>
				{/if}
			</p>
		{:else}
			<p class="subtitle mono">
				You're chatting as <strong>{displayName}</strong>
				{#if user}
					(signed in)
				{:else if !handle}
					· <a href="/login">sign in</a>
				{/if}
			</p>

			{#if !user}
				<form
					class="handle-row"
					onsubmit={(e) => {
						e.preventDefault();
						saveHandle();
					}}
				>
					<Text bind:value={handleInput} placeholder="Pick a handle (optional)" css="vr-input" />
					<Button css="vr-cta ghost" onclick={saveHandle}>update</Button>
				</form>
			{/if}
		{/if}
	{/if}
</div>

{#snippet messageBlock(msg: ChatMessage, isReply: boolean)}
	<div
		class="msg"
		class:mine={msg.mine ?? msg.name === displayName}
		class:reply={isReply}
	>
		<div class="msg-meta">
			{#if isComments && !isReply && msg.atSeconds !== null && msg.atSeconds !== undefined}
				{#if onseek}
					<button
						class="comment-time"
						onclick={() => onseek?.(msg.atSeconds as number)}
						title={`Play from ${formatTrackTime(msg.atSeconds)}`}
					>
						{formatTrackTime(msg.atSeconds)}
					</button>
				{:else}
					<span class="comment-time">{formatTrackTime(msg.atSeconds)}</span>
				{/if}
			{/if}
			<span class="msg-name">{msg.name}</span>
			<span class="msg-time"
				>{new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span
			>
			<button
				class="heart-btn"
				class:active={heartActive(msg)}
				onclick={() => toggleHeart(msg)}
				title={heartActive(msg) ? 'Remove heart' : 'Heart this'}
				aria-label={heartActive(msg) ? 'Remove heart' : 'Heart this'}
			>
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<path
						d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"
						fill={heartActive(msg) ? 'currentColor' : 'none'}
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
				{#if heartCount(msg) > 0}<span>{heartCount(msg)}</span>{/if}
			</button>
			{#if isComments ? !isReply : !msg.parentId}
				<button class="reply-btn" onclick={() => (replyTo = msg)}>Reply</button>
			{/if}
			{#if msg.mine}
				<button
					class="x-btn"
					onclick={() => deleteMessage(msg)}
					title="Delete message"
					aria-label="Delete message"
				>
					<svg viewBox="0 0 24 24" aria-hidden="true">
						<path
							d="M6 6l12 12M18 6L6 18"
							fill="none"
							stroke="currentColor"
							stroke-width="1.8"
							stroke-linecap="round"
						/>
					</svg>
				</button>
			{/if}
		</div>
		{#if !isComments && msg.parentId}
			{@const parent = byId.get(msg.parentId)}
			<p class="msg-quote">
				<span class="quote-mark" aria-hidden="true">↪</span>
				{#if parent}
					<span class="quote-name">{parent.name}</span>
					<span class="quote-text">{parent.content || (parent.gif ? 'GIF' : '')}</span>
				{:else}
					<span class="quote-text">an earlier message</span>
				{/if}
			</p>
		{/if}
		{#if msg.gif}
			<img
				class="msg-gif"
				src={msg.gif.url}
				width={msg.gif.width ?? undefined}
				height={msg.gif.height ?? undefined}
				alt=""
				loading="lazy"
			/>
		{/if}
		{#if msg.content}
			<p class="msg-body">{msg.content}</p>
		{/if}
	</div>
{/snippet}

<style>
	.chat-panel {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.chat-card {
		border: 1px solid var(--vr-line);
		background: var(--vr-surface);
	}

	.chat-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.6rem 1rem;
		border-bottom: 1px solid var(--vr-line);
		color: var(--vr-muted);
	}

	.head-at {
		margin-left: auto;
		color: var(--vr-muted);
		font-variant-numeric: tabular-nums;
	}

	.status {
		width: 8px;
		height: 8px;
		background: var(--vr-line-muted);
	}

	.status.online {
		background: var(--vr-green);
		animation: status-pulse 1.6s ease-in-out infinite;
	}

	@keyframes status-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}

	.messages {
		height: 60vh;
		overflow-y: auto;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.messages.compact {
		height: 22rem;
	}

	.empty {
		color: var(--vr-muted);
		text-align: center;
		margin: auto;
	}

	.msg {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		background: var(--vr-surface-low);
		border: 1px solid var(--vr-line-muted);
		padding: 0.5rem 0.8rem;
		max-width: 88%;
	}

	.msg.mine {
		align-self: flex-end;
		border-color: var(--vr-line);
		background: var(--vr-surface-high);
	}

	.msg.reply {
		max-width: calc(88% - 1.25rem);
		margin-left: 1.25rem;
	}

	.msg-meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.msg-name {
		color: var(--vr-text);
		font-weight: 600;
		font-size: 0.85rem;
		font-family: var(--vr-font-mono);
		white-space: nowrap;
		min-width: 0;
		text-overflow: ellipsis;
	}

	.msg-time {
		margin-left: auto;
		color: var(--vr-faint);
		font-size: 0.7rem;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.msg-body {
		word-break: break-word;
		margin: 0;
	}

	.comment-time {
		border: 1px solid var(--vr-line-muted);
		background: transparent;
		color: var(--vr-text);
		font-family: var(--vr-font-mono);
		font-size: 0.7rem;
		font-variant-numeric: tabular-nums;
		padding: 0.1rem 0.35rem;
		cursor: pointer;
		flex-shrink: 0;
	}

	.comment-time:hover {
		background: var(--vr-text);
		color: var(--vr-black);
		border-color: var(--vr-text);
	}

	.msg-quote {
		display: flex;
		align-items: baseline;
		gap: 0.3rem;
		margin: 0;
		padding-left: 0.45rem;
		border-left: 2px solid var(--vr-line);
		color: var(--vr-muted);
		font-size: 0.72rem;
		min-width: 0;
		max-width: 100%;
		overflow: hidden;
		white-space: nowrap;
	}

	.quote-mark {
		color: var(--vr-faint);
		flex-shrink: 0;
	}

	.quote-name {
		color: var(--vr-text);
		font-family: var(--vr-font-mono);
		font-weight: 600;
		flex-shrink: 0;
		max-width: 40%;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.quote-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.reply-btn {
		border: none;
		background: transparent;
		color: var(--vr-muted);
		font-family: var(--vr-font-mono);
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 0.1rem 0.15rem;
		cursor: pointer;
		flex-shrink: 0;
	}

	.reply-btn:hover {
		color: var(--vr-text);
		text-decoration: underline;
	}

	.replies {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		border-left: 1px solid var(--vr-line-muted);
		padding-left: 0.5rem;
		margin-left: 1rem;
	}

	.reply-count {
		color: var(--vr-faint);
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.reply-context {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		justify-content: space-between;
		padding: 0.45rem 1rem;
		border-top: 1px solid var(--vr-line-muted);
		background: var(--vr-surface-low);
		color: var(--vr-muted);
		font-size: 0.78rem;
	}

	.reply-context strong {
		color: var(--vr-text);
	}

	.reply-cancel {
		border: 1px solid var(--vr-line);
		background: transparent;
		color: var(--vr-muted);
		font-family: var(--vr-font-mono);
		font-size: 0.68rem;
		text-transform: uppercase;
		padding: 0.2rem 0.5rem;
		cursor: pointer;
	}

	.reply-cancel:hover {
		background: var(--vr-text);
		color: var(--vr-black);
	}

	.heart-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		background: none;
		border: none;
		color: var(--vr-faint);
		font-size: 0.72rem;
		cursor: pointer;
		padding: 0.1rem 0.15rem;
		line-height: 1;
		flex-shrink: 0;
	}

	.heart-btn svg {
		width: 14px;
		height: 14px;
	}

	.heart-btn span {
		font-variant-numeric: tabular-nums;
	}

	.heart-btn:hover,
	.heart-btn.active {
		color: var(--vr-red);
	}

	.x-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: none;
		color: var(--vr-faint);
		cursor: pointer;
		padding: 0.1rem 0.15rem;
		line-height: 1;
		flex-shrink: 0;
	}

	.x-btn svg {
		width: 14px;
		height: 14px;
	}

	.x-btn:hover {
		color: var(--vr-red);
	}

	.composer {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		padding: 0.75rem 1rem;
		border-top: 1px solid var(--vr-line);
	}

	.composer-input {
		display: flex;
		flex: 1;
		min-width: 0;
	}

	.comment-at {
		font-size: 0.7rem;
		color: var(--vr-text);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.comment-at.muted {
		color: var(--vr-faint);
	}

	.name-nudge {
		display: block;
		padding: 0.45rem 1rem;
		border-top: 1px solid var(--vr-line-muted);
		background: var(--vr-surface-low);
		color: var(--vr-muted);
		font-family: var(--vr-font-mono);
		font-size: 0.72rem;
		letter-spacing: 0.02em;
		text-decoration: none;
	}

	.name-nudge:hover {
		color: var(--vr-text);
		text-decoration: underline;
	}

	.gif-btn {
		display: inline-grid;
		place-items: center;
		background: none;
		border: 1px solid var(--vr-line);
		color: var(--vr-muted);
		width: 40px;
		flex-shrink: 0;
		cursor: pointer;
	}

	.gif-btn:hover,
	.gif-btn.active {
		color: var(--vr-text);
		border-color: var(--vr-text);
	}

	.gif-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.gif-btn-label {
		font-family: var(--vr-font-headline);
		font-weight: 700;
		font-size: 0.95rem;
		line-height: 1;
		letter-spacing: 0.02em;
		pointer-events: none;
	}

	.msg-gif {
		max-width: 240px;
		height: auto;
		display: block;
		border: 1px solid var(--vr-line-muted);
		margin: 0.25rem 0;
	}

	:global(.chat-input) {
		flex: 1;
		min-width: 0;
	}

	.send {
		background: #fff;
		border: 1px solid #fff;
		color: #000;
		font-family: var(--vr-font-headline);
		font-size: 1rem;
		text-transform: uppercase;
		padding: 0 1.25rem;
		cursor: pointer;
	}

	.send:hover {
		background: #000;
		color: #fff;
	}

	.send:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.notice {
		margin: 0.75rem 0;
		padding: 0.6rem 0.85rem;
		border: 1px solid var(--vr-line);
		font-size: 0.9rem;
	}

	.notice.bad {
		color: var(--vr-text);
	}

	.verify-box {
		border-top: 1px solid var(--vr-line);
		background: var(--vr-surface-low);
		padding: 1rem;
	}

	.verify-text {
		margin: 0 0 0.5rem;
		color: var(--vr-muted);
		font-size: 0.9rem;
	}

	.subtitle,
	.as-line {
		color: var(--vr-muted);
		margin: 0;
	}

	.subtitle strong,
	.as-line strong {
		color: var(--vr-text);
	}

	.subtitle a,
	.as-line a {
		color: var(--vr-text);
		text-decoration: underline;
	}

	.handle-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.handle-row :global(button) {
		overflow: visible;
		text-overflow: clip;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.handle-row :global(input) {
		min-width: 0;
		flex: 1 1 10rem;
	}

	@media (max-width: 640px) {
		.msg {
			max-width: 100%;
			padding: 0.45rem 0.65rem;
			gap: 0.25rem;
		}

		.msg.reply {
			max-width: calc(100% - 1.25rem);
		}

		.msg-name {
			flex: 1 1 auto;
			font-size: 0.8rem;
		}

		.msg-body {
			font-size: 0.95rem;
		}

		.composer {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr) auto;
			grid-template-areas:
				'input input input'
				'gif at send';
			align-items: center;
			column-gap: 0.5rem;
			row-gap: 0.35rem;
		}

		.composer-input {
			grid-area: input;
		}

		.composer .send {
			grid-area: send;
			min-height: 40px;
		}

		.composer .gif-btn {
			grid-area: gif;
			justify-self: start;
			min-height: 40px;
		}

		.comment-at {
			grid-area: at;
			justify-self: end;
		}
	}
</style>
