<script lang="ts">
	import { formatTrackTime } from '$lib/trackTime';
	import type { ChatMessage } from '$lib/chat';

	let {
		replayUrl,
		duration,
		currentTime,
		comments,
		seed,
		onSeek,
		onComment,
		disabled = false
	}: {
		replayUrl: string | null;
		duration: number | null;
		currentTime: number;
		comments: ChatMessage[];
		seed: string;
		onSeek: (seconds: number) => void;
		onComment: (seconds: number) => void;
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

	const bars = $derived(makeBars(seed, BAR_COUNT));

	let probedDuration = $state<number | null>(null);
	let scrub = $state<number | null>(null);
	let scrubbing = $state(false);

	const total = $derived(
		duration && Number.isFinite(duration) && duration > 0
			? duration
			: probedDuration && Number.isFinite(probedDuration) && probedDuration > 0
				? probedDuration
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
				content: m.content
			}))
	);

	let hoveredMarkerId = $state<string | null>(null);
	const hoveredMarker = $derived(markers.find((m) => m.id === hoveredMarkerId) ?? null);

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
		if (!url) return;
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

	function secondsAt(clientX: number, el: HTMLElement): number {
		if (!total) return 0;
		const rect = el.getBoundingClientRect();
		const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
		return fraction * total;
	}

	function onPointerDown(e: PointerEvent) {
		if (!active) return;
		const el = e.currentTarget as HTMLElement;
		scrubbing = true;
		scrub = secondsAt(e.clientX, el);
		el.setPointerCapture?.(e.pointerId);
	}

	function onPointerMove(e: PointerEvent) {
		if (!scrubbing) return;
		scrub = secondsAt(e.clientX, e.currentTarget as HTMLElement);
	}

	function onPointerEnd(e: PointerEvent) {
		if (!scrubbing) return;
		const target = secondsAt(e.clientX, e.currentTarget as HTMLElement);
		scrubbing = false;
		scrub = null;
		onSeek(target);
	}

	function onKeyDown(e: KeyboardEvent) {
		if (!active || !total) return;
		const step = e.shiftKey ? 30 : 5;
		let next = shown;
		if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next -= step;
		else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next += step;
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = total;
		else return;
		e.preventDefault();
		onSeek(Math.max(0, Math.min(total, next)));
	}

	function pinStyle(at: number): string {
		if (!total) return 'display:none';
		return `left:${Math.max(0, Math.min(100, (at / total) * 100))}%`;
	}
</script>

{#if replayUrl}
	<div class="waveform-shell" class:disabled={!active}>
		<div class="wave-head mono">
			<span>Waveform</span>
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
			class:inactive={!active}
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
			onkeydown={onKeyDown}
		>
			<div class="bars" aria-hidden="true">
				{#each bars as height, i (i)}
					<span
						class:played={total ? shown / total >= i / bars.length : false}
						style:height={`${height * 100}%`}
					></span>
				{/each}
			</div>
			<div class="played-shade" aria-hidden="true" style:width={`${pct}%`}></div>
			<div class="playhead" aria-hidden="true" style:left={`${pct}%`}></div>
			{#each markers as marker (marker.id)}
				<button
					type="button"
					class="pin"
					style={pinStyle(marker.at)}
					aria-label={`Jump to comment by ${marker.name} at ${formatTrackTime(marker.at)}`}
					aria-describedby={hoveredMarkerId === marker.id ? 'wave-tip' : undefined}
					onpointerdown={(e) => e.stopPropagation()}
					onpointerenter={() => (hoveredMarkerId = marker.id)}
					onpointerleave={() => (hoveredMarkerId = null)}
					onfocus={() => (hoveredMarkerId = marker.id)}
					onblur={() => (hoveredMarkerId = null)}
					onclick={(e) => {
						e.stopPropagation();
						onSeek(marker.at);
					}}
				></button>
			{/each}
			{#if hoveredMarker}
				<div
					id="wave-tip"
					class="marker-tip {markerTipClass(hoveredMarker.at)}"
					style={markerTipStyle(hoveredMarker.at)}
					role="tooltip"
				>
					<span class="tip-meta mono">{hoveredMarker.name} · {formatTrackTime(hoveredMarker.at)}</span>
					<span class="tip-body">{hoveredMarker.content || 'GIF comment'}</span>
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
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.45rem;
		color: var(--vr-muted);
		font-size: 0.68rem;
		letter-spacing: 0.05em;
		text-transform: uppercase;
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
		background: var(--vr-red);
		pointer-events: none;
		transform: translateX(-1px);
	}

	.pin {
		position: absolute;
		top: -4px;
		width: 9px;
		height: 12px;
		margin-left: -4px;
		padding: 0;
		border: 1px solid var(--vr-red);
		background: var(--vr-bg);
		cursor: pointer;
		z-index: 2;
	}

	.pin::after {
		content: '';
		position: absolute;
		left: 3px;
		top: 3px;
		width: 1px;
		height: 6px;
		background: var(--vr-red);
	}

	.pin:hover,
	.pin:focus-visible {
		background: var(--vr-red);
		outline: none;
	}

	.pin:hover::after,
	.pin:focus-visible::after {
		background: var(--vr-bg);
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
		pointer-events: none;
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
		}

		.bars {
			gap: 0;
		}

		.wave-head {
			font-size: 0.62rem;
		}
	}
</style>
