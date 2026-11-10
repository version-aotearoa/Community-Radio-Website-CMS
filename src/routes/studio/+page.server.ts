import { requireAdmin } from '$lib/server/guard';
import { getAllShows } from '$lib/server/shows';
import { episodeRoomKey, parseEpisodeRoomKey } from '$lib/chat';
import type { PageServerLoad } from './$types';

interface StudioEpisodeRow {
	id: string;
	show_id: string;
	date: string;
	title: string;
}

export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const user = requireAdmin(locals, '/studio');
	const db = platform!.env.DB;
	const recentEpisodes = await db
		.prepare(
			`SELECT b.id, b.show_id, b.date, s.title
			 FROM broadcast b
			 JOIN show s ON s.id = b.show_id
			 WHERE b.cancelled = 0
			 ORDER BY b.date DESC, b.start_minutes DESC
			 LIMIT 100`
		)
		.all();
	const rows = recentEpisodes.results as unknown as StudioEpisodeRow[];

	// Deep link from an episode page. Older episodes fall outside the recent-100
	// window, so resolve their show title on its own (idx_broadcast_show).
	const requestedRoom = url.searchParams.get('room') ?? '';
	const parsedRoom = parseEpisodeRoomKey(requestedRoom);
	const inWindow =
		!parsedRoom ||
		rows.some((ep) => episodeRoomKey(ep.show_id, ep.date) === requestedRoom);
	const linkedEpisode =
		parsedRoom && !inWindow
			? ((await db
					.prepare(
						`SELECT b.id, b.show_id, b.date, s.title
						 FROM broadcast b
						 JOIN show s ON s.id = b.show_id
						 WHERE b.show_id = ? AND b.date = ?
						 LIMIT 1`
					)
					.bind(parsedRoom.showId, parsedRoom.date)
					.first()) as StudioEpisodeRow | null)
			: null;

	return {
		user,
		shows: await getAllShows(db),
		recentEpisodes: rows,
		linkedEpisode
	};
};
