<script lang="ts">
	import { WillowDark } from '@svar-ui/svelte-core';
	import { onMount } from 'svelte';
	import { slide, fade } from 'svelte/transition';
	import { invalidateAll } from '$app/navigation';
	import { page, updated } from '$app/state';
	import StreamPlayer from '$lib/components/StreamPlayer.svelte';
	import InstallPrompt from '$lib/components/InstallPrompt.svelte';
	import SocialLinks from '$lib/components/SocialLinks.svelte';
	import { initBannerDismissed, initPwa, registerServiceWorker } from '$lib/pwa';
	import { requestCollapsePlayer } from '$lib/stores/player';
	import { authClient } from '$lib/client';
	import { SITE_TITLE } from '$lib/site';
	import '@fontsource/anton/latin.css';
	import '@fontsource/hanken-grotesk/latin-400.css';
	import '@fontsource/hanken-grotesk/latin-600.css';
	import '@fontsource/jetbrains-mono/latin-500.css';
	import '../app.css';

	let { children } = $props();

	const user = $derived(page.data.user);
	let menuOpen = $state(false);
	let buildId = $state<string | null>(null);

	/* Phones held in landscape get a blocking "rotate your device" notice.
	   Derived from the PHYSICAL screen, never the viewport: on Chrome/Brave/
	   Firefox for iOS (and Android's keyboard resize) the on-screen keyboard
	   shrinks the layout viewport, which flips `@media (orientation: landscape)`
	   while the device is still portrait — that used to cover the whole UI the
	   moment a text field (chat composer, GIF search) was focused. */
	let rotateBlocked = $state(false);

	function physicalOrientation(): 'portrait' | 'landscape' {
		const so = window.screen?.orientation;
		if (so?.type) return so.type.startsWith('landscape') ? 'landscape' : 'portrait';
		// Legacy WebKit (iOS < 16.4): 90 / -90 means landscape.
		if (typeof window.orientation === 'number') {
			return Math.abs(window.orientation) === 90 ? 'landscape' : 'portrait';
		}
		return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
	}

	function updateRotateGate() {
		if (typeof window === 'undefined') return;
		const coarse = window.matchMedia('(pointer: coarse)').matches;
		// Phone-sized screen; the keyboard can't change these dimensions.
		const phone = Math.min(window.screen.width, window.screen.height) <= 500;
		const active = document.activeElement;
		// Never gate while someone is typing: this is exactly the case keyboards
		// fool the old viewport rule with, and a field in landscape is harmless.
		const typing =
			active instanceof HTMLElement &&
			(active.matches('input, textarea, select') || active.isContentEditable);
		rotateBlocked = coarse && phone && !typing && physicalOrientation() === 'landscape';
	}

	// Preview builds show their build id so it is obvious which deploy is live;
	// production stays clean.
	function isPreviewHost() {
		if (typeof location === 'undefined') return false;
		const host = location.hostname;
		return host === 'localhost' || host.endsWith('.pages.dev') || host === 'dev.versionradio.live';
	}

	async function loadBuildId() {
		try {
			const res = await fetch('/_app/version.json', { cache: 'no-store' });
			const data = (await res.json()) as { version?: string };
			buildId = data.version ?? null;
			console.log('[version]', buildId);
		} catch {
			// build id is non-critical
		}
	}

	// The update toast's Refresh must not be served by a stale SW or HTTP cache:
	// purge both, then reload.
	async function forceRefresh() {
		try {
			if ('serviceWorker' in navigator) {
				const registrations = await navigator.serviceWorker.getRegistrations();
				await Promise.all(registrations.map((reg) => reg.unregister()));
			}
		} catch {
			// unregister is non-fatal
		}
		try {
			if (typeof caches !== 'undefined') {
				await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
			}
		} catch {
			// cache purge is non-fatal
		}
		location.reload();
	}

	// Current path for highlighting the active nav link (prefix match so
	// sub-pages keep their parent item highlighted).
	const path = $derived(page.url.pathname);

	function closeMenu() {
		menuOpen = false;
	}

	async function signOut() {
		await authClient.signOut();
		await invalidateAll();
	}

	function initials(u: { name?: string | null; email?: string | null }): string {
		const words = u.name?.trim().split(/\s+/).filter(Boolean) ?? [];
		if (words.length > 0) return words.slice(0, 2).map((w) => w[0]).join('').toUpperCase();
		return (u.email?.[0] ?? '?').toUpperCase();
	}

	onMount(() => {
		initPwa();
		initBannerDismissed();
		registerServiceWorker();
		void loadBuildId();

		// Tap/click outside the mobile menu (or the toggle) closes it.
		// Also covers the player bar: its expand chev is outside the menu,
		// so opening the max player closes the menu via this same handler.
		const onDocPointer = (e: PointerEvent) => {
			if (!menuOpen) return;
			const t = e.target as Node | null;
			if (!t) return;
			const el = t instanceof Element ? t : t.parentElement;
			if (el?.closest('.mobile-menu') || el?.closest('.menu-toggle')) return;
			closeMenu();
		};
		document.addEventListener('pointerdown', onDocPointer);

		// Safari serves back/forward pages from bfcache frozen — no onMount, no
		// load re-run — so refresh data on restore or pages show stale content
		// (e.g. an edited show description or DJ name).
		const onPageshow = (e: PageTransitionEvent) => {
			if (e.persisted) void invalidateAll();
		};
		window.addEventListener('pageshow', onPageshow);

		updateRotateGate();
		const coarseQuery = window.matchMedia('(pointer: coarse)');
		// focusout fires before activeElement moves on — re-check on the next task.
		const onFocusOut = () => setTimeout(updateRotateGate, 0);
		window.addEventListener('resize', updateRotateGate);
		window.addEventListener('orientationchange', updateRotateGate);
		window.screen.orientation?.addEventListener?.('change', updateRotateGate);
		coarseQuery.addEventListener('change', updateRotateGate);
		document.addEventListener('focusin', updateRotateGate);
		document.addEventListener('focusout', onFocusOut);

		return () => {
			document.removeEventListener('pointerdown', onDocPointer);
			window.removeEventListener('pageshow', onPageshow);
			window.removeEventListener('resize', updateRotateGate);
			window.removeEventListener('orientationchange', updateRotateGate);
			window.screen.orientation?.removeEventListener?.('change', updateRotateGate);
			coarseQuery.removeEventListener('change', updateRotateGate);
			document.removeEventListener('focusin', updateRotateGate);
			document.removeEventListener('focusout', onFocusOut);
		};
	});
</script>

<svelte:head>
	<title>{SITE_TITLE}</title>
</svelte:head>

<WillowDark fonts={false}>
	<div class="shell">
		<header class="site-header">
			<a class="brand" href="/" aria-label="Version Radio home" onclick={requestCollapsePlayer}>
				<img class="brand-logo" src="/version-logo.svg" alt="VERSION" />
			</a>
			<button
				class="menu-toggle"
				aria-label="Menu"
				aria-expanded={menuOpen}
				onclick={() => (menuOpen = !menuOpen)}
			>
				{#if menuOpen}
					<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
						<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
					</svg>
				{:else}
					<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
						<path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
					</svg>
				{/if}
			</button>
			<nav class="site-nav" aria-label="Primary">
				<a href="/shows" class:active={path.startsWith('/shows')}>Shows</a>
				<a href="/schedule" class:active={path.startsWith('/schedule')}>Schedule</a>
				<a href="/chat" class:active={path.startsWith('/chat')}>Chat</a>
				<a href="/news" class:active={path.startsWith('/news')}>News</a>
				<a href="/info" class:active={path.startsWith('/info')}>Info</a>
				{#if user && user.role === 'admin'}
					<a href="/studio" class:active={path.startsWith('/studio')}>Studio</a>
				{/if}
				<!-- Install prompt disabled for now
				<InstallPrompt variant="menu" />
				-->
			</nav>
			{#if user}
				<div class="account">
					<a class="avatar" href="/account" title={user.email} aria-label="My Version: {user.name || user.email}">
						{#if user.image}
							<img class="avatar-img" src={user.image} alt="" />
						{:else}
							<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
								<circle cx="12" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8" />
								<path
									d="M5.5 19a6.5 6.5 0 0 1 13 0"
									fill="none"
									stroke="currentColor"
									stroke-width="1.8"
									stroke-linecap="round"
								/>
							</svg>
							<span class="mono avatar-initials">{initials(user)}</span>
						{/if}
					</a>
				</div>
			{:else}
				<a class="signin" href="/login">Sign in</a>
			{/if}
		</header>

		{#if menuOpen}
			<div class="menu-scrim" aria-hidden="true" onclick={closeMenu} transition:fade={{ duration: 160 }}></div>
			<div class="mobile-menu" transition:slide={{ duration: 220 }}>
				<nav aria-label="Mobile">
					<a href="/shows" onclick={closeMenu}>Shows</a>
					<a href="/schedule" onclick={closeMenu}>Schedule</a>
					<a href="/chat" onclick={closeMenu}>Chat</a>
					<a href="/news" onclick={closeMenu}>News</a>
					<a href="/info" onclick={closeMenu}>Info</a>
					{#if user}
						{#if user.role === 'admin'}
							<a href="/studio" onclick={closeMenu}>Studio</a>
						{/if}
						<a href="/account" onclick={closeMenu}>My Version</a>
					{:else}
						<a href="/login" onclick={closeMenu}>Sign in > My Version</a>
					{/if}
				</nav>
				<div class="mobile-menu-secondary">
					<a href="/info#contact" onclick={closeMenu}>Contact</a>
					<a href="/info#terms" onclick={closeMenu}>Terms</a>
					<a href="/info#about" onclick={closeMenu}>About</a>
					<SocialLinks onlink={closeMenu} />
				</div>
				<!-- Install banner hidden for now
				<div class="menu-install">
					<InstallPrompt variant="banner" dismissable={false} />
				</div>
				-->
			</div>
		{/if}

		<main class="site-main">
			{@render children()}
		</main>

		<footer class="site-footer">
			<img class="footer-logo" src="/version-logo.svg" alt="VERSION" />
			<span class="footer-note mono">Version Radio · Aotearoa</span>
			{#if buildId && isPreviewHost()}
				<span class="build-stamp mono" title="Build id">{buildId}</span>
			{/if}
			<nav class="footer-links" aria-label="Footer">
				<a href="/info#contact">Contact</a>
				<a href="/info#terms">Terms</a>
				<a href="/info#about">About</a>
				<SocialLinks />
			</nav>
			{#if user}
				<button class="footer-signout" onclick={signOut}>Sign out</button>
			{/if}
		</footer>

		<StreamPlayer />

		{#if updated.current}
			<div class="update-toast" role="status">
				<span class="mono">New version available</span>
				<button class="update-refresh" onclick={forceRefresh}>Refresh</button>
			</div>
		{/if}
	</div>
</WillowDark>

<div class="rotate-notice" class:show={rotateBlocked} role="status" aria-live="polite">
	<img class="rotate-logo" src="/version-logo.svg" alt="VERSION" />
	<p class="rotate-title">Please rotate your device</p>
	<span class="mono">Version Radio is built for portrait</span>
</div>

<style>
	.shell {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		background: var(--vr-bg);
		color: var(--vr-text);
		padding-bottom: 64px;
	}

	.update-toast {
		position: fixed;
		left: 50%;
		bottom: 76px;
		transform: translateX(-50%);
		z-index: 60;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--vr-line);
		background: var(--vr-bg);
		color: var(--vr-text);
		font-size: 0.85rem;
		box-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
	}

	.update-refresh {
		border: 1px solid var(--vr-line);
		background: var(--vr-text);
		color: var(--vr-bg);
		font: inherit;
		padding: 0.25rem 0.7rem;
		cursor: pointer;
	}

	.update-refresh:hover {
		background: var(--vr-bg);
		color: var(--vr-text);
	}

	.site-header {
		position: sticky;
		top: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		gap: 1.5rem;
		padding: 0.75rem 2rem;
		background: var(--vr-surface);
		border-bottom: 1px solid var(--vr-line);
	}

	.brand {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		text-decoration: none;
		color: var(--vr-text);
	}

	.brand-logo {
		height: 20px;
		width: auto;
		display: block;
	}

	.site-nav {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-left: auto;
	}

	.site-nav a {
		font-family: var(--vr-font-headline);
		font-size: 1.125rem;
		line-height: 1.2;
		text-transform: uppercase;
		letter-spacing: 0.02em;
		color: var(--vr-text);
		text-decoration: none;
		padding: 0.5rem 1.25rem;
		border-bottom: 2px solid transparent;
		transition: color 150ms, background-color 150ms;
	}

	.site-nav a:hover,
	.site-nav a.active {
		color: var(--vr-black);
		background: var(--vr-text);
	}

	.menu-toggle {
		display: none;
		margin-left: auto;
		background: none;
		border: none;
		color: var(--vr-text);
		padding: 0.4rem;
		cursor: pointer;
	}

	.mobile-menu {
		position: fixed;
		top: 57px;
		left: 0;
		right: 0;
		z-index: 40;
		background: var(--vr-surface);
		border-bottom: 1px solid var(--vr-line);
		padding: 0;
	}

	.menu-scrim {
		position: fixed;
		top: 57px;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 35;
		background: rgba(0, 0, 0, 0.55);
		backdrop-filter: blur(2px);
		-webkit-backdrop-filter: blur(2px);
	}

	.mobile-menu nav {
		display: flex;
		flex-direction: column;
	}

	.mobile-menu a {
		color: var(--vr-text);
		text-decoration: none;
		font-family: var(--vr-font-headline);
		font-size: 1.25rem;
		text-transform: uppercase;
		padding: 0.85rem 2rem;
		border: none;
		border-bottom: 1px solid var(--vr-line-muted);
		background: none;
		text-align: left;
		cursor: pointer;
	}

	.mobile-menu a:hover {
		background: var(--vr-text);
		color: var(--vr-black);
	}

	.mobile-menu-secondary {
		display: flex;
		gap: 0;
		padding: 0.5rem 2rem;
		border-top: 1px solid var(--vr-line);
		margin-top: 0.4rem;
	}

	.mobile-menu-secondary a {
		border: none;
		background: none;
		font-family: var(--vr-font-mono);
		font-size: 0.72rem;
		font-weight: 500;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--vr-muted);
		text-decoration: none;
		padding: 0.5rem 1rem 0.5rem 0;
		margin-right: 1rem;
	}

	.mobile-menu-secondary a:hover {
		color: var(--vr-text);
		text-decoration: underline;
		background: none;
	}

	@media (max-width: 720px) {
		.menu-toggle {
			display: block;
		}

		.site-nav,
		.account,
		.signin {
			display: none;
		}
	}

	.site-main {
		flex: 1;
		width: 100%;
		max-width: 100rem;
		margin: 0 auto;
	}

	.signin {
		color: var(--vr-text);
		text-decoration: none;
		font-family: var(--vr-font-mono);
		font-size: 0.82rem;
		font-weight: 500;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		border: 1px solid var(--vr-line);
		padding: 0.45rem 1rem;
		transition: color 150ms, background-color 150ms;
	}

	.signin:hover {
		background: var(--vr-text);
		color: var(--vr-black);
	}

	.account {
		display: flex;
		align-items: center;
	}

	.avatar {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		border: 1px solid var(--vr-line);
		color: var(--vr-text);
		text-decoration: none;
		padding: 0.4rem 0.65rem;
		transition: color 150ms, background-color 150ms;
	}

	.avatar:hover {
		background: var(--vr-text);
		color: var(--vr-black);
	}

	.avatar-initials {
		font-size: 0.78rem;
	}

	.avatar-img {
		width: 16px;
		height: 16px;
		object-fit: cover;
		display: block;
	}

	.site-footer {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 1rem 2rem;
		border-top: 1px solid var(--vr-line);
		color: var(--vr-muted);
	}

	.footer-logo {
		height: 18px;
		width: auto;
		display: block;
	}

	.footer-note {
		color: var(--vr-faint);
		margin-left: auto;
	}

	.build-stamp {
		color: var(--vr-faint);
		border: 1px solid var(--vr-line-muted);
		padding: 0.1rem 0.4rem;
		font-size: 0.66rem;
	}

	.footer-links {
		display: flex;
		gap: 1rem;
	}

	.footer-links a {
		border: none;
		background: none;
		color: var(--vr-muted);
		text-decoration: none;
		font-family: var(--vr-font-mono);
		font-size: 0.72rem;
		font-weight: 500;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		padding: 0;
	}

	.footer-links a:hover {
		color: var(--vr-text);
		text-decoration: underline;
	}

	.footer-signout {
		background: none;
		border: 1px solid var(--vr-line-muted);
		color: var(--vr-muted);
		font-family: var(--vr-font-mono);
		font-size: 0.72rem;
		font-weight: 500;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		padding: 0.35rem 0.7rem;
		cursor: pointer;
		margin-left: 1rem;
	}

	.footer-signout:hover {
		border-color: var(--vr-line);
		color: var(--vr-text);
	}

	@media (max-width: 720px) {
		.site-header {
			padding: 0.75rem 1rem;
		}

		.footer-note,
		.build-stamp {
			display: none;
		}

		/* Keep the social icons in the footer on phones; hide the text links. */
		.footer-links {
			margin-left: auto;
		}

		.footer-links a:not(.social) {
			display: none;
		}

		.site-footer {
			padding-left: 1rem;
		}
	}

	.rotate-notice {
		display: none;
	}

	/* Phones held in landscape — block the UI (manifest orientation only locks
	   the installed Android PWA; iOS/browser need this). `.show` comes from
	   updateRotateGate(), which reads the physical screen: the on-screen
	   keyboard cannot fake landscape the way a CSS orientation query can. */
	.rotate-notice.show {
		position: fixed;
		inset: 0;
		z-index: 1000;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		padding: 2rem;
		text-align: center;
		background: var(--vr-bg-deep);
		color: var(--vr-text);
	}

	.rotate-logo {
		height: 28px;
		width: auto;
		display: block;
	}

	.rotate-title {
		margin: 0;
		font-family: var(--vr-font-headline);
		font-size: 1.5rem;
		font-weight: 400;
		text-transform: uppercase;
		letter-spacing: 0.01em;
	}
</style>
