import { json } from '@sveltejs/kit';
import { getReplayLengthMap } from '$lib/server/azuracastFiles';
import type { RequestHandler } from './$types';

/**
 * Track id → replay length in seconds, for client-side hydration of the episode
 * lists. The archive is small; one cached AzuraCast call covers every replay.
 */
export const GET: RequestHandler = async ({ platform }) => {
	const lengths = await getReplayLengthMap(platform);
	return json(Object.fromEntries(lengths), {
		headers: { 'cache-control': 'public, max-age=300' }
	});
};
