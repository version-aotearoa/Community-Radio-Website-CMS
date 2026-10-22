/**
 * Per-recording availability probe.
 *
 * A replay link only becomes "No longer available" once the file itself stops
 * serving audio — never because of which host it points at. Recordings are
 * spread across AzuraCast instances (one host per migration era) and an old
 * host keeps working until it is actually retired, so guessing from the origin
 * takes playable episodes offline.
 *
 * Probes are HEAD requests cached per isolate: a short TTL for failures so a
 * recovered file stops being flagged quickly, a longer one for successes.
 */

const AVAILABLE_TTL_MS = 10 * 60_000;
const UNAVAILABLE_TTL_MS = 2 * 60_000;
const PROBE_TIMEOUT_MS = 4000;
const RETRY_DELAY_MS = 900;
const MAX_CONCURRENCY = 4;
const MAX_ENTRIES = 500;

interface CacheEntry {
	unavailable: boolean;
	at: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<boolean>>();

function remember(url: string, unavailable: boolean): void {
	if (cache.size >= MAX_ENTRIES) {
		const oldest = cache.keys().next();
		if (!oldest.done) cache.delete(oldest.value);
	}
	cache.set(url, { unavailable, at: Date.now() });
}

async function probeOnce(url: string): Promise<{ unavailable: boolean } | null> {
	let res: Response;
	try {
		res = await fetch(url, {
			method: 'HEAD',
			redirect: 'follow',
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
		});
	} catch {
		return null; // network-level failure: could be a dead host OR a rate limit
	}

	if (res.status === 404 || res.status === 410) return { unavailable: true };
	// 429/5xx and anything else unexpected says nothing about the file itself.
	if (!res.ok) return { unavailable: false };

	// AzuraCast answers pruned recordings with an HTML page instead of audio.
	const type = (res.headers.get('content-type') ?? '').toLowerCase();
	return { unavailable: type.startsWith('text/html') };
}

async function probe(rawUrl: string): Promise<boolean> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return true; // not a URL, so nothing can play it
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;

	const first = await probeOnce(parsed.href);
	if (first) return first.unavailable;

	// A single network failure is not evidence (AzuraCast rate-limits bursts and
	// can reset connections under load). Only a repeated failure counts.
	await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
	const second = await probeOnce(parsed.href);
	return second ? second.unavailable : true;
}

/** True when the recording behind `url` does not serve audio right now. */
export async function isReplayFileUnavailable(url: string): Promise<boolean> {
	const hit = cache.get(url);
	if (hit) {
		const ttl = hit.unavailable ? UNAVAILABLE_TTL_MS : AVAILABLE_TTL_MS;
		if (Date.now() - hit.at < ttl) return hit.unavailable;
	}

	const pending = inFlight.get(url);
	if (pending) return pending;

	const run = probe(url)
		.then((unavailable) => {
			remember(url, unavailable);
			return unavailable;
		})
		.finally(() => inFlight.delete(url));
	inFlight.set(url, run);
	return run;
}

/** Add `replay_unavailable` to rows, probing each distinct link once. */
export async function annotateReplayStatus<T extends { replay_url: string | null }>(
	rows: T[]
): Promise<(T & { replay_unavailable: boolean })[]> {
	const urls = [
		...new Set(rows.map((r) => r.replay_url).filter((u): u is string => Boolean(u?.trim())))
	];
	const status = new Map<string, boolean>();

	// Small pool: a show page can list a couple of dozen episodes, and firing
	// them all at once gets rate-limited by AzuraCast (429) rather than answered.
	let cursor = 0;
	const worker = async () => {
		while (cursor < urls.length) {
			const url = urls[cursor++];
			status.set(url, await isReplayFileUnavailable(url));
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(MAX_CONCURRENCY, urls.length) }, () => worker())
	);

	return rows.map((r) => ({
		...r,
		replay_unavailable: r.replay_url ? (status.get(r.replay_url) ?? false) : false
	}));
}
