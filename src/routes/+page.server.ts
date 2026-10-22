import { getUpcomingBroadcasts, zonedNow } from '$lib/server/shows';
import { attachHearts, heartKeyOf, listNews, VR_ANON_COOKIE } from '$lib/server/news';
import { annotateReplayStatus } from '$lib/server/replayStatus';
import type { PageServerLoad } from './$types';

export interface LatestShow {
	broadcast_id: string;
	show_id: string;
	date: string;
	start_minutes: number;
	replay_url: string | null;
	/** Probed: the recording behind replay_url no longer serves audio. */
	replay_unavailable: boolean;
	art: string | null;
	title: string;
	show_image: string | null;
	dj_name: string | null;
	kind: string;
	event_type: string | null;
}

export interface FeaturedShow {
	broadcast_id: string;
	show_id: string;
	date: string;
	replay_url: string | null;
	replay_unavailable: boolean;
	art: string | null;
	title: string;
	image: string | null;
	dj_name: string | null;
	kind: string;
	event_type: string | null;
}

export const load: PageServerLoad = async ({ platform, locals, cookies }) => {
	const db = platform!.env.DB;

	// Latest shows: admin-curated episodes (broadcast.home_ready = 1, toggled
	// in Studio → Featured). No date bound, so a just-finished episode appears
	// once the admin marks it ready.
	const { results } = await db
		.prepare(
			`SELECT b.id AS broadcast_id, b.show_id, b.date, b.start_minutes, b.replay_url, b.art, s.title, s.image AS show_image, s.kind, s.event_type, COALESCE(NULLIF(s.dj_handle, ''), u.name) AS dj_name
			 FROM broadcast b
			 JOIN show s ON s.id = b.show_id
			 LEFT JOIN user u ON u.id = s.dj_id
			 WHERE s.active = 1 AND b.home_ready = 1 AND b.id = (
				SELECT b2.id FROM broadcast b2
				WHERE b2.show_id = b.show_id AND b2.home_ready = 1
				ORDER BY b2.date DESC, b2.start_minutes DESC LIMIT 1
			 )
			 ORDER BY b.date DESC, b.start_minutes DESC
			 LIMIT 3`
		)
		.all();

	const now = zonedNow();
	const upcoming = (await getUpcomingBroadcasts(db, 7)).slice(0, 6).map((b) => ({
		...b,
		onair:
			b.date === now.date &&
			b.start_minutes <= now.minutes &&
			now.minutes < b.start_minutes + b.duration_minutes
	}));

	// Featured: admin-curated archive episodes (broadcast.featured = 1),
	// most recent first. Falls back to the four earliest-dated broadcasts if
	// nothing is featured.
	const featuredSelect = (extra: string) => `
		SELECT b.id AS broadcast_id, b.date, b.show_id, b.replay_url, b.art, s.title, s.image AS show_image, s.kind, s.event_type, COALESCE(NULLIF(s.dj_handle, ''), u.name) AS dj_name
		FROM broadcast b
		JOIN show s ON s.id = b.show_id
		LEFT JOIN user u ON u.id = s.dj_id
		${extra}`;

	type FeaturedRow = {
		broadcast_id: string;
		date: string;
		show_id: string;
		replay_url: string | null;
		art: string | null;
		title: string;
		show_image: string | null;
		dj_name: string | null;
		kind: string;
		event_type: string | null;
	};

	const curated = (
		await db
			.prepare(featuredSelect('WHERE b.featured = 1 AND s.active = 1 ORDER BY b.date DESC LIMIT 3'))
			.all()
	).results as unknown as FeaturedRow[];
	let rows = curated;
	if (rows.length === 0) {
		const fallback = await db
			.prepare(featuredSelect('WHERE s.active = 1 ORDER BY b.date ASC, b.start_minutes ASC LIMIT 4'))
			.all();
		rows = fallback.results as unknown as FeaturedRow[];
	}
	const latest = await annotateReplayStatus(results as unknown as LatestShow[]);
	const featured = await annotateReplayStatus(rows).then((annotated) =>
		annotated.map((r) => ({
			broadcast_id: r.broadcast_id,
			show_id: r.show_id,
			date: r.date,
			replay_url: r.replay_url,
			replay_unavailable: r.replay_unavailable,
			art: r.art,
			title: r.title,
			image: r.show_image,
			dj_name: r.dj_name,
			kind: r.kind,
			event_type: r.event_type
		}))
	);

	const news = await listNews(db, true);
	const newsKey = heartKeyOf(locals.user?.id ?? null, cookies.get(VR_ANON_COOKIE) ?? null);

	return {
		latest,
		upcoming,
		featured,
		news: (await attachHearts(db, news.slice(0, 3), newsKey))
	};
};
