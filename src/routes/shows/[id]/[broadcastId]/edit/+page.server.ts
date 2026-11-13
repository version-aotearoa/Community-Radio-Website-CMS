import { error } from '@sveltejs/kit';
import { requireDj } from '$lib/server/guard';
import { getShow, getTracklist, resolveBroadcastForShow } from '$lib/server/shows';
import { getReplayDuration } from '$lib/server/replayDuration';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const user = requireDj(locals, `/shows/${params.id}`);
	const db = platform!.env.DB;
	const show = await getShow(db, params.id);
	if (!show) error(404, 'Show not found');
	if (show.dj_id !== user.id && user.role !== 'admin') {
		error(403, 'You do not have permission to edit this show');
	}

	const broadcast = await resolveBroadcastForShow(db, show.id, params.broadcastId);
	if (!broadcast) error(404, 'Broadcast not found');

	const tracks = await getTracklist(db, broadcast.id);
	return {
		show,
		broadcast,
		tracks,
		/** Container-parsed length so the editor's waveform is seekable immediately. */
		replayDuration: await getReplayDuration(platform, broadcast.replay_url)
	};
};
