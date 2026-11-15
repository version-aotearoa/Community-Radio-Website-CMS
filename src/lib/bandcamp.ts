/**
 * Resolve a Bandcamp track/album page into a playable stream URL + metadata.
 *
 * Bandcamp's web pages sit behind Cloudflare Bot Management (datacenter egress
 * — our Worker — gets a JS "Client Challenge"), but Bandcamp's public JSON APIs
 * are not challenged. We call those directly, so there's no browser, no proxy
 * and no per-token reader service involved:
 *
 *   1. POST /api/bcsearch_public_api/1/autocomplete_elastic → band_id + tralbum_id
 *   2. GET  /api/mobile/24/tralbum_details                  → tracks[].streaming_url
 *
 * The numeric ids are cached on the track row, so a re-resolve (the signed
 * stream token expires) skips step 1.
 *
 * `streaming_url` is a short-lived `bandcamp.com/stream_redirect` link; we follow
 * its redirect server-side to the CDN URL and cache until it expires.
 */

const SEARCH_API = 'https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic';
const TRALBUM_API = 'https://bandcamp.com/api/mobile/24/tralbum_details';
const REDIRECT_PATH_RE = /\/stream_redirect\b/i;
/** Best quality first. */
const STREAM_FORMATS = ['mp3-128', 'mp3-v0', 'aac-hi', 'aac-lo'];
/** Cache window when the stream token carries no usable `ts` expiry. */
const DEFAULT_TTL_SECONDS = 1800;

/**
 * Bandcamp rejects the Workers runtime's default/empty User-Agent on its JSON
 * endpoints, so present as a normal browser. (api/* is otherwise not challenged
 * the way the HTML pages are.)
 */
const API_HEADERS: Record<string, string> = {
	accept: 'application/json',
	'user-agent':
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
	'accept-language': 'en-NZ,en;q=0.9',
	referer: 'https://bandcamp.com/'
};

const HOST_RE = /(^|\.)bandcamp\.com$/i;

export interface BandcampStream {
	streamUrl: string;
	/** Unix seconds when the signed URL expires (best-effort). */
	expiresAt: number | null;
	format: string;
	title: string | null;
	artist: string | null;
	artId: string | null;
	durationSeconds: number | null;
	capped: boolean;
	/** Numeric ids, cached so the next resolve skips the search call. */
	bandId: number | null;
	tralbumId: number | null;
}

/** Previously-cached numeric ids (skip the search step when present). */
export interface BandcampIds {
	bandId?: number | null;
	tralbumId?: number | null;
}

/** Title/artist from the DB row — used to build better search queries. */
export interface BandcampHints {
	title?: string | null;
	artist?: string | null;
}

/** A scored Bandcamp page candidate for a row that has no URL yet. */
export interface BandcampMatch {
	url: string;
	title: string;
	artist: string;
	album: string;
	bandId: number;
	tralbumId: number;
	/** 0–1: exact title + artist ≈ 1.0; shared words only ≈ 0.35. */
	score: number;
}

export function isBandcampUrl(url: string): boolean {
	try {
		return HOST_RE.test(new URL(url).hostname);
	} catch {
		return false;
	}
}

/**
 * True only for a fetchable Bandcamp track/album *page*. Excludes
 * `EmbeddedPlayer` URLs (and artist/other pages) which resolve differently.
 */
export function isBandcampPageUrl(url: string): boolean {
	if (!isBandcampUrl(url)) return false;
	try {
		const path = new URL(url).pathname;
		if (/\/EmbeddedPlayer\//i.test(path)) return false;
		return /\/(track|album)\//i.test(path);
	} catch {
		return false;
	}
}

/** Artwork URL for a Bandcamp art id (square thumbnail). */
export function bandcampArtUrl(artId: string | null | undefined): string | null {
	return artId ? `https://f4.bcbits.com/img/a${artId}_10.jpg` : null;
}

interface SearchResult {
	type?: string;
	id?: number;
	band_id?: number;
	item_url_path?: string;
	/** Track/album title (present on autocomplete results). */
	name?: string;
	/** Artist/band name (present on autocomplete results). */
	band_name?: string;
	album_name?: string;
}

interface TralbumTrack {
	title?: string | null;
	duration?: number | null;
	art_id?: number | null;
	band_name?: string | null;
	streaming_url?: Record<string, string> | null;
}

interface TralbumDetails {
	title?: string | null;
	art_id?: number | null;
	tralbum_artist?: string | null;
	band?: { name?: string | null } | null;
	tracks?: TralbumTrack[] | null;
}

type TralbumType = 't' | 'a';

/** Host + path, lowercased, no query/hash/trailing slash — for exact matching. */
function normalizeUrl(s: string): string {
	try {
		const u = new URL(s);
		return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '').toLowerCase()}`;
	} catch {
		return s.toLowerCase();
	}
}

/** Signed token expiry from a `ts` param, if it is still in the future. */
function expiryOf(url: string): number | null {
	try {
		const ts = Number(new URL(url).searchParams.get('ts'));
		const nowSec = Math.floor(Date.now() / 1000);
		if (Number.isFinite(ts) && ts > nowSec) return ts;
	} catch {
		// no ts param
	}
	return null;
}

/** Strip diacritics/lowercase for a search-safe variant (Hauāuru → hauauru). */
function ascii(s: string): string {
	return s
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9 ]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Candidate search queries, most specific first. */
function searchQueries(url: URL, hint?: BandcampHints): string[] {
	const slug = (url.pathname.split('/').filter(Boolean).pop() ?? '').replace(/-/g, ' ');
	const band = url.hostname.split('.')[0];
	const title = hint?.title?.trim() ?? '';
	const artist = hint?.artist?.trim() ?? '';
	const candidates = [
		title && artist ? `${title} ${artist}` : '',
		title,
		ascii(`${title} ${artist}`),
		`${slug} ${band}`,
		ascii(`${slug} ${band}`)
	];
	return [...new Set(candidates.map((c) => c.trim()).filter(Boolean))];
}

async function search(query: string, type: TralbumType): Promise<SearchResult[] | null> {
	try {
		const res = await fetch(SEARCH_API, {
			method: 'POST',
			headers: { ...API_HEADERS, 'content-type': 'application/json' },
			body: JSON.stringify({
				search_text: query,
				search_filter: type,
				full_page: false,
				fan_id: null
			}),
			signal: AbortSignal.timeout(10000)
		});
		if (!res.ok) {
			console.warn(`[bandcamp] search ${res.status} for "${query}"`);
			return null;
		}
		return ((await res.json()) as { auto?: { results?: SearchResult[] } }).auto?.results ?? [];
	} catch (e) {
		console.warn(`[bandcamp] search failed for "${query}":`, e);
		return null;
	}
}

/**
 * Search Bandcamp for the exact page URL → its numeric ids. Tries several
 * queries (title/artist first, then the URL slug) and accepts only an exact
 * `item_url_path` match, so extra queries can't select the wrong track.
 */
async function lookupIds(
	url: string,
	type: TralbumType,
	hint?: BandcampHints
): Promise<{ bandId: number; tralbumId: number; type: TralbumType } | null> {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	const want = normalizeUrl(url);

	for (const query of searchQueries(u, hint)) {
		const results = await search(query, type);
		if (!results) continue;
		const hit =
			results.find(
				(r) => r.item_url_path && normalizeUrl(r.item_url_path) === want && r.type === type
			) ?? results.find((r) => r.item_url_path && normalizeUrl(r.item_url_path) === want);
		if (hit?.id && hit.band_id) {
			return { bandId: hit.band_id, tralbumId: hit.id, type: hit.type === 'a' ? 'a' : 't' };
		}
	}
	return null;
}

/**
 * Find Bandcamp page URLs for a row that only has artist + title (e.g. imported
 * from a Serato playlist).
 *
 * Unlike `lookupIds()` there is no URL to match against, so results are scored
 * on name/artist equality after normalisation and returned best-first for the
 * DJ to confirm. Never throws; an empty array means "nothing convincing".
 */
export async function searchBandcampMatches(hints: BandcampHints): Promise<BandcampMatch[]> {
	const title = hints.title?.trim() ?? '';
	const artist = hints.artist?.trim() ?? '';
	if (!title) return [];

	const queries = [...new Set([`${title} ${artist}`.trim(), ascii(`${title} ${artist}`), title].filter(Boolean))];

	const seen = new Map<string, BandcampMatch>();

	for (const query of queries.slice(0, 2)) {
		const results = await search(query, 't');
		if (!results) continue;

		for (const result of results) {
			if (!result.item_url_path || !result.band_id || !result.id) continue;

			const url = result.item_url_path.startsWith('http')
				? result.item_url_path
				: `https://bandcamp.com${result.item_url_path}`;

			const name = result.name ?? '';
			const band = result.band_name ?? '';
			const score = scoreMatch(title, artist, name, band);
			if (score < 0.3) continue;

			const existing = seen.get(url);
			if (!existing || existing.score < score) {
				seen.set(url, {
					url,
					title: name,
					artist: band,
					album: result.album_name ?? '',
					bandId: result.band_id,
					tralbumId: result.id,
					score
				});
			}
		}

		// A confident exact match is enough — don't spend the second query.
		if ([...seen.values()].some((m) => m.score >= 0.95)) break;
	}

	return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 5);
}

function scoreMatch(title: string, artist: string, hitTitle: string, hitArtist: string): number {
	const t = ascii(title);
	const a = ascii(artist);
	const ht = ascii(hitTitle);
	const ha = ascii(hitArtist);

	let score = 0;
	if (t && ht) {
		if (t === ht) score += 0.6;
		else if (ht.includes(t) || t.includes(ht)) score += 0.35;
	}
	if (a && ha) {
		if (a === ha) score += 0.4;
		else if (ha.includes(a) || a.includes(ha)) score += 0.2;
	}
	return Math.min(1, Math.round(score * 100) / 100);
}

async function fetchDetails(
	bandId: number,
	tralbumId: number,
	type: TralbumType
): Promise<TralbumDetails | null> {
	const endpoint = TRALBUM_API;
	try {
		const res = await fetch(endpoint, {
			method: 'POST',
			headers: { ...API_HEADERS, 'content-type': 'application/json' },
			body: JSON.stringify({ band_id: bandId, tralbum_id: tralbumId, tralbum_type: type }),
			signal: AbortSignal.timeout(10000)
		});
		const text = await res.text();
		if (!res.ok) {
			console.warn(`[bandcamp] tralbum_details ${res.status} for band=${bandId} tralbum=${tralbumId}`);
			return null;
		}
		try {
			return JSON.parse(text) as TralbumDetails;
		} catch {
			console.warn(
				`[bandcamp] tralbum_details non-JSON (status ${res.status}, type ${res.headers.get('content-type')}): ${text.slice(0, 200)}`
			);
			return null;
		}
	} catch (e) {
		console.warn(`[bandcamp] tralbum_details failed for band=${bandId} tralbum=${tralbumId}:`, e);
		return null;
	}
}

/** Follow a `stream_redirect` link to the final CDN URL (else return as-is). */
async function followStreamRedirect(url: string): Promise<string> {
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		return url;
	}
	if (!REDIRECT_PATH_RE.test(pathname)) return url;
	try {
		const res = await fetch(url, {
			redirect: 'manual',
			headers: { ...API_HEADERS, accept: '*/*' },
			signal: AbortSignal.timeout(8000)
		});
		const loc = res.headers.get('location');
		return loc && /^https?:/i.test(loc) ? loc : url;
	} catch {
		return url;
	}
}

export async function resolveBandcampTrack(
	url: string,
	ids?: BandcampIds,
	hints?: BandcampHints
): Promise<BandcampStream | null> {
	if (!isBandcampPageUrl(url)) return null;

	let type: TralbumType = /\/album\//i.test(new URL(url).pathname) ? 'a' : 't';
	let bandId = ids?.bandId ?? null;
	let tralbumId = ids?.tralbumId ?? null;

	// Prefer cached ids; fall back to a search (also if the cached ids go stale).
	let detail = bandId && tralbumId ? await fetchDetails(bandId, tralbumId, type) : null;
	if (!detail) {
		const found = await lookupIds(url, type, hints);
		if (!found) return null;
		bandId = found.bandId;
		tralbumId = found.tralbumId;
		type = found.type;
		detail = await fetchDetails(bandId, tralbumId, type);
	}
	if (!detail) return null;

	const track = detail.tracks?.[0];
	if (!track) return null;
	const files = track.streaming_url ?? {};
	const format = STREAM_FORMATS.find((f) => files[f]) ?? Object.keys(files)[0];
	if (!format || !files[format]) return null;

	const rawUrl = files[format];
	const streamUrl = await followStreamRedirect(rawUrl);
	const nowSec = Math.floor(Date.now() / 1000);
	const expiresAt = expiryOf(streamUrl) ?? expiryOf(rawUrl) ?? nowSec + DEFAULT_TTL_SECONDS;

	const artId =
		track.art_id != null ? String(track.art_id) : detail.art_id != null ? String(detail.art_id) : null;

	return {
		streamUrl,
		expiresAt,
		format,
		title: track.title ?? detail.title ?? null,
		artist: track.band_name ?? detail.tralbum_artist ?? detail.band?.name ?? null,
		artId,
		durationSeconds: typeof track.duration === 'number' ? Math.round(track.duration) : null,
		capped: false,
		bandId,
		tralbumId
	};
}
