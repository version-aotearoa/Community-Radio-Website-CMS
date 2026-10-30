import { json } from '@sveltejs/kit';
import { getShow, getTracklist, replaceTracklist, resolveBroadcastForShow } from '$lib/server/shows';
import { isValidMark, MARK_MAX_SECONDS } from '$lib/trackTime';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, platform }) => {
	const db = platform!.env.DB;
	const broadcast = await resolveBroadcastForShow(db, params.id, params.broadcastId);
	if (!broadcast) return json({ error: 'Not found' }, { status: 404 });
	const tracks = await getTracklist(db, broadcast.id);
	return json(tracks);
};

export const PUT: RequestHandler = async ({ request, params, locals, platform }) => {
	const user = locals.user ?? null;
	if (!user || (user.role !== 'dj' && user.role !== 'admin')) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const show = await getShow(platform!.env.DB, params.id);
	if (!show) return json({ error: 'Not found' }, { status: 404 });
	if (show.dj_id !== user.id && user.role !== 'admin') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const broadcast = await resolveBroadcastForShow(
		platform!.env.DB,
		show.id,
		params.broadcastId
	);
	if (!broadcast) return json({ error: 'Not found' }, { status: 404 });

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
	for (const [i, t] of body.tracks.entries()) {
		const mark = t.markSeconds;
		if (mark !== null && mark !== undefined && !isValidMark(mark)) {
			return json(
				{ error: `Row ${i + 1}: time must be whole seconds between 0 and ${MARK_MAX_SECONDS}` },
				{ status: 400 }
			);
		}
	}
	const filtered = body.tracks
		.map((t) => ({
			title: String(t.title ?? ''),
			artist: String(t.artist ?? ''),
			album: String(t.album ?? ''),
			url: String(t.url ?? '').trim() || null,
			markSeconds: isValidMark(t.markSeconds) ? t.markSeconds : null
		}))
		.filter((t) => t.title.trim() !== '' || t.url !== null);

	const tracks = await replaceTracklist(platform!.env.DB, broadcast.id, filtered);
	return json(tracks);
};
