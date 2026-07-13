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
# prod DB and diff sqlite_master + per-table COUNT(*) + per-table COLUMNS
# (PRAGMA table_info) pre/post. Zero unexplained deltas is the merge gate.
# Never point this at a live DB — it always copies.
#
# The column diff is what proves an additive migration actually HAPPENED:
# ADDED columns are reported informationally (an ALTER TABLE ADD COLUMN
# migration is EXPECTED to add its column — not a failure); a REMOVED column
# means a table was rebuilt narrower and is a STOP (gate fails).
#
# USAGE:
#   scripts/schema-migration-dryrun.sh <label> <path-to-db> [<label> <db> ...]
#
# ENV:
#   DRYRUN_INIT_SCRIPT — the migration script to run against each copy
#     (absolute path, or relative to the repo root). Default: scripts/init-db.js.
#     Exists as a testability seam; production use should leave it unset.
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
INIT_SCRIPT="${DRYRUN_INIT_SCRIPT:-scripts/init-db.js}"
FAILED=0

snapshot() { # $1=db  $2=out-prefix
  sqlite3 "$1" \
    "SELECT type||' '||name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY 1;" \
    > "$2.schema" 2>/dev/null
  : > "$2.counts"
  : > "$2.columns"
  local t n
  # while-read, not `for t in $(...)`: an unquoted expansion word-splits table
  # names containing whitespace, silently dropping them from BOTH snapshots —
  # a false PASS on exactly the tables the diff exists to protect.
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    n=$(sqlite3 "$1" "SELECT COUNT(*) FROM \"$t\";" 2>/dev/null || echo ERR)
    printf '%s\t%s\n' "$t" "$n" >> "$2.counts"
    sqlite3 "$1" "PRAGMA table_info(\"$t\");" 2>/dev/null \
      | awk -F'|' -v t="$t" '{printf "%s\t%s\t%s\n", t, $2, $3}' >> "$2.columns" \
      || printf '%s\t__PRAGMA_ERR__\t__PRAGMA_ERR__\n' "$t" >> "$2.columns"
  done < <(sqlite3 "$1" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;" 2>/dev/null)
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

  ( cd "$REPO_ROOT" && CROW_DB_PATH="$cp" node "$INIT_SCRIPT" ) > "$work/init.log" 2>&1
  rc=$?

  snapshot "$cp" "$work/post"
  post_uv=$(sqlite3 "$cp" "PRAGMA user_version;")
  integ=$(sqlite3 "$cp" "PRAGMA integrity_check;" | head -1)

  echo "════════ $label ════════"
  # Always name the script that ran — a stale exported DRYRUN_INIT_SCRIPT must
  # never be able to substitute a different migration with no visible signal.
  echo "  init script: $INIT_SCRIPT"
  if [ -n "${DRYRUN_INIT_SCRIPT:-}" ]; then
    echo "  ⚠⚠ NON-DEFAULT INIT SCRIPT (DRYRUN_INIT_SCRIPT is set) — this is NOT a real init-db gate run"
  fi
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

  echo "  ── COLUMNS added/removed per table ──"
  local added_cols removed_cols
  sort "$work/pre.columns" > "$work/pre.columns.sorted"
  sort "$work/post.columns" > "$work/post.columns.sorted"
  added_cols=$(comm -13 "$work/pre.columns.sorted" "$work/post.columns.sorted")
  removed_cols=$(comm -23 "$work/pre.columns.sorted" "$work/post.columns.sorted")
  if [ -n "$added_cols" ]; then
    # Informational: an additive migration is EXPECTED to add its column.
    printf '%s\n' "$added_cols" | awk -F'\t' '{print "    + " $1 "." $2 " (" $3 ")"}'
  fi
  if [ -n "$removed_cols" ]; then
    printf '%s\n' "$removed_cols" | awk -F'\t' '{print "    - " $1 "." $2 " (" $3 ")"}'
    echo "    ^^^ STOP — column(s) REMOVED or CHANGED (name/type differs from source — verify before assuming data loss)"
    FAILED=1
  fi
  if [ -z "$added_cols" ] && [ -z "$removed_cols" ]; then
    echo "    (none)"
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

[ $# -lt 2 ] && { grep '^# ' "$0" | sed 's/^# \?//' | head -44; exit 2; }
while [ $# -ge 2 ]; do dryrun_one "$1" "$2"; shift 2; echo; done

if [ "$FAILED" -eq 0 ]; then
  echo "✅ DRY-RUN GATE PASSED — no unexplained schema or row-count deltas."
  exit 0
fi
echo "❌ DRY-RUN GATE FAILED — do NOT merge the schema bump."
exit 1
