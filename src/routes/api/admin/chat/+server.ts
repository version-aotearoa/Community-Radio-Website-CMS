import { json } from '@sveltejs/kit';
import { isChatRoom } from '$lib/chat';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals, platform }) => {
	if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
	const env = platform!.env;
	const chatUrl = env.PUBLIC_CHAT_URL;
	const token = env.CHAT_ADMIN_TOKEN;
	if (!chatUrl || !token) return json({ error: 'Chat moderation not configured' }, { status: 503 });

	const room = url.searchParams.get('room') ?? 'main';
	if (!isChatRoom(room)) return json({ error: 'Invalid room' }, { status: 400 });

	const params = new URLSearchParams();
	params.set('room', room);
	const limit = url.searchParams.get('limit');
	if (limit) params.set('limit', limit);
	const beforeTs = url.searchParams.get('beforeTs');
	const beforeId = url.searchParams.get('beforeId');
	if (beforeTs && beforeId) {
		params.set('beforeTs', beforeTs);
		params.set('beforeId', beforeId);
	}

	const res = await fetch(`${chatUrl}/api/admin/history?${params.toString()}`, {
		headers: { authorization: `Bearer ${token}` }
	});
	if (!res.ok) return json({ error: 'Chat unavailable' }, { status: 502 });
	return json(await res.json());
};
