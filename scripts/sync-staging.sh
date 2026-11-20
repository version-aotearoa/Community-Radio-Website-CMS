#!/usr/bin/env bash
#
# Sync STAGING D1 to a snapshot of PROD D1 (one-way: prod -> staging).
#
# TRUE SNAPSHOT: staging is wiped then re-imported, so staging edits are lost
# and staging mirrors prod exactly. Run before each test round:
#
#   scripts/sync-staging.sh
#
# Requires: CLOUDFLARE_ACCOUNT_ID exported, wrangler auth valid, `node` available.
set -euo pipefail

PROD_DB="version-radio-db"
STAGING_DB="version-radio-db-staging"

# Tables in parent-first import order (FK-safe: follow_show, saved_episode,
# saved_track and favourite_broadcast carry REFERENCES clauses; the rest are
# plain text keys). Auth tables are intentionally skipped so staging sessions
# stay clean — staging users re-auth via magic link. d1_migrations and the
# legacy, always-empty `saved_show` are excluded.
TABLES=(user show broadcast track site_content news_post follow_show saved_episode saved_track favourite_broadcast news_heart detected_track)

# Child-first delete order (reverse of import) so FK references clear.
DELETE_ORDER=(detected_track news_heart favourite_broadcast saved_track saved_episode follow_show track broadcast show user site_content news_post)

TMP_SQL="$(mktemp /tmp/staging-sync.XXXXXX.sql)"
trap 'rm -f "$TMP_SQL"' EXIT

# Build "--table <name>" pairs for the export call.
TABLE_ARGS=()
for t in "${TABLES[@]}"; do
  TABLE_ARGS+=(--table "$t")
done

echo "==> Exporting PROD tables (data only)"
npx wrangler d1 export "$PROD_DB" --remote --no-schema \
  "${TABLE_ARGS[@]}" \
  --output "$TMP_SQL"

echo "==> Wiping STAGING (child-first)"
for t in "${DELETE_ORDER[@]}"; do
  npx wrangler d1 execute "$STAGING_DB" --remote \
    --command "DELETE FROM $t;" >/dev/null
done

echo "==> Importing snapshot into STAGING"
npx wrangler d1 execute "$STAGING_DB" --remote --file "$TMP_SQL"

echo "==> Verifying"
npx wrangler d1 execute "$STAGING_DB" --remote --command \
  "SELECT COUNT(*) AS shows FROM show; SELECT COUNT(*) AS broadcasts FROM broadcast; SELECT COUNT(*) AS tracks FROM track; SELECT COUNT(*) AS users FROM user; SELECT COUNT(*) AS content FROM site_content; SELECT COUNT(*) AS follows FROM follow_show; SELECT COUNT(*) AS saved FROM saved_episode;"

echo "==> Done. Staging now mirrors prod."
