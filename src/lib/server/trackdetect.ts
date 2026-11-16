/**
 * Track Detect API (https://api.track-detect.app) — fingerprint a recording and
 * get back a tracklist with timestamps.
 *
 * Two calls: submit the recording URL (costs one credit), then poll the job
 * until `done`. Tracks appear as they are found, so partial results are usable.
 * Re-reading a job by id is free; submitting the same URL again is not, which
 * is why the job id is stored on the broadcast.
 */

const BASE = 'https://api.track-detect.app/v1';
const TIMEOUT_MS = 20_000;

export interface TrackDetectTrack {
	/** Seconds from the start of the recording. */
	timestamp: number;
	artist: string;
	title: string;
	isrc: string | null;
	links: {
		beatport: string | null;
		deezer: string | null;
		bandcamp: string | null;
	};
}

export type TrackDetectStatus = 'queued' | 'downloading' | 'detecting' | 'done' | 'failed';

export interface TrackDetectJob {
	id: string;
	status: TrackDetectStatus;
	progress?: number;
	trackCount?: number;
	tracks?: TrackDetectTrack[];
	error?: { code: string; message: string } | null;
	credit?: 'reserved' | 'charged' | 'refunded' | string;
	createdAt?: string;
	finishedAt?: string | null;
}

export interface TrackDetectAccount {
	credits: number;
	limits: { dailyCap: number; usedToday: number; maxConcurrent: number; maxActive: number };
}

export type TrackDetectResult<T> =
	| { ok: true; data: T }
	| { ok: false; status: number; code: string; message: string };

function headers(apiKey: string): Record<string, string> {
	return {
		authorization: `Bearer ${apiKey}`,
		accept: 'application/json'
	};
}

async function call<T>(
	apiKey: string,
	path: string,
	init?: { method: string; body: unknown }
): Promise<TrackDetectResult<T>> {
	let res: Response;
	try {
		res = await fetch(`${BASE}${path}`, {
			method: init?.method ?? 'GET',
			headers: {
				...headers(apiKey),
				...(init ? { 'content-type': 'application/json' } : {})
			},
			body: init ? JSON.stringify(init.body) : undefined,
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch (error) {
		return {
			ok: false,
			status: 0,
			code: 'network_error',
			message: error instanceof Error ? error.message : 'Track Detect is unreachable'
		};
	}

	const body = (await res.json().catch(() => null)) as
		| (T & { error?: { code?: string; message?: string } })
		| null;

	if (!res.ok) {
		return {
			ok: false,
			status: res.status,
			code: body?.error?.code ?? `http_${res.status}`,
			message: body?.error?.message ?? `Track Detect answered ${res.status}`
		};
	}

	if (!body) {
		return { ok: false, status: res.status, code: 'bad_payload', message: 'Track Detect returned no JSON' };
	}

	return { ok: true, data: body };
}

/** Credit balance + limits. Free; useful before spending a credit. */
export function trackDetectAccount(apiKey: string) {
	return call<TrackDetectAccount>(apiKey, '/account');
}

/** Start a detection for one recording URL (one credit). */
export function trackDetectSubmit(apiKey: string, url: string) {
	return call<TrackDetectJob>(apiKey, '/detections', { method: 'POST', body: { url } });
}

/** Poll a detection by id. Free, and tracks arrive as they are found. */
export function trackDetectFetch(apiKey: string, id: string) {
	return call<TrackDetectJob>(apiKey, `/detections/${encodeURIComponent(id)}`);
}
