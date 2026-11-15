import { parseSeratoPlaylist, seratoPlaylistUrls, type SeratoTrack } from '$lib/serato';

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
	/** Nothing published for that date (both URL forms 404). */
	| { status: 'not-published'; tried: string[] }
	/** Published, but the page had no readable track blocks (markup change?). */
	| { status: 'no-tracks'; url: string }
	/** Network/HTTP failure worth surfacing. */
	| { status: 'upstream'; detail: string };

/**
 * Fetch a DJ's published playlist for a broadcast date.
 *
 * Tries the padded then unpadded date form, stopping at the first page that
 * yields rows. Never throws: the caller renders the status.
 */
export async function fetchSeratoPlaylist(user: string, date: string): Promise<SeratoImportResult> {
	const urls = seratoPlaylistUrls(user, date);
	if (urls.length === 0) return { status: 'not-published', tried: [] };

	for (const url of urls) {
		let res: Response;
		try {
			res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
		} catch (error) {
			return { status: 'upstream', detail: error instanceof Error ? error.message : 'fetch failed' };
		}

		if (res.status === 404) continue;
		if (!res.ok) return { status: 'upstream', detail: `Serato answered ${res.status}` };

		const html = await res.text();
		const tracks = parseSeratoPlaylist(html);
		if (tracks.length > 0) return { status: 'ok', url, tracks };
		return { status: 'no-tracks', url };
	}

	return { status: 'not-published', tried: urls };
}

/** Fetch a specific playlist URL (one-off shows / guest DJs). */
export async function fetchSeratoPlaylistUrl(url: string): Promise<SeratoImportResult> {
	try {
		const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (res.status === 404) return { status: 'not-published', tried: [url] };
		if (!res.ok) return { status: 'upstream', detail: `Serato answered ${res.status}` };

		const tracks = parseSeratoPlaylist(await res.text());
		if (tracks.length === 0) return { status: 'no-tracks', url };
		return { status: 'ok', url, tracks };
	} catch (error) {
		return { status: 'upstream', detail: error instanceof Error ? error.message : 'fetch failed' };
	}
}
