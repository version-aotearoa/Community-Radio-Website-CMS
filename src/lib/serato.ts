/**
 * Serato public playlists → tracklist rows.
 *
 * A DJ who publishes their set gets a page at
 * `https://serato.com/playlists/<handle>/<dd-mm-yyyy>` containing one block per
 * track:
 *
 *   <div class="playlist-track " id="track_126650913">
 *     <div class="playlist-tracktime">00:03:18</div>
 *     <div class="playlist-trackname">Abyssal Soundworks - Keith - Internal Dilemma</div>
 *   </div>
 *
 * The elapsed time is measured from the start of the set, which is exactly what
 * `track.mark_seconds` wants. The page is public HTML with no API, so parsing is
 * deliberately tolerant: we split on the opening tag, take the last-seen fields,
 * and fail soft on rows we can't read.
 *
 * The URL is stored per episode (`broadcast.serato_url`) rather than derived
 * from a show handle: it already names the DJ and the date.
 */

export interface SeratoTrack {
	/** `126650913` from `id="track_…"`; stable per playlist entry. */
	seratoId: string | null;
	/** Seconds from the start of the recording; null when the row had no time. */
	markSeconds: number | null;
	artist: string;
	title: string;
	/** The untouched `Artist - Title` string, for review/fallback. */
	raw: string;
}

/** Trim a pasted playlist URL; returns null when it isn't a Serato playlist page. */
export function normalizeSeratoPlaylistUrl(input: string | null | undefined): string | null {
	const value = (input ?? '').trim();
	return isSeratoPlaylistUrl(value) ? value : null;
}

/** True for a URL we are willing to fetch (public Serato playlist pages only). */
export function isSeratoPlaylistUrl(input: string): boolean {
	try {
		const url = new URL(input);
		return (
			(url.protocol === 'https:' || url.protocol === 'http:') &&
			/(^|\.)serato\.com$/i.test(url.hostname) &&
			url.pathname.startsWith('/playlists/')
		);
	} catch {
		return false;
	}
}

function decodeEntities(text: string): string {
	return text
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#0?39;|&apos;/gi, "'");
}

/** `00:03:18` / `3:18` → seconds. Null when it doesn't look like a clock. */
export function parseSeratoClock(input: string): number | null {
	const parts = input.trim().split(':');
	if (parts.length < 2 || parts.length > 3) return null;
	if (!parts.every((p) => /^\d{1,3}$/.test(p))) return null;

	const nums = parts.map(Number);
	const [h, m, s] = parts.length === 3 ? nums : [0, nums[0], nums[1]];
	if (s >= 60 || (parts.length === 3 && m >= 60)) return null;

	return h * 3600 + m * 60 + s;
}

/**
 * Parse a Serato playlist page into rows, in page order.
 *
 * Splits on the opening `<div class="playlist-track…">` rather than trying to
 * match nested divs, then pulls the three fields out of each chunk.
 */
export function parseSeratoPlaylist(html: string): SeratoTrack[] {
	const chunks = html.split(/<div class="playlist-track\b/).slice(1);
	const tracks: SeratoTrack[] = [];

	for (const chunk of chunks) {
		const rawName = chunk.match(/class="playlist-trackname">([\s\S]*?)<\/div>/)?.[1] ?? '';
		const raw = decodeEntities(rawName.replace(/<[^>]+>/g, ' '))
			.replace(/\s+/g, ' ')
			.trim();
		if (!raw) continue;

		const seratoId = chunk.match(/id="track_(\d+)"/)?.[1] ?? null;
		const time = chunk.match(/class="playlist-tracktime">\s*([0-9:]+)\s*</)?.[1] ?? '';

		// Serato writes `Artist - Title`; titles may contain further ` - ` segments,
		// so only the first separator is split.
		const split = raw.indexOf(' - ');
		const artist = split > 0 ? raw.slice(0, split).trim() : '';
		const title = split > 0 ? raw.slice(split + 3).trim() : raw;

		tracks.push({
			seratoId,
			markSeconds: parseSeratoClock(time),
			artist,
			title,
			raw
		});
	}

	return tracks;
}
