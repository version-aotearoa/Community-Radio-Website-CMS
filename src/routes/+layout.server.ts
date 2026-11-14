import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, url }) => {
	// hooks.server.ts bounces page 404s to `/?missing=<path>`. Read it here (not
	// client-side) so the notice is part of the first render, with no timer or
	// router-state juggling in the browser.
	const missing = url.searchParams.get('missing');

	return {
		user: locals.user,
		missing: missing ? missing.slice(0, 200) : null
	};
};
