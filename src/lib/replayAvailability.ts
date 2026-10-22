import { writable } from 'svelte/store';

/**
 * Replay links proven unplayable by /api/replay-status.
 *
 * The server can't answer this during render (upstream HEADs stall), so pages
 * paint every player as normal and the flags appear once the probe answers.
 */
export const unavailableReplays = writable<Set<string>>(new Set());

const asked = new Set<string>();
let pending: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** Queue links for an availability check; safe to call on every navigation. */
export function probeReplayAvailability(urls: (string | null | undefined)[]): void {
	for (const raw of urls) {
		const url = raw?.trim();
		if (!url || asked.has(url)) continue;
		asked.add(url);
		pending.push(url);
	}
	if (pending.length === 0) return;
	if (timer) clearTimeout(timer);
	// Coalesce the calls a page makes so one request covers the whole view.
	timer = setTimeout(flush, 60);
}

async function flush(): Promise<void> {
	timer = null;
	const batch = pending.splice(0, 24);
	if (batch.length === 0) return;

	try {
		const query = new URLSearchParams();
		for (const url of batch) query.append('url', url);
		const res = await fetch(`/api/replay-status?${query}`);
		if (res.ok) {
			const body = (await res.json()) as { unavailable?: string[] };
			const dead = body.unavailable ?? [];
			if (dead.length > 0) {
				unavailableReplays.update((current) => {
					const next = new Set(current);
					for (const url of dead) next.add(url);
					return next;
				});
			}
		}
	} catch {
		// Best effort: leave the player available rather than blocking it.
	}

	if (pending.length > 0) timer = setTimeout(flush, 60);
}
