import { json } from '@sveltejs/kit';
import { getShow, resolveBroadcastForShow } from '$lib/server/shows';
import { fetchSeratoPlaylistUrl } from '$lib/server/serato';
import { isSeratoPlaylistUrl, normalizeSeratoPlaylistUrl } from '$lib/serato';
import type { RequestHandler } from './$types';

/**
 * Preview a Serato import for this broadcast.
 *
 * The URL comes from an explicit `?url=` (the editor's field, before it is
 * saved) or from `broadcast.serato_url`. Returns parsed rows only — nothing is
 * written until the DJ saves the tracklist.
 */
export const GET: RequestHandler = async ({ params, url, locals, platform }) => {
	const user = locals.user;
	if (!user || (user.role !== 'dj' && user.role !== 'admin')) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const db = platform!.env.DB;
	const show = await getShow(db, params.id);
	if (!show) return json({ error: 'Show not found' }, { status: 404 });
	if (show.dj_id !== user.id && user.role !== 'admin') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const broadcast = await resolveBroadcastForShow(db, show.id, params.broadcastId);
	if (!broadcast) return json({ error: 'Episode not found' }, { status: 404 });

	const explicit = url.searchParams.get('url')?.trim() ?? '';
	const candidate = explicit || (broadcast.serato_url ?? '');

	if (!candidate) {
		return json({ status: 'no-url' });
	}

	const playlistUrl = normalizeSeratoPlaylistUrl(candidate);
	if (!playlistUrl) {
		return json({ error: 'That is not a serato.com playlist URL' }, { status: 400 });
	}

	return json(await fetchSeratoPlaylistUrl(playlistUrl));
};

/**
 * Save (or clear) the episode's Serato playlist URL.
 *
 * Kept separate from the import so a DJ can paste the URL before the playlist is
 * published; the import then works later without retyping.
 */
export const PUT: RequestHandler = async ({ request, params, locals, platform }) => {
	const user = locals.user;
	if (!user || (user.role !== 'dj' && user.role !== 'admin')) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const db = platform!.env.DB;
	const show = await getShow(db, params.id);
	if (!show) return json({ error: 'Show not found' }, { status: 404 });
	if (show.dj_id !== user.id && user.role !== 'admin') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const broadcast = await resolveBroadcastForShow(db, show.id, params.broadcastId);
	if (!broadcast) return json({ error: 'Episode not found' }, { status: 404 });

	const body = (await request.json().catch(() => ({}))) as { url?: unknown };
	const raw = typeof body.url === 'string' ? body.url.trim() : '';
	const nowSec = Math.floor(Date.now() / 1000);

	if (raw === '') {
		await db
			.prepare('UPDATE broadcast SET serato_url = NULL, updated_at = ? WHERE id = ?')
			.bind(nowSec, broadcast.id)
			.run();
		return json({ ok: true, url: null });
	}

	if (!isSeratoPlaylistUrl(raw)) {
		return json({ error: 'Paste the serato.com playlist URL for this set' }, { status: 400 });
	}

	await db
		.prepare('UPDATE broadcast SET serato_url = ?, updated_at = ? WHERE id = ?')
		.bind(raw, nowSec, broadcast.id)
		.run();

	return json({ ok: true, url: raw });
};
