-- Migration number: 0029 2026-11-03

-- Listener-saved cue points ("Tracks" in My Version): a snapshot of a tracklist
-- row plus the moment it starts in the episode's recording.
--
-- Deliberately NOT keyed on track.id: replaceTracklist() deletes and re-inserts
-- every row on each save (fresh UUIDs), so a track FK would vanish. A cue is a
-- point in a recording — (broadcast, mark_seconds) — and keeps the snapshot text
-- for display.

CREATE TABLE IF NOT EXISTS saved_track (
	user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
	broadcast_id TEXT NOT NULL REFERENCES broadcast (id) ON DELETE CASCADE,
	mark_seconds INTEGER NOT NULL,
	title TEXT NOT NULL DEFAULT '',
	artist TEXT NOT NULL DEFAULT '',
	album TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	PRIMARY KEY (user_id, broadcast_id, mark_seconds)
);

CREATE INDEX IF NOT EXISTS idx_saved_track_user ON saved_track (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_track_broadcast ON saved_track (broadcast_id);
