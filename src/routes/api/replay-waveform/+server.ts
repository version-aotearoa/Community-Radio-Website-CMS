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
 */

const PEAK_COUNT = 240;
const CACHE_SECONDS = 60 * 60 * 24 * 7;

interface WaveformJson {
	data?: unknown;
	sample_rate?: number;
	samples_per_pixel?: number;
}

interface WaveformResult {
	peaks: number[];
	duration: number | null;
	source: 'azuracast';
}

/** Minimal Cache API shape; the bundled worker types disagree with SvelteKit's Response. */
interface EdgeCache {
	match(key: string): Promise<{ json(): Promise<unknown> } | undefined>;
	put(key: string, response: unknown): Promise<void>;
}

function fallback(): Response {
	return json({ peaks: null, duration: null });
}

/** Flatten channels and reduce to `PEAK_COUNT` normalised peaks. */
function downsample(payload: WaveformJson): { peaks: number[]; duration: number | null } | null {
	const raw = payload.data;
	if (!Array.isArray(raw) || raw.length === 0) return null;

	const channels: number[][] = Array.isArray(raw[0])
		? (raw as number[][]).filter((ch) => Array.isArray(ch))
		: [raw as number[]];
	if (channels.length === 0) return null;

	const frames = Math.max(...channels.map((ch) => ch.length));
	if (!Number.isFinite(frames) || frames <= 0) return null;

	const sums = new Array<number>(PEAK_COUNT).fill(0);
	const counts = new Array<number>(PEAK_COUNT).fill(0);
	const step = frames / PEAK_COUNT;
	for (let i = 0; i < frames; i++) {
		const bucket = Math.min(PEAK_COUNT - 1, Math.floor(i / step));
		let peak = 0;
		for (const channel of channels) {
			const value = Number(channel[i] ?? 0);
			if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value));
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
			? (frames * stepPerPixel) / sampleRate
			: null;

	return { peaks, duration: duration && Number.isFinite(duration) ? duration : null };
}

export const GET: RequestHandler = async ({ url, platform }) => {
	const replayUrl = url.searchParams.get('url')?.trim() ?? '';
	if (!replayUrl) return fallback();

	let parsed: URL;
	try {
		parsed = new URL(replayUrl);
	} catch {
		return fallback();
	}
	if (parsed.origin !== new URL(AZURACAST_BASE).origin) return fallback();

	const trackId = extractReplayTrackId(parsed.href);
	if (!trackId) return fallback();

	const cache = platform?.caches?.default as unknown as EdgeCache | undefined;
	const cacheKey = `https://vr-waveform.internal/v2/${trackId}`;
	if (cache) {
		const hit = await cache.match(cacheKey);
		if (hit) {
			const cached = (await hit.json().catch(() => null)) as WaveformResult | null;
			if (cached?.peaks?.length) return json(cached);
		}
	}

	const apiKey = platform?.env.AZURACAST_API_KEY;
	if (!apiKey) return fallback();

	try {
		const upstream = await fetch(
			`${AZURACAST_BASE}/api/station/${AZURACAST_STATION_ID}/waveform/${trackId}`,
			{
				headers: { 'X-API-Key': apiKey, accept: 'application/json' },
				signal: AbortSignal.timeout(20_000)
			}
		);
		if (!upstream.ok) return fallback();

		const body = (await upstream.json().catch(() => null)) as WaveformJson | null;
		if (!body) return fallback();
		const result = downsample(body);
		if (!result) return fallback();

		const response = json(
			{ peaks: result.peaks, duration: result.duration, source: 'azuracast' } satisfies WaveformResult,
			{ headers: { 'cache-control': `public, max-age=${CACHE_SECONDS}, immutable` } }
		);
		if (cache) await cache.put(cacheKey, response.clone());
		return response;
	} catch {
		return fallback();
	}
};
