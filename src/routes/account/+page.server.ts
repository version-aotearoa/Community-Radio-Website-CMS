import { redirect } from '@sveltejs/kit';
import { cycleWeekOf, nextDateForWeekday, todayStr } from '$lib/server/shows';
import { listSavedCues } from '$lib/server/cues';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const user = locals.user;
	if (!user) redirect(302, '/login');

	const db = platform!.env.DB;
	const me = await db.prepare('SELECT createdAt FROM user WHERE id = ?').bind(user.id).first();
	const raw = me?.createdAt;
	const createdAt =
		typeof raw === 'number' ? raw : raw ? Math.floor(Date.parse(String(raw)) / 1000) : null;

	const following = await db
		.prepare(
			`SELECT s.id, s.title, s.image AS image, s.day_of_week, s.interval_weeks, s.anchor_date
			 FROM follow_show f
			 JOIN show s ON s.id = f.show_id
			 WHERE f.user_id = ?
			 ORDER BY s.day_of_week, s.start_minutes`
		)
		.bind(user.id)
		.all();

	const saved = await db
		.prepare(
			`SELECT b.id AS broadcast_id, b.show_id, b.date, b.replay_url, b.art, s.title, s.image AS image
			 FROM saved_episode e
			 JOIN broadcast b ON b.id = e.broadcast_id
			 JOIN show s ON s.id = b.show_id
			 WHERE e.user_id = ?
			 ORDER BY e.created_at DESC`
		)
		.bind(user.id)
		.all();

	const favourites = await db
		.prepare(
			`SELECT b.id AS broadcast_id, b.show_id, b.date, b.replay_url, b.art, s.title, s.image AS image
			 FROM favourite_broadcast f
			 JOIN broadcast b ON b.id = f.broadcast_id
			 JOIN show s ON s.id = b.show_id
			 WHERE f.user_id = ?
			 ORDER BY f.created_at DESC`
		)
		.bind(user.id)
		.all();

	const savedTracks = await listSavedCues(db, user.id);

	// Air cadence per followed show (station's 4-week cycle), matching the
	// shows-list cards. Empty for weekly shows.
	const today = todayStr();
	const followingWithCadence = (following.results as {
		id: string;
		title: string;
		image: string | null;
		day_of_week: number;
		interval_weeks: number;
		anchor_date: string | null;
	}[]).map((s) => {
		const baseWeek = cycleWeekOf(s.anchor_date ?? nextDateForWeekday(s.day_of_week, today));
		const showCycleWeeks =
			s.interval_weeks === 4
				? [baseWeek]
				: s.interval_weeks === 2
					? [baseWeek, ((baseWeek + 1) % 4) + 1]
					: [];
		return { id: s.id, title: s.title, image: s.image, day_of_week: s.day_of_week, showCycleWeeks };
	});

	return {
		user,
		createdAt,
		following: followingWithCadence,
		saved: saved.results as {
			broadcast_id: string;
			show_id: string;
			date: string;
			replay_url: string | null;
			art: string | null;
			title: string;
			image: string | null;
		}[],
		favourites: favourites.results as {
			broadcast_id: string;
			show_id: string;
			date: string;
			replay_url: string | null;
			art: string | null;
			title: string;
			image: string | null;
		}[],
		savedTracks
	};
};
