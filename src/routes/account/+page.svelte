<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { Button, Field, Text } from '@svar-ui/svelte-core';
	import { authClient } from '$lib/client';
	import { episodeArtOrDefault } from '$lib/azuracast';
	import { artOnError } from '$lib/art';
	import { formatTrackTime } from '$lib/trackTime';
	import Seo from '$lib/components/Seo.svelte';

	let { data } = $props();

	// Clicking the avatar right after following/saving can race the write:
	// the page load may have started before the toggle POST committed.
	// Revalidate on mount so the lists always settle to the persisted state.
	// Every mutated page now revalidates on arrival (see onMount across pages),
	// so a single revalidation here is enough — the old second pass could stomp
	// a just-saved name.
	onMount(() => {
		// Deferred past the navigation's microtasks: an immediate invalidateAll
		// aborts the in-flight navigation before SvelteKit resets scroll to top.
		setTimeout(() => void invalidateAll(), 0);
	});

	const user = $derived(data.user);
	let busy = $state(false);
	let activeTab = $state<'profile' | 'following' | 'saved' | 'tracks' | 'favourites'>('profile');

	let savedTracks = $state(untrack(() => [...data.savedTracks]));
	// Server truth wins after a revalidation (onMount invalidateAll / navigation).
	$effect(() => {
		savedTracks = data.savedTracks;
	});

	async function removeCue(t: { show_id: string; broadcast_id: string; mark_seconds: number }) {
		const res = await fetch(
			`/api/shows/${t.show_id}/broadcasts/${t.broadcast_id}/saved-track?t=${t.mark_seconds}`,
			{ method: 'DELETE' }
		).catch(() => null);
		if (!res || !res.ok) return;
		savedTracks = savedTracks.filter(
			(x) => !(x.broadcast_id === t.broadcast_id && x.mark_seconds === t.mark_seconds)
		);
	}

	let editingName = $state(false);
	let nameInput = $state('');
	let nameBusy = $state(false);
	let nameError = $state('');
	let nameSaved = $state(false);

	let editingAvatar = $state(false);
	let avatarInput = $state('');
	let avatarBusy = $state(false);
	let avatarError = $state('');
	let avatarSaved = $state(false);

	async function startNameEdit() {
		editingName = true;
		nameInput = user.name ?? '';
		nameError = '';
		nameSaved = false;
	}

	async function saveName() {
		nameBusy = true;
		nameError = '';
		nameSaved = false;
		const name = nameInput.trim().slice(0, 50);
		const res = await authClient.updateUser({ name });
		nameBusy = false;
		if (res.error) {
			nameError = res.error.message ?? 'Could not save your name.';
			return;
		}
		await invalidateAll();
		editingName = false;
		nameSaved = true;
		setTimeout(() => (nameSaved = false), 4000);
	}

	function startAvatarEdit() {
		editingAvatar = true;
		avatarInput = user.image ?? '';
		avatarError = '';
		avatarSaved = false;
	}

	async function saveAvatar() {
		avatarBusy = true;
		avatarError = '';
		avatarSaved = false;
		const image = avatarInput.trim().slice(0, 500);
		if (image && !/^https?:\/\//i.test(image)) {
			avatarBusy = false;
			avatarError = 'Avatar must be an image URL starting with http:// or https://';
			return;
		}
		const res = await authClient.updateUser({ image: image || null });
		avatarBusy = false;
		if (res.error) {
			avatarError = res.error.message ?? 'Could not save your avatar.';
			return;
		}
		await invalidateAll();
		editingAvatar = false;
		avatarSaved = true;
		setTimeout(() => (avatarSaved = false), 4000);
	}

	async function removeAvatar() {
		avatarBusy = true;
		avatarError = '';
		avatarSaved = false;
		const res = await authClient.updateUser({ image: null });
		avatarBusy = false;
		if (res.error) {
			avatarError = res.error.message ?? 'Could not remove your avatar.';
			return;
		}
		await invalidateAll();
		avatarSaved = true;
		setTimeout(() => (avatarSaved = false), 4000);
	}

	const createdAt = $derived(
		data.createdAt
			? new Intl.DateTimeFormat('en-NZ', { year: 'numeric', month: 'short', day: 'numeric' })
					.format(new Date(data.createdAt * 1000))
			: null
	);

	const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
	const ORDINALS = ['1st', '2nd', '3rd', '4th'];

	function airLabel(s: { day_of_week?: number; showCycleWeeks: number[] }) {
		if (s.day_of_week === undefined || s.showCycleWeeks.length === 0) return '';
		const day = DAY_NAMES[s.day_of_week];
		return `Every ${s.showCycleWeeks.map((w) => ORDINALS[w - 1]).join(' & ')} ${day}`;
	}

	function fmtDate(dateStr: string) {
		return new Intl.DateTimeFormat('en-NZ', { day: '2-digit', month: 'short', year: 'numeric' })
			.format(new Date(`${dateStr}T00:00:00Z`))
			.toUpperCase();
	}

	async function signOut() {
		busy = true;
		await authClient.signOut();
		await invalidateAll();
	}
</script>

<svelte:head>
	<title>My Version — Version Radio</title>
</svelte:head>

<Seo noindex />

<div class="page">
	<header class="head">
		<h1 class="h-lg">My Version</h1>
	</header>

	<div class="tabs" role="tablist">
		<button class="tab" class:active={activeTab === 'profile'} onclick={() => (activeTab = 'profile')}>
			Profile
		</button>
		<button
			class="tab"
			class:active={activeTab === 'following'}
			onclick={() => (activeTab = 'following')}
		>
			Following
		</button>
		<button class="tab" class:active={activeTab === 'saved'} onclick={() => (activeTab = 'saved')}>
			Saved
		</button>
		<button
			class="tab"
			class:active={activeTab === 'tracks'}
			onclick={() => (activeTab = 'tracks')}
		>
			Tracks
		</button>
		<button
			class="tab"
			class:active={activeTab === 'favourites'}
			onclick={() => (activeTab = 'favourites')}
		>
			Favourites
		</button>
	</div>

	{#if activeTab === 'profile'}
		<section class="card">
		<div class="identity">
			<div class="avatar" aria-hidden="true">
				{#if user.image}
					<img class="avatar-img" src={user.image} alt="" />
				{:else}
					<svg viewBox="0 0 24 24" width="18" height="18">
						<circle cx="12" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8" />
						<path
							d="M5.5 19a6.5 6.5 0 0 1 13 0"
							fill="none"
							stroke="currentColor"
							stroke-width="1.8"
							stroke-linecap="round"
						/>
					</svg>
					<span class="mono initials">{user.name?.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || (user.email?.[0] ?? '?')}</span>
				{/if}
			</div>
			<div class="identity-copy">
				<span class="h-sm">{user.name || 'Listener'}</span>
				<span class="mono meta">{user.email}</span>
				<span class="mono meta">
					{user.role ?? 'listener'}{#if createdAt} · since {createdAt}{/if}
				</span>
			</div>
		</div>
		{#if editingName}
			<form class="name-form" onsubmit={(e) => { e.preventDefault(); saveName(); }}>
				<Field label="Display name">
					<Text bind:value={nameInput} placeholder="e.g. LLUSH" css="vr-input" />
				</Field>
				{#if nameError}
					<div class="notice bad">{nameError}</div>
				{/if}
				{#if nameSaved}
					<div class="notice ok">Name saved</div>
				{/if}
				<div class="name-actions">
					<Button css="vr-cta" type="primary" disabled={nameBusy} onclick={saveName}>
						{nameBusy ? 'Saving…' : 'Save'}
					</Button>
					<Button css="vr-cta ghost" onclick={() => (editingName = false)}>Cancel</Button>
				</div>
			</form>
		{:else}
			{#if nameSaved}
				<div class="notice ok">Name saved</div>
			{/if}
			<div class="name-actions">
				<button class="btn-outline" onclick={startNameEdit}>
					{user.name ? 'Edit name' : 'Set name'}
				</button>
			</div>
		{/if}
		{#if editingAvatar}
			<form class="name-form" onsubmit={(e) => { e.preventDefault(); saveAvatar(); }}>
				<Field label="Avatar image URL">
					<Text bind:value={avatarInput} placeholder="https://…" css="vr-input" />
				</Field>
				{#if avatarError}
					<div class="notice bad">{avatarError}</div>
				{/if}
				{#if avatarSaved}
					<div class="notice ok">Avatar saved</div>
				{/if}
				<div class="name-actions">
					<Button css="vr-cta" type="primary" disabled={avatarBusy} onclick={saveAvatar}>
						{avatarBusy ? 'Saving…' : 'Save'}
					</Button>
					<Button css="vr-cta ghost" onclick={() => (editingAvatar = false)}>Cancel</Button>
				</div>
			</form>
		{:else}
			{#if avatarSaved}
				<div class="notice ok">Avatar saved</div>
			{/if}
			<div class="name-actions">
				<button class="btn-outline" onclick={startAvatarEdit}>
					{user.image ? 'Edit avatar' : 'Set avatar'}
				</button>
				{#if user.image}
					<button class="btn-outline" onclick={removeAvatar} disabled={avatarBusy}>Remove</button>
				{/if}
			</div>
		{/if}
		<button class="btn-outline signout" onclick={signOut} disabled={busy}>
			{busy ? 'Signing out…' : 'Sign out'}
		</button>
	</section>
	{/if}

	{#if activeTab === 'following'}
		<section class="card">
			<h2 class="card-title">Following</h2>
			{#if data.following.length === 0}
				<p class="muted">You're not following any shows yet.</p>
			{:else}
				<ul>
					{#each data.following as s (s.id)}
						<li>
							<a class="saved-row" href={`/shows/${s.id}`}>
								<span class="saved-art">
									{#if s.image}
										<img src={s.image} alt="" loading="lazy" />
									{:else}
										<svg viewBox="0 0 80 70" fill="currentColor" width="20" height="17" aria-hidden="true">
											<path
												fill-rule="evenodd"
												d="M0 0H40V40H50V0H80V45H70V60H55V70H25V60H10V45H0V5ZM10 5H5V40H15V55H30V65H50V55H65V40H75V5H55V45H35V5H15Z"
											/>
										</svg>
									{/if}
								</span>
								<span class="saved-info">
									<span class="h-sm">{s.title}</span>
									{#if airLabel(s)}
										<span class="mono meta">{airLabel(s)}</span>
									{/if}
								</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}

	{#if activeTab === 'saved'}
		<section class="card">
			<h2 class="card-title">Saved broadcasts</h2>
			{#if data.saved.length === 0}
				<p class="muted">No saved broadcasts yet.</p>
			{:else}
				<ul>
					{#each data.saved as s (s.broadcast_id)}
						{@const sArt = episodeArtOrDefault(s.broadcast_id, s, { image: s.image })}
						<li>
							<a class="saved-row" href={`/shows/${s.show_id}/${s.broadcast_id}`}>
								<span class="saved-art">
									{#if sArt}
										<img
											src={sArt}
											alt=""
											loading="lazy"
											onerror={(e) => artOnError(e, s.image)}
										/>
									{:else}
										<svg viewBox="0 0 80 70" fill="currentColor" width="20" height="17" aria-hidden="true">
											<path
												fill-rule="evenodd"
												d="M0 0H40V40H50V0H80V45H70V60H55V70H25V60H10V45H0V5ZM10 5H5V40H15V55H30V65H50V55H65V40H75V5H55V45H35V5H15Z"
											/>
										</svg>
									{/if}
								</span>
								<span class="saved-info">
									<span class="h-sm">{s.title}</span>
									<span class="mono meta">{fmtDate(s.date)}</span>
								</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}

	{#if activeTab === 'tracks'}
		<section class="card">
			<h2 class="card-title">Tracks</h2>
			{#if savedTracks.length === 0}
				<p class="muted">
					No saved tracks yet. Tap the heart beside a track's time on any episode to keep the
					moment here.
				</p>
			{:else}
				<ul>
					{#each savedTracks as t (`${t.broadcast_id}:${t.mark_seconds}`)}
						{@const sArt = episodeArtOrDefault(t.broadcast_id, t, { image: t.image })}
						<li class="track-item">
							<a
								class="saved-row"
								href={`/shows/${t.show_id}/${t.broadcast_id}?t=${t.mark_seconds}`}
							>
								<span class="saved-art">
									{#if sArt}
										<img
											src={sArt}
											alt=""
											loading="lazy"
											onerror={(e) => artOnError(e, t.image)}
										/>
									{:else}
										<svg viewBox="0 0 80 70" fill="currentColor" width="20" height="17" aria-hidden="true">
											<path
												fill-rule="evenodd"
												d="M0 0H40V40H50V0H80V45H70V60H55V70H25V60H10V45H0V5ZM10 5H5V40H15V55H30V65H50V55H65V40H75V5H55V45H35V5H15Z"
											/>
										</svg>
									{/if}
								</span>
								<span class="saved-info">
									<span class="h-sm">{t.title || t.artist || 'Track'}</span>
									<span class="mono meta">
										{formatTrackTime(t.mark_seconds)}{#if t.artist} · {t.artist}{/if}{#if t.album} · {t.album}{/if}
									</span>
									<span class="mono meta">{t.show_title} · {fmtDate(t.date)}</span>
								</span>
							</a>
							<button
								class="cue-remove"
								onclick={() => removeCue(t)}
								aria-label={`Remove ${t.title || 'track'} at ${formatTrackTime(t.mark_seconds)} from My Version`}
								title="Remove from My Version"
							>
								×
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}

	{#if activeTab === 'favourites'}
		<section class="card">
			<h2 class="card-title">Favourite recordings</h2>
			{#if data.favourites.length === 0}
				<p class="muted">No favourites yet.</p>
			{:else}
				<ul>
					{#each data.favourites as s (s.broadcast_id)}
						{@const sArt = episodeArtOrDefault(s.broadcast_id, s, { image: s.image })}
						<li>
							<a class="saved-row" href={`/shows/${s.show_id}/${s.broadcast_id}`}>
								<span class="saved-art">
									{#if sArt}
										<img
											src={sArt}
											alt=""
											loading="lazy"
											onerror={(e) => artOnError(e, s.image)}
										/>
									{:else}
										<svg viewBox="0 0 80 70" fill="currentColor" width="20" height="17" aria-hidden="true">
											<path
												fill-rule="evenodd"
												d="M0 0H40V40H50V0H80V45H70V60H55V70H25V60H10V45H0V5ZM10 5H5V40H15V55H30V65H50V55H65V40H75V5H55V45H35V5H15Z"
											/>
										</svg>
									{/if}
								</span>
								<span class="saved-info">
									<span class="h-sm">{s.title}</span>
									<span class="mono meta">{fmtDate(s.date)}</span>
								</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</div>

<style>
	.page {
		padding: var(--vr-pad);
		max-width: 40rem;
	}

	.head {
		margin: 0 0 1.5rem;
		border-bottom: 1px solid var(--vr-line);
		padding-bottom: 1rem;
	}

	.head h1 {
		margin: 0;
	}

	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		border-bottom: 1px solid var(--vr-line);
		padding-bottom: 0.75rem;
		margin-bottom: 1.5rem;
	}

	.tab {
		background: none;
		border: 1px solid var(--vr-line);
		color: var(--vr-muted);
		font-family: var(--vr-font-mono);
		font-size: 0.72rem;
		font-weight: 500;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		padding: 0.4rem 0.9rem;
		cursor: pointer;
	}

	.tab:hover {
		color: var(--vr-text);
		border-color: var(--vr-text);
	}

	.tab.active {
		background: var(--vr-text);
		color: var(--vr-black);
		border-color: var(--vr-text);
	}

	.muted {
		color: var(--vr-muted);
		font-size: 0.9rem;
	}

	.card {
		border: 1px solid var(--vr-line);
		background: var(--vr-surface);
		padding: 1.25rem 1.5rem;
		margin-bottom: 1.5rem;
	}

	.card-title {
		font-family: var(--vr-font-mono);
		font-size: 0.82rem;
		font-weight: 500;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		margin: 0 0 1rem;
		border-bottom: 1px solid var(--vr-line);
		padding-bottom: 0.6rem;
	}

	.identity {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-bottom: 1.25rem;
	}

	.avatar {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		border: 1px solid var(--vr-line);
		color: var(--vr-text);
		padding: 0.55rem 0.7rem;
	}

	.initials {
		font-size: 0.78rem;
	}

	.avatar-img {
		width: 18px;
		height: 18px;
		object-fit: cover;
		display: block;
	}

	.identity-copy {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
	}

	.meta {
		color: var(--vr-muted);
		font-size: 0.75rem;
	}

	.signout {
		width: 100%;
		justify-content: center;
	}

	.name-form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-bottom: 1.25rem;
		max-width: 24rem;
	}

	.name-actions {
		display: flex;
		gap: 0.6rem;
		margin-bottom: 1.25rem;
	}

	.notice {
		padding: 0.5rem 0.8rem;
		border: 1px solid var(--vr-line);
		font-size: 0.85rem;
	}

	.notice.ok {
		color: var(--vr-green);
	}

	.notice.bad {
		color: var(--vr-red);
	}

	.card ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.saved-row {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.7rem 0;
		border-top: 1px solid var(--vr-line-muted);
		text-decoration: none;
		color: var(--vr-text);
		transition: color 150ms, background-color 150ms;
	}

	.saved-row:hover {
		background: #fff;
		color: #000;
	}

	.card ul li:first-child .saved-row {
		border-top: none;
	}

	.track-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.track-item .saved-row {
		flex: 1;
		min-width: 0;
	}

	.cue-remove {
		flex-shrink: 0;
		width: 28px;
		height: 28px;
		display: grid;
		place-items: center;
		border: 1px solid var(--vr-line-muted);
		background: transparent;
		color: var(--vr-muted);
		font-size: 1rem;
		line-height: 1;
		padding: 0;
		cursor: pointer;
	}

	.cue-remove:hover {
		border-color: var(--vr-line);
		color: var(--vr-text);
	}

	.saved-art {
		width: 48px;
		height: 48px;
		flex-shrink: 0;
		display: grid;
		place-items: center;
		background: #000;
		color: var(--vr-text);
	}

	.saved-art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.saved-info {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
	}

	.saved-row:hover .meta {
		color: rgba(0, 0, 0, 0.75);
	}

	.saved-info .h-sm {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
