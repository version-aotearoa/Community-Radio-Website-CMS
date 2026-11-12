<script lang="ts">
	import { onDestroy } from 'svelte';
	import { formatTrackTime } from '$lib/trackTime';
	import type { ChatMessage } from '$lib/chat';

	let {
		replayUrl,
		duration,
		currentTime,
		comments,
		seed,
		serverDuration = null,
		onSeek,
		onComment,
		onReply = null,
		disabled = false
	}: {
		replayUrl: string | null;
		duration: number | null;
		/** Container-parsed length from the server; beats the browser probe. */
		serverDuration?: number | null;
		currentTime: number;
		comments: ChatMessage[];
		seed: string;
		onSeek: (seconds: number) => void;
		onComment: (seconds: number) => void;
		/** Reply to a root comment straight from its pin. */
		onReply?: ((comment: { id: string; name: string }) => void) | null;
		disabled?: boolean;
	} = $props();

	const BAR_COUNT = 200;

	/** Stable decorative waveform: same episode always looks the same. */
	function hashSeed(value: string): number {
		let h = 2166136261;
		for (let i = 0; i < value.length; i++) {
			h ^= value.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		return h >>> 0 || 1;
	}

	function makeBars(value: string, count: number): number[] {
		let state = hashSeed(value);
		const bars: number[] = [];
		for (let i = 0; i < count; i++) {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			state >>>= 0;
			const noise = (state % 1000) / 1000;
			const wave = 0.46 + 0.22 * Math.sin(i * 0.31) + 0.12 * Math.sin(i * 0.09 + 1.7);
			const envelope = 0.76 + 0.24 * Math.sin((i / count) * Math.PI * 2 - 1.4);
			bars.push(Math.max(0.12, Math.min(1, wave + (noise - 0.5) * 0.42 * envelope)));
		}
		return bars;
	}

	let probedDuration = $state<number | null>(null);
	let realPeaks = $state<number[] | null>(null);
	let realDuration = $state<number | null>(null);
	/** 'estimated' means the bars are decorative — no usable upstream peaks. */
	let waveformStatus = $state<'pending' | 'real' | 'estimated'>('pending');
	let waveformReason = $state('');
	let scrub = $state<number | null>(null);
	let scrubbing = $state(false);
	/** Fraction of the timeline tapped before the length was known. */
	let pendingFraction = $state<number | null>(null);
	/** Pointer position over the track, for the hover guide and time chip. */
	let hoverFraction = $state<number | null>(null);

	const bars = $derived(realPeaks && realPeaks.length > 0 ? realPeaks : makeBars(seed, BAR_COUNT));

	// The player's own duration is authoritative, then the exact <audio> metadata
	// probe. The waveform's derived duration is the last resort: it is a
	// calculation over a decoded envelope, so it must never outrank an exact one.
	const total = $derived(
		duration && Number.isFinite(duration) && duration > 0
			? duration
			: serverDuration && Number.isFinite(serverDuration) && serverDuration > 0
				? serverDuration
				: probedDuration && Number.isFinite(probedDuration) && probedDuration > 0
					? probedDuration
					: realDuration && Number.isFinite(realDuration) && realDuration > 0
						? realDuration
						: null
	);
	const shown = $derived(
		Math.max(0, Math.min(total ?? Number.MAX_SAFE_INTEGER, scrub ?? currentTime))
	);
	const pct = $derived(total && total > 0 ? (shown / total) * 100 : 0);
	const active = $derived(!disabled && !!total);

	const markers = $derived(
		comments
			.filter((m) => !m.parentId && m.atSeconds !== null && m.atSeconds !== undefined)
			.map((m) => ({
				id: m.id,
				at: Math.max(0, Math.min(total ?? m.atSeconds!, m.atSeconds!)),
				name: m.name,
				content: m.content,
				initial: initialFor(m.name),
				hue: hueFor(m.name)
			}))
	);

	/** First letter/digit of a display name — the marker's identifying glyph. */
	function initialFor(name: string): string {
		const match = name.trim().match(/[\p{L}\p{N}]/u);
		return match ? match[0].toUpperCase() : '•';
	}

	/** Stable hue per commenter, so the same person always reads the same colour. */
	function hueFor(name: string): number {
		let hash = 2166136261;
		for (let i = 0; i < name.length; i++) {
			hash ^= name.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
		return (hash >>> 0) % 360;
	}

	let hoveredMarkerId = $state<string | null>(null);
	let pinnedMarkerId = $state<string | null>(null);
	// Hover intent: the tooltip now holds a Reply button, so leaving the pin has
	// to allow the pointer to travel into the tooltip before it closes.
	let hoverTimer: ReturnType<typeof setTimeout> | undefined;
	function keepHover() {
		if (hoverTimer) {
			clearTimeout(hoverTimer);
			hoverTimer = undefined;
		}
	}
	function clearHoverSoon() {
		if (hoverTimer) clearTimeout(hoverTimer);
		hoverTimer = setTimeout(() => {
			hoveredMarkerId = null;
			hoverTimer = undefined;
		}, 180);
	}
	const activeMarkerId = $derived(pinnedMarkerId ?? hoveredMarkerId);
	const activeMarker = $derived(markers.find((m) => m.id === activeMarkerId) ?? null);

	function replyToMarker(marker: { id: string; name: string }) {
		onReply?.({ id: marker.id, name: marker.name });
		pinnedMarkerId = null;
		hoveredMarkerId = null;
	}

	function toggleMarker(id: string) {
		if (pinnedMarkerId === id) {
			pinnedMarkerId = null;
			hoveredMarkerId = null;
		} else {
			pinnedMarkerId = id;
		}
	}

	function markerTipClass(at: number): string {
		if (!total) return '';
		const pct = (at / total) * 100;
		if (pct < 22) return 'tip-left';
		if (pct > 78) return 'tip-right';
		return '';
	}

	function markerTipStyle(at: number): string {
		if (!total) return 'display:none';
		const pct = Math.max(0, Math.min(100, (at / total) * 100));
		if (pct < 22) return 'left:0';
		if (pct > 78) return 'left:auto;right:0';
		return `left:${pct}%`;
	}

	// Probe duration without starting playback when the player has never loaded
	// this recording. The global player's duration wins once it knows better.
	$effect(() => {
		const url = replayUrl;
		probedDuration = null;
		// A server-parsed length makes this probe redundant — and on a large
		// recording it competes with the player's own request for the same file.
		if (!url || (serverDuration && serverDuration > 0)) return;
		const audio = new Audio();
		audio.preload = 'metadata';
		const onLoaded = () => {
			if (Number.isFinite(audio.duration) && audio.duration > 0) probedDuration = audio.duration;
		};
		audio.addEventListener('loadedmetadata', onLoaded);
		audio.src = url;
		return () => {
			audio.removeEventListener('loadedmetadata', onLoaded);
			audio.removeAttribute('src');
			audio.load();
		};
	});

	// Real peaks from AzuraCast (downsampled server-side). Until they arrive —
	// or if the station can't generate a waveform — the decorative bars remain.
	$effect(() => {
		const url = replayUrl;
		realPeaks = null;
		realDuration = null;
		waveformStatus = 'pending';
		waveformReason = '';
		if (!url) return;
		const controller = new AbortController();
		void (async () => {
			try {
				const res = await fetch(`/api/replay-waveform?url=${encodeURIComponent(url)}`, {
					signal: controller.signal
				});
				if (!res.ok) return;
				const body = (await res.json()) as { peaks?: unknown; duration?: unknown; reason?: unknown };
				if (Array.isArray(body.peaks)) {
					const peaks = body.peaks
						.map(Number)
						.filter((n) => Number.isFinite(n))
						.map((n) => Math.max(0, Math.min(1, n)));
					if (peaks.length > 1) realPeaks = peaks;
				}
				if (typeof body.duration === 'number' && Number.isFinite(body.duration) && body.duration > 0) {
					realDuration = body.duration;
				}
				waveformStatus = realPeaks ? 'real' : 'estimated';
				waveformReason = typeof body.reason === 'string' ? body.reason : '';
			} catch {
				// decorative fallback
			}
		})();
		return () => controller.abort();
	});

	/** Why the bars are an approximation, for the "approx." flag's tooltip. */
	const waveformNote = $derived(
		waveformReason === 'unsupported'
			? 'AzuraCast cannot generate a waveform for this recording, so these bars are an approximation. Seeking and comment pins still work.'
			: 'The waveform could not be loaded, so these bars are an approximation. Seeking and comment pins still work.'
	);

	function secondsAt(clientX: number, el: HTMLElement): number {
		if (!total) return 0;
		return fractionAt(clientX, el) * total;
	}

	function fractionAt(clientX: number, el: HTMLElement): number {
		const rect = el.getBoundingClientRect();
		return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
	}

	function onPointerDown(e: PointerEvent) {
		pinnedMarkerId = null;
		// Accept the press even before the length is known: the fraction is queued
		// and applied as soon as a duration arrives, rather than silently dropped.
		if (disabled) return;
		const el = e.currentTarget as HTMLElement;
		scrubbing = true;
		scrub = total ? fractionAt(e.clientX, el) * total : null;
		el.setPointerCapture?.(e.pointerId);
	}

	function onPointerMove(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		// Hover affordance is mouse-only: touch has no hover state, and a chip
		// left behind after a tap reads as a stuck tooltip.
		if (e.pointerType === 'mouse') hoverFraction = fractionAt(e.clientX, el);
		if (!scrubbing) return;
		scrub = total ? fractionAt(e.clientX, el) * total : null;
	}

	function onPointerEnd(e: PointerEvent) {
		if (!scrubbing) return;
		const fraction = fractionAt(e.clientX, e.currentTarget as HTMLElement);
		scrubbing = false;
		scrub = null;
		if (total) onSeek(fraction * total);
		else pendingFraction = fraction;
	}

	// Apply a tap that landed before the duration was known.
	$effect(() => {
		if (!total || pendingFraction === null) return;
		const fraction = pendingFraction;
		pendingFraction = null;
		onSeek(fraction * total);
	});

	function onKeyDown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			pinnedMarkerId = null;
			hoveredMarkerId = null;
			e.preventDefault();
			return;
		}
		if (!active || !total) return;
		const step = e.shiftKey ? 30 : 5;
		let next = shown;
		if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next -= step;
		else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next += step;
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = total;
		else return;
		e.preventDefault();
		pinnedMarkerId = null;
		onSeek(Math.max(0, Math.min(total, next)));
	}

	function pinStyle(at: number): string {
		if (!total) return 'display:none';
		return `left:${Math.max(0, Math.min(100, (at / total) * 100))}%`;
	}

	onDestroy(() => {
		if (hoverTimer) clearTimeout(hoverTimer);
	});
</script>

{#if replayUrl}
	<div class="waveform-shell" class:disabled={!active}>
		<div class="wave-head mono">
			{#if waveformStatus === 'estimated'}
				<span class="wave-flag" title={waveformNote} aria-label={waveformNote}>approx.</span>
			{:else if waveformStatus === 'pending'}
				<span class="wave-flag wave-loading" role="status" title="Loading waveform…">loading</span>
			{/if}
			<button
				class="wave-comment"
				type="button"
				disabled={!total}
				onclick={() => onComment(Math.round(shown))}
			>
				Comment at {formatTrackTime(shown)}
			</button>
		</div>
		<div
			class="waveform"
			class:scrubbing
			class:inactive={disabled}
			role="slider"
			tabindex={active ? 0 : -1}
			aria-label="Seek the episode recording"
			aria-valuemin={0}
			aria-valuemax={total ? Math.round(total) : 0}
			aria-valuenow={Math.round(shown)}
			aria-valuetext={`${formatTrackTime(shown)} of ${formatTrackTime(total ?? 0)}`}
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerEnd}
			onpointercancel={() => {
				scrubbing = false;
				scrub = null;
			}}
			onpointerleave={() => (hoverFraction = null)}
			onkeydown={onKeyDown}
		>
			<div class="bars" class:approximate={waveformStatus === 'estimated'} aria-hidden="true">
				{#each bars as height, i (i)}
					<span
						class:played={total ? shown / total >= i / bars.length : false}
						style:height={`${height * 100}%`}
					></span>
				{/each}
			</div>
			<div class="played-shade" aria-hidden="true" style:width={`${pct}%`}></div>
			<div class="playhead" aria-hidden="true" style:left={`${pct}%`}></div>
			{#if hoverFraction !== null && total && !activeMarker}
				<div
					class="hover-line"
					style:left={`${hoverFraction * 100}%`}
					aria-hidden="true"
				></div>
				<span
					class="hover-time mono"
					class:edge-left={hoverFraction < 0.12}
					class:edge-right={hoverFraction > 0.88}
					style:left={`${hoverFraction * 100}%`}
					aria-hidden="true"
				>
					{formatTrackTime(hoverFraction * total)}<em>seek</em>
				</span>
			{/if}
			{#each markers as marker (marker.id)}
				<button
					type="button"
					class="pin"
					style={`${pinStyle(marker.at)};color:hsl(${marker.hue} 75% 62%)`}
					aria-label={`Show comment by ${marker.name} at ${formatTrackTime(marker.at)}`}
					aria-expanded={pinnedMarkerId === marker.id}
					aria-controls="wave-tip"
					aria-describedby={activeMarkerId === marker.id ? 'wave-tip' : undefined}
					onpointerdown={(e) => e.stopPropagation()}
					onpointerenter={() => {
						keepHover();
						hoveredMarkerId = marker.id;
					}}
					onpointerleave={clearHoverSoon}
					onfocus={() => {
						keepHover();
						hoveredMarkerId = marker.id;
					}}
					onblur={clearHoverSoon}
					onclick={(e) => {
						e.stopPropagation();
						toggleMarker(marker.id);
					}}
				>
					<span aria-hidden="true">{marker.initial}</span>
				</button>
			{/each}
			{#if activeMarker}
				<div
					id="wave-tip"
					class="marker-tip {markerTipClass(activeMarker.at)}"
					style={markerTipStyle(activeMarker.at)}
					role="group"
					aria-label={`Comment by ${activeMarker.name} at ${formatTrackTime(activeMarker.at)}`}
					onpointerdown={(e) => e.stopPropagation()}
					onpointerenter={keepHover}
					onpointerleave={clearHoverSoon}
					onfocusin={keepHover}
					onfocusout={clearHoverSoon}
				>
					<span class="tip-meta mono">{activeMarker.name} · {formatTrackTime(activeMarker.at)}</span>
					<span class="tip-body">{activeMarker.content || 'GIF comment'}</span>
					{#if onReply}
						<button
							type="button"
							class="tip-reply"
							onclick={() => replyToMarker(activeMarker)}
						>
							Reply
						</button>
					{/if}
				</div>
			{/if}
		</div>
		<div class="wave-times mono">
			<span>{formatTrackTime(shown)}</span>
			<span>{formatTrackTime(total ?? 0)}</span>
		</div>
	</div>
{/if}

<style>
	.waveform-shell {
		border: 1px solid var(--vr-line-muted);
		background: var(--vr-surface-low);
		padding: 0.55rem 0.7rem 0.45rem;
		margin: 0 0 1rem;
	}

	.waveform-shell.disabled {
		opacity: 0.55;
	}

	.wave-head {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.75rem;
		margin-bottom: 0.45rem;
		color: var(--vr-muted);
		font-size: 0.68rem;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.wave-flag {
		margin-right: auto;
		border: 1px solid var(--vr-line-muted);
		padding: 0 0.25rem;
		color: var(--vr-faint);
		font-size: 0.6rem;
		letter-spacing: 0;
		text-transform: none;
		cursor: help;
	}

	.wave-loading {
		cursor: default;
	}

	@media (prefers-reduced-motion: no-preference) {
		.wave-loading {
			animation: wave-flag-pulse 1.2s ease-in-out infinite;
		}
	}

	@keyframes wave-flag-pulse {
		0%,
		100% {
			opacity: 0.45;
		}
		50% {
			opacity: 1;
		}
	}

	.wave-comment {
		border: 1px solid var(--vr-line-muted);
		background: transparent;
		color: var(--vr-text);
		font-family: var(--vr-font-mono);
		font-size: 0.68rem;
		letter-spacing: 0.03em;
		padding: 0.2rem 0.5rem;
		cursor: pointer;
		white-space: nowrap;
	}

	.wave-comment:hover:not(:disabled) {
		background: var(--vr-text);
		color: var(--vr-black);
		border-color: var(--vr-text);
	}

	.wave-comment:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.waveform {
		position: relative;
		height: 84px;
		cursor: crosshair;
		touch-action: none;
		outline: none;
	}

	.waveform.scrubbing {
		cursor: col-resize;
	}

	.waveform:focus-visible {
		box-shadow: 0 0 0 2px var(--vr-bg), 0 0 0 3px var(--vr-text);
	}

	.waveform.inactive {
		cursor: default;
	}

	.bars {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: flex-end;
		gap: 1px;
		pointer-events: none;
	}

	.bars span {
		flex: 1 1 0;
		min-width: 0;
		background: var(--vr-line-muted);
		transition: background-color 80ms linear;
	}

	.bars span.played {
		background: var(--vr-text);
	}

	.bars.approximate span {
		opacity: 0.72;
	}

	.played-shade {
		position: absolute;
		inset: 0 auto 0 0;
		background: var(--vr-text);
		opacity: 0.05;
		pointer-events: none;
	}

	.playhead {
		position: absolute;
		top: -2px;
		bottom: -2px;
		width: 2px;
		background: var(--vr-text);
		pointer-events: none;
		transform: translateX(-1px);
		z-index: 2;
	}

	.hover-line {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 1px;
		background: var(--vr-faint);
		pointer-events: none;
		transform: translateX(-0.5px);
		z-index: 1;
	}

	.hover-time {
		position: absolute;
		bottom: 2px;
		transform: translateX(-50%);
		display: inline-flex;
		align-items: baseline;
		gap: 0.3rem;
		padding: 0.05rem 0.3rem;
		border: 1px solid var(--vr-line-muted);
		background: var(--vr-surface);
		color: var(--vr-text);
		font-size: 0.62rem;
		white-space: nowrap;
		pointer-events: none;
		z-index: 3;
	}

	.hover-time em {
		color: var(--vr-faint);
		font-style: normal;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.hover-time.edge-left {
		transform: translateX(0);
	}

	.hover-time.edge-right {
		transform: translateX(-100%);
	}

	.pin {
		position: absolute;
		top: -7px;
		width: 16px;
		height: 16px;
		margin-left: -8px;
		padding: 0;
		display: grid;
		place-items: center;
		border: 1px solid currentColor;
		border-radius: 50%;
		background: var(--vr-bg);
		font-family: var(--vr-font-mono);
		font-size: 0.55rem;
		line-height: 1;
		color: var(--vr-green);
		cursor: pointer;
		z-index: 4;
	}

	.pin span {
		transform: translateY(-0.5px);
	}

	.pin:hover,
	.pin:focus-visible {
		background: currentColor;
		outline: none;
	}

	.pin:hover span,
	.pin:focus-visible span {
		color: var(--vr-bg);
	}

	.marker-tip {
		position: absolute;
		bottom: calc(100% + 8px);
		z-index: 5;
		width: max-content;
		max-width: min(18rem, 80vw);
		border: 1px solid var(--vr-line);
		background: var(--vr-surface);
		color: var(--vr-text);
		padding: 0.45rem 0.55rem;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
		transform: translateX(-50%);
		pointer-events: auto;
	}

	/* Keep the pointer inside the tooltip while it travels up from the pin. */
	.marker-tip::before {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		top: 100%;
		height: 12px;
	}

	.tip-reply {
		margin-top: 0.35rem;
		border: none;
		background: transparent;
		color: var(--vr-muted);
		font-family: var(--vr-font-mono);
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 0.1rem 0.15rem;
		cursor: pointer;
	}

	.tip-reply:hover,
	.tip-reply:focus-visible {
		color: var(--vr-text);
		text-decoration: underline;
	}

	.marker-tip.tip-left {
		transform: none;
	}

	.marker-tip.tip-right {
		transform: none;
	}

	.marker-tip::after {
		content: '';
		position: absolute;
		left: 50%;
		top: 100%;
		width: 9px;
		height: 9px;
		margin-left: -5px;
		margin-top: -5px;
		transform: rotate(45deg);
		background: var(--vr-surface);
		border-right: 1px solid var(--vr-line);
		border-bottom: 1px solid var(--vr-line);
	}

	.marker-tip.tip-left::after {
		left: 0.75rem;
	}

	.marker-tip.tip-right::after {
		left: auto;
		right: 0.75rem;
		margin-left: 0;
	}

	.tip-meta {
		display: block;
		color: var(--vr-muted);
		font-size: 0.66rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		margin-bottom: 0.2rem;
	}

	.tip-body {
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
		font-size: 0.82rem;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.wave-times {
		display: flex;
		justify-content: space-between;
		color: var(--vr-faint);
		font-size: 0.65rem;
		font-variant-numeric: tabular-nums;
		margin-top: 0.35rem;
	}

	@media (max-width: 640px) {
		.waveform {
			height: 68px;
			/* Let vertical swipes scroll the page; horizontal drags still scrub. */
			touch-action: pan-y;
		}

		.bars {
			gap: 0;
		}

		.wave-head {
			font-size: 0.62rem;
		}
	}
</style>
