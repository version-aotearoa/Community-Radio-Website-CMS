import { get, writable } from 'svelte/store';

const AUTOPLAY_KEY = 'vr-autoplay';

// Autoplay is DISABLED until full PWA features are ready (2026-09-02): the
// switch is hidden from the player and the stored opt-in is ignored, so the
// stream never auto-starts on load. Flip to true (and restore the switch in
// StreamPlayer) when re-enabling.
const AUTOPLAY_ENABLED = false;

function readAutoplay(): boolean {
	if (!AUTOPLAY_ENABLED) return false;
	if (typeof localStorage === 'undefined') return false;
	return localStorage.getItem(AUTOPLAY_KEY) === 'on';
}

/** Whether the stream player should start playing automatically on page load. */
export const autoplay = writable<boolean>(readAutoplay());

autoplay.subscribe((value) => {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(AUTOPLAY_KEY, value ? 'on' : 'off');
});

interface PlayerRequest {
	n: number;
}

export interface MediaSource {
	url: string;
	title: string;
	artist: string | null;
	art: string | null;
	/** Originating show, when playing an archive episode (used for player links). */
	show?: { id: string; title: string } | null;
	/** Direct URL to the episode page (for sharing from the player). */
	href?: string | null;
	/** Broadcast id of the archive episode being played. */
	broadcastId?: string | null;
	/** Air date (YYYY-MM-DD) of the archive episode being played. */
	date?: string | null;
	/** Originating tracklist row (used to reflect play state on the row). */
	trackId?: string | null;
	/** Cue marker: seconds into the recording to start at. */
	startAt?: number | null;
}

export type PlaybackSource = { kind: 'live' } | ({ kind: 'media' } & MediaSource);

export const playerRequest = writable<PlayerRequest>({ n: 0 });

/** Explicit play/pause intent: ensure the player is playing (true) or paused (false). */
export const playerSet = writable<{ n: number; play: boolean }>({ n: 0, play: false });

/** Minimise-the-player signal (e.g. clicking the home logo while on /). */
export const playerCollapse = writable<PlayerRequest>({ n: 0 });

/** Whether audio is currently playing (live or recording). */
export const streamPlaying = writable(false);

/** Ask the player to ensure a given state (idempotent — safe against duplicates). */
export function requestSetPlaying(play: boolean) {
	playerSet.update((p) => ({ n: p.n + 1, play }));
}

/** One-shot seek request for the recording already loaded in the player. */
export const playerSeek = writable<{ n: number; seconds: number }>({ n: 0, seconds: 0 });

/**
 * Ask the player to jump to `seconds` in the current recording. Used by
 * tracklist cue markers so clicking a time seeks in place instead of reloading.
 */
export function requestSeek(seconds: number) {
	const target = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
	playerSeek.update((p) => ({ n: p.n + 1, seconds: target }));
}

/**
 * Live position of the recording in the player. Fed on `timeupdate`, so the
 * tracklist editor can stamp a cue marker at the current playback point.
 * `url` is null while the live stream is playing.
 */
export const playerPosition = writable<{ url: string | null; seconds: number; duration: number }>({
	url: null,
	seconds: 0,
	duration: 0
});

/** Ask the global stream player to collapse/minimise its max sheet. */
export function requestCollapsePlayer() {
	playerCollapse.update((p) => ({ n: p.n + 1 }));
}

/** What the global stream player is currently playing (live or a recording). */
export const playback = writable<PlaybackSource>({ kind: 'live' });

/** Ask the global stream player to return to the live stream and play. */
export function requestPlay() {
	// Leaving the tracklist for live audio ends the queue.
	clearPlayQueue();
	if (get(playback).kind !== 'live') {
		// media → live: the playback effect switches engines and starts audio.
		playback.set({ kind: 'live' });
	} else {
		// already live but paused: resume only (no kind change, no double play).
		playerRequest.update((p) => ({ n: p.n + 1 }));
	}
}

/** Ask the global stream player to play a recording (replay). */
export function playMedia(source: MediaSource) {
	playback.set({ kind: 'media', ...source });
}

/* ------------------------------------------------------------------ */
/* Play queue (Bandcamp tracklists) — persists across navigation so    */
/* tracks keep advancing while the global player owns playback.        */
/* ------------------------------------------------------------------ */

export interface QueueItem {
	trackId: string;
	title: string;
	artist: string | null;
	art: string | null;
}

interface ResolvedQueueItem {
	streamUrl: string;
	title: string | null;
	artist: string | null;
	art: string | null;
}

/** The ordered, playable tracks of the tracklist currently being played. */
export const playQueue = writable<QueueItem[]>([]);
export const queueIndex = writable<number>(-1);

/** Resolved stream URLs, kept for the session so transitions are instant. */
const resolvedQueue = new Map<string, ResolvedQueueItem>();

async function resolveQueueItem(item: QueueItem): Promise<ResolvedQueueItem | null> {
	const cached = resolvedQueue.get(item.trackId);
	if (cached) return cached;
	try {
		const res = await fetch(`/api/tracks/${item.trackId}/stream`);
		if (!res.ok) return null;
		const body = (await res.json()) as {
			streamUrl?: string;
			title?: string | null;
			artist?: string | null;
			art?: string | null;
		};
		if (!body.streamUrl) return null;
		const resolved: ResolvedQueueItem = {
			streamUrl: body.streamUrl,
			title: body.title ?? null,
			artist: body.artist ?? null,
			art: body.art ?? null
		};
		resolvedQueue.set(item.trackId, resolved);
		return resolved;
	} catch {
		return null;
	}
}

/** Pre-resolve the next queue item so advancing is gapless-ish. */
export function prefetchQueueNext() {
	const items = get(playQueue);
	const next = items[get(queueIndex) + 1];
	if (next) void resolveQueueItem(next);
}

/** Begin (or replace) the queue and prefetch its first transition. */
export function startPlayQueue(items: QueueItem[], startTrackId: string | null) {
	playQueue.set(items);
	queueIndex.set(startTrackId ? items.findIndex((i) => i.trackId === startTrackId) : -1);
	prefetchQueueNext();
}

export function clearPlayQueue() {
	playQueue.set([]);
	queueIndex.set(-1);
}

/** Play the queue item at `index`; skip items that can't be resolved. */
export async function playQueueAt(index: number): Promise<void> {
	const items = get(playQueue);
	const item = items[index];
	if (!item) return;
	const resolved = await resolveQueueItem(item);
	if (!resolved) {
		if (index + 1 < items.length) return playQueueAt(index + 1);
		clearPlayQueue();
		requestPlay();
		return;
	}
	queueIndex.set(index);
	playMedia({
		url: resolved.streamUrl,
		title: resolved.title || item.title || 'Bandcamp',
		artist: resolved.artist || item.artist || null,
		art: resolved.art || item.art || null,
		trackId: item.trackId
	});
	prefetchQueueNext();
}

/**
 * Advance to the next queue item. With `fromTrackId`, only advances when that
 * track is part of the queue (so a replay ending doesn't move the tracklist).
 * At the end of the queue it returns to the live stream.
 */
export async function advancePlayQueue(fromTrackId?: string | null): Promise<void> {
	const items = get(playQueue);
	if (items.length === 0) return;
	let index = get(queueIndex);
	if (fromTrackId) {
		const ended = items.findIndex((i) => i.trackId === fromTrackId);
		if (ended < 0) return;
		index = ended;
	}
	if (index + 1 >= items.length) {
		clearPlayQueue();
		requestPlay();
		return;
	}
	return playQueueAt(index + 1);
}

/** Go to the previous queue item, if there is one. */
export async function previousPlayQueue(): Promise<void> {
	const index = get(queueIndex);
	if (get(playQueue).length === 0 || index <= 0) return;
	return playQueueAt(index - 1);
}
