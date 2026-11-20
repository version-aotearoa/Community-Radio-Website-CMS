<script lang="ts">
	/**
	 * Bracketed arrow chip for link affordances. Drawn as an inline SVG so the
	 * arrow's ink is optically centred at every size — text glyphs (←/→/↗) sit
	 * on the font's math axis and read low next to caps, and need VS15 to avoid
	 * emoji presentation on iOS.
	 */
	let {
		dir = 'right'
	}: {
		dir?: 'left' | 'right' | 'up-right';
	} = $props();

	const PATHS = {
		left: 'M15 5l-7 7 7 7',
		right: 'M9 5l7 7-7 7',
		'up-right': 'M7 17 17 7M9 7h8v8'
	} as const;
</script>

<span class="arrow-chip" aria-hidden="true">
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
		stroke-linecap="round" stroke-linejoin="round">
		<path d={PATHS[dir]} />
	</svg>
</span>
