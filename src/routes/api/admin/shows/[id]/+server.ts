import { json } from '@sveltejs/kit';
import { getShow, pauseShow, resumeShow, todayStr } from '$lib/server/shows';
import type { RequestHandler } from './$types';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const POST: RequestHandler = async ({ request, params, locals, platform }) => {
	if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
	const db = platform!.env.DB;
	const body = (await request.json()) as { action?: string; value?: unknown };

	if (body.action === 'pause') {
		const show = await getShow(db, params.id);
		if (!show) return json({ error: 'Not found' }, { status: 404 });
		if (show.kind === 'event') {
			return json({ error: 'One-off events cannot be paused' }, { status: 400 });
		}
		const raw = body.value === null || body.value === undefined ? '' : String(body.value).trim();
		if (raw !== '' && !DATE_RE.test(raw)) {
			return json({ error: 'Until must be a YYYY-MM-DD date' }, { status: 400 });
		}
		if (raw !== '' && raw < todayStr()) {
			return json({ error: 'The break must end today or later' }, { status: 400 });
		}
		const until = raw === '' ? null : raw;
		await pauseShow(db, show.id, until);
		return json({ ok: true, paused: true, pausedUntil: until });
	}

	if (body.action === 'resume') {
		const show = await getShow(db, params.id);
		if (!show) return json({ error: 'Not found' }, { status: 404 });
		await resumeShow(db, show.id);
		return json({ ok: true, paused: false });
	}

	if (body.action === 'dj' && typeof body.value === 'string') {
		const dj = await db
			.prepare(`SELECT id FROM user WHERE id = ? AND role IN ('dj', 'admin')`)
			.bind(body.value)
			.first();
		if (!dj) return json({ error: 'Not a DJ account' }, { status: 400 });

		await db.prepare('UPDATE show SET dj_id = ?, updated_at = ? WHERE id = ?')
			.bind(body.value, Math.floor(Date.now() / 1000), params.id)
			.run();
		return json({ ok: true });
	}

	return json({ error: 'Invalid action' }, { status: 400 });
};
