# Shows & schedule data model

How Version Radio stores shows, materialises their airings, and derives the
station's 4-week cycle. Companion to `src/lib/server/shows.ts` (data access,
date helpers, recurrence and cycle math).

> The pure cycle helpers (`CYCLE_ANCHOR`, `cycleWeekOf`) are defined in
> `src/lib/server/shows.ts` on `main`; the schedule week-dividers change
> extracts them to a client-safe `src/lib/cycle.ts` (adding `startOfWeek`) and
> re-exports them from `shows.ts`.

> Dates are calendar strings (`YYYY-MM-DD`) in **station-local time
> (Pacific/Auckland)**. Times are **minutes since midnight** (0–1439). All date
> arithmetic is done with **UTC** `Date` objects (never local time) to stay
> correct across TZ/DST.

## 1. Tables

### `show` — a slot or a one-off event

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | slug of the title; events append the date (`<slug>-<date>`) |
| `dj_id` | TEXT | owning user (`user.id`) |
| `dj_handle` | TEXT | display override for the DJ name (`0014`) |
| `title` | TEXT | |
| `description` | TEXT | short card blurb, capped at 50 chars |
| `page_content` | TEXT | rich HTML (sanitized) shown on the show page (`0019`) |
| `image` | TEXT | curated show image (`0006`) |
| `day_of_week` | INTEGER | 0=Sun … 6=Sat |
| `start_minutes` | INTEGER | minutes since midnight |
| `duration_minutes` | INTEGER | default 60 |
| `interval_weeks` | INTEGER | recurrence multiplier: 1, 2 or 4 (`0003`) |
| `anchor_date` | TEXT | phase anchor for the recurrence (`0003`) |
| `kind` | TEXT | `'show'` (default) or `'event'` (`0015`) |
| `event_type` | TEXT | `'guest-mix'` \| `'hifi-session'` \| null — events only (`0025`) |
| `active` | INTEGER | 1 = listed publicly |
| `created_at` / `updated_at` | INTEGER | unix seconds |

Indexes: `(dj_id)`, `(day_of_week, start_minutes)`.

### `broadcast` — one airing of a show

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | `<show_id>-<date>` (legacy rows may be random UUIDs) |
| `show_id` | TEXT | → `show.id` |
| `date` | TEXT | airing date; **`UNIQUE(show_id, date)`** |
| `start_minutes`, `duration_minutes` | INTEGER | copied from the show when materialised |
| `interval_weeks` | INTEGER | snapshot of the show's interval at materialisation |
| `replay_url` | TEXT | AzuraCast [on-demand link](../README.md#azuracast-streaming-backend) (`0004`) |
| `description` | TEXT | rich HTML episode notes (`0016`) |
| `featured` | INTEGER | homepage "Featured Shows" (`0017`) |
| `home_ready` | INTEGER | homepage "Latest Shows" (`0020`) |
| `art` | TEXT | admin artwork override (`0021`) |
| `created_at` / `updated_at` | INTEGER | unix seconds |

Indexes: `(show_id, date)`, `(date)`.

### `track` — tracklist rows (belong to a **broadcast**, not a show)

`id`, `show_id`, `broadcast_id`, `position`, `title`, `artist`, `album`, `url`
(Bandcamp page), `embed_id`, `album_id`, `duration_seconds`, `mark_seconds`
(cue marker: seconds into the episode recording; `0028`), and the Bandcamp
stream cache (`stream_url`, `stream_expires_at`, `stream_format`,
`stream_art_id`, `stream_capped`, `bandcamp_band_id`, `bandcamp_tralbum_id`).

### Related user-facing tables

- `follow_show(show_id)`, `saved_episode(broadcast_id)` and
  `favourite_broadcast(broadcast_id)` — the last two have real FKs to
  `broadcast(id) ON DELETE CASCADE`.

## 2. Show kinds

- **`kind='show'`** — a slot that recurs (see §3).
- **`kind='event'`** — a one-off. `createShow` inserts the show **and exactly one
  broadcast** (id `<slug>-<date>`); `ensureBroadcasts` returns `[]` for events.
  Optional `event_type` (`Guest Mix` / `HiFi Session`).

## 3. Recurrence & the 4-week cycle (the math)

### 3.1 Date helpers (`src/lib/server/shows.ts`)

```
toDateStr(d)            // UTC Y-M-D of a Date
todayStr(tz='Pacific/Auckland') = zonedNow(tz).date
addDays(dateStr, n)     // UTC add n days
weekdayOf(dateStr)      // UTC getUTCDay(), 0=Sun
nextDateForWeekday(dow, from)  // first date >= from whose weekday === dow
                               //   diff = (dow - weekdayOf(from) + 7) % 7
nextDateForWeekday returns the same day when it already matches (diff = 0).
zonedNow(tz)            // { date, minutes } via Intl 'en-CA', hourCycle h23
broadcastEnded(now, b)  // b.date < now.date
                        // || (b.date === now.date && now.minutes >= start+duration)
```

### 3.2 The cycle

```
CYCLE_ANCHOR = '2026-01-05'   // a Monday
cycleWeekOf(date) =
  weeks = floor( (date − CYCLE_ANCHOR) / 7 days )
  ((weeks mod 4) + 4) mod 4 + 1        // → 1, 2, 3 or 4
```

`cycleWeekOf` is a pure helper (in `src/lib/server/shows.ts`, extracted to
`src/lib/cycle.ts` by the schedule week-dividers change). The schedule page
uses it to label week dividers ("Week X of 4"); the show list uses it to
describe when a show airs.

### 3.3 What `interval_weeks` means

Broadcasts are spaced `interval_weeks × 7` days apart from `anchor_date`:

| interval | cadence | airs on cycle weeks |
|---|---|---|
| `1` | every week | all four (1,2,3,4) |
| `2` | every 2nd week | `base` and `base+2` |
| `4` | every 4th week | `base` only |

where `base = cycleWeekOf(anchor_date)`. (Because +2 weeks advances the cycle
week by 2, and +4 weeks returns to the same cycle week.)

**Real example — the 4-weekly rotation** (all `interval_weeks=4`). Each show
owns one cycle week and airs every 4 weeks:

| show | anchor | `cycleWeekOf(anchor)` |
|---|---|---|
| Beats Reality | 2026-09-16 | **1** |
| detunedradio | 2026-08-26 | **2** |
| Version Excursions | 2026-09-02 | **3** |
| reasonable dubs | 2026-09-09 | **4** |
| Lushelections | 2026-08-25 (Tue) | **2** |

### 3.4 `showCycleWeeks` (display label)

`getSchedule` derives the label used by `airLabel` ("Every 1st & 3rd Wednesday"):

```ts
const baseWeek = cycleWeekOf(anchor_date ?? nextDateForWeekday(day_of_week, todayStr()));
showCycleWeeks =
  interval_weeks === 4 ? [baseWeek]
  : interval_weeks === 2 ? [baseWeek, ((baseWeek + 1) % 4) + 1]
  : [];
```

Note the interval-2 branch is `base` and `base+2`, not `base+1`: the expression
`((base + 1) % 4) + 1` maps 1→3, 2→4, 3→1, 4→2. That matches the recurrence
spacing in §3.3 (+2 weeks = +2 cycle weeks). Interval 1 returns `[]` because a
weekly show airs on every cycle week.

### 3.5 Materialising broadcasts — `ensureBroadcasts`

```
intervalDays = interval_weeks × 7
scheduleStart = fromDate ?? anchor_date ?? nextDateForWeekday(day_of_week, today)
if (fromDate && anchor_date):
    // regenerate without shifting the cycle phase: walk the ORIGINAL phase
    // forward to the first phase date on/after fromDate
    scheduleStart = anchor_date
    while scheduleStart < fromDate: scheduleStart += intervalDays
horizon = addDays(todayStr(), weeks × 7)        // weeks defaults to 12
for k = 0, 1, 2, … while date = scheduleStart + k × intervalDays <= horizon:
    INSERT OR IGNORE broadcast(id=<show>-<date>, show_id, date, start, duration, interval)
```

`INSERT OR IGNORE` plus `UNIQUE(show_id, date)` makes this **idempotent** — safe
to run on every schedule/show page load. Called from:

- the **schedule** page load (all active shows, 12 weeks),
- the **show** page load,
- a schedule-changing edit (`/api/shows/:id` deletes the show's future
  broadcasts, then regenerates),
- `createShow` for recurring shows.

**Adding an episode by hand** (`POST /api/admin/broadcasts`) inserts a single
`broadcast` row (id `<showId>-<date>`) and returns `409` if one already exists
for that date.

### 3.6 Re-phasing — `nextCycleWeekDate`

When an admin changes a show's cycle week:

```
nextCycleWeekDate(dayOfWeek, targetWeek, fromDate) =
  d = nextDateForWeekday(dayOfWeek, fromDate)
  repeat up to 4×: if cycleWeekOf(d) !== targetWeek then d += 7
  return d        // a date with the desired weekday AND cycle week
```

The result becomes the show's new `anchor_date`, so regeneration lands on the
chosen cycle week.

### 3.7 Overlap detection — `findOverlappingShows`

Two independent checks (touching boundaries do not overlap):

- **Exact date** (`date` given): `broadcast` rows on that date whose window
  intersects `[start, start+duration)`.
- **Same weekday** (`dayOfWeek` given): only within the near window
  `[today, today+84]` (where future broadcast rows may not exist yet) — shows
  whose `day_of_week` matches and whose window intersects.

## 4. Reading

| function | used by |
|---|---|
| `getSchedule` | public **Shows** list — active shows + DJ name/image + `showCycleWeeks` |
| `getAllShows` | Studio list — active shows + current `cycleWeek` |
| `getShowWithDj` | one show page |
| `getBroadcasts(showId)` | all airings for a show |
| `getUpcomingBroadcasts(db, days)` | **schedule** page (30) and homepage "Coming Up" (7) |
| `getOnAirBroadcast` / `getNextBroadcast` | `/api/live` → player "on air" / "up next" |
| `getActiveBroadcast` | next upcoming, else latest past |

## 5. Writing

| route | effect |
|---|---|
| `createShow` / `POST /api/shows` | create a show (or event + its single broadcast) |
| `POST /api/shows/:id` | diff-based edit; schedule fields are **admin-only**; a schedule change deletes + regenerates future broadcasts |
| `POST /api/admin/broadcasts` | add one episode |
| `TracklistEditor` → `replaceTracklist` | replace a broadcast's tracklist |
| `POST /api/admin/shows/:id` | assign a show's DJ |

## 6. Artwork resolution

`episodeArtOrDefault(broadcastId, b, show)`:

1. `broadcast.art` (override) → `/media/ep/<broadcastId>/<urlhash>.jpg`
2. replay-derived → `/media/<trackId>.jpg`
3. `show.image`
4. `show.dj_image` (the owner's avatar)

All image URLs are served through the edge-cached `/media` proxy.
