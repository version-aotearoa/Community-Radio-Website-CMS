<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import ShowActions from '$lib/components/ShowActions.svelte';
	import {
		clearPlayQueue,
		playback,
		playMedia,
		requestSetPlaying,
		startPlayQueue,
		streamPlaying
	} from '$lib/stores/player';
	import { bandcampArtUrl, isBandcampPageUrl } from '$lib/bandcamp';
	import { episodeArtOrDefault } from '$lib/azuracast';
	import { probeReplayAvailability, unavailableReplays } from '$lib/replayAvailability';
	import { artOnError } from '$lib/art';
	import Seo from '$lib/components/Seo.svelte';

	let { data } = $props();

	const show = $derived(data.show);
	const broadcast = $derived(data.broadcast);
	const tracks = $derived(data.tracks);
	// Episode art, defaulting to the show's (DJ) image when the episode has none.
	const artFallback = $derived(show.image ?? show.dj_image ?? null);
	const artUrl = $derived(episodeArtOrDefault(broadcast.id, broadcast, show));

	// Replay availability is probed after paint (never during render).
	onMount(() => {
		probeReplayAvailability([data.broadcast.replay_url]);
		// Deferred past the navigation's microtasks: an immediate invalidateAll
		// aborts the in-flight navigation before SvelteKit resets scroll to top.
		setTimeout(() => void invalidateAll(), 0);
		// Fill in name/artist/art for any not-yet-resolved Bandcamp rows.
		void prefetchMissing();
	});

	function fmtDate(dateStr: string) {
		return new Intl.DateTimeFormat('en-NZ', {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			year: 'numeric',
			timeZone: 'UTC'
		}).format(new Date(`${dateStr}T00:00:00Z`));
	}

	function fmtTime(mins: number) {
		const h = Math.floor(mins / 60);
		const m = mins % 60;
		return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
	}

	function hostOf(url: string) {
		try {
			return new URL(url).hostname;
		} catch {
			return url;
		}
	}

	// Bandcamp rows play through the global player: clicking resolves the
	// signed stream URL (via /api/tracks/:id/stream) then hands off to
	// playMedia(), which is a single shared <audio> element — so only one
	// track ever plays, on every browser.
	let resolving = $state<Record<string, boolean>>({});
	let trackMeta = $state<
		Record<string, { title: string | null; artist: string | null; art: string | null }>
	>({});
	let trackError = $state<Record<string, string>>({});

	function trackCurrent(trackId: string): boolean {
		const current = $playback;
		return current.kind === 'media' && current.trackId === trackId;
	}

	function trackPlaying(trackId: string): boolean {
		return trackCurrent(trackId) && $streamPlaying;
	}

	interface ResolvedStream {
		streamUrl?: string;
		title?: string | null;
		artist?: string | null;
		art?: string | null;
		error?: string;
	}

	async function fetchStream(trackId: string): Promise<ResolvedStream | null> {
		const res = await fetch(`/api/tracks/${trackId}/stream`);
		return (await res.json().catch(() => null)) as ResolvedStream | null;
	}

	/** Hand a resolved stream to the global player (single shared <audio>). */
	function startTrack(
		t: { id: string; title: string; artist: string },
		body: ResolvedStream
	) {
		if (!body.streamUrl) return;
		trackMeta[t.id] = {
			title: body.title ?? null,
			artist: body.artist ?? null,
			art: body.art ?? null
		};
		playMedia({
			url: body.streamUrl,
			title: body.title || t.title || 'Bandcamp',
			artist: body.artist || t.artist || null,
			art: body.art ?? artUrl ?? artFallback,
			show: { id: show.id, title: show.title },
			href: `/shows/${show.id}/${broadcast.id}`,
			broadcastId: broadcast.id,
			date: broadcast.date,
			trackId: t.id
		});
	}

	/** The ordered, playable Bandcamp rows — the player's auto-advance queue. */
	function buildQueue() {
		return tracks
			.filter((t) => t.url && isBandcampPageUrl(t.url))
			.map((t) => ({
				trackId: t.id,
				title: t.title,
				artist: t.artist || null,
				art: trackMeta[t.id]?.art ?? bandcampArtUrl(t.stream_art_id) ?? null
			}));
	}

	async function playTrack(t: { id: string; title: string; artist: string; url: string | null }) {
		if (!t.url) return;
		trackError[t.id] = '';

		if (trackCurrent(t.id)) {
			// Already the current track: pause explicitly, or resume/restart.
			if (trackPlaying(t.id)) {
				requestSetPlaying(false);
				return;
			}
			resolving[t.id] = true;
			try {
				// Re-resolve so a stream URL that expired mid-session is replaced;
				// otherwise resume in place.
				const body = await fetchStream(t.id);
				const currentUrl = $playback.kind === 'media' ? $playback.url : null;
				if (body?.streamUrl && body.streamUrl !== currentUrl) startTrack(t, body);
				else requestSetPlaying(true);
			} catch {
				requestSetPlaying(true);
			} finally {
				resolving[t.id] = false;
			}
			return;
		}

		resolving[t.id] = true;
		try {
			const body = await fetchStream(t.id);
			if (!body?.streamUrl) {
				trackError[t.id] = body?.error ?? "Couldn't start playback.";
				return;
			}
			// Set this tracklist as the player's queue so it auto-advances.
			startPlayQueue(buildQueue(), t.id);
			startTrack(t, body);
		} catch {
			trackError[t.id] = "Couldn't start playback.";
		} finally {
			resolving[t.id] = false;
		}
	}

	/** Artwork for a row: freshly-resolved meta, else the cached Bandcamp art id. */
	function rowArt(t: { id: string; stream_art_id?: string | null }): string | null {
		return trackMeta[t.id]?.art ?? bandcampArtUrl(t.stream_art_id ?? null);
	}

	/**
	 * Prefetch name/artist/art for Bandcamp rows that haven't been resolved yet
	 * (no persisted metadata). Runs once per page load, 2 at a time, and updates
	 * each row as results arrive. Resolved rows are cached in D1, so only the
	 * first visitor to a tracklist pays the fetch cost.
	 */
	async function prefetchMissing() {
		const pending = tracks.filter(
			(t) => t.url && isBandcampPageUrl(t.url) && (!t.title || !t.stream_art_id)
		);
		let cursor = 0;
		async function worker() {
			while (cursor < pending.length) {
				const t = pending[cursor++];
				if (trackMeta[t.id]?.title) continue;
				try {
					const res = await fetch(`/api/tracks/${t.id}/stream`);
					if (res.ok) {
						const body = (await res.json()) as {
							title?: string | null;
							artist?: string | null;
							art?: string | null;
						};
						trackMeta[t.id] = {
							title: body.title ?? null,
							artist: body.artist ?? null,
							art: body.art ?? null
						};
					}
				} catch {
					// best-effort prefetch
				}
				if (cursor < pending.length) await new Promise((r) => setTimeout(r, 200));
			}
		}
		await Promise.all([worker(), worker()]);
	}

	function toggleReplay() {
		if (!broadcast.replay_url || $unavailableReplays.has(broadcast.replay_url)) return;
		if (replayActive()) {
			requestSetPlaying(false);
			return;
		}
		// Replay isn't the Bandcamp tracklist — stop auto-advancing that queue.
		clearPlayQueue();
		playMedia({
			url: broadcast.replay_url,
			title: show.title,
			artist: show.kind === 'event' ? null : (show.dj_name ?? null),
			art: artUrl,
			show: { id: show.id, title: show.title },
			href: `/shows/${show.id}/${broadcast.id}`,
			broadcastId: broadcast.id,
			date: broadcast.date
		});
	}

	function replayActive(): boolean {
		const url = broadcast.replay_url;
		if (!url) return false;
		const current = $playback;
		return current.kind === 'media' && current.url === url && $streamPlaying;
	}

	let loginHint = $state<{ show: boolean; kind: 'follow' | 'save' | 'favourite' } | null>(null);

	let lightboxOpen = $state(false);

	// Close the artwork lightbox on Esc; lock body scroll while open.
	$effect(() => {
		if (!lightboxOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') lightboxOpen = false;
		};
		window.addEventListener('keydown', onKey);
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			window.removeEventListener('keydown', onKey);
			document.body.style.overflow = prevOverflow;
		};
	});
</script>

<svelte:head>
	<title>{show.title} — {fmtDate(broadcast.date)} — Version Radio</title>
</svelte:head>

<Seo
	title={`${show.title} — ${fmtDate(broadcast.date)}`}
	description={show.pageContentText || show.description || undefined}
	image={artUrl ?? show.image}
	url={page.url.pathname}
/>

<div class="page">
	<div class="page-head">
		<a class="back mono" href={`/shows/${show.id}`}><span class="arrow-chip" aria-hidden="true">←︎</span> {show.title}</a>
		{#if data.canEdit}
			<a class="btn-outline" href={`/shows/${show.id}/${broadcast.id}/edit`}>Edit</a>
		{/if}
	</div>

	<h1 class="h-lg">{show.title}</h1>
	<p class="meta mono">
		<strong>{fmtDate(broadcast.date)}</strong>
		· {fmtTime(broadcast.start_minutes)}–{fmtTime(
			broadcast.start_minutes + broadcast.duration_minutes
		)}
		{#if show.dj_name && show.kind !== 'event'}· with {show.dj_name}{/if}
	</p>

<section class="card">
	<div class="replay">
		{#if artUrl}
			<button
				class="art-btn"
				onclick={() => (lightboxOpen = true)}
				aria-label="View full artwork"
				title="View full artwork"
			>
				<img
					class="replay-art"
					src={artUrl}
					alt=""
					width="80"
					height="80"
					loading="lazy"
					onerror={(e) => artOnError(e, artFallback)}
				/>
			</button>
		{:else}
			<span class="replay-art replay-art-fallback" aria-hidden="true">
				<svg viewBox="0 0 80 70" fill="currentColor" width="36" height="31">
					<path
						fill-rule="evenodd"
						d="M0 0H40V40H50V0H80V45H70V60H55V70H25V60H10V45H0V5ZM10 5H5V40H15V55H30V65H50V55H65V40H75V5H55V45H35V5H15Z"
					/>
				</svg>
			</span>
		{/if}
		{#if broadcast.replay_url && $unavailableReplays.has(broadcast.replay_url)}
			<span
				class="replay-unavailable"
				title="This recording is no longer available"
				>No longer available</span
			>
		{:else if broadcast.replay_url}
			<button class="replay-btn" class:playing={replayActive()} onclick={toggleReplay}>
				{#if replayActive()}
					<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5.2a1 1 0 0 1 2 0v13.6a1 1 0 0 1-2 0zM15 5.2a1 1 0 0 1 2 0v13.6a1 1 0 0 1-2 0z" fill="currentColor" /></svg>
					Pause
				{:else}
					<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.4v13.2a1 1 0 0 0 1.53.85l10.6-6.6a1 1 0 0 0 0-1.7L9.53 4.55A1 1 0 0 0 8 5.4z" fill="currentColor" /></svg>
					Replay
				{/if}
			</button>
		{/if}
		<ShowActions
			showId={show.id}
			showTitle={`${show.title} — ${fmtDate(broadcast.date)}`}
			followed={data.followed}
			user={data.user}
			episode={{ broadcastId: broadcast.id }}
			episodeSaved={data.savedEpisode}
			episodeFavourited={data.favourited}
			favouriteCount={data.favouriteCount}
			compact
			hintExternal
			onHintChange={(h) => (loginHint = h)}
		/>
		{#if loginHint?.show}
			<div class="login-hint hint-row">
				{loginHint.kind === 'follow'
					? 'Sign in to follow shows'
					: loginHint.kind === 'save'
						? 'Sign in to save broadcasts'
						: 'Sign in to favourite recordings'} — <a class="hint-link" href="/login">Sign in</a>
			</div>
		{/if}
	</div>
	{#if broadcast.description}
		<div class="episode-desc">{@html broadcast.description}</div>
	{/if}
	<h2>Tracklist</h2>
	{#if tracks.length}
		<div class="tracklist-scroll">
			<ol class="tracklist">
			{#each tracks as t, i (t.id)}
				{#if t.url && isBandcampPageUrl(t.url)}
					<li class="track-row">
						<span class="num">{i + 1}</span>
						{#if rowArt(t)}
							<img class="bc-art" src={rowArt(t)} alt="" width="28" height="28" loading="lazy" />
						{/if}
						<button
							class="track-play"
							class:playing={trackPlaying(t.id)}
							disabled={resolving[t.id]}
							aria-label={`${trackPlaying(t.id) ? 'Pause' : 'Play'} ${t.title || `track ${i + 1}`}`}
							onclick={() => playTrack(t)}
						>
							{#if resolving[t.id]}
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
							{:else if trackPlaying(t.id)}
								<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5.2a1 1 0 0 1 2 0v13.6a1 1 0 0 1-2 0zM15 5.2a1 1 0 0 1 2 0v13.6a1 1 0 0 1-2 0z" fill="currentColor" /></svg>
							{:else}
								<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.4v13.2a1 1 0 0 0 1.53.85l10.6-6.6a1 1 0 0 0 0-1.7L9.53 4.55A1 1 0 0 0 8 5.4z" fill="currentColor" /></svg>
							{/if}
						</button>
						<span class="bc-title">{trackMeta[t.id]?.title || t.title || `Track ${i + 1}`}</span>
						{#if trackMeta[t.id]?.artist || t.artist}
							<span class="artist">{trackMeta[t.id]?.artist || t.artist}</span>
						{/if}
						{#if trackError[t.id]}
							<span class="track-err" title={trackError[t.id]}>{trackError[t.id]}</span>
						{/if}
						<a class="url-fallback" href={t.url} target="_blank" rel="noopener noreferrer">
							Bandcamp <span class="arrow-chip" aria-hidden="true">↗︎</span>
						</a>
					</li>
				{:else}
					<li>
						<span class="num">{i + 1}</span>
						{#if t.title}
							<span class="track-title">{t.title}</span>
						{/if}
						{#if t.artist}
							<span class="artist">{t.artist}</span>
						{/if}
						{#if t.album}
							<span class="album">{t.album}</span>
						{/if}
						{#if t.url}
							<a class="url-fallback" href={t.url} target="_blank" rel="noopener noreferrer" title={t.url}>
								<span class="url-host">{hostOf(t.url)}</span>
								<span class="arrow-chip" aria-hidden="true">↗︎</span>
							</a>
						{/if}
					</li>
				{/if}
			{/each}
			</ol>
		</div>
	{:else}
		<p class="hint">No tracklist for this broadcast.</p>
	{/if}
</section>

{#if lightboxOpen}
	<div
		class="lightbox"
		role="dialog"
		aria-modal="true"
		aria-label="Full artwork"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget) lightboxOpen = false;
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') lightboxOpen = false;
		}}
	>
		{#if artUrl}
			<img src={artUrl} alt="" onerror={(e) => artOnError(e, artFallback)} />
		{/if}
		<button class="lightbox-close" aria-label="Close" onclick={() => (lightboxOpen = false)}>
			<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
				<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
			</svg>
		</button>
	</div>
{/if}
</div>

<style>
	.page {
		padding: var(--vr-pad);
		max-width: 56rem;
	}

	.page-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 0.4em;
		cursor: pointer;
		color: var(--vr-muted);
		text-decoration: none;
		font-size: 0.82rem;
	}

	.back:hover {
		color: var(--vr-text);
		text-decoration: underline;
	}

	.meta {
		color: var(--vr-muted);
		margin: 0.75rem 0 1.75rem;
	}

	.card {
		border: 1px solid var(--vr-line);
		background: var(--vr-surface);
		padding: 1.25rem 1.5rem;
	}

	.card h2 {
		font-family: var(--vr-font-mono);
		font-size: 0.82rem;
		font-weight: 500;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		margin: 0 0 1rem;
		border-bottom: 1px solid var(--vr-line);
		padding-bottom: 0.6rem;
	}

	.tracklist {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.tracklist li {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		padding: 0.45rem 0;
		border-bottom: 1px solid var(--vr-line-muted);
		font-size: 0.95rem;
	}

	.tracklist li:last-child {
		border-bottom: none;
	}

	.num {
		color: var(--vr-faint);
		font-family: var(--vr-font-mono);
		font-size: 0.78rem;
		width: 1.5rem;
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
	}

	.artist,
	.album {
		color: var(--vr-muted);
		font-size: 0.85rem;
	}

	.url-fallback {
		color: var(--vr-text);
		text-decoration: underline;
		font-size: 0.9rem;
		margin-left: 0.5rem;
	}

	.tracklist li.track-row {
		align-items: center;
	}

	.bc-art {
		width: 28px;
		height: 28px;
		object-fit: cover;
		flex-shrink: 0;
		border: 1px solid var(--vr-line-muted);
	}

	.track-play {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		flex-shrink: 0;
		border: 1px solid var(--vr-line);
		background: transparent;
		color: var(--vr-text);
		cursor: pointer;
		padding: 0;
	}

	.track-play svg {
		width: 15px;
		height: 15px;
		display: block;
	}

	.track-play:hover,
	.track-play.playing {
		background: var(--vr-text);
		color: var(--vr-black);
	}

	.track-play:disabled {
		cursor: default;
		opacity: 0.7;
	}

	/* Same triangle-trace loading animation as the global player. */
	.track-play svg.trace .trace-path {
		stroke-dasharray: 34 66;
		animation: trace-loop 1.8s linear infinite;
	}

	@keyframes trace-loop {
		from {
			stroke-dashoffset: 0;
		}
		to {
			stroke-dashoffset: 100;
		}
	}

	.bc-title {
		font-weight: 500;
	}

	.track-err {
		color: var(--vr-muted);
		font-size: 0.8rem;
	}

	.hint {
		color: var(--vr-muted);
	}

	.replay {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		margin-bottom: 0.25rem;
	}

	.episode-desc {
		margin: 0 0 1rem;
		color: var(--vr-muted);
		line-height: 1.55;
	}

	.episode-desc :global(p) {
		margin: 0 0 0.5rem;
	}

	.episode-desc :global(p:last-child) {
		margin-bottom: 0;
	}

	.episode-desc :global(a) {
		color: var(--vr-green);
		text-decoration: underline;
	}

	.episode-desc :global(ul),
	.episode-desc :global(ol) {
		margin: 0 0 0.5rem;
		padding-left: 1.25rem;
	}

	.episode-desc :global(h1),
	.episode-desc :global(h2),
	.episode-desc :global(h3),
	.episode-desc :global(h4) {
		color: var(--vr-text);
		margin: 0.75rem 0 0.4rem;
		font-size: 1.1rem;
	}

	.episode-desc :global(code) {
		font-family: var(--vr-font-mono);
		background: var(--vr-surface-high);
		padding: 0.1rem 0.3rem;
	}

	.episode-desc :global(pre) {
		background: var(--vr-surface-high);
		padding: 0.75rem;
		overflow-x: auto;
	}

	.episode-desc :global(blockquote) {
		margin: 0.5rem 0;
		padding-left: 0.75rem;
		border-left: 2px solid var(--vr-line);
	}

	.hint-row {
		flex-basis: 100%;
	}

	.login-hint {
		border: 1px solid var(--vr-line);
		background: var(--vr-surface-low);
		color: var(--vr-muted);
		padding: 0.5rem 0.7rem;
		font-size: 0.85rem;
		max-width: 100%;
	}

	.hint-link {
		color: var(--vr-text);
		text-decoration: underline;
		font-weight: 600;
	}

	.replay-art {
		width: 80px;
		height: 80px;
		object-fit: cover;
		border: 1px solid var(--vr-line-muted);
		flex-shrink: 0;
	}

	.replay-art-fallback {
		display: grid;
		place-items: center;
		background: #000;
		color: var(--vr-text);
	}

	.replay-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		border: 1px solid var(--vr-line);
		background: transparent;
		color: var(--vr-text);
		font-family: var(--vr-font-mono);
		font-size: 0.75rem;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		padding: 0.35rem 0.9rem;
		cursor: pointer;
	}

	.replay-btn svg {
		width: 13px;
		height: 13px;
		display: block;
		margin-top: 1px;
		flex-shrink: 0;
	}

	.replay-btn:hover {
		background: var(--vr-text);
		color: var(--vr-black);
	}

	.replay-btn.playing {
		background: var(--vr-text);
		color: var(--vr-black);
	}

	/* Retired-server replay: state it plainly instead of a button that 404s. */
	.replay-unavailable {
		display: inline-flex;
		align-items: center;
		border: 1px dashed var(--vr-line-muted);
		color: var(--vr-faint);
		font-family: var(--vr-font-mono);
		font-size: 0.75rem;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		padding: 0.35rem 0.9rem;
		white-space: nowrap;
	}

	@media (max-width: 640px) {
		.card {
			margin-left: calc(-1 * var(--vr-pad));
			margin-right: calc(-1 * var(--vr-pad));
		}

		.tracklist-scroll {
			overflow-x: auto;
			-webkit-overflow-scrolling: touch;
			scrollbar-width: thin;
			margin: 0 -1.5rem;
			padding: 0 1.5rem;
		}

		.tracklist {
			width: max-content;
			min-width: 100%;
		}
	}

	.art-btn {
		border: none;
		padding: 0;
		background: none;
		line-height: 0;
		cursor: zoom-in;
		flex-shrink: 0;
	}

	.art-btn:hover .replay-art {
		box-shadow: 0 0 0 2px var(--vr-text);
	}

	.lightbox {
		position: fixed;
		inset: 0;
		z-index: 60;
		background: rgba(0, 0, 0, 0.9);
		display: grid;
		place-items: center;
		padding: 1.5rem;
	}

	.lightbox img {
		max-width: 92vw;
		max-height: 88vh;
		width: auto;
		height: auto;
		object-fit: contain;
		display: block;
		border: 1px solid var(--vr-line);
	}

	.lightbox-close {
		position: absolute;
		top: 1rem;
		right: 1rem;
		width: 40px;
		height: 40px;
		display: grid;
		place-items: center;
		border: 1px solid var(--vr-line);
		background: var(--vr-bg);
		color: var(--vr-text);
		cursor: pointer;
	}

	.lightbox-close:hover {
		background: var(--vr-text);
		color: var(--vr-black);
	}
</style>
