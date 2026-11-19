import { getEpisodeArchive, getSchedule } from '$lib/server/shows';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, platform }) => {
	const view = url.searchParams.get('view') === 'episodes' ? 'episodes' : 'shows';
	return {
		view,
		shows: await getSchedule(platform!.env.DB),
		episodes: view === 'episodes' ? await getEpisodeArchive(platform!.env.DB) : []
	};
};
