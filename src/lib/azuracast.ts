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
const MEDIA_ART_VERSION = '3';

/** Last-resort show artwork when a show has no image or DJ avatar. */
export const GENERAL_SHOW_IMAGE = '/og-image.jpg';

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
 * Explicit per-episode artwork override, or null when none is set.
 * - `b.art` set to a /media path -> used as-is (already CDN-cached).
 * - `b.art` set to any other URL -> proxied + cached via
 *   /media/ep/<broadcastId>/<urlhash>.jpg (hash busts the cache on change).
 *
 * Artwork is deliberately NOT derived from `replay_url`: a recording's track id
 * only resolves on the AzuraCast instance that issued it. After moving servers
 * the same id answers with another recording's art (HTTP 200, so nothing
 * errors) or with the station fallback. An owned value must outrank a derived
 * one — see `episodeArtOrDefault`.
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
	return null;
}

export interface EpisodeArtFallback {
	image?: string | null;
	dj_image?: string | null;
}

/**
 * Episode artwork, resolving to the show's identity by default:
 * explicit episode override, else the show's curated image, else the DJ
 * avatar, else the general show image. Never null, so renderers don't have to
 * carry their own last-resort branch.
 */
export function episodeArtOrDefault(
	broadcastId: string | null | undefined,
	b: { art?: string | null; replay_url?: string | null },
	show?: EpisodeArtFallback | null
): string {
	const own = episodeArtUrl(broadcastId, b);
	return own ?? show?.image ?? show?.dj_image ?? GENERAL_SHOW_IMAGE;
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
