<script lang="ts">
	import Seo from '$lib/components/Seo.svelte';
	import { cycleWeekOf, startOfWeek } from '$lib/cycle';
	import { zonedWallTimeToUtcMs } from '$lib/time';

	let { data } = $props();

	const STATION_TZ = 'Pacific/Auckland';
	const MODE_KEY = 'vr-schedule-time-mode';

	const upcoming = $derived(data.upcoming);

	// The viewer's timezone is only known client-side: start in NZ time so SSR
	// and hydration agree, then honour the saved preference on mount.
	let mode = $state<'nz' | 'local'>('nz');
	let localTz = $state('');

	const isNzViewer = $derived(localTz === '' || localTz === STATION_TZ);
	const useLocal = $derived(mode === 'local' && !isNzViewer);

	function setMode(next: 'nz' | 'local') {
		mode = next;
		try {
			localStorage.setItem(MODE_KEY, next);
		} catch {
			// storage unavailable
		}
	}

	$effect(() => {
		try {
			if (localStorage.getItem(MODE_KEY) === 'local') mode = 'local';
		} catch {
			// storage unavailable
		}
		localTz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
	});

	// Null until mounted so the SSR/first paint is identical to hydration.
	let nowMs = $state<number | null>(null);

	$effect(() => {
		nowMs = Date.now();
		const id = setInterval(() => (nowMs = Date.now()), 1000);
		return () => clearInterval(id);
	});

	/** Broadcast plus its absolute start instant (shared by countdowns and local times). */
	type Slot = (typeof upcoming)[number] & { startMs: number };

	const slots = $derived(
		upcoming.map((b) => ({ ...b, startMs: zonedWallTimeToUtcMs(b.date, b.start_minutes) }))
	);

	const localDay = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	});

	function localDateKey(ms: number): string {
		return localDay.format(ms);
	}

	/** Calendar day a slot appears under: the station date, or the viewer's local date. */
	function displayDate(slot: Slot): string {
		return useLocal ? localDateKey(slot.startMs) : slot.date;
	}

	const todayKey = $derived(
		nowMs === null ? data.today : useLocal ? localDateKey(nowMs) : data.today
	);
	const tomorrowKey = $derived(
		nowMs === null ? data.tomorrow : useLocal ? localDateKey(nowMs + 86_400_000) : data.tomorrow
	);

	// Earliest broadcast that hasn't started yet; advances as each one begins.
	const next = $derived.by(() => {
		const t = nowMs;
		if (t === null) return null;
		return slots.find((s) => s.startMs > t) ?? null;
	});

	interface Day {
		date: string;
		label: string;
		today: boolean;
		tomorrow: boolean;
		items: Slot[];
	}

	interface Week {
		monday: string;
		cycleWeek: number;
		range: string;
		days: Day[];
	}

	const days = $derived.by<Day[]>(() => {
		const groups = new Map<string, Slot[]>();
		for (const slot of slots) {
			const key = displayDate(slot);
			const list = groups.get(key) ?? [];
			list.push(slot);
			groups.set(key, list);
		}
		return Array.from(groups.entries())
			.map(([date, items]) => ({
				date,
				label: formatDate(date),
				today: date === todayKey,
				tomorrow: date === tomorrowKey,
				items
			}))
			.sort((a, b) => a.items[0].startMs - b.items[0].startMs);
	});

	// Mon–Sun weeks; the divider still names the station's 4-week cycle, computed
	// from the first broadcast's station date.
	const weeks = $derived.by<Week[]>(() => {
		const groups = new Map<string, Day[]>();
		for (const day of days) {
			const monday = startOfWeek(day.date);
			const list = groups.get(monday) ?? [];
			list.push(day);
			groups.set(monday, list);
		}
		return Array.from(groups.entries())
			.map(([monday, weekDays]) => ({
				monday,
				cycleWeek: cycleWeekOf(weekDays[0].items[0].date),
				range: formatWeekRange(monday),
				days: weekDays
			}))
			.sort((a, b) => a.monday.localeCompare(b.monday));
	});

	function formatDate(dateStr: string) {
		return new Intl.DateTimeFormat('en-NZ', {
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			timeZone: 'UTC'
		}).format(new Date(`${dateStr}T00:00:00Z`));
	}

	/** Mon–Sun range, e.g. "15–21 Sep" (same month) or "29 Sep – 5 Oct". */
	function formatWeekRange(monday: string): string {
		const start = new Date(`${monday}T00:00:00Z`);
		const end = new Date(start);
		end.setUTCDate(end.getUTCDate() + 6);
		const day = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', timeZone: 'UTC' });
		const dayMonth = new Intl.DateTimeFormat('en-NZ', {
			day: 'numeric',
			month: 'short',
			timeZone: 'UTC'
		});
		return start.getUTCMonth() === end.getUTCMonth()
			? `${day.format(start)}–${dayMonth.format(end)}`
			: `${dayMonth.format(start)} – ${dayMonth.format(end)}`;
	}

	function fmtTime(mins: number) {
		const h = Math.floor(mins / 60);
		const m = mins % 60;
		return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
	}

	const localTimeFmt = new Intl.DateTimeFormat(undefined, {
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	});

	/** Station wall-clock time, or the viewer's local time, for one slot. */
	function slotTime(slot: Slot): string {
		if (!useLocal) {
			return `${fmtTime(slot.start_minutes)}–${fmtTime(slot.start_minutes + slot.duration_minutes)}`;
		}
		const endMs = slot.startMs + slot.duration_minutes * 60_000;
		return `${localTimeFmt.format(slot.startMs)}–${localTimeFmt.format(endMs)}`;
	}

	function fmtCountdown(ms: number): string {
		const total = Math.max(0, Math.floor(ms / 1000));
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		const s = total % 60;
		const pad = (n: number) => String(n).padStart(2, '0');
		if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
		if (m > 0) return `${m}m ${pad(s)}s`;
		return `${s}s`;
	}
</script>

<svelte:head>
	<title>Schedule — Version Radio</title>
</svelte:head>

<Seo />

<div class="page">
	<header class="head">
		<div class="head-top">
			<h1 class="h-lg">Schedule</h1>
			{#if !isNzViewer}
				<div class="tz-toggle" role="group" aria-label="Time zone">
					<button class="tz-btn" class:active={!useLocal} onclick={() => setMode('nz')}>
						NZ time
					</button>
					<button class="tz-btn" class:active={useLocal} onclick={() => setMode('local')}>
						My time
					</button>
				</div>
			{/if}
		</div>
		<p class="subtitle mono">
			{#if useLocal}
				Next 30 days of broadcasts. Times in your local time ({localTz}).
			{:else}
				Next 30 days of broadcasts. All times local (NZ).
			{/if}
		</p>
	</header>

	{#if days.length === 0}
		<p class="empty mono">Nothing scheduled over the next 30 days.</p>
	{:else}
		<div class="weeks">
			{#each weeks as week (week.monday)}
				<div class="week">
					<h2 class="week-divider mono">
						Week {week.cycleWeek} of 4 <span class="week-range">· {week.range}</span>
					</h2>
					{#each week.days as day (day.date)}
						<section class="day" class:today={day.today} class:tomorrow={day.tomorrow}>
							<h3 class="day-head">
								<span class="day-label">
									{day.label}
									{#if day.today}
										<span class="sticker">Today</span>
										{#if nowMs !== null && next !== null && displayDate(next) === day.date}
											<span class="countdown">
												next in {fmtCountdown(next.startMs - nowMs)}
											</span>
										{/if}
									{:else if day.tomorrow}
										<span class="sticker">Tomorrow</span>
										{#if nowMs !== null && next !== null && displayDate(next) === day.date}
											<span class="countdown">
												next in {fmtCountdown(next.startMs - nowMs)}
											</span>
										{/if}
									{/if}
								</span>
							</h3>
							<ul>
								{#each day.items as b (b.id)}
									<li>
										<a class="slot" class:onair={b.onair} href={`/shows/${b.show_id}?from=schedule`}>
											<span class="time mono" class:onair={b.onair}>
												{#if b.onair}
													<span class="live-dot" aria-hidden="true"></span>
												{/if}
												{slotTime(b)}
											</span>
											<span class="show-title h-sm">{b.title}</span>
											{#if b.dj_name && b.kind !== 'event'}
												<span class="dj mono">{b.dj_name}</span>
											{/if}
										</a>
									</li>
								{/each}
							</ul>
						</section>
					{/each}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.page {
		padding: var(--vr-pad);
		max-width: 72rem;
	}

	.head {
		margin: 0 0 1.5rem;
		border-bottom: 1px solid var(--vr-line);
		padding-bottom: 1rem;
	}

	.head h1 {
		margin: 0;
	}

	.head-top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.tz-toggle {
		display: flex;
		gap: 0.35rem;
	}

	.tz-btn {
		background: none;
		border: 1px solid var(--vr-line);
		color: var(--vr-muted);
		font-family: var(--vr-font-mono);
		font-size: 0.72rem;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		padding: 0.3rem 0.6rem;
		cursor: pointer;
	}

	.tz-btn:hover {
		color: var(--vr-text);
		border-color: var(--vr-text);
	}

	.tz-btn.active {
		background: var(--vr-text);
		color: var(--vr-black);
		border-color: var(--vr-text);
	}

	.subtitle {
		margin: 0.5rem 0 0;
		color: var(--vr-muted);
	}

	.empty {
		color: var(--vr-muted);
	}

	.weeks {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.week {
		border: 1px solid var(--vr-line-muted);
	}

	/* The one banded header: week divider with its station cycle week + date range. */
	.week-divider {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin: 0;
		padding: 0.7rem 1.25rem;
		background: var(--vr-surface-high);
		font-size: 0.82rem;
		font-weight: 500;
		color: var(--vr-text);
	}

	.week-range {
		color: var(--vr-muted);
		font-weight: 400;
	}

	/* Slim per-day label (the week divider carries the hierarchy). */
	.day {
		border-top: 1px solid var(--vr-line-muted);
	}

	.day.today,
	.day.tomorrow {
		border-top-color: var(--vr-line);
	}

	.day-head {
		margin: 0;
		padding: 0.5rem 1.25rem;
		font-family: var(--vr-font-mono);
		font-size: 0.72rem;
		font-weight: 500;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--vr-muted);
	}

	.day.today .day-head,
	.day.tomorrow .day-head {
		color: var(--vr-text);
	}

	.day-label {
		display: inline-flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
	}

	.day-head .sticker {
		padding: 0.25rem 0.45rem;
	}

	.countdown {
		color: var(--vr-faint);
		letter-spacing: 0.02em;
		text-transform: none;
		font-variant-numeric: tabular-nums;
	}

	.day ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.slot {
		display: flex;
		align-items: baseline;
		gap: 1.25rem;
		padding: 0.85rem 1.25rem;
		border-top: 1px solid var(--vr-line-muted);
		text-decoration: none;
		color: var(--vr-text);
	}

	.day ul li:first-child .slot {
		border-top: none;
	}

	.slot:hover,
	.slot.onair:hover {
		background: var(--vr-text);
		color: var(--vr-black);
	}

	.slot.onair {
		background: rgba(255, 255, 255, 0.08);
	}

	.time {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
		color: var(--vr-muted);
		font-variant-numeric: tabular-nums;
	}

	.time.onair {
		color: var(--vr-green);
	}

	.live-dot {
		width: 0.5rem;
		height: 0.5rem;
		flex-shrink: 0;
		background: var(--vr-red);
		animation: live-pulse 1.6s ease-in-out infinite;
	}

	.slot:hover .dj {
		color: rgba(0, 0, 0, 0.8);
	}

	.slot:hover .time,
	.slot:hover .time.onair {
		color: rgba(0, 0, 0, 0.8);
	}

	.show-title {
		min-width: 0;
	}

	.dj {
		color: var(--vr-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	@media (max-width: 720px) {
		.slot .dj {
			display: none;
		}
	}

	@keyframes live-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}
</style>
