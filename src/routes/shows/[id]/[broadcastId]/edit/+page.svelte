<script lang="ts">
	import TracklistEditor from '$lib/components/TracklistEditor.svelte';

	let { data } = $props();

	const show = $derived(data.show);
	const broadcast = $derived(data.broadcast);
	const tracks = $derived(data.tracks);
</script>

<svelte:head>
	<title>{show.title} — {broadcast.date} tracklist — Version Radio</title>
</svelte:head>

<TracklistEditor
	{show}
	{broadcast}
	{tracks}
	replayDuration={data.replayDuration}
	breadcrumbHref={`/shows/${show.id}`}
/>
