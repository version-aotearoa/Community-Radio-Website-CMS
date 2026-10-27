import { GENERAL_SHOW_IMAGE } from '$lib/azuracast';

/**
 * One-shot-per-step <img> error fallback chain: swaps `src` to the next
 * candidate the first time the current artwork fails to load. Candidates are
 * tried in order, skipping any that equal the current `src`, and the general
 * show image is always appended as the last resort. Never retries a URL, so a
 * genuinely-broken chain can't loop.
 *
 * Pass a single URL, or an array when the caller has a richer identity chain
 * (e.g. [show.image, show.dj_image]).
 */
export function artOnError(
	e: Event,
	fallback: string | null | undefined | readonly (string | null | undefined)[]
) {
	const img = e.currentTarget as HTMLImageElement;
	const given = typeof fallback === 'string' ? [fallback] : (fallback ?? []);
	const chain = [...given, GENERAL_SHOW_IMAGE].filter((u): u is string => Boolean(u));

	const current = img.getAttribute('src');
	let i = Number(img.dataset.vrFb ?? '-1');
	do {
		i += 1;
	} while (i < chain.length && chain[i] === current);

	if (i >= chain.length) return;
	img.dataset.vrFb = String(i);
	img.src = chain[i];
}
