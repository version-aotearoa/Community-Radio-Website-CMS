import { error } from '@sveltejs/kit';
import { episodeRoomKey } from '$lib/chat';
import { fetchChatHistory } from '$lib/server/chatHistory';
import { getReplayDuration } from '$lib/server/replayDuration';
import {
	broadcastEnded,
	getBroadcasts,
	getShowWithDj,
	getTracklist,
	resolveBroadcastForShow,
	zonedNow
} from '$lib/server/shows';
import { getSavedCueSeconds } from '$lib/server/cues';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	const show = await getShowWithDj(db, params.id);
	if (!show) error(404, 'Show not found');
	const broadcast = await resolveBroadcastForShow(db, show.id, params.broadcastId);
	if (!broadcast) error(404, 'Broadcast not found');
	const tracks = await getTracklist(db, broadcast.id);

	// "More episodes": this show's own archive, newest first. Same rule as the
	// show page's Past broadcasts list (ended, not cancelled), so the two never
	// disagree; the current episode can't recommend itself.
	const ownEpisodes = await getBroadcasts(db, show.id);
	const recent = ownEpisodes
		.filter((b) => b.id !== broadcast.id && b.cancelled === 0 && broadcastEnded(zonedNow(), b))
		.reverse()
		.slice(0, 4);

	const user = locals.user ?? null;
	const savedCues = user ? await getSavedCueSeconds(db, user.id, broadcast.id) : [];
	const canEdit =
		user !== null && (user.role === 'admin' || (user.role === 'dj' && show.dj_id === user.id));
	const followed = user
		? Boolean(
				await db
					.prepare('SELECT 1 AS x FROM follow_show WHERE user_id = ? AND show_id = ?')
					.bind(user.id, show.id)
					.first()
			)
		: false;
	const savedEpisode = user
		? Boolean(
				await db
					.prepare('SELECT 1 AS x FROM saved_episode WHERE user_id = ? AND broadcast_id = ?')
					.bind(user.id, broadcast.id)
					.first()
			)
		: false;
	const favourited = user
		? Boolean(
				await db
					.prepare('SELECT 1 AS x FROM favourite_broadcast WHERE user_id = ? AND broadcast_id = ?')
					.bind(user.id, broadcast.id)
					.first()
			)
		: false;
	const favouriteTotal = await db
		.prepare('SELECT COUNT(*) AS n FROM favourite_broadcast WHERE broadcast_id = ?')
		.bind(broadcast.id)
		.first();

	const chatUrl = platform?.env.PUBLIC_CHAT_URL ?? '';
	const siteKey = platform?.env.PUBLIC_TURNSTILE_SITE_KEY ?? '';
	const giphyKey = platform?.env.PUBLIC_GIPHY_API_KEY ?? '';
	const chatRoom = episodeRoomKey(show.id, broadcast.date);

	return {
		show,
		broadcast,
		tracks,
		/** Up to four other ended episodes of this show, newest first. */
		recent,
		savedCues,
		followed,
		savedEpisode,
		favourited,
		favouriteCount: Number(favouriteTotal?.n ?? 0),
		canEdit,
		/** Admin-only Studio entry point for moderating this episode's comments. */
		isAdmin: user?.role === 'admin',
		/** Container-parsed length, so the waveform is seekable before playback. */
		replayDuration: await getReplayDuration(platform, broadcast.replay_url),
		chatUrl,
		siteKey,
		giphyKey,
		chatRoom,
		initialMessages: await fetchChatHistory(chatUrl, chatRoom)
	};
};
