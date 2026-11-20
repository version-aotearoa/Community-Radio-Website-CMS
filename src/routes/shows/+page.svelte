<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
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

	// ---- Episodes view (?view=episodes) ----
	const isEpisodes = $derived(data.view === 'episodes');
	let episodeShow = $state('all');
	let episodeYear = $state('all');

	const episodes = $derived(data.episodes ?? []);

	const episodeShows = $derived(
		[...new Map(episodes.map((e) => [e.show_id, e.show_title])).entries()]
			.map(([id, title]) => ({ id, title }))
			.sort((a, b) => a.title.localeCompare(b.title))
	);

	const episodeYears = $derived(
		[...new Set(episodes.map((e) => e.date.slice(0, 4)))].sort().reverse()
	);

	const visibleEpisodes = $derived(
		episodes.filter(
			(e) =>
				(episodeShow === 'all' || e.show_id === episodeShow) &&
				(episodeYear === 'all' || e.date.startsWith(episodeYear))
		)
	);

	function setView(next: 'shows' | 'episodes') {
		if ((next === 'episodes') === isEpisodes) return;
		void goto(next === 'episodes' ? '/shows?view=episodes' : '/shows', {
			keepFocus: true,
			noScroll: true
		});
	}

	/** Compact list date: YYYY-MM-DD → DD-MM-YY. */
	function fmtCardDate(dateStr: string) {
		const [y, m, d] = dateStr.split('-');
		return `${d}-${m}-${y.slice(2)}`;
	}

	function fmtDuration(mins: number) {
		const h = Math.floor(mins / 60);
		const m = mins % 60;
		if (h === 0) return `${m} min`;
		return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
	}

	// ---- Episodes search: autocomplete over tracks/artists, episode results ----
	type Suggestion = { kind: 'artist' | 'track'; value: string; sub: string };

	let searchInput = $state('');
	let suggestions = $state<{
		artists: Array<{ name: string; count: number }>;
		tracks: Array<{ title: string; artist: string }>;
	}>({ artists: [], tracks: [] });
	let suggestionsOpen = $state(false);
	let activeSuggestion = $state(-1);
	let searchTimer: ReturnType<typeof setTimeout> | null = null;
	let suggestTimer: ReturnType<typeof setTimeout> | null = null;
	let suggestController: AbortController | null = null;

	const flatSuggestions = $derived<Suggestion[]>([
		...suggestions.artists.map((a) => ({
			kind: 'artist' as const,
			value: a.name,
			sub: `${a.count} track${a.count === 1 ? '' : 's'}`
		})),
		...suggestions.tracks.map((t) => ({
			kind: 'track' as const,
			value: t.title,
			sub: t.artist
		}))
	]);

	// Keep the field in step with the URL (back/forward, cleared search).
	$effect(() => {
		searchInput = data.q ?? '';
	});

	function applySearch(value: string) {
		const params = new URLSearchParams();
		params.set('view', 'episodes');
		const q = value.trim();
		if (q) params.set('q', q);
		void goto(`/shows?${params}`, { replaceState: true, noScroll: true, keepFocus: true });
	}

	function onSearchInput() {
		suggestionsOpen = true;
		activeSuggestion = -1;
		if (searchTimer) clearTimeout(searchTimer);
		searchTimer = setTimeout(() => applySearch(searchInput), 300);
		if (suggestTimer) clearTimeout(suggestTimer);
		suggestTimer = setTimeout(() => void loadSuggestions(), 150);
	}

	async function loadSuggestions() {
		const q = searchInput.trim();
		if (q.length < 2) {
			suggestions = { artists: [], tracks: [] };
			return;
		}
		suggestController?.abort();
		suggestController = new AbortController();
		try {
			const res = await fetch(`/api/search/suggest?q=${encodeURIComponent(q)}`, {
				signal: suggestController.signal
			});
			if (!res.ok) return;
			suggestions = (await res.json()) as typeof suggestions;
		} catch {
			// aborted by a newer keystroke
		}
	}

	function pickSuggestion(index: number) {
		const picked = flatSuggestions[index];
		if (!picked) return;
		searchInput = picked.value;
		suggestionsOpen = false;
		applySearch(picked.value);
	}

	function clearSearch() {
		searchInput = '';
		suggestions = { artists: [], tracks: [] };
		suggestionsOpen = false;
		applySearch('');
	}

	function onSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			suggestionsOpen = false;
			return;
		}
		if (!suggestionsOpen || flatSuggestions.length === 0) {
			if (e.key === 'Enter') {
				e.preventDefault();
				applySearch(searchInput);
				suggestionsOpen = false;
			}
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			activeSuggestion = (activeSuggestion + 1) % flatSuggestions.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			activeSuggestion = activeSuggestion <= 0 ? flatSuggestions.length - 1 : activeSuggestion - 1;
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (activeSuggestion >= 0) pickSuggestion(activeSuggestion);
			else {
				applySearch(searchInput);
				suggestionsOpen = false;
			}
		}
	}

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

	<div class="view-bar">
		<div class="filter-btns" role="group" aria-label="View">
			<button class="filter-btn" class:active={!isEpisodes} onclick={() => setView('shows')}>
				Shows
			</button>
			<button class="filter-btn" class:active={isEpisodes} onclick={() => setView('episodes')}>
				Episodes
			</button>
		</div>
	</div>

	{#if isEpisodes}
		<div class="toolbar">
			<div class="search-wrap">
				<input
					class="search-input"
					type="text"
					placeholder="Search tracks or artists"
					bind:value={searchInput}
					oninput={onSearchInput}
					onkeydown={onSearchKeydown}
					onfocus={() => (suggestionsOpen = true)}
					onblur={() => setTimeout(() => (suggestionsOpen = false), 150)}
					role="combobox"
					aria-expanded={suggestionsOpen && flatSuggestions.length > 0}
					aria-controls="episode-suggestions"
					aria-autocomplete="list"
					aria-activedescendant={activeSuggestion >= 0
						? `episode-suggestion-${activeSuggestion}`
						: undefined}
				/>
				{#if searchInput}
					<button class="search-clear" type="button" onclick={clearSearch} aria-label="Clear search"
						>×</button
					>
				{/if}
				{#if suggestionsOpen && flatSuggestions.length > 0}
					<ul class="suggestions" id="episode-suggestions" role="listbox">
						{#each flatSuggestions as s, i (s.kind + s.value + i)}
							<li
								id={`episode-suggestion-${i}`}
								role="option"
								aria-selected={activeSuggestion === i}
								class:active={activeSuggestion === i}
							>
								<button
									type="button"
									class="suggestion"
									onmousedown={(e) => {
										e.preventDefault();
										pickSuggestion(i);
									}}
								>
									<span class="sug-tag mono">{s.kind === 'artist' ? 'Artist' : 'Track'}</span>
									<span class="sug-value">{s.value}</span>
									{#if s.sub}<span class="sug-sub mono">{s.sub}</span>{/if}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<div class="filter-stack">
				<div class="sort-control">
					<label class="sort-label mono" for="episode-show">Show</label>
					<select id="episode-show" class="sort-select" bind:value={episodeShow}>
						<option value="all">All shows</option>
						{#each episodeShows as s (s.id)}
							<option value={s.id}>{s.title}</option>
						{/each}
					</select>
				</div>
				<div class="sort-control">
					<label class="sort-label mono" for="episode-year">Year</label>
					<select id="episode-year" class="sort-select" bind:value={episodeYear}>
						<option value="all">All years</option>
						{#each episodeYears as y (y)}
							<option value={y}>{y}</option>
						{/each}
					</select>
				</div>
			</div>
			<span class="empty mono">
				{#if data.q}
					{visibleEpisodes.length} matching episode{visibleEpisodes.length === 1 ? '' : 's'}
				{:else}
					{visibleEpisodes.length} episode{visibleEpisodes.length === 1 ? '' : 's'}
				{/if}
			</span>
		</div>

		{#if visibleEpisodes.length === 0}
			<p class="empty mono">
				{data.q ? `No episodes contain “${data.q}”.` : 'No episodes yet.'}
			</p>
		{:else}
			<ul class="episode-list">
				{#each visibleEpisodes as e (e.id)}
					<li>
						<a class="episode-row" href={`/shows/${e.show_id}/${e.id}`}>
							<span class="ep-date mono">{fmtCardDate(e.date)}</span>
							<span class="ep-show mono">{e.show_title}</span>
							<span class="ep-main">
								<span class="ep-title">{e.episode_title ?? e.show_title}</span>
								{#if e.count}
									<span class="ep-match mono"
										>{e.count} matching track{e.count === 1 ? '' : 's'} · {e.labels?.join(
											' · '
										)}</span
									>
								{/if}
							</span>
							<span class="ep-meta mono">
								{#if e.replay_url}▶ Replay · {/if}{fmtDuration(e.duration_minutes)}
							</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	{:else}
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

	.view-bar {
		margin: 0 0 1rem;
	}

	.episode-list {
		list-style: none;
		margin: 0;
		padding: 0;
		border-top: 1px solid var(--vr-line);
	}

	.episode-list li {
		border-bottom: 1px solid var(--vr-line-muted);
	}

	.episode-row {
		display: grid;
		grid-template-columns: 6.5rem 15rem minmax(0, 1fr) auto;
		gap: 1rem;
		align-items: baseline;
		padding: 0.85rem 0.5rem;
		color: inherit;
		text-decoration: none;
	}

	.episode-row:hover {
		background: var(--vr-surface-low);
	}

	.ep-date {
		color: var(--vr-muted);
		font-variant-numeric: tabular-nums;
	}

	.ep-show {
		color: var(--vr-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ep-title {
		font-weight: 600;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ep-main {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}

	.ep-match {
		color: var(--vr-muted);
		font-size: 0.72rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ---- Episodes search: input + autocomplete ---- */
	.search-wrap {
		position: relative;
		flex: 1 1 20rem;
		min-width: 15rem;
		max-width: 32rem;
	}

	.search-input {
		width: 100%;
		box-sizing: border-box;
		background: var(--vr-surface-low);
		color: var(--vr-text);
		border: 1px solid var(--vr-line);
		padding: 0.5rem 2rem 0.5rem 0.6rem;
		font-family: var(--vr-font-mono);
		font-size: 0.75rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.search-input::placeholder {
		color: var(--vr-faint);
		text-transform: none;
		letter-spacing: 0;
	}

	.search-input:focus {
		outline: none;
		border-color: var(--vr-text);
	}

	.search-clear {
		position: absolute;
		top: 50%;
		right: 0.35rem;
		transform: translateY(-50%);
		background: none;
		border: none;
		color: var(--vr-muted);
		font-size: 1.1rem;
		line-height: 1;
		cursor: pointer;
		padding: 0.15rem 0.3rem;
	}

	.search-clear:hover {
		color: var(--vr-text);
	}

	.suggestions {
		position: absolute;
		z-index: 20;
		top: calc(100% + 0.25rem);
		left: 0;
		right: 0;
		margin: 0;
		padding: 0.25rem 0;
		list-style: none;
		background: var(--vr-surface);
		border: 1px solid var(--vr-line);
		max-height: 16rem;
		overflow-y: auto;
		box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
	}

	.suggestions li.active,
	.suggestions li:hover {
		background: var(--vr-surface-high);
	}

	.suggestion {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		width: 100%;
		box-sizing: border-box;
		padding: 0.45rem 0.6rem;
		background: none;
		border: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.sug-tag {
		flex-shrink: 0;
		color: var(--vr-faint);
		font-size: 0.65rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		width: 3.2rem;
	}

	.sug-value {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}

	.sug-sub {
		flex-shrink: 0;
		color: var(--vr-muted);
		font-size: 0.72rem;
		max-width: 45%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ep-meta {
		color: var(--vr-muted);
		white-space: nowrap;
		text-align: right;
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

	/* Phones: two cards per row. Columns land around 165–180px, so the image
	   gets squarer, padding and type step down, and long titles/descriptions
	   clamp so neighbouring cards keep the same height. */
	@media (max-width: 640px) {
		.grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.episode-row {
			grid-template-columns: 1fr auto;
			grid-template-areas:
				'date meta'
				'title title'
				'show show';
			column-gap: 0.5rem;
			row-gap: 0.15rem;
		}

		.ep-date {
			grid-area: date;
		}

		.ep-meta {
			grid-area: meta;
		}

		.ep-main {
			grid-area: title;
		}

		.ep-title {
			white-space: normal;
		}

		.ep-show {
			grid-area: show;
		}

		.search-wrap {
			flex: 1 1 100%;
			max-width: none;
			min-width: 0;
		}

		/* Fill the cell so a card with a two-line title doesn't end above its
		   neighbour's row — the collapsed borders then read as one block. */
		.grid > li {
			display: flex;
		}

		.card {
			flex: 1;
		}

		.card-img {
			aspect-ratio: 1.25;
		}

		.card-img.empty svg {
			width: 64px;
			height: 56px;
		}

		.card-body {
			padding: 0.6rem 0.65rem 0.75rem;
		}

		.card-meta {
			font-size: 0.66rem;
			line-height: 1.35;
			margin-bottom: 0.4rem;
		}

		.card-body h2 {
			font-size: 1.05rem;
			line-height: 1.1;
			display: -webkit-box;
			-webkit-line-clamp: 2;
			-webkit-box-orient: vertical;
			overflow: hidden;
		}

		.dj {
			font-size: 0.7rem;
			margin-top: 0.35rem;
		}

		.dj-spacer {
			height: 0.8rem;
			margin-top: 0.35rem;
		}

		.desc {
			font-size: 0.75rem;
			margin-top: 0.35rem;
			display: -webkit-box;
			-webkit-line-clamp: 2;
			-webkit-box-orient: vertical;
			overflow: hidden;
		}

		.event-tag {
			font-size: 0.6rem;
			padding: 0.05rem 0.3rem;
			margin-right: 0.3rem;
		}

		/* Won't fit beside the meta line at this width. */
		.break-tag {
			display: none;
		}
	}
</style>
