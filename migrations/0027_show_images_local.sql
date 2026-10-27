-- Migration number: 0027 	 2026-10-26

-- Show artwork is owned by the site, not hotlinked from AzuraCast.
--
-- Every show image used to point at an AzuraCast URL (a streamer avatar or a
-- recording's art id). Those ids are per-instance and include a version
-- timestamp, so migrating the stream server silently replaced every show image
-- with the station album-art fallback — while the old bytes stayed in caches,
-- making the breakage look intermittent and browser-dependent.
--
-- The files now live in static/shows/<show id>.jpg and ship with this deploy,
-- so the paths below always resolve and no longer depend on the stream server.

UPDATE show SET image = '/shows/beats-reality.jpg' WHERE id = 'beats-reality';
UPDATE show SET image = '/shows/detunedradio.jpg' WHERE id = 'detunedradio';
UPDATE show SET image = '/shows/hifi-session-2026-04-11.jpg' WHERE id = 'hifi-session-2026-04-11';
UPDATE show SET image = '/shows/imaginaldiscs-mix01-2026-09-11.jpg' WHERE id = 'imaginaldiscs-mix01-2026-09-11';
UPDATE show SET image = '/shows/lushelections-w-llush.jpg' WHERE id = 'lushelections-w-llush';
UPDATE show SET image = '/shows/reasonable-dubs.jpg' WHERE id = 'reasonable-dubs';
