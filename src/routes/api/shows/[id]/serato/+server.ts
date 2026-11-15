import { json } from '@sveltejs/kit';
import { getShow } from '$lib/server/shows';
import { normalizeSeratoUser } from '$lib/serato';
import type { RequestHandler } from './$types';

/**
 * Set (or clear) the show's Serato handle.
 *
 * The DJ who owns the show can change it, as can an admin — it only affects how
 * the tracklist editor derives the playlist URL for each episode.
 */
export const PUT: RequestHandler = async ({ request, params, locals, platform }) => {
	const user = locals.user;
	if (!user || (user.role !== 'dj' && user.role !== 'admin')) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const db = platform!.env.DB;
	const show = await getShow(db, params.id);
	if (!show) return json({ error: 'Show not found' }, { status: 404 });
	if (show.dj_id !== user.id && user.role !== 'admin') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const body = (await request.json().catch(() => ({}))) as { seratoUser?: unknown };
	const raw = typeof body.seratoUser === 'string' ? body.seratoUser.trim() : '';

	if (raw === '') {
		await db
			.prepare('UPDATE show SET serato_user = NULL, updated_at = ? WHERE id = ?')
			.bind(Math.floor(Date.now() / 1000), show.id)
			.run();
		return json({ ok: true, seratoUser: null });
	}

	const handle = normalizeSeratoUser(raw);
	if (!handle) {
		return json(
			{ error: 'Use the Serato handle from your playlist URL (letters, digits, . - _)' },
			{ status: 400 }
		);
	}

	await db
		.prepare('UPDATE show SET serato_user = ?, updated_at = ? WHERE id = ?')
		.bind(handle, Math.floor(Date.now() / 1000), show.id)
		.run();

	return json({ ok: true, seratoUser: handle });
};
