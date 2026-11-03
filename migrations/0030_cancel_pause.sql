-- Migration number: 0030 2026-11-03

-- Cancelled episodes + DJ show breaks.
--
-- Cancellation is a flag rather than a delete: ensureBroadcasts() re-materialises
-- every scheduled slot with INSERT OR IGNORE, so a deleted row would come back on
-- the next page load. A cancelled row stays, is hidden from public lists, and can
-- be restored.
--
-- A show break (`paused`) hides that show's episodes from the break window while
-- leaving the archive intact; `paused_until` NULL means "until resumed".

ALTER TABLE broadcast ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_broadcast_cancelled ON broadcast (cancelled);

ALTER TABLE show ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE show ADD COLUMN paused_until TEXT;
ALTER TABLE show ADD COLUMN paused_at TEXT;
