import { AZURACAST_BASE, AZURACAST_STATION_ID } from '$lib/azuracast';

/**
 * Replay lengths straight from AzuraCast's media list.
 *
 * The public on-demand API omits durations, but the authenticated station files
 * endpoint reports `length` (seconds) for every media file, keyed by the same
 * 24-hex `unique_id` used in replay URLs. One cached call covers the archive, so
 * the episode lists can show real recording lengths without probing each file.
 */

const CACHE_KEY = 'https://vr-azuracast-files.internal/v1';
const CACHE_SECONDS = 600;
const FETCH_TIMEOUT_MS = 4_000;

interface EdgeCache {
	match(key: string): Promise<{ json(): Promise<unknown> } | undefined>;
	put(key: string, response: unknown): Promise<void>;
}

interface AzuraCastFile {
	unique_id?: unknown;
	length?: unknown;
}

export async function getReplayLengthMap(
	platform: App.Platform | undefined
): Promise<Map<string, number>> {
	const apiKey = platform?.env.AZURACAST_API_KEY;
	if (!apiKey) return new Map();

	const cache = platform?.caches?.default as unknown as EdgeCache | undefined;
	if (cache) {
		const hit = await cache.match(CACHE_KEY).catch(() => undefined);
		if (hit) {
			const stored = (await hit.json().catch(() => null)) as Record<string, unknown> | null;
			if (stored) {
				const map = new Map<string, number>();
				for (const [id, value] of Object.entries(stored)) {
					if (typeof value === 'number' && value > 0) map.set(id, value);
				}
				return map;
			}
		}
	}

	try {
		const res = await fetch(`${AZURACAST_BASE}/api/station/${AZURACAST_STATION_ID}/files`, {
			headers: { 'X-API-Key': apiKey, accept: 'application/json' },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
		if (!res.ok) return new Map();

		const files = (await res.json().catch(() => null)) as AzuraCastFile[] | null;
		if (!Array.isArray(files)) return new Map();

		const lengths = new Map<string, number>();
		for (const file of files) {
			if (typeof file.unique_id !== 'string') continue;
			if (typeof file.length !== 'number' || file.length <= 0) continue;
			lengths.set(file.unique_id.toLowerCase(), file.length);
		}

		if (cache) {
			await cache
				.put(
					CACHE_KEY,
					Response.json(Object.fromEntries(lengths), {
						headers: { 'cache-control': `public, max-age=${CACHE_SECONDS}` }
					})
				)
				.catch(() => undefined);
		}
		return lengths;
	} catch {
		return new Map();
	}
}
