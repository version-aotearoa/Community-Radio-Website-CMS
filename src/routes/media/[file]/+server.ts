import { error } from '@sveltejs/kit';
import { AZURACAST_BASE, AZURACAST_STATION_SHORTCODE } from '$lib/azuracast';
import type { RequestHandler } from './$types';

const UPSTREAM_BASE = `${AZURACAST_BASE}/api/station/${AZURACAST_STATION_SHORTCODE}/art`;
// Accepts timestamped (<24hex>-<ts>.jpg, as stored for show images) AND bare
// (<24hex>.jpg, as emitted for replay/live art). The upstream rejects a bare id
// with a .jpg extension (405), so we strip it before the upstream call.
const FILE_RE = /^[a-z0-9]{24}(?:-\d+)?\.(?:jpg|jpeg|png|webp|avif)$/i;
const BARE_RE = /^[a-z0-9]{24}$/i;

/**
 * Edge-cached art proxy: /media/<art-file>.jpg
 * Fetches the AzuraCast artwork once, then serves it through Cloudflare's CDN
 * with a year-long immutable cache so card images are instant for everyone.
 */
export const GET: RequestHandler = async ({ params, fetch: cfFetch }) => {
	const file = params.file;
	if (!file || !FILE_RE.test(file)) error(404, 'Not found');

	// Bare track ids upstream need no extension (the .jpg form 405s).
	const upstreamFile = BARE_RE.test(file.replace(/\.\w+$/, '')) ? file.replace(/\.\w+$/, '') : file;

	/**
	 * AzuraCast answers an unknown art id — including a stale `<id>-<timestamp>`
	 * left over from a previous instance — with a redirect to a generic
	 * placeholder. Never cache that as the recording's artwork: fall back to the
	 * bare id (re-imported artwork keeps the id, not the timestamp), and only
	 * 404 when even that has no artwork.
	 */
	const fetchArt = async (name: string) => cfFetch(`${UPSTREAM_BASE}/${name}`);

	let upstream = await fetchArt(upstreamFile);
	if (upstream.redirected) {
		const bare = upstreamFile.replace(/\.\w+$/, '').replace(/-\d+$/, '');
		if (BARE_RE.test(bare)) {
			upstream = await fetchArt(bare);
		}
	}
	if (upstream.redirected) error(404, 'Not found');
	if (!upstream.ok) error(404, 'Not found');

	return new Response(upstream.body, {
		headers: {
			'cache-control': 'public, max-age=31536000, immutable, stale-while-revalidate=86400',
			'content-type': upstream.headers.get('content-type') ?? 'image/jpeg',
			etag: `"${file}"`,
			'x-content-type-options': 'nosniff'
		}
	});
};
