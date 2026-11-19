import { json } from '@sveltejs/kit';
import { getShow, resolveBroadcastForShow } from '$lib/server/shows';
import type { RequestHandler } from './$types';

/** Optional per-episode title; blank clears it back to the show title. */
const TITLE_MAX = 120;

async function authorize(
	params: { id: string; broadcastId: string },
	user: App.Locals['user'],
	db: D1Database
): Promise<{ ok: false; status: number } | { ok: true; broadcastId: string }> {
	if (!user || (user.role !== 'dj' && user.role !== 'admin')) {
		return { ok: false, status: 403 };
	}
	const show = await getShow(db, params.id);
	if (!show) return { ok: false, status: 404 };
	if (show.dj_id !== user.id && user.role !== 'admin') {
		return { ok: false, status: 403 };
	}
	const broadcast = await resolveBroadcastForShow(db, show.id, params.broadcastId);
	if (!broadcast) return { ok: false, status: 404 };
	return { ok: true, broadcastId: broadcast.id };
}

function normalise(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const title = raw.trim().slice(0, TITLE_MAX);
	return title || null;
}

export const PUT: RequestHandler = async ({ request, params, locals, platform }) => {
	const db = platform!.env.DB;
	const auth = await authorize(params, locals.user, db);
	if (!auth.ok) return json({ error: 'Forbidden' }, { status: auth.status });

	const body = (await request.json()) as { title?: unknown };
	if (typeof body.title !== 'string') {
		return json({ error: 'title must be a string' }, { status: 400 });
	}
	const title = normalise(body.title);
	await db
		.prepare('UPDATE broadcast SET title = ?, updated_at = ? WHERE id = ?')
		.bind(title, Math.floor(Date.now() / 1000), auth.broadcastId)
		.run();
	return json({ title });
};

export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	const auth = await authorize(params, locals.user, db);
	if (!auth.ok) return json({ error: 'Forbidden' }, { status: auth.status });
	await db
		.prepare('UPDATE broadcast SET title = NULL, updated_at = ? WHERE id = ?')
		.bind(Math.floor(Date.now() / 1000), auth.broadcastId)
		.run();
	return json({ title: null });
};
