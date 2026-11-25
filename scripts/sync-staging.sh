#!/usr/bin/env bash
#
# Sync STAGING D1 to a snapshot of PROD D1 (one-way: prod -> staging).
#
# FULL SNAPSHOT: staging's schema and content are replaced by prod's, so staging
# edits are lost. Auth credential/session rows (account, session, verification)
# are deliberately NOT copied — prod sessions never land on staging; staging
# users re-authenticate via magic link.
#
# The current staging database is exported to a timestamped backup first; the
# path is printed and the file is kept.
#
#   scripts/sync-staging.sh
#
# Requires: wrangler auth valid, node available.
set -euo pipefail

PROD_DB="version-radio-db"
STAGING_DB="version-radio-db-staging"
STAGING_CONFIG="deploy/staging/wrangler.jsonc"

# Rows that must never leave prod.
AUTH_TABLES=(account session verification)

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/staging-sync.XXXXXX")"
STAGING_BACKUP="${TMPDIR:-/tmp}/version-radio-staging-backup-${TIMESTAMP}.sql"
trap 'rm -rf "$WORK_DIR"' EXIT

PROD_DUMP="$WORK_DIR/prod.sql"
FILTERED_DUMP="$WORK_DIR/prod-filtered.sql"

echo "==> Backing up STAGING to $STAGING_BACKUP"
npx wrangler d1 export "$STAGING_DB" --remote -c "$STAGING_CONFIG" -y \
  --output "$STAGING_BACKUP"

echo "==> Exporting PROD (schema + data)"
npx wrangler d1 export "$PROD_DB" --remote -y --output "$PROD_DUMP"

echo "==> Filtering auth rows out of the import"
AUTH_PATTERN="^INSERT INTO \"?($(IFS='|'; echo "${AUTH_TABLES[*]}"))\"? "
grep -v -E "$AUTH_PATTERN" "$PROD_DUMP" > "$FILTERED_DUMP"
for t in "${AUTH_TABLES[@]}"; do
  if grep -q -E "^INSERT INTO \"?${t}\"? " "$FILTERED_DUMP"; then
    echo "Refusing to continue: $t rows survived filtering." >&2
    exit 1
  fi
done

echo "==> Reading STAGING schema"
npx wrangler d1 execute "$STAGING_DB" --remote -c "$STAGING_CONFIG" --json \
  --command "SELECT type, name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%';" \
  >"$WORK_DIR/objects.json"
npx wrangler d1 execute "$STAGING_DB" --remote -c "$STAGING_CONFIG" --json \
  --command "SELECT m.name AS child, f.\"table\" AS parent FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%';" \
  >"$WORK_DIR/fks.json"

# Drop tables child-first so foreign keys never block the wipe. The order is
# derived from the live schema, so new tables/FKs are handled automatically.
OBJECTS_JSON="$WORK_DIR/objects.json" \
FK_JSON="$WORK_DIR/fks.json" \
DROP_SQL="$WORK_DIR/drop.sql" \
node <<'NODE'
const fs = require('node:fs');

const objects = JSON.parse(fs.readFileSync(process.env.OBJECTS_JSON, 'utf8'))[0].results;
const fks = JSON.parse(fs.readFileSync(process.env.FK_JSON, 'utf8'))[0].results;

const tables = objects.filter((o) => o.type === 'table').map((o) => o.name);
const views = objects.filter((o) => o.type === 'view').map((o) => o.name);

// child -> parents; count how many children reference each table.
const parentsOf = new Map(tables.map((t) => [t, new Set()]));
const childCount = new Map(tables.map((t) => [t, 0]));
for (const { child, parent } of fks) {
  if (!parentsOf.has(child) || !childCount.has(parent)) continue;
  if (parentsOf.get(child).has(parent)) continue;
  parentsOf.get(child).add(parent);
  childCount.set(parent, childCount.get(parent) + 1);
}

// Tables nobody references can be dropped first; dropping a child releases its
// parents.
const queue = tables.filter((t) => childCount.get(t) === 0);
const order = [];
while (queue.length > 0) {
  const table = queue.shift();
  order.push(table);
  for (const parent of parentsOf.get(table)) {
    childCount.set(parent, childCount.get(parent) - 1);
    if (childCount.get(parent) === 0) queue.push(parent);
  }
}
if (order.length !== tables.length) {
  console.error('Could not order staging tables for drop (foreign-key cycle).');
  process.exit(1);
}

const sql = [
  ...views.map((v) => `DROP VIEW IF EXISTS "${v}";`),
  ...order.map((t) => `DROP TABLE IF EXISTS "${t}";`)
];
fs.writeFileSync(process.env.DROP_SQL, sql.join('\n') + '\n');
console.log(`    ${views.length} view(s), ${order.length} table(s) to drop`);
NODE

echo "==> Wiping STAGING"
npx wrangler d1 execute "$STAGING_DB" --remote -c "$STAGING_CONFIG" \
  --command "$(cat "$WORK_DIR/drop.sql")" >/dev/null

echo "==> Importing PROD snapshot into STAGING"
npx wrangler d1 execute "$STAGING_DB" --remote -c "$STAGING_CONFIG" \
  --file "$FILTERED_DUMP"

echo "==> Verifying row counts"
npx wrangler d1 execute "$PROD_DB" --remote --json \
  --command "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;" \
  >"$WORK_DIR/prod-tables.json"

PROD_TABLES_JSON="$WORK_DIR/prod-tables.json" \
COUNTS_SQL="$WORK_DIR/counts.sql" \
node <<'NODE'
const fs = require('node:fs');
const tables = JSON.parse(fs.readFileSync(process.env.PROD_TABLES_JSON, 'utf8'))[0].results.map(
  (r) => r.name
);
const selects = tables.map((t) => `(SELECT COUNT(*) FROM "${t}") AS "${t}"`);
fs.writeFileSync(process.env.COUNTS_SQL, `SELECT ${selects.join(', ')};\n`);
NODE

npx wrangler d1 execute "$PROD_DB" --remote --json \
  --command "$(cat "$WORK_DIR/counts.sql")" >"$WORK_DIR/prod-counts.json"
npx wrangler d1 execute "$STAGING_DB" --remote -c "$STAGING_CONFIG" --json \
  --command "$(cat "$WORK_DIR/counts.sql")" >"$WORK_DIR/staging-counts.json"

PROD_COUNTS="$WORK_DIR/prod-counts.json" \
STAGING_COUNTS="$WORK_DIR/staging-counts.json" \
AUTH_TABLES="${AUTH_TABLES[*]}" \
node <<'NODE'
const fs = require('node:fs');

const prod = JSON.parse(fs.readFileSync(process.env.PROD_COUNTS, 'utf8'))[0].results[0];
const staging = JSON.parse(fs.readFileSync(process.env.STAGING_COUNTS, 'utf8'))[0].results[0];
const skipped = new Set(process.env.AUTH_TABLES.split(/\s+/).filter(Boolean));

let failed = false;
console.log(`    ${'table'.padEnd(22)} ${'prod'.padStart(7)} ${'staging'.padStart(8)}`);
for (const table of Object.keys(prod).sort()) {
  const p = prod[table];
  const s = staging[table] ?? 0;
  const expected = skipped.has(table) ? 0 : p;
  const ok = s === expected;
  if (!ok) failed = true;
  const note = skipped.has(table) ? '  (auth rows skipped)' : ok ? '' : '  <-- MISMATCH';
  console.log(`    ${table.padEnd(22)} ${String(p).padStart(7)} ${String(s).padStart(8)}${note}`);
}
if (failed) {
  console.error('Verification failed: staging does not match prod.');
  process.exit(1);
}
NODE

echo "==> Done. Staging now mirrors prod."
