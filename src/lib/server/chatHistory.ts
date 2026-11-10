import type { ChatMessage } from '$lib/chat';

/**
 * Read a room's recent history over the worker's public HTTP endpoint, so
 * episode comments are readable before Turnstile verification. Best-effort:
 * a chat outage must not break the page.
 */
export async function fetchChatHistory(
	chatUrl: string,
	room: string
): Promise<ChatMessage[]> {
	if (!chatUrl) return [];
	try {
		const url = new URL('/api/history', chatUrl);
		url.searchParams.set('room', room);
		const res = await fetch(url);
		if (!res.ok) return [];
		const body = (await res.json().catch(() => null)) as { messages?: unknown } | null;
		return Array.isArray(body?.messages) ? (body.messages as ChatMessage[]) : [];
	} catch {
		return [];
	}
}
