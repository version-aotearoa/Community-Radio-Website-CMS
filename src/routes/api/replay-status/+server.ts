import { json } from '@sveltejs/kit';
import { probeReplayUrls } from '$lib/server/replayStatus';
import type { RequestHandler } from './$types';

const MAX_URLS = 24;
const MAX_LEN = 500;

/**
 * Which of these replay links no longer serve audio?
 *
 * Called by the page after paint so availability never blocks rendering. Only
 * links that answered definitively are reported; anything still unknown (429,
 * 5xx, timeout) is left out so the UI keeps offering the player.
 */
export const GET: RequestHandler = async ({ url }) => {
	const urls = url.searchParams
		.getAll('url')
		.slice(0, MAX_URLS)
		.map((u) => u.trim())
		.filter((u) => u.length > 0 && u.length <= MAX_LEN && /^https?:\/\//i.test(u));

	const statuses = await probeReplayUrls(urls);
	const unavailable = [...statuses].filter(([, dead]) => dead).map(([u]) => u);

	return json(
		{ unavailable },
		{ headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } }
	);
};
