import { json } from '@sveltejs/kit';
import { resolveBroadcastForShow } from '$lib/server/shows';
import { removeSavedCue, toggleSavedCue } from '$lib/server/cues';
import { isValidMark, MARK_MAX_SECONDS } from '$lib/trackTime';
import type { RequestHandler } from './$types';

type Body = {
	markSeconds?: unknown;
	title?: unknown;
	artist?: unknown;
	album?: unknown;
};

/** Toggle the signed-in user's saved cue at a position in this episode. */
export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	const user = locals.user;
	if (!user) return json({ error: 'sign-in-required' }, { status: 401 });

	const db = platform!.env.DB;
	const broadcast = await resolveBroadcastForShow(db, params.id, params.broadcastId);
	if (!broadcast) return json({ error: 'Not found' }, { status: 404 });

	const body = (await request.json().catch(() => null)) as Body | null;
	if (!body || !isValidMark(body.markSeconds)) {
		return json(
			{ error: `markSeconds must be whole seconds between 0 and ${MARK_MAX_SECONDS}` },
			{ status: 400 }
		);
	}

	const saved = await toggleSavedCue(db, user.id, broadcast.id, {
		markSeconds: body.markSeconds,
		title: String(body.title ?? '').trim(),
		artist: String(body.artist ?? '').trim(),
		album: String(body.album ?? '').trim()
	});
	return json({ saved, markSeconds: body.markSeconds });
};

/** Remove the signed-in user's saved cue at `?t=<seconds>` in this episode. */
export const DELETE: RequestHandler = async ({ params, url, locals, platform }) => {
	const user = locals.user;
	if (!user) return json({ error: 'sign-in-required' }, { status: 401 });

	const db = platform!.env.DB;
	const broadcast = await resolveBroadcastForShow(db, params.id, params.broadcastId);
	if (!broadcast) return json({ error: 'Not found' }, { status: 404 });

	const markSeconds = Number(url.searchParams.get('t'));
	if (!isValidMark(markSeconds)) {
		return json({ error: 't must be whole seconds' }, { status: 400 });
	}

	await removeSavedCue(db, user.id, broadcast.id, markSeconds);
	return json({ saved: false, markSeconds });
};
