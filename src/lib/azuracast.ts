export const AZURACAST_BASE = 'https://stream.versionradio.live';
export const AZURACAST_STATION_ID = '1';
export const AZURACAST_STATION_SHORTCODE = 'version_radio';

const TRACK_ID_RE = /^[0-9a-f]{24}$/i;
const DOWNLOAD_RE = /\/api\/station\/[\w-]+\/ondemand\/download\/([0-9a-f]{24})\b/i;

/**
 * Cache-busting suffix for proxied artwork. AzuraCast answers a missing art id
 * with a redirect to a generic placeholder, and the /media proxy caches for a
 * year — an id first requested through the wrong host would keep the
 * placeholder forever. Bumping this abandons those poisoned cache keys.
 */
const MEDIA_ART_VERSION = '2';

/** Pull a 24-hex track id out of a bare id or an on-demand download link. */
export function extractReplayTrackId(input: string): string | null {
	const id = input.trim();
	if (TRACK_ID_RE.test(id)) return id.toLowerCase();
	const m = id.match(DOWNLOAD_RE);
	return m ? m[1].toLowerCase() : null;
}

/** Canonical public play URL for an on-demand recording. */
export function replayPlayUrl(trackId: string): string {
	return `${AZURACAST_BASE}/api/station/${AZURACAST_STATION_ID}/ondemand/download/${trackId}`;
}

/**
 * Canonical proxied art path served through the /media CDN proxy (edge-cached,
 * ~0.05s warm) instead of a direct ~2.4s AzuraCast fetch.
 * `id` is a bare 24-hex track id (optionally already carrying a -timestamp).
 */
export function replayArtUrl(trackId: string): string {
	return `/media/${trackId}.jpg?v=${MEDIA_ART_VERSION}`;
}

/** Art URL from a stored replay URL, or null if it has no valid track id. */
export function replayArtFromUrl(url: string | null | undefined): string | null {
	if (!url) return null;
	const id = extractReplayTrackId(url);
	return id ? replayArtUrl(id) : null;
}

/** Deterministic short hash (FNV-1a, 8 hex). Same on client and server. */
export function artUrlHash(url: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < url.length; i++) {
		hash ^= url.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

/** True when `url` is already served by our /media proxy/CDN. */
function isMediaPath(url: string): boolean {
	try {
		return new URL(url, 'https://versionradio.live').pathname.startsWith('/media/');
	} catch {
		return false;
	}
}

/**
 * Served image URL for a broadcast tile.
 * - `b.art` set to a /media path -> used as-is (already CDN-cached).
 * - `b.art` set to any other URL -> proxied + cached via
 *   /media/ep/<broadcastId>/<urlhash>.jpg (hash busts the cache on change).
 * - otherwise falls back to the replay-derived art.
 */
export function episodeArtUrl(
	broadcastId: string | null | undefined,
	b: { art?: string | null; replay_url?: string | null }
): string | null {
	const art = b.art?.trim();
	if (art) {
		if (isMediaPath(art)) return art;
		if (broadcastId) return `/media/ep/${broadcastId}/${artUrlHash(art)}.jpg`;
		return art;
	}
	return replayArtFromUrl(b.replay_url);
}

export interface EpisodeArtFallback {
	image?: string | null;
	dj_image?: string | null;
}

/**
 * Episode artwork URL with the show's own (DJ) image as the default:
 * explicit broadcast art, else the replay's track art, else the show's
 * curated image, else the DJ avatar. Null only when the show has no image
 * at all (renderers then fall back to the brand glyph).
 */
export function episodeArtOrDefault(
	broadcastId: string | null | undefined,
	b: { art?: string | null; replay_url?: string | null },
	show?: EpisodeArtFallback | null
): string | null {
	const own = episodeArtUrl(broadcastId, b);
	return own ?? show?.image ?? show?.dj_image ?? null;
}

const ART_FILE_RE = /([0-9a-f]{24}(?:-\d+)?)\.(?:jpg|jpeg|png|webp|avif)$/i;

/**
 * Convert a full AzuraCast art URL (e.g. the nowplaying `song.art`) to the
 * proxied /media path. Falls back to the raw URL if no art id can be extracted.
 */
export function proxiedArtFromUrl(url: string | null | undefined): string | null {
	if (!url) return null;
	const m = url.trim().match(ART_FILE_RE);
	return m ? `/media/${m[1]}.jpg?v=${MEDIA_ART_VERSION}` : url;
}
