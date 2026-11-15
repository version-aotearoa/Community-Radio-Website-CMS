-- Serato playlist handle per show.
--
-- DJs publish their set to https://serato.com/playlists/<handle>/<dd-mm-yyyy>;
-- the tracklist editor derives that URL from this handle + the broadcast date
-- and imports the rows (artist - title + elapsed time → cue markers).
-- One-off/guest shows can still paste a playlist URL directly in the editor.
ALTER TABLE show ADD COLUMN serato_user TEXT;
