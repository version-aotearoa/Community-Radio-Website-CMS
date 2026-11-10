import { error } from '@sveltejs/kit';
import { artUrlHash, normalizeAzuraCastArtUrl } from '$lib/azuracast';
import type { RequestHandler } from './$types';

const FILE_RE = /^[0-9a-f]{8}\.jpg$/;

/**
 * Edge-cached proxy for admin-set episode artwork: /media/ep/<broadcastId>/<hash>.jpg
 * Resolves the stored `broadcast.art` URL for the broadcast, verifies the hash
 * (so only real episode art can be proxied — no open proxy), fetches the
 * upstream once, then serves it through Cloudflare's CDN with a year-long
 * immutable cache. Changing the art URL changes the hash -> fresh cache.
 */
export const GET: RequestHandler = async ({ params, platform, fetch: cfFetch }) => {
	const { broadcastId, file } = params;
	if (!file || !FILE_RE.test(file)) error(404, 'Not found');

	const row = (await platform!.env.DB.prepare('SELECT art FROM broadcast WHERE id = ?')
		.bind(broadcastId)
		.first()) as { art: string | null } | null;
	const art = row?.art?.trim();
	if (!art || !/^https?:\/\//i.test(art)) error(404, 'Not found');
	if (artUrlHash(art) !== file.replace(/\.\w+$/, '')) error(404, 'Not found');

	// The hash is over the stored URL (what the page linked), but fetch the
	// current AzuraCast host if the stored value predates a server move.
	const upstream = await cfFetch(normalizeAzuraCastArtUrl(art));
	if (!upstream.ok) error(502, 'Upstream error');

	return new Response(upstream.body, {
		headers: {
			'cache-control': 'public, max-age=31536000, immutable, stale-while-revalidate=86400',
			'content-type': upstream.headers.get('content-type') ?? 'image/jpeg',
			etag: `"${broadcastId}-${file}"`,
			'x-content-type-options': 'nosniff'
		}
	});
};
