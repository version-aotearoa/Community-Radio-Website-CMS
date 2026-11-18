/**
 * Restore 1× page zoom once the on-screen keyboard closes.
 *
 * iOS Safari zooms in when a text field under 16px takes focus, and does not
 * always zoom back out when the keyboard is dismissed — the page is left
 * magnified. There is no API to set the zoom level, so the only reliable reset
 * is to briefly force a 1× scale through the viewport meta, then restore it so
 * pinch-zoom keeps working.
 *
 * Touch devices only: desktop browsers never auto-zoom on focus, and their
 * page scaling must be left alone.
 */

const TEXT_FIELD = [
	'input:not([type="button" i], [type="checkbox" i], [type="radio" i], [type="submit" i], [type="reset" i], [type="file" i], [type="range" i], [type="color" i])',
	'textarea',
	'[contenteditable="true"]'
].join(', ');

/** How recently a text field must have been touched for a zoom reset. */
const RESET_DELAY_MS = 300;
/** A viewport height jump larger than this means the keyboard collapsed. */
const KEYBOARD_CLOSED_PX = 80;

export function resetZoomOnKeyboardClose(): () => void {
	if (typeof window === 'undefined') return () => {};

	const vv = window.visualViewport;
	if (!vv) return () => {};

	// Phones/tablets only.
	if (!window.matchMedia('(pointer: coarse)').matches) return () => {};

	let timer: ReturnType<typeof setTimeout> | undefined;
	let fieldFocused = false;
	let lastHeight = vv.height;

	const reset = () => {
		timer = undefined;
		if (vv.scale <= 1.01) return;
		const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
		if (!meta) return;
		const original = meta.getAttribute('content') ?? 'width=device-width, initial-scale=1';
		meta.setAttribute('content', `${original}, maximum-scale=1`);
		// Restore on the next frames so pinch-zoom is not left disabled.
		requestAnimationFrame(() => {
			requestAnimationFrame(() => meta.setAttribute('content', original));
		});
	};

	const schedule = () => {
		clearTimeout(timer);
		timer = setTimeout(reset, RESET_DELAY_MS);
	};

	function isTextField(el: EventTarget | null): boolean {
		return el instanceof HTMLElement && el.closest(TEXT_FIELD) !== null;
	}

	const onFocusIn = (e: FocusEvent) => {
		if (isTextField(e.target)) fieldFocused = true;
	};

	const onFocusOut = (e: FocusEvent) => {
		if (!isTextField(e.target)) return;
		fieldFocused = false;
		schedule();
	};

	// Backup for dismissed keyboards that keep focus (e.g. the iOS "Done"
	// key): the visual viewport grows sharply as the keyboard collapses.
	const onViewportResize = () => {
		const height = vv.height;
		const keyboardClosed = height > lastHeight + KEYBOARD_CLOSED_PX;
		lastHeight = height;
		if (keyboardClosed && fieldFocused) schedule();
	};

	document.addEventListener('focusin', onFocusIn);
	document.addEventListener('focusout', onFocusOut);
	vv.addEventListener('resize', onViewportResize);

	return () => {
		clearTimeout(timer);
		document.removeEventListener('focusin', onFocusIn);
		document.removeEventListener('focusout', onFocusOut);
		vv.removeEventListener('resize', onViewportResize);
	};
}
