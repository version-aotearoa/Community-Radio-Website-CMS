<script lang="ts">
	import Seo from '$lib/components/Seo.svelte';
	import ArrowChip from '$lib/components/ArrowChip.svelte';
	import NewsActions from '$lib/components/NewsActions.svelte';
	import { SITE_TITLE } from '$lib/site';

	let { data } = $props();

	const post = $derived(data.post);

	let lightboxOpen = $state(false);

	// Close the artwork lightbox on Esc; lock body scroll while open.
	$effect(() => {
		if (!lightboxOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') lightboxOpen = false;
		};
		window.addEventListener('keydown', onKey);
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			window.removeEventListener('keydown', onKey);
			document.body.style.overflow = prevOverflow;
		};
	});

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
		<div class="post" class:has-art={!!post.image}>
			<header class="post-head">
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
			</header>
			{#if post.image}
				<figure class="post-art">
					<button
						class="art-btn"
						onclick={() => (lightboxOpen = true)}
						aria-label="View full artwork"
						title="View full artwork"
					>
						<img class="art" src={post.image} alt="" />
					</button>
				</figure>
			{/if}
			<div class="post-body">
				{#if post.body}
					<div class="body">{@html post.body}</div>
				{/if}
				{#if data.canEdit}
					<p class="edit mono"><a href={`/studio?tab=news&edit=${post.id}`}>Edit in Studio</a></p>
				{/if}
			</div>
		</div>
	</article>
</div>

{#if lightboxOpen && post.image}
	<div
		class="lightbox"
		role="dialog"
		aria-modal="true"
		aria-label="Full artwork"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget) lightboxOpen = false;
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') lightboxOpen = false;
		}}
	>
		<img src={post.image} alt="" />
		<button class="lightbox-close" aria-label="Close" onclick={() => (lightboxOpen = false)}>
			<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
				<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
			</svg>
		</button>
	</div>
{/if}

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
		border: 1px solid var(--vr-line);
		background: var(--vr-surface);
		padding: 2rem;
	}

	/* Desktop: the card spans the page, two even columns — text left,
	   artwork filling the right column. */
	.post {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		grid-template-areas:
			'head art'
			'body art';
		column-gap: 2rem;
		align-items: start;
	}

	.post:not(.has-art) {
		grid-template-columns: minmax(0, 1fr);
		grid-template-areas:
			'head'
			'body';
	}

	.post-head {
		grid-area: head;
		min-width: 0;
	}

	.post-art {
		grid-area: art;
		margin: 0;
	}

	.post-body {
		grid-area: body;
		min-width: 0;
		/* Full-width card, readable paragraph measure. */
		max-width: 46rem;
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
		height: auto;
		display: block;
	}

	.art-btn {
		display: block;
		width: 100%;
		border: none;
		padding: 0;
		background: none;
		line-height: 0;
		cursor: zoom-in;
	}

	.art-btn:hover .art {
		box-shadow: 0 0 0 2px var(--vr-text);
	}

	.lightbox {
		position: fixed;
		inset: 0;
		z-index: 60;
		background: rgba(0, 0, 0, 0.9);
		display: grid;
		place-items: center;
		padding: 1.5rem;
	}

	.lightbox img {
		max-width: 92vw;
		max-height: 88vh;
		width: auto;
		height: auto;
		object-fit: contain;
		display: block;
		border: 1px solid var(--vr-line);
	}

	.lightbox-close {
		position: absolute;
		top: 1rem;
		right: 1rem;
		width: 40px;
		height: 40px;
		display: grid;
		place-items: center;
		border: 1px solid var(--vr-line);
		background: var(--vr-bg);
		color: var(--vr-text);
		cursor: pointer;
	}

	.lightbox-close:hover {
		background: var(--vr-text);
		color: var(--vr-black);
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

		/* Phones: title/meta left, artwork right, body across the full width. */
		.post {
			grid-template-columns: minmax(0, 1fr) 6.5rem;
			grid-template-areas:
				'head art'
				'body body';
			column-gap: 0.85rem;
			row-gap: 1.25rem;
		}

		.post:not(.has-art) {
			grid-template-columns: minmax(0, 1fr);
			grid-template-areas:
				'head'
				'body';
		}

		.title {
			margin-bottom: 1rem;
		}

		/* Thumbnail keeps its square on phones so the header row stays tidy. */
		.post-art .art {
			aspect-ratio: 1;
			object-fit: cover;
		}

		.actions-row {
			margin-bottom: 0;
		}
	}
</style>
