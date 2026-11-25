import { writable } from 'svelte/store';

interface InstallPromptEvent extends Event {
	prompt: () => Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** The deferred `beforeinstallprompt` event (Chrome/Android), once captured. */
export const installEvent = writable<InstallPromptEvent | null>(null);

/** Raised when the menu install button is tapped on iOS (no programmatic prompt). */
export const iosHintRequested = writable(false);

export function requestIosHint() {
	iosHintRequested.set(true);
}

/** Banner dismissed by the user (shared + persisted). */
export const bannerDismissed = writable(false);

const DISMISS_KEY = 'vr-install-banner-hidden';

export function initBannerDismissed() {
	if (typeof localStorage === 'undefined') return;
	if (localStorage.getItem(DISMISS_KEY) === '1') bannerDismissed.set(true);
}

export function dismissBanner() {
	bannerDismissed.set(true);
	try {
		localStorage.setItem(DISMISS_KEY, '1');
	} catch {
		// storage unavailable
	}
}

export function isIos(): boolean {
	if (typeof navigator === 'undefined') return false;
	if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return true;
	// iPadOS 13+ reports a desktop Mac user agent; touch support distinguishes it.
	return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

export function isStandalone(): boolean {
	if (typeof window === 'undefined') return false;
	return (
		window.matchMedia('(display-mode: standalone)').matches ||
		(navigator as unknown as { standalone?: boolean }).standalone === true
	);
}

export function initPwa() {
	if (typeof window === 'undefined') return;
	window.addEventListener('beforeinstallprompt', (e) => {
		e.preventDefault();
		installEvent.set(e as InstallPromptEvent);
	});
	window.addEventListener('appinstalled', () => installEvent.set(null));
}

/**
 * Kill-switch: service worker is fully bypassed until stale-cache /
 * lock-screen regressions are fixed. Flip to true to re-enable.
 */
const SW_ENABLED = false;

const SW_KILL_RELOAD_KEY = 'vr-sw-kill-reloaded';

export function registerServiceWorker() {
	if (typeof window === 'undefined') return;
	if (!('serviceWorker' in navigator)) return;

	if (!SW_ENABLED) {
		// Purge any previously installed SW and its caches (static/sw.js also
		// self-destructs). A stale SW served cached __data.json (old page data)
		// most stubbornly in Safari.
		const purge = Promise.all([
			navigator.serviceWorker.getRegistrations().then((registrations) =>
				Promise.all(
					registrations.map((reg) =>
						reg.unregister().catch(() => {
							// removal is non-fatal
						})
					)
				)
			),
			typeof caches !== 'undefined'
				? caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
				: Promise.resolve()
		]).catch(() => {
			// cleanup is non-fatal
		});

		// A worker that still controls the page keeps serving the old shell no
		// matter how many times the user reloads — reloads don't bypass the SW.
		// Reload once per tab so this navigation is served without SW control.
		let alreadyReloaded = false;
		try {
			alreadyReloaded = sessionStorage.getItem(SW_KILL_RELOAD_KEY) === '1';
		} catch {
			// storage unavailable
		}
		if (navigator.serviceWorker.controller !== null && !alreadyReloaded) {
			try {
				sessionStorage.setItem(SW_KILL_RELOAD_KEY, '1');
			} catch {
				// storage unavailable
			}
			void purge.finally(() => location.reload());
		} else {
			void purge;
		}
		return;
	}

	if (!import.meta.env.PROD) return;
	// Suspect: SW control correlates with iOS lock-screen audio death —
	// skip registration on iOS while the background-audio issue is open.
	if (isIos()) return;
	navigator.serviceWorker.register('/sw.js').catch(() => {
		// registration failure is non-fatal
	});
}
