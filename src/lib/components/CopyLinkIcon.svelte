<script lang="ts">
	/**
	 * Shared copy-link glyph: two stacked squares, swapping to a tick once copied.
	 * Every "copy link" affordance uses this so the iconography stays identical
	 * across the tracklist, comments and any future surface.
	 */
	let { copied = false, size = 15 }: { copied?: boolean; size?: number } = $props();
</script>

<svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
	{#if copied}
		<path
			d="M4 12.5l5 5L20 6.5"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	{:else}
		<rect
			x="9"
			y="9"
			width="11"
			height="11"
			rx="1.5"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
		/>
		<path
			d="M6 15V5.5A1.5 1.5 0 0 1 7.5 4H17"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
		/>
	{/if}
</svg>
