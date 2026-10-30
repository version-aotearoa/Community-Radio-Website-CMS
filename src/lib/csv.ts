import { parseTrackTime } from '$lib/trackTime';

export interface CsvTrack {
	title: string;
	artist: string;
	album: string;
	url?: string;
	/** Cue marker in the episode recording, in seconds (blank = no marker). */
	markSeconds?: number | null;
}

export interface TrackCsvResult {
	tracks: CsvTrack[];
	header: boolean;
	/** Non-empty time cells that couldn't be read (they're imported blank). */
	skippedMarks: number;
}

const HEADER_ALIASES = {
	title: ['title', 'track', 'track title', 'name', 'song'],
	artist: ['artist', 'performer', 'band', 'act'],
	album: ['album', 'record', 'lp', 'release'],
	url: ['url', 'link', 'track url', 'bandcamp url', 'bandcamp'],
	mark: ['time', 'timestamp', 'mark', 'marker', 'cue', 'start', 'start time']
} as const;

const URL_RE = /^https?:\/\/\S+$/i;
/** Clock-shaped cell (`12:34`, `1:02:03`) — used to spot a time column without a header. */
const CLOCK_RE = /^\d{1,3}(?::\d{1,2}){1,2}$/;

function normalizeCell(s: string): string {
	return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Split one record into fields honoring quoted cells ("a,b", ""escapes""). */
function splitRecord(line: string, delimiter: string): string[] {
	const fields: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];
		if (quoted) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					field += '"';
					i += 1;
				} else {
					quoted = false;
				}
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			quoted = true;
		} else if (ch === delimiter) {
			fields.push(field);
			field = '';
		} else {
			field += ch;
		}
	}
	fields.push(field);
	return fields;
}

/** Parse a CSV/TSV file into records, handling quoted fields and multiline cells. */
function parseRecords(text: string, delimiter: string): string[][] {
	const records: string[][] = [];
	let record: string[] = [];
	let field = '';
	let quoted = false;

	const endField = () => {
		record.push(field);
		field = '';
	};
	const endRecord = () => {
		endField();
		if (record.some((c) => c.trim() !== '')) records.push(record);
		record = [];
	};

	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 1;
				} else {
					quoted = false;
				}
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			quoted = true;
		} else if (ch === delimiter) {
			endField();
		} else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && text[i + 1] === '\n') i += 1;
			endRecord();
		} else {
			field += ch;
		}
	}
	endRecord();
	return records;
}

function detectHeader(record: string[]): boolean {
	const cells = record.map(normalizeCell).filter((c) => c !== '');
	return cells.some((c) =>
		(
			[
				...HEADER_ALIASES.title,
				...HEADER_ALIASES.artist,
				...HEADER_ALIASES.album,
				...HEADER_ALIASES.url,
				...HEADER_ALIASES.mark
			] as string[]
		).includes(c)
	);
}

function mapColumn(record: string[], alias: readonly string[]): number | null {
	for (let i = 0; i < record.length; i += 1) {
		if (alias.includes(normalizeCell(record[i]))) return i;
	}
	return null;
}

/** Link column: exact alias match first, then any header cell containing url/link/bandcamp. */
function mapUrlColumn(record: string[]): number | null {
	const exact = mapColumn(record, HEADER_ALIASES.url);
	if (exact !== null) return exact;
	for (let i = 0; i < record.length; i += 1) {
		const cell = normalizeCell(record[i]);
		if (['url', 'link', 'bandcamp'].some((word) => cell.includes(word))) return i;
	}
	return null;
}

/**
 * Parse a CSV/TSV tracklist export into { title, artist, album, url?, markSeconds? }
 * rows. Header row optional; when absent, columns are read positionally. A
 * URL-shaped column (e.g. Bandcamp links) and a clock-shaped time column are
 * detected anywhere; link-only imports (a single URL column) are valid — titles
 * are derived at save time.
 */
export function parseTracksCsv(
	text: string,
	delimiter: ',' | '\t' = text.includes('\t') && !text.includes(',') ? '\t' : ','
): TrackCsvResult {
	const records = parseRecords(text, delimiter);
	if (records.length === 0) return { tracks: [], header: false, skippedMarks: 0 };

	const header = detectHeader(records[0]);
	let start = 0;
	let titleIdx: number | null = 0;
	let artistIdx: number | null = 1;
	let albumIdx: number | null = 2;
	let urlIdx: number | null = null;
	let markIdx: number | null = null;
	if (header) {
		start = 1;
		titleIdx = mapColumn(records[0], HEADER_ALIASES.title);
		artistIdx = mapColumn(records[0], HEADER_ALIASES.artist);
		albumIdx = mapColumn(records[0], HEADER_ALIASES.album);
		urlIdx = mapUrlColumn(records[0]);
		markIdx = mapColumn(records[0], HEADER_ALIASES.mark);
	} else {
		// No header: any URL-shaped cell becomes the link column and a
		// clock-shaped cell the time column; the rest fill title, artist, album
		// positionally. Link-only columns are supported (title stays empty,
		// derived at save time).
		const isUrl = (cell: string | undefined) => URL_RE.test((cell ?? '').trim());
		const isClock = (cell: string | undefined) => CLOCK_RE.test((cell ?? '').trim());
		const cells = records[0] ?? [];
		urlIdx = cells.findIndex((c) => isUrl(c));
		const clockAt = cells.findIndex((c) => isClock(c));
		markIdx = clockAt >= 0 && clockAt !== urlIdx ? clockAt : null;
		const rest = cells
			.map((_, i) => i)
			.filter((i) => i !== urlIdx && i !== markIdx);
		titleIdx = rest[0] ?? null;
		artistIdx = rest[1] ?? null;
		albumIdx = rest[2] ?? null;
	}

	const tracks: CsvTrack[] = [];
	let skippedMarks = 0;
	for (const record of records.slice(start)) {
		const url = (urlIdx !== null ? (record[urlIdx] ?? '') : '').trim();
		const title = (titleIdx !== null ? (record[titleIdx] ?? '') : '').trim();
		if (title === '' && url === '') continue;
		const markRaw = (markIdx !== null ? (record[markIdx] ?? '') : '').trim();
		const parsedMark = parseTrackTime(markRaw);
		if (markRaw !== '' && !parsedMark.ok) skippedMarks += 1;
		tracks.push({
			title: title.slice(0, 300),
			artist: (artistIdx !== null ? (record[artistIdx] ?? '') : '').trim().slice(0, 200),
			album: (albumIdx !== null ? (record[albumIdx] ?? '') : '').trim().slice(0, 200),
			...(url ? { url: url.slice(0, 500) } : {}),
			...(parsedMark.ok && parsedMark.seconds !== null ? { markSeconds: parsedMark.seconds } : {})
		});
	}
	return { tracks, header, skippedMarks };
}
