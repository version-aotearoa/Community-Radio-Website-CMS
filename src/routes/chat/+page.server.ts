import { error } from '@sveltejs/kit';
import { episodeRoomKey, MAIN_CHAT_ROOM } from '$lib/chat';
import { fetchChatHistory } from '$lib/server/chatHistory';
import { resolveBroadcastForShow } from '$lib/server/shows';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, platform }) => {
	const db = platform!.env.DB;
	const chatUrl = platform?.env.PUBLIC_CHAT_URL ?? '';
	const siteKey = platform?.env.PUBLIC_TURNSTILE_SITE_KEY ?? '';
	const giphyKey = platform?.env.PUBLIC_GIPHY_API_KEY ?? '';

	const showId = url.searchParams.get('show');
	const date = url.searchParams.get('date');
	let room = MAIN_CHAT_ROOM;
	let roomLabel: string | null = null;
	let episodeHref: string | null = null;

	if (showId || date) {
		if (!showId || !date) error(404, 'Episode chat not found');
		const broadcast = await resolveBroadcastForShow(db, showId, date);
		if (!broadcast) error(404, 'Episode chat not found');
		const show = await db
			.prepare('SELECT title FROM show WHERE id = ?')
			.bind(showId)
			.first<{ title: string }>();
		room = episodeRoomKey(showId, date);
		roomLabel = `${show?.title ?? showId} · ${broadcast.date}`;
		episodeHref = `/shows/${showId}/${broadcast.id}`;
	}

	return {
		chatUrl,
		siteKey,
		giphyKey,
		room,
		roomLabel,
		episodeHref,
		isEpisodeRoom: room !== MAIN_CHAT_ROOM,
		initialMessages: await fetchChatHistory(chatUrl, room)
	};
};
