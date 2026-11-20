import { json } from '@sveltejs/kit';
import { getTrackSearchSuggestions } from '$lib/server/shows';
import type { RequestHandler } from './$types';

const MIN_QUERY = 2;

/** Autocomplete for the /shows episode search: matching artists and tracks. */
export const GET: RequestHandler = async ({ url, platform }) => {
	const query = (url.searchParams.get('q') ?? '').trim().slice(0, 80);
	if (query.length < MIN_QUERY) return json({ artists: [], tracks: [] });
	return json(await getTrackSearchSuggestions(platform!.env.DB, query));
};
