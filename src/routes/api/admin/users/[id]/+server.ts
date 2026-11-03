import { json } from '@sveltejs/kit';
import { pauseDjShows, resumeDjShows, todayStr } from '$lib/server/shows';
import type { RequestHandler } from './$types';

const ROLES = new Set(['listener', 'dj', 'admin']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const POST: RequestHandler = async ({ request, params, locals, platform }) => {
	if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
	const db = platform!.env.DB;
	const body = (await request.json()) as { action?: string; value?: unknown };
	const action = body.action;
	const value = body.value;

	if (action === 'active' && typeof value === 'boolean') {
		await db.prepare('UPDATE user SET active = ? WHERE id = ?').bind(value ? 1 : 0, params.id).run();
		return json({ ok: true });
	}

	if (action === 'role' && typeof value === 'string' && ROLES.has(value)) {
		await db.prepare('UPDATE user SET role = ? WHERE id = ?').bind(value, params.id).run();
		return json({ ok: true });
	}

	// A DJ taking a break: pause/resume every recurring show they own.
	if (action === 'pause-shows' || action === 'resume-shows') {
		const dj = await db.prepare('SELECT id FROM user WHERE id = ?').bind(params.id).first();
		if (!dj) return json({ error: 'Not found' }, { status: 404 });

		if (action === 'resume-shows') {
			const changed = await resumeDjShows(db, params.id);
			return json({ ok: true, changed });
		}

		const raw = value === null || value === undefined ? '' : String(value).trim();
		if (raw !== '' && !DATE_RE.test(raw)) {
			return json({ error: 'Until must be a YYYY-MM-DD date' }, { status: 400 });
		}
		if (raw !== '' && raw < todayStr()) {
			return json({ error: 'The break must end today or later' }, { status: 400 });
		}
		const changed = await pauseDjShows(db, params.id, raw === '' ? null : raw);
		return json({ ok: true, changed });
	}

	return json({ error: 'Invalid action' }, { status: 400 });
};
