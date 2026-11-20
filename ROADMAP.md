# Roadmap

## Push notifications (planned — not started)

### Constraints

- **Service worker required.** Push needs an active SW (`push`/`notificationclick` handlers + `pushManager.subscribe`). The SW is currently fully bypassed (`SW_ENABLED = false` in `src/lib/pwa.ts`) after the iOS lock-screen regression and stale-cache bugs.
  - Android/desktop: re-enable the SW as a **push-only SW with zero fetch handling** — no caching, so no risk of the old stale-cache/lock regressions.
  - iOS: registration stays skipped (lock-screen fix), so **iOS Web Push is blocked for now** (also requires an installed PWA there). Known limitation.
- **No cron in Pages Functions.** Cloudflare Pages can't schedule; follow the `workers/chat-worker` pattern: a standalone Worker with cron triggers.
- **Web Push encryption** — RFC 8291 (ECDH P-256 + HKDF + AES-128-GCM) via WebCrypto; VAPID private key as a Worker secret, public key as `PUBLIC_VAPID_KEY` for the client. Prefer a small hand-rolled WebCrypto implementation (no deps, matches project style); `@block65/webcrypto-web-push` if a library is wanted.
- **Targeting data already exists**: `follow_show` (user→show) and `broadcast` (date/start_minutes/replay_url).

### Architecture

**New `workers/push-worker`** (pattern: chat-worker)
- Binds the same `version-radio-db` D1 (subscriptions + dedupe).
- Cron (e.g. every 5 min): "show starting in ~15 min" → join `follow_show` × `broadcast`; "new replay" → detect freshly-set `replay_url`.
- `POST /send` (shared-secret auth) for admin announcements, called from the Pages app.
- Secrets: `VAPID_PRIVATE_KEY`, `PUSH_WORKER_SECRET`, `PUSH_WORKER_URL`.

**App changes**
- Migration: `push_subscription` table (+ `push_notified` dedupe or `broadcast.replay_notified` flag).
- Client: opt-in bell on show pages ("Notify me when this airs") + **Notifications** tab in My Version (global on/off, subscribed shows). Endpoints `/api/push/*`.
- Admin: "Notify" action in Studio (title + body) → all subscribed users.
- SW: push-only worker for Android/desktop, **no fetch handler**; iOS stays unregistered.
- `registerServiceWorker()` gains a push-mode path (desktop/Android only).

### Phases

1. **Phase 1 — plumbing**: push-only SW (Android/desktop), subscribe/unsubscribe, admin broadcast notification ("station announcement").
2. **Phase 2 — cron**: "your followed show starts in 15 min".
3. **Phase 3 — cron**: "new replay available" for followed shows.
4. **Phase 4 (later) — iOS**, once the lock-screen/SW conflict has a real fix.

### Open questions

1. Priority: admin announcement push first, or follow-show "starting soon" first?
2. Standalone `push-worker` deployed like `chat-worker` — OK?
3. Opt-in model: per-show bell + account Notifications tab, never a blanket prompt — OK?
4. Android/desktop-only for now (push-only SW, zero caching), iOS push parked — OK?

## Editable episode date & time (planned — not started)

Goal: correct a broadcast's **date**, **start time** and **duration** from the tracklist editor's Episode tab. Scope is one-off events and **archived** (past) episodes — not rescheduling upcoming recurring slots.

### Constraints

- **Unique slot.** `broadcast` is `UNIQUE (show_id, date)`; a re-dated episode can collide with an existing row. Reject with a clear 409 rather than letting the constraint surface.
- **Ghost regeneration.** `ensureBroadcasts()` walks from `show.anchor_date` and `INSERT OR IGNORE`s every slot up to the horizon, *including past ones* (`/shows/[id]`, `/schedule`, tracklist save). Moving an archived episode therefore re-creates an empty episode on the vacated slot. Fix: default the generation window to start at `todayStr()`, reusing the phase-preserving walk the `fromDate` branch already does. Every caller already means "materialise upcoming broadcasts".
- **Ids embed the date.** Episode ids are `<show>-<date>`, so a date change leaves a stale id/URL. Keep the id (URL stability); renaming stays a separate action via the Episode ID field.
- **Chat room key includes the date** (`episode:<showId>:<date>`), so a re-dated episode starts a fresh room and its old history stays in the Durable Object.
- **Permissions.** Show-level date/time edits are admin-only today (`/api/shows/[id]` gates `dayOfWeek`/`startMinutes`/`durationMinutes` behind `isAdmin`), while the episode editor (id/description/replay) is DJ-editable.

### Plan

- `PUT /api/shows/[id]/broadcasts/[broadcastId]/schedule`, mirroring the `slug`/`description`/`replay` routes: validate `date` (`YYYY-MM-DD`, real calendar date), `startMinutes` (0–1439), `durationMinutes` (1–1440); allow a date change only for events or episodes whose current date is in the past; 409 on slot collisions; write only changed columns + `updated_at`.
- TracklistEditor Episode tab: a "Date & time" block (date, time → minutes, duration) above "Episode ID", using the existing save/error/notice pattern, then `invalidateAll()` so the header and `<title>` refresh. Disable the date field on upcoming recurring episodes with a hint; note the chat-room effect.
- `ensureBroadcasts()`: default `fromDate` to `todayStr()`.
- No schema change or migration.
- Staging checks: re-date the 2005 HIFI Sessions episode and a test recurring archive episode; confirm no ghost row, collision 409, and future-date rejection.

### Open questions

1. Admin-only, or DJs for their own show too?
2. Include duration in the same block? (assumed yes)
3. OK to change `ensureBroadcasts()` to today-forward generation?
