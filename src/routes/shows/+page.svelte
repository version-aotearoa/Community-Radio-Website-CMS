<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import Seo from '$lib/components/Seo.svelte';
	import { EVENT_TYPES, eventTypeLabel } from '$lib/eventTypes';

	let { data } = $props();

	let filter = $state<'all' | 'shows' | 'events'>('all');
	let eventTypeFilter = $state<'all' | string>('all');
	let sort = $state<'az' | 'za' | 'schedule' | 'date'>('az');

	type SortOption = { value: 'az' | 'za' | 'schedule' | 'date'; label: string };

	const sortOptions = $derived<SortOption[]>(
		filter === 'events'
			? [
					{ value: 'az', label: 'A–Z' },
					{ value: 'za', label: 'Z–A' },
					{ value: 'date', label: 'Event date' }
				]
			: [
					{ value: 'az', label: 'A–Z' },
					{ value: 'za', label: 'Z–A' },
					{ value: 'schedule', label: 'Day & time' }
				]
	);

	$effect(() => {
		if (!sortOptions.some((o) => o.value === sort)) {
			sort = filter === 'events' ? 'date' : 'az';
		}
		if (filter !== 'events' && eventTypeFilter !== 'all') {
			eventTypeFilter = 'all';
		}
	});

	const allShows = $derived([...data.shows]);

	const filtered = $derived(
		filter === 'all'
			? allShows
			: allShows.filter((s) => (filter === 'events' ? s.kind === 'event' : s.kind !== 'event'))
	);

	function dateCmp(a: { anchor_date: string | null; start_minutes: number; title: string }, b: {
		anchor_date: string | null;
		start_minutes: number;
		title: string;
	}) {
		const da = a.anchor_date ?? '';
		const db = b.anchor_date ?? '';
		if (da !== db) return da < db ? -1 : 1;
		if (a.start_minutes !== b.start_minutes) return a.start_minutes - b.start_minutes;
		return a.title.localeCompare(b.title);
	}

	function scheduleCmp(
		a: { kind: string; day_of_week: number; start_minutes: number; anchor_date: string | null; title: string },
		b: { kind: string; day_of_week: number; start_minutes: number; anchor_date: string | null; title: string }
	) {
		// Mixed views (All): events trail after the regular shows, by date.
		if (a.kind !== b.kind) return a.kind === 'event' ? 1 : -1;
		if (a.kind === 'event') return dateCmp(a, b);
		if (a.day_of_week !== b.day_of_week) return a.day_of_week - b.day_of_week;
		if (a.start_minutes !== b.start_minutes) return a.start_minutes - b.start_minutes;
		return a.title.localeCompare(b.title);
	}

	const visible = $derived.by(() => {
		const list =
			eventTypeFilter === 'all'
				? filtered
				: allShows.filter((s) => s.kind === 'event' && s.event_type === eventTypeFilter);
		if (sort === 'za') return [...list].sort((a, b) => b.title.localeCompare(a.title));
		if (sort === 'schedule') return [...list].sort(scheduleCmp);
		if (sort === 'date') return [...list].sort(dateCmp);
		return [...list].sort((a, b) => a.title.localeCompare(b.title));
	});

	// Fresh server data on every visit — the DB is the source of truth
	// (SPA navigation otherwise reuses the initial SSR snapshot, so edited
	// show cards stay stale until a full reload).
	onMount(() => {
		// Deferred past the navigation's microtasks: an immediate invalidateAll
		// aborts the in-flight navigation before SvelteKit resets scroll to top.
		setTimeout(() => void invalidateAll(), 0);
	});

	const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

	const ORDINALS = ['1st', '2nd', '3rd', '4th'];

	function airLabel(show: { day_of_week: number; showCycleWeeks: number[] }) {
		const day = DAY_NAMES[show.day_of_week];
		const weeks = show.showCycleWeeks;
		if (weeks.length === 0) return `Every ${day}`;
		return `Every ${weeks.map((w) => ORDINALS[w - 1]).join(' & ')} ${day}`;
	}

	function fmtDate(dateStr: string | null) {
		if (!dateStr) return '';
		return new Intl.DateTimeFormat('en-NZ', {
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			timeZone: 'UTC'
		}).format(new Date(`${dateStr}T00:00:00Z`));
	}
</script>

<svelte:head>
	<title>Shows — Version Radio</title>
</svelte:head>

<Seo />

<div class="page">
	<header class="head">
		<h1 class="h-lg">Shows</h1>
		<p class="subtitle mono">Browse the Version Radio lineup — each show has its own page and tracklists.</p>
	</header>

	<div class="toolbar">
		<div class="filter-stack">
			<div class="filter-btns" role="group" aria-label="Filter shows">
				<button class="filter-btn" class:active={filter === 'all'} onclick={() => (filter = 'all')}>
					All
				</button>
				<button class="filter-btn" class:active={filter === 'shows'} onclick={() => (filter = 'shows')}>
					Shows
				</button>
				<button class="filter-btn" class:active={filter === 'events'} onclick={() => (filter = 'events')}>
					Events
				</button>
			</div>
			{#if filter === 'events'}
				<div class="filter-btns event-filters" role="group" aria-label="Filter events by type">
					<span class="filter-label mono">Type</span>
					<button
						class="filter-btn"
						class:active={eventTypeFilter === 'all'}
						onclick={() => (eventTypeFilter = 'all')}
					>
						All
					</button>
					{#each EVENT_TYPES as t (t.id)}
						<button
							class="filter-btn"
							class:active={eventTypeFilter === t.id}
							onclick={() => (eventTypeFilter = t.id)}
						>
							{t.label}
						</button>
					{/each}
				</div>
			{/if}
		</div>
		<div class="sort-control">
			<label class="sort-label mono" for="show-sort">Sort</label>
			<select id="show-sort" class="sort-select" bind:value={sort}>
				{#each sortOptions as opt (opt.value)}
					<option value={opt.value}>{opt.label}</option>
				{/each}
			</select>
		</div>
	</div>

	{#if visible.length === 0}
		<p class="empty mono">
			{filter === 'events' ? 'No events yet.' : filter === 'shows' ? 'No regular shows yet.' : 'No shows yet.'}
		</p>
	{:else}
		<ul class="grid">
			{#each visible as show (show.id)}
				<li>
					<a class="card" href={`/shows/${show.id}`}>
						<div class="card-img" class:empty={!show.image && !(show.kind !== 'event' && show.dj_image)}>
							{#if show.image}
								<img src={show.image} alt="" loading="lazy" />
							{:else if show.kind !== 'event' && show.dj_image}
								<img src={show.dj_image} alt="" loading="lazy" />
							{:else}
								<svg viewBox="0 0 80 70" fill="currentColor" aria-hidden="true">
									<path
										fill-rule="evenodd"
										d="M0 0H40V40H50V0H80V45H70V60H55V70H25V60H10V45H0V5ZM10 5H5V40H15V55H30V65H50V55H65V40H75V5H55V45H35V5H15Z"
									/>
								</svg>
							{/if}
						</div>
						<div class="card-body">
							<p class="mono card-meta">
								{#if show.kind === 'event'}
									{#if eventTypeLabel(show.event_type)}<span class="event-tag">{eventTypeLabel(show.event_type)}</span>{/if}
									{fmtDate(show.anchor_date)}
								{:else}
									{airLabel(show)}{#if show.showCycleWeeks.length > 0}<span class="asterisk" aria-hidden="true">*</span>{/if}
									{#if show.paused}<span class="break-tag">On break</span>{/if}
								{/if}
							</p>
							<h2 class="h-md">{show.title}</h2>
							{#if show.dj_name && show.kind !== 'event'}
								<p class="dj mono">{show.dj_name}</p>
							{:else}
								<span class="dj-spacer" aria-hidden="true"></span>
							{/if}
						{#if show.description}
							<p class="desc">{show.description}</p>
						{/if}
						</div>
					</a>
				</li>
			{/each}
		</ul>
		{#if filter !== 'events'}
			<p class="cycle-foot mono"><span aria-hidden="true">*</span> of 4 week cycle</p>
		{/if}
	{/if}
</div>

<style>
	.page {
		padding: var(--vr-pad);
	}

	.head {
		margin: 0 0 1.5rem;
		border-bottom: 1px solid var(--vr-line);
		padding-bottom: 1rem;
	}

	.head h1 {
		margin: 0;
	}

	.subtitle {
		margin: 0.5rem 0 0;
		color: var(--vr-muted);
	}

	.empty {
		color: var(--vr-muted);
	}

	.toolbar {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1.5rem;
		flex-wrap: wrap;
		margin: 0 0 1.5rem;
	}

	.filter-stack {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.filter-btns {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.event-filters {
		align-items: center;
		margin: 0;
	}

	.filter-label {
		color: var(--vr-muted);
		font-size: 0.72rem;
		margin-right: 0.25rem;
	}

	.sort-control {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.sort-label {
		color: var(--vr-muted);
		font-size: 0.72rem;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.sort-select {
		background: var(--vr-surface-low);
		color: var(--vr-text);
		border: 1px solid var(--vr-line);
		padding: 0.35rem 0.5rem;
		font-family: var(--vr-font-mono);
		font-size: 0.72rem;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		cursor: pointer;
	}

	.sort-select option {
		background: var(--vr-surface);
	}

	.filter-btn {
		background: none;
		border: 1px solid var(--vr-line);
		color: var(--vr-muted);
		font-family: var(--vr-font-mono);
		font-size: 0.72rem;
		font-weight: 500;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		padding: 0.35rem 0.7rem;
		cursor: pointer;
	}

	.filter-btn:hover {
		color: var(--vr-text);
		border-color: var(--vr-text);
	}

	.filter-btn.active {
		background: var(--vr-text);
		color: var(--vr-black);
		border-color: var(--vr-text);
	}

	.grid {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		border: 1px solid var(--vr-line);
	}

	.card {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--vr-line);
		margin: -1px 0 0 -1px;
		background: var(--vr-surface);
		text-decoration: none;
		color: var(--vr-text);
		transition: color 150ms, background-color 150ms;
	}

	.card:hover {
		background: #fff;
		color: #000;
	}

	.card-img {
		aspect-ratio: 1.6;
		position: relative;
		background: var(--vr-surface-highest);
	}

	.card-img img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.card-img.empty {
		display: grid;
		place-items: center;
		background: #000;
		color: var(--vr-text);
	}

	.card-img.empty svg {
		width: 96px;
		height: 84px;
	}

	.card-body {
		padding: 1rem 1.1rem 1.2rem;
		min-width: 0;
	}

	.card-meta {
		margin: 0 0 0.5rem;
		color: var(--vr-muted);
		font-variant-numeric: tabular-nums;
	}

	.asterisk {
		color: var(--vr-green);
		margin-left: 0.25rem;
	}

	.event-tag {
		display: inline-block;
		margin-right: 0.5rem;
		padding: 0.1rem 0.4rem;
		border: 1px solid var(--vr-line-muted);
		color: var(--vr-text);
	}

	.card:hover .event-tag {
		border-color: rgba(0, 0, 0, 0.6);
		color: #000;
	}

	.break-tag {
		display: inline-block;
		margin-left: 0.5rem;
		padding: 0.1rem 0.4rem;
		border: 1px dashed var(--vr-line-muted);
		color: var(--vr-faint);
		font-size: 0.66rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.card:hover .break-tag {
		border-color: rgba(0, 0, 0, 0.6);
		color: rgba(0, 0, 0, 0.75);
	}

	.card:hover .card-meta {
		color: rgba(0, 0, 0, 0.75);
	}

	.cycle-foot {
		margin: 1rem 0 0;
		color: var(--vr-faint);
		font-size: 0.8rem;
	}

	.cycle-foot span {
		color: var(--vr-green);
	}

	.card-body h2 {
		margin: 0;
	}

	.dj {
		margin: 0.6rem 0 0;
		color: var(--vr-muted);
	}

	/* Reserves the DJ line's vertical space on cards without one so every
	   card in a grid row is equal height. 0.82rem (mono) × 1.15 (line-height). */
	.dj-spacer {
		display: block;
		height: 0.94rem;
		margin-top: 0.6rem;
	}

	.desc {
		margin: 0.5rem 0 0;
		color: var(--vr-muted);
		font-size: 0.9rem;
	}

	.card:hover .desc {
		color: rgba(0, 0, 0, 0.8);
	}
</style>
