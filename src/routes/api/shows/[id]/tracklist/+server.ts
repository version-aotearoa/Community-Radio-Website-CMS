import { json } from '@sveltejs/kit';
import {
	ensureBroadcasts,
	getActiveBroadcast,
	getShow,
	getTracklist,
	replaceTracklist
} from '$lib/server/shows';
import type { TrackInput } from '$lib/server/shows';
import { isValidMark } from '$lib/trackTime';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, platform }) => {
	const show = await getShow(platform!.env.DB, params.id);
	if (!show) return json({ error: 'Not found' }, { status: 404 });

	const broadcast = await getActiveBroadcast(platform!.env.DB, show.id);
	if (!broadcast) return json({ tracks: [] });

	const tracks = await getTracklist(platform!.env.DB, broadcast.id);
	return json(tracks);
};

export const PUT: RequestHandler = async ({ request, params, locals, platform }) => {
	const user = locals.user;
	if (!user || (user.role !== 'dj' && user.role !== 'admin')) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const show = await getShow(platform!.env.DB, params.id);
	if (!show) return json({ error: 'Not found' }, { status: 404 });
	if (show.dj_id !== user.id && user.role !== 'admin') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	await ensureBroadcasts(platform!.env.DB, show);
	const broadcast = await getActiveBroadcast(platform!.env.DB, show.id);
	if (!broadcast) return json({ error: 'No broadcast for this show' }, { status: 409 });

	const body = (await request.json()) as {
		tracks?: Array<{
			title?: string;
			artist?: string;
			album?: string;
			url?: string;
			markSeconds?: unknown;
		}>;
	};
	if (!Array.isArray(body.tracks)) {
		return json({ error: 'tracks must be an array' }, { status: 400 });
	}
	const filtered: (TrackInput & { url: string | null })[] = body.tracks
		.map((t) => ({
			title: String(t.title ?? ''),
			artist: String(t.artist ?? ''),
			album: String(t.album ?? ''),
			url: String(t.url ?? '').trim() || null,
			markSeconds: isValidMark(t.markSeconds) ? t.markSeconds : null
		}))
		.filter((t) => t.title.trim() !== '' || t.url !== null || t.markSeconds !== null);

	const tracks = await replaceTracklist(platform!.env.DB, broadcast.id, filtered);
	return json(tracks);
};
