-- Migration number: 0028 2026-10-30

-- Cue marker for a tracklist row: the position, in whole seconds, from the
-- start of the episode's recording (broadcast.replay_url). NULL = no marker.
-- The public episode page turns a marker into click-to-seek on the replay.

ALTER TABLE track ADD COLUMN mark_seconds INTEGER;
