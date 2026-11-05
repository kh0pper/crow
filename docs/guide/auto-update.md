---
title: Auto-Update
---

# Auto-Update

Crow includes a built-in auto-updater that checks for new versions, pulls changes, and restarts the gateway. No manual SSH or git commands required.

## How It Works

The auto-updater runs as a background task inside the gateway process:

1. **Fetch** — runs `git fetch origin main` to check for new commits
2. **CI gate** — checks the target commit's required CI results on GitHub
   (`suite`, `static-checks`, `audit`). A red or still-running build skips the
   update until the next check; forks without those CI checks are unaffected.
   Disable with `CROW_UPDATE_CI_GATE=0`.
3. **Quarantine check** — if this host already rolled a commit back, and that
   commit is still the head of `main`, the update is skipped (see
   [Automatic rollback](#automatic-rollback))
4. **Pull** — runs `git pull --ff-only origin main` (fast-forward only, no merge commits).
   Local changes are **not** stashed: `git pull` refuses only when the incoming
   diff overlaps a file you modified, and leaves every other local edit alone.
5. **Dependencies** — runs `npm install` if `package.json` or `package-lock.json` changed
6. **Import check** — loads the pulled gateway's whole import graph in a short-lived
   child process. If it does not load, the update is rolled back before it is ever
   started (see [Automatic rollback](#automatic-rollback))
7. **Migrations** — runs `node scripts/init-db.js` for any schema changes, wrapped in
   the migration guard (automatic pre-migration backup + data-loss protection — see
   the [database recovery guide](../developers/db-recovery.md))
8. **Restart** — gracefully closes the HTTP server and exits so systemd restarts the process

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-update enabled | Yes | Toggle in Settings > Updates |
| Check interval | 6 hours | How often to check for new versions |

### Settings page

Go to **Settings > Updates** in the Crow's Nest to:

- Enable or disable auto-update
- See the current version (git commit hash)
- See when the last check ran and what it found
- Manually trigger an update check

## Local changes

An instance with local modifications (a development machine, or a hand-edited
config file) needs no special handling:

1. The updater never stashes or discards anything. It runs `git pull --ff-only`,
   which refuses only when the incoming diff overlaps a file you modified.
2. Every other local edit survives the update untouched.
3. A refused pull is reported in Settings > Updates (`Pull failed …`) and retried
   on the next check. Commit, revert or stash the overlapping file to let the
   update through.

There is no stash/pop cycle any more: a stash that failed to reapply used to
leave the checkout clean but the operator's work parked in `git stash list`.

## Automatic rollback

An update that cannot start is worse than a late update: systemd restarts a
crashing gateway every few seconds, so the fix on `main` is never even fetched.
Crow therefore checks the pulled code **before** committing to it.

**Layer 0 (this release).** After the pull and `npm install`, and *before*
`init-db` runs, the updater launches the pulled `servers/gateway/index.js` in a
child process with `CROW_GATEWAY_IMPORT_CHECK=1`, using the environment the unit
actually configures. That file answers with a one-line token and exit code 0 as
its very first statement, which proves the entire static import graph loaded. On
a clean non-zero exit, a timeout (60 s), or a missing token, the updater:

1. writes `<git-dir>/crow-update-quarantine.json` naming the commit — so no
   instance on this checkout pulls it again;
2. moves the checkout back with `git reset --keep <previous>`, which refuses
   rather than destroying local changes that overlap;
3. reinstalls dependencies if they changed, and
4. records `Rolled back: <sha> fails to load (…)` in Settings > Updates and
   rings the notification bell.

Nothing restarts into the bad commit. A commit whose code does not load stays
quarantined until `main` moves past it; a rollback taken for a machine-side
reason (a timeout, a failed `npm install`, a failed `init-db` that changed
nothing) also expires after 6 hours. If `git reset --keep` refuses because local
changes overlap, the quarantine stays, the restart is withheld, and the result
says `Update rollback blocked` — including the case where the checkout is still
holding the bad commit, so the next restart or reboot would boot it.

`init-db` failing after a pull is only rolled back when nothing about the new
code can have reached the database: the pull must not cross a schema generation,
`scripts/init-db.js` must be byte-identical in both commits, the database must
still be readable, and `user_version` must not have advanced. Otherwise the
tree is left where it is and the alert says so.

Every co-hosted instance sharing the checkout honors the same marker: none of
them migrates or restarts into a quarantined commit, and each one separately
verifies that *its own* environment can load the tree before migrating.

### Layer 1: the boot guard {#boot-guard}

Layer 0 can only see crashes that happen while a healthy process is still
running. Anything behind a dynamic import, or a failure that only appears under
the service manager's environment, can still loop forever. The boot guard is the
backstop, and it runs **outside** the gateway's module graph.

**How it is wired.** The service unit gets two extra commands (a drop-in,
`10-boot-guard.conf`): one *before every start*, including every automatic
restart, and one *after every stop*. The script they run is not the copy in your
checkout — it lives in `~/.crow/boot-guard/crow-boot-guard.mjs` and is refreshed
only by a gateway that has already been up for ten minutes. A commit whose code
cannot start therefore can never replace the thing that judges it.

**What it does.**

- Every start is recorded. An exit is counted as a crash only when it really is
  one: a non-zero exit (other than 78, which means "this instance's paths are
  refused"), a core dump, or a signal other than TERM/INT/HUP/KILL. A restart
  Crow asked for (an update, a bundle install, `systemctl restart`) never counts,
  and neither does running out of memory — that is usually the machine, so it
  gets one notification instead. (If your unit starts the gateway through
  `npm run gateway`, the exit status the guard sees describes npm rather than
  node; npm passes a killed node on as a non-zero exit, which the guard counts.)
- After **three** counted crashes, the next start (the fourth) moves `main` back
  to the last commit this host proved it could boot, writes the quarantine marker
  so no instance pulls the bad commit again, reinstalls dependencies if they
  changed, and leaves the previous code running. You get one alert, and Settings
  → Updates shows `Rolled back: …`.
- It arms itself: after a manual `git pull` and restart it will guard the new
  commit too, but **only** for commits that are already on `origin/main` and
descend from the last healthy one. Your own unpushed commits on `main` are never
  rolled back.
- If two Crow instances share one checkout, exactly one of them moves the tree;
  the other notices and reports `Rolled back: … a co-hosted instance rolled it back`.

**What it refuses** (nothing is changed in any of these cases):

| Situation | Why |
|---|---|
| No record of a commit that booted healthily | it cannot know what to move back to |
| The checkout is not on `main` | resetting would detach HEAD and stop all updates |
| The previous commit is not an ancestor of the failing one | moving back would drop commits |
| The checkout is read-only for this instance | the instance that pulls it must roll back |
| A `git index.lock` exists | another git command is running; the guard never deletes it |
| The database moved ahead: `user_version` is past what the previous commit expects | its migrations may not be reversible |
| `scripts/init-db.js` changed between the two commits | it rebuilds tables without bumping the schema generation |
| A database migration ran that does not declare it is safe to run the old code on the new shape | older code may not understand the data |

**Recovering from a refusal.** The alert and `~/.crow/boot-guard/STATUS` carry
the exact steps for the case that fired. In general:

```bash
# 1. Stop the loop.
sudo systemctl stop crow-gateway

# 2. If the alert says the database moved (a schema generation, an init-db
#    change, or a migration that is not rollback-safe), put back the backup the
#    migration guard took BEFORE touching git.
ls ~/backups/crow            # or wherever your backup directory is

# 3. Move main back to a commit you know starts, keeping unrelated local edits.
cd ~/crow
git log --oneline -5
git reset --keep <that-commit>

# 4. Start it again.
sudo systemctl start crow-gateway
```

Do not `git checkout <commit>`: that detaches HEAD, the updater then skips every
check with `Skipped: not on main`, and updates stop silently.

**Installing it.** New installs get it automatically. For an existing host, run
`sudo scripts/ops/install-boot-guard.sh` from the checkout (or
`scripts/ops/install-boot-guard.sh --user` for a user unit); it writes a drop-in
per gateway unit and copies the launcher, takes effect at the next start, and
never restarts anything itself. The Docker image is not covered: it has no
`.git`, so nothing is ever pulled there and there is nothing to roll back.

If the drop-in is present but the guard does not run (a moved `node`, a deleted
launcher copy), the Crow's Nest shows a "The boot guard did not run" card on the
next boot instead of failing silently.

## Graceful Restart

When the auto-updater (or a bundle install) triggers a restart, it:

1. Emits a `crow:shutdown` event to close the HTTP server's listening socket
2. Waits 1 second for the socket to release
3. Exits with code 1 so systemd's `Restart=on-failure` brings the service back up

This prevents the common `EADDRINUSE` error where the new process starts before
the old one has released the port.

## Manual Update

If you prefer to update manually:

```bash
cd ~/crow
git pull origin main
npm install
npm run init-db
sudo systemctl restart crow-gateway
```

Or trigger a one-time check from the Settings page without enabling automatic checks.

## Rollback

If an update causes issues, roll back **on `main`**:

```bash
cd ~/crow
git log --oneline -5             # Find the previous commit
git reset --keep <commit-hash>   # Move main back, keeping unrelated local edits
sudo systemctl restart crow-gateway
```

Use `reset`, never `checkout`: `git checkout <commit>` detaches HEAD, the
checkout is no longer "on main", and the auto-updater then skips **every** check
with `Skipped: not on main` — updates stop silently until someone moves the
branch back.

`git reset --keep` refuses if the commit you are moving to differs in a file you
have modified; commit, stash or revert that file first. The auto-updater only
uses fast-forward pulls, so `git reflog` always has the previous state.

If you rolled back because a commit did not start, also write the quarantine so
no instance re-pulls it:

```bash
printf '{"v":1,"sha":"<bad-sha>","previous":"<good-sha>","reason":"manual","at":"%s","by":"operator"}\n' \
  "$(date -Iseconds)" > "$(git rev-parse --absolute-git-dir)/crow-update-quarantine.json"
```

The marker lives in the git dir, not in `.git/` by name: in a linked worktree the
git dir is elsewhere, and `git rev-parse --absolute-git-dir` is the path the
updater itself uses.

## Logs

Update activity is logged to the gateway's stdout (visible in `journalctl -u crow-gateway`):

```
[auto-update] Enabled — checking every 6h
[auto-update] 3 new commit(s) available. Updating...
[auto-update] Dependencies changed — running npm install...
[auto-update] import check unavailable in 1a2b3c4d5 (no CROW_GATEWAY_IMPORT_CHECK seam) — relying on the boot guard
[auto-update] Running database migrations...
[auto-update] Updated: c29e19c → 9d18049
[auto-update] Restarting gateway via systemd...
```

A rollback reads:

```
[auto-update] Rolled back: 9d18049 fails to load (import-check); running c29e19c; updates resume when main moves past it
```

Update results are also saved to the database and visible in Settings > Updates.