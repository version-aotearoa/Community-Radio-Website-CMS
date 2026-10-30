<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import { page } from '$app/state';

	import {
		autoplay,
		playback,
		advancePlayQueue,
		playerCollapse,
		playerPosition,
		playerRequest,
		playerSeek,
		playerSet,
		previousPlayQueue,
		requestPlay,
		streamPlaying
	} from '$lib/stores/player';
	import { live, startLivePolling } from '$lib/stores/live';
	import { liveArtOf } from '$lib/api/live';
	import { AZURACAST_BASE, AZURACAST_STATION_SHORTCODE } from '$lib/azuracast';
	import SeekControl from '$lib/components/SeekControl.svelte';

	const STREAM_URL = `${AZURACAST_BASE}/hls/${AZURACAST_STATION_SHORTCODE}/live.m3u8`;

	let audioEl: HTMLAudioElement | undefined = $state();
	let hls: import('hls.js').default | null = null;
	let HlsCtor: typeof import('hls.js').default | null = null;
	let nativeHls = $state(false);
	let playing = $derived($streamPlaying);
	let loading = $state(false);
	let expanded = $state(false);
	let dragging = $state(false);
	let dragY = $state(0);
	let dragStartY = 0;
	let dragStartedAt = 0;
	let currentTime = $state(0);
	let duration = $state(NaN);
	/** Cue marker waiting for the recording's metadata before it can be applied. */
	let pendingSeek: number | null = null;

	// TEMPORARY loading-trace debug ring (Safari phantom-stall investigation).
	// Exposed as window.__vrPlayerDebug; strip once the culprit is confirmed.
	const VR_DEBUG: {
		events: string[];
		snapshot: () => Record<string, unknown>;
	} = {
		events: [],
		snapshot() {
			return {
				paused: audioEl?.paused ?? null,
				readyState: audioEl?.readyState ?? null,
				networkState: audioEl?.networkState ?? null,
				currentTime: audioEl?.currentTime ?? null,
				duration: audioEl?.duration ?? null,
				src: audioEl?.currentSrc ?? null,
				loading,
				streamPlaying: $streamPlaying,
				mediaMode,
				events: [...VR_DEBUG.events]
			};
		}
	};

	function setLoading(v: boolean, reason: string) {
		if (loading === v) return;
		loading = v;
		const line = `${new Date().toLocaleTimeString('en-NZ', { hour12: false })} loading→${v} (${reason}) paused=${audioEl?.paused} ready=${audioEl?.readyState} net=${audioEl?.networkState} t=${(audioEl?.currentTime ?? 0).toFixed(1)}`;
		VR_DEBUG.events.push(line);
		if (VR_DEBUG.events.length > 200) VR_DEBUG.events.splice(0, VR_DEBUG.events.length - 200);
		console.info(`[vr] ${line}`);
	}

	const livePayload = $derived($live);
	const media = $derived($playback.kind === 'media' ? $playback : null);
	const mediaMode = $derived(media !== null);

	const isLive = $derived(!mediaMode && livePayload?.live.isLive === true);

	// Live shows prefer our own artwork (curated show image, then DJ avatar) over
	// the encoder's now-playing art, which goes stale while a DJ is connected.
	const artSource = $derived(media?.art ?? liveArtOf(livePayload, isLive));

	/** Set when the chosen art URL fails to load, so we drop to the eq-bars. */
	let artFailed = $state(false);
	$effect(() => {
		artSource;
		artFailed = false;
	});
	function onArtError() {
		artFailed = true;
	}
	/** Authoritative live identity from our DB: scheduled slot first, else a streamer-matched show. */
	const identity = $derived(isLive ? (livePayload?.onAir ?? livePayload?.liveShow ?? null) : null);
	/** Show context link: the live identity while a DJ is live, else text-matched/on-air for re-airs. */
	const showLink = $derived(
		isLive ? identity : (livePayload?.trackShow ?? livePayload?.onAir ?? null)
	);

	const stationSticker = $derived(mediaMode ? 'Archive' : isLive ? 'Live now' : 'Replay');

	// A re-air's encoder metadata usually repeats the show name, so the title
	// line above the "On air: <show>" link would duplicate it — drop it then.
	const onAirLine = $derived(!mediaMode && !isLive && !!showLink);

	// ---- iOS lock-screen / notification metadata (Media Session, metadata-only) ----
	// No seek actions and no setPositionState: live has no finite timeline and
	// the HANDOVER cautions to re-verify background audio after any re-enable.
	const hasMediaSession =
		typeof navigator !== 'undefined' && 'mediaSession' in navigator && typeof MediaMetadata !== 'undefined';

	$effect(() => {
		if (!hasMediaSession) return;
		const state: MediaSessionPlaybackState = $streamPlaying ? 'playing' : 'paused';
		if (navigator.mediaSession.playbackState !== state) navigator.mediaSession.playbackState = state;
	});

	$effect(() => {
		if (!hasMediaSession) return;
		$playback;
		$live;
		artSource;
		let title = 'Version Radio';
		let artist = '';
		if (media) {
			title = media.title;
			artist = media.artist ?? '';
		} else if (isLive) {
			// Live: never let stale encoder metadata reach the lock screen.
			if (identity) {
				title = identity.title;
				artist = identity.djName ?? livePayload?.live.streamerName ?? '';
			} else {
				title = livePayload?.live.streamerName || 'Version Radio';
			}
		} else if (livePayload?.onAir?.title) {
			title = livePayload.onAir.title;
			artist = livePayload.onAir.djName ?? livePayload.live.streamerName ?? '';
		} else if (livePayload?.nowPlaying?.title) {
			title = livePayload.nowPlaying.title;
			artist = livePayload.nowPlaying.artist ?? '';
		}
		const artwork = artSource ? [{ src: artSource, sizes: '512x512' }] : [];
		try {
			navigator.mediaSession.metadata = new MediaMetadata({
				title,
				artist: artist || 'Version Radio',
				album: 'Version Radio',
				artwork
			});
		} catch {
			// metadata is best-effort
		}
	});

	$effect(() => {
		// React to a requestPlay() signal from anywhere in the app (skip the passive n=0 mount run).
		if ($playerRequest.n === 0) return;
		togglePlay();
	});

	$effect(() => {
		// React to an explicit requestSetPlaying() intent: ensure the element is
		// playing or paused. Idempotent, so duplicate/stray signals are no-ops
		// (the old blind toggle could flip straight back on a race).
		if ($playerSet.n === 0) return;
		const play = $playerSet.play;
		// Read media state untracked so a source change doesn't re-apply intent.
		untrack(() => void applyPlaying(play));
	});

	$effect(() => {
		// Cue marker seek on the recording that's already loaded (a tracklist time
		// click while the replay plays): seek in place, no reload. If the metadata
		// hasn't arrived yet the target is queued and applied when it does.
		if ($playerSeek.n === 0) return;
		const seconds = $playerSeek.seconds;
		untrack(() => {
			if (!mediaMode) return;
			pendingSeek = seconds;
			applyPendingSeek();
		});
	});

	$effect(() => {
		// React to a requestCollapsePlayer() signal (e.g. logo click on home).
		if ($playerCollapse.n === 0) return;
		expanded = false;
	});

	let lastPath = '';

	$effect(() => {
		// Collapse the max player on navigation (track path changes only —
		// reading `expanded` here would re-trigger and kill the toggle).
		const path = page.url.pathname;
		if (path !== lastPath) {
			lastPath = path;
			expanded = false;
		}
	});

	let prevKey = 'live';

	$effect(() => {
		const p = $playback;
		const key = p.kind === 'media' ? `media:${p.url}` : 'live';
		if (key === prevKey) return;
		prevKey = key;
		currentTime = 0;
		duration = NaN;
		// A recording may start at a cue marker (`startAt`); live never does.
		pendingSeek = p.kind === 'media' ? (p.startAt ?? null) : null;
		playerPosition.set({ url: p.kind === 'media' ? p.url : null, seconds: 0, duration: 0 });
		if (!audioEl) return;
		if (p.kind === 'media') {
			stopLive();
			audioEl.src = p.url;
			setLoading(true, 'switch:media');
			audioEl.play().catch(() => setLoading(false, 'play-rejected:switch-media'));
		} else {
			stopMedia();
			initLiveEngine();
			setLoading(true, 'switch:live');
			audioEl.play().catch(() => setLoading(false, 'play-rejected:switch-live'));
		}
	});

	function stopLive() {
		hls?.destroy();
		hls = null;
		if (audioEl) {
			audioEl.removeAttribute('src');
			audioEl.load();
		}
	}

	function stopMedia() {
		if (audioEl) {
			audioEl.pause();
			audioEl.removeAttribute('src');
			audioEl.load();
		}
	}

	/** Lazy-load hls.js on first live playback so it isn't in the initial bundle. */
	async function initLiveEngine() {
		if (!audioEl) return;
		if (HlsCtor) {
			if (HlsCtor.isSupported()) {
				if (!hls) {
					hls = new HlsCtor({ enableWorker: true, maxBufferLength: 30 });
					hls.loadSource(STREAM_URL);
					hls.attachMedia(audioEl);
					wireHlsEvents(HlsCtor);
				}
			} else if (!nativeHls && audioEl.canPlayType('application/vnd.apple.mpegurl')) {
				nativeHls = true;
				audioEl.src = STREAM_URL;
			}
			return;
		}

		const mod = await import('hls.js');
		HlsCtor = mod.default;

		if (HlsCtor.isSupported()) {
			hls = new HlsCtor({ enableWorker: true, maxBufferLength: 30 });
			hls.loadSource(STREAM_URL);
			hls.attachMedia(audioEl);
			wireHlsEvents(HlsCtor);
		} else if (audioEl.canPlayType('application/vnd.apple.mpegurl')) {
			// Native HLS (Safari): no per-variant control.
			nativeHls = true;
			audioEl.src = STREAM_URL;
		}
	}

	function wireHlsEvents(Ctor: typeof import('hls.js').default) {
		hls?.on(Ctor.Events.ERROR, (_evt, data) => {
			if (!data.fatal) return;
			if (data.type === Ctor.ErrorTypes.NETWORK_ERROR) {
				hls?.startLoad();
			} else if (data.type === Ctor.ErrorTypes.MEDIA_ERROR) {
				hls?.recoverMediaError();
			} else {
				setTimeout(() => hls?.startLoad(), 3000);
			}
		});
	}

	async function togglePlay() {
		if (!audioEl) return;
		if (mediaMode) {
			if (audioEl.paused) {
				setLoading(true, 'play-start:media');
				await audioEl.play().catch(() => setLoading(false, 'play-rejected:media'));
			} else {
				audioEl.pause();
			}
			return;
		}
		await initLiveEngine();
		if (audioEl.paused) {
			setLoading(true, 'play-start:live');
			await audioEl.play().catch(() => setLoading(false, 'play-rejected:live'));
		} else {
			audioEl.pause();
		}
	}

	/** Ensure a target state (idempotent). Handles live-engine init for play. */
	async function applyPlaying(play: boolean) {
		if (!audioEl) return;
		if (play) {
			if (mediaMode) {
				if (audioEl.paused) {
					setLoading(true, 'set:play:media');
					await audioEl.play().catch(() => setLoading(false, 'play-rejected:set-media'));
				}
			} else {
				await initLiveEngine();
				if (audioEl.paused) {
					setLoading(true, 'set:play:live');
					await audioEl.play().catch(() => setLoading(false, 'play-rejected:set-live'));
				}
			}
		} else if (!audioEl.paused) {
			audioEl.pause();
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && expanded) expanded = false;
	}

	// ---- Swipe down to minimise (mobile) ----
	// Drag anywhere on the open sheet except interactive controls; follow the
	// finger and snap closed on a firm pull or flick. Mouse is left alone.
	const SHEET_COLLAPSE_RATIO = 0.25;
	const SHEET_FLICK_VELOCITY = 0.5; // px per ms

	function isInteractiveTarget(target: EventTarget | null) {
		return (
			target instanceof Element &&
			!!target.closest('button, a, input, select, textarea, [role="button"]')
		);
	}

	function onSheetPointerDown(e: PointerEvent) {
		if (!expanded || e.pointerType === 'mouse') return;
		if (isInteractiveTarget(e.target)) return;
		dragging = true;
		dragY = 0;
		dragStartY = e.clientY;
		dragStartedAt = performance.now();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function onSheetPointerMove(e: PointerEvent) {
		if (!dragging) return;
		dragY = Math.max(0, e.clientY - dragStartY);
	}

	function onSheetPointerEnd(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		const elapsed = Math.max(1, performance.now() - dragStartedAt);
		const velocity = dragY / elapsed;
		const height = (e.currentTarget as HTMLElement).clientHeight || 1;
		if (dragY > height * SHEET_COLLAPSE_RATIO || velocity > SHEET_FLICK_VELOCITY) {
			expanded = false;
		}
		dragY = 0;
	}

	// ---- Loading-trace hardening (phantom-stall investigation) ----
	// waiting/stalled only count when actually playing; a 1.5s watchdog clears
	// phantoms (time advanced or buffer filled) while real stalls (frozen time)
	// keep the trace visible.
	let stallTimer: ReturnType<typeof setTimeout> | null = null;
	let stallStartedAt = 0;

	function clearStallWatchdog() {
		if (stallTimer) {
			clearTimeout(stallTimer);
			stallTimer = null;
		}
	}

	function beginStall() {
		if (!audioEl || audioEl.paused) return;
		clearStallWatchdog();
		stallStartedAt = audioEl.currentTime;
		setLoading(true, 'stall:begin');
		stallTimer = setTimeout(() => {
			stallTimer = null;
			if (audioEl && !audioEl.paused && (audioEl.readyState >= 3 || audioEl.currentTime > stallStartedAt)) {
				setLoading(false, 'stall:phantom');
			}
		}, 1500);
	}

	function onVisibilityChange() {
		if (document.visibilityState === 'visible' && audioEl && !audioEl.paused && audioEl.readyState >= 3) {
			setLoading(false, 'event:visibility');
		}
	}

	onMount(() => {
		startLivePolling();
		if (typeof window !== 'undefined') {
			(window as unknown as Record<string, unknown>).__vrPlayerDebug = VR_DEBUG;
		}
		if (audioEl) {
			// streamPlaying flips on `playing` (post-buffering) so the loading
			// trace stays visible across the load; `play` fires far too early.
			audioEl.addEventListener('playing', () => {
				streamPlaying.set(true);
				setLoading(false, 'event:playing');
				clearStallWatchdog();
			});
			audioEl.addEventListener('pause', () => {
				streamPlaying.set(false);
				setLoading(false, 'event:pause');
				clearStallWatchdog();
			});
			audioEl.addEventListener('ended', () => {
				// Reset on finish so state is accurate and a replay starts at 0.
				streamPlaying.set(false);
				setLoading(false, 'event:ended');
				clearStallWatchdog();
				if (audioEl) audioEl.currentTime = 0;
				// Auto-advance the tracklist queue (no-op for live/replays).
				void advancePlayQueue(media?.trackId ?? null);
			});
			audioEl.addEventListener('canplay', () => {
				setLoading(false, 'event:canplay');
				clearStallWatchdog();
				applyPendingSeek();
			});
			audioEl.addEventListener('seeked', () => setLoading(false, 'event:seeked'));
			audioEl.addEventListener('waiting', () => {
				// Paused-invariant: an engine "waiting" while paused is not a
				// real stall (Safari fires these during blocked autoplay).
				if (!audioEl?.paused) beginStall();
			});
			audioEl.addEventListener('stalled', () => {
				// Safari phantom stalls mid-playback when the buffer is fine.
				if (audioEl && !audioEl.paused && audioEl.readyState < 3) beginStall();
			});
			audioEl.addEventListener('timeupdate', () => {
				currentTime = audioEl?.currentTime ?? 0;
				// Mirror the position for the tracklist editor's "stamp time" helper.
				const nowPlaying = $playback;
				if (nowPlaying.kind === 'media') {
					playerPosition.set({
						url: nowPlaying.url,
						seconds: currentTime,
						duration: Number.isFinite(duration) ? duration : 0
					});
				}
				setLoading(false, 'event:timeupdate');
				clearStallWatchdog();
			});
			audioEl.addEventListener('loadedmetadata', () => {
				duration = audioEl?.duration ?? NaN;
				applyPendingSeek();
			});
			audioEl.addEventListener('durationchange', () => {
				duration = audioEl?.duration ?? NaN;
				applyPendingSeek();
			});
		}
		window.addEventListener('keydown', onKey);
		document.addEventListener('visibilitychange', onVisibilityChange);
		if (hasMediaSession) {
			navigator.mediaSession.setActionHandler('play', () => {
				if (audioEl?.paused) void togglePlay();
			});
			navigator.mediaSession.setActionHandler('pause', () => {
				if (audioEl && !audioEl.paused) void togglePlay();
			});
			navigator.mediaSession.setActionHandler('nexttrack', () => void advancePlayQueue());
			navigator.mediaSession.setActionHandler('previoustrack', () => void previousPlayQueue());
		}
		if ($autoplay && !mediaMode) togglePlay();
	});

	onDestroy(() => {
		hls?.destroy();
		audioEl?.pause();
		clearStallWatchdog();
		if (hasMediaSession) {
			navigator.mediaSession.setActionHandler('play', null);
			navigator.mediaSession.setActionHandler('pause', null);
			navigator.mediaSession.setActionHandler('nexttrack', null);
			navigator.mediaSession.setActionHandler('previoustrack', null);
		}
		if (typeof window !== 'undefined') {
			window.removeEventListener('keydown', onKey);
			document.removeEventListener('visibilitychange', onVisibilityChange);
			delete (window as unknown as Record<string, unknown>).__vrPlayerDebug;
		}
	});

	function fmtDt(dateStr: string) {
		return new Intl.DateTimeFormat('en-NZ', {
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			timeZone: 'UTC'
		}).format(new Date(`${dateStr}T00:00:00Z`));
	}

	/** Seek a recording to `sec` (live/HLS has no finite timeline, so ignore). */
	function seekTo(sec: number) {
		if (!audioEl || !Number.isFinite(duration) || duration <= 0) return;
		const target = Math.max(0, Math.min(sec, duration));
		audioEl.currentTime = target;
		currentTime = target;
	}

	/**
	 * Apply a queued cue marker (`startAt` or a tracklist click) as soon as the
	 * recording's duration is known. Until then the target stays pending — an
	 * offset can't be clamped or seeked without metadata.
	 */
	function applyPendingSeek() {
		if (pendingSeek === null || !audioEl) return;
		if (!Number.isFinite(duration) || duration <= 0) return;
		seekTo(pendingSeek);
		pendingSeek = null;
	}

	function trackText() {
		if (media) return `${media.title}${media.artist ? ` — ${media.artist}` : ''}`;
		// A live DJ's stream metadata can be stale until the encoder sends new
		// metadata, so while live we show the DB show identity (or the streamer
		// name) instead of the raw nowPlaying text.
		if (identity) return identity.title;
		if (isLive) return livePayload?.live.streamerName || 'Live now';
		if (livePayload?.nowPlaying?.title) {
			return `${livePayload.nowPlaying.title}${livePayload.nowPlaying.artist ? ` — ${livePayload.nowPlaying.artist}` : ''}`;
		}
		return playing ? 'Now playing' : 'Paused';
	}

	// ---- Player actions: follow (show) + episode bookmark + native share ----

	const user = $derived(page.data.user);

	/** Show context for save/share: archive episode first, then on-air show. */
	const shareContext = $derived(
		media?.href
			? { href: media.href, id: media?.show?.id ?? null, title: (media?.show?.title ?? media.title).replace(' — ', ' · ') }
			: showLink
				? { href: `/shows/${showLink.id}`, id: showLink.id, title: showLink.title }
				: { href: location.href, id: null, title: 'Version Radio' }
	);

	const showId = $derived(media?.show?.id ?? showLink?.id ?? null);
	const broadcastId = $derived(mediaMode ? (media?.broadcastId ?? null) : null);

	let followed = $state(false);
	let episodeSaved = $state(false);
	let episodeFavourited = $state(false);
	let favouriteCount = $state(0);
	let loginHint = $state(false);
	let hintKind = $state<'follow' | 'save' | 'favourite'>('follow');
	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		followed = false;
		episodeSaved = false;
		episodeFavourited = false;
		favouriteCount = 0;
		loginHint = false;
		if (!user) return;
		let cancelled = false;
		if (showId) {
			fetch(`/api/shows/${showId}/follow`)
				.then((r) => (r.status === 401 ? null : r.json() as Promise<{ following: boolean }>))
				.then((d) => {
					if (!cancelled && d) followed = d.following;
				})
				.catch(() => {});
		}
		if (broadcastId) {
			fetch(`/api/shows/${showId}/broadcasts/${broadcastId}/saved`)
				.then((r) => (r.status === 401 ? null : r.json() as Promise<{ saved: boolean }>))
				.then((d) => {
					if (!cancelled && d) episodeSaved = d.saved;
				})
				.catch(() => {});
			fetch(`/api/shows/${showId}/broadcasts/${broadcastId}/favourite`)
				.then(
					(r) =>
						r.status === 401
							? null
							: (r.json() as Promise<{ favourited: boolean; count: number }>)
				)
				.then((d) => {
					if (!cancelled && d) {
						episodeFavourited = d.favourited;
						favouriteCount = d.count;
					}
				})
				.catch(() => {});
		}
		return () => {
			cancelled = true;
		};
	});

	async function togglePlayerFollow() {
		if (!showId) return;
		if (!user) {
			hintKind = 'follow';
			loginHint = true;
			return;
		}
		loginHint = false;
		const prev = followed;
		followed = !followed;
		const res = await fetch(`/api/shows/${showId}/follow`, { method: 'POST' });
		if (res.status === 401) {
			followed = prev;
			hintKind = 'follow';
			loginHint = true;
			return;
		}
		if (!res.ok) followed = prev;
	}

	async function togglePlayerEpisodeSaved() {
		if (!showId || !broadcastId) return;
		if (!user) {
			hintKind = 'save';
			loginHint = true;
			return;
		}
		loginHint = false;
		const prev = episodeSaved;
		episodeSaved = !episodeSaved;
		const res = await fetch(`/api/shows/${showId}/broadcasts/${broadcastId}/saved`, {
			method: 'POST'
		});
		if (res.status === 401) {
			episodeSaved = prev;
			hintKind = 'save';
			loginHint = true;
			return;
		}
		if (!res.ok) episodeSaved = prev;
	}

	async function togglePlayerFavourite() {
		if (!showId || !broadcastId) return;
		if (!user) {
			hintKind = 'favourite';
			loginHint = true;
			return;
		}
		loginHint = false;
		const prev = episodeFavourited;
		const prevCount = favouriteCount;
		episodeFavourited = !prev;
		favouriteCount = Math.max(0, prevCount + (prev ? -1 : 1));
		const res = await fetch(`/api/shows/${showId}/broadcasts/${broadcastId}/favourite`, {
			method: 'POST'
		});
		if (res.status === 401) {
			episodeFavourited = prev;
			favouriteCount = prevCount;
			hintKind = 'favourite';
			loginHint = true;
			return;
		}
		if (!res.ok) {
			episodeFavourited = prev;
			favouriteCount = prevCount;
			return;
		}
		const body = (await res.json().catch(() => null)) as
			| { favourited?: boolean; count?: number }
			| null;
		episodeFavourited = body?.favourited ?? !prev;
		favouriteCount = body?.count ?? favouriteCount;
	}

	async function shareTrack() {
		const { href, title } = shareContext;
		const url = new URL(href, location.origin).href;
		if (navigator.share) {
			try {
				await navigator.share({ title: `${title} — Version Radio`, url });
			} catch {
				// cancelled — no-op
			}
			return;
		}
		try {
			await navigator.clipboard.writeText(url);
		} catch {
			return;
		}
		copied = true;
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copied = false), 1600);
	}

	onDestroy(() => {
		if (copyTimer) clearTimeout(copyTimer);
	});
</script>

<audio bind:this={audioEl} preload="none"></audio>

<div class="dock">
	<section
		id="player-sheet"
		class="sheet"
		class:open={expanded}
		class:dragging
		style:transform={dragging ? `translateY(${dragY}px)` : null}
		onpointerdown={onSheetPointerDown}
		onpointermove={onSheetPointerMove}
		onpointerup={onSheetPointerEnd}
		onpointercancel={onSheetPointerEnd}
		aria-label="Player details"
	>
		<div class="grabber" aria-hidden="true"></div>
		<div class="strip">
			{#if artSource && !artFailed}
				<img class="strip-img" src={artSource} alt="" loading="lazy" onerror={onArtError} />
			{:else}
				<span class="eq big" class:playing={playing} aria-hidden="true">
					<i></i><i></i><i></i><i></i>
				</span>
			{/if}
		</div>
		<div class="sheet-body">
			<div class="sheet-info">
				<div class="sheet-station mono">
					<span class="sticker" class:green={isLive} class:dark={!isLive && !mediaMode}>
						{#if isLive}
							<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
								<path d="M2 12h2.5M4.5 8a5.5 5.5 0 0 1 0 8M8 9a3.5 3.5 0 0 1 0 6M19.5 12H22M15 8a5.5 5.5 0 0 1 0 8M12 9a3.5 3.5 0 0 1 0 6" stroke="currentColor" stroke-width="1.6" fill="none"/>
							</svg>
						{/if}
						{stationSticker}
					</span>
					<span class="station-name">
						{#if mediaMode}
							Recording{media?.date ? ` · ${fmtDt(media.date)}` : ''}
						{/if}
					</span>
				</div>
				<span class="track big">{trackText()}</span>
				{#if mediaMode && Number.isFinite(duration) && duration > 0}
					<SeekControl {currentTime} {duration} onSeek={seekTo} />
				{/if}
				{#if !mediaMode}
					{#if isLive}
						{#if identity}
							<a class="showlink" href={`/shows/${identity.id}`} title={identity.title}>
								{identity.djName ?? livePayload?.live.streamerName ?? 'Live on air'}
							</a>
						{/if}
					{:else if showLink}
						<a class="showlink showlink-onair" href={`/shows/${showLink.id}`}>On air: {showLink.title}</a>
					{/if}
				{:else}
					{#if media?.show}
						<a class="showlink mono" href={`/shows/${media.show.id}`}>{media.show.title} <span class="arrow-chip" aria-hidden="true">→︎</span></a>
					{/if}
				{/if}
			</div>
			<div class="sheet-controls">
				<button
					class="chev"
					onclick={() => (expanded = false)}
					aria-label="Collapse player"
					title="Minimise"
				>
					▾
				</button>
				<div class="sheet-controls-right">
					{#if !mediaMode && !playing}
						<button class="live-btn" onclick={requestPlay}>Listen live</button>
					{/if}
					{#if showId && !broadcastId}
						<button
							class="icon-btn"
							class:active={followed}
							onclick={togglePlayerFollow}
							aria-pressed={followed}
							aria-label={followed ? 'Unfollow show' : 'Follow show'}
							title={followed ? 'Unfollow show' : 'Follow show'}
						>
							<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
								<path
									d="M12 3a6 6 0 0 1 6 6v3l1.6 2.6a.6.6 0 0 1-.5.9H4.9a.6.6 0 0 1-.5-.9L6 12V9a6 6 0 0 1 6-6zM10 17.5a2 2 0 0 0 4 0"
									fill={followed ? 'currentColor' : 'none'}
									stroke="currentColor"
									stroke-width="1.6"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
						</button>
					{/if}
					{#if broadcastId}
						<button
							class="icon-btn favourite"
							class:active={episodeFavourited}
							onclick={togglePlayerFavourite}
							aria-pressed={episodeFavourited}
							aria-label={episodeFavourited ? 'Remove favourite' : 'Favourite recording'}
							title={episodeFavourited ? 'Remove favourite' : 'Favourite recording'}
						>
							<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
								<path
									d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"
									fill={episodeFavourited ? 'currentColor' : 'none'}
									stroke="currentColor"
									stroke-width="1.8"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
							{#if favouriteCount > 0}
								<span class="icon-count">{favouriteCount}</span>
							{/if}
						</button>
					{/if}
					{#if broadcastId}
						<button
							class="icon-btn"
							class:active={episodeSaved}
							onclick={togglePlayerEpisodeSaved}
							aria-pressed={episodeSaved}
							aria-label={episodeSaved ? 'Remove bookmark' : 'Bookmark broadcast'}
							title={episodeSaved ? 'Remove bookmark' : 'Bookmark broadcast'}
						>
							<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
								<path
									d="M6 4.5v15l6-4.5 6 4.5v-15a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"
									fill={episodeSaved ? 'currentColor' : 'none'}
									stroke="currentColor"
									stroke-width="1.8"
									stroke-linejoin="round"
								/>
							</svg>
						</button>
					{/if}
					<button class="icon-btn" onclick={shareTrack} aria-label="Share" title="Share">
						<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
							<path
								d="M12 3v12M8 7l4-4 4 4M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"
								fill="none"
								stroke="currentColor"
								stroke-width="1.8"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					</button>
					{#if mediaMode}
						<button class="live-btn back" onclick={requestPlay}>
							<span class="lbl-full">Back to live</span><span class="lbl-short">LIVE</span>
						</button>
					{/if}
					<button class="play big" onclick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
						{#if loading}
							<svg class="trace" viewBox="0 0 24 24" aria-hidden="true">
								<path
									class="trace-path"
									pathLength="100"
									d="M8 5.4v13.2a1 1 0 0 0 1.53.85l10.6-6.6a1 1 0 0 0 0-1.7L9.53 4.55A1 1 0 0 0 8 5.4z"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linejoin="round"
								/>
							</svg>
						{:else if playing}
							<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5.2a1 1 0 0 1 2 0v13.6a1 1 0 0 1-2 0zM15 5.2a1 1 0 0 1 2 0v13.6a1 1 0 0 1-2 0z" fill="currentColor" /></svg>
						{:else}
							<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.4v13.2a1 1 0 0 0 1.53.85l10.6-6.6a1 1 0 0 0 0-1.7L9.53 4.55A1 1 0 0 0 8 5.4z" fill="currentColor" /></svg>
						{/if}
					</button>
				</div>
			</div>
			{#if loginHint || copied}
				<div class="sheet-note">
					{#if loginHint}
						<span class="mono">
							{hintKind === 'follow'
								? 'Sign in to follow shows'
								: hintKind === 'save'
									? 'Sign in to save broadcasts'
									: 'Sign in to favourite recordings'} — <a class="note-link" href="/login">Sign in</a>
						</span>
					{:else}
						<span class="mono note-copied">Copied</span>
					{/if}
				</div>
			{/if}
		</div>
	</section>

	<div class="player-bar" class:out={expanded}>
		<button
			class="bar-toggle mono"
			class:dark={!isLive && !mediaMode}
			onclick={() => (expanded = !expanded)}
			aria-controls="player-sheet"
			aria-expanded={expanded}
			aria-label={`${stationSticker} — ${expanded ? 'Minimise player' : 'Maximise player'}`}
			title={expanded ? 'Minimise' : 'Maximise'}
		>
			<span class="bar-toggle-chev" aria-hidden="true">{expanded ? '▾' : '▴'}</span>
			{stationSticker}
		</button>
		<div class="bar-meta">
			{#if artSource && !artFailed}
				<img class="art" src={artSource} alt="" width="28" height="28" loading="lazy" onerror={onArtError} />
			{:else}
				<span class="eq" class:playing={playing} aria-hidden="true">
					<i></i><i></i><i></i><i></i>
				</span>
			{/if}
			<div class="meta">
				{#if !onAirLine}
					<span class="track mono" class:muted={!media && !identity && !isLive && !livePayload?.nowPlaying?.title}>{media ? media.title : trackText()}</span>
				{/if}
				{#if mediaMode && Number.isFinite(duration) && duration > 0}
					<SeekControl {currentTime} {duration} onSeek={seekTo} compact />
				{:else if media?.artist}
					<span class="track mono muted">{media.artist}</span>
				{/if}
				{#if !mediaMode}
					{#if isLive}
						{#if identity}
							<a class="showlink mono" href={`/shows/${identity.id}`} title={identity.title}>
								{identity.djName ?? 'Live on air'}
							</a>
						{/if}
					{:else if showLink}
						<a class="showlink mono" href={`/shows/${showLink.id}`}>On air: {showLink.title}</a>
					{:else if livePayload?.live?.streamerName}
						<span class="showlink mono">{livePayload.live.streamerName}</span>
					{/if}
				{/if}
			</div>
		</div>

		<div class="controls">
			{#if mediaMode}
				<button class="live-btn back" onclick={requestPlay}>
					<span class="lbl-full">Back to live</span><span class="lbl-short">LIVE</span>
				</button>
			{/if}
			<button class="play" onclick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
				{#if loading}
					<svg class="trace" viewBox="0 0 24 24" aria-hidden="true">
						<path
							class="trace-path"
							pathLength="100"
							d="M8 5.4v13.2a1 1 0 0 0 1.53.85l10.6-6.6a1 1 0 0 0 0-1.7L9.53 4.55A1 1 0 0 0 8 5.4z"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linejoin="round"
						/>
					</svg>
				{:else if playing}
					<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5.2a1 1 0 0 1 2 0v13.6a1 1 0 0 1-2 0zM15 5.2a1 1 0 0 1 2 0v13.6a1 1 0 0 1-2 0z" fill="currentColor" /></svg>
				{:else}
					<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.4v13.2a1 1 0 0 0 1.53.85l10.6-6.6a1 1 0 0 0 0-1.7L9.53 4.55A1 1 0 0 0 8 5.4z" fill="currentColor" /></svg>
				{/if}
			</button>
		</div>
	</div>
</div>

<style>
	.dock {
		position: fixed;
		left: 0;
		right: 0;
		top: 57px;
		bottom: 0;
		z-index: 30;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		pointer-events: none;
	}

	.player-bar {
		pointer-events: auto;
		display: flex;
		align-items: stretch;
		justify-content: space-between;
		gap: 0;
		height: 64px;
		background: var(--vr-surface);
		border-top: 1px solid var(--vr-line);
		transform: translateY(0);
		transition: transform 900ms cubic-bezier(0.33, 1, 0.68, 1);
		transition-delay: 400ms;
	}

	.player-bar.out {
		transform: translateY(100%);
		transition-delay: 0ms;
	}

	.bar-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		padding: 0 1rem;
		border: none;
		border-right: 1px solid var(--vr-line-muted);
		font-family: var(--vr-font-mono);
		font-size: 0.82rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: #000;
		background: var(--vr-green);
		white-space: nowrap;
		cursor: pointer;
	}

	.bar-toggle.dark {
		background: #000;
		color: #fff;
		border-right-color: #fff;
	}

	.bar-toggle-chev {
		font-size: 0.9rem;
		letter-spacing: 0;
	}

	.bar-toggle:hover {
		background: var(--vr-text);
		color: var(--vr-black);
		border-right-color: var(--vr-line-muted);
	}

	.bar-meta {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
		flex: 1;
		padding: 0 1rem;
	}

	.art {
		width: 28px;
		height: 28px;
		object-fit: cover;
		border: 1px solid var(--vr-line-muted);
		flex-shrink: 0;
	}

	.meta {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		line-height: 1.2;
		min-width: 0;
		flex: 1;
	}

	.track {
		font-size: 0.72rem;
		color: var(--vr-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 36rem;
	}

	.track.big {
		font-size: 1.35rem;
		font-family: var(--vr-font-headline);
		text-transform: uppercase;
		line-height: 1.15;
		font-weight: 400;
		white-space: normal;
		max-width: 44rem;
	}

	.track.muted {
		color: var(--vr-muted);
	}

	.showlink {
		font-size: 0.72rem;
		color: var(--vr-green);
		text-decoration: none;
		max-width: 24rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sheet .showlink {
		color: var(--vr-muted);
	}

	.sheet .showlink-onair {
		text-decoration: underline;
	}

	.showlink:hover {
		text-decoration: underline;
	}

	.eq {
		display: inline-flex;
		align-items: flex-end;
		gap: 2px;
		height: 16px;
		width: 16px;
	}

	.eq i {
		width: 3px;
		background: var(--vr-muted);
		height: 4px;
	}

	.eq.playing i {
		background: var(--vr-green);
		animation: eq 0.9s ease-in-out infinite;
	}

	.eq.playing i:nth-child(2) {
		animation-delay: 0.15s;
	}

	.eq.playing i:nth-child(3) {
		animation-delay: 0.3s;
	}

	.eq.playing i:nth-child(4) {
		animation-delay: 0.45s;
	}

	@keyframes eq {
		0%,
		100% {
			height: 4px;
		}
		50% {
			height: 14px;
		}
	}

	.eq.big {
		width: 44px;
		height: 44px;
		gap: 4px;
	}

	.eq.big i {
		width: 6px;
		background: var(--vr-faint);
	}

	.eq.big.playing i {
		background: var(--vr-green);
	}

	.controls {
		display: flex;
		align-items: stretch;
		gap: 0;
	}

	.chev {
		width: 38px;
		border: none;
		border-right: 1px solid var(--vr-line-muted);
		background: transparent;
		color: var(--vr-muted);
		font-size: 0.9rem;
		cursor: pointer;
	}

	.chev:hover {
		background: var(--vr-text);
		color: var(--vr-black);
	}

	.sheet .chev {
		width: 40px;
		height: 40px;
		border: 1px solid var(--vr-line);
		display: grid;
		place-items: center;
	}

	.icon-btn {
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		border: 1px solid var(--vr-line);
		background: transparent;
		color: var(--vr-muted);
		cursor: pointer;
	}

	.icon-btn:hover {
		background: var(--vr-text);
		color: var(--vr-black);
	}

	.icon-btn.active {
		border-color: var(--vr-line);
		color: var(--vr-text);
	}

	.icon-btn.favourite {
		display: inline-flex;
		gap: 0.3rem;
		width: auto;
		min-width: 40px;
		padding: 0 0.6rem;
	}

	.icon-btn.favourite:hover,
	.icon-btn.favourite.active {
		background: none;
		border-color: var(--vr-red);
		color: var(--vr-red);
	}

	.icon-count {
		font-family: var(--vr-font-mono);
		font-size: 0.72rem;
		line-height: 1;
		font-variant-numeric: tabular-nums;
	}

	.sheet-note {
		border-top: 1px solid var(--vr-line-muted);
		padding: 0.6rem 0 0;
		margin-top: 0.15rem;
	}

	.sheet-note .mono {
		font-size: 0.78rem;
		color: var(--vr-muted);
	}

	.note-link {
		color: var(--vr-text);
		text-decoration: underline;
		font-weight: 600;
	}

	.note-copied {
		color: var(--vr-green);
	}

	/* Autoplay switch removed while the feature is disabled (PWA-ready gate) —
	   restore .autoplay-switch markup/CSS when re-enabling in StreamPlayer. */

	.live-btn {
		border: none;
		border-left: 1px solid var(--vr-line-muted);
		background: transparent;
		color: var(--vr-muted);
		font-family: var(--vr-font-mono);
		font-size: 0.72rem;
		font-weight: 500;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		padding: 0 1rem;
		cursor: pointer;
		white-space: nowrap;
	}

	.live-btn .lbl-short {
		display: none;
	}

	.live-btn:hover {
		background: var(--vr-text);
		color: var(--vr-black);
	}

	.play {
		display: grid;
		place-items: center;
		width: 64px;
		border: none;
		border-left: 1px solid var(--vr-line);
		background: transparent;
		color: var(--vr-text);
		cursor: pointer;
		transition: background-color 150ms, color 150ms;
	}

	.play:hover {
		background: var(--vr-text);
		color: var(--vr-black);
	}

	.play svg {
		width: 22px;
		height: 22px;
		display: block;
		margin-left: 1px;
	}

	.play svg.trace .trace-path {
		stroke-dasharray: 34 66;
		animation: trace-loop 1.8s linear infinite;
	}

	.play.big svg.trace .trace-path {
		animation-duration: 1.6s;
	}

	@keyframes trace-loop {
		from {
			stroke-dashoffset: 0;
		}
		to {
			stroke-dashoffset: 100;
		}
	}

	.play.big {
		width: 52px;
		height: 52px;
		border: 1px solid #fff;
		background: #fff;
		color: #000;
	}

	.play.big:hover {
		background: #000;
		color: #fff;
	}

	.play.big svg {
		width: 24px;
		height: 24px;
	}

	.sheet {
		position: absolute;
		inset: 0;
		z-index: 2;
		display: grid;
		grid-template-rows: minmax(0, 1fr) auto;
		overflow: hidden;
		background: var(--vr-bg);
		border-top: 1px solid var(--vr-line);
		pointer-events: none;
		touch-action: none;
		transform: translateY(100%);
		transition: transform 800ms cubic-bezier(0.33, 1, 0.68, 1);
	}

	.sheet.open {
		transform: translateY(0);
		pointer-events: auto;
		transition-duration: 550ms;
		transition-delay: 200ms;
	}

	/* Swipe-down drag: follow the finger without fighting the open/close anim. */
	.sheet.dragging {
		transition: none;
	}

	.grabber {
		position: absolute;
		top: 0.5rem;
		left: 50%;
		transform: translateX(-50%);
		width: 42px;
		height: 4px;
		background: var(--vr-line-muted);
		pointer-events: none;
		z-index: 3;
	}

	.strip {
		min-height: 0;
		display: grid;
		place-items: center;
		padding: 1.25rem;
	}

	.strip-img {
		aspect-ratio: 1;
		width: 100%;
		max-width: min(100%, 64vh);
		max-height: 100%;
		object-fit: cover;
		display: block;
		border: 1px solid var(--vr-line);
		-webkit-user-drag: none;
	}

	.sheet-body {
		background: var(--vr-surface);
		border-top: 1px solid var(--vr-line);
		padding: 1.25rem 1.25rem calc(1.25rem + env(safe-area-inset-bottom));
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 1.25rem;
	}

	.sheet-info {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		min-width: 0;
		flex: 1;
	}

	.sheet-station {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.sheet-station .sticker {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}

	.sheet-station .sticker.green {
		background: var(--vr-green);
		color: #000;
	}

	.sheet-station .sticker.dark {
		background: #000;
		color: #fff;
		border: 1px solid #fff;
	}

	.station-name {
		color: var(--vr-faint);
	}

	.sheet-controls {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.sheet-controls-right {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	@media (max-width: 720px) {
		.bar-toggle {
			padding: 0 0.7rem;
		}

		.bar-meta {
			padding: 0 0.7rem;
			overflow: hidden;
		}

		.art {
			display: none;
		}

		.live-btn {
			display: none;
		}

		/* Return-to-live stays available on mobile — compact "LIVE" label. */
		.live-btn.back {
			display: inline-flex;
			align-items: center;
			padding: 0 0.6rem;
			font-size: 0.68rem;
		}

		.live-btn.back .lbl-full {
			display: none;
		}

		.live-btn.back .lbl-short {
			display: inline;
		}
	}
</style>
