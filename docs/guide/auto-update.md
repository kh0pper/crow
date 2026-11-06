---
title: Auto-Update
---

# Auto-Update

Crow includes a built-in auto-updater that checks for new versions, pulls changes, and restarts the gateway. No manual SSH or git commands required.

## How It Works

The auto-updater runs as a background task inside the gateway process:

1. **Fetch** — runs `git fetch origin main` to check for new commits
2. **CI gate** — checks the target commit's required CI results on GitHub
   (`suite`, `static-checks`, `audit`). A red build skips the update until the
   next regular check, and a still-running one is re-asked sooner; an origin that
   is not GitHub has no CI to ask
   and updates as before; a GitHub answer that cannot be read also skips it
   (see [The CI gate](#the-ci-gate)). Disable with `CROW_UPDATE_CI_GATE=0`.
3. **Quarantine check** — if this host already rolled a commit back, and that
   commit is still the head of `main`, the update is skipped (see
   [Automatic rollback](#automatic-rollback); a rollback taken for a machine-side
   reason expires after 6 hours, so it retries even if `main` never moves)
4. **Pull** — runs `git pull --ff-only origin main` (fast-forward only, no merge commits).
   Local changes are **not** stashed: `git pull` refuses only when the incoming
   diff overlaps a file you modified, and leaves every other local edit alone.
5. **Dependencies** — runs `npm install` if `package.json` or `package-lock.json` changed.
   If the install fails, the update stops right there and is rolled back: no import
   check, no migration, no restart (see [Automatic rollback](#automatic-rollback))
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

## The CI gate {#the-ci-gate}

Before pulling, the updater asks GitHub for the required check-runs of the very
commit it is about to deploy (`suite`, `static-checks`, `audit`). Both the
6-hourly tick and **Check for updates now** in Settings > Updates go through the
same gate, so the manual button cannot bypass it.

When GitHub answers, the answer decides:

| Answer | What happens |
|---|---|
| all three green | the update proceeds |
| any of them red | skipped, retried on the next regular check — only a *still-running* CI run is re-asked sooner (see below) |
| any of them still running | skipped, but re-checked about 30 minutes later instead of waiting the whole interval |
| some of the three missing, nothing still running | skipped as **no CI** (see below): the missing checks will never report on this origin — **green needs all three**, so a sha where only `audit` ran is never deployed and never reads "still running" |
| no run for our three checks | skipped as **no CI**: an unverified commit is never deployed. A push that raced the check answers on the next regular check — not a 30-minute retry, which only a still-running run earns; a fork that strips those checks keeps being skipped instead |

**No CI.** GitHub answered, but without all three required checks — typically a
fork that does not carry this repo's CI, or a push whose workflows have not
registered yet. The commit is unverified, so this tick is skipped with its own
message, naming the missing checks:

```
Skipped: origin/main has none of the required CI checks (1a2b3c4d5; a fork without this repo's CI?) — not deploying an unverified commit; set CROW_UPDATE_CI_GATE=0 to update without the gate
Skipped: origin/main has only some of the required CI checks (1a2b3c4d5; missing audit — a fork without this repo's full CI?) — not deploying an unverified commit; set CROW_UPDATE_CI_GATE=0 to update without the gate
```

It is recorded as a transient result, so it never rings the bell; if it repeats
past two check intervals the Nest's Updates card warns that the required checks
didn't all run on main. `CROW_UPDATE_CI_GATE=0` is the way out.

**A verdict that is not known yet is not a verdict.** While GitHub reports a
required check as still running, the updater asks again about 30 minutes later
(plus a small per-machine offset), and keeps asking while CI is still running. It
stops after `ceil(interval / 30 min) - 1` retries, so a retry can never run past
the next regular check, and it stops immediately when any other answer arrives.
Only a *running* CI run earns that retry: a red result, a commit without the
required checks, and GitHub being unreachable all wait for the regular interval.
An outage must not be re-asked every 30 minutes — each unreadable tick counts
toward the 3-in-a-row bell below, so a fast retry would ring it after about an
hour instead of after three regular checks.

Two outcomes are *not* a CI result:

**Not applicable.** The origin is not GitHub — a bare repository on disk, or
another host — so there is no CI to ask and the gate can never apply. The update
proceeds exactly as it always has, the log says

```
[auto-update] CI gate not applicable (origin is not GitHub)
```

and the Nest's Updates card carries one info line saying updates are not
CI-gated for this origin. That line stays visible between checks: an up-to-date
tick re-reads the origin locally and records not applicable again (only a
GitHub origin clears it), so the notice does not depend on catching the one tick
that pulled.

**Unavailable.** The origin *is* GitHub and no answer could be read: a network
failure, a timeout, a `403`/`429` rate limit, any other non-200 response, or a
body that is not valid JSON. The commit is unverified, so this tick is **skipped**
just like a running build — nothing is pulled, so the code on disk keeps running —
but it waits for the next regular check instead of earning a 30-minute retry:

```
Skipped: CI status could not be read for origin/main (1a2b3c4d5) — will retry next tick
```

The first two unreadable ticks in a row are transient, so a short GitHub outage
stays quiet. The third in a row is recorded as a failure and rings the
notification bell once (its 24-hour per-code cooldown keeps it to one):

```
Skipped: CI status unreadable for 3 checks in a row — updates are paused until GitHub answers (or set CROW_UPDATE_CI_GATE=0)
```

Any other answer — green, red, running, or not applicable — resets that count,
so an outage that clears needs no action. If this machine can never reach
GitHub's API (an offline install whose origin is still a GitHub URL), set
`CROW_UPDATE_CI_GATE=0` in the unit's environment and restart Crow: the gate is
then skipped entirely.

## Local changes

An instance with local modifications (a development machine, or a hand-edited
config file) needs no special handling:

1. The updater never stashes or discards anything. It runs `git pull --ff-only`,
   which refuses only when the incoming diff overlaps a file you modified.
2. Every other local edit survives the update untouched.
3. A refused pull is reported in Settings > Updates (`Pull failed …`) and retried
   on the next regular check — the ~30-minute re-check is only for a CI run that
   is still in progress (see [The CI gate](#the-ci-gate)). Commit, revert or stash
   the overlapping file to let the update through.

There is no stash/pop cycle any more: a stash that failed to reapply used to
leave the checkout clean but the operator's work parked in `git stash list`.

## Automatic rollback

An update that cannot start is worse than a late update: systemd restarts a
crashing gateway every few seconds, so the fix on `main` is never even fetched.
Crow therefore checks the pulled code **before** committing to it.

**Layer 0 (this release).** After the pull, the updater installs dependencies
first: if `npm install` exits non-zero, the update is abandoned at that point —
no import check, no `init-db`, no restart — because the checks that follow would
be judging a tree whose dependencies nobody installed, and the migration would
run for a commit that may never start. The rollback steps below apply to it too,
with `deps-failed` as the recorded reason.

Then, and *before* `init-db` runs, the updater launches the pulled
`servers/gateway/index.js` in a child process with `CROW_GATEWAY_IMPORT_CHECK=1`,
using the environment the unit actually configures. That file answers with a
one-line token and exit code 0 as its very first statement, which proves the
entire static import graph loaded. On a clean non-zero exit, a timeout (60 s), or
a missing token, the updater:

1. writes `<git-dir>/crow-update-quarantine.json` naming the commit — so no
   instance on this checkout pulls it again;
2. moves the checkout back with `git reset --keep <previous>`, which refuses
   rather than destroying local changes that overlap;
3. reinstalls dependencies if they changed, and
4. records `Rolled back: …` in Settings > Updates — `… fails to load (…)` for a
   commit that cannot load, `… — npm install failed` for one whose dependencies
   could not be installed — and rings the notification bell.

Nothing restarts into the bad commit. A commit whose code does not load stays
quarantined until `main` moves past it; a rollback taken for a machine-side
reason (a timeout, a failed `npm install`, a failed `init-db` that changed
nothing) also expires after 6 hours. Neither applies to the marker a *blocked*
rollback leaves behind (the checkout still holds the refused commit): that marker
is never deleted and never times out, so `main` moving on does not unfreeze it
either — the next restart or reboot would boot exactly that commit. If `git reset
--keep` refuses because local changes overlap, the restart is withheld, the
result says `Update rollback blocked`, and the marker is re-written WITHOUT an
expiry — the checkout is still holding the bad commit, so a later check reports
it instead of `Up to date`, and the next restart or reboot would boot it. As soon
as the checkout no longer holds that commit (move `main` back by hand, for
example) the marker is back to an ordinary one: a machine-side reason (the
dependencies never installed) expires 6 hours after it was written and that same
commit is retried, and one whose code does not load waits for `main` as usual.
Nothing has to be deleted by hand. A marker a rollback that *succeeded* wrote is
ordinary from the start: if you fix the cause and put that same commit on `main`
yourself (a manual `git pull --ff-only`), the marker expires as usual and `main`
moving on clears it, so it cannot freeze updates.

`init-db` failing after a pull is only rolled back when nothing about the new
code can have reached the database: the pull must not cross a schema generation,
`scripts/init-db.js` must be byte-identical in both commits, the database must
still be readable, and `user_version` must not have advanced. Otherwise the
tree is left where it is and the alert says so.

Every co-hosted instance sharing the checkout honors the same marker: none of
them migrates or restarts into a commit a blocked rollback left checked out —
not even once its 6 hours have passed, as long as the checkout still holds that
commit — and each one separately verifies that *its own* environment can load
the tree before migrating.

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

**A rejection that cannot clear by itself is not retried.** When the guard
refuses because the database moved ahead (`user_version`), because
`scripts/init-db.js` changed, or because an applied migration does not declare
that the previous code can run on the new shape, nothing you can do in the
gateway will change the answer: the guard leaves `main` where it is, keeps the
alert and the `STATUS` file, quarantines the commit so no instance pulls it
again, and does **not** re-arm the same commit on the next
start — otherwise it would boot the failing commit three more times per cycle
for nothing. The other refusals (no proven previous commit, a checkout that is
not on `main`, a read-only checkout, an `index.lock`) can clear on their own, so
these are re-checked on the next start. A rollback always compares the failing
commit with the last commit that ran stably for ten minutes, not with the commit
just before it, so after a refusal-class change is fixed forward, later crashes
stay refusable until that fix has itself run stably for ten minutes. A refusal's
cause may not be the commit itself (a database left ahead by something else), so
the quarantine is not permanent: once the instance that refused it has itself run
that commit stably for ten minutes, it rewrites the marker as an ordinary one,
and a newer commit on `main` is pulled normally. A co-hosted instance that never
refused it cannot clear it that way — a refusal belongs to the instance that
refused.

**Recovering from a refusal.** The alert and `~/.crow/boot-guard/STATUS` carry
the exact steps for the case that fired. In general (`CROW_APP` is your checkout:
`~/.crow/app` for an installer setup, or wherever you cloned the repo):

```bash
# 1. Stop the loop.
sudo systemctl stop crow-gateway

# 2. Only a schema-generation crossing (user_version above what the previous
#    commit expects) takes a backup, and the alert names that exact file:
#    restore it — the migration guard took it BEFORE touching git. Every other
#    kind of change took none, so the alert names the directory the guard's
#    earlier backups are in but gives no restore step: those belong to earlier
#    migrations, not to this one. Registry migrations take no backup.
ls "$HOME/.crow/data/backups/migrations"

# 3. Move main back to a commit you know starts, keeping unrelated local edits.
CROW_APP="${CROW_APP:-$HOME/.crow/app}"
cd "$CROW_APP"
git log --oneline -5
git reset --keep <that-commit>

# 4. Start it again.
sudo systemctl start crow-gateway
```

Do not `git checkout <commit>`: that detaches HEAD, the updater then skips every
check with `Skipped: not on main`, and updates stop silently.

**What this protects against.** The guard is a defence against *accidental* bad
commits: an import that throws, a syntax error, a dependency that will not
start. It is **not** a defence against a deliberately malicious commit. Such a
commit runs as the service user, exactly like the gateway, so it can rewrite
`~/.crow/boot-guard/crow-boot-guard.mjs`, the state file next to it, or this
repository's `.git/config` before the next start. The launcher's isolation
(`core.hooksPath=/dev/null`, `GIT_*` stripped, no tree code imported) exists so
that an honest bad commit's hooks and modules cannot run during the reset — it
buys nothing against an attacker. Treat write access to `main` as equivalent to
a shell as the service user.

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

If you prefer to update manually (`CROW_APP` is your checkout: `~/.crow/app` for
an installer setup, or wherever you cloned the repo):

```bash
CROW_APP="${CROW_APP:-$HOME/.crow/app}"
cd "$CROW_APP"
git pull --ff-only origin main
npm install --omit=dev
node scripts/guarded-init-db.mjs   # guarded migration: backup first, restore on data loss
sudo systemctl restart crow-gateway
```

`node scripts/guarded-init-db.mjs` uses the same guard the updater uses: it takes
a pre-migration backup, classifies the result for data loss and restores the
backup if the migration damaged the store. `npm run init-db` still
exists, but it is the bare, unguarded run with no backup — use it only on a
scratch database, never on one you care about.

`bash "$CROW_APP/scripts/crow-update.sh"` does the same sequence in one step and
goes further: it verifies the new code actually answers `/health` and rolls back
with `git reset --keep` if it does not.

Or trigger a one-time check from the Settings page without enabling automatic checks.

## Rollback

If an update causes issues, roll back **on `main`** (`CROW_APP` is your checkout:
`~/.crow/app` for an installer setup, or wherever you cloned the repo):

```bash
CROW_APP="${CROW_APP:-$HOME/.crow/app}"
cd "$CROW_APP"
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
[auto-update] CI gate not applicable (origin is not GitHub)
[auto-update] Dependencies changed — running npm install...
[auto-update] import check unavailable in 1a2b3c4d5 (no CROW_GATEWAY_IMPORT_CHECK seam) — relying on the boot guard
[auto-update] Running database migrations...
[auto-update] Updated: c29e19c → 9d18049
[auto-update] Restarting to run 9d18049...
```

A rollback reads:

```
[auto-update] Rolled back: 9d18049 fails to load (import-check); running c29e19c; updates resume when main moves past it
[auto-update] Rolled back: 9d18049 — npm install failed; running c29e19c; retried after 6 h or when main moves
```

If the rollback's OWN `npm install` fails, the result (and the notification) carry
one more clause — install before the next restart, because `node_modules` may be
half-written even though the old code keeps running from memory:

```
; its dependencies could not be reinstalled — run npm install --omit=dev in the checkout before the next restart
```

A failed `npm install` logs its exit code and the tail of npm's own output (which
is why it stays in the log and never in the notification):

```
[auto-update] npm install failed (exit 1): npm ERR! …
```

Update results are also saved to the database and visible in Settings > Updates.

## System updates {#system-updates}

Everything above is about **Crow's own code**. The machine underneath is kept
patched too: the installer turns on `unattended-upgrades`, so Debian/Ubuntu
security updates install themselves once a day, and adds the repositories Crow
installed to the same run. "System" here means exactly what the distribution's
own unattended-upgrades configuration counts as a security archive — Crow
neither narrows nor widens it.

### What the installer turns on

| What it covers | Origin |
|---|---|
| Node.js (NodeSource) | `origin=. nodistro,codename=nodistro` |
| Docker Engine and its packages | `origin=Docker,archive=${distro_codename}` |
| Caddy | `origin=cloudsmith/caddy/stable,codename=any-version` |

The three origins live in Crow's own file,
`/etc/apt/apt.conf.d/52crow-unattended-upgrades`. The distribution's
`50unattended-upgrades` is never edited, and its own security origins stay
exactly as they were: Crow only adds to them. `/etc/apt/apt.conf.d/20auto-upgrades`
turns the daily run on, and is written only when it does not exist yet — a host
that already configured unattended-upgrades keeps its own settings. Re-running
the installer rewrites Crow's file only when its content differs.

### Reboots are never automatic

`Unattended-Upgrade::Automatic-Reboot` is set to `"false"`. When an update needs
a reboot, the Crow's Nest shows a **System updates** card saying a reboot is
needed, with the packages that asked for it (up to ten names). Restart when it
suits you:

```bash
sudo reboot
```

The same card says whether the daily run is still on and when it last ran, so a
timer that stopped shows up as "security updates last ran N days ago" instead of
silence. On a fresh install it says the run has not happened yet until its first
day passes — that is not an error. It also lists the installed Node and Docker
versions — as information only, without looking up the newest release.

### Services can restart briefly

A Node, Docker or Caddy security update replaces the package. Docker and Caddy
restart their own service as part of that, so the dashboard can be unreachable
for a few seconds while it happens. Restarting `dockerd` stops **every**
container on the machine; only the containers with a restart policy come back,
and Crow's bundles use `restart: unless-stopped`, so they do. Crow itself is not
restarted by these updates — [Auto-Update](#auto-update) handles Crow's code. A
Node update only takes effect once the gateway is restarted, so apply it with
`sudo systemctl restart crow-gateway` when it suits you.

### Turning automatic updates off {#turning-off}

Two different things can be turned off: whether the daily run happens at all,
and whether it also covers the repositories Crow added.

- **Install without it:** pass the opt-out to the installer. The documented
  one-liner sends the script to bash on stdin, so the option goes to bash
  itself:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | bash -s -- --no-auto-updates
  curl -fsSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | CROW_NO_AUTO_UPDATES=1 bash
  ```

  Nothing under `/etc/apt/apt.conf.d` is changed: neither
  `52crow-unattended-upgrades` nor `20auto-upgrades` is written. The other
  install steps still add their repository sources and keyrings (NodeSource in
  `/etc/apt/sources.list.d`, the Caddy keyring in `/usr/share/keyrings`), so apt
  keeps offering those packages — nothing installs them on its own.

  With a downloaded copy the same two options work: `bash crow-install.sh --no-auto-updates`
  or `CROW_NO_AUTO_UPDATES=1 bash crow-install.sh`.

- **Drop Crow's extra origins:** `sudo rm /etc/apt/apt.conf.d/52crow-unattended-upgrades`.
  This only removes Crow's additions: Node, Docker and Caddy stop updating
  themselves, while the daily run stays on and the distribution's own security
  updates keep installing themselves.

- **Stop the daily run:** set the switch to off in `/etc/apt/apt.conf.d/20auto-upgrades`:

  ```
  APT::Periodic::Unattended-Upgrade "0";
  ```

  or run `sudo dpkg-reconfigure unattended-upgrades` and answer *No*. This turns
  every automatic run off, Crow's extra origins included.

Once automatic updates are off, the Nest's **System updates** card says so and
links back here. It never claims the machine is current while nothing is
checking.