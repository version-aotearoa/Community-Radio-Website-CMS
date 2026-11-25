<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { Grid, WillowDark } from '@svar-ui/svelte-grid';
	import { Button } from '@svar-ui/svelte-core';
	import { get } from 'svelte/store';
	import RichTextEditor from '$lib/components/RichTextEditor.svelte';
	import EpisodeWaveform from '$lib/components/EpisodeWaveform.svelte';
	import { parseTracksCsv, toTracksCsv, tracklistCsvFilename } from '$lib/csv';
	import { formatTrackTime, parseTrackTime } from '$lib/trackTime';
	import {
		clearPlayQueue,
		playback,
		playMedia,
		playerPosition,
		requestSeek,
		requestSetPlaying,
		streamPlaying
	} from '$lib/stores/player';
	import { probeReplayAvailability, unavailableReplays } from '$lib/replayAvailability';
	import { episodeArtOrDefault } from '$lib/azuracast';
	import { artOnError } from '$lib/art';
	import type { ShowRow, BroadcastRow, TrackRow } from '$lib/server/shows';

	let {
		show,
		broadcast,
		tracks: initialTracks,
		replayDuration = null,
		breadcrumbHref = '/studio'
	}: {
		show: ShowRow;
		broadcast: BroadcastRow;
		tracks: TrackRow[];
		/** Container-parsed replay length, so the waveform seeks before playback. */
		replayDuration?: number | null;
		breadcrumbHref?: string;
	} = $props();

	let gridApi = $state<any>(null);
	let saveVersion = $state(0);
	let saving = $state(false);
	let error = $state('');
	let notice = $state('');
	let tracks = $state<TrackRow[]>([]);
	/** Where "Back to episode" goes — the listener view of this broadcast. */
	const episodeHref = $derived(`/shows/${show.id}/${broadcast.id}`);
	// Live mirror of the grid contents. The grid's internal store is controlled
	// by the `data` prop (resets on reinit), so the mirror is the save source.
	// NOTE: positions in the mirror/grid are 1-based (display numbers); the DB
	// stores 0-based (converted at the boundaries below).
	let editable = $state<TrackRow[]>([]);
	let prevBroadcastId = $state('');

	function toDisplayPos(rows: TrackRow[]): TrackRow[] {
		return rows.map((t) => ({ ...t, position: t.position + 1 }));
	}

	// Re-seed the tracklist when the broadcast changes (navigation between
	// episodes). In-progress grid edits on the current broadcast are never
	// stomped by unrelated re-renders.
	$effect(() => {
		if (broadcast.id === prevBroadcastId) return;
		prevBroadcastId = broadcast.id;
		tracks = initialTracks;
		editable = toDisplayPos(initialTracks);
	});

	let replayInput = $state('');
	let replaySaving = $state(false);
	let replayError = $state('');
	let replayNotice = $state('');
	let descInput = $state('');
	let descSaving = $state(false);
	let descError = $state('');
	let descNotice = $state('');
	let slugInput = $state('');
	let slugSaving = $state(false);
	let slugError = $state('');
	let titleInput = $state('');
	let titleSaving = $state(false);
	let titleError = $state('');
	let titleNotice = $state('');
	let artInput = $state('');
	let artSaving = $state(false);
	let artError = $state('');
	let fileInput: HTMLInputElement | undefined = $state();
	let activeTab = $state<'tracklist' | 'replay' | 'description' | 'episode'>('tracklist');

	// ---- Serato import / Bandcamp matching ----
	let seratoBusy = $state(false);
	let seratoError = $state('');
	let seratoNotice = $state('');
	let seratoUrl = $state('');
	let seratoSaving = $state(false);
	let bandcampBusy = $state(false);
	let bandcampNotice = $state('');

	// ---- Track Detect (admin trial) ----
	const isAdmin = $derived(page.data.user?.role === 'admin');
	let detectBusy = $state(false);
	let detectError = $state('');
	let detectNotice = $state('');
	let detectStatus = $state<string | null>(null);
	let detectProgress = $state<number | null>(null);
	let detectTimer: ReturnType<typeof setTimeout> | null = null;

	// Follow the episode's saved Serato playlist URL when fresh data arrives.
	$effect(() => {
		seratoUrl = broadcast.serato_url ?? '';
	});

	// Sync the replay/description/slug form fields whenever the broadcast prop
	// changes (fresh server data after a save or navigation).
	$effect(() => {
		replayInput = broadcast.replay_url ?? '';
		descInput = broadcast.description ?? '';
		slugInput = broadcast.id;
		titleInput = broadcast.title ?? '';
		artInput = broadcast.art ?? '';
	});

	const artFb = $derived(show.image ?? null);
	const artPreview = $derived(episodeArtOrDefault(broadcast.id, broadcast, { image: show.image }));

	/* ---- Replay preview: play/pause, ±5s / ±1 min and scrub without leaving the editor ---- */

	/** The saved recording link; updated locally when the Replay tab saves one. */
	let replayUrl = $state('');
	$effect(() => {
		replayUrl = broadcast.replay_url ?? '';
	});
	$effect(() => {
		probeReplayAvailability([broadcast.replay_url]);
	});

	const replayMine = $derived($playback.kind === 'media' && $playback.url === replayUrl);
	const replayPlaying = $derived(replayMine && $streamPlaying);
	const replayPos = $derived(
		replayMine && $playerPosition.url === replayUrl ? $playerPosition : null
	);
	const replayUnavailable = $derived(!!replayUrl && $unavailableReplays.has(replayUrl));

	/** The replay as a player source, optionally starting at an offset. */
	function replaySource(startAt: number | null = null) {
		return {
			url: replayUrl,
			title: show.title,
			artist: show.dj_handle || null,
			art: artPreview,
			show: { id: show.id, title: show.title },
			href: `/shows/${show.id}/${broadcast.id}`,
			broadcastId: broadcast.id,
			date: broadcast.date,
			startAt
		};
	}

	function toggleReplayPreview() {
		if (!replayUrl || replayUnavailable) return;
		if (replayMine) {
			requestSetPlaying(!replayPlaying);
			return;
		}
		// Same path as the public episode page: one shared <audio> element.
		clearPlayQueue();
		playMedia(replaySource());
	}

	/** Skip ±`delta` seconds; clamping happens in the player store. */
	function nudgeReplay(delta: number) {
		if (!replayMine) return;
		requestSeek(Math.max(0, (replayPos?.seconds ?? 0) + delta));
	}

	/** Seek the waveform; start the replay there if it isn't loaded yet. */
	function seekFromWaveform(seconds: number) {
		if (!replayUrl || replayUnavailable) return;
		const target = Math.max(0, Math.floor(seconds));
		if (replayMine) {
			requestSeek(target);
			return;
		}
		clearPlayQueue();
		playMedia(replaySource(target));
	}

	const GRID_EVENTS = [
		'update-cell',
		'update-row',
		'add-row',
		'delete-row',
		'move-item',
		'copy-row',
		'undo',
		'redo'
	] as const;

	let gridData = $derived(
		editable.map((t) => ({
			id: t.id,
			position: t.position,
			mark: formatTrackTime(t.mark_seconds),
			title: t.title,
			artist: t.artist,
			album: t.album,
			url: t.url ?? ''
		}))
	);

	/** Rows whose typed time couldn't be read (id → raw text); blocks saving. */
	let invalidMarks = $state<Record<string, string>>({});

	/** First row whose time is earlier than the row above it (warning only). */
	const backwardsAt = $derived.by(() => {
		let prev: number | null = null;
		for (const t of editable) {
			if (t.mark_seconds === null) continue;
			if (prev !== null && t.mark_seconds < prev) return t.position;
			prev = t.mark_seconds;
		}
		return null;
	});

	function resyncFromGrid() {
		const rows = gridApi?.getState().data ?? [];
		const invalid: Record<string, string> = {};
		editable = rows.map((r: any) => {
			const rawMark = String(r.mark ?? '');
			const parsed = parseTrackTime(rawMark);
			if (!parsed.ok) invalid[String(r.id)] = rawMark.trim();
			return {
				id: r.id,
				position: Number(r.position ?? 0),
				mark_seconds: parsed.ok ? parsed.seconds : null,
				title: String(r.title ?? ''),
				artist: String(r.artist ?? ''),
				album: String(r.album ?? ''),
				url: String(r.url ?? '')
			};
		});
		invalidMarks = invalid;
	}

	/** True when the mirror differs from the last saved rows. */
	const dirty = $derived.by(() => {
		if (editable.length !== tracks.length) return true;
		for (let i = 0; i < editable.length; i++) {
			const saved = tracks[i];
			const current = editable[i];
			if (
				saved.title !== current.title ||
				saved.artist !== current.artist ||
				saved.album !== current.album ||
				(saved.url ?? '') !== (current.url ?? '') ||
				(saved.mark_seconds ?? null) !== (current.mark_seconds ?? null)
			) {
				return true;
			}
		}
		return false;
	});

	function handleExit(e: MouseEvent) {
		if (!dirty) return;
		if (!confirm('You have unsaved tracklist changes. Leave anyway?')) e.preventDefault();
	}

	$effect(() => {
		if (!dirty) return;
		const handler = (e: BeforeUnloadEvent) => {
			e.preventDefault();
			e.returnValue = '';
		};
		window.addEventListener('beforeunload', handler);
		return () => window.removeEventListener('beforeunload', handler);
	});

	const columns = [
		{ id: 'position', header: '#', width: 54 },
		{ id: 'mark', header: 'Time', width: 90, editor: 'text' },
		{ id: 'title', header: 'Title', width: 260, editor: 'text' },
		{ id: 'artist', header: 'Artist', width: 220, editor: 'text' },
		{ id: 'album', header: 'Album/Label', width: 220, editor: 'text' },
		{ id: 'url', header: 'Link', width: 240, editor: 'text' }
	];

	function handleInit(api: any) {
		gridApi = api;
		for (const ev of GRID_EVENTS) {
			api.on(ev, () => {
				resyncFromGrid();
				if (ev === 'move-item') setTimeout(renumber, 0);
			});
		}
	}

	function renumber() {
		const rows = gridApi?.getState().data ?? [];
		rows.forEach((row: any, i: number) => {
			if (row.position !== i + 1) {
				gridApi.exec('update-row', { id: row.id, row: { position: i + 1 } });
			}
		});
	}

	/** Extract a readable error from a failed save response (JSON body, text, or status). */
	async function readErrorMessage(res: Response): Promise<string> {
		const text = await res.text().catch(() => '');
		try {
			const body = JSON.parse(text) as { error?: unknown };
			if (typeof body.error === 'string' && body.error.trim() !== '') return body.error;
		} catch {
			// not JSON
		}
		if (text.trim() !== '' && !text.trimStart().startsWith('<')) return text.trim().slice(0, 200);
		return `Request failed (${res.status})`;
	}

	function fmtTime(mins: number) {
		const h = Math.floor(mins / 60);
		const m = mins % 60;
		return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
	}

	/**
	 * Add a track below the selected row (the last one when several are
	 * selected, or the focused cell's row), so mid-list fixes don't need a
	 * drag. With nothing selected it appends to the end.
	 */
	async function insertTrack() {
		const state = gridApi?.getState();
		const rows = state?.data ?? [];
		const selected: string[] = state?.selectedRows ?? [];
		const anchorId = selected.at(-1) ?? state?.focusCell?.row ?? rows.at(-1)?.id;
		await gridApi.exec('add-row', {
			row: {
				id: crypto.randomUUID(),
				position: rows.length + 1,
				mark: '',
				title: '',
				artist: '',
				album: '',
				url: ''
			},
			after: anchorId,
			select: true
		});
		renumber();
	}

	async function deleteSelected() {
		const selected = gridApi?.getState().selectedRows ?? [];
		for (const id of selected) {
			await gridApi.exec('delete-row', { id });
		}
		renumber();
	}

	function onGridKeydown(e: KeyboardEvent) {
		// The library's text editor treats Enter as cancel — intercept it in the
		// capture phase and commit the pending cell value instead.
		if (e.key !== 'Enter') return;
		if (!gridApi?.getState().editor) return;
		e.preventDefault();
		e.stopPropagation();
		gridApi.exec('close-editor', {}).catch(() => {});
	}

	/** Normalised key for duplicate detection during a Serato import. */
	function rowKey(mark: string, title: string, artist: string): string {
		const norm = (s: string) =>
			s
				.toLowerCase()
				.normalize('NFD')
				.replace(/[\u0300-\u036f]/g, '')
				.replace(/[^a-z0-9]+/g, ' ')
				.trim();
		return `${mark.trim()}|${norm(title)}|${norm(artist)}`;
	}

	/**
	 * Append imported rows to the grid, skipping ones already present (matched on
	 * time + title + artist). Used by the Serato and Track Detect imports so both
	 * behave the same and neither disturbs existing rows.
	 */
	async function appendImportedRows(
		rows: Array<{ markSeconds: number | null; artist: string; title: string; url?: string | null }>
	): Promise<{ added: number; skipped: number }> {
		const existing = new Set(
			(gridApi?.getState().data ?? []).map((r: any) =>
				rowKey(String(r.mark ?? ''), String(r.title ?? ''), String(r.artist ?? ''))
			)
		);

		let position = (gridApi?.getState().data ?? []).length;
		let added = 0;

		for (const row of rows) {
			const mark = formatTrackTime(row.markSeconds ?? null);
			const key = rowKey(mark, row.title, row.artist);
			if (existing.has(key)) continue;
			existing.add(key);

			await gridApi.exec('add-row', {
				row: {
					id: crypto.randomUUID(),
					position: ++position,
					mark,
					title: row.title,
					artist: row.artist,
					album: '',
					url: row.url ?? ''
				},
				after: null
			});
			added += 1;
		}

		renumber();
		return { added, skipped: rows.length - added };
	}

	/** Import the DJ's published Serato playlist for this episode. */
	async function importSerato() {
		seratoError = '';
		seratoNotice = '';
		seratoBusy = true;

		try {
			const typed = seratoUrl.trim();
			if (!typed && !broadcast.serato_url) {
				seratoError = 'Paste the Serato playlist URL for this set first.';
				return;
			}

			const query = typed ? `?url=${encodeURIComponent(typed)}` : '';
			const res = await fetch(
				`/api/shows/${show.id}/broadcasts/${broadcast.id}/serato${query}`
			);
			const body = (await res.json().catch(() => ({}))) as {
				status?: string;
				url?: string;
				tracks?: Array<{
					markSeconds: number | null;
					artist: string;
					title: string;
				}>;
				detail?: string;
				error?: string;
			};

			if (!res.ok) {
				seratoError = body.error ?? 'Serato import failed.';
				return;
			}

			if (body.status === 'no-url') {
				seratoError = 'Paste the Serato playlist URL for this set first.';
				return;
			}

			if (body.status === 'not-published') {
				seratoError = 'Serato has no playlist at that URL (yet).';
				return;
			}

			if (body.status === 'no-tracks') {
				seratoError = 'Serato returned the page but no tracks could be read.';
				return;
			}

			if (body.status === 'upstream') {
				seratoError = `Serato could not be read: ${body.detail ?? 'unknown error'}`;
				return;
			}

			const parsed = body.tracks ?? [];
			if (parsed.length === 0) {
				seratoError = 'The playlist is empty.';
				return;
			}

			// Remember the URL on the episode so a later import needs no retyping.
			if (body.url && body.url !== broadcast.serato_url) {
				void saveSeratoUrl(body.url, { silent: true });
			}

			const { added, skipped } = await appendImportedRows(
				parsed.map((t) => ({ markSeconds: t.markSeconds, artist: t.artist, title: t.title }))
			);
			seratoNotice = `${added} track${added === 1 ? '' : 's'} added${
				skipped > 0 ? `, ${skipped} already present` : ''
			}.`;
		} catch {
			seratoError = 'Serato import failed.';
		} finally {
			seratoBusy = false;
		}
	}

	/** Save (or clear) this episode's Serato playlist URL. */
	async function saveSeratoUrl(explicitUrl?: string, opts?: { silent?: boolean }) {
		seratoError = '';
		if (!opts?.silent) seratoNotice = '';
		seratoSaving = true;

		const value = (explicitUrl ?? seratoUrl).trim();
		try {
			const res = await fetch(`/api/shows/${show.id}/broadcasts/${broadcast.id}/serato`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url: value })
			});
			const body = (await res.json().catch(() => ({}))) as { url?: string | null; error?: string };

			if (!res.ok) {
				if (!opts?.silent) seratoError = body.error ?? 'Could not save the URL.';
				return;
			}

			seratoUrl = body.url ?? '';
			if (!opts?.silent) {
				seratoNotice = seratoUrl ? 'Serato playlist URL saved.' : 'Serato playlist URL cleared.';
			}
		} finally {
			seratoSaving = false;
		}
	}

	/**
	 * Fill Bandcamp links for rows that don't have one.
	 *
	 * Sequential and capped: this hits Bandcamp's undocumented public search API
	 * once per row, so it stays polite and bounded.
	 */
	async function findBandcampLinks() {
		bandcampBusy = true;
		bandcampNotice = '';
		const rows: any[] = gridApi?.getState().data ?? [];
		const pending = rows.filter((r) => !String(r.url ?? '').trim()).slice(0, 40);

		let filled = 0;
		for (const row of pending) {
			try {
				const res = await fetch('/api/bandcamp/match', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ artist: row.artist ?? '', title: row.title ?? '' })
				});
				if (!res.ok) continue;
				const body = (await res.json()) as {
					matches?: Array<{ url: string; score: number; title: string; artist: string }>;
				};
				const best = body.matches?.[0];
				if (!best || best.score < 0.75) continue;
				await gridApi?.exec('update-row', { id: row.id, row: { url: best.url } });
				filled += 1;
			} catch {
				// keep going: one failed lookup must not abort the pass
			}
			await new Promise((resolve) => setTimeout(resolve, 150));
		}

		bandcampNotice = filled
			? `${filled} Bandcamp link${filled === 1 ? '' : 's'} matched (best-guess — check before saving).`
			: 'No confident Bandcamp matches found.';
		bandcampBusy = false;
	}

	/**
	 * Track Detect: start (or reuse) a detection for this episode and import the
	 * results. Admin-only while trialling. POST never spends a second credit for a
	 * job that is already queued/running/done; `restart` is an explicit re-run.
	 */
	async function detectTracks(restart = false) {
		detectError = '';
		detectNotice = '';
		detectBusy = true;

		try {
			const res = await fetch(
				`/api/shows/${show.id}/broadcasts/${broadcast.id}/detect${restart ? '?restart=1' : ''}`,
				{ method: 'POST' }
			);
			const body = (await res.json().catch(() => ({}))) as {
				error?: string;
				status?: string;
				jobId?: string;
				reused?: boolean;
				credits?: number | null;
			};
			if (!res.ok) {
				detectError = body.error ?? 'Could not start the detection.';
				return;
			}

			detectStatus = body.status ?? 'queued';
			detectNotice =
				body.reused && body.status === 'done'
					? 'Reading the finished detection (no credit spent).'
					: `Detection ${body.status ?? 'queued'} — this can take several minutes.`;

			await pollDetection();
		} catch {
			detectError = 'Could not reach Track Detect.';
		} finally {
			detectBusy = false;
		}
	}

	async function pollDetection() {
		for (let attempt = 0; attempt < 60; attempt += 1) {
			const res = await fetch(`/api/shows/${show.id}/broadcasts/${broadcast.id}/detect`);
			const body = (await res.json().catch(() => ({}))) as {
				error?: string;
				code?: string;
				status?: string;
				progress?: number | null;
				tracks?: Array<{
					timestamp: number;
					artist: string;
					title: string;
					links?: { bandcamp?: string | null };
				}>;
			};

			if (!res.ok) {
				detectError = body.error ?? 'Detection failed.';
				return;
			}

			detectStatus = body.status ?? detectStatus;
			detectProgress = typeof body.progress === 'number' ? body.progress : null;

			if (detectStatus === 'failed') {
				detectError = body.error ?? 'Detection failed (the credit was refunded).';
				return;
			}

			if (detectStatus === 'done') {
				const tracks = body.tracks ?? [];
				if (tracks.length === 0) {
					detectNotice = 'Detection finished but nothing was recognised.';
					return;
				}
				const { added, skipped } = await appendImportedRows(
					tracks.map((t) => ({
						markSeconds: t.timestamp,
						artist: t.artist,
						title: t.title,
						url: t.links?.bandcamp ?? ''
					}))
				);
				detectNotice = `${added} track${added === 1 ? '' : 's'} added${
					skipped > 0 ? `, ${skipped} already present` : ''
				}.`;
				return;
			}

			detectNotice = `Detecting… ${detectProgress ?? 0}%`;
			await new Promise((resolve) => setTimeout(resolve, 10_000));
		}

		detectError = 'Still running — reopen this episode later to fetch the finished detection.';
	}

	async function onCsvPicked(el: HTMLInputElement) {
		error = '';
		const file = el.files?.[0];
		if (!file) return;
		try {
			const text = await file.text();
			const { tracks: parsed, header, skippedMarks } = parseTracksCsv(text);
			// Import always replaces the current grid contents — clearing is a
			// no-op when the grid is empty, so this also serves a fresh import.
			const rows = gridApi?.getState().data ?? [];
			for (const r of rows) {
				await gridApi.exec('delete-row', { id: r.id });
			}
			let position = 0;
			for (const t of parsed) {
				await gridApi.exec('add-row', {
					row: {
						id: crypto.randomUUID(),
						position: ++position,
						mark: formatTrackTime(t.markSeconds ?? null),
						title: t.title,
						artist: t.artist,
						album: t.album,
						url: t.url ?? ''
					},
					after: null
				});
			}
			renumber();
			const withLinks = parsed.filter((t) => t.url).length;
			const withTimes = parsed.filter((t) => t.markSeconds !== undefined).length;
			const linkNote = withLinks ? ` — ${withLinks} with link${withLinks === 1 ? '' : 's'}` : '';
			const timeNote = withTimes ? ` — ${withTimes} with time${withTimes === 1 ? '' : 's'}` : '';
			const skippedNote = skippedMarks
				? ` ${skippedMarks} time${skippedMarks === 1 ? '' : 's'} couldn't be read and ${
						skippedMarks === 1 ? 'was' : 'were'
					} left blank.`
				: '';
			notice = header
				? `Imported ${parsed.length} tracks from CSV${linkNote}${timeNote}.${skippedNote}`
				: `Imported ${parsed.length} tracks (no header row; columns read as title, artist, album${withLinks ? `, link` : ''})${linkNote}${timeNote}.${skippedNote}`;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not read that file.';
		} finally {
			el.value = '';
		}
	}

	/**
	 * Download the grid as CSV. Flushes the open cell editor first, and writes
	 * the same headers the importer reads, so the file round-trips.
	 */
	async function exportCsv() {
		error = '';
		notice = '';
		if (gridApi) await gridApi.exec('close-editor', {}).catch(() => {});
		resyncFromGrid();
		const rows = editable
			.filter(
				(t) => t.title.trim() !== '' || (t.url ?? '').trim() !== '' || t.mark_seconds !== null
			)
			.map((t) => ({
				position: t.position,
				markSeconds: t.mark_seconds,
				title: t.title,
				artist: t.artist,
				album: t.album,
				url: t.url
			}));
		if (rows.length === 0) {
			notice = 'Nothing to export yet.';
			return;
		}
		const blob = new Blob([toTracksCsv(rows)], { type: 'text/csv;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = tracklistCsvFilename(show.id, broadcast.date);
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
		notice = `Exported ${rows.length} row${rows.length === 1 ? '' : 's'} to CSV.`;
	}

	async function saveReplay() {
		replayError = '';
		replayNotice = '';
		replaySaving = true;
		const url = replayInput.trim();
		const res = await fetch(`/api/shows/${show.id}/broadcasts/${broadcast.id}/replay`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ url: url || null })
		});
		replaySaving = false;
		if (!res.ok) {
			replayError = await readErrorMessage(res);
			return;
		}
		const saved = (await res.json()) as { replayUrl: string | null };
		replayInput = saved.replayUrl ?? '';
		replayUrl = saved.replayUrl ?? '';
		replayNotice = saved.replayUrl ? 'Replay link saved.' : 'Replay link cleared.';
	}

	async function clearReplay() {
		replayError = '';
		replayNotice = '';
		replaySaving = true;
		const res = await fetch(`/api/shows/${show.id}/broadcasts/${broadcast.id}/replay`, {
			method: 'DELETE'
		});
		replaySaving = false;
		if (!res.ok) {
			replayError = await readErrorMessage(res);
			return;
		}
		replayInput = '';
		replayUrl = '';
		replayNotice = 'Replay link cleared.';
	}

	async function saveDescription() {
		descError = '';
		descNotice = '';
		descSaving = true;
		const res = await fetch(`/api/shows/${show.id}/broadcasts/${broadcast.id}/description`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ description: descInput })
		});
		descSaving = false;
		if (!res.ok) {
			descError = await readErrorMessage(res);
			return;
		}
		const saved = (await res.json()) as { description: string };
		descInput = saved.description;
		descNotice = 'Description saved.';
	}

	async function clearDescription() {
		descError = '';
		descNotice = '';
		descSaving = true;
		const res = await fetch(`/api/shows/${show.id}/broadcasts/${broadcast.id}/description`, {
			method: 'DELETE'
		});
		descSaving = false;
		if (!res.ok) {
			descError = await readErrorMessage(res);
			return;
		}
		descInput = '';
		descNotice = 'Description cleared.';
	}

	async function saveTitle() {
		titleError = '';
		titleNotice = '';
		titleSaving = true;
		const res = await fetch(`/api/shows/${show.id}/broadcasts/${broadcast.id}/title`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: titleInput })
		});
		titleSaving = false;
		if (!res.ok) {
			titleError = await readErrorMessage(res);
			return;
		}
		await invalidateAll();
		titleNotice = titleInput.trim() ? 'Episode title saved.' : 'Episode title cleared.';
	}

	async function clearTitle() {
		titleError = '';
		titleNotice = '';
		titleSaving = true;
		const res = await fetch(`/api/shows/${show.id}/broadcasts/${broadcast.id}/title`, {
			method: 'DELETE'
		});
		titleSaving = false;
		if (!res.ok) {
			titleError = await readErrorMessage(res);
			return;
		}
		titleInput = '';
		await invalidateAll();
		titleNotice = 'Episode title cleared.';
	}

	async function saveSlug() {
		slugError = '';
		slugSaving = true;
		const res = await fetch(`/api/shows/${show.id}/broadcasts/${broadcast.id}/slug`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ slug: slugInput })
		});
		slugSaving = false;
		if (!res.ok) {
			slugError = await readErrorMessage(res);
			return;
		}
		const saved = (await res.json()) as { id: string };
		if (saved.id !== broadcast.id) {
			// Renamed: navigate to the new episode editor URL.
			await goto(`/shows/${show.id}/${saved.id}/edit`, { invalidateAll: true });
			return;
		}
	}

	async function saveArt() {
		artError = '';
		artSaving = true;
		const url = artInput.trim();
		const res = await fetch(`/api/shows/${show.id}/broadcasts/${broadcast.id}/art`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ url: url || null })
		});
		artSaving = false;
		if (!res.ok) {
			artError = await readErrorMessage(res);
			return;
		}
		await invalidateAll();
	}

	async function clearArt() {
		artError = '';
		artSaving = true;
		const res = await fetch(`/api/shows/${show.id}/broadcasts/${broadcast.id}/art`, {
			method: 'DELETE'
		});
		artSaving = false;
		if (!res.ok) {
			artError = await readErrorMessage(res);
			return;
		}
		await invalidateAll();
	}

	async function save() {
		error = '';
		notice = '';
		// Commit any still-open cell editor so its pending value reaches row data.
		if (gridApi) await gridApi.exec('close-editor', {}).catch(() => {});
		resyncFromGrid();

		const badRows = Object.entries(invalidMarks);
		if (badRows.length > 0) {
			const positions = badRows.map(
				([id]) => editable.find((t) => t.id === id)?.position ?? '?'
			);
			const which = positions.length === 1 ? 'row' : 'rows';
			error = `Can't save: ${which} ${positions.join(', ')} ${
				positions.length === 1 ? "has a time that isn't" : "have times that aren't"
			} a clock value. Use m:ss or h:mm:ss — or leave it blank.`;
			return;
		}

		saving = true;
		const payload = editable
			.map((t) => ({
				id: t.id,
				title: t.title,
				artist: t.artist,
				album: t.album,
				url: t.url ?? '',
				markSeconds: t.mark_seconds
			}))
			// Keep time-only rows: a cue can be placed before the title is filled in.
			.filter((t) => t.title.trim() !== '' || t.url.trim() !== '' || t.markSeconds !== null);

		const res = await fetch(`/api/shows/${show.id}/broadcasts/${broadcast.id}/tracklist`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ tracks: payload })
		});
		saving = false;
		if (!res.ok) {
			error = 'Save failed. Please try again.';
			return;
		}
		const saved = (await res.json()) as TrackRow[];
		tracks = saved;
		editable = toDisplayPos(saved);
		saveVersion += 1;
		const bandcamp = saved.filter(
			(t) => typeof t.url === 'string' && /bandcamp\.com/i.test(t.url)
		).length;
		notice = `Tracklist saved (${saved.length} tracks)${bandcamp ? ` — ${bandcamp} Bandcamp track${bandcamp === 1 ? '' : 's'} ready to play` : '.'}`;
		// Warm Bandcamp metadata in the background so the public page is already
		// enriched (see README → "Bandcamp playback").
		void warmMetadata(saved);
	}

	/**
	 * Resolve name/artist (and cache art) for saved Bandcamp rows that are still
	 * missing it. Client-orchestrated: each row is its own short request, so a
	 * large import can't blow the Worker time budget.
	 */
	async function warmMetadata(rows: TrackRow[]) {
		const pending = rows.filter(
			(t) =>
				typeof t.url === 'string' &&
				/bandcamp\.com/i.test(t.url) &&
				!/EmbeddedPlayer/i.test(t.url) &&
				(!t.title || !t.stream_art_id)
		);
		if (pending.length === 0) return;

		const resolved = new Map<string, { title: string; artist: string }>();
		let cursor = 0;
		async function worker() {
			while (cursor < pending.length) {
				const t = pending[cursor++];
				try {
					const res = await fetch(`/api/tracks/${t.id}/stream`);
					if (res.ok) {
						const body = (await res.json()) as { title?: string | null; artist?: string | null };
						if (body.title || body.artist) {
							resolved.set(t.id, { title: body.title ?? '', artist: body.artist ?? '' });
						}
					}
				} catch {
					// best-effort enrichment
				}
				if (cursor < pending.length) await new Promise((r) => setTimeout(r, 200));
			}
		}
		await Promise.all([worker(), worker()]);

		// Reflect resolved names in the grid, unless the DJ is mid-edit.
		if (resolved.size > 0 && !gridApi?.getState().editor) {
			// `/api/tracks/:id/stream` already persisted these names, so the
			// saved baseline must gain them too. Otherwise the enrichment reads
			// as an unsaved change and the exit confirm fires after every save.
			const enrich = (row: TrackRow) => {
				const got = resolved.get(row.id);
				return got ? { ...row, title: row.title || got.title, artist: row.artist || got.artist } : row;
			};
			tracks = tracks.map(enrich);
			editable = editable.map(enrich);
			saveVersion += 1;
		}
	}

		let stampNotice = $state('');

	/**
	 * Fill the selected row's time with the player's current position in this
	 * episode's replay — the quick way to mark while listening back.
	 */
	async function stampSelected() {
		stampNotice = '';
		const selected = gridApi?.getState().selectedRows ?? [];
		const id = selected[0];
		if (!id) {
			stampNotice = 'Select a row first, then stamp the playing position.';
			return;
		}
		const current = get(playback);
		const pos = get(playerPosition);
		if (!replayUrl || current.kind !== 'media' || current.url !== replayUrl || pos.url !== replayUrl) {
			stampNotice = "Play this episode's replay above, then stamp the position.";
			return;
		}
		const seconds = Math.max(0, Math.floor(pos.seconds));
		await gridApi?.exec('update-row', { id, row: { mark: formatTrackTime(seconds) } });
		// Keep the mirror authoritative: the grid event may fire before its own
		// state has the new value, and a stale resync used to drop the mark (and
		// could drop a concurrent edit on the next save).
		editable = editable.map((row) => (row.id === id ? { ...row, mark_seconds: seconds } : row));
		stampNotice = `Stamped ${formatTrackTime(seconds)} into the selected row.`;
	}
</script>

<div class="page">
<div class="editor-head">
	<div>
		<p class="eyebrow mono"><a href={breadcrumbHref}>{show.title}</a> / Show</p>
		<h1>{show.title}</h1>
		<p class="airdate mono">
			Broadcast: <strong>{broadcast.date}</strong> · {fmtTime(broadcast.start_minutes)}
		</p>
	</div>
	<a class="exit-btn mono" href={episodeHref} onclick={handleExit}>Back to episode</a>
</div>

<div class="tabs" role="tablist">
	<button class="tab" class:active={activeTab === 'tracklist'} onclick={() => (activeTab = 'tracklist')}>Tracklist</button>
	<button class="tab" class:active={activeTab === 'replay'} onclick={() => (activeTab = 'replay')}>Replay</button>
	<button class="tab" class:active={activeTab === 'description'} onclick={() => (activeTab = 'description')}>Description</button>
	<button class="tab" class:active={activeTab === 'episode'} onclick={() => (activeTab = 'episode')}>Episode</button>
</div>

<input
	bind:this={fileInput}
	type="file"
	accept=".csv,.tsv,text/csv,text/tab-separated-values"
	class="hidden-input"
	onchange={(e) => onCsvPicked(e.currentTarget)}
/>

{#if activeTab === 'replay'}
	<div class="replay-row">
		<label for="replay-link">Replay link</label>
		<input
			id="replay-link"
			type="url"
			placeholder="Paste the on-demand track id or download link"
			bind:value={replayInput}
			onkeydown={(e) => e.key === 'Enter' && saveReplay()}
		/>
		<Button css="vr-cta ghost" disabled={replaySaving} onclick={saveReplay}>
			{replaySaving ? 'Saving…' : 'Save'}
		</Button>
		<Button css="vr-cta ghost" disabled={replaySaving} onclick={clearReplay}>Clear</Button>
		<p class="hint">Copy the recording's link from the AzuraCast on-demand player. Accepts a 24-char track id or a full download link.</p>
		{#if replayError}
			<p class="replay-msg bad">{replayError}</p>
		{/if}
		{#if replayNotice}
			<p class="replay-msg ok">{replayNotice}</p>
		{/if}
	</div>
{/if}

{#if activeTab === 'description'}
	<div class="desc-row">
		<label for="broadcast-desc">Description</label>
		<RichTextEditor bind:value={descInput} placeholder="Episode description" />
		<div class="desc-actions">
			<Button css="vr-cta ghost" disabled={descSaving} onclick={saveDescription}>
				{descSaving ? 'Saving…' : 'Save'}
			</Button>
			<Button css="vr-cta ghost" disabled={descSaving} onclick={clearDescription}>Clear</Button>
		</div>
		{#if descError}
			<p class="replay-msg bad">{descError}</p>
		{/if}
		{#if descNotice}
			<p class="replay-msg ok">{descNotice}</p>
		{/if}
	</div>
{/if}

{#if activeTab === 'episode'}
	<div class="desc-row">
		<label for="episode-title">Episode title (optional)</label>
		<input
			id="episode-title"
			type="text"
			maxlength="120"
			placeholder={show.title}
			bind:value={titleInput}
			onkeydown={(e) => e.key === 'Enter' && saveTitle()}
		/>
		<div class="desc-actions">
			<Button css="vr-cta ghost" disabled={titleSaving} onclick={saveTitle}>
				{titleSaving ? 'Saving…' : 'Save'}
			</Button>
			<Button css="vr-cta ghost" disabled={titleSaving} onclick={clearTitle}>Clear</Button>
		</div>
		<p class="hint">Shown on the show page and this episode's page. Leave blank to use the
			show title.</p>
		{#if titleError}
			<p class="replay-msg bad">{titleError}</p>
		{/if}
		{#if titleNotice}
			<p class="replay-msg ok">{titleNotice}</p>
		{/if}
	</div>

	<div class="desc-row">
		<label for="episode-slug">Episode ID</label>
		<input
			id="episode-slug"
			type="text"
			placeholder="lowercase-slug"
			bind:value={slugInput}
			onkeydown={(e) => e.key === 'Enter' && saveSlug()}
		/>
		<div class="desc-actions">
			<Button css="vr-cta ghost" disabled={slugSaving} onclick={saveSlug}>
				{slugSaving ? 'Saving…' : 'Save'}
			</Button>
		</div>
		{#if slugError}
			<p class="replay-msg bad">{slugError}</p>
		{/if}
	</div>

	<div class="desc-row">
		<label for="episode-art">Artwork URL (optional, blank clears)</label>
		<div class="art-fields">
			<input
				id="episode-art"
				type="url"
				placeholder="https://… or /media/<art-id>.jpg"
				bind:value={artInput}
				onkeydown={(e) => e.key === 'Enter' && saveArt()}
			/>
			<Button css="vr-cta ghost" disabled={artSaving} onclick={saveArt}>
				{artSaving ? 'Saving…' : 'Save'}
			</Button>
			<Button css="vr-cta ghost" disabled={artSaving} onclick={clearArt}>Clear</Button>
		</div>
		<p class="hint">Overrides this episode's default artwork. External image URLs are
			proxied and cached via /media; AzuraCast /media paths are used as-is. Leave blank to
			use the show's own image.</p>
		{#if artPreview}
			<img
				class="art-preview"
				src={artPreview}
				alt="Current artwork"
				loading="lazy"
				onerror={(e) => artOnError(e, artFb)}
			/>
		{/if}
		{#if artError}
			<p class="replay-msg bad">{artError}</p>
		{/if}
	</div>
{/if}

{#if activeTab === 'tracklist'}
	<div class="replay-strip">
		{#if !replayUrl}
			<button class="strip-btn" onclick={() => (activeTab = 'replay')}>
				Set a replay link
			</button>
			<span class="strip-note">A recording is needed to stamp times.</span>
		{:else if replayUnavailable}
			<span class="strip-note">Recording no longer available.</span>
		{:else}
			<button
				class="strip-btn"
				disabled={!replayMine}
				onclick={() => nudgeReplay(-60)}
				aria-label="Back 1 minute"
				title="Back 1 minute"
			>
				−1m
			</button>
			<button
				class="strip-btn"
				disabled={!replayMine}
				onclick={() => nudgeReplay(-5)}
				aria-label="Back 5 seconds"
				title="Back 5 seconds"
			>
				−5s
			</button>
			<button
				class="strip-btn play"
				class:playing={replayPlaying}
				onclick={toggleReplayPreview}
				aria-label={replayPlaying ? 'Pause the replay' : 'Play the replay'}
			>
				{replayPlaying ? '❚❚ Pause' : '▶ Replay'}
			</button>
			<button
				class="strip-btn"
				disabled={!replayMine}
				onclick={() => nudgeReplay(5)}
				aria-label="Forward 5 seconds"
				title="Forward 5 seconds"
			>
				+5s
			</button>
			<button
				class="strip-btn"
				disabled={!replayMine}
				onclick={() => nudgeReplay(60)}
				aria-label="Forward 1 minute"
				title="Forward 1 minute"
			>
				+1m
			</button>
			<span class="strip-time mono">
				{formatTrackTime(replayPos?.seconds ?? 0)} / {formatTrackTime(replayPos?.duration ?? 0)}
			</span>
			<button
				class="strip-btn stamp"
				onclick={stampSelected}
				aria-label="Stamp the playing position into the selected row"
				title="Stamp the playing position into the selected row"
			>
				Stamp time
			</button>
		{/if}
	</div>

	{#if replayUrl && !replayUnavailable}
		<EpisodeWaveform
			replayUrl={replayUrl}
			duration={replayMine ? (replayPos?.duration ?? null) : null}
			serverDuration={replayDuration}
			currentTime={replayPos?.seconds ?? 0}
			comments={[]}
			seed={broadcast.id}
			mode="seek"
			onSeek={seekFromWaveform}
		/>
	{/if}

	<div class="tracklist-actions">
		<Button css="vr-cta ghost" onclick={() => fileInput?.click()}>Import CSV</Button>
		<Button css="vr-cta ghost" onclick={exportCsv}>Export CSV</Button>
		<Button css="vr-cta ghost" disabled={seratoBusy} onclick={importSerato}>
			{seratoBusy ? 'Reading Serato…' : 'Import from Serato'}
		</Button>
		<Button css="vr-cta ghost" disabled={bandcampBusy} onclick={findBandcampLinks}>
			{bandcampBusy ? 'Matching Bandcamp…' : 'Find Bandcamp links'}
		</Button>
		<Button css="vr-cta ghost" onclick={insertTrack}>+ Insert track</Button>
		<Button css="vr-cta ghost" onclick={deleteSelected}>Delete selected</Button>
		<Button css="vr-cta" type="primary" disabled={saving} onclick={save}>
			{saving ? 'Saving…' : 'Save tracklist'}
		</Button>
	</div>

	<div class="serato-row">
		<label for="serato-url">Serato playlist URL</label>
		<input
			id="serato-url"
			type="url"
			placeholder="https://serato.com/playlists/<dj>/<date>"
			bind:value={seratoUrl}
			onkeydown={(e) => e.key === 'Enter' && importSerato()}
		/>
		<Button css="vr-cta ghost" disabled={seratoSaving} onclick={() => saveSeratoUrl()}>
			{seratoSaving ? 'Saving…' : 'Save URL'}
		</Button>
	</div>
	<p class="hint">
		Open your set on serato.com and paste its address. It is stored on this episode, so the
		import works later without retyping.
	</p>
	{#if seratoError}
		<p class="replay-msg bad">{seratoError}</p>
	{/if}
	{#if seratoNotice}
		<p class="replay-msg ok">{seratoNotice}</p>
	{/if}
	{#if bandcampNotice}
		<p class="replay-msg ok">{bandcampNotice}</p>
	{/if}

	{#if isAdmin}
		<div class="serato-row">
			<Button css="vr-cta ghost" disabled={detectBusy} onclick={() => detectTracks(false)}>
				{detectBusy && detectStatus && detectStatus !== 'done'
					? `Detecting… ${detectProgress ?? 0}%`
					: 'Detect tracks'}
			</Button>
			{#if detectStatus === 'done' || broadcast.detect_status === 'done'}
				<Button css="vr-cta ghost" disabled={detectBusy} onclick={() => detectTracks(true)}>
					Detect again (1 credit)
				</Button>
			{/if}
			<span class="hint">Beta · fingerprints the replay via Track Detect. One credit per new run.</span>
		</div>
		{#if detectError}
			<p class="replay-msg bad">{detectError}</p>
		{/if}
		{#if detectNotice}
			<p class="replay-msg ok">{detectNotice}</p>
		{/if}
	{/if}

	{#if error}
		<div class="notice bad">{error}</div>
	{/if}
	{#if notice}
		<div class="notice ok">{notice}</div>
	{/if}
	{#if backwardsAt !== null}
		<div class="notice warn">Times go backwards at row {backwardsAt} — allowed, just checking.</div>
	{/if}
	{#if stampNotice}
		<p class="hint">{stampNotice}</p>
	{/if}

	<div class="grid-wrap" onkeydowncapture={onGridKeydown}>
		{#key saveVersion}
			<WillowDark>
				<Grid
					{columns}
					data={gridData}
					reorder={true}
					undo={true}
					select={true}
					multiselect={true}
					init={handleInit}
				/>
			</WillowDark>
		{/key}
	</div>

	<p class="hint">Click a cell to edit it. Time is where the track starts in this episode's
		recording (m:ss or h:mm:ss) — listeners click it to jump there. Use the replay strip
		above to play, skip ±5s / ±1 min or scrub, select a row, then “Stamp time”. “Insert
		track” adds a row below the selected one (or at the end). Drag rows to
		reorder. Use Ctrl+Z / Ctrl+Y to undo and redo.</p>
{/if}
</div>

<style>
	.page {
		padding: 2rem;
		max-width: 76rem;
	}

	.editor-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		flex-wrap: wrap;
		margin-bottom: 1rem;
	}

	.exit-btn {
		margin-left: auto;
		align-self: flex-start;
		border: 1px solid var(--vr-line);
		padding: 0.35rem 0.7rem;
		color: var(--vr-text);
		text-decoration: none;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		white-space: nowrap;
	}

	.exit-btn:hover,
	.exit-btn:focus-visible {
		background: var(--vr-text);
		color: var(--vr-black);
		border-color: var(--vr-text);
	}

	.eyebrow {
		margin: 0;
		font-size: 0.82rem;
		color: var(--vr-muted);
	}

	.eyebrow a {
		color: var(--vr-text);
		text-decoration: underline;
	}

	h1 {
		margin: 0.4rem 0 0;
		font-family: var(--vr-font-headline);
		font-size: 2.25rem;
		font-weight: 400;
		line-height: 1;
		text-transform: uppercase;
		letter-spacing: 0.01em;
	}

	.airdate {
		margin: 0.5rem 0 0;
		color: var(--vr-muted);
	}

	.tabs {
		display: flex;
		flex-wrap: wrap;
		margin: 0 0 1rem;
		border: 1px solid var(--vr-line);
	}

	.tab {
		flex: 0 0 auto;
		background: transparent;
		color: var(--vr-text);
		border: none;
		border-right: 1px solid var(--vr-line);
		font-family: var(--vr-font-headline);
		font-size: 1rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 0.55rem 1.1rem;
		cursor: pointer;
	}

	.tab:last-child {
		border-right: none;
	}

	.tab:hover {
		background: var(--vr-surface-high);
	}

	.tab.active {
		background: var(--vr-text);
		color: var(--vr-black);
	}

	.tracklist-actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin: 0 0 0.5rem;
	}

	/* Serato import: handle + one-off URL. Kept quiet — most DJs set it once. */
	.serato-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin: 0 0 0.5rem;
	}

	.serato-row label {
		font-size: 0.75rem;
		color: var(--vr-muted);
		font-family: var(--vr-font-mono);
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.serato-row input {
		flex: 1 1 16rem;
		min-width: 0;
		background: var(--vr-bg-deep);
		border: 1px solid var(--vr-line-muted);
		color: var(--vr-text);
		font: inherit;
		font-size: 0.85rem;
		padding: 0.4rem 0.55rem;
	}

	.serato-row input:focus-visible {
		outline: 1px solid var(--vr-line);
		outline-offset: 1px;
	}

	/* Replay preview: play/pause, ±5s / ±1 min, scrub — so cues can be stamped
	   without leaving edit mode. */
	.replay-strip {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0 0 0.6rem;
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--vr-line);
		background: var(--vr-surface-low);
	}

	.strip-btn {
		background: transparent;
		border: 1px solid var(--vr-line-muted);
		color: var(--vr-text);
		font-family: var(--vr-font-mono);
		font-size: 0.72rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		padding: 0.35rem 0.6rem;
		cursor: pointer;
		white-space: nowrap;
	}

	.strip-btn:hover:not(:disabled) {
		background: var(--vr-text);
		color: var(--vr-black);
		border-color: var(--vr-line);
	}

	.strip-btn:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.strip-btn.play {
		min-width: 6.5rem;
		border-color: var(--vr-line);
	}

	.strip-btn.play.playing {
		background: var(--vr-text);
		color: var(--vr-black);
	}

	.strip-btn.stamp {
		border-color: var(--vr-line);
	}

	.strip-time {
		font-size: 0.72rem;
		color: var(--vr-muted);
		white-space: nowrap;
	}


	.strip-note {
		font-size: 0.78rem;
		color: var(--vr-muted);
	}

	.grid-wrap {
		border: 1px solid var(--vr-line);
		background: var(--vr-surface);
		padding: 0.75rem;
		height: 440px;
		overflow: hidden;
	}

	.hint {
		color: var(--vr-muted);
		font-size: 0.85rem;
		margin-top: 0.75rem;
	}

	.hidden-input {
		display: none;
	}

	.replay-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin: 0.5rem 0 1rem;
		padding: 0.75rem 0.85rem;
		border: 1px solid var(--vr-line);
		background: var(--vr-surface);
	}

	.desc-row {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin: 0 0 1rem;
		padding: 0.75rem 0.85rem;
		border: 1px solid var(--vr-line);
		background: var(--vr-surface);
	}

	.desc-row label {
		font-size: 0.85rem;
		color: var(--vr-muted);
		font-family: var(--vr-font-mono);
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.desc-actions {
		display: flex;
		gap: 0.5rem;
	}

	.art-fields {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		align-items: center;
	}

	.art-fields input {
		flex: 1;
		min-width: 220px;
	}

	.art-preview {
		width: 80px;
		height: 80px;
		object-fit: cover;
		border: 1px solid var(--vr-line-muted);
		margin-top: 0.4rem;
	}

	.desc-row input {
		background: transparent;
		color: var(--vr-text);
		border: 1px solid var(--vr-line-muted);
		padding: 0.4rem 0.6rem;
		font-size: 0.85rem;
	}

	.replay-row label {
		font-size: 0.85rem;
		color: var(--vr-muted);
		font-family: var(--vr-font-mono);
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.replay-row input {
		flex: 1;
		min-width: 200px;
		background: transparent;
		color: var(--vr-text);
		border: 1px solid var(--vr-line-muted);
		padding: 0.4rem 0.6rem;
		font-size: 0.85rem;
		font-family: var(--vr-font-body);
	}

	.replay-row input:focus {
		outline: none;
		border-color: #fff;
		box-shadow: 0 0 0 2px #fff, inset 0 0 0 1px #fff;
	}

	.replay-row .hint {
		flex-basis: 100%;
		margin: 0.25rem 0 0;
		font-size: 0.78rem;
	}

	.replay-msg {
		flex-basis: 100%;
		margin: 0.35rem 0 0;
		font-size: 0.85rem;
	}

	.replay-msg.ok {
		color: var(--vr-muted);
	}

	.replay-msg.bad {
		color: var(--vr-text);
	}

	.notice {
		margin: 0 0 0.75rem;
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

	.notice.warn {
		border-style: dashed;
		color: var(--vr-muted);
	}
</style>
