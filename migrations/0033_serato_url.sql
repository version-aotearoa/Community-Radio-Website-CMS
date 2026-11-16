-- One Serato playlist per episode, pasted as a URL.
--
-- The URL already contains the DJ and the date, so deriving it from a show-level
-- handle was unnecessary indirection (and guessed at day/month padding).
ALTER TABLE broadcast ADD COLUMN serato_url TEXT;

-- Nothing was ever saved in this column, so dropping it loses no data.
ALTER TABLE show DROP COLUMN serato_user;
