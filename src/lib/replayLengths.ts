import { extractReplayTrackId } from '$lib/azuracast';

/** Track id → replay length in seconds, shared across page navigations. */
export type ReplayLengths = Record<string, number>;

let cache: ReplayLengths | null = null;
let inflight: Promise<ReplayLengths> | null = null;

/** Fetch (once per session) the archive's replay lengths from the Worker. */
export function fetchReplayLengths(): Promise<ReplayLengths> {
	if (cache) return Promise.resolve(cache);
	if (inflight) return inflight;

	inflight = fetch('/api/replay-lengths', { headers: { accept: 'application/json' } })
		.then((res) => (res.ok ? res.json() : null))
		.then((body: unknown) => {
			const lengths: ReplayLengths = {};
			if (body && typeof body === 'object') {
				for (const [id, value] of Object.entries(body as Record<string, unknown>)) {
					if (typeof value === 'number' && value > 0) lengths[id] = value;
				}
			}
			cache = lengths;
			return lengths;
		})
		.catch(() => {
			cache = {};
			return cache;
		})
		.finally(() => {
			inflight = null;
		});

	return inflight;
}

/**
 * Scheduled minutes, replaced by the real recording length when AzuraCast knows
 * it. Rounds to the nearest minute to match `fmtDuration`'s schedule wording.
 */
export function replayMinutes(
	replayUrl: string | null | undefined,
	lengths: ReplayLengths,
	scheduledMinutes: number
): number {
	if (!replayUrl) return scheduledMinutes;
	const id = extractReplayTrackId(replayUrl);
	const seconds = id ? lengths[id] : undefined;
	return typeof seconds === 'number' && seconds > 0
		? Math.max(1, Math.round(seconds / 60))
		: scheduledMinutes;
}
