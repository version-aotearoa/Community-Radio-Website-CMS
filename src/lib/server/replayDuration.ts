import { AZURACAST_BASE, extractReplayTrackId } from '$lib/azuracast';

/**
 * Exact duration for an AzuraCast replay, parsed from its container.
 *
 * The browser's `<audio preload="metadata">` probe works but is slow on large
 * recordings (a 215 MB m4a can take seconds), and until it resolves the episode
 * waveform has no total and ignores clicks. The waveform peaks endpoint also
 * reports a duration, but only for files its generator can decode — AAC is not
 * one of them.
 *
 * Reading the first 256 KB and parsing `mvhd` (m4a) / `TLEN` (mp3) gives the
 * same answer in one range request, and works for every container.
 */

const RANGE_BYTES = 262_144;
const CACHE_SECONDS = 60 * 60 * 24;
const FETCH_TIMEOUT_MS = 2_500;

interface EdgeCache {
	match(key: string): Promise<{ json(): Promise<unknown> } | undefined>;
	put(key: string, response: unknown): Promise<void>;
}

/** Walk the MP4 atom tree in the fetched slice and return the mvhd duration. */
function mp4Duration(bytes: DataView): number | null {
	// moov may be nested after a leading ftyp/free; walk top-level boxes.
	let offset = 0;
	const length = bytes.byteLength;
	while (offset + 8 <= length) {
		const size = bytes.getUint32(offset);
		const type = String.fromCharCode(
			bytes.getUint8(offset + 4),
			bytes.getUint8(offset + 5),
			bytes.getUint8(offset + 6),
			bytes.getUint8(offset + 7)
		);
		if (size < 8) break;
		if (type === 'moov') {
			let inner = offset + 8;
			// `moov` is often larger than the fetched slice (sample tables), but
			// `mvhd` is its first child — so bound the walk to what we have.
			const end = Math.min(offset + size, length);
			while (inner + 8 <= end) {
				const innerSize = bytes.getUint32(inner);
				const innerType = String.fromCharCode(
					bytes.getUint8(inner + 4),
					bytes.getUint8(inner + 5),
					bytes.getUint8(inner + 6),
					bytes.getUint8(inner + 7)
				);
				if (innerSize < 8 || inner + innerSize > end) break;
				if (innerType === 'mvhd') {
					const version = bytes.getUint8(inner + 8);
					const base = inner + 12; // skip version + flags
					if (version === 1) {
						const timescale = bytes.getUint32(base + 16);
						const high = bytes.getUint32(base + 20);
						const low = bytes.getUint32(base + 24);
						const duration = high * 2 ** 32 + low;
						return timescale > 0 ? duration / timescale : null;
					}
					const timescale = bytes.getUint32(base + 8);
					const duration = bytes.getUint32(base + 12);
					return timescale > 0 ? duration / timescale : null;
				}
				inner += innerSize;
			}
			return null;
		}
		offset += size;
	}
	return null;
}

/** ID3v2 TLEN (ms) or a CBR estimate from the first MPEG frame. */
function mp3Duration(bytes: DataView, totalBytes: number | null): number | null {
	let offset = 0;
	const length = bytes.byteLength;

	if (
		length > 10 &&
		bytes.getUint8(0) === 0x49 && // I
		bytes.getUint8(1) === 0x44 && // D
		bytes.getUint8(2) === 0x33 // 3
	) {
		const tagSize =
			((bytes.getUint8(6) & 0x7f) << 21) |
			((bytes.getUint8(7) & 0x7f) << 14) |
			((bytes.getUint8(8) & 0x7f) << 7) |
			(bytes.getUint8(9) & 0x7f);
		const frameStart = 10 + (bytes.getUint8(5) & 0x10 ? 10 : 0);
		let frame = frameStart;
		const tagEnd = Math.min(length, 10 + tagSize);
		while (frame + 10 <= tagEnd) {
			const id = String.fromCharCode(
				bytes.getUint8(frame),
				bytes.getUint8(frame + 1),
				bytes.getUint8(frame + 2),
				bytes.getUint8(frame + 3)
			);
			// v2.3 frames are big-endian; v2.4 uses syncsafe ints, which only
			// differ above 127 bytes — TLEN is always far shorter than that.
			const size =
				(bytes.getUint8(frame + 4) << 24) |
				(bytes.getUint8(frame + 5) << 16) |
				(bytes.getUint8(frame + 6) << 8) |
				bytes.getUint8(frame + 7);
			if (size <= 0 || frame + 10 + size > tagEnd) break;
			if (id === 'TLEN') {
				let text = '';
				for (let i = 0; i < size; i++) {
					const code = bytes.getUint8(frame + 10 + i);
					if (code === 0) break;
					text += String.fromCharCode(code);
				}
				const ms = Number(text.trim());
				if (Number.isFinite(ms) && ms > 0) return ms / 1000;
			}
			frame += 10 + size;
		}
		offset = 10 + tagSize;
	}

	// No TLEN: estimate from the first MPEG frame's bitrate (CBR assumption).
	for (let i = offset; i + 4 <= length; i++) {
		if (bytes.getUint8(i) !== 0xff || (bytes.getUint8(i + 1) & 0xe0) !== 0xe0) continue;
		const bitrateIndex = (bytes.getUint8(i + 2) & 0xf0) >> 4;
		const bitrates = [
			0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0
		];
		const kbps = bitrates[bitrateIndex] ?? 0;
		if (!kbps || !totalBytes) return null;
		return (totalBytes * 8) / (kbps * 1000);
	}
	return null;
}

/** Read the four ASCII bytes at `offset` (empty when they run past the slice). */
function magicAt(bytes: DataView, offset: number, length: number): string {
	if (offset + length > bytes.byteLength) return '';
	let out = '';
	for (let i = 0; i < length; i++) out += String.fromCharCode(bytes.getUint8(offset + i));
	return out;
}

/**
 * FLAC's STREAMINFO holds an exact sample count. AzuraCast happily serves FLAC
 * uploads, and a lossless file has no MPEG sync words — the old fallback used to
 * pick a false one and report a wildly wrong length (1.79× on a real episode).
 */
function flacDuration(bytes: DataView): number | null {
	if (magicAt(bytes, 0, 4) !== 'fLaC') return null;
	let offset = 4;
	// Metadata blocks: 1 byte (last<<7 | type) + 3-byte big-endian length.
	while (offset + 4 <= bytes.byteLength) {
		const header = bytes.getUint8(offset);
		const type = header & 0x7f;
		const length = (bytes.getUint8(offset + 1) << 16) | (bytes.getUint8(offset + 2) << 8) | bytes.getUint8(offset + 3);
		const body = offset + 4;
		if (body + length > bytes.byteLength) return null;
		if (type === 0) {
			if (length < 18) return null;
			// 20 bits sample rate, 3 bits channels, 5 bits depth, 36 bits samples.
			const sampleRate = (bytes.getUint8(body + 10) << 12) | (bytes.getUint8(body + 11) << 4) | (bytes.getUint8(body + 12) >> 4);
			const totalSamples =
				(bytes.getUint8(body + 13) & 0x0f) * 2 ** 32 +
				((bytes.getUint8(body + 14) << 24) | (bytes.getUint8(body + 15) << 16) | (bytes.getUint8(body + 16) << 8) | bytes.getUint8(body + 17));
			if (sampleRate <= 0 || totalSamples <= 0) return null;
			return totalSamples / sampleRate;
		}
		if ((header & 0x80) !== 0) return null;
		offset = body + length;
	}
	return null;
}

/** True when the slice starts with (or soon contains) a plausible MPEG frame sync. */
function looksLikeMpeg(bytes: DataView): boolean {
	const limit = Math.min(bytes.byteLength - 4, 2048);
	for (let i = 0; i < limit; i++) {
		if (bytes.getUint8(i) !== 0xff) continue;
		if ((bytes.getUint8(i + 1) & 0xe0) !== 0xe0) continue;
		const bitrateIndex = (bytes.getUint8(i + 2) & 0xf0) >> 4;
		const sampleRateIndex = (bytes.getUint8(i + 2) & 0x0c) >> 2;
		if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) continue;
		return true;
	}
	return false;
}

/**
 * Exact duration where the container carries one (MP4 `mvhd`, FLAC STREAMINFO,
 * MP3 `TLEN`), and null when it doesn't — a guess is worse than letting the
 * browser's metadata probe answer.
 */
function durationForContainer(bytes: DataView, totalBytes: number | null): number | null {
	const magic4 = magicAt(bytes, 0, 4);

	if (magicAt(bytes, 4, 4) === 'ftyp') return mp4Duration(bytes);
	if (magic4 === 'fLaC') return flacDuration(bytes);
	// Ogg (Vorbis/Opus) keeps its length in the final page; estimating from
	// bitrate would be a guess, so let the browser probe it.
	if (magic4 === 'OggS') return null;
	if (magicAt(bytes, 0, 3) === 'ID3' || looksLikeMpeg(bytes)) return mp3Duration(bytes, totalBytes);
	return null;
}

/** Duration in seconds for a replay URL, or null when it can't be determined. */
export async function getReplayDuration(
	platform: App.Platform | undefined,
	replayUrl: string | null | undefined
): Promise<number | null> {
	const raw = replayUrl?.trim();
	if (!raw) return null;

	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.origin !== new URL(AZURACAST_BASE).origin) return null;

	const trackId = extractReplayTrackId(parsed.href);
	if (!trackId) return null;

	const cache = platform?.caches?.default as unknown as EdgeCache | undefined;
	const cacheKey = `https://vr-replay-duration.internal/v3/${trackId}`;
	if (cache) {
		const hit = await cache.match(cacheKey);
		if (hit) {
			const cached = (await hit.json().catch(() => null)) as { duration?: unknown } | null;
			const value = Number(cached?.duration);
			if (Number.isFinite(value) && value > 0) return value;
			if (cached && cached.duration === null) return null;
		}
	}

	try {
		const res = await fetch(parsed.href, {
			headers: { range: `bytes=0-${RANGE_BYTES - 1}` },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
		if (!res.ok) return null;

		const buffer = await res.arrayBuffer();
		if (buffer.byteLength < 16) return null;
		const view = new DataView(buffer);

		const contentRange = res.headers.get('content-range') ?? '';
		const totalMatch = contentRange.match(/\/(\d+)$/);
		const totalBytes = totalMatch ? Number(totalMatch[1]) : null;

		const duration = durationForContainer(view, totalBytes);

		const clean =
			duration && Number.isFinite(duration) && duration > 0 ? Math.round(duration * 10) / 10 : null;

		if (cache) {
			await cache.put(
				cacheKey,
				// A miss is retried soon: a deploy can fix the parser, and a null
				// must not pin the waveform to its slow fallback for a day.
				Response.json(
					{ duration: clean },
					{ headers: { 'cache-control': `public, max-age=${clean ? CACHE_SECONDS : 600}` } }
				)
			);
		}
		return clean;
	} catch {
		return null;
	}
}
