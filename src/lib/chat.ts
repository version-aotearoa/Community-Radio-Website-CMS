/** Shared chat/comment types and room helpers (client + server safe). */

export interface GifMedia {
	url: string;
	preview?: string | null;
	width?: number | null;
	height?: number | null;
}

export interface ChatMessage {
	id: string;
	ts: number;
	name: string;
	content: string;
	userId?: string | null;
	gif?: GifMedia | null;
	reactions?: Record<string, number>;
	my?: string[];
	/** True when this connection authored the message. */
	mine?: boolean;
	/** Moment in the episode recording, in seconds. */
	atSeconds?: number | null;
	/** Parent comment when this message is a reply. */
	parentId?: string | null;
}

export const MAIN_CHAT_ROOM = 'main';

/** Stable room key for an episode: show id + air date are immutable. */
export function episodeRoomKey(showId: string, date: string): string {
	return `episode:${showId}:${date}`;
}

export interface EpisodeRoomKey {
	showId: string;
	date: string;
}

/** Split an `episode:<showId>:<YYYY-MM-DD>` room key; null for anything else. */
export function parseEpisodeRoomKey(room: string): EpisodeRoomKey | null {
	const m = /^episode:([A-Za-z0-9_-]+):(\d{4}-\d{2}-\d{2})$/.exec(room);
	return m ? { showId: m[1], date: m[2] } : null;
}

/** Room names accepted by the chat worker. */
export function isChatRoom(room: string): boolean {
	return room === MAIN_CHAT_ROOM || parseEpisodeRoomKey(room) !== null;
}
