# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

SvelteKit (Svelte 5) PWA on Cloudflare Pages (Workers). Stream served via self-hosted AzuraCast HLS (this deployment: `stream.versionradio.live`; point `src/lib/azuracast.ts` at your own instance to fork).

## Users

Primary users are listeners — typically someone with Version Radio on in the background (desktop or phone), who glances at the now-playing/Tracklist view and joins the chat during a show. The community (DJs, regulars, hosts) are a second first-class audience: they run the station, schedule shows, manage tracklists, moderate chat, and rely on replays and schedules. Both matter; the listener side gets the most screen time.

## Product Purpose

Version Radio is an underground NZ independent art-radio station: a 24/7 stream with live shows, DJ tracklists, schedules, replays, and a community chat. Success means the station keeps broadcasting, people tune in, and the chat feels lived-in — not that the site converts or scales.

## Positioning

An independent non-commercial station with a strong identity — underground, alternative, art-radio. It is never a SaaS dashboard or a commercial web product. The identity is the reason it's worth listening to; the tools (stream, schedule, tracklists, replays, chat) are what keep it running.

## Operating Context

Listeners use the PWA on desktop and phone, often in the background. DJs use admin flows (schedule, tracklist editor, replay links) from the same site. Chat is live and social; replays let listeners catch missed shows.

## Capabilities and Constraints

- Live HLS stream, now-playing, tracklist timeline, schedules, show pages with replays
- Community chat with identity, reactions, moderation (admin), and rate-limits
- PWA install, offline-capable frontend, Cloudflare-bound server
- Tracklists: manual entry, CSV import, editable via admin
- Digital-brutalist identity: monochrome + functional red/green status stickers; Anton / Hanken Grotesk / JetBrains Mono (self-hosted)
- Anti-SaaS / anti-commercial: no gradient-purple SaaS aesthetics, no generic marketing patterns, no "everything is a card" layouts

## Brand Commitments

- Name: Version Radio
- Logo: traced stepped-V glyph (monochrome, `static/logo.svg`), used in: brand mark, favicon, icons
- Visual identity: digital brutalism — monochrome with functional red/green status stickers, zero radius, 1px white borders; the stepped-V mark and its pixel/stepped geometry are the signature
- Voice: plain, understated — the station itself is the personality

## Evidence on Hand

- `static/logo.svg` — official mark (traced from `v_icon_dark.webp` reference)
- README.md, HANDOVER.md — project documentation
- No testimonials/press are claimed or should be invented

## Product Principles

- The identity leads: the station owns the aesthetic; the platform disappears into the broadcast.
- Community is the product's second skin: chat, shows, and replays exist so people can be around the broadcast together.
- Monochrome is a discipline, not a lack of colour: contrast, spacing, and the pixel mark carry the character.
- Do not look like a SaaS product — no commercial clichés, no cards-in-cards, no marketing gradient.
- Everything else works quietly: streaming, schedule, tracklists, replays are reliable first.

## Accessibility & Inclusion

Dark theme is the only theme; contrast and legibility on the player, chat, and tracklist views must remain usable at brightness levels typical of dark screens/browsers.
