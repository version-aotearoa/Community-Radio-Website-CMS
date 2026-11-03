/**
 * Listener-saved cue points: a tracklist row's position inside an episode's
 * recording, kept in "My Version" (`/account` → Tracks).
 *
 * Cues are snapshots keyed on (user, broadcast, mark_seconds) — never on
 * track.id, because replaceTracklist() re-inserts every row with a fresh UUID on
 * each save. See migrations/0029_saved_track.sql.
 */

export interface SavedCueInput {
	markSeconds: number;
	title: string;
	artist: string;
	album: string;
}

export interface SavedCueRow {
	broadcast_id: string;
	show_id: string;
	show_title: string;
	date: string;
	art: string | null;
	image: string | null;
	title: string;
	artist: string;
	album: string;
	mark_seconds: number;
	created_at: number;
}

const now = () => Math.floor(Date.now() / 1000);

/** Cue seconds the user has saved for one episode. */
export async function getSavedCueSeconds(
	db: D1Database,
	userId: string,
	broadcastId: string
): Promise<number[]> {
	const { results } = await db
		.prepare(
			'SELECT mark_seconds FROM saved_track WHERE user_id = ? AND broadcast_id = ? ORDER BY mark_seconds'
		)
		.bind(userId, broadcastId)
		.all();
	return (results as unknown as { mark_seconds: number }[]).map((r) => r.mark_seconds);
}

/** Add or remove a cue snapshot. Returns the resulting saved state. */
export async function toggleSavedCue(
	db: D1Database,
	userId: string,
	broadcastId: string,
	cue: SavedCueInput
): Promise<boolean> {
	const existing = await db
		.prepare(
			'SELECT 1 FROM saved_track WHERE user_id = ? AND broadcast_id = ? AND mark_seconds = ?'
		)
		.bind(userId, broadcastId, cue.markSeconds)
		.first();

	if (existing) {
		await removeSavedCue(db, userId, broadcastId, cue.markSeconds);
		return false;
	}

	await db
		.prepare(
			`INSERT INTO saved_track (user_id, broadcast_id, mark_seconds, title, artist, album, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			userId,
			broadcastId,
			cue.markSeconds,
			cue.title.slice(0, 300),
			cue.artist.slice(0, 200),
			cue.album.slice(0, 200),
			now()
		)
		.run();
	return true;
}

/** Remove one saved cue (no-op when it isn't there). */
export async function removeSavedCue(
	db: D1Database,
	userId: string,
	broadcastId: string,
	markSeconds: number
): Promise<void> {
	await db
		.prepare('DELETE FROM saved_track WHERE user_id = ? AND broadcast_id = ? AND mark_seconds = ?')
		.bind(userId, broadcastId, markSeconds)
		.run();
}

/** Every cue the user has saved, newest first, with episode/show context. */
export async function listSavedCues(db: D1Database, userId: string): Promise<SavedCueRow[]> {
	const { results } = await db
		.prepare(
			`SELECT t.broadcast_id, b.show_id, s.title AS show_title, b.date, b.art, s.image,
			        t.title, t.artist, t.album, t.mark_seconds, t.created_at
			 FROM saved_track t
			 JOIN broadcast b ON b.id = t.broadcast_id
			 JOIN show s ON s.id = b.show_id
			 WHERE t.user_id = ?
			 ORDER BY t.created_at DESC, t.mark_seconds`
		)
		.bind(userId)
		.all();
	return results as unknown as SavedCueRow[];
}
