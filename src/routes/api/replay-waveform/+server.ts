import { json } from '@sveltejs/kit';
import { AZURACAST_BASE, AZURACAST_STATION_ID, extractReplayTrackId } from '$lib/azuracast';
import type { RequestHandler } from './$types';

/**
 * Real waveform peaks for an AzuraCast replay.
 *
 * AzuraCast's waveform endpoint is keyed on the 24-hex media unique id — which
 * is the same id as the on-demand track id — and returns audiowaveform JSON.
 * We downsample it to a few hundred peaks and cache that tiny result so the
 * browser never sees the API key or the multi-megabyte upstream payload.
 *
 * Not every recording can be processed: audiowaveform decodes through
 * libsndfile, which handles WAV/MP3/FLAC/Ogg Vorbis/Opus but not the MP4/AAC
 * container, so an `.m4a` recording makes AzuraCast answer 500. That failure is
 * remembered briefly (`reason: 'unsupported'`) so each page view doesn't retry
 * a slow, doomed generation attempt.
 */

const PEAK_COUNT = 240;
const CACHE_SECONDS = 60 * 60 * 24 * 7;
/** How long an unprocessable recording is remembered before retrying upstream. */
const UNSUPPORTED_CACHE_SECONDS = 60 * 60 * 6;

interface WaveformJson {
	data?: unknown;
	length?: number;
	sample_rate?: number;
	samples_per_pixel?: number;
}

type WaveformReason =
	| 'no-url'
	| 'bad-url'
	| 'foreign-host'
	| 'no-track-id'
	| 'no-key'
	| 'unsupported'
	| 'upstream'
	| 'bad-payload';

interface WaveformResult {
	peaks: number[] | null;
	duration: number | null;
	source?: 'azuracast';
	reason?: WaveformReason;
}

/** Minimal Cache API shape; the bundled worker types disagree with SvelteKit's Response. */
interface EdgeCache {
	match(key: string): Promise<{ json(): Promise<unknown> } | undefined>;
	put(key: string, response: unknown): Promise<void>;
}

function fallback(reason: WaveformReason): Response {
	return json(
		{ peaks: null, duration: null, reason } satisfies WaveformResult,
		{ headers: { 'cache-control': 'no-store' } }
	);
}

/**
 * Flatten channels and reduce to `PEAK_COUNT` normalised peaks.
 *
 * audiowaveform's JSON stores a min/max pair per pixel rather than one value:
 * `data` is a flat array of `2 * length` numbers for mono, or one such array per
 * channel for stereo. Treating every number as a frame (the previous behaviour)
 * doubled both the pixel count and the derived duration, so comment pins and
 * click-to-seek mapped at half scale until the player reported the real length.
 */
function downsample(payload: WaveformJson): { peaks: number[]; duration: number | null } | null {
	const raw = payload.data;
	if (!Array.isArray(raw) || raw.length === 0) return null;

	const channels = (Array.isArray(raw[0]) ? raw : [raw]).filter((ch) => Array.isArray(ch)) as number[][];
	if (channels.length === 0) return null;

	const minFrames = Math.min(...channels.map((ch) => ch.length));
	if (!Number.isFinite(minFrames) || minFrames <= 0) return null;

	// `length` is the authoritative pixel count; fall back to the frame count for
	// a payload that omits it (pairs when even, single values otherwise).
	const declared = Number(payload.length);
	const hasLength = Number.isFinite(declared) && declared > 0;
	const paired = hasLength ? minFrames >= declared * 2 : minFrames % 2 === 0;
	const pixels = hasLength ? declared : Math.floor(minFrames / (paired ? 2 : 1));
	if (!Number.isFinite(pixels) || pixels <= 0) return null;

	const amplitudeAt = (channel: number[], pixel: number): number => {
		if (!paired) return Math.abs(Number(channel[pixel] ?? 0));
		const low = Math.abs(Number(channel[pixel * 2] ?? 0));
		const high = Math.abs(Number(channel[pixel * 2 + 1] ?? 0));
		return Math.max(low, high);
	};

	const sums = new Array<number>(PEAK_COUNT).fill(0);
	const counts = new Array<number>(PEAK_COUNT).fill(0);
	const step = pixels / PEAK_COUNT;
	for (let pixel = 0; pixel < pixels; pixel++) {
		const bucket = Math.min(PEAK_COUNT - 1, Math.floor(pixel / step));
		let peak = 0;
		for (const channel of channels) {
			const value = amplitudeAt(channel, pixel);
			if (Number.isFinite(value)) peak = Math.max(peak, value);
		}
		sums[bucket] += peak;
		counts[bucket] += 1;
	}

	const buckets = sums.map((sum, i) => (counts[i] > 0 ? sum / counts[i] : 0));
	const max = Math.max(...buckets);
	if (!Number.isFinite(max) || max <= 0) return null;
	const peaks = buckets.map((value) => Math.max(0.02, Math.min(1, value / max)));

	const sampleRate = Number(payload.sample_rate);
	const stepPerPixel = Number(payload.samples_per_pixel);
	const duration =
		Number.isFinite(sampleRate) &&
		sampleRate > 0 &&
		Number.isFinite(stepPerPixel) &&
		stepPerPixel > 0
			? (pixels * stepPerPixel) / sampleRate
			: null;

	return { peaks, duration: duration && Number.isFinite(duration) ? duration : null };
}

export const GET: RequestHandler = async ({ url, platform }) => {
	const replayUrl = url.searchParams.get('url')?.trim() ?? '';
	if (!replayUrl) return fallback('no-url');

	let parsed: URL;
	try {
		parsed = new URL(replayUrl);
	} catch {
		return fallback('bad-url');
	}
	if (parsed.origin !== new URL(AZURACAST_BASE).origin) return fallback('foreign-host');

	const trackId = extractReplayTrackId(parsed.href);
	if (!trackId) return fallback('no-track-id');

	const cache = platform?.caches?.default as unknown as EdgeCache | undefined;
	const cacheKey = `https://vr-waveform.internal/v3/${trackId}`;
	if (cache) {
		const hit = await cache.match(cacheKey);
		if (hit) {
			const cached = (await hit.json().catch(() => null)) as WaveformResult | null;
			if (cached && (cached.peaks?.length || cached.reason)) return json(cached);
		}
	}

	const apiKey = platform?.env.AZURACAST_API_KEY;
	if (!apiKey) return fallback('no-key');

	try {
		const upstream = await fetch(
			`${AZURACAST_BASE}/api/station/${AZURACAST_STATION_ID}/waveform/${trackId}`,
			{
				headers: { 'X-API-Key': apiKey, accept: 'application/json' },
				signal: AbortSignal.timeout(20_000)
			}
		);
		if (!upstream.ok) {
			// AzuraCast reports an undecodable container as a 500 whose body names
			// the file and format. Only that verdict is cached — a transient outage
			// must not be remembered as "this recording has no waveform".
			const detail = await upstream.text().catch(() => '');
			const unsupported = upstream.status >= 500 && /waveform|file format/i.test(detail);
			if (unsupported) {
				const negative = json(
					{ peaks: null, duration: null, reason: 'unsupported' } satisfies WaveformResult,
					{
						headers: { 'cache-control': `public, max-age=${UNSUPPORTED_CACHE_SECONDS}` }
					}
				);
				if (cache) await cache.put(cacheKey, negative.clone());
				return negative;
			}
			return fallback('upstream');
		}

		const body = (await upstream.json().catch(() => null)) as WaveformJson | null;
		if (!body) return fallback('bad-payload');
		const result = downsample(body);
		if (!result) return fallback('bad-payload');

		const response = json(
			{ peaks: result.peaks, duration: result.duration, source: 'azuracast' } satisfies WaveformResult,
			{ headers: { 'cache-control': `public, max-age=${CACHE_SECONDS}, immutable` } }
		);
		if (cache) await cache.put(cacheKey, response.clone());
		return response;
	} catch {
		return fallback('upstream');
	}
};
