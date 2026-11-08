<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	let {
		siteKey,
		action,
		onToken = () => {},
		onExpire = () => {}
	}: {
		siteKey: string;
		action: string;
		onToken?: (token: string) => void;
		onExpire?: () => void;
	} = $props();

	let container: HTMLDivElement | undefined = $state();
	let widgetId: number | undefined;
	let destroyed = false;

	const instanceId = Math.random().toString(36).slice(2);
	const globalName = `onVrTurnstileLoad${instanceId}`;

	function render() {
		if (destroyed || !container || !window.turnstile) return;
		widgetId = window.turnstile.render(container, {
			sitekey: siteKey,
			action,
			callback: (token: string) => onToken(token),
			'expired-callback': () => onExpire()
		});
		delete (window as unknown as Record<string, unknown>)[globalName];
	}

	onMount(() => {
		if (window.turnstile) {
			render();
			return;
		}
		(window as unknown as Record<string, unknown>)[globalName] = render;
		const script = document.createElement('script');
		script.src = `https://challenges.cloudflare.com/turnstile/v0/api.js?onload=${globalName}&render=explicit`;
		script.async = true;
		document.head.appendChild(script);

		return () => {
			delete (window as unknown as Record<string, unknown>)[globalName];
		};
	});

	onDestroy(() => {
		destroyed = true;
		if (widgetId !== undefined && window.turnstile) {
			try {
				window.turnstile.remove(widgetId);
			} catch {
				// Widget already gone; nothing to clean up.
			}
			widgetId = undefined;
		}
	});
</script>

<div bind:this={container} class="turnstile-wrap"></div>

<style>
	.turnstile-wrap {
		margin: 0.5rem 0;
	}
</style>
