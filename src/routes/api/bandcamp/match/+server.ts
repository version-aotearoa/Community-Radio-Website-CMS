import { json } from '@sveltejs/kit';
import { searchBandcampMatches } from '$lib/bandcamp';
import type { RequestHandler } from './$types';

/**
 * Find Bandcamp page URLs for an artist/title pair.
 *
 * Used by the tracklist editor after a Serato import: rows arrive with artist
 * and title but no link, and a confident match fills `url` so the existing
 * Bandcamp resolver provides metadata, artwork and playback.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const user = locals.user;
	if (!user || (user.role !== 'dj' && user.role !== 'admin')) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const body = (await request.json().catch(() => ({}))) as {
		artist?: unknown;
		title?: unknown;
	};
	const title = typeof body.title === 'string' ? body.title.slice(0, 200) : '';
	const artist = typeof body.artist === 'string' ? body.artist.slice(0, 200) : '';

	if (!title.trim()) return json({ error: 'Title is required' }, { status: 400 });

	const matches = await searchBandcampMatches({ title, artist });
	return json({ matches });
};
