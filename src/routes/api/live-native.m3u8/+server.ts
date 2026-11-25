import { AZURACAST_BASE, AZURACAST_STATION_SHORTCODE } from '$lib/azuracast';
import type { RequestHandler } from './$types';

/**
 * Bitrate-capped HLS master for devices that must use native HLS (iOS/iPadOS).
 *
 * Native Safari cannot use hls.js, so its ABR picks from whatever the master
 * offers. The full AzuraCast master includes the 211 kbps hifi variant, which
 * the direct NZ → Amsterdam path cannot sustain (~16–25 KB/s measured), so
 * playback buffers. This master offers only lofi (52.8 kbps) and midfi
 * (105.6 kbps), both of which fit the measured path, while still letting iOS
 * ABR choose between them.
 *
 * Variants stay on the AzuraCast origin: the Worker proxy stalls native HLS.
 */
export const GET: RequestHandler = () => {
	const base = `${AZURACAST_BASE}/hls/${AZURACAST_STATION_SHORTCODE}`;
	const body = [
		'#EXTM3U',
		'#EXT-X-VERSION:3',
		'',
		'#EXT-X-STREAM-INF:BANDWIDTH=52800,CODECS="mp4a.40.2",NAME="Low"',
		`${base}/aac_lofi.m3u8`,
		'',
		'#EXT-X-STREAM-INF:BANDWIDTH=105600,CODECS="mp4a.40.2",NAME="Medium"',
		`${base}/aac_midfi.m3u8`,
		''
	].join('\n');

	return new Response(body, {
		headers: {
			'content-type': 'application/vnd.apple.mpegurl',
			'cache-control': 'no-cache',
			'access-control-allow-origin': '*'
		}
	});
};
