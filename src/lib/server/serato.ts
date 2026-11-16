import { parseSeratoPlaylist, type SeratoTrack } from '$lib/serato';

/** Serato sits behind a CDN that wants a browser-shaped request. */
const HEADERS: Record<string, string> = {
	accept: 'text/html,application/xhtml+xml',
	'accept-language': 'en-NZ,en;q=0.9',
	'user-agent':
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
};

const TIMEOUT_MS = 12_000;

export type SeratoImportResult =
	| { status: 'ok'; url: string; tracks: SeratoTrack[] }
	/** Serato answered 404 — the DJ hasn't published this playlist. */
	| { status: 'not-published'; url: string }
	/** Published, but the page had no readable track blocks (markup change?). */
	| { status: 'no-tracks'; url: string }
	/** Network/HTTP failure worth surfacing. */
	| { status: 'upstream'; detail: string };

/**
 * Fetch one published playlist page by its URL.
 *
 * The URL normally comes from `broadcast.serato_url` (pasted by the DJ) and is
 * validated before it reaches here. Never throws: the caller renders the status.
 */
export async function fetchSeratoPlaylistUrl(url: string): Promise<SeratoImportResult> {
	try {
		const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (res.status === 404) return { status: 'not-published', url };
		if (!res.ok) return { status: 'upstream', detail: `Serato answered ${res.status}` };

		const tracks = parseSeratoPlaylist(await res.text());
		if (tracks.length === 0) return { status: 'no-tracks', url };
		return { status: 'ok', url, tracks };
	} catch (error) {
		return { status: 'upstream', detail: error instanceof Error ? error.message : 'fetch failed' };
	}
}
