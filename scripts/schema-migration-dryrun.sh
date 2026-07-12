#!/usr/bin/env bash
#
# Schema-bump dry-run gate.
#
# WHY: bumping SCHEMA_GENERATION does NOT run "just your new migration".
# needsSchemaInit (servers/shared/schema-version.js) -> servers/gateway/index.js
# runs the ENTIRE scripts/init-db.js, which contains 8 DROP TABLE
# rebuild-migrations (shared_items, crow_context, dashboard_settings,
# research_projects, a generic DROP TABLE ${tableName}) plus DELETE FROM
# schedules / project_spaces. They are guarded, but they have not executed since
# the current generation was stamped, and a bump re-arms every one of them
# against every live DB in the fleet.
#
# And PRAGMA integrity_check CANNOT detect the damage: it reports page-level
# integrity and returns "ok" for a table that was rebuilt having silently lost
# rows. user_version = <new> only proves the script reached its last line.
#
# So: before ANY schema-bumping PR merges, run init-db against a COPY of each
# prod DB and diff sqlite_master + per-table COUNT(*) pre/post. Zero unexplained
# deltas is the merge gate. Never point this at a live DB — it always copies.
#
# USAGE:
#   scripts/schema-migration-dryrun.sh <label> <path-to-db> [<label> <db> ...]
#
# The whole fleet (run from crow; pull the remote DBs to local copies first):
#   scripts/schema-migration-dryrun.sh \
#     crow    ~/.crow/data/crow.db \
#     mpa     ~/.crow-mpa/data/crow.db \
#     grackle /tmp/grackle.db \
#     bswan   /tmp/bswan.db
#
# EXPECTED OUTPUT for a well-behaved additive migration: the only schema delta is
# your new column/table, user_version advances, and every row count is unchanged.
# ANY unexplained row-count delta or lost table is a STOP.
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILED=0

snapshot() { # $1=db  $2=out-prefix
  sqlite3 "$1" \
    "SELECT type||' '||name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY 1;" \
    > "$2.schema" 2>/dev/null
  : > "$2.counts"
  local t n
  for t in $(sqlite3 "$1" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;" 2>/dev/null); do
    n=$(sqlite3 "$1" "SELECT COUNT(*) FROM \"$t\";" 2>/dev/null || echo ERR)
    printf '%s\t%s\n' "$t" "$n" >> "$2.counts"
  done
}

dryrun_one() { # $1=label  $2=src-db
  local label="$1" src="$2"
  local work cp rc pre_uv post_uv integ
  if [ ! -f "$src" ]; then
    echo "════════ $label ════════"
    echo "  SKIP — no such DB: $src"
    return 0
  fi
  work="$(mktemp -d)"; cp="$work/crow.db"
  cp "$src" "$cp" || { echo "[$label] COPY FAILED"; FAILED=1; return 1; }

  snapshot "$cp" "$work/pre"
  pre_uv=$(sqlite3 "$cp" "PRAGMA user_version;")

  ( cd "$REPO_ROOT" && CROW_DB_PATH="$cp" node scripts/init-db.js ) > "$work/init.log" 2>&1
  rc=$?

  snapshot "$cp" "$work/post"
  post_uv=$(sqlite3 "$cp" "PRAGMA user_version;")
  integ=$(sqlite3 "$cp" "PRAGMA integrity_check;" | head -1)

  echo "════════ $label ════════"
  echo "  init-db exit=$rc   user_version: $pre_uv -> $post_uv   integrity: $integ"
  [ "$rc" -ne 0 ] && FAILED=1
  [ "$integ" != "ok" ] && FAILED=1

  echo "  ── schema objects added/removed ──"
  if diff "$work/pre.schema" "$work/post.schema" | grep -qE '^[<>]'; then
    diff "$work/pre.schema" "$work/post.schema" | grep -E '^[<>]' | sed 's/^/    /'
  else
    echo "    (none)"
  fi

  echo "  ── ROW-COUNT DELTAS (what integrity_check cannot see) ──"
  if join -t$'\t' "$work/pre.counts" "$work/post.counts" 2>/dev/null \
       | awk -F'\t' '$2!=$3 {print "    " $1 ": " $2 " -> " $3}' | grep -q .; then
    join -t$'\t' "$work/pre.counts" "$work/post.counts" \
      | awk -F'\t' '$2!=$3 {print "    " $1 ": " $2 " -> " $3}'
    echo "    ^^^ STOP — unexplained row loss"
    FAILED=1
  else
    echo "    (none — all preserved tables identical)"
  fi

  echo "  ── tables that DISAPPEARED ──"
  if comm -23 <(cut -f1 "$work/pre.counts" | sort) <(cut -f1 "$work/post.counts" | sort) | grep -q .; then
    comm -23 <(cut -f1 "$work/pre.counts" | sort) <(cut -f1 "$work/post.counts" | sort) | sed 's/^/    LOST: /'
    FAILED=1
  else
    echo "    (none)"
  fi

  [ "$rc" -ne 0 ] && { echo "  ── init-db errors ──"; tail -5 "$work/init.log" | sed 's/^/    /'; }
  rm -rf "$work"
}

[ $# -lt 2 ] && { grep '^# ' "$0" | sed 's/^# \?//' | head -32; exit 2; }
while [ $# -ge 2 ]; do dryrun_one "$1" "$2"; shift 2; echo; done

if [ "$FAILED" -eq 0 ]; then
  echo "✅ DRY-RUN GATE PASSED — no unexplained schema or row-count deltas."
  exit 0
fi
echo "❌ DRY-RUN GATE FAILED — do NOT merge the schema bump."
exit 1
