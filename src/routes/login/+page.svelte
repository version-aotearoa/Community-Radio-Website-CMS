<script lang="ts">
	import { Button, Field, Text } from '@svar-ui/svelte-core';
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { authClient } from '$lib/client';
	import Turnstile from '$lib/components/Turnstile.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import { displayNameFor, needsDisplayName } from '$lib/displayName';

	let { data } = $props();

	let email = $state('');
	let displayName = $state('');
	let sent = $state(false);
	let error = $state('');
	let urlError = $state('');
	let busy = $state(false);
	let turnstileToken = $state('');
	let turnstileExpired = $state(false);
	let termsDialog = $state<HTMLDialogElement | null>(null);

	function openTerms() {
		termsDialog?.showModal();
	}

	const user = $derived(data.user);
	const { github, google } = $derived(data.providers);

	onMount(() => {
		// A consumed/expired magic-link bounces back here with ?error (via
		// errorCallbackURL '/login'). Surface it instead of silently dropping it.
		const params = new URLSearchParams(window.location.search);
		if (!params.get('error')) return;
		urlError =
			params.get('error_description') ||
			(params.get('error') === 'INVALID_TOKEN'
				? 'This sign-in link was already used or has expired — request a new one.'
				: 'This sign-in link is no longer valid — request a new one.');
	});

	function onTurnstileToken(token: string) {
		turnstileToken = token;
		turnstileExpired = false;
	}

	function onTurnstileExpire() {
		turnstileToken = '';
		turnstileExpired = true;
	}

	async function sendMagicLink() {
		// Lock synchronously before the async Turnstile check: the svar-ui
		// Button renders type="submit", so a click also submits the form — a
		// second send would fire unless busy is already set (→ 2 magic links).
		if (busy) return;
		busy = true;
		error = '';
		urlError = '';
		if (!email.trim()) {
			error = 'Enter your email address first.';
			busy = false;
			return;
		}
		if (data.siteKey) {
			if (!turnstileToken) {
				error = turnstileExpired ? 'Verification expired — please verify again.' : 'Please complete the verification.';
				busy = false;
				return;
			}
			const vr = await fetch('/api/verify-turnstile', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: turnstileToken })
			});
			if (!vr.ok) {
				error = 'Verification failed. Please try again.';
				turnstileToken = '';
				busy = false;
				return;
			}
		}
		const name = displayName.trim().slice(0, 50);
		if (name.includes('@')) {
			error = 'Use a display name, not an email address.';
			busy = false;
			return;
		}
		const res = await authClient.signIn.magicLink({
			email,
			callbackURL: '/',
			errorCallbackURL: '/login',
			...(name ? { name } : {})
		});
		busy = false;
		if (res.error) {
			error = res.error.message ?? 'Something went wrong. Please try again.';
			return;
		}
		sent = true;
	}

	async function signInWith(provider: 'github' | 'google') {
		error = '';
		await authClient.signIn.social({ provider, callbackURL: '/' });
	}

	async function signOut() {
		await authClient.signOut();
		await invalidateAll();
	}
</script>

<svelte:head>
	<title>Sign in — Version Radio</title>
</svelte:head>

<Seo />

<div class="login-wrap">
	<section class="card">
		{#if user}
			<h1>Signed in</h1>
			<p class="muted">
				You're signed in as <strong>{displayNameFor(user)}</strong>.
			</p>
			{#if needsDisplayName(user)}
				<p class="muted">
					Set a display name so chat doesn't show you as “Listener” —
					<a class="hint-link" href="/account">My Version → Profile</a>
				</p>
			{/if}
			<Button css="vr-cta ghost" type="primary" onclick={signOut}>Sign out</Button>
		{:else}
			<h1>Sign in to Version Radio</h1>
			<p class="muted">Get a sign-in link by email, or use one of your accounts.</p>

			{#if urlError}
				<div class="notice bad">{urlError}</div>
			{/if}

			{#if sent}
				<div class="notice ok">Check your inbox — we've emailed you a sign-in link.</div>
			{:else}
				<form onsubmit={(e) => { e.preventDefault(); sendMagicLink(); }}>
					<Field label="Display name (optional)">
						<Text
							type="text"
							placeholder="Used when creating your account"
							bind:value={displayName}
							css="vr-input"
						/>
					</Field>
					<Field label="Email">
						<Text
							type="text"
							placeholder="you@example.com"
							bind:value={email}
							css="vr-input"
						/>
					</Field>
					{#if data.siteKey}
						<Turnstile
							siteKey={data.siteKey}
							action="login"
							onToken={onTurnstileToken}
							onExpire={onTurnstileExpire}
						/>
					{/if}
					{#if error}
						<div class="notice bad">{error}</div>
					{/if}
					<Button
						css="vr-cta"
						type="primary"
						disabled={busy}
						onclick={(e) => {
							e.preventDefault();
							sendMagicLink();
						}}
					>
						{busy ? 'Sending…' : 'Email me a sign-in link'}
					</Button>
				</form>

				{#if github || google}
					<div class="divider"><span>or continue with</span></div>
					<div class="socials">
						{#if github}
							<Button css="vr-cta ghost" onclick={() => signInWith('github')}>GitHub</Button>
						{/if}
						{#if google}
							<Button css="vr-cta ghost" onclick={() => signInWith('google')}>Google</Button>
						{/if}
					</div>
				{/if}
			{/if}

			<p class="terms">
				By signing in, you agree to our <a
					href="/info#terms"
					onclick={(e) => {
						e.preventDefault();
						openTerms();
					}}>Terms of Use</a
				>.
			</p>
		{/if}
	</section>
</div>

<dialog
	bind:this={termsDialog}
	class="terms-modal"
	aria-labelledby="terms-title"
	onclick={(e) => {
		if (e.target === e.currentTarget) termsDialog?.close();
	}}
>
	<div class="terms-modal-inner">
		<div class="terms-modal-head">
			<h2 id="terms-title">Terms of Use</h2>
			<button class="terms-close" type="button" aria-label="Close" onclick={() => termsDialog?.close()}>
				<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
					<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
				</svg>
			</button>
		</div>
		<div class="terms-modal-body">
			{#if data.terms}
				{@html data.terms}
			{:else}
				<p class="muted">Terms are unavailable right now.</p>
			{/if}
		</div>
	</div>
</dialog>

<style>
	.login-wrap {
		max-width: 26rem;
		margin: 2rem auto;
		padding: 0 1rem;
	}

	.card {
		border: 1px solid var(--vr-line);
		background: var(--vr-surface);
		padding: 1.75rem 2rem;
	}

	h1 {
		margin: 0 0 0.5rem;
		font-family: var(--vr-font-headline);
		font-size: 1.9rem;
		font-weight: 400;
		line-height: 1;
		text-transform: uppercase;
		letter-spacing: 0.01em;
	}

	.muted {
		color: var(--vr-muted);
		margin: 0 0 1.25rem;
	}

	.hint-link {
		color: var(--vr-text);
		text-decoration: underline;
	}

	.terms {
		margin: 1.75rem 0 0;
		padding-top: 1rem;
		border-top: 1px solid var(--vr-line-muted);
		color: var(--vr-faint);
		font-size: 0.8rem;
	}

	.terms a {
		color: var(--vr-muted);
		text-decoration: underline;
	}

	.terms a:hover {
		color: var(--vr-text);
	}

	.divider {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin: 1.25rem 0;
		color: var(--vr-muted);
		font-size: 0.85rem;
		font-family: var(--vr-font-mono);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.divider::before,
	.divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--vr-line-muted);
	}

	.socials {
		display: flex;
		gap: 0.75rem;
	}

	.notice {
		margin: 0.5rem 0 1rem;
		padding: 0.6rem 0.85rem;
		border: 1px solid var(--vr-line);
		font-size: 0.9rem;
	}

	.notice.ok {
		color: var(--vr-muted);
	}

	.notice.bad {
		color: var(--vr-text);
	}

	/* Terms modal (native <dialog>; top-layer gives focus trap + Esc) */
	.terms-modal {
		border: 1px solid var(--vr-line);
		background: var(--vr-surface);
		color: var(--vr-text);
		padding: 0;
		margin: auto;
		width: min(32rem, calc(100vw - 2rem));
	}

	/* Flex lives on an inner wrapper, not the <dialog>: changing the dialog's
	   own display breaks the UA margin-auto centering in WebKit. */
	.terms-modal-inner {
		display: flex;
		flex-direction: column;
		max-height: min(80vh, 42rem);
	}

	.terms-modal::backdrop {
		background: rgba(0, 0, 0, 0.7);
		backdrop-filter: blur(2px);
		-webkit-backdrop-filter: blur(2px);
	}

	.terms-modal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-shrink: 0;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid var(--vr-line);
	}

	.terms-modal-head h2 {
		margin: 0;
		font-family: var(--vr-font-headline);
		font-size: 1.25rem;
		font-weight: 400;
		line-height: 1;
		text-transform: uppercase;
		letter-spacing: 0.01em;
	}

	.terms-close {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		flex-shrink: 0;
		border: 1px solid var(--vr-line);
		background: transparent;
		color: var(--vr-text);
		padding: 0;
		cursor: pointer;
	}

	.terms-close:hover {
		background: var(--vr-text);
		color: var(--vr-black);
	}

	.terms-modal-body {
		padding: 1.25rem;
		overflow-y: auto;
		min-height: 0;
		font-size: 0.95rem;
		line-height: 1.55;
	}

	.terms-modal-body :global(p) {
		margin: 0 0 0.85rem;
	}

	.terms-modal-body :global(p:last-child) {
		margin-bottom: 0;
	}

	.terms-modal-body :global(h1),
	.terms-modal-body :global(h2),
	.terms-modal-body :global(h3),
	.terms-modal-body :global(h4) {
		font-family: var(--vr-font-headline);
		font-size: 1.1rem;
		text-transform: uppercase;
		margin: 1.25rem 0 0.5rem;
	}

	.terms-modal-body :global(a) {
		color: var(--vr-green);
	}

	.terms-modal-body :global(ul),
	.terms-modal-body :global(ol) {
		margin: 0 0 0.85rem;
		padding-left: 1.25rem;
	}

	.terms-modal-body :global(li) {
		margin: 0.25rem 0;
	}

	.terms-modal-body :global(code) {
		font-family: var(--vr-font-mono);
		font-size: 0.9em;
	}

	.terms-modal-body :global(pre) {
		background: var(--vr-surface-low);
		border: 1px solid var(--vr-line);
		padding: 0.75rem;
		overflow-x: auto;
	}

	.terms-modal-body :global(blockquote) {
		border-left: 2px solid var(--vr-green);
		margin: 0.75rem 0;
		padding-left: 0.85rem;
		color: var(--vr-muted);
	}
</style>
