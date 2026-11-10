import { requireAdmin } from '$lib/server/guard';
import { getAllShows } from '$lib/server/shows';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform }) => {
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
	return {
		user,
		shows: await getAllShows(db),
		recentEpisodes: recentEpisodes.results as unknown as {
			id: string;
			show_id: string;
			date: string;
			title: string;
		}[]
	};
};
