import { error } from '@sveltejs/kit';
import {
	broadcastEnded,
	cycleWeekOf,
	ensureBroadcasts,
	getBroadcastTracksMap,
	getBroadcasts,
	getShowWithDj,
	nextDateForWeekday,
	todayStr,
	zonedNow
} from '$lib/server/shows';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	const show = await getShowWithDj(db, params.id);
	if (!show) error(404, 'Show not found');

	await ensureBroadcasts(db, show);
	const broadcasts = await getBroadcasts(db, show.id);
	const tracks = await getBroadcastTracksMap(db, broadcasts.map((b) => b.id));

	const user = locals.user ?? null;
	const canEdit =
		user !== null && (user.role === 'admin' || (user.role === 'dj' && show.dj_id === user.id));

	const today = todayStr();
	const followed = user
		? Boolean(
				await db
					.prepare('SELECT 1 AS x FROM follow_show WHERE user_id = ? AND show_id = ?')
					.bind(user.id, show.id)
					.first()
			)
		: false;

	// Cycle weeks the show airs on (station's 4-week cycle). Interval 1 airs
	// every week, interval 2 on two weeks, interval 4 on a single week.
	const anchor = show.anchor_date ?? nextDateForWeekday(show.day_of_week, today);
	const baseWeek = cycleWeekOf(anchor);
	const showCycleWeeks =
		show.interval_weeks === 4 ? [baseWeek] : show.interval_weeks === 2 ? [baseWeek, ((baseWeek + 1) % 4) + 1] : [];
	const currentCycleWeek = cycleWeekOf(today);

	return {
		show,
		broadcasts,
		tracks,
		canEdit,
		today,
		followed,
		showCycleWeeks,
		currentCycleWeek,
		upcoming: broadcasts.filter((b) => !broadcastEnded(zonedNow(), b)).slice(0, 1),
		past: broadcasts.filter((b) => broadcastEnded(zonedNow(), b)).reverse()
	};
};
