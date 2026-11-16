import { json } from '@sveltejs/kit';
import { getShow, resolveBroadcastForShow } from '$lib/server/shows';
import {
	trackDetectAccount,
	trackDetectFetch,
	trackDetectSubmit,
	type TrackDetectJob,
	type TrackDetectTrack
} from '$lib/server/trackdetect';
import type { RequestHandler } from './$types';

/**
 * Track Detect (fingerprinting) for one episode — admin only while we trial it.
 *
 * POST starts a detection on the episode's replay URL (one credit) or returns
 * the existing job when one is queued/running/finished, so a stray click can't
 * spend credits twice. GET polls, caches the rows in `detected_track` and lets
 * the editor import them without touching the credit balance again.
 */

const ACTIVE = new Set(['queued', 'downloading', 'detecting']);

type DetectContext = {
	db: D1Database;
	show: Awaited<ReturnType<typeof getShow>>;
	broadcast: NonNullable<Awaited<ReturnType<typeof resolveBroadcastForShow>>>;
};

async function loadContext(
	params: { id: string; broadcastId: string },
	locals: App.Locals,
	platform: App.Platform
): Promise<DetectContext | Response> {
	const user = locals.user;
	if (!user || user.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });

	const db = platform.env.DB;
	const show = await getShow(db, params.id);
	if (!show) return json({ error: 'Show not found' }, { status: 404 });

	const broadcast = await resolveBroadcastForShow(db, show.id, params.broadcastId);
	if (!broadcast) return json({ error: 'Episode not found' }, { status: 404 });

	return { db, show, broadcast };
}

export const GET: RequestHandler = async ({ params, locals, platform }) => {
	const ctx = await loadContext(params, locals, platform!);
	if (ctx instanceof Response) return ctx;

	const apiKey = platform!.env.TRACK_DETECT_API_KEY;
	if (!apiKey) return json({ status: 'unconfigured', error: 'TRACK_DETECT_API_KEY is not set' });

	const jobId = ctx.broadcast.detect_job_id;
	if (!jobId) return json({ status: 'none' });

	const result = await trackDetectFetch(apiKey, jobId);
	if (!result.ok) {
		return json({ status: 'error', error: result.message, code: result.code }, { status: 502 });
	}

	const job: TrackDetectJob = result.data;
	const tracks: TrackDetectTrack[] = job.tracks ?? [];
	const status = job.status;
	const progress = typeof job.progress === 'number' ? job.progress : null;

	const nowSec = Math.floor(Date.now() / 1000);
	await ctx.db
		.prepare(
			'UPDATE broadcast SET detect_status = ?, detect_progress = ?, detect_checked_at = ? WHERE id = ?'
		)
		.bind(status, progress, nowSec, ctx.broadcast.id)
		.run();

	// Cache the rows so a finished detection can be re-imported for free. The job
	// response is authoritative for this broadcast, so replace rather than merge.
	if (tracks.length > 0) {
		const stmts = tracks.map((track) =>
			ctx.db
				.prepare(
					`INSERT OR REPLACE INTO detected_track
					   (broadcast_id, job_id, timestamp, artist, title, isrc, bandcamp_url, deezer_url, beatport_url)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					ctx.broadcast.id,
					job.id,
					Math.max(0, Math.round(track.timestamp)),
					track.artist ?? '',
					track.title ?? '',
					track.isrc ?? null,
					track.links?.bandcamp ?? null,
					track.links?.deezer ?? null,
					track.links?.beatport ?? null
				)
		);
		await ctx.db.batch(stmts);
	}

	return json({
		status,
		jobId: job.id,
		progress,
		trackCount: tracks.length,
		credit: job.credit ?? null,
		error: job.error ?? null,
		tracks
	});
};

export const POST: RequestHandler = async ({ params, url, locals, platform }) => {
	const ctx = await loadContext(params, locals, platform!);
	if (ctx instanceof Response) return ctx;

	const apiKey = platform!.env.TRACK_DETECT_API_KEY;
	if (!apiKey) {
		return json({ error: 'Track detection is not configured (TRACK_DETECT_API_KEY).' }, { status: 503 });
	}

	const replayUrl = ctx.broadcast.replay_url?.trim();
	if (!replayUrl) {
		return json({ error: 'Add the episode replay first — detection runs on the recording.' }, { status: 400 });
	}

	const restart = url.searchParams.get('restart') === '1';

	// Reuse an existing job: never spend a second credit by accident.
	if (ctx.broadcast.detect_job_id && !restart) {
		const existing = ctx.broadcast.detect_status ?? 'unknown';
		if (ACTIVE.has(existing) || existing === 'done') {
			return json({
				status: existing,
				jobId: ctx.broadcast.detect_job_id,
				reused: true,
				hint: 'Already detected — fetch the results, or pass restart=1 to spend another credit.'
			});
		}
	}

	const account = await trackDetectAccount(apiKey);
	if (account.ok && account.data.credits <= 0) {
		return json({ error: 'No Track Detect credits left.' }, { status: 402 });
	}

	const submitted = await trackDetectSubmit(apiKey, replayUrl);
	if (!submitted.ok) {
		return json({ error: submitted.message, code: submitted.code }, { status: submitted.status || 502 });
	}

	const job = submitted.data;
	const nowSec = Math.floor(Date.now() / 1000);
	await ctx.db
		.prepare(
			`UPDATE broadcast
			   SET detect_job_id = ?, detect_status = ?, detect_progress = ?, detect_checked_at = ?
			 WHERE id = ?`
		)
		.bind(job.id, job.status, 0, nowSec, ctx.broadcast.id)
		.run();

	return json({ status: job.status, jobId: job.id, reused: false, credits: account.ok ? account.data.credits : null });
};
