import { text } from '@sveltejs/kit';
import { AZURACAST_BASE } from '$lib/azuracast';
import type { RequestHandler } from './$types';

/**
 * Same-origin proxy for AzuraCast HLS and media.
 *
 * hls.js uses XHR, which is CORS-blocked against the AzuraCast origin from
 * arbitrary origins. It also gives playback a Cloudflare-backbone route to the
 * origin: the AzuraCast VPS is in Amsterdam while the audience is in NZ, and
 * the direct path can run below the stream bitrate (measured 16–25 KB/s vs
 * ~123 KB/s through this Worker).
 *
 * Range requests pass through so on-demand replays stay seekable.
 */
const ALLOWED_PREFIXES = ['/hls/', '/media/', '/api/station/'];

/** Request headers that must survive for seeking / conditional fetches. */
const FORWARD_REQUEST = ['range', 'if-range'];

/** Upstream headers needed to honour 206s and cacheable media. */
const FORWARD_RESPONSE = [
	'content-type',
	'content-length',
	'content-range',
	'accept-ranges',
	'etag',
	'last-modified'
];

async function proxy(request: Request, params: { path?: string }): Promise<Response> {
	const path = `/${params.path ?? ''}`;
	if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
		return text('Not found', { status: 404 });
	}

	const forwarded = new Headers();
	for (const name of FORWARD_REQUEST) {
		const value = request.headers.get(name);
		if (value) forwarded.set(name, value);
	}

	try {
		const upstream = await fetch(`${AZURACAST_BASE}${path}`, {
			method: request.method === 'HEAD' ? 'HEAD' : 'GET',
			headers: forwarded,
			redirect: 'follow'
		});
		if (!upstream.ok) return text('Upstream error', { status: upstream.status });

		const headers = new Headers();
		for (const name of FORWARD_RESPONSE) {
			const value = upstream.headers.get(name);
			if (value) headers.set(name, value);
		}
		headers.set('access-control-allow-origin', '*');
		// Playlists change every segment; media is safe to cache briefly. Never
		// cache a partial response — a 206 is only valid for that one range.
		headers.set(
			'cache-control',
			path.endsWith('.m3u8') ? 'no-cache' : upstream.status === 206 ? 'no-store' : 'public, max-age=10'
		);

		const body = request.method === 'HEAD' ? null : upstream.body;
		return new Response(body, { status: upstream.status, headers });
	} catch (e) {
		console.error('[vr] stream proxy failed', path, e);
		return text('Proxy error', { status: 502 });
	}
}

export const GET: RequestHandler = ({ request, params }) => proxy(request, params);

export const HEAD: RequestHandler = ({ request, params }) => proxy(request, params);
