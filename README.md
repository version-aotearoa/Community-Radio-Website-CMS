# Version Radio — Svelte app on Cloudflare

Independent radio: live stream player, DJ tracklist editor, public schedule, and community chat.

See [ROADMAP.md](ROADMAP.md) for planned features (push notifications).

> **Bring your own AzuraCast.** This repository is the software behind Version
> Radio, so every instance, station id, domain, Pages/D1/Worker name and brand
> string in it is *our* value — each one is something you replace to run your own
> station. Start with [Running your own station](#running-your-own-station).

**Environments**

- **local** — `npm run dev` on your machine; local D1 state; `.dev.vars`
- **dev (staging)** — `version-radio-staging` Pages project at `https://dev.versionradio.live` (`version-radio-staging.pages.dev`); separate `version-radio-db-staging` + `chat-worker-staging`; preview before prod
- **prod** — `version-radio` Pages project at `https://versionradio.live` (`version-radio.pages.dev`); `version-radio-db`

Those project names and domains belong to our deployment; substitute yours.

## Stack

- **Frontend**: SvelteKit (Runes), SVAR Svelte UI (WillowDark theme), hls.js
- **Platform**: Cloudflare Pages (full-stack) · D1 (SQLite) · Durable Objects (chat) · Better Auth (magic links + social) · Cloudflare Turnstile
- **Streaming**: self-hosted **AzuraCast** (live HLS, now-playing, replays, artwork) — see [AzuraCast (streaming backend)](#azuracast-streaming-backend) and [Running your own station](#running-your-own-station)
- **PWA**: manifest + service worker (offline app shell)

## Architecture

- `src/` — SvelteKit app (Pages). Server routes access Cloudflare bindings via `event.platform.env`.
- `workers/chat-worker/` — separate Worker owning the `ChatRoom` Durable Object (WebSockets + DO SQLite). SvelteKit does not export DO classes (adapter limitation), so the chat worker is deployed independently and the app connects to it via `PUBLIC_CHAT_URL`.
- `migrations/` — D1 migrations (domain + auth tables).
- [`docs/shows-schedule.md`](docs/shows-schedule.md) — shows/broadcasts data model + recurrence/4-week-cycle math.
- Live stream, now-playing, replays and artwork come from the self-hosted **AzuraCast** backend (this deployment: `stream.versionradio.live`) — see [AzuraCast (streaming backend)](#azuracast-streaming-backend).

## Accounts and chat identity

Sign-in is Better Auth: email magic links plus Google/GitHub (each button only
appears when its `*_ID`/`*_SECRET` env vars are set). Every account has a `user`
row (`name`, `email`, `role`, `active`); social sign-ins also store an `account`
row with the provider tokens.

**An email address is never a display name.** `displayNameFor()`
(`src/lib/displayName.ts`) resolves the public name — the account's `name`, or
`Listener` when it is empty or looks like an address. `/api/chat/identity` signs
that name into the chat token, so it can't leak into a message; the chat worker
also coerces any inbound name containing `@` and rewrites stored ones
(`ChatRoom` migration 7). Accounts without a name are nudged to set one from the
chat composer, the login page and My Version → Profile.

**Episode comments.** Each episode has its own chat room
(`episode:<show>:<date>`, keyed on stable show/date rather than the mutable
episode slug). The episode page embeds the conversation above its tracklist.
Comments carry `at_seconds` — the replay position when posted — and clicking a
comment's time seeks/starts the recording there. Replies are one level deep and
inherit the parent's timestamp. A clickable waveform above the tracklist shows
comment pins and seeks on click/drag; hovering or tapping a pin opens its
comment without moving playback. With `AZURACAST_API_KEY` set, the waveform uses
real AzuraCast peaks (downsampled and cached server-side); otherwise — or when
AzuraCast cannot decode the recording (its generator handles MP3/Ogg/FLAC/WAV,
not the MP4/AAC container, so older `.m4a` recordings fail) — it falls back to a
stable decorative waveform, marked **approx.** in the header. **Comment** posts at the current or pinned
moment. Comments sit below the tracklist. Public history is readable before
Turnstile verification; verifying only gates posting and live updates. Studio →
Chat selects the main room or a recent episode room for moderation.

## Running your own station

Everything here is wired for one station. The table lists what to change; the
AzuraCast backend is the only hard-coded dependency, and it lives in one file.

| What | Where |
|---|---|
| AzuraCast origin, station id, shortcode | `src/lib/azuracast.ts` |
| Brand title, default description, Bluesky link | `src/lib/site.ts` |
| Chat worker URL, Turnstile keys, auth + email secrets | `.dev.vars` locally, then Pages project env (see `.dev.vars.example`) |
| Pages project, D1 database, chat worker names | `wrangler.jsonc`, `deploy/staging/wrangler.jsonc`, `workers/chat-worker/wrangler.jsonc` |
| Public domains (`versionradio.live`, `dev.versionradio.live`) | Cloudflare Pages custom domains + your DNS |
| Show importer's source instance | `scripts/import-shows.mjs` |

**AzuraCast** — the app talks to a single backend, configured by three exports in
`src/lib/azuracast.ts`:

```ts
export const AZURACAST_BASE = 'https://stream.versionradio.live'; // ← your AzuraCast origin
export const AZURACAST_STATION_ID = '1';                          // ← your station id
export const AZURACAST_STATION_SHORTCODE = 'version_radio';
```

Point those at your instance and the rest follows: live HLS proxying, on-demand
replay URLs, artwork, and waveform peaks are all derived from them. The
on-demand/replay endpoints used publicly need no API key; only waveform peaks
send `AZURACAST_API_KEY` (a station key with access to media data), and the site
falls back to a decorative waveform without it.

Two Version Radio specifics are safe to delete for a fresh install:

- `normalizeAzuraCastArtUrl()` in `src/lib/azuracast.ts` rewrites stored artwork
  from the retired `stream.version.nz` host — a one-off migration artefact.
- `.m4a` recordings in our archive predate the recording-format change; yours
  will depend on your own AzuraCast settings.

## AzuraCast (streaming backend)

AzuraCast is an **external, self-hosted dependency** (not run by the app) — the
documentation below applies to any instance; this deployment uses
`https://stream.versionradio.live` with station id `1` and shortcode
`version_radio` (see [Running your own station](#running-your-own-station)).
It provides the 24/7 live HLS stream (AutoDJ re-air + live DJ input),
now-playing/live metadata, on-demand replays, and artwork. The old
`stream.version.nz` host was retired in the server move; stored artwork URLs
from it are rewritten in `normalizeAzuraCastArtUrl()`.

**API / stream data used**

| Endpoint | Purpose | App route |
|---|---|---|
| `GET /api/nowplaying` | now-playing song/art, `duration`/`elapsed`/`remaining`/`played_at`, `live.is_live` + `live.streamer_name`, `playlist` | `/api/live` (proxied, `Cache-Control: max-age=15`; client polls every 30 s) |
| `GET /hls/version_radio/live.m3u8` | live audio (4 AAC variants, 52.8–352 kbps) | `src/lib/components/StreamPlayer.svelte` (`STREAM_URL`) |
| `GET /api/station/version_radio/art/<file>` | artwork | `/media/[file]` (edge-cached, year immutable) |
| `GET /api/station/1/ondemand/download/<track_id>` | replay audio (Range-capable, server-side seekable) | stored in `broadcast.replay_url` (`replayPlayUrl`) |
| `/api/stream/[...path]` *(our route)* | same-origin passthrough for `/hls/`, `/media/`, `/api/station/` | hls.js XHR (Chrome/desktop) |

- **Replay art** derives from the on-demand track id → `/media/<track_id>.jpg` (`replayArtFromUrl`); `show.image` may also be an AzuraCast-provided URL.
- Admin replay fields accept a bare 24-hex track id or an on-demand URL (`extractReplayTrackId`).

**Behaviour / quirks**

- **Live vs re-air**: `live.is_live` is true only for a real DJ; the 24/7 re-air is the station's `default` playlist playing recorded files through the same HLS stream (`playlist: "default"`).
- **`elapsed` drifts** (the now-playing cache is ~15 s stale), so the client anchors a wall clock and resyncs on each 30 s poll.
- **iOS** must play the origin `live.m3u8` directly; hls.js (Chrome/desktop) goes through `/api/stream` for CORS. Proxying iOS native HLS stalls segments and breaks background/lock-screen playback.
- HLS segments rotate every ~4 s; pruned replays return `text/html`, so replay buttons require a live on-demand file.
- Auth-gated AzuraCast endpoints (history, media detail) are **not** used.

**Failure handling**: if AzuraCast is unreachable the site still loads — `/api/live` returns `isOnline: false`, `/media` art 404s, and live/replay playback is unavailable.

## Video relay (Streamplace)

The station is also simulcast as video to [Streamplace](https://stream.place) via
[streamplace-azuracast-relay](https://github.com/version-aotearoa/streamplace-azuracast-relay),
which runs on the same VPS as AzuraCast:

- a remote DJ publishes from OBS over RTMPS to `multistream.versionradio.live:1935`
- the relay passes the video through untouched (no transcode) to Streamplace
- the same audio is pushed back into the station's Liquidsoap harbour, so radio
  listeners hear the DJ while the video audience watches them
- when no DJ is publishing, the relay sends the station's own audio with
  per-track artwork and burned-in captions instead

The app does not consume this yet; it remains an AzuraCast-only frontend.

## External dependencies

- **AzuraCast** (self-hosted) — live stream, now-playing, replays, artwork
- **Streamplace** — video simulcast target (see [Video relay](#video-relay-streamplace))
- **Bandcamp** public JSON APIs — tracklist playback resolution
- **GIPHY** — chat GIFs (client-side; `PUBLIC_GIPHY_API_KEY`)
- **Cloudflare Turnstile** — bot protection (auth + chat)
- **Resend / Cloudflare Email Service** — transactional email (magic links)
- Cloudflare **Stream / R2** — *not used*; evaluated as a possible AzuraCast replacement

## Bandcamp playback

Tracklist rows with a Bandcamp link play through the **global player** (the same single `<audio>` element as live/replay), so only one track ever plays — on every browser. (The old EmbeddedPlayer iframes were replaced: a cross-origin embed can't be controlled, and Chrome blocks a second embed's audio.)

**Resolution.** Bandcamp web pages are behind Cloudflare Bot Management, so datacenter egress (our Worker) can't fetch a track/album page. Bandcamp's **public JSON APIs** aren't challenged, so we call those directly — no browser, proxy or reader service:

1. `POST https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic` → match the stored page URL (`item_url_path`) → numeric `band_id` + `tralbum_id`.
2. `GET https://bandcamp.com/api/mobile/24/tralbum_details?band_id=…&tralbum_id=…&tralbum_type=t|a` → `tracks[].streaming_url`.

The ids are cached on the track row (`bandcamp_band_id` / `bandcamp_tralbum_id`), so a re-resolve skips step 1. `streaming_url` is a short-lived signed `bandcamp.com/stream_redirect` link; we follow its redirect to the CDN URL and store:

- the stream URL (`stream_url`, `stream_expires_at` gates re-resolution),
- title, artist, duration, and art id (`stream_art_id`).

`GET /api/tracks/:id/stream` is D1-cache-first and resolves on miss. Only Bandcamp **track/album page** URLs resolve; `EmbeddedPlayer`/artist URLs return a "re-link with the page URL" error.

**Metadata prefetch (name/artist/art).** Fills rows so names appear before play. It runs **client-side** (each row is its own short request, so a large import can't hit the Worker's 30s ceiling), 2 at a time with a small stagger, and skips rows that already have metadata:

1. **Editor — after “Save tracklist”**: warms D1 so the public page is already enriched.
2. **Public broadcast page — on load**: resolves any rows still missing metadata. The first visitor to a tracklist pays the fetch cost; later views render straight from D1.

Clicking a track still resolves as a fallback (usually instant once prefetched).

**Playback & queue.** Starting a track loads the tracklist into a **persistent queue** (`playQueue` in the player store), so playback keeps advancing even if you navigate away:

- When a track ends, the next playable row plays automatically; the next stream URL is prefetched so transitions are near-instant.
- Rows that can't resolve are skipped. At the end of the tracklist it returns to the **live stream**.
- Lock-screen / headset **next/previous** control the queue (Media Session `nexttrack`/`previoustrack`).
- Starting a replay (or going back to live) clears the queue.

**Cue markers (click a time to jump in the recording).** A tracklist row can carry
`mark_seconds` — its position in that episode's recording (`broadcast.replay_url`,
an AzuraCast on-demand file with HTTP Range support). The public episode page shows
it as a time in the row; clicking it plays the replay from that point:

- Already playing this replay → the player **seeks in place** (`requestSeek` in the
  player store), so nothing reloads.
- Otherwise the replay starts with `startAt`, applied once metadata makes seeking
  possible (`applyPendingSeek` in `StreamPlayer`).
- The clicked row highlights (`aria-current`) until the recording pauses, ends, or
  playback moves elsewhere.
- No replay (or one flagged by `replayAvailability`) → the time renders as plain,
  non-clickable text. Marks are stored regardless, so they become live as soon as a
  recording is added.

DJs type `m:ss` / `h:mm:ss` (bare seconds also work) into the **Time** column; CSV
imports recognise `time`/`timestamp`/`mark`/`cue`/`start` headers (or a clock-shaped
column), and **Stamp time** fills the selected row from the replay's current
position. Column: `0028_track_mark.sql`.

The tracklist editor has a **replay strip** above the grid — play/pause, skip
±5s / ±1 min, scrub and a live `12:34 / 1:04:09` readout — so cues can be stamped
without leaving edit mode. It drives the same global player as the public page,
and falls back to “Set a replay link” when the episode has no recording.

**Export CSV** writes the grid back out with the same headers the importer
accepts (`#,time,title,artist,album,url`), BOM + CRLF for Excel, so a file
round-trips through Import. Rows that only carry a Time are kept — a cue can
exist before its title is filled in.

**Saving a moment / sharing it.** Each public tracklist row carries a heart and a
copy-link beside its number:

- **♥** saves that cue — the row's text plus its time — to **My Version → Tracks**
  (`saved_track`, `0029`). Saved cues are keyed on `(broadcast, mark_seconds)`, not
  `track.id`, so saving the tracklist again never orphans them.
- **⧉** copies `/shows/<show>/<episode>?t=<seconds>`; opening it scrolls the
  matching tracklist row into view and resumes the recording at that point (`?t`
  is read on mount and handed to the player's `startAt`, clamped to the recording
  length).
- When the browser refuses autoplay on a shared link, the page shows a
  **Play from here** prompt (track, time, episode) whose confirm button is the
  user gesture that starts playback at that second (`PlayFromHere.svelte`).

**Notes / limits**

- Signed stream URLs expire; a play after expiry re-resolves (ids are cached, so it's one API call).
- Some tracks are preview-only (`capped`) — surfaced as `capped: true`.
- Migrations `0022_track_stream.sql` / `0026_track_bandcamp_ids.sql` add the `stream_*` and `bandcamp_*` columns.
- Hotlinking Bandcamp streams is a product decision; each row keeps a prominent “Bandcamp ↗” link.

## Local development

```sh
# App (vite dev; D1 emulated via adapter platformProxy)
npm install
npm run dev

# Or production-accurate run
npm run build
npm run pages:dev
```

Chat worker (separate terminal):

```sh
cd workers/chat-worker
npm install
npm run dev          # http://localhost:8790
```

Copy `.dev.vars.example` → `.dev.vars` (app) and `.dev.vars.turnstile.example` values into it. Chat worker reads its own `.dev.vars`.

Local magic links are logged to the console (`[dev-email] To: ...`) instead of sent.

## Deployment

### CI/CD pipeline (recommended)

Deploys are automated via GitHub Actions (see `.github/workflows/`):

- **`pr-checks`** — runs `npm run check` on every PR. Required status check on `main` (bad code can't merge).
- **`Deploy prod`** — runs on merge to `main` (PR-gated): D1 migrations → Pages deploy (`version-radio`) → chat worker.
- **`Deploy staging`** — manual (`workflow_dispatch`, pick a branch): Pages deploy (`version-radio-staging`) → staging chat worker.

Setup (one-time): add GitHub secrets `CLOUDFLARE_API_TOKEN` (Pages:Edit, D1:Edit, Workers Scripts:Edit) and `CLOUDFLARE_ACCOUNT_ID` (`6f00a3bc33382599b284ed7a623807d9`). `main` is branch-protected (`pr-checks`, `enforce_admins`); a human review gate (PR + 1 approval) can be added for major updates by requiring reviews on `main`.

### Manual (local fallback)

Prod (only if the pipeline can't be used — normally CI handles it):

```sh
# 1. Migrations
npx wrangler d1 migrations apply version-radio-db --remote

# 2. Chat worker (independent DO worker)
cd workers/chat-worker && npx wrangler deploy   # prints https://chat-worker.<sub>.workers.dev

# 3. App
npm run build
npx wrangler pages deploy .svelte-kit/cloudflare --project-name version-radio --branch main
```

Prod URL: `https://versionradio.live`.

## Staging (dev) deployment

Deploy to staging with `npm run pages:deploy` (local, any branch) **or** the CI `Deploy staging` workflow (pick a branch in GitHub Actions). Both build and upload to the `version-radio-staging` Pages project using `deploy/staging/wrangler.jsonc` for the staging D1 binding. One-time setup:

1. **Pages project** — create `version-radio-staging` (same build output: `.svelte-kit/cloudflare`).
2. **D1** — create a separate database and apply migrations:
   ```sh
   npx wrangler d1 create version-radio-db-staging
   npx wrangler d1 migrations apply version-radio-db-staging --remote -c deploy/staging/wrangler.jsonc
   ```
   Staging starts fresh (no prod data copy).
3. **Custom domain** — Pages dashboard → `version-radio-staging` → Custom domains → Set up a domain → `dev.versionradio.live`, then at your DNS provider add `CNAME dev → version-radio-staging.pages.dev`. Associate in the dashboard first (CNAME-only setup causes a 522).
4. **Secrets (staging project)** — `AUTH_SECRET` (new value, not prod's), `GOOGLE_ID/GOOGLE_SECRET` (reuse prod), `RESEND_API_KEY/RESEND_FROM` (reuse prod), `PUBLIC_CHAT_URL` (staging chat worker URL), `TURNSTILE_SECRET`/`TURNSTILE_HOSTNAMES`/`PUBLIC_TURNSTILE_SITE_KEY` (test keys), `BETTER_AUTH_URL=https://dev.versionradio.live`.
5. **Chat worker** — from `workers/chat-worker`: `npx wrangler deploy --name chat-worker-staging`, then set `CHAT_IDENTITY_SECRET` + `CHAT_ADMIN_TOKEN` (shared values with the staging app).
6. **OAuth** — add `https://dev.versionradio.live/api/auth/callback/*` callback URLs to the GitHub/Google OAuth apps.

Staging URL: `https://dev.versionradio.live` (also reachable via `https://version-radio-staging.pages.dev`).

## Custom domains (all environments)

`versionradio.live` is an apex domain — it requires the zone on Cloudflare (full setup, nameservers moved from the registrar). Subdomains (`dev.versionradio.live`) work without moving the zone: associate the hostname in the Pages dashboard first (CNAME-only setup causes a 522), then add a CNAME at your DNS provider. Check for CAA records at your zone if certificate issuance fails.

## Before going live

- Create real Turnstile widget (account-level) for the production hostname `versionradio.live`; set `PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`, `TURNSTILE_HOSTNAMES` (add `dev.versionradio.live` too). Test keys are in `.dev.vars` today and on staging. Notes: with the test keys siteverify returns `hostname: "example.com"` (hence staging's `TURNSTILE_HOSTNAMES` includes it) — real keys return the real page hostname, so no `example.com` entry is needed once prod has real keys. The login form sets its `busy` flag synchronously (before the async Turnstile verify) so enabling Turnstile on prod will not cause duplicate magic-link emails.
- Onboard a sending domain for Cloudflare Email Service; add the `EMAIL` binding via the Pages dashboard (config-file `send_email` is rejected for Pages) and set `EMAIL_FROM`. Until then magic links log to the console.
- Set `BETTER_AUTH_URL` (or `baseURL`) once a stable production hostname exists.
- Add GitHub/Google OAuth client IDs as `GITHUB_ID/GITHUB_SECRET/GOOGLE_ID/GOOGLE_SECRET` secrets.
