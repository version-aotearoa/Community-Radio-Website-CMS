import { redirect, type RequestEvent } from '@sveltejs/kit';
import { building } from '$app/environment';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { createAuth } from '$lib/server/auth';

/** Paths whose 404s must stay 404s: they answer JSON/media, not pages. */
const NEVER_BOUNCE = new Set(['api', 'media']);

/** Last path segment looks like a file (`.png`, `.json`, `.xml`) rather than a page. */
const LOOKS_LIKE_FILE = /\.[a-z0-9]+$/i;

/** Strip SvelteKit's client-router (`__data.json`) suffix to get the path people see. */
function pagePathname(url: URL): string {
	return url.pathname.replace(/\/__data\.json$/, '');
}

/** Path + query for the notice, minus SvelteKit's internal invalidation param. */
function pagePath(url: URL): string {
	const search = new URLSearchParams(url.search);
	search.delete('x-sveltekit-invalidated');
	const qs = search.toString();

	return pagePathname(url) + (qs ? `?${qs}` : '');
}

/**
 * Should a 404 be turned into a bounce to the homepage?
 *
 * Only for page requests (a full document load or the client router asking for
 * data), and never for API/media responses, asset-looking paths or non-GET
 * verbs — an `<audio>`, `<img>` or `fetch()` caller must still see a real 404.
 * Permanent moves belong in `_redirects`, which Pages applies at the edge before
 * this Worker ever runs.
 */
function shouldBounceHome(event: RequestEvent, response: Response): boolean {
	if (response.status !== 404) return false;
	if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return false;

	const pathname = pagePathname(event.url);
	if (pathname === '/') return false;
	if (event.url.searchParams.has('missing')) return false;

	const [first = ''] = pathname.split('/').filter(Boolean);
	if (NEVER_BOUNCE.has(first)) return false;
	if (LOOKS_LIKE_FILE.test(pathname.split('/').pop() ?? '')) return false;

	if (event.isDataRequest) return true;

	return (event.request.headers.get('accept') ?? '').includes('text/html');
}

function bounceHome(event: RequestEvent, response: Response): Response {
	if (!shouldBounceHome(event, response)) return response;

	const path = pagePath(event.url);
	const referer = event.request.headers.get('referer');
	console.warn(`[404] ${event.request.method} ${path}${referer ? ` (from ${referer})` : ''}`);

	// The root layout load reads this param server-side and hands it to the page,
	// so the notice is in the first render. (Setting a flash cookie here is not
	// possible: cookies are frozen once the response exists.)
	redirect(303, `/?missing=${encodeURIComponent(path)}`);
}

export async function handle({ event, resolve }) {
	// Never let the browser (or edge) cache SSR responses: HTML pages and data
	// must be fresh on every load (Safari heuristically caches responses with
	// no Cache-Control header). Static assets bypass the worker entirely.
	// Asset proxies (/media) set their own long-lived cache headers, so exempt
	// them here or the edge cache never engages.
	if (!event.url.pathname.startsWith('/media/')) {
		event.setHeaders({ 'cache-control': 'no-store' });
	}

	if (event.platform?.env) {
		const auth = createAuth(event.platform.env);

		const session = await auth.api.getSession({ headers: event.request.headers });
		if (session) {
			if (session.user.active === false) {
				// Deactivated user: destroy their session and treat as signed out.
				await auth.api.signOut({ headers: event.request.headers });
				event.locals.session = null;
				event.locals.user = null;
			} else {
				event.locals.session = session.session as App.Session;
				event.locals.user = session.user as App.User;
			}
		}

		return bounceHome(event, await svelteKitHandler({ event, resolve, auth, building }));
	}

	return bounceHome(event, await resolve(event));
}
