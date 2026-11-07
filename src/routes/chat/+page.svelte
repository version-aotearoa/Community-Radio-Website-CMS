<script lang="ts">
	import ChatPanel from '$lib/components/ChatPanel.svelte';
	import Seo from '$lib/components/Seo.svelte';

	let { data } = $props();
</script>

<svelte:head>
	<title>{data.isEpisodeRoom ? 'Episode chat' : 'Chat'} — Version Radio</title>
</svelte:head>

<Seo />

<div class="page">
	{#if data.isEpisodeRoom}
		<div class="room-head">
			<p class="eyebrow mono">Episode chat</p>
			<h1 class="room-title">{data.roomLabel}</h1>
			<p class="room-links mono">
				{#if data.episodeHref}
					<a href={data.episodeHref}>Back to episode</a> ·
				{/if}
				<a href="/chat">Global chat</a>
			</p>
		</div>
	{/if}

	{#key data.room}
		<ChatPanel
			room={data.room}
			chatUrl={data.chatUrl}
			siteKey={data.siteKey}
			giphyKey={data.giphyKey}
			user={data.user}
			mode="chat"
			initialMessages={data.initialMessages}
		/>
	{/key}
</div>

<style>
	.page {
		padding: var(--vr-pad);
		max-width: 50rem;
	}

	.room-head {
		margin-bottom: 1.25rem;
	}

	.eyebrow {
		margin: 0 0 0.35rem;
		font-size: 0.72rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--vr-muted);
	}

	.room-title {
		margin: 0;
		font-family: var(--vr-font-headline);
		font-size: 1.6rem;
		font-weight: 400;
		line-height: 1.1;
		text-transform: uppercase;
		letter-spacing: 0.01em;
	}

	.room-links {
		margin: 0.5rem 0 0;
		color: var(--vr-muted);
		font-size: 0.78rem;
	}

	.room-links a {
		color: var(--vr-text);
		text-decoration: underline;
	}

	@media (max-width: 640px) {
		.page {
			padding: 0;
		}

		.room-head {
			padding: var(--vr-pad);
		}
	}
</style>
