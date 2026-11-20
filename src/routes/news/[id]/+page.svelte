<script lang="ts">
	import Seo from '$lib/components/Seo.svelte';
	import ArrowChip from '$lib/components/ArrowChip.svelte';
	import NewsActions from '$lib/components/NewsActions.svelte';
	import { SITE_TITLE } from '$lib/site';

	let { data } = $props();

	const post = $derived(data.post);

	function fmtDate(secs: number) {
		return new Intl.DateTimeFormat('en-NZ', {
			day: 'numeric',
			month: 'long',
			year: 'numeric'
		}).format(new Date(secs * 1000));
	}
</script>

<svelte:head>
	<title>{post.title} — {SITE_TITLE}</title>
</svelte:head>

<Seo title={`${post.title} — ${SITE_TITLE}`} description={data.excerpt} image={post.image} />

<div class="page">
	<a class="back mono" href="/news"><ArrowChip dir="left" /> News</a>

	<article class="article">
		<p class="mono meta">
			{fmtDate(post.created_at)}
			{#if !post.published}
				<span class="draft">Draft</span>
			{/if}
		</p>
		<h1 class="h-lg title">{post.title}</h1>
		<div class="actions-row">
			<NewsActions
				postId={post.id}
				title={post.title}
				count={data.heartCount}
				active={data.myHeart}
			/>
		</div>
		{#if post.image}
			<img class="art" src={post.image} alt="" />
		{/if}
		{#if post.body}
			<div class="body">{@html post.body}</div>
		{/if}
		{#if data.canEdit}
			<p class="edit mono"><a href={`/studio?tab=news&edit=${post.id}`}>Edit in Studio</a></p>
		{/if}
	</article>
</div>

<style>
	.page {
		padding: var(--vr-pad);
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 0.4em;
		cursor: pointer;
		color: var(--vr-muted);
		text-decoration: none;
		margin-bottom: 1.5rem;
	}

	.back:hover {
		color: var(--vr-text);
	}

	.article {
		max-width: 46rem;
		border: 1px solid var(--vr-line);
		background: var(--vr-surface);
		padding: 2rem;
	}

	.meta {
		margin: 0 0 0.75rem;
		color: var(--vr-muted);
		font-variant-numeric: tabular-nums;
	}

	.draft {
		color: var(--vr-red);
		margin-left: 0.75rem;
	}

	.title {
		margin: 0 0 1.25rem;
	}

	.actions-row {
		margin: 0 0 1.5rem;
	}

	.art {
		width: 100%;
		max-height: 24rem;
		object-fit: cover;
		display: block;
		margin: 0 0 1.5rem;
	}

	.body {
		font-size: 1.02rem;
		line-height: 1.6;
	}

	.body :global(p) {
		margin: 0 0 1rem;
	}

	.body :global(p:last-child) {
		margin-bottom: 0;
	}

	.body :global(h1),
	.body :global(h2),
	.body :global(h3),
	.body :global(h4) {
		font-family: var(--vr-font-headline);
		text-transform: uppercase;
		margin: 1.5rem 0 0.6rem;
	}

	.body :global(h1) {
		font-size: 1.4rem;
	}

	.body :global(h2) {
		font-size: 1.25rem;
	}

	.body :global(h3),
	.body :global(h4) {
		font-size: 1.1rem;
	}

	.body :global(a) {
		color: var(--vr-green);
	}

	.body :global(blockquote) {
		border-left: 2px solid var(--vr-green);
		margin: 1rem 0;
		padding-left: 1rem;
		color: var(--vr-muted);
	}

	.body :global(ul),
	.body :global(ol) {
		margin: 0 0 1rem;
		padding-left: 1.5rem;
	}

	.body :global(li) {
		margin: 0.3rem 0;
	}

	.body :global(code) {
		font-family: var(--vr-font-mono);
		font-size: 0.9em;
	}

	.body :global(pre) {
		background: var(--vr-surface-low);
		border: 1px solid var(--vr-line);
		padding: 1rem;
		overflow-x: auto;
	}

	.edit {
		margin: 2rem 0 0;
		color: var(--vr-muted);
	}

	.edit a {
		color: var(--vr-muted);
	}

	@media (max-width: 640px) {
		.page {
			padding: 1rem;
		}

		.article {
			padding: 1.25rem;
		}
	}
</style>
