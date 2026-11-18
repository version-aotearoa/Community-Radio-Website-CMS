<script lang="ts">
	import { onMount } from 'svelte';

	interface PickedGif {
		url: string;
		preview?: string | null;
		width?: number | null;
		height?: number | null;
	}

	interface GiphyImage {
		url?: string;
		webp?: string;
		width?: string;
		height?: string;
	}

	interface GiphyResult {
		id: string;
		images: {
			fixed_height_small?: GiphyImage;
			downsized?: GiphyImage;
			fixed_width?: GiphyImage;
		};
	}

	let {
		giphyKey,
		onSelect,
		onClose
	}: {
		giphyKey: string;
		onSelect: (gif: PickedGif) => void;
		onClose: () => void;
	} = $props();

	const RATING = 'pg-13';
	const LIMIT = 24;
	const BUNDLE = 'messaging_non_clips';

	let results = $state<GiphyResult[]>([]);
	let query = $state('');
	let loading = $state(false);
	let error = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pickerEl = $state<HTMLDivElement | null>(null);

	function urlFor(q: string): string {
		const base = q
			? 'https://api.giphy.com/v1/gifs/search'
			: 'https://api.giphy.com/v1/gifs/trending';
		const params = new URLSearchParams({
			api_key: giphyKey,
			rating: RATING,
			limit: String(LIMIT),
			bundle: BUNDLE
		});
		if (q) params.set('q', q);
		return `${base}?${params.toString()}`;
	}

	async function load(q: string) {
		loading = true;
		error = '';
		try {
			const res = await fetch(urlFor(q));
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { data?: GiphyResult[] };
			results = data.data ?? [];
		} catch {
			results = [];
			error = "Couldn't load GIFs right now.";
		} finally {
			loading = false;
		}
	}

	function onInput() {
		clearTimeout(timer);
		timer = setTimeout(() => load(query.trim()), 300);
	}

	function gridImg(r: GiphyResult): string {
		const img = r.images.fixed_height_small ?? r.images.downsized ?? r.images.fixed_width;
		return img?.webp ?? img?.url ?? '';
	}

	function pick(r: GiphyResult) {
		const img = r.images.fixed_height_small ?? r.images.downsized ?? r.images.fixed_width;
		if (!img || !img.url) return;
		const width = img.width ? Number(img.width) : null;
		const height = img.height ? Number(img.height) : null;
		onSelect({ url: img.url, preview: img.webp ?? img.url, width, height });
	}

	onMount(() => {
		load('');
		// On phones the picker renders below the composer, near the bottom of the
		// viewport, so it would otherwise open off-screen. Wait a frame so the
		// keyboard collapse (triggered by the GIF button) has reflowed first.
		if (window.matchMedia('(max-width: 640px)').matches) {
			const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			const frame = requestAnimationFrame(() => {
				pickerEl?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
			});
			return () => {
				cancelAnimationFrame(frame);
				clearTimeout(timer);
			};
		}
		return () => clearTimeout(timer);
	});
</script>

<div class="gif-picker" bind:this={pickerEl}>
	<div class="picker-head">
		<input
			class="picker-input"
			type="text"
			placeholder="Search GIFs…"
			bind:value={query}
			oninput={onInput}
			autocomplete="off"
			aria-label="Search GIFs"
		/>
		<button class="picker-close" onclick={onClose} aria-label="Close GIF picker" title="Close">
			<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
				<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
			</svg>
		</button>
	</div>

	{#if loading}
		<p class="picker-note">Loading…</p>
	{:else if error}
		<p class="picker-note bad">{error}</p>
	{:else if results.length === 0}
		<p class="picker-note">No results. Try another search.</p>
	{:else}
		<div class="picker-grid">
			{#each results as r (r.id)}
				<button class="picker-item" onclick={() => pick(r)} aria-label="Choose GIF">
					<img src={gridImg(r)} alt="" loading="lazy" />
				</button>
			{/each}
		</div>
	{/if}

	<a class="giphy-credit" href="https://giphy.com/" target="_blank" rel="noopener noreferrer">Powered by GIPHY</a>
</div>

<style>
	.gif-picker {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		border: 1px solid var(--vr-line);
		border-top: none;
		background: var(--vr-surface);
		padding: 0.75rem;
	}

	.picker-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.picker-input {
		flex: 1;
		background: transparent;
		border: 1px solid var(--vr-line);
		color: var(--vr-text);
		font-family: var(--vr-font-mono);
		font-size: 0.85rem;
		padding: 0.45rem 0.7rem;
		outline: none;
	}

	.picker-input:focus {
		border-color: var(--vr-text);
	}

	.picker-close {
		display: inline-grid;
		place-items: center;
		background: none;
		border: 1px solid var(--vr-line);
		color: var(--vr-muted);
		width: 30px;
		height: 30px;
		cursor: pointer;
	}

	.picker-close:hover {
		color: var(--vr-text);
		border-color: var(--vr-text);
	}

	.picker-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		align-items: start;
		gap: 0.5rem;
		max-height: 260px;
		overflow-y: auto;
	}

	.picker-item {
		display: block;
		padding: 0;
		border: 1px solid var(--vr-line-muted);
		background: none;
		cursor: pointer;
		overflow: hidden;
	}

	.picker-item img {
		width: 100%;
		height: auto;
		display: block;
	}

	.picker-item:hover {
		border-color: var(--vr-text);
	}

	.picker-note {
		color: var(--vr-muted);
		font-size: 0.85rem;
		margin: 0;
	}

	.picker-note.bad {
		color: var(--vr-red);
	}

	.giphy-credit {
		color: var(--vr-faint);
		font-family: var(--vr-font-mono);
		font-size: 0.68rem;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		text-decoration: none;
		text-align: right;
	}

	.giphy-credit:hover {
		color: var(--vr-text);
		text-decoration: underline;
	}

	@media (max-width: 640px) {
		.gif-picker {
			border-left: none;
			border-right: none;
		}

		/* 16px keeps phones from auto-zooming when the search field is focused. */
		.picker-input {
			font-size: 1rem;
		}

		.picker-grid {
			grid-template-columns: repeat(3, 1fr);
		}
	}
</style>
