import { json } from '@sveltejs/kit';
import { trackDetectAccount } from '$lib/server/trackdetect';
import type { RequestHandler } from './$types';

/**
 * Track Detect credit balance for the admin trial.
 *
 * The account call is free, so the editor can show the balance before an admin
 * spends a credit. The API key never leaves the server.
 */
export const GET: RequestHandler = async ({ locals, platform }) => {
	if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });

	const apiKey = platform!.env.TRACK_DETECT_API_KEY;
	if (!apiKey) return json({ configured: false });

	const result = await trackDetectAccount(apiKey);
	if (!result.ok) {
		return json({ configured: true, error: result.message, code: result.code }, { status: 502 });
	}

	return json({
		configured: true,
		credits: result.data.credits,
		limits: result.data.limits,
		purchaseUrl: result.data.purchaseUrl ?? null
	});
};
