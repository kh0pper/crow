# Crow Workspace W1 (Platform) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `workspace` store extension (Nextcloud + MariaDB + Redis + ONLYOFFICE + cron). On crow it installs with only an admin password typed, configures itself, shows a phone-setup page, and backs itself up nightly, encrypted, to the external drive. No secret ever appears in a process's argv, a second Crow instance on the same host can never take over its containers, and maintenance mode is always recovered out of process.

**Architecture:** Three generic installer features land first, and every bundle benefits from them:

1. **Secrets and env scoping.** `env_vars[].generate: "secret"` makes the installer mint internal secrets, keep them across reinstall, and write every bundle `.env` at mode 600. `propagate: false`, `pattern` and `install_required` scope and validate operator input.
2. **Lifecycle hooks.** A first-party `postInstall` hook runs in its own process group, with a minimal env, after the install is recorded. `docker.precreate` creates host data folders first, and `docker.pull_timeout_s` is an opt-in long pull.
3. **Compose-project ownership guard.** It refuses to `up`/`start`/`stop`/`down` containers that another Crow install on the host owns.

The `workspace` bundle sits on top of them:
- a pinned, loopback-only compose file on a pinned subnet;
- an idempotent `ops/bootstrap.sh` that passes every secret over **stdin**, scrubs the human admin password after first use, and keeps the retained-secrets copy in sync;
- a streaming gpg backup with `ExecStopPost` recovery and alerts;
- a server-rendered en/es setup page.

Before anything merges, an attended, deadman-guarded smoke window on crow exercises every unverified assumption. A registered acceptance window closes it out after merge.

**Tech Stack:** Node 24 (gateway, `node:test`), bash + `docker compose` + Nextcloud `occ`, gpg 2.4 (symmetric AES256), systemd user units, Tailscale Serve.

**Spec:** `docs/superpowers/specs/2026-10-02-crow-workspace-design.md` (§4 = W1). It is binding: where this plan and the spec disagree, the spec wins, and any deviation is listed under Rulings.

**Review:** this is revision 3. Revision 2 addressed `~/crow-weekend-push/reports/workspace-w1-plan-review.md` (C1–C4, S1–S16) and Kevin's answers. Revision 3 fixes `workspace-w1-plan-rereview.md` R1 (the ownership guard: the real compose project name, refusing only another Crow install of the same bundle) and R2 (smoke helpers become named units with `RuntimeMaxSec`), and applies every minor note. Anything not adopted is marked with its own ruling.

## Rulings (where the spec is silent; each grounded in evidence gathered 2026-10-02)

1. **Host ports: `127.0.0.1:3070` (Nextcloud) and `127.0.0.1:3071` (ONLYOFFICE). Serve HTTPS ports: `8456` → 3070 and `8457` → 3071.** Evidence that these are free:
   - not in `docs/developers/port-allocation.md`;
   - not in any of the 2,143 compose files under `/home/kh0pp` (depth 5);
   - not in live `ss -ltn`;
   - not in `tailscale serve status`, which shows 8444–8446 and 8448–8455 plus 12393.

   The smoke window (Task 8) uses scratch values: 13070/13071 and Serve 8458/8459/8460, plus subnet 10.89.71.0/24; ruling 18 covers why scratch restore needs its own subnet. All of them were verified free the same way.
2. **Pinned images** (Docker Hub API, 2026-10-02). They are recorded in the compose file, which image-freshness reads, and mirrored in `manifest.images`; a test keeps the two equal.
   - `nextcloud:34.0.4-apache`: same digest as `stable-apache`, `37b10988…`.
   - `mariadb:11.8.9`: the version Nextcloud stable34's system_requirements recommends.
   - `redis:8.2.10-alpine`.
   - `onlyoffice/documentserver:9.4.0.1`: same digest as `latest`, `3ab6ebc7…`.
3. **The generic secret generator** (config-friction F1).
   - Manifest field: `env_vars[].generate: "secret"`. The value is 32 random bytes, base64url, 43 chars, with no `$`, quote or space characters.
   - Values are never regenerated on reinstall. The order is: installed `.env`, then the retained copy at `${CROW_HOME}/secrets/bundle-env/<id>.env` (dir 700, file 600, never deleted by uninstall), then a new value.
   - Generated keys are hidden from the forms, ignored if a request sends them, never install-blocking, and never propagated to the gateway `.env`.
4. **Every bundle `.env` is mode 600:**
   - written as a 600 temp file, then renamed (S10: never briefly world-readable);
   - the same on Configure;
   - plus a one-shot `chmod 600` of every installed bundle `.env` in `repairInstalledBundleAssets` at boot, which fixes today's 644/777 `phone`/`media` files.

   No shipped bundle bind-mounts its own `.env`.
5. **`propagate: false`** keeps a declared var out of the gateway `.env`. **`pattern`** (an anchored regex) is enforced with a 400 `invalid_env` before anything is written.
   - **`install_required: true`** makes a key install-blocking even when the compose file does not consume it. That is how the admin password stays mandatory after C4 removed it from compose.
   - `installBlockingEnvKeys` feeds both the server gate and the client gate (the consent-challenge `install_required` list).
6. **The admin password is checked before install and scrubbed after first use** (Kevin Q2; re-review minor 3).
   - Before install, a generic `env_vars[].check: "not_breached"` runs the same Have I Been Pwned check that Nextcloud's `password_policy` enforces by default. It uses k-anonymity: only the first 5 hex chars of the SHA-1 leave the machine. If the service is offline, there is no verdict. The pattern's 12-character minimum already exceeds the policy's default 10.
   - If Nextcloud still refuses the password, bootstrap dies with an exact recovery message and keeps the password line, so nothing is lost. That step runs before tailnet detection. The human password never enters a container:
   - Compose gives the Nextcloud entrypoint a *generated throwaway* first-run password, `WORKSPACE_FIRSTRUN_ADMIN_PASSWORD`, used only for the image's own first install.
   - Bootstrap then pipes the typed `WORKSPACE_ADMIN_PASSWORD` over stdin into `occ user:resetpassword --password-from-env` and removes it from `.env`.
   - It is therefore never in container env (compose does not reference it), never in the retained-secrets copy (it is not generated), never in backups after the first bootstrap, and never in argv. Containers need no recreate.
   - The manifest marks it `install_required` + `pattern` + `secret` + `propagate:false`, but **not** `required`, so the "Needs setup" badge does not light up once it has been scrubbed.
   - Reset path: `ops/reset-password.sh <login>`, which reads the new password from the terminal (no echo) or stdin and passes it via stdin, never argv.
7. **The `postInstall` hook** is `{ "script": "<relative .sh>", "timeout_s": ≤1800 }`, honored for first-party bundles only (`origin: "community"` is refused).
   - **S2: it runs after `installed.json` is written**, so a gateway restart mid-hook leaves a recorded bundle plus a re-runnable script, never orphan containers.
   - It runs in **its own process group** (`spawn` detached; on timeout the whole group gets SIGTERM, then SIGKILL 10 s later), with stdin `/dev/null` and a **minimal env**: `PATH HOME USER LANG XDG_RUNTIME_DIR DOCKER_*` + `CROW_HOME` + `CROW_BUNDLE_DIR`.
   - If it fails, the install stays recorded, the job ends not-ok, and the exact re-run command is logged.
   - Its script's top-level dir is a refresh root.
   - **Not adopted (S2b):** detaching through `systemd-run`. The post-record placement, the idempotent script and the logged re-run command cover the restart case without a second supervisor.
8. **`docker.precreate`**: paths relative to `CROW_HOME`, created 0700 before `up` (Docker would create a missing bind source as root). Workspace precreates `workspace` and `workspace/backups-staging`.
9. **The compose-project ownership guard (C1; Kevin Q1: one Workspace per host).**
   - Generic: before compose `pull`/`up` at install, before `start`/`stop`, and before `down` at uninstall, the gateway resolves the project name **the way compose does**: `docker compose config --format json` → `.name` in the project dir, which honors `.env`, `COMPOSE_PROJECT_NAME` and an interpolated `name:` (re-review R1a: the live R4 browser is `name: ${CROW_BROWSER_CONTAINER_NAME:-browser}` + `.env` `COMPOSE_PROJECT_NAME=crow-browser-r4`).
     - If that call fails (Docker down, an unset `:?` var), it falls back to `COMPOSE_PROJECT_NAME` from `.env`, then `name:` with `${VAR:-default}` resolved against `.env`, then the normalized dirname.
   - It asks `docker ps -a --filter label=com.docker.compose.project=<name>` for each container's `com.docker.compose.project.working_dir`.
   - **It refuses only when the owner is another Crow install of the same bundle** (re-review R1b). That means the owner dir is `<H>/bundles/<id>[/<compose subdir>]`, with `<H>` ≠ this `CROW_HOME`, and `<H>/installed.json` lists `<id>`. The refusal says: "This extension's containers (compose project "<name>") belong to another Crow install on this host (<dir>): manage them from there." Install refusal removes the copied files. Start/stop return 409. Uninstall skips `down` but still removes this instance's own files.
   - **Any other foreign working_dir is a legacy provenance, so the gateway logs a warning and proceeds exactly as today.** Examples are crow's 35b started from `~/crow-addons/…` and grackle's `vllm-cuda-embed` from `~/crow/bundles/…`.
   - If Docker can't be queried, it proceeds and lets compose fail on its own.
   - Exported read-only `composeOwnershipCheck(bundleId)` for the Task 8 live check.
   - **Accepted (re-review minor 8):** the guard runs after `.env` is written, because project resolution needs it. A refused install therefore leaves its unused retained-secrets file behind. That is harmless, and a later legitimate install reuses it.
10. **The compose project name is fixed (`name: crow-workspace`) and the network is pinned to `10.89.70.0/24`** (S3).
    - The fixed name makes the C1 guard's answer deterministic; it is not a collision fix, which the old Ruling 10 claimed.
    - The pinned subnet keeps the bridge gateway at `10.89.70.1`, so `trusted_proxies` and `overwritecondaddr` survive a `down`/`up`.
    - The subnet sits outside Docker's default pools (crow's networks use 172.17–31/16 and 192.168.x/20), the LAN (10.0.0.0/24), thunderbolt (10.99.0.0/30) and the `DOCKER-USER` fence (192.168.250.0/24).
11. **No `ports` and no `webUI` in the manifest**, so there is no ufw rule and no same-number Serve port. Serve is an operator step (`sudo -n` fails on crow, and Tailscale has no operator user).
12. **The tailnet hostname is derived at bootstrap** from `tailscale status --json` and stored as `WORKSPACE_PUBLIC_HOST`. A manifest may not contain `*.ts.net`.
    - Every operator-visible value is pattern-gated (S6): the host, and the ports `^[0-9]{2,5}$`. The panel also refuses to render a value that fails these regexes.
    - S5: the "no tailnet name" error tells the operator to edit `~/.crow/bundles/workspace/.env`, because Configure has no field for optional keys.
13. **Backups (C3, S8, Kevin Q4).**
    - **Slot `03:55`** (no randomized delay). This is inside the 02:15–04:15 band in which `dsv4-window.sh` hard-refuses benchmark windows. It is after `crow-db-backup` (03:15) and `crow-dayane-backup` (03:40), and after the 02:30 audit and `crow-r4-backup` start. Live timers read 2026-10-02 have nothing else between 03:41 and 05:30.
    - The 30-min maintenance hold cap ends the risky part by 04:25 at the latest. It is registered in `~/CROW-SCHEDULE.md` as a standing automation.
    - **Streaming, no plaintext on disk:** the dump, the in-container tar and the `.env` are each piped straight into `gpg --symmetric --cipher-algo AES256 --compress-algo none`. The archive `crow-workspace-<ts>.tar` is a plain tar of three `.gpg` members.
    - **Secrets:** `MYSQL_PWD` for the dump (never `-p`).
    - **Destination:** it must be passed when the timer is installed (`--dest`); there is no crow-specific default. `--mount` makes `mountpoint -q` mandatory, so an unplugged drive never fills the root NVMe.
    - **Recovery, out of process:**
      - the unit's `ExecStopPost=ops/backup-stoppost.sh` runs after any termination, SIGKILL included, and turns maintenance off (bounded by `timeout 120`);
      - it sweeps `run-*` work dirs and alerts when the unit was killed, timed out or OOM-killed;
      - `backup.sh` itself sweeps leftovers at start, bounds its trap's `--off` with `timeout 60`, and alerts on its own failures.
    - **Alerts:** `--alert-lib <path>` sources a lab-style `send_alert` (on crow, `~/lab-maintenance/scripts/lib/alerts.sh`). Without it, failures go to the journal.
    - **Not adopted (S8):** `Nice`/`IOSchedulingClass` are dropped, because they do not reach the containerized processes. A `box-reserve` defer is also not adopted: the backup uses no GPU, and the slot sits inside the window-refusal band.
14. **No secrets in argv anywhere (C4).**
    - **JWT:** piped over stdin; the container writes it to a private temp file for `occ config:import <file>` (NC 34 cannot open `/dev/stdin` under `exec -T`; smoke 2026-10-02).
    - **Passwords for `occ`:** piped over stdin and read inside the container by `sh -c 'IFS= read -r NC_PASS; export NC_PASS; exec php occ "$@"'`. This relies on no `docker compose exec -e` pass-through, which was itself unverified.
    - **Redis:** `requirepass` goes into a 600 config file inside the container, and Redis runs as the `redis` user via `su-exec` with `init: true` (re-review minor 6). The healthcheck uses `REDISCLI_AUTH`.
    - **Dump:** `MYSQL_PWD`.
    - **Accepted residual:** the image's own first-boot `occ maintenance:install` puts the generated DB password and the throwaway first-run admin password in `php` argv for a few seconds, once. The throwaway is invalid after bootstrap resets the admin. Avoiding this would mean replacing the image's installer.
    - **Test coverage:** a static test bans `-p"$`, `-a "$`, `--value="$`, `--requirepass`, `--admin-pass` and `-e *PASS*/SECRET/JWT` in the compose file and `ops/*.sh`. The fake `docker compose` records argv and stdin separately, and the tests assert each secret is on stdin, never argv. The smoke window samples real host `ps` during bootstrap and backup.
15. **crow-bot (Kevin Q5).** It is not an admin. It is a member of group `crow-bots`.
    - **No public links:** `core shareapi_allow_links_exclude_groups=["crow-bots"]` (the key was verified in NC 34 `Share20/Manager.php`).
    - **Not in autocomplete:** household users go into group `household`, and `shareapi_restrict_user_enumeration_to_group=yes` with full-match left on (the default). Typing exactly `crow-bot` still shares with it; partial typing never suggests it. Verified in NC 34 `UserPlugin.php`.
    - **Token hygiene** (S4): existing `crow-workspace-tools` tokens are deleted before a re-mint, and the minted token must match `^[A-Za-z0-9]{72}$` (NC 34 `auth-tokens:add` generates 72 alphanumerics).
    - The quota is deferred to W2.
16. **The data layout is `~/.crow/workspace/{nextcloud/, db/, backups-staging/, backup-passphrase}`.** `nextcloud/` is the whole `/var/www/html`, so the spec's `data/` is `nextcloud/data/`. Backups tar all of it, so a restore never meets a version-equal entrypoint that skips the code.
17. **Uninstall semantics (S9), stated in the manifest `notes`, the guide and the panel.** Uninstall keeps:
    - the data;
    - the retained secrets;
    - the backup timer (disable it first);
    - the Serve mappings (remove them).

    "Delete data" removes no bind-mounted files. The guide gives every cleanup command.
18. **The scratch restore** uses a portless project `crow-ws-restore` on subnet `10.89.72.0/24`, with `restart: "no"` on every service (S7). The smoke uses `crow-ws-smoke` on `10.89.71.0/24`.
19. **Memory and OOM (S12):**
    - `mem_limit`: onlyoffice 3g, nextcloud 2g, cron 512m, db 1g, redis 256m;
    - `oom_score_adj: -500` for `nextcloud-db` and `nextcloud-redis`, which hold household writes. That sits between crow-oom-protect's writer tier (-700) and default; test models are +800;
    - nextcloud and onlyoffice stay at the default;
    - the measured steady state is recorded in CROW-SCHEDULE (Task 10).
20. **`docker.pull_timeout_s` is opt-in** (S16). The default stays `run()`'s 300 s; Workspace sets 1800.
21. **Nav** (S14): the panel is named **"Office"** with icon `files` (in `NAV_ICONS`), which avoids "Workspace › Workspace".
22. **The `nextcloud` bundle** becomes `type: "skill"`, v1.1.0, with `deprecated.superseded_by: "workspace"`. Its compose, ports and webUI are removed, and so is the 8080 known conflict, in both `docs/developers/` and `docs/es/developers/` (S15).
23. **`workspace` stays at version `0.1.0`** until merge. The smoke window installs only scratch copies, never from `~/crow`.
24. **Panel strings are bundle-local en/es** (the `phone` pattern), with a parity test.
25. **Execution branch:** `feat/workspace-w1-platform`, cut from `docs/crow-workspace-spec` in `~/crow-wt-workspace`. Never `git checkout` in `~/crow`.
26. **Smoke-window hygiene (re-review R2 + minors 4, 5, 9).**
    - **Helpers:** the argv sampler and the header echo run as named transient user units (`ws-smoke-sampler`, `ws-smoke-echo`), each with `RuntimeMaxSec`. The sampler logs only matching lines, deduplicated, so the log stays small.
    - **Teardown:** the deadman stops both units, then removes containers and networks by compose label as well as through compose, which covers an unparsable compose. It cleans only the smoke's own restore dir.
    - **Kill test:** the SIGKILL test kills a `setsid` process group.
    - **Sudo:** runs as `sudo -S` with the credential from the global CLAUDE.md, or Kevin runs those lines.
    - **Not adopted (minor 5b):** foreground `sudo timeout … tailscale serve`. A stale tailnet-only Serve mapping that returns 502 is the documented deadman-path leftover, and the normal path removes it.

## Global Constraints

- Tailnet only, through Tailscale Serve HTTPS ports. **Never Funnel**. `tests/auth-network.test.js` must still pass, and a public-internet probe of both Serve ports must fail.
- All five services `restart: unless-stopped`, all published on `127.0.0.1` only; MariaDB healthchecked; ONLYOFFICE `JWT_ENABLED=true` with a generated secret.
- Images pinned by tag (no `latest`) and recorded in the manifest; the manifest declares `requires.min_ram_mb` / `min_disk_mb` (≈3–5 GB RAM, no GPU).
- The installer generates every internal secret into the bundle `.env` at mode 600; the only operator input is the admin password (never defaulted).
- Bootstrap is idempotent: each step checks existing state first.
- Data under `~/.crow/workspace/`, never NTFS `/mnt/external`, never `/mnt/data`.
- Backups are `gpg --symmetric` AES256 (no new package), maintenance is held only for dump + snapshot, `--off` is guaranteed even on SIGKILL (ExecStopPost), and 14 days are kept on the drive.
- Every window (smoke, first start, upgrade) is registered in `~/CROW-SCHEDULE.md` before it starts and cleared after. A window that degrades or occupies resources carries an out-of-process deadman.
- Repo rules (`CLAUDE.md`):
  - positional-path commits: `git add <new files> && git commit <paths> -m …`, then `git show --stat HEAD`;
  - `git pull --rebase` before a push;
  - tests via `npm test -- tests/<file>.test.js`, never raw `node --test`;
  - new host ports go in `docs/developers/port-allocation.md`;
  - `node scripts/build-registry.mjs --check` must pass;
  - bundle code changes need a manifest version bump;
  - no AI attribution;
  - never `git checkout` in `~/crow`;
  - check-runs must all be `completed/success` before merge.
- `gh` is not installed on crow: PRs go through the GitHub MCP tools (repo `kh0pper/crow`).

## Review Focus

1. **Uninstall then reinstall Workspace, or restore a backup and later reinstall**: the kept DB must still match the secrets the reinstall uses. *Pinned:*
   - Task 1: `REVIEW FOCUS 1 — reinstall reuses retained secrets`, plus `REVIEW FOCUS 1 (wiring) — install → uninstall route → install keeps the same .env secrets`;
   - Task 5: `REVIEW FOCUS 1 (restore) — bootstrap re-syncs the retained copy from .env`.
2. **An admin password containing `$`, a space, `#`, a quote or `;`** must be refused up front, with nothing half-installed. *Pinned in Task 2:* `REVIEW FOCUS 2 — unsafe admin password refused before anything is written`.
3. **Re-running the bootstrap** must not duplicate the bot, the calendar or app passwords. A lost token is re-minted once, and the stale tokens are revoked. *Pinned in Task 5:* `REVIEW FOCUS 3 — second run changes nothing; lost token re-minted once, stale tokens revoked`.
4. **The nightly backup being killed or failing at any point** must not leave Nextcloud in maintenance mode or leave plaintext on disk. *Pinned in Task 6:* `REVIEW FOCUS 4 — failure and hang still turn maintenance off; no plaintext ever on disk`, plus `REVIEW FOCUS 4 (SIGKILL) — ExecStopPost recovers maintenance mode, sweeps, alerts`.
5. **Secrets reaching the gateway `.env`, logs, the page, argv or container env.** *Pinned:*
   - Task 2: `REVIEW FOCUS 5a`;
   - Task 5: `REVIEW FOCUS 5b — secrets travel on stdin, never argv or output; admin password scrubbed`;
   - Task 4: `REVIEW FOCUS 5c — no secret-in-argv patterns in compose or ops scripts`;
   - Task 7: `REVIEW FOCUS 5d — the page renders no secret value`;
   - Task 8: the live `ps` sampler.
6. **A second Crow instance on the same host (R4) installing, starting, stopping or uninstalling Workspace** must never touch the household's containers. And the guard must never block an instance's own per-instance project (R4 browser) or containers that were started from a legacy path. *Pinned in Task 3:* `REVIEW FOCUS 6 — a second instance cannot adopt another instance's compose project`, `regression (R4 browser)`, `regression (legacy provenance)`; *live in Task 8 Step 7*.

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `servers/gateway/bundle-env-secrets.js` | Create | Generated secrets (resolve/retain), private file writes, gateway exclusion, pattern checks |
| `servers/gateway/bundle-lifecycle.js` | Create | `precreate`, the `postInstall` plan, the process-group hook runner plus minimal env, the compose-project ownership guard |
| `servers/gateway/routes/bundles.js` | Modify | Wire both helper modules into install/uninstall/start/stop/Configure/validate/refresh/repair |
| `servers/gateway/dashboard/panels/extensions/html.js` | Modify | Hide `generate` vars from the browser |
| `registry/manifest.schema.json` | Modify | `generate`, `propagate`, `pattern`, `pattern_hint`, `install_required`, `docker.precreate`, `docker.pull_timeout_s`, `postInstall`, `images`, `deprecated` |
| `scripts/lib/bundle-contract.mjs` | Modify | `postInstall.script` exists; `precreate` entries are safe |
| `bundles/workspace/manifest.json` | Create | The store entry |
| `bundles/workspace/docker-compose.yml` | Create | The five pinned, loopback-only, limited services on a pinned subnet |
| `bundles/workspace/ops/bootstrap.sh` | Create | Idempotent `occ` configuration (secrets over stdin; admin scrub; retained-secrets sync) |
| `bundles/workspace/ops/add-user.sh` | Create | Household account (group `household`) plus a one-time password |
| `bundles/workspace/ops/reset-password.sh` | Create | Password reset over stdin |
| `bundles/workspace/ops/backup.sh` | Create | Streaming encrypted backup |
| `bundles/workspace/ops/backup-stoppost.sh` | Create | Out-of-process recovery (ExecStopPost) |
| `bundles/workspace/ops/restore.sh` | Create | Unpack and decrypt an archive |
| `bundles/workspace/ops/restore-scratch.sh` + `restore-scratch.override.yml` | Create | Boot an archive in a throwaway project |
| `bundles/workspace/ops/install-backup-timer.sh` | Create | User units plus the passphrase |
| `bundles/workspace/panel/workspace.js` | Create | The "Office" setup page (en/es) |
| `bundles/nextcloud/manifest.json` / `docker-compose.yml` | Modify / Delete | Deprecated connect-only skill |
| `scripts/known-port-conflicts.json` | Modify | Drop 8080 |
| `docs/developers/port-allocation.md`, `docs/es/developers/port-allocation.md` | Modify | 3070/3071/8456/8457; 8080 resolved |
| `registry/add-ons.json` | Regenerate | — |
| `docs/guide/workspace.md`, `docs/.vitepress/config.ts` | Create / Modify | Operator guide plus sidebar |
| `tests/bundle-env-secrets.test.js` | Create | Task 1 |
| `tests/bundle-env-scoping.test.js` | Create | Task 2 |
| `tests/bundle-lifecycle-hooks.test.js` | Create | Task 3 |
| `tests/workspace-bundle.test.js` | Create | Task 4 |
| `tests/workspace-bootstrap.test.js` | Create | Task 5 |
| `tests/workspace-backup.test.js` | Create | Task 6 |
| `tests/workspace-panel.test.js` | Create | Task 7 |

**CI tasks** (code + unit tests, no containers): 1–7 and 9. **Attended LIVE tasks on crow:** 8 (the pre-merge smoke on scratch copies, with a deadman) and 10 (post-merge install + acceptance). Steps only Kevin can do are marked **[KEVIN]**.

---

### Task 0: Branch and dependencies (setup, no commit)

- [ ] **Step 1: Cut the execution branch in the worktree**

```bash
cd ~/crow-wt-workspace
git status --short            # expect clean
git switch -c feat/workspace-w1-platform
```

- [ ] **Step 2: Install the repo's locked dependencies (no new packages)**

```bash
cd ~/crow-wt-workspace && npm ci
npm test -- tests/bundles-install-env.test.js   # baseline: expect all pass
```

Do NOT symlink `~/crow/node_modules`: `.gitignore`'s `node_modules/` does not ignore a symlink.

---

### Task 1: Installer-generated secrets and `.env` at mode 600

**Files:**
- Create: `servers/gateway/bundle-env-secrets.js`
- Modify: `servers/gateway/routes/bundles.js`:
  - fs import (line 25);
  - `writeInstallEnv` (~1836);
  - `runInstallJob` step 2 (~1960);
  - Configure route `POST /bundles/api/env` (~3042);
  - `repairInstalledBundleAssets` loop (~847).
- Modify: `registry/manifest.schema.json`
- Test: `tests/bundle-env-secrets.test.js`

**Interfaces:**
- Produces:
  - `parseEnvText(text): Record<string,string>`
  - `generatedEnvKeys(manifest): string[]`
  - `newSecretValue(): string` returns 43 base64url chars
  - `writePrivateFile(path, content): void`: a 600 temp file in the same dir, then an atomic rename
  - `retainedEnvPath(crowHome, bundleId): string` → `<crowHome>/secrets/bundle-env/<id>.env`
  - `resolveGeneratedEnv(bundleId, manifest, { destDir, crowHome }): Record<string,string>`
  - `stripGeneratedKeys(manifest, envVars)`
  - Manifest field: `env_vars[].generate: "secret"`

- [ ] **Step 1: Write the failing test**

Create `tests/bundle-env-secrets.test.js`:

```js
/**
 * Installer-generated bundle secrets + .env hygiene (Crow Workspace W1, Task 1).
 * bundles.js resolves CROW_HOME at import — scratch dirs are set BEFORE the import.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, chmodSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-envsec-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-envsec-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
const CROW_HOME = process.env.CROW_HOME;

const S = await import("../servers/gateway/bundle-env-secrets.js");
const B = await import("../servers/gateway/routes/bundles.js");
const FIXTURES = mkdtempSync(join(tmpdir(), "crow-envsec-app-"));
B._setAppBundlesForTest(FIXTURES);
const GATEWAY_ENV = join(mkdtempSync(join(tmpdir(), "crow-envsec-gwenv-")), ".env");
B._setAppEnvPathForTest(GATEWAY_ENV);

after(() => {
  B._setAppEnvPathForTest(null);
  rmSync(CROW_HOME, { recursive: true, force: true });
  rmSync(FIXTURES, { recursive: true, force: true });
});

const MANIFEST = {
  id: "demo",
  env_vars: [
    { name: "DEMO_DB_PASSWORD", generate: "secret" },
    { name: "DEMO_JWT", generate: "secret" },
    { name: "DEMO_ADMIN_PASSWORD", required: true, secret: true },
  ],
};
const mode = (p) => statSync(p).mode & 0o777;
const scratch = (prefix) => mkdtempSync(join(tmpdir(), prefix));

test("generatedEnvKeys lists only generate:'secret' vars", () => {
  assert.deepEqual(S.generatedEnvKeys(MANIFEST), ["DEMO_DB_PASSWORD", "DEMO_JWT"]);
  assert.deepEqual(S.generatedEnvKeys({ env_vars: [{ name: "X", generate: "bogus" }] }), []);
  assert.deepEqual(S.generatedEnvKeys(null), []);
});

test("fresh install: one distinct 43-char base64url value per generated key", () => {
  const out = S.resolveGeneratedEnv("demo", MANIFEST, { destDir: scratch("d-"), crowHome: scratch("h-") });
  assert.deepEqual(Object.keys(out).sort(), ["DEMO_DB_PASSWORD", "DEMO_JWT"]);
  for (const v of Object.values(out)) assert.match(v, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(out.DEMO_DB_PASSWORD, out.DEMO_JWT);
});

test("retained copy is mode 600 inside a mode 700 dir and holds every generated key", () => {
  const home = scratch("h-");
  const out = S.resolveGeneratedEnv("demo", MANIFEST, { destDir: scratch("d-"), crowHome: home });
  const p = S.retainedEnvPath(home, "demo");
  assert.equal(p, join(home, "secrets", "bundle-env", "demo.env"));
  assert.equal(mode(p), 0o600);
  assert.equal(mode(join(home, "secrets", "bundle-env")), 0o700);
  assert.deepEqual(S.parseEnvText(readFileSync(p, "utf8")), out);
});

test("REVIEW FOCUS 1 — reinstall reuses retained secrets", () => {
  const home = scratch("h-");
  const first = S.resolveGeneratedEnv("demo", MANIFEST, { destDir: scratch("d1-"), crowHome: home });
  const second = S.resolveGeneratedEnv("demo", MANIFEST, { destDir: scratch("d2-"), crowHome: home });
  assert.deepEqual(second, first, "a regenerated DB password would lock Nextcloud out of its kept database");
});

test("an existing installed .env value wins over the retained copy", () => {
  const home = scratch("h-"); const dest = scratch("d-");
  S.resolveGeneratedEnv("demo", MANIFEST, { destDir: dest, crowHome: home });
  writeFileSync(join(dest, ".env"), "DEMO_DB_PASSWORD=from-installed-env\n");
  assert.equal(S.resolveGeneratedEnv("demo", MANIFEST, { destDir: dest, crowHome: home }).DEMO_DB_PASSWORD, "from-installed-env");
});

test("a manifest with no generated vars returns {} and writes no retained file", () => {
  const home = scratch("h-");
  assert.deepEqual(S.resolveGeneratedEnv("plain", { env_vars: [{ name: "A" }] }, { destDir: scratch("d-"), crowHome: home }), {});
  assert.equal(existsSync(S.retainedEnvPath(home, "plain")), false);
});

test("stripGeneratedKeys drops generated keys from a request body", () => {
  assert.deepEqual(S.stripGeneratedKeys(MANIFEST, { DEMO_DB_PASSWORD: "attacker", DEMO_ADMIN_PASSWORD: "ok" }), { DEMO_ADMIN_PASSWORD: "ok" });
  assert.equal(S.stripGeneratedKeys(MANIFEST, null), null);
});

test("writePrivateFile replaces a 644 file atomically at 600 and leaves no temp file", () => {
  const dir = scratch("w-"); const p = join(dir, ".env");
  writeFileSync(p, "A=1\n", { mode: 0o644 });
  S.writePrivateFile(p, "A=2\n");
  assert.equal(mode(p), 0o600);
  assert.equal(readFileSync(p, "utf8"), "A=2\n");
  assert.deepEqual(readdirSync(dir), [".env"]);
});

test("writeInstallEnv writes .env at 600 on all three rungs; existing file tightened, never clobbered", () => {
  const d1 = scratch("e1-");
  B.writeInstallEnv(d1, { A_KEY: "v" }, null);
  assert.equal(mode(join(d1, ".env")), 0o600);
  const d2 = scratch("e2-");
  writeFileSync(join(d2, ".env.example"), "X=1\n", { mode: 0o644 });
  B.writeInstallEnv(d2, {}, null);
  assert.equal(mode(join(d2, ".env")), 0o600);
  const d3 = scratch("e3-");
  B.writeInstallEnv(d3, {}, { env_vars: [{ name: "K", required: true }] });
  assert.equal(mode(join(d3, ".env")), 0o600);
  const d4 = scratch("e4-");
  writeFileSync(join(d4, ".env"), "KEEP=1\n", { mode: 0o644 });
  B.writeInstallEnv(d4, {}, { env_vars: [{ name: "KEEP" }] });
  assert.equal(readFileSync(join(d4, ".env"), "utf8"), "KEEP=1\n");
  assert.equal(mode(join(d4, ".env")), 0o600);
});

// ── routes ──
function seedInstalled(id, manifest, envText) {
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, name: id, type: "bundle", version: "0.1.0", ...manifest }));
  writeFileSync(join(dir, ".env"), envText, { mode: 0o644 });
  chmodSync(join(dir, ".env"), 0o644);
  return dir;
}
async function withRouter(fn) {
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const post = (base, path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test("Configure leaves the .env at 600 and ignores attempts to overwrite a generated key", async () => {
  const dir = seedInstalled("demo-cfg", { env_vars: MANIFEST.env_vars }, "DEMO_DB_PASSWORD=original\nDEMO_ADMIN_PASSWORD=old\n");
  const r = await withRouter((base) => post(base, "/bundles/api/env", { bundle_id: "demo-cfg", env_vars: { DEMO_DB_PASSWORD: "attacker", DEMO_ADMIN_PASSWORD: "newpass" } }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const env = S.parseEnvText(readFileSync(join(dir, ".env"), "utf8"));
  assert.equal(env.DEMO_DB_PASSWORD, "original");
  assert.equal(env.DEMO_ADMIN_PASSWORD, "newpass");
  assert.equal(mode(join(dir, ".env")), 0o600);
});

test("REVIEW FOCUS 1 (wiring) — install → uninstall route → install keeps the same .env secrets", async () => {
  const id = "demo-cycle";
  mkdirSync(join(FIXTURES, id), { recursive: true });
  const manifest = { id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.1.0", env_vars: MANIFEST.env_vars };
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify(manifest));
  const installOnce = async () => {
    const job = B._createJobForTest(id, "install");
    const out = await B.runInstallJob(id, { DEMO_ADMIN_PASSWORD: "Correct-Horse-1" }, { job, installedSnapshot: [], consentVerified: false, manifest });
    assert.equal(out.ok, true, out.reason);
    return S.parseEnvText(readFileSync(join(CROW_HOME, "bundles", id, ".env"), "utf8"));
  };
  const first = await installOnce();
  await withRouter(async (base) => {
    const r = await post(base, "/bundles/api/uninstall", { bundle_id: id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const deadline = Date.now() + 10_000;
    while (existsSync(join(CROW_HOME, "bundles", id)) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  });
  assert.equal(existsSync(join(CROW_HOME, "bundles", id)), false, "uninstall removed the bundle dir");
  const second = await installOnce();
  assert.equal(second.DEMO_DB_PASSWORD, first.DEMO_DB_PASSWORD);
  assert.equal(second.DEMO_JWT, first.DEMO_JWT);
});

test("boot repair tightens every installed bundle .env to 600", async () => {
  const dir = seedInstalled("demo-loose", {}, "PHONE_RUNNER_SECRET=x\n");
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([{ id: "demo-loose", type: "bundle", version: "0.1.0" }]));
  await B.repairInstalledBundleAssets({ appBundles: FIXTURES, run: async () => ({ stdout: "", stderr: "" }) });
  assert.equal(mode(join(dir, ".env")), 0o600);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/bundle-env-secrets.test.js`
Expected: FAIL: `Cannot find module '…/servers/gateway/bundle-env-secrets.js'`.

- [ ] **Step 3: Implement `servers/gateway/bundle-env-secrets.js`**

```js
/**
 * Installer-generated bundle secrets + bundle .env hygiene (config-friction stage 1, F1).
 *
 *   env_vars[].generate: "secret"   → 32 random bytes, base64url (43 chars; no `$`,
 *                                     quotes or spaces: safe in compose .env, URLs, bash)
 *
 * NEVER regenerated on reinstall: bundles bind-mount their data and the kept DB still
 * expects the old password. Order: installed .env → retained copy at
 * <CROW_HOME>/secrets/bundle-env/<id>.env (dir 700, file 600; uninstall never deletes
 * it) → new value. Generated keys are hidden from the forms (html.js), ignored in
 * requests (stripGeneratedKeys), never install-blocking, never sent to the gateway .env.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { randomBytes, createHash } from "node:crypto";

const GENERATE_KINDS = new Set(["secret"]);

export function parseEnvText(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function readEnvSafe(path) {
  try { return existsSync(path) ? parseEnvText(readFileSync(path, "utf8")) : {}; } catch { return {}; }
}

export function generatedEnvKeys(manifest) {
  return (manifest?.env_vars || [])
    .filter((v) => v && typeof v.name === "string" && GENERATE_KINDS.has(v.generate))
    .map((v) => v.name);
}

export function newSecretValue() {
  return randomBytes(32).toString("base64url");
}

/**
 * Write a secret-bearing file: a fresh 600 temp file in the same dir, then an atomic
 * rename — the content is never readable at a wider mode, not even briefly.
 */
export function writePrivateFile(path, content) {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function retainedEnvPath(crowHome, bundleId) {
  return join(crowHome, "secrets", "bundle-env", `${bundleId}.env`);
}

export function resolveGeneratedEnv(bundleId, manifest, { destDir, crowHome }) {
  const keys = generatedEnvKeys(manifest);
  if (keys.length === 0) return {};
  const installed = readEnvSafe(join(destDir, ".env"));
  const retainedPath = retainedEnvPath(crowHome, bundleId);
  const retained = readEnvSafe(retainedPath);
  const out = {};
  for (const k of keys) out[k] = installed[k] || retained[k] || newSecretValue();
  const dir = dirname(retainedPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const merged = { ...retained, ...out };
  writePrivateFile(
    retainedPath,
    `# Crow-generated secrets for bundle '${bundleId}'. Kept across uninstall so a\n` +
      `# reinstall reuses them (the bundle's data still expects them). Do not edit.\n` +
      Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
  );
  return out;
}

export function stripGeneratedKeys(manifest, envVars) {
  if (!envVars || typeof envVars !== "object") return envVars;
  const drop = new Set(generatedEnvKeys(manifest));
  const out = {};
  for (const [k, v] of Object.entries(envVars)) if (!drop.has(k)) out[k] = v;
  return out;
}
```

- [ ] **Step 4: Wire it into `servers/gateway/routes/bundles.js`**

(a) fs import, line 25: add `chmodSync` to the named imports.

(b) After `import { readEnvFile } from "../env-manager.js";`:

```js
import { resolveGeneratedEnv, stripGeneratedKeys, writePrivateFile } from "../bundle-env-secrets.js";
```

(c) Replace the body of `writeInstallEnv` (append ` * Every rung writes mode 600 — bundle .env files hold secrets.` to its doc comment):

```js
export function writeInstallEnv(destDir, envVars, manifest, log = () => {}) {
  const envPath = join(destDir, ".env");
  const examplePath = join(destDir, ".env.example");
  const envLines = (envVars && typeof envVars === "object")
    ? Object.entries(envVars).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${v}`)
    : [];
  if (envLines.length > 0) {
    writePrivateFile(envPath, envLines.join("\n") + "\n");
    log(`Wrote ${envLines.length} env vars`);
    return;
  }
  if (existsSync(envPath)) { chmodSync(envPath, 0o600); return; }
  if (existsSync(examplePath)) {
    writePrivateFile(envPath, readFileSync(examplePath, "utf8"));
    log("Created .env from .env.example");
    return;
  }
  if ((manifest?.env_vars || []).length > 0) {
    writePrivateFile(envPath, "# Managed by Crow — no values provided at install; configure via the dashboard Extensions panel.\n");
    log("Wrote placeholder .env (no values provided — configure via Extensions)");
  }
}
```

(d) In `runInstallJob`, replace `writeInstallEnv(destDir, envVars, manifest, (msg) => appendLog(job, msg));` with:

```js
    // 2. Write env vars. Generated secrets (env_vars[].generate) are minted or reused
    // here — never taken from the request, never shown, never sent to the gateway .env
    // (they are not in envVars, which is what propagates).
    const generated = resolveGeneratedEnv(bundleId, manifest, { destDir, crowHome: CROW_HOME });
    const installEnv = { ...(stripGeneratedKeys(manifest, envVars) || {}), ...generated };
    writeInstallEnv(destDir, installEnv, manifest, (msg) => appendLog(job, msg));
    if (Object.keys(generated).length > 0) {
      appendLog(job, `Generated ${Object.keys(generated).length} internal secret(s) — stored at mode 600, never shown`);
    }
```

(e) Configure route: change `const { bundle_id, env_vars } = req.body;` to `const { bundle_id } = req.body; let { env_vars } = req.body;`. After the `env_vars must be an object` 400 block, add:

```js
      // Generated secrets are never operator input — a request cannot rotate a DB
      // password out from under its database.
      env_vars = stripGeneratedKeys(getInstalledFirstManifest(bundle_id), env_vars);
```

Replace that route's `writeFileSync(envPath, envContent);` with `writePrivateFile(envPath, envContent);`.

(f) `repairInstalledBundleAssets`: as the first statement inside `for (const entry of installed) {`, right after the `id` validity `continue`, add:

```js
    // Every installed bundle .env holds secrets: tighten legacy 644/777 files at boot.
    try {
      const envP = join(BUNDLES_DIR, id, ".env");
      if (existsSync(envP)) chmodSync(envP, 0o600);
    } catch { /* never block boot repair on a chmod */ }
```

(g) Schema, `env_vars.items.properties`: add `"generate": { "type": "string", "enum": ["secret"] },`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/bundle-env-secrets.test.js tests/bundles-install-env.test.js tests/bundles-install-hardening.test.js tests/bundles-env-mcp-config.test.js tests/bundle-version-refresh.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/bundle-env-secrets.js tests/bundle-env-secrets.test.js
git commit servers/gateway/bundle-env-secrets.js servers/gateway/routes/bundles.js registry/manifest.schema.json tests/bundle-env-secrets.test.js \
  -m "feat(bundles): installer-generated secrets kept across reinstall; every bundle .env at 600 (atomic, boot-tightened)"
git show --stat HEAD
```

---

### Task 2: Env-var scoping (`propagate`, `pattern`, `install_required`, hidden generated keys)

**Files:**
- Modify: `servers/gateway/bundle-env-secrets.js`, `servers/gateway/routes/bundles.js`:
  - `declaredEnvSubset` (~1428);
  - `installBlockingEnvKeys` (~1607);
  - `validateInstall` (after the `requireEnv` block, ~1697);
  - Configure route.
- Modify: `servers/gateway/dashboard/panels/extensions/html.js:438`, `registry/manifest.schema.json`
- Test: `tests/bundle-env-scoping.test.js`

**Interfaces:**
- Consumes: `generatedEnvKeys` (Task 1).
- Produces:
  - `gatewayExcludedKeys(manifest): Set<string>`
  - `envPatternViolation(manifest, envVars): { key, why } | null`
  - `breachedValueViolation(manifest, envVars, { fetchImpl, timeoutMs }): Promise<{ key, why } | null>`; seam `_setBreachFetchForTest(fn)`
  - Manifest fields: `env_vars[].propagate: boolean`, `pattern: "^…$"`, `pattern_hint: string`, `install_required: boolean`, `check: "not_breached"`
  - Error contract: 400 `code: "invalid_env"`

- [ ] **Step 1: Write the failing test**

Create `tests/bundle-env-scoping.test.js`:

```js
/** Env-var scoping for bundles (Crow Workspace W1, Task 2). Scratch CROW_HOME before import. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-envscope-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-envscope-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
const CROW_HOME = process.env.CROW_HOME;

const S = await import("../servers/gateway/bundle-env-secrets.js");
const B = await import("../servers/gateway/routes/bundles.js");
const { buildExtensionsHTML } = await import("../servers/gateway/dashboard/panels/extensions/html.js");

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-envscope-app-"));
B._setAppBundlesForTest(FIXTURES);
const GATEWAY_ENV = join(mkdtempSync(join(tmpdir(), "crow-envscope-gw-")), ".env");
writeFileSync(GATEWAY_ENV, "# gateway env\n");
B._setAppEnvPathForTest(GATEWAY_ENV);
after(() => {
  B._setAppEnvPathForTest(null);
  rmSync(CROW_HOME, { recursive: true, force: true });
  rmSync(FIXTURES, { recursive: true, force: true });
});

const SAFE = "^[A-Za-z0-9!%*+,./:=?@^_~-]{12,128}$";
const ENV_VARS = [
  { name: "WS_ADMIN_USER", default: "admin", propagate: false },
  { name: "WS_ADMIN_PASSWORD", install_required: true, secret: true, propagate: false, pattern: SAFE, pattern_hint: "12-128 letters, digits or ! % * + , - . / : = ? @ ^ _ ~" },
  { name: "WS_DB_PASSWORD", required: true, generate: "secret" },
  { name: "WS_PLAIN_URL", required: false },
];
function fixture(id, { compose = null } = {}) {
  const dir = join(FIXTURES, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.1.0", env_vars: ENV_VARS }));
  if (compose) writeFileSync(join(dir, "docker-compose.yml"), compose);
  return dir;
}

test("gatewayExcludedKeys = generated + propagate:false", () => {
  assert.deepEqual([...S.gatewayExcludedKeys({ env_vars: ENV_VARS })].sort(), ["WS_ADMIN_PASSWORD", "WS_ADMIN_USER", "WS_DB_PASSWORD"]);
});

test("REVIEW FOCUS 5a — generated and propagate:false keys never reach the gateway .env", () => {
  const subset = B.declaredEnvSubset({ env_vars: ENV_VARS }, { WS_ADMIN_USER: "admin", WS_ADMIN_PASSWORD: "Correct-Horse-1", WS_DB_PASSWORD: "x", WS_PLAIN_URL: "http://a" });
  assert.deepEqual(subset, { WS_PLAIN_URL: "http://a" });
});

test("envPatternViolation: blank skipped, match ok, mismatch named by key (value never echoed)", () => {
  const m = { env_vars: ENV_VARS };
  assert.equal(S.envPatternViolation(m, {}), null);
  assert.equal(S.envPatternViolation(m, { WS_ADMIN_PASSWORD: "" }), null);
  assert.equal(S.envPatternViolation(m, { WS_ADMIN_PASSWORD: "Good.Pass-word_1" }), null);
  for (const bad of ["pa$$word12345", "has space 12345", "hash#tag123456", "quote'd1234567", "semi;colon12345", "short1"]) {
    const v = S.envPatternViolation(m, { WS_ADMIN_PASSWORD: bad });
    assert.ok(v, `expected refusal for ${JSON.stringify(bad)}`);
    assert.equal(v.key, "WS_ADMIN_PASSWORD");
    assert.ok(!v.why.includes(bad));
  }
});

test("installBlockingEnvKeys: generated keys never block; install_required blocks without any compose reference", () => {
  fixture("ws-block", { compose: "services:\n  a:\n    image: busybox:1.36\n    environment:\n      P: ${WS_DB_PASSWORD:?gen}\n" });
  assert.deepEqual(B.installBlockingEnvKeys("ws-block"), ["WS_ADMIN_PASSWORD"]);
  assert.deepEqual(B.missingInstallEnv("ws-block", { WS_ADMIN_PASSWORD: "Correct-Horse-1" }), []);
});

test("REVIEW FOCUS 2 — unsafe admin password refused before anything is written", async () => {
  fixture("ws-pattern");
  const v = await B.validateInstall("ws-pattern", { envVars: { WS_ADMIN_PASSWORD: "pa$$ w0rd#'; rm" }, requireEnv: true, forceInstall: true });
  assert.equal(v.ok, false);
  assert.equal(v.status, 400);
  assert.equal(v.code, "invalid_env");
  assert.match(v.error, /WS_ADMIN_PASSWORD/);
  assert.equal(existsSync(join(CROW_HOME, "bundles", "ws-pattern")), false);
});

test("a missing install_required password is refused; a safe one passes", async () => {
  fixture("ws-req");
  const miss = await B.validateInstall("ws-req", { envVars: {}, requireEnv: true, forceInstall: true });
  assert.equal(miss.code, "missing_required_env");
  const ok = await B.validateInstall("ws-req", { envVars: { WS_ADMIN_PASSWORD: "Correct-Horse-Battery-9" }, requireEnv: true, forceInstall: true });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test("Configure refuses a pattern-violating value with 400 invalid_env and leaves the .env untouched", async () => {
  const dir = join(CROW_HOME, "bundles", "ws-cfg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id: "ws-cfg", name: "ws-cfg", type: "bundle", version: "0.1.0", env_vars: ENV_VARS }));
  writeFileSync(join(dir, ".env"), "WS_ADMIN_USER=admin\n", { mode: 0o600 });
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/bundles/api/env`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle_id: "ws-cfg", env_vars: { WS_ADMIN_PASSWORD: "bad $value here" } }),
    });
    const body = await r.json();
    assert.equal(r.status, 400);
    assert.equal(body.code, "invalid_env");
  } finally { server.close(); }
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "WS_ADMIN_USER=admin\n");
  assert.ok(!readFileSync(GATEWAY_ENV, "utf8").includes("WS_ADMIN"));
});

test("not_breached: a breached value is refused via k-anonymity (5-char prefix only); offline → no verdict", async () => {
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha1").update("Password1234").digest("hex").toUpperCase();
  const urls = [];
  const fakeFetch = async (url) => { urls.push(url); return { ok: true, text: async () => `0000000000000000000000000000000000A:3\r\n${sha.slice(5)}:41234\r\n` }; };
  const m = { env_vars: [{ name: "P", check: "not_breached" }] };
  const v = await S.breachedValueViolation(m, { P: "Password1234" }, { fetchImpl: fakeFetch });
  assert.equal(v.key, "P");
  assert.ok(!v.why.includes("Password1234"));
  assert.deepEqual(urls, [`https://api.pwnedpasswords.com/range/${sha.slice(0, 5)}`]);
  assert.equal(await S.breachedValueViolation(m, { P: "Never-Seen-Before-9" }, { fetchImpl: fakeFetch }), null);
  assert.equal(await S.breachedValueViolation(m, { P: "Password1234" }, { fetchImpl: async () => { throw new Error("offline"); } }), null);
  fixture("ws-breach");
  B._setBreachFetchForTest(fakeFetch);
  const manifestPath = join(FIXTURES, "ws-breach", "manifest.json");
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  man.env_vars = man.env_vars.map((e) => (e.name === "WS_ADMIN_PASSWORD" ? { ...e, check: "not_breached" } : e));
  writeFileSync(manifestPath, JSON.stringify(man));
  const r = await B.validateInstall("ws-breach", { envVars: { WS_ADMIN_PASSWORD: "Password1234" }, requireEnv: true, forceInstall: true });
  B._setBreachFetchForTest(null);
  assert.equal(r.code, "invalid_env");
  assert.match(r.error, /known data breaches/);
});

test("the store never sends a generated key to the browser", () => {
  const { addonRegistryScript } = buildExtensionsHTML({
    installed: {}, available: [{ id: "ws-ui", name: "WS", description: "d", type: "bundle", category: "productivity", version: "0.1.0", env_vars: ENV_VARS }],
    collections: [], registrySource: "local", communityStores: [], bundleStatus: {}, lang: "en",
  });
  assert.ok(!addonRegistryScript.includes("WS_DB_PASSWORD"));
  assert.ok(addonRegistryScript.includes("WS_ADMIN_PASSWORD"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/bundle-env-scoping.test.js`
Expected: FAIL: `S.gatewayExcludedKeys is not a function`.

- [ ] **Step 3: Implement**

(a) Append to `servers/gateway/bundle-env-secrets.js`:

```js
/** Never written to the gateway's own .env: generated secrets + `propagate: false` vars. */
export function gatewayExcludedKeys(manifest) {
  const out = new Set(generatedEnvKeys(manifest));
  for (const v of manifest?.env_vars || []) {
    if (v && typeof v.name === "string" && v.propagate === false) out.add(v.name);
  }
  return out;
}

/**
 * `env_vars[].check: "not_breached"` — refuse a value found in known data breaches,
 * the same Have I Been Pwned check Nextcloud's password_policy enforces by default, so
 * the install is refused up front instead of failing in the post-install hook.
 * k-anonymity: only the first 5 hex chars of the SHA-1 leave the machine. Network
 * failure → no verdict (the app's own policy decides; bootstrap explains recovery).
 */
export async function breachedValueViolation(manifest, envVars, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const vals = envVars && typeof envVars === "object" ? envVars : {};
  for (const v of manifest?.env_vars || []) {
    if (!v || v.check !== "not_breached") continue;
    const val = vals[v.name];
    if (val === undefined || val === null || val === "") continue;
    const sha = createHash("sha1").update(String(val)).digest("hex").toUpperCase();
    let text;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetchImpl(`https://api.pwnedpasswords.com/range/${sha.slice(0, 5)}`, { signal: ctl.signal, headers: { "Add-Padding": "true" } });
      clearTimeout(timer);
      if (!r.ok) continue;
      text = await r.text();
    } catch {
      continue;
    }
    for (const line of String(text).split("\n")) {
      const [suffix, count] = line.trim().split(":");
      if (suffix === sha.slice(5) && Number(count) > 0) {
        return { key: v.name, why: "appears in known data breaches (haveibeenpwned.com), so the app's password policy would reject it; choose another" };
      }
    }
  }
  return null;
}

/** First supplied value breaking its manifest `pattern`, or null. Names the KEY, never the value. */
export function envPatternViolation(manifest, envVars) {
  const vals = envVars && typeof envVars === "object" ? envVars : {};
  for (const v of manifest?.env_vars || []) {
    if (!v || typeof v.pattern !== "string") continue;
    const val = vals[v.name];
    if (val === undefined || val === null || val === "") continue;
    let re;
    try { re = new RegExp(v.pattern); } catch { continue; }
    if (!re.test(String(val))) {
      return { key: v.name, why: v.pattern_hint ? `must be ${v.pattern_hint}` : "does not match the allowed format" };
    }
  }
  return null;
}
```

(b) `bundles.js` import line becomes:

```js
import { resolveGeneratedEnv, stripGeneratedKeys, writePrivateFile, gatewayExcludedKeys, envPatternViolation, breachedValueViolation } from "../bundle-env-secrets.js";
```

(c) `declaredEnvSubset`:

```js
export function declaredEnvSubset(manifest, envVars) {
  const excluded = gatewayExcludedKeys(manifest);
  const declared = new Set((manifest?.env_vars || []).map((v) => v && v.name).filter((n) => n && !excluded.has(n)));
  const subset = {};
  for (const [k, v] of Object.entries(envVars && typeof envVars === "object" ? envVars : {})) {
    if (declared.has(k)) subset[k] = v;
  }
  return subset;
}
```

(d) Replace the body of `installBlockingEnvKeys` from `const composePath = …` to the end with:

```js
  const composePath = join(APP_BUNDLES, bundleId, "docker-compose.yml");
  let text = "";
  try { if (existsSync(composePath)) text = readFileSync(composePath, "utf8"); } catch { /* unreadable → only install_required can block */ }
  const hard = hardFailComposeKeys(text);
  return (manifest?.env_vars || [])
    .filter((v) => v && typeof v.name === "string" && !v.generate && !nonBlankEnv(v.default)
      && (v.install_required === true || (v.required && hard.has(v.name))))
    .map((v) => v.name);
```

Extend its doc comment: ` * install_required: true blocks regardless of compose (a key used only by a post-install hook).`

(e) In `validateInstall`, directly after the `if (requireEnv) { … }` block:

```js
  // A supplied value that breaks its manifest pattern (e.g. an admin password with `$`
  // or a space) is refused BEFORE anything is copied — never a half-install.
  const badPattern = envPatternViolation(manifest, envVars);
  if (badPattern) {
    return {
      ok: false, status: 400, code: "invalid_env",
      error: `Environment variable '${badPattern.key}' ${badPattern.why}`,
      extra: { code: "invalid_env", key: badPattern.key },
    };
  }
  const breached = await breachedValueViolation(manifest, envVars, { fetchImpl: _breachFetchForTest || globalThis.fetch });
  if (breached) {
    return {
      ok: false, status: 400, code: "invalid_env",
      error: `Environment variable '${breached.key}' ${breached.why}`,
      extra: { code: "invalid_env", key: breached.key },
    };
  }
```

Add the test seam next to the other `_set…ForTest` exports:

```js
// Test-only: replace the HIBP range fetch used by env_vars[].check "not_breached".
let _breachFetchForTest = null;
export function _setBreachFetchForTest(fn) { _breachFetchForTest = fn || null; }
```

(f) Configure route, directly after the existing `findInvalidEnv` 400 block:

```js
      const badPattern = envPatternViolation(getInstalledFirstManifest(bundle_id), env_vars);
      if (badPattern) {
        return res.status(400).json({ code: "invalid_env", key: badPattern.key, error: `Environment variable '${badPattern.key}' ${badPattern.why}` });
      }
```

(g) `html.js` line 438: `env_vars: (addon.env_vars || []).filter((ev) => !ev.generate).map((ev) => ({`.

(h) Schema, `env_vars.items.properties`:

```json
          "propagate": { "type": "boolean" },
          "install_required": { "type": "boolean" },
          "check": { "type": "string", "enum": ["not_breached"] },
          "pattern": { "type": "string", "pattern": "^\\^.*\\$$" },
          "pattern_hint": { "type": "string" },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/bundle-env-scoping.test.js tests/bundle-env-secrets.test.js tests/bundles-validate-install.test.js tests/bundles-install-hardening.test.js tests/extensions-page-render.test.js tests/extensions-needs-config.test.js tests/bundle-contract.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/bundle-env-scoping.test.js
git commit servers/gateway/bundle-env-secrets.js servers/gateway/routes/bundles.js servers/gateway/dashboard/panels/extensions/html.js registry/manifest.schema.json tests/bundle-env-scoping.test.js \
  -m "feat(bundles): env scoping — propagate:false, anchored pattern gate, install_required, generated keys hidden"
git show --stat HEAD
```

---

### Task 3: Lifecycle hooks and the compose-project ownership guard

**Files:**
- Create: `servers/gateway/bundle-lifecycle.js`
- Modify: `servers/gateway/routes/bundles.js`:
  - imports and seams;
  - `runInstallJob` docker branch and tail;
  - `dispatchBundleAction` (local start/stop, ~2986);
  - uninstall job (~2768);
  - `refreshVersionedBundle` (~720).
- Modify: `scripts/lib/bundle-contract.mjs`, `registry/manifest.schema.json`
- Test: `tests/bundle-lifecycle-hooks.test.js`

**Interfaces:**
- Consumes: `composeEnv`, `run`, `runCompose`, `_setComposeRunnerForTest`, `CROW_HOME`, `BUNDLES_DIR`.
- Produces:
  - `safeRelPath(p): string | null`
  - `precreateDirs(manifest, crowHome): string[]` (throws before creating anything if any entry is unsafe)
  - `postInstallPlan(manifest): null | { refused } | { script, timeoutMs }`
  - `hookEnv(destDir, crowHome, base = process.env): object`
  - `spawnGroup(cmd, args, { cwd, env, timeout, maxBuffer }): Promise<{ stdout, stderr }>`: its own process group, stdin ignored, the group is killed on timeout
  - `runPostInstall({ manifest, destDir, env, log, runner }): Promise<{ ok: true, skipped? } | { ok: false, reason, rerun? }>`
  - `composeProjectName(composeText, projectDir, envVars = {}): string`: the fallback resolver
  - `resolveComposeProject({ projectDir, composeText, envVars, runner, env }): Promise<string>`: `docker compose config --format json` first
  - `classifyProjectOwners({ project, projectDir, bundleId, crowHome, runner }): Promise<{ owner: string | null, unrelated: string[] }>`
  - bundles.js: `composeOwnershipCheck(bundleId): Promise<{ project, refusal: string | null, warning: string | null }>` (read-only; exported for the Task 8 live check)
  - `pullTimeoutMs(manifest): number | undefined`
  - bundles.js seams: `_setHookRunnerForTest(fn)`, `_setDockerRunnerForTest(fn)`
  - Manifest fields: `docker.precreate`, `docker.pull_timeout_s` (≤3600), `postInstall { script, timeout_s ≤1800 }`
  - Hook runtime contract (Task 5 relies on it): `bash <destDir>/<script>`, `cwd` = destDir, env = `hookEnv(...)`, stdin `/dev/null`

- [ ] **Step 1: Write the failing test**

Create `tests/bundle-lifecycle-hooks.test.js`:

```js
/** Bundle lifecycle hooks + compose-project ownership (Crow Workspace W1, Task 3). Scratch CROW_HOME before import. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-hooks-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-hooks-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
const CROW_HOME = process.env.CROW_HOME;

const L = await import("../servers/gateway/bundle-lifecycle.js");
const B = await import("../servers/gateway/routes/bundles.js");
const { validateManifest } = await import("../scripts/lib/bundle-contract.mjs");

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-hooks-app-"));
B._setAppBundlesForTest(FIXTURES);
const ownerless = async () => ({ stdout: "", stderr: "" }); // `docker ps` → no containers
after(() => {
  B._setComposeRunnerForTest(null); B._setHookRunnerForTest(null); B._setDockerRunnerForTest(null);
  rmSync(CROW_HOME, { recursive: true, force: true });
  rmSync(FIXTURES, { recursive: true, force: true });
});

const COMPOSE = "services:\n  app:\n    image: busybox:1.36\n    restart: unless-stopped\n";
function fixture(id, manifest, compose = COMPOSE) {
  const dir = join(FIXTURES, id);
  mkdirSync(join(dir, "ops"), { recursive: true });
  const full = { id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.1.0", docker: { composefile: "docker-compose.yml" }, ...manifest };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(full));
  writeFileSync(join(dir, "docker-compose.yml"), compose);
  writeFileSync(join(dir, "ops", "bootstrap.sh"), "#!/usr/bin/env bash\necho ok\n");
  return full;
}
async function install(id, manifest) {
  const job = B._createJobForTest(id, "install");
  const out = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
  return { out, job };
}
const installedIds = () => (existsSync(join(CROW_HOME, "installed.json")) ? JSON.parse(readFileSync(join(CROW_HOME, "installed.json"), "utf8")).map((i) => i.id) : []);

test("safeRelPath accepts plain relative paths only", () => {
  assert.equal(L.safeRelPath("workspace/backups-staging"), "workspace/backups-staging");
  for (const bad of ["", "/etc", "../x", "a/../../x", null, 3]) assert.equal(L.safeRelPath(bad), null, String(bad));
});

test("precreateDirs makes 0700 dirs under CROW_HOME and validates every entry first", () => {
  const home = mkdtempSync(join(tmpdir(), "pc-"));
  assert.deepEqual(L.precreateDirs({ docker: { precreate: ["ws", "ws/staging"] } }, home), [join(home, "ws"), join(home, "ws/staging")]);
  assert.equal(statSync(join(home, "ws")).mode & 0o777, 0o700);
  assert.throws(() => L.precreateDirs({ docker: { precreate: ["ok-first", "../escape"] } }, home), /relative path inside CROW_HOME/);
  assert.equal(existsSync(join(home, "ok-first")), false);
});

test("postInstallPlan: none, community refusal, bad path, default and clamped timeout", () => {
  assert.equal(L.postInstallPlan({}), null);
  assert.match(L.postInstallPlan({ origin: "community", postInstall: { script: "ops/x.sh" } }).refused, /first-party/);
  assert.match(L.postInstallPlan({ postInstall: { script: "../x.sh" } }).refused, /relative \.sh path/);
  assert.match(L.postInstallPlan({ postInstall: { script: "ops/x.py" } }).refused, /relative \.sh path/);
  assert.deepEqual(L.postInstallPlan({ postInstall: { script: "ops/x.sh" } }), { script: "ops/x.sh", timeoutMs: 600_000 });
  assert.equal(L.postInstallPlan({ postInstall: { script: "ops/x.sh", timeout_s: 99999 } }).timeoutMs, 1_800_000);
});

test("hookEnv is minimal: PATH/HOME/DOCKER_* + CROW_HOME + CROW_BUNDLE_DIR, nothing else from the gateway", () => {
  const env = L.hookEnv("/b/ws", "/h", { PATH: "/usr/bin", HOME: "/home/k", DOCKER_HOST: "unix:///x", ANTHROPIC_API_KEY: "sk-no", CROW_DB_PATH: "/db", USER: "k" });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/k", USER: "k", DOCKER_HOST: "unix:///x", CROW_HOME: "/h", CROW_BUNDLE_DIR: "/b/ws" });
});

test("spawnGroup kills the whole process group on timeout (no orphaned grandchildren)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grp-"));
  const pidFile = join(dir, "child.pid");
  const t0 = Date.now();
  await assert.rejects(L.spawnGroup("bash", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], { env: { PATH: process.env.PATH }, timeout: 500 }));
  assert.ok(Date.now() - t0 < 15_000);
  const pid = Number(readFileSync(pidFile, "utf8"));
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(pid, 0), "grandchild must be dead");
});

test("runPostInstall: bash <abs script>, cwd, env, timeout; failure carries a stderr tail and a re-run command", async () => {
  const dest = mkdtempSync(join(tmpdir(), "rp-"));
  mkdirSync(join(dest, "ops")); writeFileSync(join(dest, "ops", "b.sh"), "echo hi\n");
  const calls = []; const logs = [];
  const ok = await L.runPostInstall({
    manifest: { postInstall: { script: "ops/b.sh", timeout_s: 5 } }, destDir: dest, env: { CROW_HOME: "/h" },
    log: (m) => logs.push(m), runner: async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { stdout: "step one\nstep two\n", stderr: "" }; },
  });
  assert.deepEqual(ok, { ok: true });
  assert.equal(calls[0].cmd, "bash");
  assert.deepEqual(calls[0].args, [join(dest, "ops", "b.sh")]);
  assert.equal(calls[0].opts.cwd, dest);
  assert.equal(calls[0].opts.timeout, 5000);
  assert.ok(logs.some((l) => l.includes("step two")));
  const bad = await L.runPostInstall({
    manifest: { postInstall: { script: "ops/b.sh" } }, destDir: dest, env: {}, log: () => {},
    runner: async () => { throw Object.assign(new Error("exit 1"), { stdout: "", stderr: "Nextcloud not ready after 600s" }); },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /post-install setup failed: .*Nextcloud not ready/);
  assert.equal(bad.rerun, `bash ${join(dest, "ops", "b.sh")}`);
});

test("composeProjectName fallback: COMPOSE_PROJECT_NAME > interpolated name: > dirname", () => {
  assert.equal(L.composeProjectName("name: crow-workspace\nservices: {}\n", "/x/bundles/workspace"), "crow-workspace");
  assert.equal(L.composeProjectName("services: {}\n", "/x/bundles/Work Space"), "workspace");
  const browser = "name: ${CROW_BROWSER_CONTAINER_NAME:-browser}\nservices: {}\n";
  assert.equal(L.composeProjectName(browser, "/h/bundles/browser", {}), "browser");
  assert.equal(L.composeProjectName(browser, "/h/bundles/browser", { CROW_BROWSER_CONTAINER_NAME: "crow-browser-x" }), "crow-browser-x");
  assert.equal(L.composeProjectName(browser, "/h/bundles/browser", { COMPOSE_PROJECT_NAME: "crow-browser-r4" }), "crow-browser-r4");
});

test("resolveComposeProject prefers `docker compose config` and falls back when it fails", async () => {
  const ok = async (cmd, args) => (args[0] === "compose" ? { stdout: JSON.stringify({ name: "crow-browser-r4" }), stderr: "" } : { stdout: "", stderr: "" });
  assert.equal(await L.resolveComposeProject({ projectDir: "/h/bundles/browser", composeText: "services: {}\n", envVars: {}, runner: ok }), "crow-browser-r4");
  const down = async () => { throw new Error("no docker"); };
  assert.equal(await L.resolveComposeProject({ projectDir: "/h/bundles/browser", composeText: "services: {}\n", envVars: { COMPOSE_PROJECT_NAME: "crow-browser-r4" }, runner: down }), "crow-browser-r4");
});

test("classifyProjectOwners: only another Crow install OF THIS BUNDLE is an owner; legacy paths are unrelated", async () => {
  const mine = mkdtempSync(join(tmpdir(), "own-mine-"));
  const otherHome = mkdtempSync(join(tmpdir(), "own-otherhome-"));
  mkdirSync(join(otherHome, "bundles", "ws"), { recursive: true });
  writeFileSync(join(otherHome, "installed.json"), JSON.stringify([{ id: "ws", type: "bundle" }]));
  const notInstalledHome = mkdtempSync(join(tmpdir(), "own-stale-"));
  mkdirSync(join(notInstalledHome, "bundles", "ws"), { recursive: true });
  const mk = (stdout) => async () => ({ stdout, stderr: "" });
  const args = (stdout) => ({ project: "p", projectDir: mine, bundleId: "ws", crowHome: join(mine, ".."), runner: mk(stdout) });
  assert.deepEqual(await L.classifyProjectOwners(args(`${otherHome}/bundles/ws\n`)), { owner: `${otherHome}/bundles/ws`, unrelated: [] });
  assert.deepEqual(await L.classifyProjectOwners(args("/home/k/crow-addons/llamacpp-vulkan-qwen36-35b-a3b\n")), { owner: null, unrelated: ["/home/k/crow-addons/llamacpp-vulkan-qwen36-35b-a3b"] });
  assert.deepEqual(await L.classifyProjectOwners(args("/home/k/crow/bundles/ws\n")), { owner: null, unrelated: ["/home/k/crow/bundles/ws"] }, "a repo checkout path has no installed.json listing → legacy");
  assert.deepEqual(await L.classifyProjectOwners(args(`${notInstalledHome}/bundles/ws\n`)), { owner: null, unrelated: [`${notInstalledHome}/bundles/ws`] });
  assert.deepEqual(await L.classifyProjectOwners(args(`${otherHome}/bundles/other-id\n`)), { owner: null, unrelated: [`${otherHome}/bundles/other-id`] });
  assert.deepEqual(await L.classifyProjectOwners(args(`${mine}\n${mine}\n`)), { owner: null, unrelated: [] });
  assert.deepEqual(await L.classifyProjectOwners({ ...args(""), runner: async () => { throw new Error("no docker"); } }), { owner: null, unrelated: [] });
});

test("install: precreate, pull/up with opt-in long timeout, hook AFTER installed.json, minimal env", async () => {
  B._setDockerRunnerForTest(ownerless);
  const m = fixture("hk-ok", { docker: { composefile: "docker-compose.yml", precreate: ["hk-ok-data"], pull_timeout_s: 1800 }, postInstall: { script: "ops/bootstrap.sh", timeout_s: 30 } });
  const order = [];
  B._setComposeRunnerForTest(async (args, opts) => { order.push({ step: args[0], timeout: opts.timeout }); return { stdout: "", stderr: "" }; });
  B._setHookRunnerForTest(async (cmd, args, opts) => { order.push({ step: "hook", env: opts.env, cwd: opts.cwd, recorded: installedIds().includes("hk-ok") }); return { stdout: "done\n", stderr: "" }; });
  const { out } = await install("hk-ok", m);
  assert.equal(out.ok, true, out.reason);
  assert.ok(existsSync(join(CROW_HOME, "hk-ok-data")));
  assert.deepEqual(order.map((o) => o.step), ["pull", "up", "hook"]);
  assert.equal(order[0].timeout, 1_800_000);
  assert.equal(order[1].timeout, 1_800_000);
  assert.equal(order[2].recorded, true, "installed.json is written BEFORE the hook runs");
  assert.equal(order[2].env.CROW_BUNDLE_DIR, join(CROW_HOME, "bundles", "hk-ok"));
  assert.equal(order[2].env.CROW_HOME, CROW_HOME);
  assert.equal(order[2].env.CROW_DATA_DIR, undefined, "no gateway env leaks into the hook");
});

test("install: no pull_timeout_s → compose keeps run()'s default timeout", async () => {
  B._setDockerRunnerForTest(ownerless);
  const seen = [];
  B._setComposeRunnerForTest(async (args, opts) => { seen.push(opts.timeout); return { stdout: "", stderr: "" }; });
  B._setHookRunnerForTest(null);
  const { out } = await install("hk-default", fixture("hk-default", {}));
  assert.equal(out.ok, true, out.reason);
  assert.deepEqual(seen, [undefined, undefined]);
});

test("install: a failing hook keeps the bundle installed, ends not-ok, and logs the re-run command", async () => {
  B._setDockerRunnerForTest(ownerless);
  B._setComposeRunnerForTest(async () => ({ stdout: "", stderr: "" }));
  B._setHookRunnerForTest(async () => { throw Object.assign(new Error("exit 1"), { stderr: "boom" }); });
  const { out, job } = await install("hk-fail", fixture("hk-fail", { postInstall: { script: "ops/bootstrap.sh" } }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /post-install setup failed: .*boom/);
  assert.ok(installedIds().includes("hk-fail"));
  assert.ok(B._getJobForTest(job.id).log.some((l) => l.includes(`bash ${join(CROW_HOME, "bundles", "hk-fail", "ops", "bootstrap.sh")}`)));
});

test("install: compose up failure → hook never runs; community bundle → hook refused", async () => {
  B._setDockerRunnerForTest(ownerless);
  let hookCalls = 0;
  B._setHookRunnerForTest(async () => { hookCalls++; return { stdout: "", stderr: "" }; });
  B._setComposeRunnerForTest(async (args) => { if (args[0] === "up") throw Object.assign(new Error("x"), { stderr: "port busy" }); return { stdout: "", stderr: "" }; });
  await install("hk-upfail", fixture("hk-upfail", { postInstall: { script: "ops/bootstrap.sh" } }));
  B._setComposeRunnerForTest(async () => ({ stdout: "", stderr: "" }));
  const { out } = await install("hk-comm", fixture("hk-comm", { origin: "community", postInstall: { script: "ops/bootstrap.sh" } }));
  assert.equal(hookCalls, 0);
  assert.equal(out.ok, false);
  assert.match(out.reason, /first-party/);
});

test("install: an unsafe precreate entry refuses the install and removes the copied files", async () => {
  B._setDockerRunnerForTest(ownerless);
  B._setComposeRunnerForTest(async () => ({ stdout: "", stderr: "" }));
  const { out } = await install("hk-esc", fixture("hk-esc", { docker: { composefile: "docker-compose.yml", precreate: ["../outside"] } }));
  assert.equal(out.ok, false);
  assert.equal(existsSync(join(CROW_HOME, "bundles", "hk-esc")), false);
});

test("REVIEW FOCUS 6 — a second instance cannot adopt another instance's compose project", async () => {
  const id = "hk-owned";
  const m = fixture(id, { postInstall: { script: "ops/bootstrap.sh" } }, "name: crow-shared\nservices:\n  app:\n    image: busybox:1.36\n");
  const composeCalls = [];
  B._setComposeRunnerForTest(async (args) => { composeCalls.push(args[0]); return { stdout: "", stderr: "" }; });
  // The household's install lives in ANOTHER Crow home that really lists this bundle.
  const otherHome = mkdtempSync(join(tmpdir(), "hk-otherhome-"));
  mkdirSync(join(otherHome, "bundles", id), { recursive: true });
  writeFileSync(join(otherHome, "installed.json"), JSON.stringify([{ id, type: "bundle", version: "0.1.0" }]));
  const dockerCalls = [];
  B._setDockerRunnerForTest(async (cmd, args) => {
    dockerCalls.push(args);
    if (args[0] === "compose") throw new Error("config unavailable"); // exercise the fallback resolver
    return { stdout: `${otherHome}/bundles/${id}\n`, stderr: "" };
  });
  // install refused, nothing started, copied files removed
  const { out } = await install(id, m);
  assert.equal(out.ok, false);
  assert.ok(out.reason.includes(`belong to another Crow install on this host (${otherHome}/bundles/${id})`), out.reason);
  assert.deepEqual(composeCalls, []);
  assert.ok(dockerCalls.some((a) => a.includes("label=com.docker.compose.project=crow-shared")));
  assert.equal(existsSync(join(CROW_HOME, "bundles", id)), false);
  // a copy that IS installed here (older install) cannot start/stop/down the foreign project
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
  writeFileSync(join(dir, "docker-compose.yml"), "name: crow-shared\nservices:\n  app:\n    image: busybox:1.36\n");
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([...installedIds().map((i) => ({ id: i })), { id, type: "bundle", version: "0.1.0" }]));
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    for (const action of ["start", "stop"]) {
      const r = await post(`/bundles/api/${action}`, { bundle_id: id });
      assert.equal(r.status, 409, `${action}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /another Crow install/);
    }
    const u = await post("/bundles/api/uninstall", { bundle_id: id });
    assert.equal(u.status, 200);
    const deadline = Date.now() + 10_000;
    while (existsSync(dir) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  } finally { server.close(); }
  assert.deepEqual(composeCalls, [], "no up/stop/down ever reached the foreign project");
  assert.equal(existsSync(dir), false, "this instance's own files are still removed");
});

async function startBundle(id) {
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/bundles/api/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle_id: id }) });
    return { status: r.status, body: await r.json() };
  } finally { server.close(); }
}
function seedInstalledCompose(id, compose, envText) {
  const m = fixture(id, {}, compose);
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
  writeFileSync(join(dir, "docker-compose.yml"), compose);
  if (envText) writeFileSync(join(dir, ".env"), envText, { mode: 0o600 });
  return dir;
}

test("regression (R4 browser): COMPOSE_PROJECT_NAME in .env selects the project; crow's copy of the same bundle is NOT an owner", async () => {
  const id = "hk-browser";
  const dir = seedInstalledCompose(id, "name: ${CROW_BROWSER_CONTAINER_NAME:-hk-browser}\nservices:\n  app:\n    image: busybox:1.36\n", "COMPOSE_PROJECT_NAME=crow-hk-browser-r4\n");
  const crowHome = mkdtempSync(join(tmpdir(), "hk-crowhome-"));
  mkdirSync(join(crowHome, "bundles", id), { recursive: true });
  writeFileSync(join(crowHome, "installed.json"), JSON.stringify([{ id }]));
  for (const configWorks of [true, false]) {
    const filters = [];
    B._setDockerRunnerForTest(async (cmd, args) => {
      if (args[0] === "compose") { if (!configWorks) throw new Error("no config"); return { stdout: JSON.stringify({ name: "crow-hk-browser-r4" }), stderr: "" }; }
      const f = args.find((a) => a.startsWith("label=")); filters.push(f);
      // crow's own browser project ("hk-browser") belongs to crow's home; R4's project is ours.
      return { stdout: f.endsWith("=hk-browser") ? `${crowHome}/bundles/${id}\n` : `${dir}\n`, stderr: "" };
    });
    const calls = [];
    B._setComposeRunnerForTest(async (args) => { calls.push(args[0]); return { stdout: "", stderr: "" }; });
    const r = await startBundle(id);
    assert.equal(r.status, 200, `configWorks=${configWorks}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(filters, ["label=com.docker.compose.project=crow-hk-browser-r4"]);
    assert.deepEqual(calls, ["up"]);
  }
});

test("regression (legacy provenance): containers started from ~/crow-addons or a repo checkout stay controllable", async () => {
  const id = "hk-legacy";
  seedInstalledCompose(id, "services:\n  app:\n    image: busybox:1.36\n");
  for (const legacy of ["/home/k/crow-addons/hk-legacy", "/home/k/crow/bundles/hk-legacy"]) {
    B._setDockerRunnerForTest(async (cmd, args) => (args[0] === "compose" ? { stdout: JSON.stringify({ name: "hk-legacy" }), stderr: "" } : { stdout: `${legacy}\n`, stderr: "" }));
    const calls = [];
    B._setComposeRunnerForTest(async (args) => { calls.push(args[0]); return { stdout: "", stderr: "" }; });
    const r = await startBundle(id);
    assert.equal(r.status, 200, `${legacy}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(calls, ["up"]);
  }
});

test("version-bump refresh re-copies the hook script's directory for a docker bundle", async () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-repo-"));
  const id = "hk-refresh";
  mkdirSync(join(repo, id, "ops"), { recursive: true });
  writeFileSync(join(repo, id, "manifest.json"), JSON.stringify({ id, type: "bundle", version: "0.2.0", docker: { composefile: "docker-compose.yml" }, postInstall: { script: "ops/bootstrap.sh" } }));
  writeFileSync(join(repo, id, "ops", "bootstrap.sh"), "echo v2\n");
  const dest = join(CROW_HOME, "bundles", id);
  mkdirSync(join(dest, "ops"), { recursive: true });
  writeFileSync(join(dest, "manifest.json"), JSON.stringify({ id, type: "bundle", version: "0.1.0", docker: { composefile: "docker-compose.yml" }, postInstall: { script: "ops/bootstrap.sh" } }));
  writeFileSync(join(dest, "ops", "bootstrap.sh"), "echo v1\n");
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([{ id, type: "bundle", version: "0.1.0" }]));
  await B.repairInstalledBundleAssets({ appBundles: repo, run: async () => ({ stdout: "", stderr: "" }) });
  assert.equal(readFileSync(join(dest, "ops", "bootstrap.sh"), "utf8"), "echo v2\n");
});

test("contract: missing postInstall script and unsafe precreate are manifest errors", () => {
  const root = mkdtempSync(join(tmpdir(), "hk-contract-"));
  const dir = join(root, "c1"); mkdirSync(dir);
  writeFileSync(join(dir, "docker-compose.yml"), COMPOSE);
  const r = validateManifest({ id: "c1", name: "c", description: "d", type: "bundle", category: "x", docker: { composefile: "docker-compose.yml", precreate: ["/abs"] }, postInstall: { script: "ops/missing.sh" } }, dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('postInstall.script "ops/missing.sh" not found')), r.errors.join("; "));
  assert.ok(r.errors.some((e) => e.includes('docker.precreate "/abs"')), r.errors.join("; "));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/bundle-lifecycle-hooks.test.js`
Expected: FAIL: `Cannot find module '…/servers/gateway/bundle-lifecycle.js'`.

- [ ] **Step 3: Implement `servers/gateway/bundle-lifecycle.js`**

```js
/**
 * Bundle lifecycle hooks + compose-project ownership — generic, manifest-declared.
 *
 *   docker.precreate: ["ws", "ws/staging"]   dirs under CROW_HOME created 0700 BEFORE
 *     `compose up` (Docker creates a missing bind source as ROOT).
 *   docker.pull_timeout_s: 1800               opt-in long pull/up (default: run()'s 300 s).
 *   postInstall: { script: "ops/bootstrap.sh", timeout_s: 1500 }
 *     `bash <installed bundle>/<script>` after a SUCCESSFUL `compose up -d` AND after the
 *     install is recorded; own process group (the whole group dies on timeout), stdin
 *     /dev/null, minimal env. Community bundles (origin: "community") are refused.
 *
 * Ownership: compose identifies a project by NAME only. Two Crow instances on one host
 * (crow + R4 share ~/crow) would otherwise recreate/stop/down each other's containers.
 * classifyProjectOwners() reads the working_dir label of every container in the project and
 * refuses only for another Crow install of the SAME bundle; legacy provenance only warns.
 */
import { mkdirSync, existsSync, realpathSync, readFileSync } from "node:fs";
import { join, isAbsolute, normalize, basename } from "node:path";
import { spawn } from "node:child_process";

export const POST_INSTALL_MAX_TIMEOUT_S = 1800;
const POST_INSTALL_DEFAULT_TIMEOUT_S = 600;
const PULL_TIMEOUT_MAX_S = 3600;

export function safeRelPath(p) {
  if (typeof p !== "string" || p === "" || isAbsolute(p)) return null;
  const n = normalize(p);
  if (n.split(/[\\/]/).includes("..")) return null;
  return n;
}

export function precreateDirs(manifest, crowHome) {
  const rels = (manifest?.docker?.precreate || []).map((p) => {
    const rel = safeRelPath(p);
    if (!rel) throw new Error(`docker.precreate entry "${p}" must be a relative path inside CROW_HOME`);
    return rel;
  });
  return rels.map((rel) => {
    const abs = join(crowHome, rel);
    mkdirSync(abs, { recursive: true, mode: 0o700 });
    return abs;
  });
}

export function pullTimeoutMs(manifest) {
  const t = manifest?.docker?.pull_timeout_s;
  return Number.isInteger(t) && t > 0 ? Math.min(t, PULL_TIMEOUT_MAX_S) * 1000 : undefined;
}

export function postInstallPlan(manifest) {
  const h = manifest?.postInstall;
  if (!h) return null;
  if (manifest.origin === "community") return { refused: "post-install hooks run host shell code and are honored for first-party bundles only" };
  const script = safeRelPath(h.script);
  if (!script || !script.endsWith(".sh")) return { refused: `postInstall.script "${h.script}" must be a relative .sh path inside the bundle` };
  const t = Number.isInteger(h.timeout_s) ? h.timeout_s : POST_INSTALL_DEFAULT_TIMEOUT_S;
  return { script, timeoutMs: Math.min(Math.max(t, 1), POST_INSTALL_MAX_TIMEOUT_S) * 1000 };
}

const HOOK_ENV_KEYS = ["PATH", "HOME", "USER", "LANG", "XDG_RUNTIME_DIR"];
/** The hook sees only what docker/compose need — never the gateway's API keys or DB paths. */
export function hookEnv(destDir, crowHome, base = process.env) {
  const env = {};
  for (const k of HOOK_ENV_KEYS) if (base[k] !== undefined) env[k] = base[k];
  for (const [k, v] of Object.entries(base)) if (k.startsWith("DOCKER_")) env[k] = v;
  env.CROW_HOME = crowHome;
  env.CROW_BUNDLE_DIR = destDir;
  return env;
}

/** execFile-like, but in its own process group: a timeout kills the whole group. */
export function spawnGroup(cmd, args, { cwd, env, timeout, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let timedOut = false; let killTimer = null;
    const cap = (s, d) => (s.length > maxBuffer ? s : s + d);
    child.stdout.on("data", (d) => { stdout = cap(stdout, d); });
    child.stderr.on("data", (d) => { stderr = cap(stderr, d); });
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const timer = timeout ? setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 10_000);
    }, timeout) : null;
    child.on("error", (err) => { clearTimeout(timer); clearTimeout(killTimer); reject(Object.assign(err, { stdout, stderr })); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) { clearTimeout(killTimer); killGroup("SIGKILL"); }
      if (code === 0 && !timedOut) return resolve({ stdout, stderr });
      const why = timedOut ? `timed out after ${Math.round(timeout / 1000)}s` : `exit ${code ?? signal}`;
      reject(Object.assign(new Error(why), { stdout, stderr: `${stderr}\n${why}` }));
    });
  });
}

function tailLines(text, n) {
  return String(text || "").split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-n);
}

/** Never throws. */
export async function runPostInstall({ manifest, destDir, env, log, runner }) {
  const plan = postInstallPlan(manifest);
  if (!plan) return { ok: true, skipped: true };
  if (plan.refused) return { ok: false, reason: plan.refused };
  const abs = join(destDir, plan.script);
  if (!existsSync(abs)) return { ok: false, reason: `post-install script ${plan.script} is missing from the bundle` };
  const rerun = `bash ${abs}`;
  log(`Running post-install setup (${plan.script}, up to ${plan.timeoutMs / 1000}s)…`);
  try {
    const { stdout } = await runner("bash", [abs], { cwd: destDir, env, timeout: plan.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    for (const line of tailLines(stdout, 40)) log(`  ${line}`);
    return { ok: true };
  } catch (err) {
    const tail = tailLines(`${err?.stdout || ""}\n${err?.stderr || err?.message || ""}`, 8).join(" | ");
    return { ok: false, reason: `post-install setup failed: ${tail || "no output"}`, rerun };
  }
}

const normProject = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]/g, "");

/**
 * Fallback project name when `docker compose config` cannot run: COMPOSE_PROJECT_NAME
 * from the project .env, then a top-level `name:` with ${VAR}/${VAR:-default} resolved
 * against that .env, then the normalized dirname — compose's own precedence.
 */
export function composeProjectName(composeText, projectDir, envVars = {}) {
  if (envVars.COMPOSE_PROJECT_NAME) return normProject(envVars.COMPOSE_PROJECT_NAME);
  const m = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(String(composeText || ""));
  if (m) {
    const v = m[1].replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/g, (_, k, d) => envVars[k] || d || "");
    if (normProject(v)) return normProject(v);
  }
  return normProject(basename(String(projectDir)));
}

/** The project compose itself would use (`config --format json` → .name), else the fallback. */
export async function resolveComposeProject({ projectDir, composeText, envVars = {}, runner, env }) {
  try {
    const { stdout } = await runner("docker", ["compose", "config", "--format", "json"], { cwd: projectDir, env, timeout: 15_000 });
    const name = JSON.parse(String(stdout || "{}")).name;
    if (name) return name;
  } catch { /* docker down or an unset :? var — fall back */ }
  return composeProjectName(composeText, projectDir, envVars);
}

function realOrSelf(p) { try { return realpathSync(p); } catch { return p; } }

function installedListsId(installedPath, id) {
  try {
    const d = JSON.parse(readFileSync(installedPath, "utf8"));
    const arr = Array.isArray(d) ? d : Object.entries(d).map(([k, v]) => ({ id: k, ...v }));
    return arr.some((e) => (typeof e === "string" ? e : e && e.id) === id);
  } catch {
    return false;
  }
}

/**
 * Who else has containers in `project`?
 *   owner     — another Crow install OF THIS BUNDLE: <H>/bundles/<id>[/subdir], H ≠ crowHome,
 *               and <H>/installed.json lists <id>. Callers refuse.
 *   unrelated — every other foreign working_dir (a legacy ~/crow-addons path, a repo
 *               checkout, a stale home). Callers warn and proceed, exactly as before.
 * Docker unreachable → nobody (compose will fail on its own).
 */
export async function classifyProjectOwners({ project, projectDir, bundleId, crowHome, runner }) {
  let stdout = "";
  try {
    ({ stdout } = await runner("docker", ["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", '{{.Label "com.docker.compose.project.working_dir"}}'], { timeout: 15_000 }));
  } catch {
    return { owner: null, unrelated: [] };
  }
  const mine = realOrSelf(projectDir);
  const myHome = realOrSelf(crowHome);
  const marker = `/bundles/${bundleId}`;
  let owner = null;
  const unrelated = [];
  for (const d of [...new Set(String(stdout).split("\n").map((l) => l.trim()).filter(Boolean))]) {
    const r = realOrSelf(d);
    if (r === mine) continue;
    const at = r.lastIndexOf(marker);
    const rest = at >= 0 ? r.slice(at + marker.length) : null;
    const home = at >= 0 && (rest === "" || rest.startsWith("/")) ? r.slice(0, at) : null;
    if (!owner && home && home !== myHome && installedListsId(join(home, "installed.json"), bundleId)) owner = d;
    else unrelated.push(d);
  }
  return { owner, unrelated };
}
```

- [ ] **Step 4: Wire into `servers/gateway/routes/bundles.js`**

(a) Imports, next to the Task 1 import:

```js
import { precreateDirs, runPostInstall, hookEnv, spawnGroup, pullTimeoutMs, resolveComposeProject, classifyProjectOwners } from "../bundle-lifecycle.js";
import { parseEnvText } from "../bundle-env-secrets.js";
```

(b) After the `_setComposeRunnerForTest` export, add the seams and a guard helper:

```js
// Test-only: replace the post-install hook runner / the `docker` CLI runner.
let _hookRunnerForTest = null;
export function _setHookRunnerForTest(fn) { _hookRunnerForTest = fn || null; }
let _dockerRunnerForTest = null;
export function _setDockerRunnerForTest(fn) { _dockerRunnerForTest = fn || null; }

/**
 * Ownership of this bundle's compose project. refusal: another Crow install of the SAME
 * bundle on this host owns it (callers refuse). warning: containers from a legacy path
 * share the project (callers log and proceed, as before this guard existed).
 */
async function composeOwnership(bundleId, bundleDir, manifest) {
  const rel = manifestComposeFile(manifest) || "docker-compose.yml";
  let text = "";
  try { text = readFileSync(join(bundleDir, rel), "utf8"); } catch { return { project: null, refusal: null, warning: null }; }
  const projectDir = join(bundleDir, dirname(rel));
  let envVars = {};
  try { envVars = parseEnvText(readFileSync(join(projectDir, ".env"), "utf8")); } catch { /* no .env */ }
  const runner = _dockerRunnerForTest || run;
  const project = await resolveComposeProject({ projectDir, composeText: text, envVars, runner, env: composeEnv() });
  const { owner, unrelated } = await classifyProjectOwners({ project, projectDir, bundleId, crowHome: CROW_HOME, runner });
  return {
    project,
    refusal: owner ? `This extension's containers (compose project "${project}") belong to another Crow install on this host (${owner}) — manage them from there.` : null,
    warning: unrelated.length ? `compose project "${project}" also has containers started from ${unrelated.join(", ")} (legacy path) — continuing` : null,
  };
}
/** Read-only, for operators and the pre-merge smoke: the guard's verdict for an installed bundle. */
export async function composeOwnershipCheck(bundleId) {
  return composeOwnership(bundleId, join(BUNDLES_DIR, bundleId), getInstalledFirstManifest(bundleId));
}
```

(c) In `runInstallJob`, next to `let composeFailure = null;`, add `let runHook = false;` and `let hookFailure = null;`.

(d) Docker branch: right after `appendLog(job, "Security check passed");`, insert:

```js
        const own = await composeOwnership(bundleId, destDir, manifest);
        if (own.refusal) {
          appendLog(job, `Install refused: ${own.refusal}`);
          rmSync(destDir, { recursive: true, force: true });
          return { ok: false, reason: own.refusal };
        }
        if (own.warning) appendLog(job, `Note: ${own.warning}`);
        try {
          const made = precreateDirs(manifest, CROW_HOME);
          if (made.length) appendLog(job, `Prepared data folders: ${made.map((p) => relativePath(CROW_HOME, p)).join(", ")}`);
        } catch (err) {
          appendLog(job, `Install refused: ${err.message}`);
          rmSync(destDir, { recursive: true, force: true });
          return { ok: false, reason: err.message };
        }
```

(e) Same branch: pass the opt-in timeout to both compose calls:

```js
          await runCompose(["pull"], { cwd: destDir, timeout: pullTimeoutMs(manifest) });
```

```js
          await runCompose(upArgs, { cwd: destDir, timeout: pullTimeoutMs(manifest) });
```

Note that `{ timeout: undefined }` spread over `run()`'s `{ timeout: 300_000, ...opts }` would *erase* the default. So change `run()` to `execFile(cmd, args, { ...opts, timeout: opts.timeout ?? 300_000 }, …)`.

(f) Right after the up `try { … } catch (err) { … }` block (still inside `if (existsSync(composePath))`), add:

```js
        runHook = !composeFailure && !!manifest?.postInstall;
```

(g) Directly after `saveInstalled(installedSnapshot); appendLog(job, "Installation tracked");` (step 6), insert:

```js
    // Post-install hook — AFTER the install is recorded, so a gateway restart mid-hook
    // leaves a recorded bundle + a re-runnable script, never orphan containers.
    if (runHook) {
      const hook = await runPostInstall({
        manifest, destDir: join(BUNDLES_DIR, bundleId),
        env: hookEnv(join(BUNDLES_DIR, bundleId), CROW_HOME),
        log: (m) => appendLog(job, m),
        runner: _hookRunnerForTest || spawnGroup,
      });
      if (!hook.ok) {
        hookFailure = hook.reason;
        appendLog(job, `Post-install setup did not finish: ${hook.reason}`);
        if (hook.rerun) appendLog(job, `Fix the cause, then re-run it: ${hook.rerun}`);
      }
    }
```

`destDir` is block-scoped inside the earlier `try`, so this uses `join(BUNDLES_DIR, bundleId)`, which is the same path.

(h) Tail: after the `if (composeFailure) { … return … }` block, before `return { ok: true, needsRestart };`:

```js
    if (hookFailure) {
      appendLog(job, `Installed and running, but setup is incomplete (${hookFailure.slice(0, 400)})`);
      return { ok: false, reason: hookFailure, needsRestart };
    }
```

(i) `dispatchBundleAction` local path: right after the `existsSync(composePath)` 404 check, add:

```js
    const own = await composeOwnership(bundleId, bundleDir, getInstalledFirstManifest(bundleId));
    if (own.refusal) return res.status(409).json({ error: own.refusal, code: "compose_project_foreign" });
    if (own.warning) console.warn(`[bundles] ${bundleId} ${action}: ${own.warning}`);
```

(j) Uninstall job: wrap the existing `if (existsSync(composePath)) { … runCompose(downArgs …) … }` so it first runs

```js
            const own = await composeOwnership(bundle_id, bundleDir, manifest);
            if (own.warning) appendLog(job, `Note: ${own.warning}`);
            if (own.refusal) {
              appendLog(job, `Containers left running: ${own.refusal}`);
            } else {
              /* existing "Stopping containers..." + runCompose(downArgs) block, unchanged */
            }
```

(k) `refreshVersionedBundle`: after `if (repoManifest.panelRoutes) declare(repoManifest.panelRoutes);`:

```js
  // The post-install hook's directory is code — refreshed on a version bump like panel/.
  if (repoManifest.postInstall?.script) declare(repoManifest.postInstall.script);
```

(l) `scripts/lib/bundle-contract.mjs`, step 3, after the skills loop:

```js
  if (manifest && manifest.postInstall && !fileExists(bundleDir, manifest.postInstall.script)) {
    errors.push(`postInstall.script "${manifest.postInstall.script}" not found`);
  }
  for (const p of (manifest && manifest.docker && Array.isArray(manifest.docker.precreate)) ? manifest.docker.precreate : []) {
    if (typeof p !== "string" || p === "" || isAbsolute(p) || p.split(/[\\/]/).includes("..")) {
      errors.push(`docker.precreate "${p}" must be a relative path inside CROW_HOME`);
    }
  }
```

(m) Schema: in `docker.properties`, add `"precreate": { "type": "array", "items": { "type": "string", "minLength": 1 } }` and `"pull_timeout_s": { "type": "integer", "minimum": 1, "maximum": 3600 }`. Then add a top-level property:

```json
    "postInstall": {
      "type": "object", "required": ["script"], "additionalProperties": false,
      "properties": {
        "script": { "type": "string", "minLength": 1, "pattern": "\\.sh$" },
        "timeout_s": { "type": "integer", "minimum": 1, "maximum": 1800 }
      }
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/bundle-lifecycle-hooks.test.js tests/bundle-env-secrets.test.js tests/bundle-version-refresh.test.js tests/bundles-install-job.test.js tests/bundles-install-hardening.test.js tests/bundles-webui-lifecycle.test.js tests/bundles-install-set.test.js tests/bundle-contract.test.js`, then `node scripts/build-registry.mjs --check`.
Expected: PASS. Existing install/uninstall tests stub compose but not docker: an unstubbed `docker ps` either finds no labeled containers or fails, and both mean "proceed". If a test host has docker and a real project named like a fixture, set `_setDockerRunnerForTest` in that file.

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/bundle-lifecycle.js tests/bundle-lifecycle-hooks.test.js
git commit servers/gateway/bundle-lifecycle.js servers/gateway/routes/bundles.js scripts/lib/bundle-contract.mjs registry/manifest.schema.json tests/bundle-lifecycle-hooks.test.js \
  -m "feat(bundles): compose-project ownership guard; post-record process-group postInstall hook; precreate; opt-in pull timeout"
git show --stat HEAD
```

---

### Task 4: The `workspace` bundle (manifest and compose), plus the `nextcloud` deprecation and port registries

**Files:**
- Create: `bundles/workspace/manifest.json`, `bundles/workspace/docker-compose.yml`
- Modify: `bundles/nextcloud/manifest.json`. Delete: `bundles/nextcloud/docker-compose.yml`
- Modify: `scripts/known-port-conflicts.json`, `docs/developers/port-allocation.md`, `docs/es/developers/port-allocation.md`, `registry/manifest.schema.json`
- Regenerate: `registry/add-ons.json`
- Test: `tests/workspace-bundle.test.js`

**Interfaces:**
- Consumes: manifest fields from Tasks 1–3.
- Produces (Tasks 5–8, 10):
  - Env keys:
    - `WORKSPACE_ADMIN_USER` (default `admin`)
    - `WORKSPACE_ADMIN_PASSWORD` (install_required; scrubbed by bootstrap)
    - generated: `WORKSPACE_FIRSTRUN_ADMIN_PASSWORD`, `WORKSPACE_DB_ROOT_PASSWORD`, `WORKSPACE_DB_PASSWORD`, `WORKSPACE_REDIS_PASSWORD`, `WORKSPACE_ONLYOFFICE_JWT_SECRET`
    - `WORKSPACE_PUBLIC_HOST`, `WORKSPACE_NC_SERVE_PORT` (8456), `WORKSPACE_OO_SERVE_PORT` (8457)
    - `WORKSPACE_BOT_APP_PASSWORD` is bootstrap-written and undeclared.
  - Compose:
    - project `crow-workspace`; network `crow-workspace_default` on `10.89.70.0/24`;
    - services `nextcloud`, `nextcloud-cron`, `nextcloud-db`, `nextcloud-redis`, `onlyoffice`;
    - binds `${CROW_HOME}/workspace/nextcloud` → `/var/www/html` and `${CROW_HOME}/workspace/db` → `/var/lib/mysql`.

- [ ] **Step 1: Write the failing test**

Create `tests/workspace-bundle.test.js`:

```js
/** Static checks of the Crow Workspace bundle (W1 Task 4). Text-level: the repo has no YAML parser. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";

const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, "bundles", "workspace");
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8"));
const compose = readFileSync(join(DIR, "docker-compose.yml"), "utf8");
const envVar = (n) => manifest.env_vars.find((v) => v.name === n);
const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
function serviceBlocks() {
  const body = compose.split(/^services:\s*$/m)[1].split(/^networks:\s*$/m)[0];
  const names = [...body.matchAll(/^  ([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1]);
  return names.map((name, i) => {
    const start = body.indexOf(`\n  ${name}:`);
    const end = i + 1 < names.length ? body.indexOf(`\n  ${names[i + 1]}:`) : body.length;
    return { name, text: body.slice(start, end) };
  });
}

test("manifest passes the bundle contract", () => {
  const r = validateManifest(manifest, DIR, { bundleExists: (id) => existsSync(join(ROOT, "bundles", id, "manifest.json")) });
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("no 'changeme'-style default anywhere in the bundle", () => {
  for (const f of walk(DIR)) assert.doesNotMatch(readFileSync(f, "utf8"), /change_?me/i, f);
});

test("five services, each restart: unless-stopped and memory-limited", () => {
  const svcs = serviceBlocks();
  assert.deepEqual(svcs.map((s) => s.name).sort(), ["nextcloud", "nextcloud-cron", "nextcloud-db", "nextcloud-redis", "onlyoffice"]);
  for (const s of svcs) {
    assert.match(s.text, /^    restart: unless-stopped$/m, s.name);
    assert.match(s.text, /^    mem_limit: \d+[mg]$/m, s.name);
  }
  for (const n of ["nextcloud-db", "nextcloud-redis"]) assert.match(serviceBlocks().find((s) => s.name === n).text, /oom_score_adj: -500/);
});

test("only 127.0.0.1:3070 and 127.0.0.1:3071 are published", () => {
  const maps = [...compose.matchAll(/^\s*-\s*"([^"]*:\d+:\d+)"\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(maps.sort(), ["127.0.0.1:3070:80", "127.0.0.1:3071:80"]);
});

test("project name fixed; network pinned to 10.89.70.0/24; binds under CROW_HOME/workspace", () => {
  assert.match(compose, /^name: crow-workspace$/m);
  assert.match(compose, /^networks:\n  default:\n    ipam:\n      config:\n        - subnet: 10\.89\.70\.0\/24$/m);
  assert.match(compose, /\$\{CROW_HOME:\?[^}]*\}\/workspace\/nextcloud:\/var\/www\/html/);
  assert.match(compose, /\$\{CROW_HOME:\?[^}]*\}\/workspace\/db:\/var\/lib\/mysql/);
  assert.deepEqual(manifest.docker.precreate, ["workspace", "workspace/backups-staging"]);
  assert.equal(manifest.docker.pull_timeout_s, 1800);
});

test("every image is pinned to an exact version and mirrored in manifest.images", () => {
  const images = [...new Set([...compose.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((m) => m[1]))].sort();
  for (const i of images) { assert.doesNotMatch(i, /:latest$|:stable|^[^:]+$/, i); assert.match(i, /:\d+\.\d+\.\d+/, i); }
  assert.deepEqual([...manifest.images].sort(), images);
});

test("every compose var is declared; every secret it uses is generated and hard-fail", () => {
  const used = [...compose.matchAll(/\$\{([A-Z_][A-Z0-9_]*)([^}]*)\}/g)];
  for (const n of new Set(used.map((m) => m[1]))) if (n !== "CROW_HOME") assert.ok(envVar(n), `${n} not declared`);
  for (const n of ["WORKSPACE_FIRSTRUN_ADMIN_PASSWORD", "WORKSPACE_DB_ROOT_PASSWORD", "WORKSPACE_DB_PASSWORD", "WORKSPACE_REDIS_PASSWORD", "WORKSPACE_ONLYOFFICE_JWT_SECRET"]) {
    assert.equal(envVar(n).generate, "secret", n);
    for (const m of used.filter((u) => u[1] === n)) assert.match(m[2], /^:\?/, n);
  }
});

test("the human admin password never reaches a container and is install-gated, not badge-gated", () => {
  assert.doesNotMatch(compose, /WORKSPACE_ADMIN_PASSWORD/);
  const v = envVar("WORKSPACE_ADMIN_PASSWORD");
  assert.equal(v.install_required, true);
  assert.equal(v.check, "not_breached", "pre-install check against Nextcloud's default HIBP password policy");
  assert.notEqual(v.required, true, "required:true would raise 'Needs setup' after bootstrap scrubs it");
  assert.equal(v.secret, true);
  assert.equal(v.propagate, false);
  assert.equal(v.default, undefined);
  assert.ok(new RegExp(v.pattern).test("Correct-Horse-Battery-9"));
  assert.ok(!new RegExp(v.pattern).test("has $ dollar 123"));
  for (const v2 of manifest.env_vars) assert.ok(v2.propagate === false || v2.generate === "secret", `${v2.name} must stay out of the gateway .env`);
  for (const n of ["WORKSPACE_NC_SERVE_PORT", "WORKSPACE_OO_SERVE_PORT", "WORKSPACE_PUBLIC_HOST", "WORKSPACE_ADMIN_USER"]) assert.ok(envVar(n).pattern, `${n} must be pattern-gated (rendered into shell commands)`);
  assert.ok(new RegExp(envVar("WORKSPACE_PUBLIC_HOST").pattern).test("crow.example-tailnet.ts.net"));
  assert.ok(!new RegExp(envVar("WORKSPACE_PUBLIC_HOST").pattern).test("x; rm -rf ~"));
});

test("cron gets the DB/Redis env but never an admin password", () => {
  const cron = serviceBlocks().find((s) => s.name === "nextcloud-cron").text;
  assert.match(cron, /entrypoint: \/cron\.sh/);
  assert.match(cron, /environment: \*nextcloud-common-env/);
  assert.doesNotMatch(cron, /ADMIN/);
});

test("REVIEW FOCUS 5c — no secret-in-argv patterns in compose or ops scripts", () => {
  const files = [join(DIR, "docker-compose.yml"), ...(existsSync(join(DIR, "ops")) ? walk(join(DIR, "ops")) : []).filter((f) => /\.(sh|ya?ml)$/.test(f))];
  const banned = [/-p"\$/, /-a "\$/, /-a \$\$/, /--value="\$/, /--requirepass/, /--admin-pass/, /-e [A-Z_]*(PASS|SECRET|JWT|TOKEN)\b/];
  for (const f of files) for (const re of banned) assert.doesNotMatch(readFileSync(f, "utf8"), re, `${f} ${re}`);
  assert.match(compose, /REDISCLI_AUTH=/);
  assert.match(compose, /exec su-exec redis redis-server \/tmp\/redis\.conf/);
  assert.match(serviceBlocks().find((s) => s.name === "nextcloud-redis").text, /init: true/);
});

test("ONLYOFFICE has JWT on; manifest has no ports/webUI; RAM/disk declared; Office nav", () => {
  assert.match(compose, /JWT_ENABLED: "true"/);
  assert.match(compose, /JWT_SECRET: \$\{WORKSPACE_ONLYOFFICE_JWT_SECRET:\?/);
  assert.equal(manifest.ports, undefined);
  assert.equal(manifest.webUI, undefined);
  assert.ok(manifest.requires.min_ram_mb >= 3072 && manifest.requires.min_ram_mb <= 5120);
  assert.ok(manifest.requires.min_disk_mb >= 10240);
  assert.match(manifest.notes, /Uninstalling keeps/);
});

test("the old nextcloud bundle is a deprecated connect-only entry with no compose", () => {
  const nc = JSON.parse(readFileSync(join(ROOT, "bundles", "nextcloud", "manifest.json"), "utf8"));
  assert.equal(existsSync(join(ROOT, "bundles", "nextcloud", "docker-compose.yml")), false);
  assert.equal(nc.docker, undefined);
  assert.equal(nc.ports, undefined);
  assert.equal(nc.webUI, undefined);
  assert.equal(nc.deprecated.superseded_by, "workspace");
  assert.equal(JSON.parse(readFileSync(join(ROOT, "scripts", "known-port-conflicts.json"), "utf8"))["8080"], undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/workspace-bundle.test.js`
Expected: FAIL: `ENOENT … bundles/workspace/manifest.json`.

- [ ] **Step 3: Create `bundles/workspace/manifest.json`**

```json
{
  "id": "workspace",
  "name": "Crow Workspace",
  "version": "0.1.0",
  "description": "Your own private office on this machine: files, documents you can edit together (ONLYOFFICE), calendars and contacts that sync to your phones, and forms, built on Nextcloud. Tailnet only, never public.",
  "type": "bundle",
  "author": "Crow",
  "category": "productivity",
  "tags": ["office", "documents", "calendar", "contacts", "files", "forms", "nextcloud", "onlyoffice", "self-hosted"],
  "icon": "document",
  "docker": {
    "composefile": "docker-compose.yml",
    "precreate": ["workspace", "workspace/backups-staging"],
    "pull_timeout_s": 1800
  },
  "images": [
    "mariadb:11.8.9",
    "nextcloud:34.0.4-apache",
    "onlyoffice/documentserver:9.4.0.1",
    "redis:8.2.10-alpine"
  ],
  "requires": { "min_ram_mb": 4096, "recommended_ram_mb": 5120, "min_disk_mb": 10240 },
  "env_vars": [
    {
      "name": "WORKSPACE_ADMIN_USER",
      "description": "Login name for the Workspace administrator account (you).",
      "default": "admin", "required": false, "propagate": false,
      "pattern": "^[a-z][a-z0-9._-]{1,31}$",
      "pattern_hint": "2-32 lowercase letters, digits, dots, dashes or underscores, starting with a letter"
    },
    {
      "name": "WORKSPACE_ADMIN_PASSWORD",
      "description": "Password for that administrator account. Used once by setup, then removed from this machine's config; change it later inside Workspace (Settings, Security). 12-128 characters: letters, digits and ! % * + , - . / : = ? @ ^ _ ~ (no spaces, quotes, $ or #).",
      "install_required": true, "secret": true, "propagate": false, "check": "not_breached",
      "pattern": "^[A-Za-z0-9!%*+,./:=?@^_~-]{12,128}$",
      "pattern_hint": "12-128 letters, digits or ! % * + , - . / : = ? @ ^ _ ~"
    },
    { "name": "WORKSPACE_FIRSTRUN_ADMIN_PASSWORD", "description": "Throwaway password for the image's first install (generated; replaced by setup).", "required": true, "secret": true, "generate": "secret" },
    { "name": "WORKSPACE_DB_ROOT_PASSWORD", "description": "MariaDB root password (generated).", "required": true, "secret": true, "generate": "secret" },
    { "name": "WORKSPACE_DB_PASSWORD", "description": "MariaDB password for Nextcloud (generated).", "required": true, "secret": true, "generate": "secret" },
    { "name": "WORKSPACE_REDIS_PASSWORD", "description": "Redis password (generated).", "required": true, "secret": true, "generate": "secret" },
    { "name": "WORKSPACE_ONLYOFFICE_JWT_SECRET", "description": "Secret shared by Nextcloud and ONLYOFFICE (generated).", "required": true, "secret": true, "generate": "secret" },
    {
      "name": "WORKSPACE_PUBLIC_HOST",
      "description": "This machine's tailnet name. Leave blank and setup detects it.",
      "default": "", "required": false, "propagate": false,
      "pattern": "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$",
      "pattern_hint": "a hostname (lowercase letters, digits, dots and dashes)"
    },
    { "name": "WORKSPACE_NC_SERVE_PORT", "description": "Tailscale Serve HTTPS port for Workspace.", "default": "8456", "required": false, "propagate": false, "pattern": "^[0-9]{2,5}$", "pattern_hint": "a port number" },
    { "name": "WORKSPACE_OO_SERVE_PORT", "description": "Tailscale Serve HTTPS port for the document editor.", "default": "8457", "required": false, "propagate": false, "pattern": "^[0-9]{2,5}$", "pattern_hint": "a port number" }
  ],
  "notes": "One Workspace per machine. Uses about 3-5 GB RAM, no GPU. Every internal password is generated at install; you type only the admin password, which setup uses once and then removes. Setup finishes on its own after the containers start (a few minutes on first install). Then open Office in Crow to publish it on your tailnet and set up phones. Uninstalling keeps your files and database in ~/.crow/workspace, the generated secrets, the backup timer and the tailnet addresses; see the Workspace guide for the cleanup commands. 'Delete data' does not remove those files."
}
```

- [ ] **Step 4: Create `bundles/workspace/docker-compose.yml`**

```yaml
## Crow Workspace (W1 Platform): Nextcloud + MariaDB + Redis + ONLYOFFICE Docs + cron.
##
## Installed by Crow. Every internal secret is generated at install
## (manifest env_vars[].generate) into this bundle's .env (mode 600); the
## post-install bootstrap (ops/bootstrap.sh) configures the rest through occ,
## passing secrets on stdin only. The human admin password never reaches a
## container: the image installs with a generated throwaway, and bootstrap
## replaces it.
##
## Loopback only. The household reaches it through two Tailscale Serve HTTPS
## ports (see Office in Crow). NEVER Funnel. One Workspace per host: the project
## name is fixed and Crow refuses to touch it from a second install.
## Images are pinned; upgrade Nextcloud one major version at a time, never
## automatically (docs/guide/workspace.md).

name: crow-workspace

x-nextcloud-common-env: &nextcloud-common-env
  MYSQL_HOST: nextcloud-db
  MYSQL_DATABASE: nextcloud
  MYSQL_USER: nextcloud
  MYSQL_PASSWORD: ${WORKSPACE_DB_PASSWORD:?generated at install}
  REDIS_HOST: nextcloud-redis
  REDIS_HOST_PASSWORD: ${WORKSPACE_REDIS_PASSWORD:?generated at install}
  PHP_UPLOAD_LIMIT: 2G
  APACHE_DISABLE_REWRITE_IP: "1"

x-nextcloud-volumes: &nextcloud-volumes
  - ${CROW_HOME:?CROW_HOME is required}/workspace/nextcloud:/var/www/html

services:
  nextcloud:
    image: nextcloud:34.0.4-apache
    restart: unless-stopped
    mem_limit: 2g
    ports:
      - "127.0.0.1:3070:80"
    environment:
      <<: *nextcloud-common-env
      NEXTCLOUD_ADMIN_USER: ${WORKSPACE_ADMIN_USER:-admin}
      NEXTCLOUD_ADMIN_PASSWORD: ${WORKSPACE_FIRSTRUN_ADMIN_PASSWORD:?generated at install}
    volumes: *nextcloud-volumes
    depends_on:
      nextcloud-db:
        condition: service_healthy
      nextcloud-redis:
        condition: service_healthy

  nextcloud-cron:
    image: nextcloud:34.0.4-apache
    restart: unless-stopped
    mem_limit: 512m
    entrypoint: /cron.sh
    environment: *nextcloud-common-env
    volumes: *nextcloud-volumes
    depends_on:
      - nextcloud

  nextcloud-db:
    image: mariadb:11.8.9
    restart: unless-stopped
    mem_limit: 1g
    oom_score_adj: -500
    command: ["--transaction-isolation=READ-COMMITTED"]
    environment:
      MARIADB_ROOT_PASSWORD: ${WORKSPACE_DB_ROOT_PASSWORD:?generated at install}
      MARIADB_DATABASE: nextcloud
      MARIADB_USER: nextcloud
      MARIADB_PASSWORD: ${WORKSPACE_DB_PASSWORD:?generated at install}
      MARIADB_AUTO_UPGRADE: "1"
    volumes:
      - ${CROW_HOME:?CROW_HOME is required}/workspace/db:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s

  nextcloud-redis:
    image: redis:8.2.10-alpine
    restart: unless-stopped
    mem_limit: 256m
    oom_score_adj: -500
    # requirepass goes into a private config file inside the container (never argv), and
    # redis-server is exec'd as the redis user via setpriv (the image entrypoint's own method;
    # the image ships no gosu-style helper). rm -f first: on a container restart the old conf is owned by
    # redis in sticky /tmp, and root may not reopen it (fs.protected_regular); init: true reaps and forwards SIGTERM for a prompt stop.
    init: true
    command:
      - sh
      - -c
      - umask 077 && rm -f /tmp/redis.conf && printf 'requirepass %s\n' "$$REDIS_PASSWORD" > /tmp/redis.conf && chown redis:redis /tmp/redis.conf && exec /bin/setpriv --reuid redis --regid redis --clear-groups redis-server /tmp/redis.conf
    environment:
      REDIS_PASSWORD: ${WORKSPACE_REDIS_PASSWORD:?generated at install}
    healthcheck:
      test: ["CMD-SHELL", "REDISCLI_AUTH=\"$$REDIS_PASSWORD\" redis-cli ping | grep -q PONG"]
      interval: 10s
      timeout: 5s
      retries: 10

  onlyoffice:
    image: onlyoffice/documentserver:9.4.0.1
    restart: unless-stopped
    mem_limit: 3g
    ports:
      - "127.0.0.1:3071:80"
    environment:
      JWT_ENABLED: "true"
      JWT_SECRET: ${WORKSPACE_ONLYOFFICE_JWT_SECRET:?generated at install}
      JWT_HEADER: Authorization
      ALLOW_PRIVATE_IP_ADDRESS: "true"
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost/healthcheck"]
      interval: 30s
      timeout: 10s
      retries: 10
      start_period: 120s

networks:
  default:
    ipam:
      config:
        - subnet: 10.89.70.0/24
```

- [ ] **Step 5: Deprecate `nextcloud`**

```bash
git rm bundles/nextcloud/docker-compose.yml
```

Replace `bundles/nextcloud/manifest.json` with:

```json
{
  "id": "nextcloud",
  "name": "Nextcloud (connect existing)",
  "version": "1.1.0",
  "description": "Deprecated: connect Crow to a Nextcloud you already run, over WebDAV. To host your own files, documents and calendars, install Crow Workspace instead.",
  "type": "skill",
  "author": "Crow",
  "category": "productivity",
  "tags": ["files", "webdav", "documents", "deprecated"],
  "icon": "cloud",
  "deprecated": { "since": "2026-10-02", "superseded_by": "workspace" },
  "skills": ["skills/nextcloud.md"],
  "requires": { "min_ram_mb": 64, "min_disk_mb": 10 },
  "env_vars": [
    { "name": "NEXTCLOUD_URL", "description": "Your Nextcloud server URL (e.g., https://cloud.example.com)", "required": true },
    { "name": "NEXTCLOUD_USER", "description": "Your Nextcloud login", "required": true },
    { "name": "NEXTCLOUD_PASSWORD", "description": "A Nextcloud app password (Settings → Security)", "required": true, "secret": true }
  ],
  "notes": "Connect-only. This entry no longer deploys a server (its old compose shipped default database passwords and collided with LocalAI on port 8080). For a self-hosted suite use Crow Workspace."
}
```

Set `scripts/known-port-conflicts.json` to:

```json
{
  "_comment": "Pre-existing port collisions allowed by check-port-allocation.js. Do not add new entries — fix the conflict instead. Each entry must list ALL bundles that share the port; check passes only if the bundle set matches exactly. (8080 localai/nextcloud resolved 2026-10-02: nextcloud's compose retired, Crow Workspace uses 3070/3071.)"
}
```

- [ ] **Step 6: Port registries (English and Spanish) and schema**

In `docs/developers/port-allocation.md`:
- Replace the known-conflict row with `| — | none. The 8080 LocalAI/Nextcloud collision was resolved 2026-10-02 (the nextcloud bundle no longer deploys; Crow Workspace uses 3070/3071). |`.
- Change the 8080 allocation row to `| 8080 | 127.0.0.1 | localai (existing) | existing |`.
- Insert these rows in numeric order (3070/3071 after 3065; 8456/8457 after 8098):

```markdown
| 3070 | 127.0.0.1 | workspace (Crow Workspace: Nextcloud web; tailnet via Serve :8456) | W1 2026-10 |
| 3071 | 127.0.0.1 | workspace (Crow Workspace: ONLYOFFICE Docs; tailnet via Serve :8457) | W1 2026-10 |
| 8456 | tailnet (Serve) | Tailscale Serve HTTPS → 127.0.0.1:3070 (Workspace; never Funnel) | W1 2026-10 |
| 8457 | tailnet (Serve) | Tailscale Serve HTTPS → 127.0.0.1:3071 (Workspace editor; never Funnel) | W1 2026-10 |
```

Also add a "Docker subnets" note under Conventions: `crow-workspace pins 10.89.70.0/24 (scratch: 10.89.71.0/24 smoke, 10.89.72.0/24 restore). Do not reuse.`

In `docs/es/developers/port-allocation.md`:
- Replace the conflict row (line 21) with `| — | ninguno. El conflicto 8080 LocalAI/Nextcloud se resolvió el 2026-10-02 (el bundle nextcloud ya no despliega; Crow Workspace usa 3070/3071). |`.
- Change line 64 to `| 8080 | 127.0.0.1 | localai (existente) | existente |`.
- Add the same four rows in Spanish (`workspace (Crow Workspace: Nextcloud web; tailnet vía Serve :8456)` and so on) and the subnet note.

Schema, top-level properties:

```json
    "images": { "type": "array", "items": { "type": "string", "pattern": "^[^\\s]+:[^\\s]+$" } },
    "deprecated": { "type": "object", "additionalProperties": true, "properties": { "since": { "type": "string" }, "superseded_by": { "type": "string" } } },
```

- [ ] **Step 7: Regenerate the registry and run the gates**

```bash
node scripts/build-registry.mjs && node scripts/build-registry.mjs --check
node scripts/check-port-allocation.js
npm test -- tests/workspace-bundle.test.js tests/bundle-contract.test.js tests/bundle-inference-contract.test.js tests/extensions-page-render.test.js
```

Expected: all PASS. The 5c argv scan covers only the compose file until Task 5 creates `ops/`; the test already guards the missing dir.

- [ ] **Step 8: Commit**

```bash
git add bundles/workspace/manifest.json bundles/workspace/docker-compose.yml tests/workspace-bundle.test.js
git commit bundles/workspace bundles/nextcloud scripts/known-port-conflicts.json docs/developers/port-allocation.md docs/es/developers/port-allocation.md registry/manifest.schema.json registry/add-ons.json tests/workspace-bundle.test.js \
  -m "feat(workspace): Crow Workspace bundle — pinned, loopback-only, limited, pinned subnet, no secrets in argv; retire nextcloud's compose"
git show --stat HEAD
```

---

### Task 5: Idempotent bootstrap, household accounts, password reset

**Files:**
- Create: `bundles/workspace/ops/bootstrap.sh`, `ops/add-user.sh`, `ops/reset-password.sh`
- Modify: `bundles/workspace/manifest.json` (`postInstall`), `registry/add-ons.json`
- Test: `tests/workspace-bootstrap.test.js`

**Interfaces:**
- Consumes: the Task 3 hook contract; the Task 4 env keys, service names and project.
- Produces:
  - `.env`:
    - gains `WORKSPACE_PUBLIC_HOST` (when it was blank) and `WORKSPACE_BOT_APP_PASSWORD` (72 alphanumerics);
    - **loses** `WORKSPACE_ADMIN_PASSWORD` once it has been applied;
    - stays at mode 600.
  - `${CROW_HOME}/secrets/bundle-env/workspace.env` is re-synced from `.env` for every generated key on every run (C2).
  - Nextcloud state:
    - apps calendar/contacts/forms/onlyoffice; cron jobs; APCu local cache;
    - trusted domains, proxies and overwrite* (gateway `10.89.70.1`);
    - the ONLYOFFICE connector;
    - groups `household` (admin) and `crow-bots` (crow-bot), the link-share exclusion and enumeration restriction;
    - calendar `Menu`.
  - Seams (env):
    - `WORKSPACE_DC` (default `docker compose`), `WORKSPACE_COMPOSE_PROJECT` (default `crow-workspace`), `WORKSPACE_TS`, `WORKSPACE_DOCKER`, `WORKSPACE_WAIT_S`, `WORKSPACE_SLEEP_S`.
  - Secret transport: every secret is written by a bash builtin (`printf`) into the stdin of `dc exec -T … sh -c '…read…'`.

- [ ] **Step 1: Write the failing test**

Create `tests/workspace-bootstrap.test.js`:

```js
/**
 * ops/bootstrap.sh, add-user.sh, reset-password.sh against a FAKE `docker compose`:
 * the fake answers occ from marker files in FAKE_STATE, logs each call's argv to
 * calls.log and its stdin (secrets travel there) to stdin.log.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OPS = join(import.meta.dirname, "..", "bundles", "workspace", "ops");

const FAKE_DC = String.raw`#!/usr/bin/env bash
S="$FAKE_STATE"
printf '%s\n' "$*" >> "$S/calls.log"
{ printf '[%s] ' "$*"; cat; printf '\n'; } >> "$S/stdin.log"
for last; do :; done
case "$*" in
  *"occ status --output=json"*) if [ -f "$S/installed" ]; then echo '{"installed":true,"version":"34.0.4"}'; else echo '{"installed":false}'; fi ;;
  *"occ config:app:get "*" enabled"*) app=$(printf '%s' "$*" | sed -E 's/.*config:app:get ([a-z_]+) enabled.*/\1/'); if [ -f "$S/app-$app" ]; then echo yes; fi ;;
  *"occ app:install "*|*"occ app:enable "*) touch "$S/app-$last" ;;
  *"occ dav:list-calendars "*) echo "+------+"; if [ -f "$S/cal-Menu" ]; then echo "| Menu | Menu | principals/users/admin | admin |  ✓  |"; fi ;;
  *"occ dav:create-calendar "*) touch "$S/cal-$last" ;;
  *"occ user:info "*) [ -f "$S/user-$last" ] || exit 1 ;;
  *"user:add "*) touch "$S/user-$last" ;;
  *"occ user:auth-tokens:list "*) if [ -f "$S/tokens" ]; then echo '[{"id":7,"name":"crow-workspace-tools"},{"id":8,"name":"phone"}]'; else echo '[]'; fi ;;
  *"user:auth-tokens:add "*) n=$(( $(cat "$S/tokens" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$S/tokens"; printf 'app password:\n%s%s\n' "$(printf 'A%.0s' $(seq 1 71))" "$n" ;;
  *"onlyoffice:documentserver --check"*) echo "Document server is successfully connected" ;;
  *"user:resetpassword --password-from-env admin"*) [ -f "$S/reject-admin" ] && { echo "Password is among the 1,000,000 most common ones" >&2; exit 1; } ;;
  *) : ;;
esac
exit 0
`;
const FAKE_TS = String.raw`#!/usr/bin/env bash
printf '%s\n' "ts $*" >> "$FAKE_STATE/calls.log"
[ -f "$FAKE_STATE/no-tailnet" ] && exit 1
echo '{"Self":{"DNSName":"box.tailnet-example.ts.net."}}'
`;
const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
printf '%s\n' "docker $*" >> "$FAKE_STATE/calls.log"
echo 10.89.70.1
`;
const TOKEN1 = "A".repeat(71) + "1";
const TOKEN2 = "A".repeat(71) + "2";
const SECRETS = {
  WORKSPACE_ADMIN_PASSWORD: "Admin-Secret-Value-123",
  WORKSPACE_FIRSTRUN_ADMIN_PASSWORD: "firstrun-SECRET-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  WORKSPACE_DB_ROOT_PASSWORD: "dbroot-SECRET-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  WORKSPACE_DB_PASSWORD: "db-SECRET-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  WORKSPACE_REDIS_PASSWORD: "redis-SECRET-ccccccccccccccccccccccccccccccccccc",
  WORKSPACE_ONLYOFFICE_JWT_SECRET: "jwt-SECRET-ddddddddddddddddddddddddddddddddddddd",
};
const GENERATED = ["WORKSPACE_FIRSTRUN_ADMIN_PASSWORD", "WORKSPACE_DB_ROOT_PASSWORD", "WORKSPACE_DB_PASSWORD", "WORKSPACE_REDIS_PASSWORD", "WORKSPACE_ONLYOFFICE_JWT_SECRET"];

function setup({ env = {}, state = ["installed"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ws-boot-"));
  const ctx = { root, bundle: join(root, "bundle"), st: join(root, "state"), bin: join(root, "bin"), home: join(root, "crowhome") };
  for (const d of [ctx.bundle, ctx.st, ctx.bin, ctx.home]) mkdirSync(d);
  for (const [n, body] of [["dc", FAKE_DC], ["ts", FAKE_TS], ["docker", FAKE_DOCKER]]) { writeFileSync(join(ctx.bin, n), body); chmodSync(join(ctx.bin, n), 0o755); }
  for (const s of state) writeFileSync(join(ctx.st, s), "");
  const vars = { WORKSPACE_ADMIN_USER: "admin", ...SECRETS, WORKSPACE_PUBLIC_HOST: "", WORKSPACE_NC_SERVE_PORT: "8456", WORKSPACE_OO_SERVE_PORT: "8457", ...env };
  writeFileSync(join(ctx.bundle, ".env"), Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  return ctx;
}
function run(script, ctx, args = [], { input, env: extra = {} } = {}) {
  const r = spawnSync("bash", [join(OPS, script), ...args], {
    encoding: "utf8", input,
    env: {
      PATH: process.env.PATH, HOME: ctx.root, CROW_HOME: ctx.home, CROW_BUNDLE_DIR: ctx.bundle, FAKE_STATE: ctx.st,
      WORKSPACE_DC: join(ctx.bin, "dc"), WORKSPACE_TS: join(ctx.bin, "ts"), WORKSPACE_DOCKER: join(ctx.bin, "docker"),
      WORKSPACE_WAIT_S: "2", WORKSPACE_SLEEP_S: "1", ...extra,
    },
  });
  return { ...r, out: `${r.stdout}\n${r.stderr}` };
}
const read = (ctx, f) => (existsSync(join(ctx.st, f)) ? readFileSync(join(ctx.st, f), "utf8") : "");
const parseEnv = (p) => Object.fromEntries(readFileSync(p, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const envOf = (ctx) => parseEnv(join(ctx.bundle, ".env"));
const retained = (ctx) => join(ctx.home, "secrets", "bundle-env", "workspace.env");

test("fresh run configures everything once", () => {
  const ctx = setup();
  const r = run("bootstrap.sh", ctx);
  assert.equal(r.status, 0, r.out);
  const c = read(ctx, "calls.log");
  for (const app of ["calendar", "contacts", "forms", "onlyoffice"]) assert.match(c, new RegExp(`occ app:install ${app}`));
  assert.match(c, /occ background:cron/);
  assert.match(c, /docker network inspect crow-workspace_default/);
  assert.match(c, /occ config:system:set trusted_domains 1 --value=nextcloud/);
  assert.match(c, /occ config:system:set trusted_domains 2 --value=box\.tailnet-example\.ts\.net/);
  assert.match(c, /occ config:system:set trusted_proxies 0 --value=10\.89\.70\.1/);
  assert.match(c, /occ config:system:set overwritehost --value=box\.tailnet-example\.ts\.net:8456/);
  assert.match(c, /occ config:system:set overwritecondaddr --value=\^10\\\.89\\\.70\\\.1\$/);
  assert.match(c, /occ config:app:set onlyoffice DocumentServerUrl --value=https:\/\/box\.tailnet-example\.ts\.net:8457\//);
  assert.match(c, /occ config:app:set onlyoffice DocumentServerInternalUrl --value=http:\/\/onlyoffice\//);
  assert.match(c, /occ config:app:set onlyoffice StorageUrl --value=http:\/\/nextcloud\//);
  assert.match(c, /php occ config:import \/dev\/stdin/);
  assert.match(c, /occ dav:create-calendar admin Menu/);
  assert.match(c, /occ group:add household/);
  assert.match(c, /occ group:adduser household admin/);
  assert.match(c, /occ config:app:set core shareapi_allow_links_exclude_groups --value=\["crow-bots"\]/);
  assert.match(c, /occ config:app:set core shareapi_restrict_user_enumeration_to_group --value=yes/);
  assert.match(c, /user:add --password-from-env --display-name=Crow bot --group crow-bots crow-bot/);
  assert.doesNotMatch(c, /--group admin/);
  assert.equal(envOf(ctx).WORKSPACE_BOT_APP_PASSWORD, TOKEN1);
  assert.equal(envOf(ctx).WORKSPACE_PUBLIC_HOST, "box.tailnet-example.ts.net");
  assert.equal(statSync(join(ctx.bundle, ".env")).mode & 0o777, 0o600);
});

test("REVIEW FOCUS 5b — secrets travel on stdin, never argv or output; admin password scrubbed", () => {
  const ctx = setup();
  const r = run("bootstrap.sh", ctx);
  assert.equal(r.status, 0, r.out);
  const argv = read(ctx, "calls.log"); const stdin = read(ctx, "stdin.log");
  for (const v of [...Object.values(SECRETS), TOKEN1]) {
    assert.ok(!r.out.includes(v), `printed: ${v.slice(0, 8)}…`);
    assert.ok(!argv.includes(v), `in argv: ${v.slice(0, 8)}…`);
  }
  assert.ok(stdin.includes(SECRETS.WORKSPACE_ONLYOFFICE_JWT_SECRET), "JWT reached occ config:import via stdin");
  assert.match(stdin, /user:resetpassword --password-from-env admin\] Admin-Secret-Value-123/, "admin password applied via stdin");
  assert.equal(envOf(ctx).WORKSPACE_ADMIN_PASSWORD, undefined, "scrubbed from .env after use");
  assert.ok(!readFileSync(retained(ctx), "utf8").includes("Admin-Secret-Value-123"), "never in the kept-secrets copy");
});

test("REVIEW FOCUS 1 (restore) — bootstrap re-syncs the retained copy from .env (600, other keys kept)", () => {
  const ctx = setup();
  mkdirSync(join(ctx.home, "secrets", "bundle-env"), { recursive: true });
  writeFileSync(retained(ctx), "# header\nWORKSPACE_DB_PASSWORD=stale-from-a-fresh-install\nOTHER_KEY=keep-me\n", { mode: 0o644 });
  assert.equal(run("bootstrap.sh", ctx).status, 0);
  const kept = parseEnv(retained(ctx));
  for (const k of GENERATED) assert.equal(kept[k], SECRETS[k], k);
  assert.equal(kept.OTHER_KEY, "keep-me");
  assert.equal(statSync(retained(ctx)).mode & 0o777, 0o600);
  assert.equal(statSync(join(ctx.home, "secrets", "bundle-env")).mode & 0o777, 0o700);
});

test("REVIEW FOCUS 3 — second run changes nothing; lost token re-minted once, stale tokens revoked", () => {
  const ctx = setup();
  assert.equal(run("bootstrap.sh", ctx).status, 0);
  writeFileSync(join(ctx.st, "calls.log"), "");
  assert.equal(run("bootstrap.sh", ctx).status, 0);
  assert.doesNotMatch(read(ctx, "calls.log"), /app:install|app:enable|dav:create-calendar|user:add |user:resetpassword|auth-tokens:add|auth-tokens:delete/);
  assert.equal(envOf(ctx).WORKSPACE_BOT_APP_PASSWORD, TOKEN1);

  const kept = readFileSync(join(ctx.bundle, ".env"), "utf8").split("\n").filter((l) => !l.startsWith("WORKSPACE_BOT_APP_PASSWORD=")).join("\n");
  writeFileSync(join(ctx.bundle, ".env"), kept, { mode: 0o600 });
  writeFileSync(join(ctx.st, "calls.log"), "");
  assert.equal(run("bootstrap.sh", ctx).status, 0);
  const c = read(ctx, "calls.log");
  assert.doesNotMatch(c, /user:add /);
  assert.equal((c.match(/user:resetpassword --password-from-env crow-bot/g) || []).length, 1);
  assert.match(c, /occ user:auth-tokens:delete crow-bot 7/);
  assert.doesNotMatch(c, /auth-tokens:delete crow-bot 8/, "tokens with other names are left alone");
  assert.equal((c.match(/auth-tokens:add/g) || []).length, 1);
  assert.equal(envOf(ctx).WORKSPACE_BOT_APP_PASSWORD, TOKEN2);
});

test("Nextcloud rejecting the typed admin password → clear, recoverable failure; the password is NOT scrubbed", () => {
  const ctx = setup({ state: ["installed", "reject-admin"] });
  const r = run("bootstrap.sh", ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /Nextcloud rejected the admin password/);
  assert.match(r.out, /ops\/reset-password\.sh admin/);
  assert.match(r.out, /delete the WORKSPACE_ADMIN_PASSWORD line/);
  assert.ok(!r.out.includes(SECRETS.WORKSPACE_ADMIN_PASSWORD));
  assert.equal(envOf(ctx).WORKSPACE_ADMIN_PASSWORD, SECRETS.WORKSPACE_ADMIN_PASSWORD, "kept until it is applied or the operator removes it");
  assert.doesNotMatch(read(ctx, "calls.log"), /^ts /m, "the admin step runs before tailnet detection");
});

test("Nextcloud never finishing its install fails within the bounded wait", () => {
  const r = run("bootstrap.sh", setup({ state: [] }));
  assert.notEqual(r.status, 0);
  assert.match(r.out, /Nextcloud not ready after 2s/);
});

test("no tailnet name → refusal pointing at editing the .env (Configure has no field for it)", () => {
  const r = run("bootstrap.sh", setup({ state: ["installed", "no-tailnet"] }));
  assert.notEqual(r.status, 0);
  assert.match(r.out, /WORKSPACE_PUBLIC_HOST=<name> to .*\.env/);
  assert.doesNotMatch(r.out, /Configure/);
});

test("configured host used as-is (tailscale never asked); an unsafe host is refused", () => {
  const ctx = setup({ env: { WORKSPACE_PUBLIC_HOST: "office.example.lan" } });
  assert.equal(run("bootstrap.sh", ctx).status, 0);
  assert.doesNotMatch(read(ctx, "calls.log"), /^ts /m);
  assert.match(read(ctx, "calls.log"), /overwritehost --value=office\.example\.lan:8456/);
  const bad = run("bootstrap.sh", setup({ env: { WORKSPACE_PUBLIC_HOST: "x;rm" } }));
  assert.notEqual(bad.status, 0);
  assert.match(bad.out, /not a valid hostname/);
});

test("a scratch project name drives the network name (smoke/restore projects)", () => {
  const ctx = setup();
  assert.equal(run("bootstrap.sh", ctx, [], { env: { WORKSPACE_COMPOSE_PROJECT: "crow-ws-smoke" } }).status, 0);
  assert.match(read(ctx, "calls.log"), /docker network inspect crow-ws-smoke_default/);
});

test("add-user.sh: group household, one-time password printed once and sent via stdin; idempotent; bad logins refused", () => {
  const ctx = setup();
  const r1 = run("add-user.sh", ctx, ["dayane", "Dayane"]);
  assert.equal(r1.status, 0, r1.out);
  const pw = /One-time password for dayane: ([A-Za-z0-9]{20})\n/.exec(r1.stdout)[1];
  assert.match(read(ctx, "calls.log"), /user:add --password-from-env --display-name=Dayane --group household dayane/);
  assert.ok(!read(ctx, "calls.log").includes(pw));
  assert.ok(read(ctx, "stdin.log").includes(pw));
  const r2 = run("add-user.sh", ctx, ["dayane", "Dayane"]);
  assert.match(r2.stdout, /already exists/);
  assert.doesNotMatch(r2.stdout, /One-time password/);
  assert.notEqual(run("add-user.sh", ctx, ["Bad Login", "X"]).status, 0);
  assert.notEqual(run("add-user.sh", ctx, ["crow-bot", "X"]).status, 0);
});

test("reset-password.sh: new password via stdin (pattern-gated), never argv", () => {
  const ctx = setup();
  const r = run("reset-password.sh", ctx, ["admin"], { input: "New-Correct-Horse-7\n" });
  assert.equal(r.status, 0, r.out);
  assert.match(read(ctx, "stdin.log"), /user:resetpassword --password-from-env admin\] New-Correct-Horse-7/);
  assert.ok(!read(ctx, "calls.log").includes("New-Correct-Horse-7"));
  assert.notEqual(run("reset-password.sh", ctx, ["admin"], { input: "has $ bad\n" }).status, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/workspace-bootstrap.test.js`
Expected: FAIL: bash `No such file or directory` for `ops/bootstrap.sh`.

- [ ] **Step 3: Implement `bundles/workspace/ops/bootstrap.sh`**

```bash
#!/usr/bin/env bash
# Crow Workspace post-install bootstrap. Idempotent: every step checks the current
# state first, so it is safe to re-run at any time (also restore step 6):
#     bash ~/.crow/bundles/workspace/ops/bootstrap.sh
# Never prints a secret, never puts one in argv (host OR container): secrets are
# written by the `printf` builtin into the stdin of `docker compose exec -T`.
set -euo pipefail
umask 077

BUNDLE_DIR="${CROW_BUNDLE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$BUNDLE_DIR/.env"
export CROW_HOME="${CROW_HOME:-$HOME/.crow}"
DC="${WORKSPACE_DC:-docker compose}"
PROJECT="${WORKSPACE_COMPOSE_PROJECT:-crow-workspace}"
TS="${WORKSPACE_TS:-tailscale}"
DOCKER="${WORKSPACE_DOCKER:-docker}"
WAIT_S="${WORKSPACE_WAIT_S:-600}"
SLEEP_S="${WORKSPACE_SLEEP_S:-5}"
NET="${PROJECT}_default"
BOT="crow-bot"
TOKEN_NAME="crow-workspace-tools"
GENERATED_KEYS="WORKSPACE_FIRSTRUN_ADMIN_PASSWORD WORKSPACE_DB_ROOT_PASSWORD WORKSPACE_DB_PASSWORD WORKSPACE_REDIS_PASSWORD WORKSPACE_ONLYOFFICE_JWT_SECRET"
RETAINED_DIR="$CROW_HOME/secrets/bundle-env"
RETAINED="$RETAINED_DIR/workspace.env"
HOST_RE='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'

log() { printf '[workspace] %s\n' "$*"; }
die() { printf '[workspace] ERROR: %s\n' "$*" >&2; exit 1; }
env_get() { [ -f "$ENV_FILE" ] || return 0; sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
env_rewrite() {  # $1 = key to drop; $2 = optional "KEY=value" line to append. Atomic, 600.
  local tmp
  tmp="$(mktemp "$BUNDLE_DIR/.env.XXXXXX")"
  { grep -v "^$1=" "$ENV_FILE" || true; [ -n "${2:-}" ] && printf '%s\n' "$2"; } > "$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$ENV_FILE"
}
env_set() { env_rewrite "$1" "$1=$2"; }
env_unset() { env_rewrite "$1"; }
dc() { (cd "$BUNDLE_DIR" && $DC "$@"); }
occ() { dc exec -T -u www-data nextcloud php occ "$@"; }
# occ with ONE secret: caller pipes it on stdin; occ sees it only as env NC_PASS.
occ_with_pass() { dc exec -T -u www-data nextcloud sh -c 'IFS= read -r NC_PASS; export NC_PASS; exec php occ "$@"' sh "$@"; }
wait_for() {
  local what="$1" waited=0; shift
  until "$@" >/dev/null 2>&1; do
    [ "$waited" -ge "$WAIT_S" ] && die "$what not ready after ${WAIT_S}s"
    sleep "$SLEEP_S"; waited=$((waited + SLEEP_S))
  done
  log "$what ready"
}
nc_installed() { [[ "$(occ status --output=json 2>/dev/null)" == *'"installed":true'* ]]; }
oo_connected() { occ onlyoffice:documentserver --check; }
random_pw() { head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

[ -f "$ENV_FILE" ] || die ".env missing at $ENV_FILE (reinstall Workspace from the Extensions page)"
ADMIN_USER="$(env_get WORKSPACE_ADMIN_USER)"; ADMIN_USER="${ADMIN_USER:-admin}"
NC_PORT="$(env_get WORKSPACE_NC_SERVE_PORT)"; NC_PORT="${NC_PORT:-8456}"
OO_PORT="$(env_get WORKSPACE_OO_SERVE_PORT)"; OO_PORT="${OO_PORT:-8457}"
[[ "$NC_PORT" =~ ^[0-9]{2,5}$ && "$OO_PORT" =~ ^[0-9]{2,5}$ ]] || die "Serve ports must be numbers"
[ -n "$(env_get WORKSPACE_ONLYOFFICE_JWT_SECRET)" ] || die "WORKSPACE_ONLYOFFICE_JWT_SECRET is missing from .env"

# 0a. Keep the retained-secrets copy equal to .env (restore / new-box recovery, C2).
mkdir -p "$RETAINED_DIR"; chmod 700 "$RETAINED_DIR"
tmp="$(mktemp "$RETAINED_DIR/.workspace.env.XXXXXX")"
{
  if [ -f "$RETAINED" ]; then grep -vE "^($(echo "$GENERATED_KEYS" | tr ' ' '|'))=" "$RETAINED" || true; fi
  for k in $GENERATED_KEYS; do v="$(env_get "$k")"; [ -n "$v" ] && printf '%s=%s\n' "$k" "$v"; done
} > "$tmp"
chmod 600 "$tmp"; mv "$tmp" "$RETAINED"; unset v

# 1. Nextcloud finished the image's first-run install (with the generated throwaway admin password).
wait_for "Nextcloud" nc_installed

# 1b. Apply the typed admin password via stdin, then scrub it from this machine (Kevin Q2).
#     Runs before tailnet detection, so a missing tailnet name never delays it.
ADMIN_PW="$(env_get WORKSPACE_ADMIN_PASSWORD)"
if [ -n "$ADMIN_PW" ]; then
  if ! printf '%s\n' "$ADMIN_PW" | occ_with_pass user:resetpassword --password-from-env "$ADMIN_USER" >/dev/null 2>&1; then
    unset ADMIN_PW
    die "Nextcloud rejected the admin password from the install form (its password policy, e.g. a password found in known data breaches). Fix: bash $BUNDLE_DIR/ops/reset-password.sh $ADMIN_USER with another password, then delete the WORKSPACE_ADMIN_PASSWORD line from $ENV_FILE and re-run this script."
  fi
  env_unset WORKSPACE_ADMIN_PASSWORD
  log "admin password set from the install form; removed from .env"
fi
unset ADMIN_PW

# 0b. Where the household reaches it: this machine's tailnet name.
HOST="$(env_get WORKSPACE_PUBLIC_HOST)"
if [ -z "$HOST" ]; then
  HOST="$($TS status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
  [ -n "$HOST" ] || die "cannot work out this machine's tailnet name. Add a line WORKSPACE_PUBLIC_HOST=<name> to $ENV_FILE (keep it mode 600), then re-run this script"
  [[ "$HOST" =~ $HOST_RE ]] || die "'$HOST' is not a valid hostname"
  env_set WORKSPACE_PUBLIC_HOST "$HOST"
fi
[[ "$HOST" =~ $HOST_RE ]] || die "WORKSPACE_PUBLIC_HOST '$HOST' is not a valid hostname"
NC_URL="https://$HOST:$NC_PORT"
OO_URL="https://$HOST:$OO_PORT/"


# 2. Apps + background jobs (Redis locking is configured by the image from REDIS_HOST).
for app in calendar contacts forms onlyoffice; do
  if [ "$(occ config:app:get "$app" enabled 2>/dev/null || true)" = "yes" ]; then
    log "app $app: already enabled"
  else
    occ app:install "$app" >/dev/null 2>&1 || occ app:enable "$app" >/dev/null
    log "app $app: enabled"
  fi
done
occ background:cron >/dev/null
occ config:system:set memcache.local --value='\OC\Memcache\APCu' >/dev/null

# 3. Reverse proxy: Serve → 127.0.0.1:3070 → the (pinned) docker bridge gateway.
GW="$($DOCKER network inspect "$NET" -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"
[ -n "$GW" ] || die "cannot read the gateway address of docker network $NET"
occ config:system:set trusted_domains 1 --value=nextcloud >/dev/null
occ config:system:set trusted_domains 2 --value="$HOST" >/dev/null
occ config:system:set trusted_proxies 0 --value="$GW" >/dev/null
occ config:system:set overwritehost --value="$HOST:$NC_PORT" >/dev/null
occ config:system:set overwriteprotocol --value=https >/dev/null
occ config:system:set overwrite.cli.url --value="$NC_URL" >/dev/null
occ config:system:set overwritecondaddr --value="^${GW//./\\.}\$" >/dev/null
occ config:system:set allow_local_remote_servers --value=true --type=boolean >/dev/null
log "proxy: $NC_URL (overwrite only for requests via $GW)"

# 4. ONLYOFFICE connector. The JWT goes in on stdin: php builds the JSON from STDIN,
#    `occ config:import /dev/stdin` reads it with a BLOCKING read (no-arg stdin mode is
#    non-blocking and can race the pipe) — the secret is in no argv anywhere.
occ config:app:set onlyoffice DocumentServerUrl --value="$OO_URL" >/dev/null
occ config:app:set onlyoffice DocumentServerInternalUrl --value="http://onlyoffice/" >/dev/null
occ config:app:set onlyoffice StorageUrl --value="http://nextcloud/" >/dev/null
printf '%s\n' "$(env_get WORKSPACE_ONLYOFFICE_JWT_SECRET)" | dc exec -T -u www-data nextcloud sh -c \
  'php -r "echo json_encode([\"apps\"=>[\"onlyoffice\"=>[\"jwt_secret\"=>trim(stream_get_contents(STDIN))]]]);" | php occ config:import /dev/stdin' >/dev/null
occ config:app:set onlyoffice jwt_header --value=Authorization >/dev/null
occ config:system:set onlyoffice allow_local_address --value=true --type=boolean >/dev/null
occ config:app:set onlyoffice defFormats --value='{"docx":true,"xlsx":true,"pptx":true,"odt":true,"ods":true,"odp":true}' >/dev/null
occ config:app:set onlyoffice editFormats --value='{"odt":true,"ods":true,"odp":true}' >/dev/null
wait_for "ONLYOFFICE" oo_connected

# 5. Groups + sharing policy (Kevin Q5): crow-bot can't make public links and is never
#    suggested by autocomplete (household users enumerate only their group; typing the
#    exact login still works).
occ group:add household >/dev/null 2>&1 || true
occ group:adduser household "$ADMIN_USER" >/dev/null 2>&1 || true
occ group:add crow-bots >/dev/null 2>&1 || true
occ config:app:set core shareapi_allow_links_exclude_groups --value='["crow-bots"]' >/dev/null
occ config:app:set core shareapi_restrict_user_enumeration_to_group --value=yes >/dev/null
occ config:app:set core shareapi_restrict_user_enumeration_full_match --value=yes >/dev/null

# 6. The shared "Menu" calendar, owned by the admin (shared with people in the Calendar app).
if occ dav:list-calendars "$ADMIN_USER" 2>/dev/null | grep -qE '^\| Menu +\|'; then
  log "calendar Menu: exists"
else
  occ dav:create-calendar "$ADMIN_USER" Menu >/dev/null
  log "calendar Menu: created"
fi

# 7. crow-bot (group crow-bots, not admin) + exactly one valid app password, in .env (600).
if occ user:info "$BOT" >/dev/null 2>&1; then BOT_EXISTS=1; else BOT_EXISTS=0; fi
if [ "$BOT_EXISTS" = 1 ] && [ -n "$(env_get WORKSPACE_BOT_APP_PASSWORD)" ]; then
  log "$BOT: present"
else
  BOT_PW="$(random_pw 40)"
  if [ "$BOT_EXISTS" = 0 ]; then
    printf '%s\n' "$BOT_PW" | occ_with_pass user:add --password-from-env --display-name="Crow bot" --group crow-bots "$BOT" >/dev/null
  else
    printf '%s\n' "$BOT_PW" | occ_with_pass user:resetpassword --password-from-env "$BOT" >/dev/null
    for id in $(occ user:auth-tokens:list "$BOT" --output=json 2>/dev/null | python3 -c '
import json, sys
try: d = json.load(sys.stdin)
except Exception: d = []
print(" ".join(str(t["id"]) for t in d if t.get("name") == "'"$TOKEN_NAME"'"))'); do
      occ user:auth-tokens:delete "$BOT" "$id" >/dev/null
    done
  fi
  TOKEN="$(printf '%s\n' "$BOT_PW" | occ_with_pass user:auth-tokens:add --password-from-env --name "$TOKEN_NAME" "$BOT" | tail -n 1 | tr -d '\r')"
  unset BOT_PW
  [[ "$TOKEN" =~ ^[A-Za-z0-9]{72}$ ]] || die "could not mint the $BOT app password (unexpected occ output)"
  env_set WORKSPACE_BOT_APP_PASSWORD "$TOKEN"
  unset TOKEN
  log "$BOT: account ready; app password stored in .env (mode 600)"
fi

log "done. Workspace: $NC_URL  editor: $OO_URL"
log "next: publish both on your tailnet (Office in Crow shows the two commands)"
```

- [ ] **Step 4: Implement `bundles/workspace/ops/add-user.sh` and `ops/reset-password.sh`**

`add-user.sh`:

```bash
#!/usr/bin/env bash
# Create a household Workspace account (group "household") with a one-time password,
# printed ONCE to this terminal. Run it yourself, so the password stays out of any AI
# session transcript. Ask the person to change it at first login.
#   bash ~/.crow/bundles/workspace/ops/add-user.sh <login> "<Display Name>"
set -euo pipefail
umask 077
BUNDLE_DIR="${CROW_BUNDLE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export CROW_HOME="${CROW_HOME:-$HOME/.crow}"
DC="${WORKSPACE_DC:-docker compose}"
LOGIN="${1:-}"; NAME="${2:-}"
die() { printf '[workspace] ERROR: %s\n' "$*" >&2; exit 1; }
dc() { (cd "$BUNDLE_DIR" && $DC "$@"); }
occ_with_pass() { dc exec -T -u www-data nextcloud sh -c 'IFS= read -r NC_PASS; export NC_PASS; exec php occ "$@"' sh "$@"; }

[[ "$LOGIN" =~ ^[a-z][a-z0-9._-]{1,31}$ ]] || die "login must be 2-32 lowercase letters, digits, dots, dashes or underscores, starting with a letter"
[ "$LOGIN" != "crow-bot" ] || die "crow-bot is managed by the bootstrap"
[ -n "$NAME" ] || NAME="$LOGIN"
if dc exec -T -u www-data nextcloud php occ user:info "$LOGIN" >/dev/null 2>&1; then
  echo "Account $LOGIN already exists; nothing changed."
  exit 0
fi
PW="$(head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
printf '%s\n' "$PW" | occ_with_pass user:add --password-from-env --display-name="$NAME" --group household "$LOGIN" >/dev/null
echo "One-time password for $LOGIN: $PW"
echo "Ask them to change it at first login: avatar → Settings → Security → Password."
```

`reset-password.sh`:

```bash
#!/usr/bin/env bash
# Reset a Workspace account's password. The new password is read from the terminal
# (not echoed) or from stdin, and reaches occ only via stdin, never argv.
#   bash ~/.crow/bundles/workspace/ops/reset-password.sh <login>
set -euo pipefail
umask 077
BUNDLE_DIR="${CROW_BUNDLE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export CROW_HOME="${CROW_HOME:-$HOME/.crow}"
DC="${WORKSPACE_DC:-docker compose}"
LOGIN="${1:-}"
die() { printf '[workspace] ERROR: %s\n' "$*" >&2; exit 1; }
dc() { (cd "$BUNDLE_DIR" && $DC "$@"); }
[[ "$LOGIN" =~ ^[a-z][a-z0-9._-]{1,31}$ ]] || die "usage: reset-password.sh <login>"
if [ -t 0 ]; then IFS= read -rsp "New password for $LOGIN: " PW; echo; else IFS= read -r PW; fi
[[ "$PW" =~ ^[A-Za-z0-9!%*+,./:=?@^_~-]{12,128}$ ]] || die "password must be 12-128 letters, digits or ! % * + , - . / : = ? @ ^ _ ~"
printf '%s\n' "$PW" | dc exec -T -u www-data nextcloud sh -c 'IFS= read -r NC_PASS; export NC_PASS; exec php occ "$@"' sh user:resetpassword --password-from-env "$LOGIN" >/dev/null
unset PW
echo "Password for $LOGIN updated."
```

```bash
chmod +x bundles/workspace/ops/*.sh
```

- [ ] **Step 5: Declare the hook**

In `bundles/workspace/manifest.json`, after `"docker": {…},`, add `"postInstall": { "script": "ops/bootstrap.sh", "timeout_s": 1500 },`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm test -- tests/workspace-bootstrap.test.js tests/workspace-bundle.test.js
node scripts/build-registry.mjs && node scripts/build-registry.mjs --check
```

Expected: PASS. `workspace-bundle`'s 5c scan now covers `ops/*.sh`.

- [ ] **Step 7: Commit**

```bash
git add bundles/workspace/ops/bootstrap.sh bundles/workspace/ops/add-user.sh bundles/workspace/ops/reset-password.sh tests/workspace-bootstrap.test.js
git commit bundles/workspace registry/add-ons.json tests/workspace-bootstrap.test.js \
  -m "feat(workspace): idempotent bootstrap — stdin-only secrets, admin scrub, retained-secrets sync, crow-bot sharing limits, token hygiene"
git show --stat HEAD
```

---

### Task 6: Streaming encrypted backup, out-of-process recovery, restore, timer installer

**Files:**
- Create in `bundles/workspace/ops/`: `backup.sh`, `backup-stoppost.sh`, `restore.sh`, `restore-scratch.sh`, `restore-scratch.override.yml`, `install-backup-timer.sh`
- Test: `tests/workspace-backup.test.js`

**Interfaces:**
- Consumes: the service names, `.env`, `~/.crow/workspace/`.
- Produces:
  - archive `crow-workspace-YYYYmmdd-HHMMSS.tar`, a plain tar of `db.sql.gpg`, `files.tar.gpg` and `bundle.env.gpg`;
  - passphrase `~/.crow/workspace/backup-passphrase` (600);
  - units `crow-workspace-backup.{service,timer}` (03:55), with `ExecStopPost=… ops/backup-stoppost.sh`.
- Env:
  - `WORKSPACE_BACKUP_DEST` (required), `WORKSPACE_BACKUP_MOUNT` (optional; must be a mountpoint), `WORKSPACE_BACKUP_ALERT_LIB` (optional; defines `send_alert`);
  - seams `WORKSPACE_DC`, `WORKSPACE_GPG`, `WORKSPACE_DATA_ROOT`, `WORKSPACE_BACKUP_PASSFILE`, `WORKSPACE_BACKUP_KEEP_DAYS`, `WORKSPACE_BACKUP_HOLD_S`, `WORKSPACE_SYSTEMCTL`, `XDG_CONFIG_HOME`, `WORKSPACE_BACKUP_ONCALENDAR`.

- [ ] **Step 1: Write the failing test**

Create `tests/workspace-backup.test.js`:

```js
/** Backup/restore/recovery scripts against a FAKE docker compose; real gpg in a scratch GNUPGHOME. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, readdirSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OPS = join(import.meta.dirname, "..", "bundles", "workspace", "ops");
const SKIP = spawnSync("gpg", ["--version"]).status !== 0 && "gpg not installed";

const FAKE_DC = String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_STATE/calls.log"
case "$*" in
  *"mariadb-dump"*)
    if [ -f "$FAKE_STATE/fail-dump" ]; then echo "dump exploded" >&2; exit 2; fi
    if [ -f "$FAKE_STATE/slow-dump" ]; then sleep 5; fi
    echo "-- FAKE SQL DUMP household-db" ;;
  *" tar -C /var/www/html "*) printf 'FAKE-FILES-TAR household-doc' ;;
  *) : ;;
esac
exit 0
`;
const FAKE_ALERT_LIB = 'send_alert() { printf "%s|%s|%s\\n" "$1" "$2" "${3:-}" >> "$FAKE_STATE/alerts.log"; }\n';

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ws-bak-"));
  const ctx = { root, bundle: join(root, "bundle"), ws: join(root, "ws"), dest: join(root, "external"), st: join(root, "state"), bin: join(root, "bin"), gnupg: join(root, "gnupg") };
  for (const d of [ctx.bundle, ctx.ws, ctx.dest, ctx.st, ctx.bin, ctx.gnupg]) mkdirSync(d, { recursive: true });
  chmodSync(ctx.gnupg, 0o700);
  writeFileSync(join(ctx.bin, "dc"), FAKE_DC); chmodSync(join(ctx.bin, "dc"), 0o755);
  writeFileSync(join(ctx.bin, "alerts.sh"), FAKE_ALERT_LIB);
  writeFileSync(join(ctx.bundle, ".env"), "WORKSPACE_DB_PASSWORD=env-SECRET\n", { mode: 0o600 });
  writeFileSync(join(ctx.ws, "backup-passphrase"), "test-passphrase-123\n", { mode: 0o600 });
  return ctx;
}
function baseEnv(ctx, extra = {}) {
  return {
    PATH: process.env.PATH, HOME: ctx.root, GNUPGHOME: ctx.gnupg, FAKE_STATE: ctx.st,
    CROW_BUNDLE_DIR: ctx.bundle, WORKSPACE_DATA_ROOT: ctx.ws, WORKSPACE_BACKUP_DEST: ctx.dest,
    WORKSPACE_DC: join(ctx.bin, "dc"), WORKSPACE_BACKUP_ALERT_LIB: join(ctx.bin, "alerts.sh"), ...extra,
  };
}
const runOps = (script, ctx, extra = {}, args = []) => {
  const r = spawnSync("bash", [join(OPS, script), ...args], { encoding: "utf8", env: baseEnv(ctx, extra) });
  return { ...r, out: `${r.stdout}\n${r.stderr}` };
};
const read = (ctx, f) => (existsSync(join(ctx.st, f)) ? readFileSync(join(ctx.st, f), "utf8") : "");
const archives = (dir) => readdirSync(dir).filter((n) => /^crow-workspace-\d{8}-\d{6}\.tar$/.test(n));
const listTar = (p) => spawnSync("tar", ["-tf", p], { encoding: "utf8" }).stdout.trim().split("\n").sort();

test("happy path: archive = 3 gpg members, no plaintext; staging (600) + drive; maintenance on then off; MYSQL_PWD", { skip: SKIP }, () => {
  const ctx = setup();
  const r = runOps("backup.sh", ctx);
  assert.equal(r.status, 0, r.out);
  const [name] = archives(ctx.dest);
  assert.ok(name);
  assert.deepEqual(archives(join(ctx.ws, "backups-staging")), [name]);
  assert.equal(statSync(join(ctx.ws, "backups-staging", name)).mode & 0o777, 0o600);
  assert.deepEqual(listTar(join(ctx.dest, name)), ["bundle.env.gpg", "db.sql.gpg", "files.tar.gpg"]);
  const bytes = readFileSync(join(ctx.dest, name));
  for (const plain of ["FAKE SQL DUMP", "FAKE-FILES-TAR", "env-SECRET"]) assert.ok(!bytes.includes(plain), plain);
  const c = read(ctx, "calls.log");
  assert.ok(c.indexOf("maintenance:mode --on") < c.indexOf("mariadb-dump"));
  assert.ok(c.indexOf(" tar -C /var/www/html ") < c.indexOf("maintenance:mode --off"));
  assert.match(c, /MYSQL_PWD="\$MARIADB_ROOT_PASSWORD" exec mariadb-dump/);
  assert.equal(read(ctx, "alerts.log"), "", "no alert on success");
});

test("restore.sh round-trips the archive into a private dir", { skip: SKIP }, () => {
  const ctx = setup();
  assert.equal(runOps("backup.sh", ctx).status, 0);
  const [name] = archives(ctx.dest);
  const target = join(ctx.root, "restored");
  const r = spawnSync("bash", [join(OPS, "restore.sh"), join(ctx.dest, name), target, join(ctx.ws, "backup-passphrase")], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: ctx.root, GNUPGHOME: ctx.gnupg } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statSync(target).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(target, "db.sql"), "utf8"), "-- FAKE SQL DUMP household-db\n");
  assert.equal(readFileSync(join(target, "nextcloud-files.tar"), "utf8"), "FAKE-FILES-TAR household-doc");
  assert.equal(readFileSync(join(target, "bundle.env"), "utf8"), "WORKSPACE_DB_PASSWORD=env-SECRET\n");
  assert.ok(!existsSync(join(target, "db.sql.gpg")), "encrypted members cleaned up");
});

test("REVIEW FOCUS 4 — failure and hang still turn maintenance off; no plaintext ever on disk", { skip: SKIP }, () => {
  const ctx = setup();
  writeFileSync(join(ctx.st, "fail-dump"), "");
  const r = runOps("backup.sh", ctx);
  assert.notEqual(r.status, 0);
  const c = read(ctx, "calls.log");
  assert.ok(c.lastIndexOf("maintenance:mode --off") > c.indexOf("maintenance:mode --on"));
  assert.deepEqual(archives(ctx.dest), []);
  assert.deepEqual(readdirSync(join(ctx.ws, "backups-staging")), []);
  assert.match(read(ctx, "alerts.log"), /Workspace backup FAILED/);

  const ctx2 = setup();
  writeFileSync(join(ctx2.st, "slow-dump"), "");
  assert.notEqual(runOps("backup.sh", ctx2, { WORKSPACE_BACKUP_HOLD_S: "1" }).status, 0);
  assert.match(read(ctx2, "calls.log"), /maintenance:mode --off/);
  assert.deepEqual(readdirSync(join(ctx2.ws, "backups-staging")), []);
});

test("REVIEW FOCUS 4 (SIGKILL) — ExecStopPost recovers maintenance mode, sweeps, alerts", () => {
  const ctx = setup();
  const leftover = join(ctx.ws, "backups-staging", "run-20261003-035500.abc123");
  mkdirSync(leftover, { recursive: true });
  writeFileSync(join(leftover, "db.sql.gpg"), "x");
  const r = runOps("backup-stoppost.sh", ctx, { SERVICE_RESULT: "signal", EXIT_CODE: "killed", EXIT_STATUS: "KILL" });
  assert.equal(r.status, 0, r.out);
  assert.match(read(ctx, "calls.log"), /exec -T -u www-data nextcloud php occ maintenance:mode --off/);
  assert.equal(existsSync(leftover), false);
  assert.match(read(ctx, "alerts.log"), /Workspace backup was killed \(signal\)/);
  const ok = setup();
  assert.equal(runOps("backup-stoppost.sh", ok, { SERVICE_RESULT: "success" }).status, 0);
  assert.equal(read(ok, "alerts.log"), "", "a clean run never alerts");
  assert.match(read(ok, "calls.log"), /maintenance:mode --off/, "always forces maintenance off (idempotent)");
});

test("a run starts by sweeping run-* left by a killed run", { skip: SKIP }, () => {
  const ctx = setup();
  const leftover = join(ctx.ws, "backups-staging", "run-old.zzz");
  mkdirSync(leftover, { recursive: true });
  assert.equal(runOps("backup.sh", ctx).status, 0);
  assert.equal(existsSync(leftover), false);
});

test("preflight refusals happen BEFORE maintenance mode: no dest, not a mountpoint, unwritable, passfile mode", { skip: SKIP }, () => {
  const cases = [
    [{ WORKSPACE_BACKUP_DEST: "" }, /WORKSPACE_BACKUP_DEST is not set/],
    [{ WORKSPACE_BACKUP_MOUNT: "/tmp" }, /is not a mounted filesystem/],
  ];
  for (const [extra, re] of cases) {
    const ctx = setup();
    if (extra.WORKSPACE_BACKUP_MOUNT && spawnSync("mountpoint", ["-q", "/tmp"]).status === 0) continue; // /tmp is a mount on this host; case not representable
    const r = runOps("backup.sh", ctx, extra);
    assert.notEqual(r.status, 0); assert.match(r.out, re); assert.doesNotMatch(read(ctx, "calls.log"), /maintenance:mode/);
    assert.match(read(ctx, "alerts.log"), /ABORTED/);
  }
  const ctx = setup();
  chmodSync(join(ctx.ws, "backup-passphrase"), 0o644);
  const r = runOps("backup.sh", ctx);
  assert.notEqual(r.status, 0); assert.match(r.out, /must be mode 600/); assert.doesNotMatch(read(ctx, "calls.log"), /maintenance:mode/);
  if (!(process.getuid && process.getuid() === 0)) {
    const c2 = setup(); const locked = join(c2.root, "locked"); mkdirSync(locked); chmodSync(locked, 0o500);
    const r2 = runOps("backup.sh", c2, { WORKSPACE_BACKUP_DEST: join(locked, "sub") });
    assert.notEqual(r2.status, 0); assert.match(r2.out, /not writable/); assert.doesNotMatch(read(c2, "calls.log"), /maintenance:mode/);
  }
});

test("retention: drive keeps 14 days, staging keeps only the newest", { skip: SKIP }, () => {
  const ctx = setup();
  const old = join(ctx.dest, "crow-workspace-20260901-035500.tar");
  const recent = join(ctx.dest, "crow-workspace-20260929-035500.tar");
  mkdirSync(join(ctx.ws, "backups-staging"), { recursive: true });
  const oldStaged = join(ctx.ws, "backups-staging", "crow-workspace-20260930-035500.tar");
  for (const p of [old, recent, oldStaged]) writeFileSync(p, "x");
  const now = Date.now() / 1000; const day = 86400;
  utimesSync(old, now - 15 * day, now - 15 * day);
  utimesSync(recent, now - 3 * day, now - 3 * day);
  assert.equal(runOps("backup.sh", ctx).status, 0);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(oldStaged), false);
  assert.equal(archives(join(ctx.ws, "backups-staging")).length, 1);
});

test("install-backup-timer.sh: --dest required; units carry dest/mount/alert-lib, ExecStopPost and caps; passphrase once", () => {
  const ctx = setup();
  rmSync(join(ctx.ws, "backup-passphrase"));
  const fakeCtl = join(ctx.bin, "systemctl");
  writeFileSync(fakeCtl, '#!/usr/bin/env bash\nprintf "%s\\n" "systemctl $*" >> "$FAKE_STATE/calls.log"\n'); chmodSync(fakeCtl, 0o755);
  const env = { PATH: process.env.PATH, HOME: ctx.root, FAKE_STATE: ctx.st, CROW_HOME: join(ctx.root, "crowhome"), CROW_BUNDLE_DIR: ctx.bundle, WORKSPACE_DATA_ROOT: ctx.ws, XDG_CONFIG_HOME: join(ctx.root, "cfg"), WORKSPACE_SYSTEMCTL: fakeCtl };
  const sh = (args) => spawnSync("bash", [join(OPS, "install-backup-timer.sh"), ...args], { encoding: "utf8", env });
  assert.notEqual(sh([]).status, 0, "no --dest → refused");
  const r1 = sh(["--dest", "/mnt/external/crow-workspace-backups", "--mount", "/mnt/external", "--alert-lib", "/home/k/lab-maintenance/scripts/lib/alerts.sh"]);
  assert.equal(r1.status, 0, r1.stderr);
  const pass = join(ctx.ws, "backup-passphrase");
  const secret = readFileSync(pass, "utf8").trim();
  assert.match(secret, /^[A-Za-z0-9]{48}$/);
  assert.equal(statSync(pass).mode & 0o777, 0o600);
  assert.ok(r1.stdout.includes(secret));
  const unit = (n) => readFileSync(join(ctx.root, "cfg", "systemd", "user", n), "utf8");
  const svc = unit("crow-workspace-backup.service");
  assert.match(svc, new RegExp(`ExecStart=/bin/bash ${ctx.bundle}/ops/backup.sh`));
  assert.match(svc, new RegExp(`ExecStopPost=/bin/bash ${ctx.bundle}/ops/backup-stoppost.sh`));
  assert.match(svc, /TimeoutStartSec=2h/);
  assert.match(svc, /TimeoutStopSec=5min/, "ExecStopPost runs under TimeoutStopSec: it must exceed stoppost's 120 s bound");
  assert.match(svc, /Environment=WORKSPACE_BACKUP_DEST=\/mnt\/external\/crow-workspace-backups/);
  assert.match(svc, /Environment=WORKSPACE_BACKUP_MOUNT=\/mnt\/external/);
  assert.match(svc, /Environment=WORKSPACE_BACKUP_ALERT_LIB=\/home\/k\/lab-maintenance\/scripts\/lib\/alerts\.sh/);
  assert.doesNotMatch(svc, /Nice=|IOSchedulingClass=/);
  const tmr = unit("crow-workspace-backup.timer");
  assert.match(tmr, /OnCalendar=\*-\*-\* 03:55:00/);
  assert.match(tmr, /Persistent=true/);
  assert.doesNotMatch(tmr, /RandomizedDelaySec/);
  assert.match(read(ctx, "calls.log"), /systemctl --user enable --now crow-workspace-backup\.timer/);
  const r2 = sh(["--dest", "/mnt/external/crow-workspace-backups"]);
  assert.equal(r2.status, 0);
  assert.ok(!r2.stdout.includes(secret));
  assert.equal(readFileSync(pass, "utf8").trim(), secret);
});

test("scratch-restore override never restarts, publishes nothing, uses its own subnet", () => {
  const o = readFileSync(join(OPS, "restore-scratch.override.yml"), "utf8");
  for (const s of ["nextcloud", "nextcloud-cron", "nextcloud-db", "nextcloud-redis", "onlyoffice"]) assert.match(o, new RegExp(`  ${s}:\\n    restart: "no"`), s);
  assert.match(o, /ports: !reset \[\]/);
  assert.match(o, /subnet: 10\.89\.72\.0\/24/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/workspace-backup.test.js`
Expected: FAIL (the scripts do not exist).

- [ ] **Step 3: Implement `bundles/workspace/ops/backup.sh`**

```bash
#!/usr/bin/env bash
# Nightly Crow Workspace backup (crow-workspace-backup.timer, 03:55).
#  maintenance on → (dump | gpg) + (in-container tar | gpg) → maintenance off →
#  (.env | gpg) → one plain tar of the three .gpg members to staging, then the drive.
# No plaintext ever touches disk. Maintenance is held for the dump+snapshot only,
# bounded by HOLD_S; the trap turns it off (timeout 60) on any exit it can catch, and
# ExecStopPost=ops/backup-stoppost.sh does it after anything else (SIGKILL, OOM).
set -euo pipefail
umask 077

export CROW_HOME="${CROW_HOME:-$HOME/.crow}"
BUNDLE_DIR="${CROW_BUNDLE_DIR:-$CROW_HOME/bundles/workspace}"
WS="${WORKSPACE_DATA_ROOT:-$CROW_HOME/workspace}"
STAGING="$WS/backups-staging"
DEST="${WORKSPACE_BACKUP_DEST:-}"
MOUNT="${WORKSPACE_BACKUP_MOUNT:-}"
PASSFILE="${WORKSPACE_BACKUP_PASSFILE:-$WS/backup-passphrase}"
KEEP_DAYS="${WORKSPACE_BACKUP_KEEP_DAYS:-14}"
HOLD_S="${WORKSPACE_BACKUP_HOLD_S:-1800}"
DC="${WORKSPACE_DC:-docker compose}"
GPG="${WORKSPACE_GPG:-gpg}"
TS="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="crow-workspace-$TS.tar"

log() { printf '[workspace-backup] %s\n' "$*"; }
alert() {  # loud by design: a silent backup failure is the same as no backup
  local lib="${WORKSPACE_BACKUP_ALERT_LIB:-}"
  if [ -n "$lib" ] && [ -r "$lib" ]; then
    ( set +eu; source "$lib"; send_alert "$1" "$2" high ) >/dev/null 2>&1 || true
  fi
  printf '[workspace-backup] ALERT: %s: %s\n' "$1" "$2" >&2
}
abort() { alert "Workspace backup ABORTED" "$1"; exit 1; }
dc() { (cd "$BUNDLE_DIR" && $DC "$@"); }
occ() { dc exec -T -u www-data nextcloud php occ "$@"; }
enc() { "$GPG" --batch --yes --pinentry-mode loopback --passphrase-file "$PASSFILE" --symmetric --cipher-algo AES256 --compress-algo none -o "$1"; }

# Preflight: all before maintenance mode, so a refusal never locks anyone out.
[ -n "$DEST" ] || abort "WORKSPACE_BACKUP_DEST is not set (re-run ops/install-backup-timer.sh --dest <dir>)"
[ -f "$PASSFILE" ] || abort "no backup passphrase at $PASSFILE (run ops/install-backup-timer.sh first)"
[ "$(stat -c %a "$PASSFILE")" = "600" ] || abort "$PASSFILE must be mode 600"
[ -f "$BUNDLE_DIR/.env" ] || abort "no .env at $BUNDLE_DIR"
if [ -n "$MOUNT" ]; then mountpoint -q "$MOUNT" || abort "$MOUNT is not a mounted filesystem (drive unplugged?)"; fi
mkdir -p "$DEST" 2>/dev/null || true
{ [ -d "$DEST" ] && [ -w "$DEST" ]; } || abort "$DEST not writable"
mkdir -p "$STAGING"
rm -rf "$STAGING"/run-*            # leftovers from a killed run
WORK="$(mktemp -d "$STAGING/run-$TS.XXXXXX")"

MAINT=0
cleanup() {
  local rc=$?
  if [ "$MAINT" = 1 ]; then
    (cd "$BUNDLE_DIR" && timeout 60 $DC exec -T -u www-data nextcloud php occ maintenance:mode --off) >/dev/null 2>&1 \
      || log "WARNING: maintenance mode may still be ON (ExecStopPost will retry)"
    MAINT=0
  fi
  rm -rf "$WORK" "$STAGING/$ARCHIVE.part"
  [ "$rc" = 0 ] || alert "Workspace backup FAILED" "exit $rc at $(date +%T); see journalctl --user -u crow-workspace-backup"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 143' INT TERM

DEADLINE=$(( $(date +%s) + HOLD_S ))
check_left() { LEFT=$(( DEADLINE - $(date +%s) )); [ "$LEFT" -gt 0 ] || { log "maintenance window exceeded ${HOLD_S}s"; exit 1; }; }

occ maintenance:mode --on >/dev/null
MAINT=1
log "maintenance mode on"
check_left
(cd "$BUNDLE_DIR" && timeout --kill-after=10 "$LEFT" $DC exec -T nextcloud-db sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb-dump --single-transaction --default-character-set=utf8mb4 -uroot nextcloud') | enc "$WORK/db.sql.gpg"
check_left
(cd "$BUNDLE_DIR" && timeout --kill-after=10 "$LEFT" $DC exec -T -u root nextcloud tar -C /var/www/html -cf - .) | enc "$WORK/files.tar.gpg"
occ maintenance:mode --off >/dev/null
MAINT=0
log "maintenance mode off (dump + snapshot encrypted)"

enc "$WORK/bundle.env.gpg" < "$BUNDLE_DIR/.env"
tar -C "$WORK" -cf "$STAGING/$ARCHIVE.part" db.sql.gpg files.tar.gpg bundle.env.gpg
mv "$STAGING/$ARCHIVE.part" "$STAGING/$ARCHIVE"
chmod 600 "$STAGING/$ARCHIVE"
cp "$STAGING/$ARCHIVE" "$DEST/$ARCHIVE.part"
mv "$DEST/$ARCHIVE.part" "$DEST/$ARCHIVE"

find "$STAGING" -maxdepth 1 -name 'crow-workspace-*.tar' ! -name "$ARCHIVE" -delete
find "$DEST" -maxdepth 1 -name 'crow-workspace-*.tar' -mtime +"$((KEEP_DAYS - 1))" -delete
log "backup ok: $DEST/$ARCHIVE ($(du -h "$DEST/$ARCHIVE" | cut -f1))"
```

- [ ] **Step 4: Implement `bundles/workspace/ops/backup-stoppost.sh`**

```bash
#!/usr/bin/env bash
# ExecStopPost for crow-workspace-backup.service. systemd runs it after ANY end of the
# backup (success, failure, timeout, SIGKILL, OOM), so maintenance mode is recovered
# OUT OF PROCESS. It also sweeps work dirs and alerts when the backup could not.
set -uo pipefail
export CROW_HOME="${CROW_HOME:-$HOME/.crow}"
BUNDLE_DIR="${CROW_BUNDLE_DIR:-$CROW_HOME/bundles/workspace}"
WS="${WORKSPACE_DATA_ROOT:-$CROW_HOME/workspace}"
DC="${WORKSPACE_DC:-docker compose}"
RESULT="${SERVICE_RESULT:-unknown}"

(cd "$BUNDLE_DIR" && timeout 120 $DC exec -T -u www-data nextcloud php occ maintenance:mode --off) >/dev/null 2>&1
off_rc=$?
rm -rf "$WS/backups-staging"/run-* "$WS/backups-staging"/*.part 2>/dev/null

msg=""
case "$RESULT" in
  success|exit-code) ;;   # backup.sh reported its own outcome
  *) msg="Workspace backup was killed ($RESULT, ${EXIT_CODE:-?}/${EXIT_STATUS:-?})" ;;
esac
[ "$off_rc" = 0 ] || msg="${msg:+$msg; }could not confirm maintenance mode is off. Run: cd $BUNDLE_DIR && CROW_HOME=$CROW_HOME docker compose exec -u www-data nextcloud php occ maintenance:mode --off"
if [ -n "$msg" ]; then
  lib="${WORKSPACE_BACKUP_ALERT_LIB:-}"
  if [ -n "$lib" ] && [ -r "$lib" ]; then ( set +eu; source "$lib"; send_alert "Workspace backup" "$msg" high ) >/dev/null 2>&1; fi
  printf '[workspace-backup] ALERT: %s\n' "$msg" >&2
fi
exit 0
```

The test's `--off` assertion needs the fake dc's exit to be 0, which it is, so no alert fires for `success`.

- [ ] **Step 5: Implement `bundles/workspace/ops/restore.sh`**

```bash
#!/usr/bin/env bash
# Unpack + decrypt a Crow Workspace backup into a private directory (mode 700).
#   bash ops/restore.sh <crow-workspace-*.tar> <target-dir> [passphrase-file]
# Produces db.sql, nextcloud-files.tar (all of /var/www/html), bundle.env.
set -euo pipefail
umask 077
ARCHIVE="${1:?usage: restore.sh <archive.tar> <target-dir> [passphrase-file]}"
TARGET="${2:?usage: restore.sh <archive.tar> <target-dir> [passphrase-file]}"
PASSFILE="${3:-${CROW_HOME:-$HOME/.crow}/workspace/backup-passphrase}"
GPG="${WORKSPACE_GPG:-gpg}"
die() { printf '[workspace-restore] ERROR: %s\n' "$*" >&2; exit 1; }
[ -f "$ARCHIVE" ] || die "no archive at $ARCHIVE"
[ -f "$PASSFILE" ] || die "no passphrase file at $PASSFILE"
mkdir -p "$TARGET"; chmod 700 "$TARGET"
tar -C "$TARGET" -xf "$ARCHIVE" db.sql.gpg files.tar.gpg bundle.env.gpg
dec() { "$GPG" --batch --yes --pinentry-mode loopback --passphrase-file "$PASSFILE" --decrypt -o "$TARGET/$2" "$TARGET/$1" && rm -f "$TARGET/$1"; }
dec db.sql.gpg db.sql
dec files.tar.gpg nextcloud-files.tar
dec bundle.env.gpg bundle.env
for f in db.sql nextcloud-files.tar bundle.env; do [ -s "$TARGET/$f" ] || die "archive is missing $f"; chmod 600 "$TARGET/$f"; done
echo "Unpacked to $TARGET: db.sql, nextcloud-files.tar, bundle.env (plaintext: delete when done)"
```

- [ ] **Step 6: Implement the scratch restore (exercised live in Tasks 8 and 10)**

`bundles/workspace/ops/restore-scratch.override.yml`:

```yaml
## Used ONLY by ops/restore-scratch.sh: a restored copy never restarts by itself
## (no lingering second Nextcloud), publishes no host ports, and uses its own subnet
## (the live project pins 10.89.70.0/24).
services:
  nextcloud:
    restart: "no"
    ports: !reset []
  nextcloud-cron:
    restart: "no"
  nextcloud-db:
    restart: "no"
  nextcloud-redis:
    restart: "no"
  onlyoffice:
    restart: "no"
    ports: !reset []
networks:
  default:
    ipam:
      config: !override
        - subnet: 10.89.72.0/24
```

`bundles/workspace/ops/restore-scratch.sh`:

```bash
#!/usr/bin/env bash
# Prove a backup restores: boot it in a throwaway compose project (crow-ws-restore:
# no published ports, own subnet, never restarts, own data dir). Shows its users and
# the admin's files. Never touches crow-workspace.
#   bash ops/restore-scratch.sh <ONE crow-workspace-....tar> [passphrase-file]
#   bash ops/restore-scratch.sh --clean
set -euo pipefail
umask 077
BUNDLE_DIR="${CROW_BUNDLE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SCRATCH="${WORKSPACE_SCRATCH_DIR:-$HOME/.crow-workspace-restore}"
IMAGE="nextcloud:34.0.4-apache"
PROJECT="crow-ws-restore"
WAIT_S=300
log() { printf '[restore-scratch] %s\n' "$*"; }
die() { printf '[restore-scratch] ERROR: %s\n' "$*" >&2; exit 1; }
sdc() { CROW_HOME="$SCRATCH" docker compose -p "$PROJECT" -f "$BUNDLE_DIR/docker-compose.yml" -f "$BUNDLE_DIR/ops/restore-scratch.override.yml" --env-file "$SCRATCH/unpacked/bundle.env" "$@"; }

if [ "${1:-}" = "--clean" ]; then
  [ -f "$SCRATCH/unpacked/bundle.env" ] && sdc down -v --remove-orphans || true
  [ -d "$SCRATCH/workspace" ] && docker run --rm -v "$SCRATCH:/s" "$IMAGE" rm -rf /s/workspace
  rm -rf "$SCRATCH"
  log "scratch restore removed"
  exit 0
fi

ARCHIVE="${1:?usage: restore-scratch.sh <archive.tar> [passphrase-file] | --clean}"
[ ! -e "$SCRATCH" ] || die "$SCRATCH already exists. Run: $0 --clean"
bash "$BUNDLE_DIR/ops/restore.sh" "$ARCHIVE" "$SCRATCH/unpacked" "${2:-${CROW_HOME:-$HOME/.crow}/workspace/backup-passphrase}"
ADMIN="$(sed -n 's/^WORKSPACE_ADMIN_USER=//p' "$SCRATCH/unpacked/bundle.env" | tail -n 1)"; ADMIN="${ADMIN:-admin}"
mkdir -p "$SCRATCH/workspace/nextcloud" "$SCRATCH/workspace/db"
docker run --rm -v "$SCRATCH/workspace/nextcloud:/dst" -v "$SCRATCH/unpacked:/src:ro" "$IMAGE" \
  sh -c 'tar -C /dst -xpf /src/nextcloud-files.tar && chown -R www-data:www-data /dst'
sdc up -d nextcloud-db nextcloud-redis
waited=0
until sdc exec -T nextcloud-db healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; do
  [ "$waited" -ge "$WAIT_S" ] && die "scratch MariaDB not healthy after ${WAIT_S}s"
  sleep 5; waited=$((waited + 5))
done
sdc exec -T nextcloud-db sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -uroot nextcloud' < "$SCRATCH/unpacked/db.sql"
sdc up -d nextcloud
waited=0
until [[ "$(sdc exec -T -u www-data nextcloud php occ status --output=json 2>/dev/null)" == *'"installed":true'* ]]; do
  [ "$waited" -ge "$WAIT_S" ] && die "scratch Nextcloud not up after ${WAIT_S}s"
  sleep 5; waited=$((waited + 5))
done
sdc exec -T -u www-data nextcloud php occ maintenance:mode --off
log "status:"; sdc exec -T -u www-data nextcloud php occ status
log "users:";  sdc exec -T -u www-data nextcloud php occ user:list
log "files of $ADMIN:"; sdc exec -T -u www-data nextcloud ls -la "data/$ADMIN/files"
log "OK. Inspect, then remove it with: $0 --clean"
```

- [ ] **Step 7: Implement `bundles/workspace/ops/install-backup-timer.sh`**

```bash
#!/usr/bin/env bash
# Turn on nightly Workspace backups: a USER systemd timer (no sudo) + the backup
# passphrase (generated once, SHOWN ONCE: write it down and keep it offline).
#   bash ops/install-backup-timer.sh --dest <dir> [--mount <mountpoint>] [--alert-lib <alerts.sh>]
# On crow: --dest /mnt/external/crow-workspace-backups --mount /mnt/external
#          --alert-lib ~/lab-maintenance/scripts/lib/alerts.sh
# Idempotent: rewrites the units, never touches an existing passphrase.
set -euo pipefail
umask 077
export CROW_HOME="${CROW_HOME:-$HOME/.crow}"
BUNDLE_DIR="${CROW_BUNDLE_DIR:-$CROW_HOME/bundles/workspace}"
WS="${WORKSPACE_DATA_ROOT:-$CROW_HOME/workspace}"
PASSFILE="$WS/backup-passphrase"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ONCAL="${WORKSPACE_BACKUP_ONCALENDAR:-*-*-* 03:55:00}"
SYSTEMCTL="${WORKSPACE_SYSTEMCTL:-systemctl}"
DEST=""; MOUNT=""; ALERT_LIB=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="${2:?}"; shift 2 ;;
    --mount) MOUNT="${2:?}"; shift 2 ;;
    --alert-lib) ALERT_LIB="${2:?}"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$DEST" ] || { echo "usage: install-backup-timer.sh --dest <dir> [--mount <mountpoint>] [--alert-lib <alerts.sh>]" >&2; exit 2; }
mkdir -p "$WS" "$UNIT_DIR"

if [ ! -f "$PASSFILE" ]; then
  head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48 > "$PASSFILE"
  chmod 600 "$PASSFILE"
  echo "=== Workspace backup passphrase (shown ONCE: write it down, keep it offline) ==="
  cat "$PASSFILE"; echo
  echo "=== Without it, the backups cannot be opened. ==="
else
  echo "Backup passphrase already exists at $PASSFILE (not shown again)."
fi

{
  echo "[Unit]"
  echo "Description=Nightly Crow Workspace backup (Nextcloud DB + files, gpg-encrypted)"
  echo
  echo "[Service]"
  echo "Type=oneshot"
  echo "Environment=CROW_HOME=$CROW_HOME"
  echo "Environment=WORKSPACE_BACKUP_DEST=$DEST"
  [ -n "$MOUNT" ] && echo "Environment=WORKSPACE_BACKUP_MOUNT=$MOUNT"
  [ -n "$ALERT_LIB" ] && echo "Environment=WORKSPACE_BACKUP_ALERT_LIB=$ALERT_LIB"
  echo "ExecStart=/bin/bash $BUNDLE_DIR/ops/backup.sh"
  echo "ExecStopPost=/bin/bash $BUNDLE_DIR/ops/backup-stoppost.sh"
  echo "TimeoutStartSec=2h"
  echo "TimeoutStopSec=5min"
} > "$UNIT_DIR/crow-workspace-backup.service"

cat > "$UNIT_DIR/crow-workspace-backup.timer" <<EOF
[Unit]
Description=Nightly Crow Workspace backup

[Timer]
OnCalendar=$ONCAL
Persistent=true

[Install]
WantedBy=timers.target
EOF

$SYSTEMCTL --user daemon-reload
$SYSTEMCTL --user enable --now crow-workspace-backup.timer
if command -v loginctl >/dev/null 2>&1 && [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo yes)" != "yes" ]; then
  echo "WARNING: lingering is off for $(id -un); the timer only runs while you are logged in. Fix: sudo loginctl enable-linger $(id -un)"
fi
echo "Nightly backup enabled ($ONCAL) → $DEST. Run one now: systemctl --user start crow-workspace-backup.service"
```

```bash
chmod +x bundles/workspace/ops/*.sh
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
npm test -- tests/workspace-backup.test.js tests/workspace-bundle.test.js
bash -n bundles/workspace/ops/restore-scratch.sh
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add bundles/workspace/ops/backup.sh bundles/workspace/ops/backup-stoppost.sh bundles/workspace/ops/restore.sh bundles/workspace/ops/restore-scratch.sh bundles/workspace/ops/restore-scratch.override.yml bundles/workspace/ops/install-backup-timer.sh tests/workspace-backup.test.js
git commit bundles/workspace/ops tests/workspace-backup.test.js \
  -m "feat(workspace): streaming gpg backup (no plaintext), ExecStopPost maintenance recovery + alerts, restore, scratch restore, timer installer"
git show --stat HEAD
```

---

### Task 7: The "Office" setup page (en/es panel)

**Files:**
- Create: `bundles/workspace/panel/workspace.js`
- Modify: `bundles/workspace/manifest.json` (add `"panel": "panel/workspace.js"`), `registry/add-ons.json`
- Test: `tests/workspace-panel.test.js`

**Interfaces:**
- Consumes: the `.env` keys `WORKSPACE_PUBLIC_HOST`, `WORKSPACE_NC_SERVE_PORT`, `WORKSPACE_OO_SERVE_PORT`, `WORKSPACE_ADMIN_USER`; host ports 3070/3071; the `ops/*.sh` names.
- Produces: `WORKSPACE_STRINGS`, `readPublicSettings(crowHome)`, `workspaceUrls(settings)`, `renderWorkspacePage(settings, lang)`, and the default panel `{ id: "workspace", name: "Office", icon: "files", route: "/dashboard/workspace" }`.

- [ ] **Step 1: Write the failing test**

Create `tests/workspace-panel.test.js`:

```js
/** Crow Workspace "Office" setup page (W1 Task 7). Pure render functions — no gateway import. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import panel, { WORKSPACE_STRINGS, readPublicSettings, workspaceUrls, renderWorkspacePage } from "../bundles/workspace/panel/workspace.js";

function home(envText) {
  const h = mkdtempSync(join(tmpdir(), "ws-panel-"));
  if (envText !== null) {
    mkdirSync(join(h, "bundles", "workspace"), { recursive: true });
    writeFileSync(join(h, "bundles", "workspace", ".env"), envText, { mode: 0o600 });
  }
  return h;
}
const ENV = [
  "WORKSPACE_ADMIN_USER=admin", "WORKSPACE_DB_PASSWORD=db-SECRET-x", "WORKSPACE_ONLYOFFICE_JWT_SECRET=jwt-SECRET-y",
  "WORKSPACE_FIRSTRUN_ADMIN_PASSWORD=firstrun-SECRET-z", "WORKSPACE_BOT_APP_PASSWORD=TOKEN-zzz",
  "WORKSPACE_PUBLIC_HOST=box.tailnet-example.ts.net", "WORKSPACE_NC_SERVE_PORT=8456", "WORKSPACE_OO_SERVE_PORT=8457",
].join("\n") + "\n";
const keysDeep = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keysDeep(v, `${p}${k}.`) : [`${p}${k}`])).sort();

test("en and es carry the same keys, all non-empty", () => {
  assert.deepEqual(keysDeep(WORKSPACE_STRINGS.es), keysDeep(WORKSPACE_STRINGS.en));
  for (const lang of ["en", "es"]) for (const [k, v] of Object.entries(WORKSPACE_STRINGS[lang])) assert.ok(String(v).trim(), `${lang}.${k}`);
});

test("readPublicSettings returns only the four public keys", () => {
  assert.deepEqual(readPublicSettings(home(ENV)), {
    WORKSPACE_ADMIN_USER: "admin", WORKSPACE_PUBLIC_HOST: "box.tailnet-example.ts.net", WORKSPACE_NC_SERVE_PORT: "8456", WORKSPACE_OO_SERVE_PORT: "8457",
  });
  assert.equal(readPublicSettings(home(null)), null);
});

test("URLs: Workspace, DAV base, editor", () => {
  const u = workspaceUrls(readPublicSettings(home(ENV)));
  assert.equal(u.nc, "https://box.tailnet-example.ts.net:8456");
  assert.equal(u.dav, "https://box.tailnet-example.ts.net:8456/remote.php/dav");
  assert.equal(u.office, "https://box.tailnet-example.ts.net:8457/");
});

test("page: address, DAVx⁵, iPhone CalDAV, tailnet note, Serve commands, backup/add-user/uninstall cleanup", () => {
  const html = renderWorkspacePage(readPublicSettings(home(ENV)), "en");
  for (const s of ["https://box.tailnet-example.ts.net:8456", "https://box.tailnet-example.ts.net:8456/remote.php/dav", "DAVx",
    WORKSPACE_STRINGS.en.tailnetNote, "sudo tailscale serve --bg --https=8456 http://127.0.0.1:3070",
    "sudo tailscale serve --bg --https=8457 http://127.0.0.1:3071", "ops/install-backup-timer.sh --dest", "ops/add-user.sh",
    "sudo tailscale serve --https=8456 off", "systemctl --user disable --now crow-workspace-backup.timer"]) assert.ok(html.includes(s), s);
  assert.doesNotMatch(html, /tailscale funnel --/);
});

test("REVIEW FOCUS 5d — the page renders no secret value", () => {
  const html = renderWorkspacePage(readPublicSettings(home(ENV)), "en");
  for (const s of ["db-SECRET-x", "jwt-SECRET-y", "firstrun-SECRET-z", "TOKEN-zzz"]) assert.ok(!html.includes(s), s);
});

test("not set up / invalid values → friendly notice; values that are not shell-safe are never rendered", () => {
  for (const s of [null, { WORKSPACE_ADMIN_USER: "admin" }, { WORKSPACE_PUBLIC_HOST: "x; rm -rf ~" }, { WORKSPACE_PUBLIC_HOST: '"><script>alert(1)</script>' }]) {
    const html = renderWorkspacePage(s, "en");
    assert.ok(html.includes(WORKSPACE_STRINGS.en.notReady), JSON.stringify(s));
    assert.doesNotMatch(html, /https:\/\/:|rm -rf|<script>alert/);
  }
  const badPort = renderWorkspacePage({ WORKSPACE_PUBLIC_HOST: "box.example", WORKSPACE_NC_SERVE_PORT: "8456; reboot" }, "en");
  assert.ok(badPort.includes("--https=8456 "), "invalid port falls back to the default");
  assert.doesNotMatch(badPort, /reboot/);
});

test("Spanish render; panel metadata (Office, files icon)", () => {
  assert.ok(renderWorkspacePage(readPublicSettings(home(ENV)), "es").includes(WORKSPACE_STRINGS.es.addressH));
  assert.equal(panel.id, "workspace");
  assert.equal(panel.name, "Office");
  assert.equal(panel.icon, "files");
  assert.equal(panel.route, "/dashboard/workspace");
  assert.equal(typeof panel.handler, "function");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/workspace-panel.test.js`
Expected: FAIL: `Cannot find module …/bundles/workspace/panel/workspace.js`.

- [ ] **Step 3: Implement `bundles/workspace/panel/workspace.js`**

```js
/**
 * Crow's Nest Panel — "Office": the Crow Workspace setup page (W1 §4.5).
 *
 * Server-rendered, no client script. Reads ONLY four non-secret keys from the installed
 * bundle's .env and renders a value only if it passes the same shell-safe patterns the
 * manifest enforces (the admin block is copy-pasted into a terminal). Named "Office" so
 * the sidebar never reads "Workspace › Workspace". Copied alone to
 * $CROW_HOME/panels/workspace.js, so it imports nothing from the bundle.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const T = {
  en: {
    title: "Office",
    subtitle: "Your private office: files, documents, calendars and contacts.",
    notReady: "Workspace is not set up yet. Finish the install on the Extensions page, then reopen this page.",
    addressH: "Your Workspace address",
    addressP: "Open it in a browser on any device that is on your tailnet. Sign in with your Workspace account (not your Crow password).",
    appPwH: "One app password per device",
    appPwP: "In Workspace: your avatar → Settings → Security → Devices & sessions → Create new app password. Use it instead of your real password on phones and sync apps, so a lost device can be cut off on its own.",
    androidH: "Android",
    androidFiles: "Files: install the Nextcloud app and sign in with this server address:",
    androidDav: "Calendars and contacts: install DAVx⁵, choose “Login with URL and user name”, and paste this base URL:",
    androidDav2: "Pick the calendars (including Menu) and address books to sync. They appear in your phone's normal Calendar and Contacts apps.",
    appleH: "iPhone, iPad and Mac",
    appleP: "Settings → Calendar → Accounts → Add Account → Other → Add CalDAV Account. Server:",
    appleP2: "Do the same under Contacts with “Add CardDAV Account” and the same server. User name: your Workspace login. Password: an app password.",
    laptopH: "Laptop",
    laptopP: "Use the address above in your browser. To keep folders on disk, the Nextcloud desktop client (nextcloud.com/install) can sync them.",
    tailnetNote: "Workspace only works while the device is connected to your tailnet (Tailscale on). It is never reachable from the public internet.",
    officeP: "Document editor address (Workspace opens it for you):",
    adminH: "For the admin",
    serveP: "Run once on this machine to publish Workspace on your tailnet. Never use “tailscale funnel” for these:",
    backupP: "Turn on nightly encrypted backups (shows the backup passphrase once; keep it offline):",
    userP: "Add a household account yourself (prints a one-time password):",
    uninstallP: "Before uninstalling: stop the backups and unpublish. Your files and database stay in ~/.crow/workspace until you remove them.",
  },
  es: {
    title: "Office",
    subtitle: "Tu oficina privada: archivos, documentos, calendarios y contactos.",
    notReady: "Workspace todavía no está configurado. Termina la instalación en la página de Extensiones y vuelve a abrir esta página.",
    addressH: "La dirección de tu Workspace",
    addressP: "Ábrela en el navegador de cualquier dispositivo conectado a tu tailnet. Entra con tu cuenta de Workspace (no con tu contraseña de Crow).",
    appPwH: "Una contraseña de aplicación por dispositivo",
    appPwP: "En Workspace: tu avatar → Configuración → Seguridad → Dispositivos y sesiones → Crear nueva contraseña de aplicación. Úsala en lugar de tu contraseña real en teléfonos y apps de sincronización, así un dispositivo perdido se puede desconectar por separado.",
    androidH: "Android",
    androidFiles: "Archivos: instala la app de Nextcloud y entra con esta dirección de servidor:",
    androidDav: "Calendarios y contactos: instala DAVx⁵, elige “Iniciar sesión con URL y nombre de usuario” y pega esta URL base:",
    androidDav2: "Elige los calendarios (incluido Menu) y las libretas de direcciones que quieras sincronizar. Aparecen en las apps normales de Calendario y Contactos del teléfono.",
    appleH: "iPhone, iPad y Mac",
    appleP: "Ajustes → Calendario → Cuentas → Añadir cuenta → Otra → Añadir cuenta CalDAV. Servidor:",
    appleP2: "Haz lo mismo en Contactos con “Añadir cuenta CardDAV” y el mismo servidor. Usuario: tu login de Workspace. Contraseña: una contraseña de aplicación.",
    laptopH: "Computadora",
    laptopP: "Usa la dirección de arriba en tu navegador. Para tener carpetas en el disco, el cliente de escritorio de Nextcloud (nextcloud.com/install) puede sincronizarlas.",
    tailnetNote: "Workspace solo funciona mientras el dispositivo está conectado a tu tailnet (Tailscale activado). Nunca es accesible desde internet público.",
    officeP: "Dirección del editor de documentos (Workspace la abre por ti):",
    adminH: "Para el administrador",
    serveP: "Ejecuta una vez en esta máquina para publicar Workspace en tu tailnet. Nunca uses “tailscale funnel” para esto:",
    backupP: "Activa las copias de seguridad cifradas cada noche (muestra la frase de cifrado una sola vez; guárdala fuera de línea):",
    userP: "Agrega tú mismo una cuenta del hogar (muestra una contraseña de un solo uso):",
    uninstallP: "Antes de desinstalar: detén las copias y despublica. Tus archivos y la base de datos quedan en ~/.crow/workspace hasta que los borres.",
  },
};
export { T as WORKSPACE_STRINGS };

const PUBLIC_KEYS = ["WORKSPACE_PUBLIC_HOST", "WORKSPACE_NC_SERVE_PORT", "WORKSPACE_OO_SERVE_PORT", "WORKSPACE_ADMIN_USER"];
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const PORT_RE = /^[0-9]{2,5}$/;
const NC_HOST_PORT = 3070;
const OO_HOST_PORT = 3071;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function readPublicSettings(crowHome) {
  const p = join(crowHome, "bundles", "workspace", ".env");
  if (!existsSync(p)) return null;
  const out = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && PUBLIC_KEYS.includes(m[1])) out[m[1]] = m[2];
  }
  return out;
}

export function workspaceUrls(s) {
  const rawHost = (s && s.WORKSPACE_PUBLIC_HOST) || "";
  const host = HOST_RE.test(rawHost) ? rawHost : "";
  const ncPort = PORT_RE.test((s && s.WORKSPACE_NC_SERVE_PORT) || "") ? s.WORKSPACE_NC_SERVE_PORT : "8456";
  const ooPort = PORT_RE.test((s && s.WORKSPACE_OO_SERVE_PORT) || "") ? s.WORKSPACE_OO_SERVE_PORT : "8457";
  const nc = `https://${host}:${ncPort}`;
  return { host, ncPort, ooPort, nc, dav: `${nc}/remote.php/dav`, office: `https://${host}:${ooPort}/` };
}

export function renderWorkspacePage(settings, lang) {
  const t = T[lang === "es" ? "es" : "en"];
  const style = `<style>
    .ws-panel h1 { margin: 0 0 .25rem; font-size: 1.5rem; }
    .ws-sub { color: var(--crow-text-muted); margin: 0 0 1rem; }
    .ws-card { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border); border-radius: 10px; padding: .9rem 1rem; margin-bottom: 1rem; }
    .ws-card h2 { font-size: 1.05rem; margin: 0 0 .5rem; }
    .ws-card code, .ws-card pre { background: var(--crow-bg-surface, var(--crow-bg)); border-radius: 4px; padding: .1rem .4rem; overflow-wrap: anywhere; }
    .ws-card pre { padding: .5rem .6rem; white-space: pre-wrap; }
    .ws-note { border-left: 3px solid var(--crow-accent); }
  </style>`;
  const u = workspaceUrls(settings);
  if (!settings || !u.host) {
    return `${style}<div class="ws-panel"><h1>${esc(t.title)}</h1><p class="ws-sub">${esc(t.subtitle)}</p><div class="ws-card ws-note"><p>${esc(t.notReady)}</p></div></div>`;
  }
  const card = (h, body) => `<div class="ws-card"><h2>${esc(h)}</h2>${body}</div>`;
  return `${style}<div class="ws-panel">
    <h1>${esc(t.title)}</h1><p class="ws-sub">${esc(t.subtitle)}</p>
    <div class="ws-card ws-note"><p>${esc(t.tailnetNote)}</p></div>
    ${card(t.addressH, `<p><a href="${esc(u.nc)}" target="_blank" rel="noopener">${esc(u.nc)}</a></p><p>${esc(t.addressP)}</p><p>${esc(t.officeP)} <code>${esc(u.office)}</code></p>`)}
    ${card(t.appPwH, `<p>${esc(t.appPwP)}</p>`)}
    ${card(t.androidH, `<p>${esc(t.androidFiles)} <code>${esc(u.nc)}</code></p><p>${esc(t.androidDav)} <code>${esc(u.dav)}</code></p><p>${esc(t.androidDav2)}</p>`)}
    ${card(t.appleH, `<p>${esc(t.appleP)} <code>${esc(u.dav)}</code></p><p>${esc(t.appleP2)}</p>`)}
    ${card(t.laptopH, `<p>${esc(t.laptopP)}</p>`)}
    ${card(t.adminH, `<p>${esc(t.serveP)}</p><pre>sudo tailscale serve --bg --https=${u.ncPort} http://127.0.0.1:${NC_HOST_PORT}
sudo tailscale serve --bg --https=${u.ooPort} http://127.0.0.1:${OO_HOST_PORT}</pre>
      <p>${esc(t.backupP)}</p><pre>bash ~/.crow/bundles/workspace/ops/install-backup-timer.sh --dest &lt;backup folder&gt; --mount &lt;drive mountpoint&gt;</pre>
      <p>${esc(t.userP)}</p><pre>bash ~/.crow/bundles/workspace/ops/add-user.sh &lt;login&gt; "&lt;Name&gt;"</pre>
      <p>${esc(t.uninstallP)}</p><pre>systemctl --user disable --now crow-workspace-backup.timer
sudo tailscale serve --https=${u.ncPort} off
sudo tailscale serve --https=${u.ooPort} off</pre>`)}
  </div>`;
}

export default {
  id: "workspace",
  name: "Office",
  icon: "files",
  route: "/dashboard/workspace",
  navOrder: 58,
  category: "productivity",
  async handler(req, res, { layout, lang }) {
    const crowHome = process.env.CROW_HOME || join(homedir(), ".crow");
    const t = T[lang === "es" ? "es" : "en"];
    res.send(layout({ title: t.title, content: renderWorkspacePage(readPublicSettings(crowHome), lang) }));
  },
};
```

In `bundles/workspace/manifest.json`, add `"panel": "panel/workspace.js",` after the `postInstall` line.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- tests/workspace-panel.test.js tests/workspace-bundle.test.js
node scripts/build-registry.mjs && node scripts/build-registry.mjs --check
```

- [ ] **Step 5: Commit**

```bash
git add bundles/workspace/panel/workspace.js tests/workspace-panel.test.js
git commit bundles/workspace registry/add-ons.json tests/workspace-panel.test.js \
  -m "feat(workspace): en/es Office setup page — shell-safe values only, Serve/backup/add-user/uninstall commands"
git show --stat HEAD
```

---

### Task 8: PRE-MERGE attended smoke window on crow (scratch copies, deadman-guarded) — LIVE

This task was added at Kevin's request (Q3). Nothing has merged yet. It runs **only scratch copies from the branch**:
- the Workspace stack as compose project `crow-ws-smoke`, on 127.0.0.1:13070/13071, subnet 10.89.71.0/24, with `restart: "no"`;
- temporary Serve ports 8458/8459, plus 8460 for the header echo;
- a harness that runs the branch's installer code against the existing `searxng` bundle in a scratch `CROW_HOME`;
- read-only ownership checks against the live R4 browser and crow's 35b.

Prod is not stopped, and no model container is touched.

**Every long-lived helper is a named transient user unit with its own `RuntimeMaxSec`:**
- the argv sampler is `ws-smoke-sampler`;
- the header echo is `ws-smoke-echo`;
- the deadman, `ws-smoke-deadman`, is a transient timer.

The deadman's teardown stops them all and removes the smoke containers by compose label, even if compose can't parse. No helper is ever a backgrounded shell job, because shell state (`$!`, variables) does not survive between Bash tool calls. Every step therefore starts with `source /tmp/claude-1000/ws-smoke/vars.sh`.

**Sudo:** the operator session runs `sudo` as `sudo -S`, with the credential from the global CLAUDE.md, never written to a file or into this plan. Alternatively, Kevin runs those lines. The deadman cannot sudo, so a stale Serve mapping (tailnet-only, 502) is the only possible deadman-path leftover.

Every finding goes into `$SMOKE/findings.md`. Any FAIL means a fix commit on the branch, its unit test, and a re-run of the affected step in a new registered window, all before Task 9.

**Files:** no repo files. Scratch: `/tmp/claude-1000/ws-smoke`.

- [ ] **Step 1: Register; write the vars, helpers and teardown; arm the deadman**

Read `~/CROW-SCHEDULE.md`, then add a Reservations row:

```markdown
| **2026-10-0X HH:MM → +3 h hard cap (attended; transient units ws-smoke-{deadman,sampler,echo}, each with RuntimeMaxSec; deadman tears down at the cap)** | **Crow Workspace W1 PRE-MERGE smoke** (Kevin Q3): scratch compose `crow-ws-smoke` 127.0.0.1:13070/13071 + temp Serve 8458-8460; branch installer reinstalls `searxng` in a scratch CROW_HOME (127.0.0.1:8098); read-only ownership checks on R4 browser + 35b. No GPU, no model containers, prod untouched. | Claude session (crow) + Kevin | manual | no crow-ws-smoke/crow-ws-restore/searxng/ws-smoke-* containers AND `systemctl --user list-units 'ws-smoke-*'` empty AND serve 8458-8460 off AND row moved to Done |
```

Then:

```bash
SMOKE=/tmp/claude-1000/ws-smoke; rm -rf $SMOKE; mkdir -p $SMOKE; chmod 700 $SMOKE
cat > $SMOKE/vars.sh <<'EOF'
# Sourced at the top of EVERY smoke step (tool calls do not keep shell state).
SMOKE=/tmp/claude-1000/ws-smoke
REPO=$HOME/crow-wt-workspace
B=$SMOKE/bundle
SDC="docker compose -p crow-ws-smoke -f docker-compose.yml -f ops/smoke.override.yml"
H=crow.dachshund-chromatic.ts.net
sdc() { (cd $B && CROW_HOME=$SMOKE/home $SDC "$@"); }
occ() { sdc exec -T -u www-data nextcloud php occ "$@"; }
BKENV="CROW_HOME=$SMOKE/home CROW_BUNDLE_DIR=$B WORKSPACE_DATA_ROOT=$SMOKE/home/workspace WORKSPACE_BACKUP_DEST=$SMOKE/dest"
EOF
cat > $SMOKE/sampler.sh <<'EOF'
#!/usr/bin/env bash
# ws-smoke-sampler: every 0.2 s, record argv of the processes that could carry a secret.
# Only matching lines, deduplicated, flushed per line: the log stays small and survives a kill.
while :; do ps -eo args | grep -E 'php|occ|mariadb|redis|gpg|docker|tar ' ; sleep 0.2; done \
  | awk '!seen[$0]++ { print; fflush() }' > /tmp/claude-1000/ws-smoke/argv.log
EOF
cat > $SMOKE/echo.py <<'EOF'
# ws-smoke-echo: print the request headers Tailscale Serve forwards.
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = "".join(f"{k}: {v}\n" for k, v in self.headers.items()).encode()
        self.send_response(200); self.send_header("Content-Type", "text/plain"); self.end_headers(); self.wfile.write(body)
http.server.HTTPServer(("127.0.0.1", 13072), H).serve_forever()
EOF
cat > $SMOKE/teardown.sh <<'EOF'
#!/usr/bin/env bash
# Out-of-process teardown for the W1 smoke (deadman + normal end). Idempotent; label-based
# fallbacks so it works even if compose cannot parse (no .env yet).
SMOKE=/tmp/claude-1000/ws-smoke
B=$SMOKE/bundle
systemctl --user stop ws-smoke-sampler.service ws-smoke-echo.service 2>/dev/null
[ -f $B/.env ] && (cd $B && CROW_HOME=$SMOKE/home docker compose -p crow-ws-smoke -f docker-compose.yml -f ops/smoke.override.yml down -v --remove-orphans) 2>/dev/null
[ -d $SMOKE/restore ] && WORKSPACE_SCRATCH_DIR=$SMOKE/restore bash $B/ops/restore-scratch.sh --clean 2>/dev/null
[ -f $SMOKE/gw-home/bundles/searxng/docker-compose.yml ] && (cd $SMOKE/gw-home/bundles/searxng && CROW_HOME=$SMOKE/gw-home docker compose down -v --remove-orphans) 2>/dev/null
for p in crow-ws-smoke crow-ws-restore searxng; do
  docker ps -aq --filter label=com.docker.compose.project=$p | xargs -r docker rm -f 2>/dev/null
  docker network rm ${p}_default 2>/dev/null
done
docker rm -f ws-smoke-c1 2>/dev/null
[ -d $SMOKE/home ] && docker run --rm -v $SMOKE:/s nextcloud:34.0.4-apache rm -rf /s/home /s/restore 2>/dev/null
echo "teardown done $(date +%T). Serve 8458/8459/8460 need: sudo tailscale serve --https=<port> off (the deadman cannot sudo; a stale mapping only 502s)" >> $SMOKE/teardown.log
EOF
chmod +x $SMOKE/teardown.sh $SMOKE/sampler.sh
systemd-run --user --unit=ws-smoke-deadman --on-active=10800 /bin/bash $SMOKE/teardown.sh
systemctl --user list-timers ws-smoke-deadman.timer
```

- [ ] **Step 2: Pre-pull; build the scratch Workspace copy**

```bash
source /tmp/claude-1000/ws-smoke/vars.sh
for i in nextcloud:34.0.4-apache mariadb:11.8.9 redis:8.2.10-alpine onlyoffice/documentserver:9.4.0.1; do docker pull "$i"; done
cp -r $REPO/bundles/workspace $B
cat > $B/ops/smoke.override.yml <<'EOF'
services:
  nextcloud:
    restart: "no"
    ports: !override
      - "127.0.0.1:13070:80"
  nextcloud-cron:
    restart: "no"
  nextcloud-db:
    restart: "no"
  nextcloud-redis:
    restart: "no"
  onlyoffice:
    restart: "no"
    ports: !override
      - "127.0.0.1:13071:80"
networks:
  default:
    ipam:
      config: !override
        - subnet: 10.89.71.0/24
EOF
# .env exactly as the installer would write it (Tasks 1-3 code), plus scratch-only values.
cd $REPO && SMOKE=$SMOKE node --input-type=module -e '
import { readFileSync } from "node:fs";
import { resolveGeneratedEnv, writePrivateFile, newSecretValue } from "./servers/gateway/bundle-env-secrets.js";
import { precreateDirs } from "./servers/gateway/bundle-lifecycle.js";
const S = process.env.SMOKE, dest = S + "/bundle", home = S + "/home";
const m = JSON.parse(readFileSync(dest + "/manifest.json", "utf8"));
precreateDirs(m, home);
const gen = resolveGeneratedEnv("workspace", m, { destDir: dest, crowHome: home });
const env = { WORKSPACE_ADMIN_USER: "admin", WORKSPACE_ADMIN_PASSWORD: "Smoke-" + newSecretValue().replace(/[^A-Za-z0-9]/g, "").slice(0, 20),
  WORKSPACE_PUBLIC_HOST: "crow.dachshund-chromatic.ts.net", WORKSPACE_NC_SERVE_PORT: "8458", WORKSPACE_OO_SERVE_PORT: "8459", ...gen };
writePrivateFile(dest + "/.env", Object.entries(env).map(([k, v]) => k + "=" + v).join("\n") + "\n");
console.log("scratch .env written:", Object.keys(env).join(" "));'
stat -c '%a %n' $B/.env $SMOKE/home/secrets/bundle-env/workspace.env $SMOKE/home/workspace   # 600 600 700
# Keep the smoke admin password BEFORE bootstrap scrubs it (Kevin signs in with it; Step 6 greps argv for it).
(umask 077; sed -n 's/^WORKSPACE_ADMIN_PASSWORD=//p' $B/.env > $SMOKE/admin.pw)
```

- [ ] **Step 3: Start the sampler unit and the stack; run the bootstrap twice**

```bash
source /tmp/claude-1000/ws-smoke/vars.sh
systemd-run --user --unit=ws-smoke-sampler -p RuntimeMaxSec=10800 /bin/bash $SMOKE/sampler.sh
sdc up -d
time (cd $B && CROW_HOME=$SMOKE/home CROW_BUNDLE_DIR=$B WORKSPACE_DC="$SDC" WORKSPACE_COMPOSE_PROJECT=crow-ws-smoke bash ops/bootstrap.sh) | tee $SMOKE/bootstrap1.log
(cd $B && CROW_HOME=$SMOKE/home CROW_BUNDLE_DIR=$B WORKSPACE_DC="$SDC" WORKSPACE_COMPOSE_PROJECT=crow-ws-smoke bash ops/bootstrap.sh) | tee $SMOKE/bootstrap2.log   # no "created"/"enabled"/"account ready" lines
ls -la $SMOKE/argv.log   # small (deduplicated matching lines only)
```

- [ ] **Step 4: Verify every previously unverified item.** Record PASS/FAIL per line in `$SMOKE/findings.md`.

```bash
source /tmp/claude-1000/ws-smoke/vars.sh
# (a) healthchecks; Redis runs as the redis user (not root) and stops promptly
sdc ps --format '{{.Service}} {{.State}} {{.Health}}'
docker top crow-ws-smoke-nextcloud-redis-1 -o user,args             # user redis; argv carries no password
# (b) occ "enabled" output is literally "yes"
occ config:app:get calendar enabled; occ config:app:get onlyoffice enabled
# (c) bind roots: the precreated parent stays kh0pp 700; nextcloud/ → www-data (33), db/ → mysql (999)
stat -c '%u:%g %a %n' $SMOKE/home/workspace $SMOKE/home/workspace/nextcloud $SMOKE/home/workspace/db
# (d) pinned subnet + proxy settings; no reverse-proxy setup warning
docker network inspect crow-ws-smoke_default -f '{{(index .IPAM.Config 0).Gateway}}'   # 10.89.71.1
occ config:system:get trusted_proxies; occ config:system:get overwritecondaddr
occ setupchecks | tee $SMOKE/setupchecks.txt
# (e) admin scrub + config:import worked (JWT set) + connector check
grep -c '^WORKSPACE_ADMIN_PASSWORD=' $B/.env || true                                       # 0
for c in $(docker ps -q --filter label=com.docker.compose.project=crow-ws-smoke); do docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $c; done | grep -c '^WORKSPACE_ADMIN_PASSWORD' || true   # 0
occ config:app:get onlyoffice jwt_secret | wc -c                                           # 44 (43 chars + newline): set, never printed here
occ onlyoffice:documentserver --check
# (f) bot token valid; bot cannot create a public link; hidden from partial autocomplete
umask 077
printf 'machine 127.0.0.1 login crow-bot password %s\n' "$(sed -n 's/^WORKSPACE_BOT_APP_PASSWORD=//p' $B/.env)" > $SMOKE/bot.netrc
curl -s --netrc-file $SMOKE/bot.netrc -H 'OCS-APIRequest: true' 'http://127.0.0.1:13070/ocs/v2.php/cloud/user?format=json' | python3 -c 'import json,sys; print(json.load(sys.stdin)["ocs"]["meta"]["statuscode"])'   # 200
curl -s --netrc-file $SMOKE/bot.netrc -X PUT --data-binary 'hello' http://127.0.0.1:13070/remote.php/dav/files/crow-bot/smoke.txt -o /dev/null -w '%{http_code}\n'   # 201
curl -s --netrc-file $SMOKE/bot.netrc -H 'OCS-APIRequest: true' -X POST -d 'path=/smoke.txt&shareType=3' 'http://127.0.0.1:13070/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json' | python3 -c 'import json,sys; m=json.load(sys.stdin)["ocs"]["meta"]; print(m["statuscode"], m.get("message"))'   # NOT 200
(cd $B && CROW_HOME=$SMOKE/home CROW_BUNDLE_DIR=$B WORKSPACE_DC="$SDC" bash ops/add-user.sh smoketester "Smoke Tester") > $SMOKE/adduser.txt
printf 'machine 127.0.0.1 login smoketester password %s\n' "$(sed -n 's/^One-time password for smoketester: //p' $SMOKE/adduser.txt)" > $SMOKE/u.netrc
curl -s --netrc-file $SMOKE/u.netrc -H 'OCS-APIRequest: true' 'http://127.0.0.1:13070/ocs/v2.php/core/autocomplete/get?search=crow&itemType=files&format=json' | grep -c crow-bot     # 0
curl -s --netrc-file $SMOKE/u.netrc -H 'OCS-APIRequest: true' 'http://127.0.0.1:13070/ocs/v2.php/core/autocomplete/get?search=crow-bot&itemType=files&format=json' | grep -c crow-bot # ≥1
# (g) a known-breached admin password is refused by Nextcloud → bootstrap's recovery message (and the pre-install HIBP gate refuses it too)
printf 'Password1234\n' | (cd $B && CROW_HOME=$SMOKE/home CROW_BUNDLE_DIR=$B WORKSPACE_DC="$SDC" bash ops/reset-password.sh smoketester) ; echo rc=$?   # non-zero: policy rejected it
cd $REPO && node --input-type=module -e 'import("./servers/gateway/bundle-env-secrets.js").then(async (S) => console.log(await S.breachedValueViolation({ env_vars: [{ name: "P", check: "not_breached" }] }, { P: "Password1234" })))'   # { key: "P", ... }
# (h) compose without a file (informational; scripts never rely on it)
(cd /tmp && docker compose -p crow-ws-smoke ps 2>&1 | head -3)
# (i) gpg loopback symmetric on this host, like the CI runner
cd $REPO && npm test -- tests/workspace-backup.test.js
```

- [ ] **Step 5: Tailnet: forwarded headers (echo unit), then mixed content in a real browser**

```bash
source /tmp/claude-1000/ws-smoke/vars.sh
systemd-run --user --unit=ws-smoke-echo -p RuntimeMaxSec=3600 /usr/bin/python3 $SMOKE/echo.py
sudo -S tailscale serve --bg --https=8460 http://127.0.0.1:13072
curl -s https://$H:8460/ | tee $SMOKE/forwarded-headers.txt   # expect X-Forwarded-Proto: https, X-Forwarded-Host, X-Forwarded-For
sudo -S tailscale serve --https=8460 off; systemctl --user stop ws-smoke-echo.service
sudo -S tailscale serve --bg --https=8458 http://127.0.0.1:13070
sudo -S tailscale serve --bg --https=8459 http://127.0.0.1:13071
curl -s https://$H:8458/status.php; curl -s https://$H:8459/healthcheck
```

**[KEVIN]** In a tailnet browser:
1. Open `https://crow.dachshund-chromatic.ts.net:8458` and sign in as `admin` with the password in `$SMOKE/admin.pw` (mode 600; Kevin reads it himself). Signing in also proves that the scrubbed password was really applied.
2. Upload a .docx and open it.
3. Report that the editor loads and that the console shows **no mixed-content errors**.

- [ ] **Step 6: Backup: a real run, then a SIGKILL of the whole process group (C3 live), then a restore**

```bash
source /tmp/claude-1000/ws-smoke/vars.sh
umask 077
head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48 > $SMOKE/home/workspace/backup-passphrase
printf 'send_alert() { printf "%%s|%%s\\n" "$1" "$2" >> %s/alerts.log; }\n' "$SMOKE" > $SMOKE/alerts-fake.sh
(cd $B && env $BKENV WORKSPACE_DC="$SDC" WORKSPACE_BACKUP_ALERT_LIB=$SMOKE/alerts-fake.sh bash ops/backup.sh) | tee $SMOKE/backup1.log
tar -tf $SMOKE/dest/crow-workspace-*.tar                     # db.sql.gpg files.tar.gpg bundle.env.gpg
# SIGKILL mid-run: a transient user unit that mirrors the product unit (a bare `setsid ... & kill -9 -- -PID` did
# NOT kill anything in the 2026-10-02 smoke). RuntimeMaxSec + ExecStopPost are the real C3 mechanism.
systemd-run --user --unit=ws-smoke-backup -p RuntimeMaxSec=600 -p ExecStopPost="$B/ops/backup-stoppost.sh" \
  --setenv=WORKSPACE_DC="$SDC" $(printf -- '--setenv=%s ' $BKENV) -d bash "$B/ops/backup.sh"
sleep 3; systemctl --user kill --signal=SIGKILL ws-smoke-backup; sleep 2
# the unit's ExecStopPost (ops/backup-stoppost.sh) runs by itself after the kill: add
# --setenv=SERVICE_RESULT is NOT needed (systemd sets it); add --setenv=WORKSPACE_BACKUP_ALERT_LIB=$SMOKE/alerts-fake.sh
# to the systemd-run line above to capture its alert. Watch `occ maintenance:mode` flip enabled -> disabled.
occ maintenance:mode                                          # "disabled"
ls $SMOKE/home/workspace/backups-staging/; cat $SMOKE/alerts.log   # no run-*; one "killed (signal)" alert
systemctl --user stop ws-smoke-sampler.service
# C4 live: no secret value ever appeared in any sampled argv (patterns via a file, never argv)
{ sed -n 's/^[A-Z_]*=//p' $B/.env; sed -n 's/^[A-Z_]*=//p' $SMOKE/home/secrets/bundle-env/workspace.env; cat $SMOKE/admin.pw; } | sort -u | grep -v '^$' > $SMOKE/secret-values.txt
grep -cFf $SMOKE/secret-values.txt $SMOKE/argv.log || echo "0 secrets in argv"   # only the Ruling 14 residual may appear (image first install: throwaway + DB password); anything else = FAIL
grep -Ff $SMOKE/secret-values.txt $SMOKE/argv.log | sed -E 's/[A-Za-z0-9_-]{20,}/<redacted>/g' | sort -u | head
(cd $B && WORKSPACE_SCRATCH_DIR=$SMOKE/restore bash ops/restore-scratch.sh "$(ls -t $SMOKE/dest/crow-workspace-*.tar | head -n 1)" $SMOKE/home/workspace/backup-passphrase) | tee $SMOKE/restore.log
(cd $B && WORKSPACE_SCRATCH_DIR=$SMOKE/restore bash ops/restore-scratch.sh --clean)
```

- [ ] **Step 7: The ownership guard, live (R1)**

7a. Read-only checks against real installs. Neither may be refused:
- R4's per-instance browser, project `crow-browser-r4` via its `.env`;
- crow's 35b, whose containers were started from `~/crow-addons`.

```bash
source /tmp/claude-1000/ws-smoke/vars.sh
mkdir -p $SMOKE/ro-data
cd $REPO
CROW_HOME=$HOME/.crow-r4 CROW_DATA_DIR=$SMOKE/ro-data node --input-type=module -e 'const B = await import("./servers/gateway/routes/bundles.js"); console.log(JSON.stringify(await B.composeOwnershipCheck("browser")))'
#   expect {"project":"crow-browser-r4","refusal":null,...}
CROW_HOME=$HOME/.crow CROW_DATA_DIR=$SMOKE/ro-data node --input-type=module -e 'const B = await import("./servers/gateway/routes/bundles.js"); console.log(JSON.stringify(await B.composeOwnershipCheck("llamacpp-vulkan-qwen36-35b-a3b")))'
#   expect refusal null (a "legacy path" warning naming ~/crow-addons is fine)
CROW_HOME=$HOME/.crow CROW_DATA_DIR=$SMOKE/ro-data node --input-type=module -e 'const B = await import("./servers/gateway/routes/bundles.js"); console.log(JSON.stringify(await B.composeOwnershipCheck("browser")))'
#   expect refusal null (crow's own browser)
```

7b. The generic installer, run for real, against `searxng` in a scratch `CROW_HOME`. A fake *second Crow install that lists searxng* must block the install. Then install, uninstall and reinstall must all work.

```bash
source /tmp/claude-1000/ws-smoke/vars.sh
mkdir -p $SMOKE/gw-home $SMOKE/gw-data $SMOKE/otherhome/bundles/searxng
printf '[{"id":"searxng","type":"bundle"}]\n' > $SMOKE/otherhome/installed.json
cat > $SMOKE/smokeB.mjs <<'EOF'
// Drives the branch's real installer code (no stubs) against searxng in a scratch CROW_HOME.
const REPO = process.env.HOME + "/crow-wt-workspace";
const SMOKE = "/tmp/claude-1000/ws-smoke";
Object.assign(process.env, { CROW_HOME: SMOKE + "/gw-home", CROW_DATA_DIR: SMOKE + "/gw-data",
  CROW_AUTO_UPDATE: "0", CROW_DISABLE_HEALTH_MONITOR: "1", CROW_DISABLE_INSTANCE_SYNC: "1", CROW_DISABLE_NOSTR: "1", CROW_DISABLE_MODEL_ORCHESTRATION: "1" });
const { execFileSync } = await import("node:child_process");
const { statSync, existsSync } = await import("node:fs");
const express = (await import(REPO + "/node_modules/express/index.js")).default;
const B = await import(REPO + "/servers/gateway/routes/bundles.js");
const say = (...a) => console.log("[smokeB]", ...a);
async function install() {
  const v = await B.validateInstall("searxng", { envVars: {}, forceInstall: true });
  if (!v.ok) return { ok: false, reason: v.error };
  const job = B._createJobForTest("searxng", "install");
  return B.runInstallJob("searxng", {}, { job, installedSnapshot: v.installed, consentVerified: v.consentVerified, manifest: v.manifest });
}
async function uninstall() {
  const app = express(); app.use(express.json()); app.use(B.default());
  const srv = app.listen(0, "127.0.0.1"); await new Promise((r) => srv.once("listening", r));
  await fetch(`http://127.0.0.1:${srv.address().port}/bundles/api/uninstall`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle_id: "searxng" }) });
  const dir = process.env.CROW_HOME + "/bundles/searxng"; const t = Date.now() + 120_000;
  while (existsSync(dir) && Date.now() < t) await new Promise((r) => setTimeout(r, 500));
  srv.close();
}
const label = (wd) => ["create", "--name", "ws-smoke-c1", "--label", "com.docker.compose.project=searxng", "--label", `com.docker.compose.project.working_dir=${wd}`, "nextcloud:34.0.4-apache", "true"];
// (1) owned by ANOTHER CROW INSTALL of searxng → refused
execFileSync("docker", label(SMOKE + "/otherhome/bundles/searxng"));
let r = await install(); say("C1 foreign Crow install:", r.ok ? "INSTALLED (FAIL)" : "refused: " + r.reason);
execFileSync("docker", ["rm", "-f", "ws-smoke-c1"]);
// (2) a legacy path (no installed.json) → proceeds with a warning
execFileSync("docker", label(SMOKE + "/legacy-addons/searxng"));
r = await install(); say("legacy-path owner:", r.ok ? "installed (ok, warned)" : "FAIL " + r.reason);
execFileSync("docker", ["rm", "-f", "ws-smoke-c1"]);
say(".env mode:", (statSync(process.env.CROW_HOME + "/bundles/searxng/.env").mode & 0o777).toString(8));
await uninstall(); say("uninstall #1 done");
r = await install(); say("install #2 (reinstall):", r.ok ? "ok" : "FAIL " + r.reason);
await uninstall(); say("uninstall #2 done");
process.exit(0);
EOF
node $SMOKE/smokeB.mjs 2>&1 | tee $SMOKE/smokeB.log
docker ps -a --filter label=com.docker.compose.project=searxng --format '{{.Names}}'   # empty
```

Expected:
- `C1 foreign Crow install: refused: …belong to another Crow install…`;
- `legacy-path owner: installed (ok, warned)`;
- `.env mode: 600`;
- reinstall ok;
- no searxng containers left.

- [ ] **Step 8: Teardown, disarm, record**

```bash
source /tmp/claude-1000/ws-smoke/vars.sh
bash $SMOKE/teardown.sh
sudo -S tailscale serve --https=8458 off; sudo -S tailscale serve --https=8459 off
tailscale serve status | grep -cE ':(8458|8459|8460)' || true                     # 0
systemctl --user stop ws-smoke-deadman.timer ws-smoke-deadman.service 2>/dev/null
systemctl --user list-units --all 'ws-smoke-*' --no-legend                        # empty
docker ps -a --format '{{.Names}}' | grep -E 'crow-ws-(smoke|restore)|searxng|ws-smoke' || echo "clean"
cp $SMOKE/findings.md ~/crow-weekend-push/reports/workspace-w1-smoke-findings.md
rm -rf $SMOKE   # held plaintext secrets; nothing still writes into it (sampler unit stopped)
```

Move the CROW-SCHEDULE row to Done with the PASS/FAIL summary. For **every FAIL**: write a fix commit with its unit test, then re-run the affected step in a new registered window. Task 9 starts only when the findings are all PASS, or when Kevin has explicitly accepted an item.

---

### Task 9: Operator guide, full gates, PR, merge, deploy

**Files:**
- Create: `docs/guide/workspace.md`
- Modify: `docs/.vitepress/config.ts` (the English guide sidebar, after `{ text: 'Phone (assistant calls)', link: '/guide/phone' },`)

- [ ] **Step 1: Write `docs/guide/workspace.md`**

```markdown
# Crow Workspace

A private office on your own machine: Nextcloud for files, sharing, calendars, contacts and forms, with ONLYOFFICE for editing Word/Excel/PowerPoint files together. Reachable only from your tailnet. One Workspace per machine: a second Crow instance on the same machine refuses to install or manage it.

## Install
1. Extensions → **Crow Workspace** → Install. Type an admin password (12–128 characters: letters, digits and `! % * + , - . / : = ? @ ^ _ ~`). That is the only thing you type; every internal password is generated and stored at mode 600. Setup uses your admin password once and then removes it from this machine.
2. Setup finishes by itself after the containers start (first install: a few minutes). If it reports "setup is incomplete", fix the cause and run the printed command (`bash ~/.crow/bundles/workspace/ops/bootstrap.sh`); re-running is always safe.
3. Open **Office** in Crow's sidebar and run the two `sudo tailscale serve …` commands it shows. Never use `tailscale funnel` for these ports.
4. If setup cannot detect your tailnet name, add `WORKSPACE_PUBLIC_HOST=<name>` to `~/.crow/bundles/workspace/.env` (keep it mode 600) and re-run the bootstrap.

## Phones and laptops
The Office page has the exact addresses: the Nextcloud app plus DAVx⁵ on Android, CalDAV/CardDAV on iPhone/Mac, and the browser or desktop client on laptops. Use one app password per device. Everything works only while the device is on the tailnet. The shared calendar is called "Menu"; some phones may show it by its internal name.

## Accounts and passwords
- **Add a person** (run it yourself): `bash ~/.crow/bundles/workspace/ops/add-user.sh <login> "<Name>"`. It prints a one-time password once; they change it at first login (avatar → Settings → Security). New people join the `household` group.
- **If setup says "Nextcloud rejected the admin password"** (its password policy refuses passwords found in data breaches; the installer already checks this when it can reach haveibeenpwned.com): run `bash ~/.crow/bundles/workspace/ops/reset-password.sh <admin login>` with another password, delete the `WORKSPACE_ADMIN_PASSWORD=` line from `~/.crow/bundles/workspace/.env`, then re-run `bash ~/.crow/bundles/workspace/ops/bootstrap.sh`.
- **Reset a password:** `bash ~/.crow/bundles/workspace/ops/reset-password.sh <login>`. It asks for the new password without echoing it and passes it to Nextcloud over stdin, never on a command line.
- **crow-bot** is Crow's own account: not an admin, cannot create public links, never suggested when you type part of a name (type `crow-bot` exactly to share with it). It sees only what you share with it.

## Backups
- **Turn on:** `bash ~/.crow/bundles/workspace/ops/install-backup-timer.sh --dest <folder> --mount <drive mountpoint> [--alert-lib <alerts.sh>]`. On crow: `--dest /mnt/external/crow-workspace-backups --mount /mnt/external --alert-lib ~/lab-maintenance/scripts/lib/alerts.sh`. It shows the backup passphrase **once**; keep it offline.
- **Nightly at 03:55:**
  1. maintenance mode, held only for the database dump and file snapshot, at most 30 min;
  2. everything streamed straight into gpg (AES256), so no plaintext ever touches disk;
  3. one `.tar` of three encrypted parts goes to the drive and is kept 14 days.
- If the job is killed, a stop hook turns maintenance mode back off and sends an alert. An unplugged drive aborts the run before anything starts.
- **Run one now:** `systemctl --user start crow-workspace-backup.service`, then `journalctl --user -u crow-workspace-backup -n 30`.

## Restore
- **Test a backup without touching the live one:** `bash ~/.crow/bundles/workspace/ops/restore-scratch.sh <crow-workspace-*.tar>`. It boots a portless copy that never restarts by itself and lists its users and files. Remove it with `--clean`.
- **Restore for real** (replaces the live data; register a window first):
  0. `systemctl --user stop crow-workspace-backup.timer`. Re-enable it with `start` at the end: a nightly run mid-restore would toggle maintenance mode under you.
  1. `export CROW_HOME=~/.crow && cd ~/.crow/bundles/workspace && docker compose down`. Every `docker compose` below runs in this shell, because the compose file needs `CROW_HOME`.
  2. `sudo mv ~/.crow/workspace/nextcloud ~/.crow/workspace/nextcloud.old && sudo mv ~/.crow/workspace/db ~/.crow/workspace/db.old`
  3. `bash ops/restore.sh <archive> ~/ws-restore`, then copy `~/ws-restore/bundle.env` over `.env` (keep mode 600). **Restoring onto a different machine:** blank the `WORKSPACE_PUBLIC_HOST=` line first, so the bootstrap detects the new tailnet name.
  4. `mkdir -p ~/.crow/workspace/nextcloud && docker run --rm -v ~/.crow/workspace/nextcloud:/dst -v ~/ws-restore:/src:ro nextcloud:34.0.4-apache sh -c 'tar -C /dst -xpf /src/nextcloud-files.tar && chown -R www-data:www-data /dst'`
  5. `docker compose up -d nextcloud-db nextcloud-redis`, wait until healthy, then `docker compose exec -T nextcloud-db sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -uroot nextcloud' < ~/ws-restore/db.sql`
  6. `docker compose up -d`, then `docker compose exec -u www-data nextcloud php occ maintenance:mode --off`, then `bash ops/bootstrap.sh`. The bootstrap also re-syncs `~/.crow/secrets/bundle-env/workspace.env` to the restored passwords, so a later uninstall/reinstall keeps working.
  7. Delete `~/ws-restore` (it holds plaintext).

## Uninstalling
Uninstall removes the containers and Crow's copy of the extension. It **keeps**:
- your files and database (`~/.crow/workspace`);
- the generated secrets (`~/.crow/secrets/bundle-env/workspace.env`);
- the backup timer;
- the two tailnet addresses.

"Delete data" in the dialog does **not** remove those files. To remove everything:
1. `systemctl --user disable --now crow-workspace-backup.timer && rm ~/.config/systemd/user/crow-workspace-backup.*`
2. `sudo tailscale serve --https=8456 off && sudo tailscale serve --https=8457 off`
3. After a last backup: `sudo rm -rf ~/.crow/workspace && rm ~/.crow/secrets/bundle-env/workspace.env`

## Upgrades
Images are pinned. Upgrade Nextcloud **one major version at a time** (34 → 35 → 36), each in a registered window and after a fresh backup, with the backup timer stopped for the window (`systemctl --user stop crow-workspace-backup.timer`, then `start` afterwards):
1. Bump the `nextcloud` tag in the repo bundle (with a manifest version bump) AND in the installed `~/.crow/bundles/workspace/docker-compose.yml`. A version refresh never re-copies compose files.
2. `export CROW_HOME=~/.crow && cd ~/.crow/bundles/workspace && docker compose pull && docker compose up -d`
3. Check `occ status`.

Never auto-update.

## Limits
- ONLYOFFICE Community Edition allows about 20 simultaneous connections and no mobile *editing* in the browser (viewing works).
- The editor container keeps no volumes, so recreating it (an upgrade, a restart with new settings) drops documents that are open at that moment. Unsaved typing is lost; saved files are safe.
- Fine for a household.
```

In `docs/.vitepress/config.ts`, after `{ text: 'Phone (assistant calls)', link: '/guide/phone' },`, add `{ text: 'Crow Workspace', link: '/guide/workspace' },`.

- [ ] **Step 2: Run every CI gate locally**

```bash
cd ~/crow-wt-workspace
npm test                                   # FULL suite; 0 failures
node scripts/check-port-allocation.js      # OK
node scripts/build-registry.mjs --check    # OK
npm test -- tests/auth-network.test.js     # 21/21
grep -rnI "changeme" bundles/workspace bundles/nextcloud || echo "no changeme"
```

- [ ] **Step 3: Commit the docs and push**

```bash
git add docs/guide/workspace.md
git commit docs/guide/workspace.md docs/.vitepress/config.ts -m "docs(workspace): operator guide — install, phones, accounts, backups, restore, uninstall, upgrades"
git show --stat HEAD
git pull --rebase origin main
git push -u origin feat/workspace-w1-platform
```

- [ ] **Step 4: Open the PR** with `mcp__github__create_pull_request`:
  - owner `kh0pper`, repo `crow`, head `feat/workspace-w1-platform`, base `main`;
  - title "Crow Workspace W1: platform extension + generic secrets, hooks and compose-ownership guard";
  - body: Tasks 1–7 summary, the Rulings list, the smoke findings path (`~/crow-weekend-push/reports/workspace-w1-smoke-findings.md`, summarized inline), and "Post-merge acceptance (spec §4.7) runs as Task 10."
  - No AI attribution.

- [ ] **Step 5: Gate the merge on check-runs**

```bash
SHA=$(git rev-parse HEAD)
curl -s "https://api.github.com/repos/kh0pper/crow/commits/$SHA/check-runs" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); runs=d["check_runs"]; print(len(runs)); [print(r["name"], r["status"], r["conclusion"]) for r in runs]'
```

Every run must be `completed success` (`suite`, `static-checks`, `audit`); an empty list on a current sha is wrong. Then merge with `mcp__github__merge_pull_request` (squash).

- [ ] **Step 6: Deploy to crow**

```bash
git -C ~/crow branch --show-current          # main (never checkout in ~/crow)
git -C ~/crow pull --ff-only origin main
sudo systemctl restart crow-gateway crow-r4-gateway
sleep 20; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/health   # 200
systemctl is-active crow-gateway crow-r4-gateway
stat -c '%a %n' ~/.crow/bundles/*/.env ~/.crow-r4/bundles/*/.env 2>/dev/null | grep -v '^600' || echo "all bundle .env files 600 (boot repair)"
```

---

### Task 10: LIVE install and §4.7 acceptance on crow (registered window; [KEVIN] steps)

This task is attended, and nothing in prod is stopped. If the crow gateway is unhealthy for more than 5 minutes, run `sudo systemctl restart crow-gateway` and stop.

- [ ] **Step 1: Register the window** in `~/CROW-SCHEDULE.md`:

```markdown
| **2026-10-0X HH:MM → est. +2 h (attended; no GPU, no model containers; Workspace first start ~3-5 GB RAM)** | **Crow Workspace W1 first start + acceptance** (spec §4.7) | Claude session (crow) + Kevin | manual | crow-workspace healthy AND gateway + r4 health unchanged AND row moved to Done |
```

- [ ] **Step 2: Before snapshot (§4.7-7).** The 35b is on-demand, so it is not a stable signal. Snapshot the gateways and the model-status API instead:

```bash
EV=/tmp/claude-1000/ws-accept; mkdir -p $EV; chmod 700 $EV
wdc() { (cd ~/.crow/bundles/workspace && CROW_HOME=$HOME/.crow docker compose "$@"); }
R4PORT=$(systemctl show -p Environment crow-r4-gateway | grep -oE 'PORT=[0-9]+' | head -1 | cut -d= -f2)
snap() {
  systemctl is-active crow-gateway crow-r4-gateway
  curl -s -o /dev/null -w 'gw %{http_code}\n' http://127.0.0.1:3001/health
  [ -n "$R4PORT" ] && curl -s -o /dev/null -w 'r4 %{http_code}\n' http://127.0.0.1:$R4PORT/health
  docker ps --format '{{.Names}}' | grep -v '^crow-workspace' | sort
}
snap > $EV/pre.txt
```

- [ ] **Step 3: Pre-pull the images**

```bash
for i in nextcloud:34.0.4-apache mariadb:11.8.9 redis:8.2.10-alpine onlyoffice/documentserver:9.4.0.1; do docker pull "$i"; done
```

- [ ] **Step 4: [KEVIN] Install.** Kevin opens Extensions → Crow Workspace → Install and types the admin password. Claude watches:

```bash
wdc ps; journalctl -u crow-gateway --since "-20 min" | grep -i workspace | tail -40
```

Expected job log:
- "Generated 5 internal secret(s)";
- "Prepared data folders";
- "Installation tracked" **before** "Running post-install setup";
- "[workspace] admin password set from the install form; removed from .env";
- "[workspace] done.".

- [ ] **Step 5: Verify the install surface (§4.7-1, and Kevin Q2/Q5)**

```bash
stat -c '%a %n' ~/.crow/bundles/workspace/.env ~/.crow/secrets/bundle-env/workspace.env      # 600 600
grep -rIl -i 'change_\?me' ~/.crow/bundles/workspace ~/.crow/secrets/bundle-env/workspace.env || echo "no changeme"
grep -c '^WORKSPACE_' ~/crow/.env || true                                                     # 0
grep -c '^WORKSPACE_ADMIN_PASSWORD=' ~/.crow/bundles/workspace/.env || true                   # 0 (scrubbed)
cut -d= -f1 ~/.crow/bundles/workspace/.env | sort                                             # key NAMES only
wdc ps --format '{{.Service}} {{.State}} {{.Health}}'                                         # 5 running; db/redis/onlyoffice healthy
ss -ltn | grep -E ':(3070|3071) '                                                             # 127.0.0.1 only
docker network inspect crow-workspace_default -f '{{(index .IPAM.Config 0).Gateway}}'          # 10.89.70.1
stat -c '%a %U %n' ~/.crow/workspace ~/.crow/workspace/backups-staging                       # 700 kh0pp
wdc exec -T -u www-data nextcloud php occ app:list | grep -E 'calendar|contacts|forms|onlyoffice'
wdc exec -T -u www-data nextcloud php occ onlyoffice:documentserver --check
wdc exec -T -u www-data nextcloud php occ dav:list-calendars admin
wdc exec -T -u www-data nextcloud php occ user:info crow-bot                                   # groups: crow-bots only
wdc exec -T -u www-data nextcloud php occ config:system:get memcache.locking                   # \OC\Memcache\Redis
wdc exec -T -u www-data nextcloud php occ config:app:get core backgroundjobs_mode             # cron
wdc exec -T -u www-data nextcloud php occ config:app:get core shareapi_allow_links_exclude_groups   # ["crow-bots"]
wdc exec -T -u www-data nextcloud php occ setupchecks | tee $EV/setupchecks.txt
```

- [ ] **Step 6: Publish and probe (§4.7-2)**

```bash
sudo tailscale serve --bg --https=8456 http://127.0.0.1:3070
sudo tailscale serve --bg --https=8457 http://127.0.0.1:3071
tailscale serve status | tee $EV/serve.txt          # 8456/8457 tailnet only; Funnel block unchanged
H=crow.dachshund-chromatic.ts.net
curl -s https://$H:8456/status.php; curl -s https://$H:8457/healthcheck
ssh raven "curl -s -o /dev/null -w '%{http_code}\n' https://$H:8456/status.php"   # 200
ssh black-swan "curl -sS -m 15 --doh-url https://cloudflare-dns.com/dns-query https://$H:8456/status.php; echo rc=\$?"   # FAIL (rc≠0)
ssh black-swan "curl -sS -m 15 --doh-url https://cloudflare-dns.com/dns-query https://$H:8457/healthcheck; echo rc=\$?"  # FAIL
ssh black-swan "curl -s -m 15 --doh-url https://cloudflare-dns.com/dns-query -o /dev/null -w '%{http_code}\n' https://$H/"  # not Nextcloud
cd ~/crow && npm test -- tests/auth-network.test.js  # 21/21
```

- [ ] **Step 7: [KEVIN] Accounts and sharing.** Kevin himself runs `bash ~/.crow/bundles/workspace/ops/add-user.sh dayane "Dayane"`, which keeps the one-time password out of Claude's transcript, and gives it to Dayane. Dayane signs in and changes it. Then, as admin, Kevin:
  - shares **Menu** with `dayane` (can edit);
  - creates **Shared with Crow** and shares it with `crow-bot`, typing the full name;
  - puts `acceptance-test.docx` in a folder shared with Dayane.

- [ ] **Step 8: [KEVIN] Co-editing (§4.7-3).** Kevin and Dayane open `acceptance-test.docx` from two devices at once, and each sees the other's edits live.

- [ ] **Step 9: [KEVIN] Phones (§4.7-4).** Both phones get an app password and DAVx⁵ with the Office page's base URL. A Menu event made on Kevin's phone must appear on Dayane's. Also check how both phones show the calendar's name.

- [ ] **Step 10: Bot isolation (§4.7-5).** The token reaches curl through a mode-600 netrc file, never argv:

```bash
umask 077
printf 'machine %s login crow-bot password %s\n' "$H" "$(sed -n 's/^WORKSPACE_BOT_APP_PASSWORD=//p' ~/.crow/bundles/workspace/.env)" > $EV/bot.netrc
curl -s -o /dev/null -w 'admin root: %{http_code}\n' --netrc-file $EV/bot.netrc -X PROPFIND -H 'Depth: 1' https://$H:8456/remote.php/dav/files/admin/
curl -s -o /dev/null -w 'shared: %{http_code}\n' --netrc-file $EV/bot.netrc -X PROPFIND -H 'Depth: 1' "https://$H:8456/remote.php/dav/files/crow-bot/Shared%20with%20Crow/"
rm -f $EV/bot.netrc
```

Expected: the admin root is 403 or 404; shared is 207.

- [ ] **Step 11: Backup and restore (§4.6, §4.7-6).** **[KEVIN]** runs this and writes the passphrase down offline:

```bash
bash ~/.crow/bundles/workspace/ops/install-backup-timer.sh --dest /mnt/external/crow-workspace-backups --mount /mnt/external --alert-lib ~/lab-maintenance/scripts/lib/alerts.sh
```

Then Claude runs:

```bash
systemctl --user cat crow-workspace-backup.service | grep -E 'ExecStopPost|WORKSPACE_BACKUP'
systemctl --user list-timers crow-workspace-backup.timer        # next 03:55
systemctl --user start crow-workspace-backup.service
journalctl --user -u crow-workspace-backup -n 30 --no-pager | tee $EV/backup.txt   # "backup ok"
A=$(ls -t /mnt/external/crow-workspace-backups/crow-workspace-*.tar | head -1); tar -tf "$A"   # three .gpg members
wdc exec -T -u www-data nextcloud php occ maintenance:mode       # disabled
bash ~/.crow/bundles/workspace/ops/restore-scratch.sh "$A" | tee $EV/restore.txt   # users admin, dayane, crow-bot; the docx listed
bash ~/.crow/bundles/workspace/ops/restore-scratch.sh --clean
```

- [ ] **Step 12: After snapshot (§4.7-7) and capacity**

```bash
snap > $EV/post.txt; diff $EV/pre.txt $EV/post.txt && echo "prod unchanged"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | grep crow-workspace | tee $EV/ram.txt
```

- [ ] **Step 13: Close out the schedule.** In `~/CROW-SCHEDULE.md`:
  - Add to "Other timers/crons": `| 03:55 | crow-workspace-backup.timer (user): Workspace maintenance ≤30 min + gpg stream to /mnt/external; ExecStopPost recovery; steady-state RAM <ram.txt totals>; db/redis oom_score_adj -500 |`.
  - Move the reservation row to Done with per-§4.7 PASS/FAIL.

File any failure as a follow-up PR (fix the product, not the instance).

- [ ] **Step 14: Handoff to Kevin:**
  - each §4.7 item with its evidence path;
  - the smoke findings;
  - the measured RAM;
  - the Serve ports;
  - the reminder that the backup passphrase exists only on paper and in `~/.crow/workspace/backup-passphrase`;
  - the reset path (`ops/reset-password.sh`);
  - that W2 is unblocked and will read `WORKSPACE_BOT_APP_PASSWORD` from the bundle `.env`.

---

## Self-Review

**1. Spec coverage**

| Spec § | Covered by |
|---|---|
| 4.1 packaging, five services, restart, loopback | Task 4 |
| 4.1 pinned images in manifest, ports, RAM/disk | Task 4, Ruling 2 |
| 4.2 Serve | Tasks 7, 8, 10 |
| 4.2 trusted_domains, overwrite*, proxies | Task 5 (pinned subnet: Task 4) |
| 4.2 JWT and internal URLs | Tasks 4, 5 |
| 4.2 no Funnel, auth-network, public probe | Tasks 9, 10 |
| 4.3 generated secrets at 600 | Tasks 1, 2 |
| 4.3 only the admin password typed, then scrubbed | Tasks 2, 4, 5 |
| 4.3 bootstrap steps 1–5, idempotent | Task 5 (Dayane: Task 10 Step 7) |
| 4.4 data dir | Task 4 |
| 4.4 backup steps, trap + out-of-process recovery, timeout, 14 days, gpg, passphrase | Task 6 |
| 4.4 restore documented and tested | Tasks 6, 8, 9, 10 |
| 4.5 setup page | Task 7 |
| 4.6 box schedule | Tasks 8, 10 (timer as a standing automation) |
| 4.7 items 1–7 | Task 10 Steps 2–12 |

Spec §6 risks are covered in the Task 9 guide plus Ruling 19. Review C1–C4 map to Rulings 9, 5/6 + Task 5, 13, and 14. Suggestions S1–S16 map to Task 8 and Rulings 7, 10, 15, 12, 18, 13, 17, 4, 19, 21 and 20. S11 is the Task 1 wiring test, and S13 is Task 10 Steps 2, 7 and 10.

**2. Placeholder scan.** No TBD/TODO. Every code step carries full code. Live steps carry exact commands. The only angle-bracket tokens are user-supplied values in rendered help text and the guide (`<login>`, `<folder>`).

**3. Name consistency.**
- Helper names are identical across tasks: `resolveGeneratedEnv`, `stripGeneratedKeys`, `writePrivateFile`, `gatewayExcludedKeys`, `envPatternViolation`, `precreateDirs`, `pullTimeoutMs`, `postInstallPlan`, `hookEnv`, `spawnGroup`, `runPostInstall`, `composeProjectName`, `resolveComposeProject`, `classifyProjectOwners`, `composeOwnershipCheck`, `_setHookRunnerForTest`, `_setDockerRunnerForTest`.
- Env keys use the `WORKSPACE_*` names, including `WORKSPACE_FIRSTRUN_ADMIN_PASSWORD`.
- Projects and subnets: `crow-workspace`/10.89.70, `crow-ws-smoke`/10.89.71, `crow-ws-restore`/10.89.72.
- The archive is `crow-workspace-*.tar` with members `db.sql.gpg`, `files.tar.gpg` and `bundle.env.gpg`.
- The fake `docker compose` argv strings match what the scripts emit: `exec -T -u www-data nextcloud sh -c IFS= read -r NC_PASS; … sh user:add …`, `MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb-dump`, and `exec -T -u root nextcloud tar -C /var/www/html -cf - .`.

**4. Review Focus.** Six items, each pinned in its owning task (1 → Tasks 1 and 5; 2 → Task 2; 3 → Task 5; 4 → Task 6; 5 → Tasks 2, 4, 5 and 7, plus the Task 8 live sampler; 6 → Task 3).

**Still unverified at plan time** (each has a named step in the Task 8 smoke, and a FAIL blocks merge):
- whether Tailscale Serve sends forwarded headers, and whether ONLYOFFICE produces mixed content (Step 5);
- the `occ … enabled` output (4b);
- bind-mount ownership (4c);
- the MariaDB/Redis healthchecks, and Redis running as `redis` from its private config file (4a);
- gpg loopback (4i);
- compose without a file (4h, informational);
- `config:import /dev/stdin` (JWT length check, 4e);
- Nextcloud refusing a breached password, plus the pre-install HIBP gate (4g);
- the ownership guard against the live R4 browser, crow's 35b and crow's browser, plus a foreign-install refusal and a legacy-path pass on `searxng` (Step 7);
- link-share exclusion and the autocomplete restriction (4f);
- the `auth-tokens:add` output having no trailing notice (the 72-char regex in the bootstrap fails loudly otherwise).
