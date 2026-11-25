-- Seconds of intro in the episode recording that Serato did not capture.
--
-- Serato playlist times start at the beginning of the DJ's Serato recording,
-- but the published replay can start earlier (station intro/ident). Importing
-- adds this offset to every Serato mark so cue markers line up with the replay.
ALTER TABLE broadcast ADD COLUMN serato_offset_seconds INTEGER NOT NULL DEFAULT 0;
