import {
	getEpisodeArchive,
	getEpisodeTrackMatches,
	getSchedule,
	type EpisodeListItem,
	type EpisodeMatchSummary
} from '$lib/server/shows';
import type { PageServerLoad } from './$types';

const MIN_QUERY = 2;

export const load: PageServerLoad = async ({ url, platform }) => {
	const db = platform!.env.DB;
	const view = url.searchParams.get('view') === 'episodes' ? 'episodes' : 'shows';
	const q = (url.searchParams.get('q') ?? '').trim().slice(0, 80);

	let episodes: Array<EpisodeListItem & Partial<EpisodeMatchSummary>> = [];
	if (view === 'episodes') {
		const archive = await getEpisodeArchive(db);
		if (q.length >= MIN_QUERY) {
			const matches = await getEpisodeTrackMatches(db, q);
			episodes = archive
				.filter((episode) => matches[episode.id])
				.map((episode) => ({ ...episode, ...matches[episode.id] }));
		} else {
			episodes = archive;
		}
	}

	return {
		view,
		q,
		shows: await getSchedule(db),
		episodes
	};
};
