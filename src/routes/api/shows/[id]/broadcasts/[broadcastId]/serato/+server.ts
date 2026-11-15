import { json } from '@sveltejs/kit';
import { getShow, resolveBroadcastForShow } from '$lib/server/shows';
import { fetchSeratoPlaylist, fetchSeratoPlaylistUrl } from '$lib/server/serato';
import { isSeratoPlaylistUrl, normalizeSeratoUser } from '$lib/serato';
import type { RequestHandler } from './$types';

/**
 * Preview a Serato import for this broadcast.
 *
 * The URL comes from an explicit `?url=` (one-off shows / guest DJs) or from the
 * show's `serato_user` handle + the broadcast date. Returns parsed rows only —
 * nothing is written until the DJ saves the tracklist.
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
	if (explicit) {
		if (!isSeratoPlaylistUrl(explicit)) {
			return json({ error: 'That is not a serato.com playlist URL' }, { status: 400 });
		}
		return json(await fetchSeratoPlaylistUrl(explicit));
	}

	const handle = normalizeSeratoUser(show.serato_user);
	if (!handle) {
		return json({
			status: 'no-handle',
			handle: show.serato_user ?? null,
			date: broadcast.date
		});
	}

	return json({ ...(await fetchSeratoPlaylist(handle, broadcast.date)), handle, date: broadcast.date });
};
