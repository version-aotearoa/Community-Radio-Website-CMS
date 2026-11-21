<script lang="ts">
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Text, Field, Button } from '@svar-ui/svelte-core';
	import ShowActions from '$lib/components/ShowActions.svelte';
	import ArrowChip from '$lib/components/ArrowChip.svelte';
	import RichTextEditor from '$lib/components/RichTextEditor.svelte';
	import { playback, playMedia, requestSetPlaying, streamPlaying } from '$lib/stores/player';
	import { EVENT_TYPES, eventTypeLabel } from '$lib/eventTypes';
	import { episodeArtOrDefault } from '$lib/azuracast';
	import { probeReplayAvailability, unavailableReplays } from '$lib/replayAvailability';
	import { artOnError } from '$lib/art';
	import Seo from '$lib/components/Seo.svelte';

	let { data } = $props();

	const show = $derived(data.show);
	const upcoming = $derived(data.upcoming);
	const past = $derived(data.past);

	// Replay availability is probed after paint (never during render).
	onMount(() => {
		probeReplayAvailability([...data.upcoming, ...data.past].map((b) => b.replay_url));
		// Deferred past the navigation's microtasks: an immediate invalidateAll
		// aborts the in-flight navigation before SvelteKit resets scroll to top.
		setTimeout(() => void invalidateAll(), 0);
	});

	let title = $state('');
	let description = $state('');
	let pageContent = $state('');
	let djName = $state<string | null>('');
	let djId = $state('');
	let djHandle = $state('');
	let eventType = $state('');

	// Seed + sync the edit/display buffer from the server show data. Reading
	// `data.show` here (inside the effect) keeps the state reactive to fresh
	// loads without a stale untrack snapshot.
	$effect(() => {
		title = data.show.title;
		description = data.show.description ?? '';
		pageContent = data.show.page_content ?? '';
		djName = data.show.dj_name ?? '';
		djId = data.show.dj_id;
		djHandle = data.show.dj_handle ?? '';
		eventType = data.show.event_type ?? '';
	});

	let editing = $state(false);
	let saving = $state(false);
	let editError = $state('');
	let editSaved = $state(false);

	const isAdmin = $derived(data.user?.role === 'admin');

	interface DjOption {
		id: string;
		name: string;
		email: string;
	}

	let djOptions = $state<DjOption[]>([]);

	async function startEdit() {
		editing = true;
		saving = false;
		editError = '';
		editSaved = false;
		title = data.show.title;
		description = data.show.description ?? '';
		pageContent = data.show.page_content ?? '';
		djId = data.show.dj_id;
		djHandle = data.show.dj_handle ?? '';
		eventType = data.show.event_type ?? '';
		if (isAdmin && djOptions.length === 0) {
			const res = await fetch('/api/admin/users');
			if (res.ok) {
				const users = (await res.json()) as {
					id: string;
					name: string;
					email: string;
					role: string;
				}[];
				djOptions = users.filter((u) => u.role === 'dj' || u.role === 'admin');
			}
		}
	}

	async function saveEdit() {
		saving = true;
		editError = '';
		editSaved = false;
		const body: Record<string, string> = { title, description, pageContent, djHandle };
		if (isAdmin) body.djId = djId;
		if (show.kind === 'event') body.eventType = eventType;
		const res = await fetch(`/api/shows/${data.show.id}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		saving = false;
		if (!res.ok) {
			const err = (await res.json().catch(() => null)) as { error?: string } | null;
			editError = err?.error ?? `Save failed (${res.status})`;
			return;
		}
		await invalidateAll();
		title = data.show.title;
		description = data.show.description ?? '';
		pageContent = data.show.page_content ?? '';
		djName = data.show.dj_name;
		djId = data.show.dj_id;
		djHandle = data.show.dj_handle ?? '';
		editing = false;
		editSaved = true;
		setTimeout(() => (editSaved = false), 4000);
	}

	const backHref = $derived(
		page.url.searchParams.get('from') === 'schedule' ? '/schedule' : '/shows'
	);
	const backLabel = $derived(backHref === '/schedule' ? 'Schedule' : 'Shows');

	const eventDate = $derived(
		show.kind === 'event' ? (upcoming[0]?.date ?? past[0]?.date ?? null) : null
	);

	const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

	function fmtTime(mins: number) {
		const h = Math.floor(mins / 60);
		const m = mins % 60;
		return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
	}

	function fmtDuration(mins: number) {
		const h = Math.floor(mins / 60);
		const m = mins % 60;
		if (h === 0) return `${m} min`;
		return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
	}

	function fmtDate(dateStr: string) {
		return new Intl.DateTimeFormat('en-NZ', {
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			timeZone: 'UTC'
		}).format(new Date(`${dateStr}T00:00:00Z`));
	}

	/** Compact card date: YYYY-MM-DD → DD-MM-YY. */
	function fmtCardDate(dateStr: string) {
		const [y, m, d] = dateStr.split('-');
		return `${d}-${m}-${y.slice(2)}`;
	}

	function cycleWeeksLabel(): string {
		const weeks = data.showCycleWeeks;
		if (weeks.length === 1) return `week ${weeks[0]}`;
		return `weeks ${weeks.join(' & ')}`;
	}

	function toggleReplay(b: { id: string; replay_url: string | null; date: string }) {
		if (!b.replay_url || $unavailableReplays.has(b.replay_url)) return;
		if (replayActive(b.replay_url)) {
			requestSetPlaying(false);
			return;
		}
		playMedia({
			url: b.replay_url,
			title: show.title,
			artist: show.kind === 'event' ? null : (show.dj_name ?? null),
			art: episodeArtOrDefault(b.id, b, show),
			show: { id: show.id, title: show.title },
			href: `/shows/${show.id}/${b.id}`,
			broadcastId: b.id,
			date: b.date
		});
	}

	function replayActive(url: string | null): boolean {
		if (!url) return false;
		const current = $playback;
		return current.kind === 'media' && current.url === url && $streamPlaying;
	}
</script>

<svelte:head>
	<title>{title} — Version Radio</title>
</svelte:head>

<Seo
	title={data.show.title}
	description={data.show.pageContentText || data.show.description || undefined}
	image={data.show.image}
	url={page.url.pathname}
/>

<div class="page">
	<header class="head">
		<div>
			<a class="back mono" href={backHref}><ArrowChip dir="left" /> {backLabel}</a>
			<h1 class="h-lg">{title}</h1>
			{#if show.kind === 'event'}
				{#if eventDate}
					<p class="subtitle mono">{fmtDate(eventDate)}</p>
				{/if}
				{#if eventTypeLabel(show.event_type)}
					<p class="event-type mono">{eventTypeLabel(show.event_type)}</p>
				{/if}
			{:else}
				<p class="subtitle mono">
					{DAY_NAMES[show.day_of_week]}s · {fmtTime(show.start_minutes)}–{fmtTime(
						show.start_minutes + show.duration_minutes
					)}{#if show.interval_weeks === 1} · Every week{/if}
				</p>
				{#if data.showCycleWeeks.length > 0}
					<p class="cycle-line mono">
						Show airs {cycleWeeksLabel()} of 4 — current cycle week {data.currentCycleWeek}
					</p>
				{/if}
			{/if}
			{#if djName && show.kind !== 'event'}
				<p class="dj mono">with {djName}</p>
			{/if}
			{#if show.paused}
				<p class="break-banner mono">
					{#if show.paused_until}
						On break until {fmtDate(show.paused_until)}
					{:else}
						On break — episodes return when the show resumes
					{/if}
				</p>
			{/if}
			{#if editing}
				<form class="edit-form" onsubmit={(e) => { e.preventDefault(); saveEdit(); }}>
					<Field label="Title">
						<Text bind:value={title} css="vr-input" />
					</Field>
					<Field label="DJ name">
						<Text
							bind:value={djHandle}
							css="vr-input"
							placeholder={data.show.dj_name ?? 'e.g. LLUSH'}
						/>
					</Field>
					{#if isAdmin}
						<Field label="DJ">
							<select class="dj-select" bind:value={djId}>
								{#if !djOptions.some((d) => d.id === djId)}
									<option value={djId} disabled>Unknown DJ</option>
								{/if}
								{#each djOptions as dj (dj.id)}
									<option value={dj.id}>{dj.name || dj.email}</option>
								{/each}
							</select>
						</Field>
					{/if}
					{#if show.kind === 'event'}
						<Field label="Event type">
							<select class="dj-select" bind:value={eventType}>
								<option value="">None</option>
								{#each EVENT_TYPES as t (t.id)}
									<option value={t.id}>{t.label}</option>
								{/each}
							</select>
						</Field>
					{/if}
					<Field label="Description (card blurb)">
						<input
							class="vr-input"
							maxlength={50}
							style="width:100%"
							bind:value={description}
							placeholder="Short blurb, max 50 chars"
						/>
					</Field>
					<Field label="Page content">
						<RichTextEditor bind:value={pageContent} placeholder="Show page content (rich text)" />
					</Field>
					{#if editError}
						<div class="notice bad">{editError}</div>
					{/if}
					<div class="edit-actions">
						<Button css="vr-cta" type="primary" disabled={saving} onclick={saveEdit}>
							{saving ? 'Saving…' : 'Save'}
						</Button>
						<Button css="vr-cta ghost" onclick={() => (editing = false)}>Cancel</Button>
					</div>
				</form>
			{:else}
				{#if pageContent}
					<div class="desc">{@html pageContent}</div>
				{/if}
				{#if editSaved}
					<div class="notice ok">Saved</div>
				{/if}
			{/if}
		</div>
		<div class="head-actions">
			<ShowActions
				showId={show.id}
				showTitle={title}
				followed={data.followed}
				user={data.user}
			/>
			{#if data.canEdit}
				<button class="btn-outline" onclick={startEdit} disabled={editing}>Edit show</button>
			{/if}
		</div>
	</header>

	{#if upcoming.length > 0}
		<section class="block">
			<h2 class="h-md">Upcoming</h2>
			<ul class="broadcasts upcoming-list">
				{#each upcoming as b (b.id)}
					<li class="broadcast" class:today={b.date === data.today}>
						<header>
							{#if b.title}
								<strong>{b.title}</strong>
								<span class="mono">
									{fmtCardDate(b.date)} · {fmtTime(b.start_minutes)}–{fmtTime(
										b.start_minutes + b.duration_minutes
									)}
								</span>
							{:else}
								<strong>{fmtCardDate(b.date)}</strong>
								<span class="mono">
									{fmtTime(b.start_minutes)}–{fmtTime(b.start_minutes + b.duration_minutes)}
								</span>
							{/if}
						{#if b.cancelled}
							<span class="tag-cancelled mono">Cancelled</span>
						{/if}
					</header>
					<div class="replay">
						<a class="view-show mono" href={`/shows/${show.id}/${b.id}`}>View <ArrowChip dir="right" /></a>
					</div>
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if past.length > 0}
		<section class="block">
			<h2 class="h-md">{show.kind === 'event' ? 'Broadcast recording' : 'Past broadcasts'}</h2>
			<ul class="broadcasts past-list">
				{#each past as b, i (b.id)}
					{@const epArt = episodeArtOrDefault(b.id, b, show)}
					{@const epArtFb = [show.image, show.dj_image]}
					<li class="broadcast past">
						<a
							class="past-art"
							href={`/shows/${show.id}/${b.id}`}
							aria-label={`View ${b.title ?? fmtDate(b.date)} episode`}
						>
							{#if epArt}
								<img
									src={epArt}
									alt=""
									loading="lazy"
									onerror={(e) => artOnError(e, epArtFb)}
								/>
							{:else}
								<span class="past-art-fallback" aria-hidden="true">
									<svg viewBox="0 0 80 70" fill="currentColor" width="36" height="31">
										<path
											fill-rule="evenodd"
											d="M0 0H40V40H50V0H80V45H70V60H55V70H25V60H10V45H0V5ZM10 5H5V40H15V55H30V65H50V55H65V40H75V5H55V45H35V5H15Z"
										/>
									</svg>
								</span>
							{/if}
						</a>
						<div class="past-body">
							<header>
								{#if b.title}
									<strong>{b.title}</strong>
								{/if}
								{#if b.cancelled}
									<span class="tag-cancelled mono">Cancelled</span>
								{/if}
								<span class="mono">{fmtCardDate(b.date)}</span>
							</header>
							<div class="replay">
								{#if b.replay_url && $unavailableReplays.has(b.replay_url)}
									<span
										class="replay-unavailable"
										title="This recording is no longer available"
										>No longer available</span
									>
								{:else if b.replay_url}
									<button class="replay-btn" class:playing={replayActive(b.replay_url)} onclick={() => toggleReplay(b)}>
										{#if replayActive(b.replay_url)}
											<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5.2a1 1 0 0 1 2 0v13.6a1 1 0 0 1-2 0zM15 5.2a1 1 0 0 1 2 0v13.6a1 1 0 0 1-2 0z" fill="currentColor" /></svg>
											Pause
										{:else}
											<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.4v13.2a1 1 0 0 0 1.53.85l10.6-6.6a1 1 0 0 0 0-1.7L9.53 4.55A1 1 0 0 0 8 5.4z" fill="currentColor" /></svg>
											Replay
										{/if}
									</button>
								{/if}
								<a class="view-show mono" href={`/shows/${show.id}/${b.id}`}>View <ArrowChip dir="right" /></a>
							</div>
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if upcoming.length === 0 && past.length === 0}
		<p class="hint mono">No scheduled broadcasts yet.</p>
	{/if}
</div>

<style>
	.page {
		padding: var(--vr-pad);
	}

	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		margin-bottom: 1.75rem;
	}

	.head-actions {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.6rem;
		flex-shrink: 0;
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 0.4em;
		margin: 0 0 0.5rem;
		padding: 0.25rem 0;
		cursor: pointer;
		color: var(--vr-muted);
		text-decoration: none;
	}

	.back:hover {
		color: var(--vr-text);
		text-decoration: underline;
	}

	.head h1 {
		margin: 0;
	}

	.subtitle {
		margin: 0.75rem 0 0;
		color: var(--vr-muted);
		font-variant-numeric: tabular-nums;
	}

	.dj {
		margin: 0.4rem 0 0;
		color: var(--vr-faint);
	}

	.event-type {
		display: inline-block;
		margin: 0.6rem 0 0;
		padding: 0.2rem 0.5rem;
		border: 1px solid var(--vr-line);
		color: var(--vr-text);
	}

	.cycle-line {
		margin: 0.4rem 0 0;
		color: var(--vr-faint);
	}

	.desc {
		margin: 0.85rem 0 0;
		color: var(--vr-muted);
		max-width: 44rem;
	}

	.desc :global(p) {
		margin: 0 0 0.5rem;
	}

	.desc :global(p:last-child) {
		margin-bottom: 0;
	}

	.desc :global(a) {
		color: var(--vr-green);
		text-decoration: underline;
	}

	.desc :global(ul),
	.desc :global(ol) {
		margin: 0 0 0.5rem;
		padding-left: 1.25rem;
	}

	.desc :global(h1),
	.desc :global(h2),
	.desc :global(h3),
	.desc :global(h4) {
		color: var(--vr-text);
		margin: 0.75rem 0 0.4rem;
		font-size: 1.1rem;
	}

	.desc :global(code) {
		font-family: var(--vr-font-mono);
		background: var(--vr-surface-high);
		padding: 0.1rem 0.3rem;
	}

	.desc :global(pre) {
		background: var(--vr-surface-high);
		padding: 0.75rem;
		overflow-x: auto;
	}

	.desc :global(blockquote) {
		margin: 0.5rem 0;
		padding-left: 0.75rem;
		border-left: 2px solid var(--vr-line);
	}

	.edit-form {
		margin-top: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		max-width: 28rem;
	}

	.dj-select {
		background: var(--vr-surface-low);
		color: var(--vr-text);
		border: 1px solid var(--vr-line);
		padding: 0.4rem 0.5rem;
		width: 100%;
	}

	.edit-actions {
		display: flex;
		gap: 0.6rem;
		margin-top: 0.25rem;
	}

	.notice {
		padding: 0.5rem 0.8rem;
		border: 1px solid var(--vr-line);
		font-size: 0.85rem;
	}

	.notice.ok {
		color: var(--vr-green);
	}

	.notice.bad {
		color: var(--vr-red);
	}

	.block {
		margin-top: 1.5rem;
	}

	.block h2 {
		margin: 0 0 0.75rem;
		border-bottom: 1px solid var(--vr-line);
		padding-bottom: 0.5rem;
	}

	.broadcast {
		border: 1px solid var(--vr-line-muted);
		background: var(--vr-surface-low);
		padding: 1rem 1.25rem 1.1rem;
	}

	.broadcasts {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	/* Desktop: the upcoming card takes half the content width, and past
	   broadcasts sit two-up. Mobile keeps the single full-width column. */
	@media (min-width: 641px) {
		.upcoming-list {
			width: 50%;
		}

		.past-list {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.past-list > li {
			min-width: 0;
		}
	}

	/* Wide desktop: episode cards go three-up. The title/date row stays on one
	   line so the date keeps its top-right corner (see header rules below). */
	@media (min-width: 1000px) {
		.past-list {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}

	.broadcast.today {
		border-color: var(--vr-line);
		background: var(--vr-surface-high);
	}

	.broadcast header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 1rem;
	}

	.broadcast header strong {
		font-family: var(--vr-font-body);
		font-weight: 600;
		/* Long titles wrap inside their own column instead of pushing the date
		   off its top-right corner. */
		min-width: 0;
	}

	/* The date/time keeps a single line at the card's top-right, even when the
	   episode has no title and it is the header's only item. */
	.broadcast header > span:not(.tag-cancelled) {
		flex-shrink: 0;
		white-space: nowrap;
		margin-left: auto;
	}

	.broadcast header span {
		color: var(--vr-green);
		font-variant-numeric: tabular-nums;
	}

	.broadcast:not(.today) header span {
		color: var(--vr-muted);
	}

	.break-banner {
		margin: 0.5rem 0 0;
		padding: 0.4rem 0.7rem;
		border: 1px dashed var(--vr-line);
		background: var(--vr-surface-low);
		color: var(--vr-muted);
		font-size: 0.75rem;
		display: inline-block;
	}

	.tag-cancelled {
		font-size: 0.68rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--vr-faint);
		border: 1px dashed var(--vr-line-muted);
		padding: 0.15rem 0.4rem;
		white-space: nowrap;
	}

	.hint {
		color: var(--vr-muted);
		font-size: 0.9rem;
		margin: 0;
	}

	.replay {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-top: 0.85rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--vr-line-muted);
	}

	.broadcast.past {
		display: flex;
		align-items: stretch;
		gap: 1rem;
		padding: 0;
		overflow: hidden;
	}

	/* Fixed square art. Sizing it from the body height created a feedback loop
	   (art wider → body narrower → text taller → art taller), which could grow
	   the image until it swallowed the card when the window was resized. */
	.broadcast.past .past-art {
		flex: 0 0 auto;
		width: 8rem;
		height: 8rem;
		align-self: center;
		display: block;
		background: var(--vr-surface-highest);
	}

	.broadcast.past .past-art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.past-art-fallback {
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
		background: #000;
		color: var(--vr-text);
	}

	.broadcast.past .past-body {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		flex-direction: column;
		justify-content: center;
		padding: 0.9rem 1.1rem 0.9rem 0;
	}

	@media (max-width: 640px) {
		/* Equal card heights on phones: the square art is sized from the body,
		   so a shared min-height keeps every thumbnail the same size whether or
		   not the episode has a title. */
		.broadcast.past {
			min-height: 8.125rem;
			gap: 0.75rem;
		}

		/* Phones: the date sits on the first row, top-left, above the title
		   (the same order the Episodes list uses). The Cancelled tag stays
		   below the title. */
		.broadcast header {
			flex-direction: column;
			align-items: flex-start;
			gap: 0.15rem;
		}

		.broadcast.past header > span:not(.tag-cancelled) {
			order: -1;
		}

		/* Stacked cards are left-aligned, including the upcoming card's time. */
		.broadcast header > span:not(.tag-cancelled) {
			margin-left: 0;
		}

		/* A very long title can't grow the card beyond its neighbours. */
		.broadcast.past header strong {
			display: -webkit-box;
			-webkit-line-clamp: 2;
			line-clamp: 2;
			-webkit-box-orient: vertical;
			overflow: hidden;
		}

		/* Top-align the card body: with a shared min-height, centring pushed
		   untitled cards' dates further down than titled ones. */
		.broadcast.past .past-body {
			justify-content: flex-start;
		}

		/* Date/title stay at the top; Replay/View stay pinned to the bottom. */
		.broadcast.past .past-body .replay {
			margin-top: auto;
		}
	}

	.replay-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		border: 1px solid var(--vr-line);
		background: transparent;
		color: var(--vr-text);
		padding: 0.4rem 0.9rem;
		font-size: 0.75rem;
		font-family: var(--vr-font-mono);
		letter-spacing: 0.05em;
		text-transform: uppercase;
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
		padding: 0.4rem 0.9rem;
		font-size: 0.75rem;
		font-family: var(--vr-font-mono);
		letter-spacing: 0.05em;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.view-show {
		color: var(--vr-green);
		font-size: 0.8rem;
		text-decoration: none;
		margin-left: auto;
		white-space: nowrap;
	}

	.view-show:hover {
		text-decoration: underline;
	}
</style>
