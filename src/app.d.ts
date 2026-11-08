/// <reference path="../worker-configuration.d.ts" />

declare global {
	namespace App {
		interface Session {
			id: string;
			token: string;
			userId: string;
			expiresAt: Date;
			ipAddress?: string | null;
			userAgent?: string | null;
		}

		interface User {
			id: string;
			name: string;
			email: string;
			emailVerified: boolean;
			image?: string | null;
			role: 'listener' | 'dj' | 'admin';
			active: boolean;
			createdAt: Date;
			updatedAt: Date;
		}

		// Server-side auth session / user context (populated in hooks.server.ts)
		interface Locals {
			user: App.User | null;
			session: App.Session | null;
		}

		// Cloudflare runtime bindings available on event.platform
		interface Platform {
			env: CloudflareBindings;
			ctx: ExecutionContext;
			caches: CacheStorage;
			cf: IncomingRequestCfProperties;
		}

		interface PageData {
			user: App.Locals['user'];
		}
	}

	// Secrets / vars not derived from wrangler bindings.
	interface CloudflareBindings {
		AUTH_SECRET: string;
		/** Server-only AzuraCast API key (station media access, used for waveforms). */
		AZURACAST_API_KEY?: string;
		CHAT_ADMIN_TOKEN?: string;
		CHAT_IDENTITY_SECRET?: string;
		GITHUB_ID?: string;
		GITHUB_SECRET?: string;
		GOOGLE_ID?: string;
		GOOGLE_SECRET?: string;
		EMAIL_FROM?: string;
		EMAIL?: SendEmail;
		RESEND_API_KEY?: string;
		RESEND_FROM?: string;
		PUBLIC_CHAT_URL?: string;
		PUBLIC_GIPHY_API_KEY?: string;
		/** Jina reader API key (Bandcamp page fetches bypass the bot challenge). */
		JINA_API_KEY?: string;
		TURNSTILE_SECRET?: string;
		TURNSTILE_HOSTNAMES?: string;
		PUBLIC_TURNSTILE_SITE_KEY?: string;
	}

	interface Window {
		turnstile?: {
			render: (container: HTMLElement, config: Record<string, unknown>) => number;
			reset: (widgetId: number) => void;
			remove: (widgetId: number) => void;
		};
	}
}

export {};
