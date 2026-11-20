# Roadmap

## Push notifications — web/Android/desktop (planned — not started)

### Constraints

- **Service worker required.** Push needs an active SW (`push`/`notificationclick` handlers + `pushManager.subscribe`). The SW is currently fully bypassed (`SW_ENABLED = false` in `src/lib/pwa.ts`) after the iOS lock-screen regression and stale-cache bugs.
  - Android/desktop: re-enable the SW as a **push-only SW with zero fetch handling** — no caching, so no risk of the old stale-cache/lock regressions.
  - iOS: **not possible on the web** — see the native app section below. `registerServiceWorker()` returns early on iOS because SW control correlates with lock-screen/background audio dying in the installed PWA on WebKit, and Media Session metadata alone doesn't restore lock-screen controls. Web Push requires a SW, so iOS is out of scope for this section.
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
4. **Phase 4 — iOS: not here.** Web Push on iOS needs a service worker, which isn't viable (see the native app section). No iOS work in this section.

### Open questions

1. Priority: admin announcement push first, or follow-show "starting soon" first?
2. Standalone `push-worker` deployed like `chat-worker` — OK?
3. Opt-in model: per-show bell + account Notifications tab, never a blanket prompt — OK?
4. Android/desktop-only for web push (push-only SW, zero caching); iOS handled by the native app — OK?

## Native iOS app (planned — not started)

Goal: bring push notifications — and proper lock-screen media — to iOS through a native app, since Web Push there requires a service worker and the SW/PWA combination breaks lock-screen audio.

### Why native

- **iOS Web Push is blocked**: push needs a service worker; this site deliberately ships none (`SW_ENABLED = false`), and iOS registration is skipped because SW control correlates with lock-screen/background audio death.
- **APNs needs no SW**, so a native app can deliver push regardless of the web SW situation.
- **Lock-screen media**: a native player (`AVPlayer` + `MPNowPlayingInfoCenter` / `MPRemoteCommandCenter`) behaves properly where WKWebView audio is unreliable once the screen locks.
- Media Session metadata already exists in `StreamPlayer.svelte`; it can't carry push, but the metadata shape is reusable for a native now-playing screen.

### Shape

- **Recommended: Capacitor shell** around the existing SvelteKit site, plus native audio and push plugins. Reuses browse/show/episode/player, auth (magic link) and tracklists; avoids a second front end.
- **Fallback: SwiftUI app** (`AVPlayer`, `MPNowPlayingInfoCenter`, APNs) if WKWebView can't hold lock-screen playback — more work, best result.
- **Shared backend** with the web push plan: extend `workers/push-worker` with APNs token auth (ES256 JWT via WebCrypto, HTTP/2) and a `push_device` table; web push (Android/desktop) and the app can share the same worker and notification rules.
- **Store risk**: App Store guideline 4.2 rejects thin website wrappers — native audio, offline tracklists and push are the justification for review.

### Phases

1. **Spike (TestFlight)** — Capacitor shell loads the site; verify magic-link session cookies persist, background audio survives lock (`AVAudioSession` category), universal links open episodes, and a test APNs push arrives. This decides shell vs native.
2. **Push backend** — migration `push_device` (`device_id`, `user_id`, `platform`, `apns_token`, `updated_at`); `workers/push-worker` with APNs; cron for "show starting soon" and "new replay"; dedupe; admin announcements.
3. **App shell** — Xcode project (e.g. `apps/ios`), icons/splash, notification permission flow, settings mirroring `follow_show`, deep links into episode/player.
4. **Parity** — same alert types as web (followed show soon, new replay, announcements), per-show toggle, tap-through into the player at the right episode.
5. **Store readiness** — privacy labels, in-app account deletion (required when accounts exist), 4.2 mitigation, TestFlight then App Store review.

### Open questions

1. Capacitor shell first, or go straight to native SwiftUI?
2. Launch scope: push + player + browse, with chat/studio excluded?
3. TestFlight-only for now, or public App Store release?
4. Sign-in: magic link inside the webview, or add Sign in with Apple?
5. Who owns the Apple Developer account, certificates and review cadence?

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
