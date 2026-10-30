/**
 * Tracklist cue markers: a row's position inside the episode recording
 * (`track.mark_seconds`). DJs type `m:ss` / `h:mm:ss` (bare seconds also work);
 * the column is stored as an integer so the player can seek to it directly.
 */

/** A mark beyond 24h is a typo, not a recording position. */
export const MARK_MAX_SECONDS = 24 * 60 * 60;

export type ParsedTrackTime =
	| { ok: true; seconds: number | null }
	| { ok: false; seconds: null };

/** `m:ss`, or `h:mm:ss` from an hour up. Matches the player's clock format. */
export function formatTrackTime(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '';
	const whole = Math.max(0, Math.floor(seconds));
	const h = Math.floor(whole / 3600);
	const m = Math.floor((whole % 3600) / 60);
	const s = whole % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Parse a typed mark. Blank is valid and means "no marker"; anything we can't
 * read returns `ok: false` so callers can refuse the edit instead of silently
 * dropping the timestamp.
 */
export function parseTrackTime(input: string | null | undefined): ParsedTrackTime {
	const text = (input ?? '').trim();
	if (text === '') return { ok: true, seconds: null };

	let seconds: number | null = null;

	if (/^\d+$/.test(text)) {
		seconds = Number(text);
	} else {
		const parts = text.split(':');
		const numeric = parts.every((p) => /^\d{1,3}$/.test(p));
		if ((parts.length === 2 || parts.length === 3) && numeric) {
			const nums = parts.map(Number);
			const [h, m, s] = parts.length === 3 ? nums : [0, nums[0], nums[1]];
			// Seconds must be a valid clock second; minutes too when hours are given
			// (a two-part value is just M:SS, so minutes may exceed 59 there).
			const secondsValid = s < 60;
			const minutesValid = parts.length === 3 ? m < 60 : true;
			if (secondsValid && minutesValid) seconds = h * 3600 + m * 60 + s;
		}
	}

	if (seconds === null || !Number.isInteger(seconds) || seconds < 0 || seconds > MARK_MAX_SECONDS) {
		return { ok: false, seconds: null };
	}
	return { ok: true, seconds };
}

/** Whether `seconds` is a storable mark (used by the API as a safety net). */
export function isValidMark(seconds: unknown): seconds is number {
	return (
		typeof seconds === 'number' &&
		Number.isInteger(seconds) &&
		seconds >= 0 &&
		seconds <= MARK_MAX_SECONDS
	);
}
