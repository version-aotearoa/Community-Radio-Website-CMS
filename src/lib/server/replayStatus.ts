/**
 * Per-recording availability probe.
 *
 * A replay link only becomes "No longer available" once the file itself stops
 * serving audio — never because of which host it points at. Recordings are
 * spread across AzuraCast instances (one host per migration era) and an old
 * host keeps working until it is actually retired, so guessing from the origin
 * takes playable episodes offline.
 *
 * IMPORTANT: this must never run on the render path. Upstream HEADs can stall
 * for seconds from a Worker (rate limits, blocked egress), and awaiting them
 * during SSR timed out whole page loads. Pages render immediately and ask
 * /api/replay-status; results are cached per isolate.
 */

const AVAILABLE_TTL_MS = 10 * 60_000;
const UNAVAILABLE_TTL_MS = 2 * 60_000;
const PROBE_TIMEOUT_MS = 2500;
const RETRY_DELAY_MS = 700;
const MAX_CONCURRENCY = 4;
const MAX_ENTRIES = 500;
const DEFAULT_BUDGET_MS = 3000;

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

async function probeOnce(url: string, timeoutMs: number): Promise<{ unavailable: boolean } | null> {
	let res: Response;
	try {
		res = await fetch(url, {
			method: 'HEAD',
			redirect: 'follow',
			signal: AbortSignal.timeout(timeoutMs)
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

async function probe(rawUrl: string, timeoutMs: number): Promise<boolean> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return true; // not a URL, so nothing can play it
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;

	const first = await probeOnce(parsed.href, timeoutMs);
	if (first) return first.unavailable;

	// A single network failure is not evidence (AzuraCast rate-limits bursts and
	// can reset connections under load). Only a repeated failure counts.
	await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
	const second = await probeOnce(parsed.href, timeoutMs);
	return second ? second.unavailable : true;
}

/** True when the recording behind `url` does not serve audio right now. */
export async function isReplayFileUnavailable(
	url: string,
	timeoutMs = PROBE_TIMEOUT_MS
): Promise<boolean> {
	const hit = cache.get(url);
	if (hit) {
		const ttl = hit.unavailable ? UNAVAILABLE_TTL_MS : AVAILABLE_TTL_MS;
		if (Date.now() - hit.at < ttl) return hit.unavailable;
	}

	const pending = inFlight.get(url);
	if (pending) return pending;

	const run = probe(url, timeoutMs)
		.then((unavailable) => {
			remember(url, unavailable);
			return unavailable;
		})
		.finally(() => inFlight.delete(url));
	inFlight.set(url, run);
	return run;
}

/**
 * Probe as many URLs as fit in `budgetMs`; URLs that don't answer in time are
 * simply absent from the result (unknown, never treated as missing).
 */
export async function probeReplayUrls(
	urls: string[],
	budgetMs = DEFAULT_BUDGET_MS
): Promise<Map<string, boolean>> {
	const unique = [...new Set(urls.filter((u) => Boolean(u?.trim())))];
	const out = new Map<string, boolean>();
	const deadline = Date.now() + budgetMs;
	let cursor = 0;

	const worker = async () => {
		while (cursor < unique.length) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) return;
			const url = unique[cursor++];
			const verdict = await Promise.race([
				isReplayFileUnavailable(url, Math.min(PROBE_TIMEOUT_MS, remaining)),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining))
			]);
			if (verdict !== null) out.set(url, verdict);
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(MAX_CONCURRENCY, unique.length) }, () => worker())
	);
	return out;
}
