<script lang="ts">
	/**
	 * Shared-link helper: shown when a `?t=` page load couldn't autoplay
	 * (browser autoplay policy), so the listener can start the recording at the
	 * shared moment with one deliberate tap. The tap is the user gesture the
	 * browser needs.
	 */
	import { onMount, onDestroy } from 'svelte';
	import { formatTrackTime } from '$lib/trackTime';

	let {
		seconds,
		title,
		artist = null,
		meta,
		art = null,
		onplay,
		ondismiss
	}: {
		seconds: number;
		title: string;
		artist?: string | null;
		/** Episode context line, e.g. "Version Excursions · 28 Oct 2026". */
		meta: string;
		art?: string | null;
		onplay: () => void;
		ondismiss: () => void;
	} = $props();

	let playBtn: HTMLButtonElement | undefined = $state();
	let artFailed = $state(false);

	onMount(() => {
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		// Focus the confirm action so keyboard/Enter starts playback immediately.
		playBtn?.focus();
		return () => {
			document.body.style.overflow = prevOverflow;
		};
	});

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') ondismiss();
	}
</script>

<svelte:window onkeydown={onKey} />

<div
	class="backdrop"
	role="presentation"
	onclick={(e) => {
		if (e.target === e.currentTarget) ondismiss();
	}}
>
	<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="play-from-title">
		<p class="eyebrow mono">Shared moment</p>
		<div class="body">
			{#if art && !artFailed}
				<img class="art" src={art} alt="" width="56" height="56" onerror={() => (artFailed = true)} />
			{/if}
			<div class="copy">
				<h2 id="play-from-title">{title}</h2>
				{#if artist}
					<p class="artist">{artist}</p>
				{/if}
				<p class="meta mono">{formatTrackTime(seconds)} · {meta}</p>
			</div>
		</div>
		<div class="actions">
			<button class="primary" bind:this={playBtn} onclick={onplay}>
				Play from {formatTrackTime(seconds)}
			</button>
			<button class="ghost" onclick={ondismiss}>Not now</button>
		</div>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 70;
		background: rgba(0, 0, 0, 0.82);
		display: grid;
		place-items: center;
		padding: 1.25rem;
	}

	.sheet {
		width: 100%;
		max-width: 26rem;
		border: 1px solid var(--vr-line);
		background: var(--vr-surface);
		padding: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.eyebrow {
		margin: 0;
		font-size: 0.72rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--vr-muted);
	}

	.body {
		display: flex;
		align-items: center;
		gap: 0.85rem;
		min-width: 0;
	}

	.art {
		width: 56px;
		height: 56px;
		object-fit: cover;
		border: 1px solid var(--vr-line-muted);
		flex-shrink: 0;
	}

	.copy {
		min-width: 0;
	}

	.copy h2 {
		margin: 0;
		font-family: var(--vr-font-headline);
		font-size: 1.35rem;
		font-weight: 400;
		line-height: 1.1;
		text-transform: uppercase;
		letter-spacing: 0.01em;
		overflow-wrap: anywhere;
	}

	.artist {
		margin: 0.2rem 0 0;
		color: var(--vr-muted);
		font-size: 0.9rem;
	}

	.meta {
		margin: 0.35rem 0 0;
		color: var(--vr-muted);
		font-size: 0.78rem;
	}

	.actions {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
	}

	.primary,
	.ghost {
		font-family: var(--vr-font-mono);
		font-size: 0.75rem;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		padding: 0.55rem 1rem;
		cursor: pointer;
		border: 1px solid var(--vr-line);
	}

	.primary {
		background: var(--vr-text);
		color: var(--vr-black);
	}

	.primary:hover {
		background: transparent;
		color: var(--vr-text);
	}

	.ghost {
		background: transparent;
		color: var(--vr-muted);
	}

	.ghost:hover {
		color: var(--vr-text);
		border-color: var(--vr-text);
	}

	.primary:focus-visible,
	.ghost:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--vr-bg), 0 0 0 3px var(--vr-text);
	}
</style>
