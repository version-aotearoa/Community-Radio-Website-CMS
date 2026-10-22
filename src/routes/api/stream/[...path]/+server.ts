import { error, text } from '@sveltejs/kit';
import { AZURACAST_BASE } from '$lib/azuracast';
import type { RequestHandler } from './$types';

/**
 * Same-origin proxy for AzuraCast HLS (and media) streams:
 * hls.js uses XHR, which is CORS-blocked against the AzuraCast origin from
 * arbitrary origins. Serving through our own Worker avoids that entirely.
 */
const AZURACAST = AZURACAST_BASE;
const ALLOWED_PREFIXES = ['/hls/', '/media/', '/api/station/'];

export const GET: RequestHandler = async ({ params }) => {
	const path = `/${params.path ?? ''}`;
	if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
		return text('Not found', { status: 404 });
	}

	try {
		const upstream = await fetch(`${AZURACAST}${path}`, {
			redirect: 'follow'
		});
		if (!upstream.ok) return text('Upstream error', { status: upstream.status });

		const headers = new Headers();
		const contentType = upstream.headers.get('content-type');
		if (contentType) headers.set('content-type', contentType);
		headers.set('access-control-allow-origin', '*');
		headers.set('cache-control', 'public, max-age=10');

		return new Response(upstream.body, { status: 200, headers });
	} catch (e) {
		console.error('[vr] stream proxy failed', path, e);
		return text('Proxy error', { status: 502 });
	}
};
