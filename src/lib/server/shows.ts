export interface ShowRow {
	id: string;
	dj_id: string;
	dj_handle: string | null;
	kind: string;
	/** Optional subtype for kind='event' rows ('guest-mix' | 'hifi-session'), else null. */
	event_type: string | null;
	title: string;
	description: string;
	page_content: string;
	image: string | null;
	day_of_week: number;
	start_minutes: number;
	duration_minutes: number;
	interval_weeks: number;
	anchor_date: string | null;
	cycleWeek?: number;
	active: number;
	created_at: number;
	updated_at: number;
}

export interface BroadcastRow {
	id: string;
	show_id: string;
	date: string; // YYYY-MM-DD (Pacific/Auckland calendar date)
	start_minutes: number;
	duration_minutes: number;
	interval_weeks: number;
	replay_url: string | null;
	description: string;
	featured: number;
	home_ready: number;
	/** Admin-set artwork override (any public image URL); else replay art is used. */
	art: string | null;
	created_at: number;
	updated_at: number;
}

import { extractReplayTrackId, replayPlayUrl as azReplayPlayUrl } from '$lib/azuracast';
import {
	DESCRIPTION_MAX,
	descriptionToText,
	sanitizeDescription
} from '$lib/server/sanitize';
import { isEventType } from '$lib/eventTypes';
import { cycleWeekOf } from '$lib/cycle';

/** Max length of the short plain-text card blurb (show.description). */
export const SHOW_DESC_MAX = 50;

/** Max length of the plain-text extract used for social share descriptions. */
export const OG_DESC_MAX = 200;

export interface TrackRow {
	id: string;
	show_id: string;
	broadcast_id: string | null;
	position: number;
	title: string;
	artist: string;
	album: string;
	url: string | null;
	embed_id: string | null;
	album_id: string | null;
	/** Bandcamp stream (resolved on demand; signed URL, expires ~24h). */
	stream_url: string | null;
	stream_expires_at: number | null;
	stream_format: string | null;
	stream_art_id: string | null;
	stream_capped: number | null;
	duration_seconds: number | null;
	/** Bandcamp numeric ids (cached from the search API) so re-resolve skips search. */
	bandcamp_band_id: number | null;
	bandcamp_tralbum_id: number | null;
	created_at: number;
	updated_at: number;
}

export interface TrackInput {
	title: string;
	artist?: string;
	album?: string;
	url?: string | null;
	embedId?: string | null;
	albumId?: string | null;
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * Show rows carry a short plain-text blurb (`description`, max 50 chars) for
 * cards/taglines plus rich HTML `page_content` (sanitized) shown only on the
 * show page. `description` is rendered as escaped text, so any stray HTML is
 * stripped via `descriptionToText` rather than allowed through.
 */
function sanitizeShowRow<T extends ShowRow>(row: T): T {
	return {
		...row,
		event_type: isEventType(row.event_type) ? row.event_type : null,
		description: descriptionToText(row.description).slice(0, SHOW_DESC_MAX),
		page_content: sanitizeDescription(row.page_content).slice(0, DESCRIPTION_MAX)
	};
}

function sanitizeBroadcastRow<T extends BroadcastRow>(row: T): T {
	return { ...row, description: sanitizeDescription(row.description) };
}

/* ------------------------------------------------------------------ */
/* Date helpers (calendar-date only; safe across TZ/DST)               */
/* ------------------------------------------------------------------ */

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

export function toDateStr(d: Date): string {
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function todayStr(timeZone = 'Pacific/Auckland'): string {
	return zonedNow(timeZone).date;
}

/**
 * Whether a broadcast's airing window has fully elapsed at the given instant
 * (station-local date + minutes). Same-date rows count as ended only once
 * `start_minutes + duration_minutes` has passed; earlier-date rows are past.
 */
export function broadcastEnded(
	now: { date: string; minutes: number },
	b: { date: string; start_minutes: number; duration_minutes: number }
): boolean {
	return b.date < now.date || (b.date === now.date && now.minutes >= b.start_minutes + b.duration_minutes);
}

export function addDays(dateStr: string, days: number): string {
	const [y, m, d] = dateStr.split('-').map(Number);
	const date = new Date(Date.UTC(y, m - 1, d));
	date.setUTCDate(date.getUTCDate() + days);
	return toDateStr(date);
}

export function weekdayOf(dateStr: string): number {
	const [y, m, d] = dateStr.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
}

/** Next (or current) date <= fromDate matching `dayOfWeek`... find result >= fromDate. */
export function nextDateForWeekday(dayOfWeek: number, fromDate: string): string {
	const cur = weekdayOf(fromDate);
	const diff = (dayOfWeek - cur + 7) % 7;
	return addDays(fromDate, diff);
}

/* ------------------------------------------------------------------ */
/* Broadcasts                                                          */
/* ------------------------------------------------------------------ */

/**
 * Materialise upcoming broadcasts for a show from its recurrence rule:
 * anchor + k * interval_weeks. Idempotent (UNIQUE(show_id, date)).
 */
export async function ensureBroadcasts(
	db: D1Database,
	show: Pick<ShowRow, 'id' | 'interval_weeks' | 'anchor_date' | 'day_of_week' | 'start_minutes' | 'duration_minutes' | 'kind'>,
	weeks = 12,
	fromDate?: string
): Promise<BroadcastRow[]> {
	// One-off events never generate recurring broadcasts.
	if (show.kind === 'event') return [];
	let scheduleStart = fromDate ?? show.anchor_date ?? nextDateForWeekday(show.day_of_week, todayStr());
	if (fromDate && show.anchor_date) {
		// Keep the anchor's cycle phase: walk forward to the first phase date
		// on/after `fromDate` so regeneration never shifts the cycle week.
		scheduleStart = show.anchor_date;
		const intervalDays = show.interval_weeks * 7;
		while (scheduleStart < fromDate) scheduleStart = addDays(scheduleStart, intervalDays);
	}
	const horizon = addDays(todayStr(), weeks * 7);
	const intervalDays = show.interval_weeks * 7;

	const stmts: D1PreparedStatement[] = [];
	let k = 0;
	let date = scheduleStart;
	while (date <= horizon) {
		stmts.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO broadcast (id, show_id, date, start_minutes, duration_minutes, interval_weeks, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					// Friendly, deterministic episode slug (`<show>-<date>`) — matches
					// the admin Add-episode route and events, and keeps URLs readable.
					`${show.id}-${date}`,
					show.id,
					date,
					show.start_minutes,
					show.duration_minutes,
					show.interval_weeks,
					now(),
					now()
				)
		);
		k += 1;
		date = addDays(scheduleStart, k * intervalDays);
	}
	if (stmts.length > 0) await db.batch(stmts);
	return getBroadcasts(db, show.id);
}

export async function getBroadcasts(db: D1Database, showId: string): Promise<BroadcastRow[]> {
	const { results } = await db
		.prepare('SELECT * FROM broadcast WHERE show_id = ? ORDER BY date')
		.bind(showId)
		.all();
	return (results as unknown as BroadcastRow[]).map(sanitizeBroadcastRow);
}

/** The show's current broadcast: next upcoming, or latest past if nothing upcoming. */
export async function getActiveBroadcast(db: D1Database, showId: string): Promise<BroadcastRow | null> {
	const upcoming = await db
		.prepare('SELECT * FROM broadcast WHERE show_id = ? AND date >= ? ORDER BY date LIMIT 1')
		.bind(showId, todayStr())
		.first();
	if (upcoming) return sanitizeBroadcastRow(upcoming as unknown as BroadcastRow);
	const last = await db
		.prepare('SELECT * FROM broadcast WHERE show_id = ? ORDER BY date DESC LIMIT 1')
		.bind(showId)
		.first();
	return (last ? sanitizeBroadcastRow(last as unknown as BroadcastRow) : null) as BroadcastRow | null;
}

export async function getBroadcast(db: D1Database, id: string): Promise<BroadcastRow | null> {
	const row = (await db.prepare('SELECT * FROM broadcast WHERE id = ?').bind(id).first()) as
		| BroadcastRow
		| null;
	return row ? sanitizeBroadcastRow(row) : null;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve a broadcast reference to the real row for a given show, tolerating
 * the site's mixed episode id conventions. Tries, in order: the exact id (only
 * if it belongs to `showId`), a bare `YYYY-MM-DD` date, and a
 * `<showId>-<YYYY-MM-DD>` slug. Returns null when nothing plausibly matches.
 * Used so page URLs and save endpoints agree even when a row's id and the
 * requested reference differ in convention.
 */
export async function resolveBroadcastForShow(
	db: D1Database,
	showId: string,
	ref: string
): Promise<BroadcastRow | null> {
	const exact = await getBroadcast(db, ref);
	if (exact && exact.show_id === showId) return exact;

	if (DATE_ONLY_RE.test(ref)) {
		const row = await db
			.prepare('SELECT * FROM broadcast WHERE show_id = ? AND date = ? LIMIT 1')
			.bind(showId, ref)
			.first();
		if (row) return sanitizeBroadcastRow(row as unknown as BroadcastRow);
	}

	const m = ref.match(/^(.+)-(\d{4}-\d{2}-\d{2})$/);
	if (m && m[1] === showId) {
		const row = await db
			.prepare('SELECT * FROM broadcast WHERE show_id = ? AND date = ? LIMIT 1')
			.bind(showId, m[2])
			.first();
		if (row) return sanitizeBroadcastRow(row as unknown as BroadcastRow);
	}

	return null;
}

/**
 * Store (or clear) a broadcast's replay link. Accepts a bare track id or a raw
 * on-demand download URL; stores the canonical absolute play URL.
 * Returns the stored value (null when cleared).
 */
export async function setBroadcastReplayUrl(
	db: D1Database,
	broadcastId: string,
	url: string | null
): Promise<string | null> {
	const replay_url = url ? replayPlayUrl(url) : null;
	await db
		.prepare('UPDATE broadcast SET replay_url = ?, updated_at = ? WHERE id = ?')
		.bind(replay_url, now(), broadcastId)
		.run();
	return replay_url;
}

/**
 * Canonical play URL from a pasted URL or bare track id (or null).
 *
 * A pasted URL is kept verbatim — origin and path exactly as given — because
 * recordings are spread across AzuraCast instances (one host per migration
 * era) and rewriting the host would point at a server that doesn't hold the
 * track. A bare track id has no host of its own, so it expands against the
 * current instance.
 */
export function replayPlayUrl(input: string): string | null {
	const raw = input.trim();
	const id = extractReplayTrackId(raw);
	if (!id) return null;
	if (/^https?:\/\//i.test(raw)) return raw;
	return azReplayPlayUrl(id);
}

/* ------------------------------------------------------------------ */
/* Shows                                                               */
/* ------------------------------------------------------------------ */

export async function getShow(db: D1Database, id: string): Promise<ShowRow | null> {
	const row = (await db.prepare('SELECT * FROM show WHERE id = ?').bind(id).first()) as
		| ShowRow
		| null;
	return row ? sanitizeShowRow(row) : null;
}

export interface ShowWithDj extends ShowRow {
	dj_name: string | null;
	dj_image: string | null;
	/** Plain-text extract of page_content for social share descriptions. */
	pageContentText: string;
}

export async function getShowWithDj(db: D1Database, id: string): Promise<ShowWithDj | null> {
	const row = (await db
		.prepare(
			`SELECT s.*, COALESCE(NULLIF(s.dj_handle, ''), u.name) AS dj_name, u.image AS dj_image
			 FROM show s
			 LEFT JOIN user u ON u.id = s.dj_id
			 WHERE s.id = ?`
		)
		.bind(id)
		.first()) as ShowWithDj | null;
	const clean = row ? sanitizeShowRow(row) : null;
	return clean
		? { ...clean, pageContentText: descriptionToText(clean.page_content).slice(0, OG_DESC_MAX) }
		: null;
}

export async function getShowsForDj(db: D1Database, djId: string): Promise<ShowRow[]> {
	const { results } = await db
		.prepare(
			'SELECT * FROM show WHERE dj_id = ? AND active = 1 ORDER BY day_of_week, start_minutes'
		)
		.bind(djId)
		.all();
	return (results as unknown as ShowRow[]).map(sanitizeShowRow);
}

export async function getAllShows(db: D1Database): Promise<ShowRow[]> {
	const { results } = await db
		.prepare('SELECT * FROM show WHERE active = 1 ORDER BY day_of_week, start_minutes')
		.all();
	return (results as unknown as ShowRow[]).map((s) =>
		sanitizeShowRow({
			...s,
			cycleWeek: cycleWeekOf(s.anchor_date ?? nextDateForWeekday(s.day_of_week, todayStr()))
		})
	);
}

export interface ScheduleShow extends ShowRow {
	dj_name: string | null;
	dj_image: string | null;
	/** Station-cycle weeks the show airs on (1-4). Empty for weekly shows. */
	showCycleWeeks: number[];
}

export async function getSchedule(db: D1Database): Promise<ScheduleShow[]> {
	const { results } = await db
		.prepare(
			`SELECT s.*, COALESCE(NULLIF(s.dj_handle, ''), u.name) AS dj_name, u.image AS dj_image
			 FROM show s
			 LEFT JOIN user u ON u.id = s.dj_id
			 WHERE s.active = 1
			 ORDER BY s.day_of_week, s.start_minutes`
		)
		.all();
	return (results as unknown as ScheduleShow[]).map((s) => {
		const clean = sanitizeShowRow(s);
		const baseWeek = cycleWeekOf(
			clean.anchor_date ?? nextDateForWeekday(clean.day_of_week, todayStr())
		);
		const showCycleWeeks =
			clean.interval_weeks === 4
				? [baseWeek]
				: clean.interval_weeks === 2
					? [baseWeek, ((baseWeek + 1) % 4) + 1]
					: [];
		return { ...clean, showCycleWeeks };
	});
}

/** Loose name normalisation: lowercase, strip anything but a-z/0-9/spaces. */
export function normalizeText(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

/** Live-DJ identity block: the active show's display-facing fields. */
export interface LiveShowIdentity {
	id: string;
	title: string;
	dj_name: string | null;
	dj_handle: string | null;
	dj_image: string | null;
	image: string | null;
}

/**
 * Match a connected live streamer's source name to an active show, by show
 * title, DJ handle, or DJ display name. Exact normalised equality wins; a
 * containment match (min 4 chars, either direction) is the fallback. Returns
 * null when nothing plausibly matches (e.g. ad-hoc sources not on the roster).
 */
export function matchLiveShow(
	shows: ScheduleShow[],
	streamerName: string | null | undefined
): LiveShowIdentity | null {
	if (!streamerName) return null;
	const needle = normalizeText(streamerName);
	if (needle.length < 4) return null;

	const toIdentity = (s: ScheduleShow): LiveShowIdentity => ({
		id: s.id,
		title: s.title,
		dj_name: s.dj_name,
		dj_handle: s.dj_handle,
		dj_image: s.dj_image,
		image: s.image
	});

	for (const s of shows) {
		const exact = [s.title, s.dj_handle ?? '', s.dj_name ?? '']
			.map(normalizeText)
			.some((n) => n.length >= 4 && n === needle);
		if (exact) return toIdentity(s);
	}
	for (const s of shows) {
		const contains = [s.title, s.dj_handle ?? '', s.dj_name ?? '']
			.map(normalizeText)
			.some((n) => n.length >= 4 && (n.includes(needle) || needle.includes(n)));
		if (contains) return toIdentity(s);
	}
	return null;
}

/** Station-wide 4-week cycle anchor (Monday). */
export { CYCLE_ANCHOR, cycleWeekOf } from '$lib/cycle';

/**
 * The first date on/after `fromDate` whose weekday is `dayOfWeek` and whose
 * cycle week is `targetWeek` (1-4). Used to re-phase a show's anchor.
 */
export function nextCycleWeekDate(dayOfWeek: number, targetWeek: number, fromDate: string): string {
	let date = nextDateForWeekday(dayOfWeek, fromDate);
	for (let i = 0; i < 4 && cycleWeekOf(date) !== targetWeek; i++) {
		date = addDays(date, 7);
	}
	return date;
}

export interface UpcomingBroadcast extends BroadcastRow {
	title: string;
	dj_name: string | null;
	kind: string;
	event_type: string | null;
}

export interface AiringInfo extends UpcomingBroadcast {
	show_id: string;
	image: string | null;
	dj_image: string | null;
}

/** Broadcast airing right now (date + minutes given in station-local time). */
export async function getOnAirBroadcast(
	db: D1Database,
	date: string,
	minutes: number
): Promise<AiringInfo | null> {
	return db
		.prepare(
			`SELECT b.*, s.title, s.kind, s.event_type, s.image, COALESCE(NULLIF(s.dj_handle, ''), u.name) AS dj_name, u.image AS dj_image
			 FROM broadcast b
			 JOIN show s ON s.id = b.show_id
			 LEFT JOIN user u ON u.id = s.dj_id
			 WHERE b.date = ? AND b.start_minutes <= ? AND ? < b.start_minutes + b.duration_minutes
			   AND s.active = 1
			 LIMIT 1`
		)
		.bind(date, minutes, minutes)
		.first() as Promise<AiringInfo | null>;
}

/** The next upcoming broadcast on or after `minutes` on/after `date`. */
export async function getNextBroadcast(
	db: D1Database,
	date: string,
	minutes: number
): Promise<AiringInfo | null> {
	return db
		.prepare(
			`SELECT b.*, s.title, s.kind, s.event_type, COALESCE(NULLIF(s.dj_handle, ''), u.name) AS dj_name, u.image AS dj_image
			 FROM broadcast b
			 JOIN show s ON s.id = b.show_id
			 LEFT JOIN user u ON u.id = s.dj_id
			 WHERE s.active = 1
			   AND (b.date > ? OR (b.date = ? AND b.start_minutes > ?))
			 ORDER BY b.date, b.start_minutes
			 LIMIT 1`
		)
		.bind(date, date, minutes)
		.first() as Promise<AiringInfo | null>;
}

/** Current date (YYYY-MM-DD) and minutes-since-midnight in a given IANA timezone. */
export function zonedNow(timeZone = 'Pacific/Auckland'): { date: string; minutes: number } {
	const now = new Date();
	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	});
	const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
	return {
		date: `${parts.year}-${parts.month}-${parts.day}`,
		minutes: Number(parts.hour) * 60 + Number(parts.minute)
	};
}

/** Upcoming airings for all active shows within the next `days` days. */
export async function getUpcomingBroadcasts(
	db: D1Database,
	days = 30
): Promise<UpcomingBroadcast[]> {
	const from = todayStr();
	const to = addDays(from, days);
	const { results } = await db
		.prepare(
			`SELECT b.*, s.title, s.kind, s.event_type, COALESCE(NULLIF(s.dj_handle, ''), u.name) AS dj_name
			 FROM broadcast b
			 JOIN show s ON s.id = b.show_id
			 LEFT JOIN user u ON u.id = s.dj_id
			 WHERE b.date >= ? AND b.date <= ? AND s.active = 1
			 ORDER BY b.date, b.start_minutes`
		)
		.bind(from, to)
		.all();
	const now = zonedNow();
	return (results as unknown as UpcomingBroadcast[]).filter((b) => !broadcastEnded(now, b));
}

export interface OverlapInfo {
	id: string;
	title: string;
}

/**
 * Shows whose slot intersects the given one. Recurring slots match on
 * day_of_week; date-based slots (events/episodes) additionally match
 * broadcasts on that exact date. Touching boundaries do not overlap.
 */
export async function findOverlappingShows(
	db: D1Database,
	input: {
		date?: string;
		dayOfWeek?: number;
		startMinutes: number;
		durationMinutes: number;
		excludeShowId?: string;
	}
): Promise<OverlapInfo[]> {
	const end = input.startMinutes + input.durationMinutes;
	const overlaps: OverlapInfo[] = [];
	const seen = new Set<string>();

	if (input.date) {
		const { results } = await db
			.prepare(
				`SELECT DISTINCT s.id, s.title
				 FROM broadcast b
				 JOIN show s ON s.id = b.show_id
				 WHERE b.date = ?
				   AND b.start_minutes + b.duration_minutes > ? AND b.start_minutes < ?
				   AND (? IS NULL OR s.id != ?)
				 LIMIT 5`
			)
			.bind(input.date, input.startMinutes, end, input.excludeShowId ?? null, input.excludeShowId ?? '')
			.all();
		for (const r of results as unknown as OverlapInfo[]) {
			if (!seen.has(r.id)) {
				seen.add(r.id);
				overlaps.push(r);
			}
		}
	}

	if (typeof input.dayOfWeek === 'number') {
		// Same-weekday fallback only matters for the near-future window where
		// broadcast rows may not exist yet. Past (and far-future) dates rely
		// solely on the exact-date broadcast check — historical truth.
		const horizon = addDays(todayStr(), 84);
		const inWindow =
			!input.date || (input.date >= todayStr() && input.date <= horizon);
		if (inWindow) {
			const { results } = await db
				.prepare(
					`SELECT s.id, s.title
					 FROM show s
					 WHERE s.day_of_week = ? AND s.active = 1
					   AND s.start_minutes + s.duration_minutes > ? AND s.start_minutes < ?
					   AND (? IS NULL OR s.id != ?)
					 LIMIT 5`
				)
				.bind(input.dayOfWeek, input.startMinutes, end, input.excludeShowId ?? null, input.excludeShowId ?? '')
				.all();
			for (const r of results as unknown as OverlapInfo[]) {
				if (!seen.has(r.id)) {
					seen.add(r.id);
					overlaps.push(r);
				}
			}
		}
	}

	return overlaps;
}

/** URL-safe slug from a title (lowercase, spaces/others → hyphens). */
export function slugify(title: string): string {
	return (
		title
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'show'
	);
}

/** Unique slug id: base, then base-2, base-3, … until unused. */
async function uniqueShowId(db: D1Database, base: string): Promise<string> {
	if (!(await db.prepare('SELECT id FROM show WHERE id = ?').bind(base).first())) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base}-${n}`;
		if (!(await db.prepare('SELECT id FROM show WHERE id = ?').bind(candidate).first())) return candidate;
	}
}

export async function createShow(
	db: D1Database,
	input: {
		djId: string;
		title: string;
		description?: string;
		pageContent?: string;
		image?: string | null;
		dayOfWeek: number;
		startMinutes: number;
		durationMinutes: number;
		intervalWeeks?: number;
		anchorDate?: string;
		kind?: 'show' | 'event';
		eventType?: string | null;
		date?: string;
		replayUrl?: string;
	}
): Promise<ShowRow> {
	const t = now();
	const kind = input.kind === 'event' ? 'event' : 'show';
	const eventType = kind === 'event' && isEventType(input.eventType) ? input.eventType : null;
	const intervalWeeks = Math.max(1, Math.floor(input.intervalWeeks ?? 1) || 1);
	const anchorDate = input.anchorDate ?? input.date ?? nextDateForWeekday(input.dayOfWeek, todayStr());
	const image = input.image?.trim().slice(0, 500) || null;
	// Friendly slug id: shows slugify the title; events append the date so the
	// URL is stable and descriptive (matches the seeded show ids).
	const base = kind === 'event' ? `${slugify(input.title)}-${input.date ?? ''}` : slugify(input.title);
	const id = await uniqueShowId(db, base);
	await db
		.prepare(
			`INSERT INTO show (id, dj_id, title, description, page_content, image, day_of_week, start_minutes, duration_minutes, interval_weeks, anchor_date, kind, event_type, active, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
		)
		.bind(
			id,
			input.djId,
			input.title.trim(),
			descriptionToText(input.description ?? '').slice(0, SHOW_DESC_MAX),
			sanitizeDescription(input.pageContent ?? '').slice(0, DESCRIPTION_MAX),
			image,
			input.dayOfWeek,
			input.startMinutes,
			input.durationMinutes,
			intervalWeeks,
			anchorDate,
			kind,
			eventType,
			t,
			t
		)
		.run();
	const show = (await getShow(db, id)) as ShowRow;

	if (kind === 'event') {
		const replayRaw = input.replayUrl?.trim() ?? '';
		const replayUrl = replayRaw ? replayPlayUrl(replayRaw) : null;
		if (replayRaw && !replayUrl) {
			throw new Error('Paste a track id (24 hex chars) or an on-demand download link.');
		}
		await db
			.prepare(
				`INSERT INTO broadcast (id, show_id, date, start_minutes, duration_minutes, interval_weeks, replay_url, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				`${id}-${input.date!}`,
				id,
				input.date!,
				input.startMinutes,
				input.durationMinutes,
				intervalWeeks,
				replayUrl,
				t,
				t
			)
			.run();
		return show;
	}

	await ensureBroadcasts(db, show);
	return show;
}

/* ------------------------------------------------------------------ */
/* Tracklists (per broadcast)                                          */
/* ------------------------------------------------------------------ */

export async function getTrack(db: D1Database, id: string): Promise<TrackRow | null> {
	const row = (await db.prepare('SELECT * FROM track WHERE id = ?').bind(id).first()) as
		| TrackRow
		| null;
	return row ?? null;
}

/**
 * Persist a resolved Bandcamp stream (URL + expiry + art/cap), opportunistically
 * filling empty title/artist/duration from the resolved metadata (never
 * overwriting values the DJ typed).
 */
export async function setTrackStream(
	db: D1Database,
	id: string,
	stream: {
		streamUrl: string;
		expiresAt: number | null;
		format: string;
		artId: string | null;
		capped: boolean;
		title?: string | null;
		artist?: string | null;
		durationSeconds?: number | null;
		bandId?: number | null;
		tralbumId?: number | null;
	}
): Promise<void> {
	await db
		.prepare(
			`UPDATE track SET
			   stream_url = ?, stream_expires_at = ?, stream_format = ?, stream_art_id = ?, stream_capped = ?, updated_at = ?,
			   title = CASE WHEN title = '' THEN ? ELSE title END,
			   artist = CASE WHEN artist = '' THEN ? ELSE artist END,
			   duration_seconds = COALESCE(duration_seconds, ?),
			   bandcamp_band_id = COALESCE(?, bandcamp_band_id),
			   bandcamp_tralbum_id = COALESCE(?, bandcamp_tralbum_id)
			 WHERE id = ?`
		)
		.bind(
			stream.streamUrl,
			stream.expiresAt,
			stream.format,
			stream.artId,
			stream.capped ? 1 : 0,
			now(),
			stream.title ?? '',
			stream.artist ?? '',
			stream.durationSeconds ?? null,
			stream.bandId ?? null,
			stream.tralbumId ?? null,
			id
		)
		.run();
}

export async function getTracklist(db: D1Database, broadcastId: string): Promise<TrackRow[]> {
	const { results } = await db
		.prepare('SELECT * FROM track WHERE broadcast_id = ? ORDER BY position')
		.bind(broadcastId)
		.all();
	return results as unknown as TrackRow[];
}

/** Tracklists for many broadcasts at once: { [broadcastId]: TrackRow[] }. */
export async function getBroadcastTracksMap(
	db: D1Database,
	broadcastIds: string[]
): Promise<Record<string, TrackRow[]>> {
	const result: Record<string, TrackRow[]> = {};
	if (broadcastIds.length === 0) return result;
	const { results } = await db
		.prepare(
			`SELECT * FROM track WHERE broadcast_id IN (${broadcastIds.map(() => '?').join(',')})
			 ORDER BY broadcast_id, position`
		)
		.bind(...broadcastIds)
		.all();
	for (const row of results as unknown as TrackRow[]) {
		(result[row.broadcast_id ?? ''] ??= []).push(row);
	}
	return result;
}

/** Atomically replaces a broadcast's tracklist (delete + insert in one D1 batch). */
export async function replaceTracklist(
	db: D1Database,
	broadcastId: string,
	tracks: TrackInput[]
): Promise<TrackRow[]> {
	const t = now();
	const broadcast = await getBroadcast(db, broadcastId);
	const stmts = [
		db.prepare('DELETE FROM track WHERE broadcast_id = ?').bind(broadcastId),
		...tracks.map((track, i) =>
			db
				.prepare(
					`INSERT INTO track (id, show_id, broadcast_id, position, title, artist, album, url, embed_id, album_id, duration_seconds, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
				)
				.bind(
					crypto.randomUUID(),
					broadcast!.show_id,
					broadcastId,
					i,
					track.title.trim().slice(0, 300),
					track.artist?.trim().slice(0, 200) ?? '',
					track.album?.trim().slice(0, 200) ?? '',
					track.url?.trim().slice(0, 500) ?? null,
					track.embedId ?? null,
					track.albumId ?? null,
					t,
					t
				)
		)
	];
	await db.batch(stmts);
	return getTracklist(db, broadcastId);
}
