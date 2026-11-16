-- Track Detect (api.track-detect.app) job state per broadcast.
--
-- Detection runs on the episode's replay file and returns timestamps + artist/
-- title + store links. We keep the job id so results can be re-read for free:
-- submitting the same URL again would cost another credit.
ALTER TABLE broadcast ADD COLUMN detect_job_id TEXT;
ALTER TABLE broadcast ADD COLUMN detect_status TEXT;
ALTER TABLE broadcast ADD COLUMN detect_progress INTEGER;
ALTER TABLE broadcast ADD COLUMN detect_checked_at INTEGER;

CREATE TABLE IF NOT EXISTS detected_track (
	broadcast_id TEXT NOT NULL,
	job_id TEXT NOT NULL,
	-- Seconds from the start of the recording (track.mark_seconds).
	timestamp INTEGER NOT NULL,
	artist TEXT NOT NULL DEFAULT '',
	title TEXT NOT NULL DEFAULT '',
	isrc TEXT,
	bandcamp_url TEXT,
	deezer_url TEXT,
	beatport_url TEXT,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	PRIMARY KEY (broadcast_id, timestamp, artist, title)
);

CREATE INDEX IF NOT EXISTS idx_detected_track_broadcast ON detected_track (broadcast_id, timestamp);
