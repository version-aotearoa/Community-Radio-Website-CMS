import { json } from '@sveltejs/kit';
import { proxiedArtFromUrl } from '$lib/azuracast';
import {
	getNextBroadcast,
	getOnAirBroadcast,
	getSchedule,
	matchLiveShow,
	zonedNow
} from '$lib/server/shows';
import { AZURACAST_BASE } from '$lib/azuracast';
import type { RequestHandler } from './$types';

const AZURACAST = `${AZURACAST_BASE}/api/nowplaying`;

/** Tolerant CORS: loopback/LAN dev origins (localhost vs [::1] vs 127.0.0.1). */
const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'content-type, accept'
};

export const OPTIONS: RequestHandler = () => new Response(null, { headers: CORS });

function normalize(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

/** Match a track's artist/text against a known show name (either direction, min 4 chars). */
function matchShowName(title: string | null | undefined, artist: string | null | undefined, text: string | null | undefined, shows: { id: string; title: string }[]) {
	const haystacks = [artist, title, text]
		.filter((s): s is string => Boolean(s))
		.map(normalize)
		.filter((s) => s.length >= 4);
	if (haystacks.length === 0) return null;
	for (const show of shows) {
		const needle = normalize(show.title);
		if (needle.length < 4) continue;
		if (
			haystacks.some((h) => h.includes(needle)) ||
			haystacks.some((h) => needle.includes(h))
		) {
			return { id: show.id, title: show.title };
		}
	}
	return null;
}

export const GET: RequestHandler = async ({ platform, fetch: cfFetch }) => {
	const db = platform!.env.DB;
	const now = zonedNow();

	try {
		const upstream = await cfFetch(AZURACAST, { signal: AbortSignal.timeout(8000) });
		if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
		const data = (await upstream.json()) as Array<Record<string, unknown>>;
		const station = data[0] ?? {};

		const np = (station.now_playing ?? {}) as Record<string, unknown>;
		const song = (np.song ?? {}) as Record<string, unknown>;
		const live = (station.live ?? {}) as Record<string, unknown>;

		const shows = await getSchedule(db);
		const trackShow = matchShowName(
			typeof song.title === 'string' ? song.title : null,
			typeof song.artist === 'string' ? song.artist : null,
			typeof song.text === 'string' ? song.text : null,
			shows
		);

		// Live DJ identity from our own schedule/roster: the stream's metadata
		// (song.title/artist) is often stale while a DJ is connected (AzuraCast
		// only re-reports it on new encoder metadata), so match the reliable
		// streamer name to a known show instead.
		const streamerName = typeof live.streamer_name === 'string' ? live.streamer_name : null;
		const matchedLive = live.is_live ? matchLiveShow(shows, streamerName) : null;
		const liveShow = matchedLive
			? {
					id: matchedLive.id,
					title: matchedLive.title,
					djName: matchedLive.dj_name,
					djImage: matchedLive.dj_image,
					image: matchedLive.image
				}
			: null;

		const [onAir, next] = await Promise.all([
			getOnAirBroadcast(db, now.date, now.minutes),
			getNextBroadcast(db, now.date, now.minutes)
		]);

		return json(
			{
				isOnline: Boolean(station.is_online ?? true),
				live: {
					isLive: Boolean(live.is_live),
					streamerName: typeof live.streamer_name === 'string' ? live.streamer_name : null
				},
				nowPlaying: {
					title: typeof song.title === 'string' ? song.title : null,
					artist: typeof song.artist === 'string' ? song.artist : null,
					text: typeof song.text === 'string' ? song.text : null,
					art: proxiedArtFromUrl(typeof song.art === 'string' ? song.art : null),
					playedAt: typeof np.played_at === 'number' ? np.played_at : null,
					duration: typeof np.duration === 'number' ? np.duration : null,
					elapsed: typeof np.elapsed === 'number' ? np.elapsed : null,
					remaining: typeof np.remaining === 'number' ? np.remaining : null
				},
				trackShow,
				liveShow,
				onAir: onAir
					? {
							id: onAir.show_id,
							title: onAir.title,
							image: onAir.image,
							djName: onAir.dj_name,
							djImage: onAir.dj_image,
							date: onAir.date,
							startMinutes: onAir.start_minutes,
							durationMinutes: onAir.duration_minutes
						}
					: null,
				next: next
					? {
							id: next.show_id,
							title: next.title,
							djName: next.dj_name,
							djImage: next.dj_image,
							date: next.date,
							startMinutes: next.start_minutes
						}
					: null,
				now
		},
		{
			headers: { 'Cache-Control': 'public, max-age=15', ...CORS }
		}
	);
} catch {
	return json(
		{ isOnline: false, live: { isLive: false, streamerName: null }, nowPlaying: null, trackShow: null, liveShow: null, onAir: null, next: null, now },
		{ headers: { 'Cache-Control': 'public, max-age=10', ...CORS } }
	);
}
};
