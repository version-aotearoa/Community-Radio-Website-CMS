import { json } from '@sveltejs/kit';
import { deleteBroadcastForever, getBroadcast, setBroadcastCancelled } from '$lib/server/shows';
import type { RequestHandler } from './$types';

/** Cancel (hide) or restore one episode. */
export const POST: RequestHandler = async ({ request, params, locals, platform }) => {
	if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
	const db = platform!.env.DB;

	const broadcast = await getBroadcast(db, params.id);
	if (!broadcast) return json({ error: 'Not found' }, { status: 404 });

	const body = (await request.json().catch(() => null)) as { action?: string } | null;
	const action = body?.action;
	if (action !== 'cancel' && action !== 'restore') {
		return json({ error: 'Invalid action' }, { status: 400 });
	}

	const cancelled = await setBroadcastCancelled(db, broadcast.id, action === 'cancel');
	return json({ ok: true, cancelled });
};

/**
 * Delete an episode for good (mistakes only): track rows are removed explicitly,
 * bookmarks/favourites/saved cues cascade from the broadcast FK.
 */
export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
	const db = platform!.env.DB;

	const broadcast = await getBroadcast(db, params.id);
	if (!broadcast) return json({ error: 'Not found' }, { status: 404 });

	await deleteBroadcastForever(db, broadcast.id);
	return json({ ok: true });
};
