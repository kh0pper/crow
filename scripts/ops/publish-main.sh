#!/usr/bin/env bash
# Publish this box's `main` to origin so the pull-only auto-updater on every
# instance can actually converge. The auto-updater (servers/gateway/auto-update.js)
# only PULLs origin/main — nothing pushed crow's commits up, so origin/main went
# stale and the whole fleet sat behind it. This is the missing publish half.
#
# Safety: only pushes when local `main` is STRICTLY AHEAD of origin/main and the
# push is a clean fast-forward. If the two have diverged it logs and bails (a
# human should reconcile). Pushes the `main` ref directly, so it works no matter
# which branch is currently checked out. Auth uses the stored credential helper
# (git config credential.helper=store). Install via cron ONLY on the primary
# (do NOT run on peer instances — they'd fight over origin/main).
#
# See memory: crow-autoupdate-pull-only.
set -euo pipefail
REPO="${CROW_REPO:-/home/kh0pp/crow}"
cd "$REPO" || exit 0
ts() { date -Is; }

git fetch -q origin main 2>/dev/null || { echo "$(ts) fetch failed"; exit 0; }
LOCAL=$(git rev-parse main 2>/dev/null) || { echo "$(ts) no local main"; exit 0; }
REMOTE=$(git rev-parse origin/main 2>/dev/null) || { echo "$(ts) no origin/main"; exit 0; }

[ "$LOCAL" = "$REMOTE" ] && exit 0  # already published — quiet no-op

# Fast-forward only: origin/main must be an ancestor of local main.
if ! git merge-base --is-ancestor "$REMOTE" "$LOCAL"; then
  echo "$(ts) main diverged from origin/main (local=$LOCAL origin=$REMOTE) — manual reconcile needed, not pushing"
  exit 0
fi

echo "$(ts) publishing main ${REMOTE:0:9}..${LOCAL:0:9}"
git push origin main:main && echo "$(ts) pushed."
