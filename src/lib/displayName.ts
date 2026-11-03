/**
 * Public display name for an account.
 *
 * Email addresses must never surface as a display name: the chat broadcasts and
 * persists the name against every message, and the header/login use it too. A
 * magic-link signup starts with `name = ''`, so the old `name || email` fallback
 * leaked personal addresses. Anything that looks like an address is rejected
 * even if a user typed one into their profile.
 */
export function displayNameFor(
	user: { name?: string | null; email?: string | null } | null | undefined
): string {
	const name = user?.name?.trim() ?? '';
	if (name !== '' && !name.includes('@')) return name;
	return 'Listener';
}

/** True when the account still needs a display name (chat shows "Listener"). */
export function needsDisplayName(
	user: { name?: string | null; email?: string | null } | null | undefined
): boolean {
	return displayNameFor(user) === 'Listener';
}
