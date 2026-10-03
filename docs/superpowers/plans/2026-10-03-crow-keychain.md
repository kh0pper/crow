# Crow Keychain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship, in one PR:
- compose-exact `.env` quoting, so nearly any printable character survives every reader;
- Generate / Show / Copy and "Save to Crow keychain" on the password fields an extension opts in (`generatable` / `keychain`);
- a local-only Crow keychain encrypted with **its own key file**, never backed up, with a passphrase Export/Import;
- a re-auth-gated Settings → Passwords page;
- an optional copy into the user's own Vaultwarden via the Bitwarden CLI;
- a generic `generate` + `keychain` (+ `store_as: argon2id`) capability, adopted by Vaultwarden (pinned 1.37.3) and Workspace.

**Architecture:**
- One codec module owns every byte Crow writes to or reads from a bundle `.env`. It is line-preserving on update and tilde-safe.
- The installer gains a "generated and known" path: mint → keychain first → persist the hash.
- The keychain is one additive, never-synced SQLite table, sealed with `secret-box` under a random key in `<CROW_HOME>/secrets/keychain.key`. A small JSON API sits behind a per-session 5-minute re-auth gate.
- The UI changes the existing extensions modal (a template-literal client) and adds a Settings section.
- The vault save shells out to `@bitwarden/cli`, installed as a dependency of the vaultwarden bundle.

**Tech Stack:** Node 24 (`node:crypto` `argon2Sync`, `node:test`, express, better-sqlite3 via `servers/db.js`), linkedom + `node:vm` for client tests, Docker Compose v5.1.2, bash + python3 (Workspace ops), `@bitwarden/cli` 2026.9.1, `vaultwarden/server:1.37.3`.

**Spec:** `docs/superpowers/specs/2026-10-03-crow-keychain-design.md` (revision 2). It is binding: where this plan and the spec disagree, the spec wins. Spec §7 R1–R21 apply; this plan adds P1–P12.

**Review:** this is revision 3.
- Revision 2 answered `~/crow-weekend-push/reports/keychain-plan-review.md` (C1–C8, S1–S10) and Kevin's answers to Q1–Q6.
- Revision 3 answers `~/crow-weekend-push/reports/keychain-plan-rereview.md`: blocking B1–B3 and minor m1–m7.

The ruling table maps every item.

**How the code in this plan was produced:**
- Every code block was first applied, task by task and in this order, to a git-tracked scratch copy of the branch.
- Each task's tests were run after its step, and the full suite ran at the end: **6059 / 6059 passed**, `build-registry --check` OK, `check-port-allocation` OK.
- New files are given in full. Changes to existing files are given as `git apply` patches cut from that scratch history.
- So the patches apply in order to this branch (base `ec197558` plus the docs commits).

If a patch fails to apply because `main` moved, re-run `git pull --rebase` and apply with `git apply --3way`, then resolve the conflict by hand, keeping the patch's intent.

## Rulings added by this plan

- **P1 — The codec is proven, not assumed.** The bare / path-bare / single / double encoder was fuzzed on crow against compose `${VAR}` interpolation, `env_file:`, and bash `. ./.env`.
  - In revision 2, a third of the random values carry a leading `~` or a `:~` (review C2), and the explicit tilde set `~ ~+ ~- ~root ~/x a:~/y x=~ ~~ p~q` is pinned.
  - The Python decoder (`envfile.py`) and the JS decoder both match bash.
- **P2 — Readers switched.**
  - Gateway: `composeBuildContexts`, Configure, `bundles-config.parseEnvFile`, `extension-proxy.readBundleEnv`, `migrations.readCompanionEnv`.
  - Bundles: browser `instance.js`, companion `settings-section.js` (reader and line-preserving writer), workspace `panel/workspace.js`, the four `configure-storage.mjs` scripts, workspace `bootstrap.sh` / `restore-scratch.sh` (through `envfile.py`).
  - `port-inventory.js` (digits) and the gateway `.env` (`env-manager.js`, `index.js`) are untouched.
- **P3 — Client tests** live in new files, so `extensions-client-contract.test.js` is unchanged. Generator and field buttons use `btn-secondary`, never `btn-primary`: existing tests select `#modal-content .btn-primary` as Install.
- **P4 — API mount:** `router.use(keychainApiRouter())` directly after `router.use("/dashboard", csrfMiddleware);` in `servers/gateway/dashboard/index.js`.
- **P5 — The first-view banner is server-rendered** (`buildExtensionsHTML({ keychainPending })`), readable entries only.
- **P6 — The vault option needs `#ext-keychain-config[data-vault="1"]`,** rendered when `installed.vaultwarden` exists.
- **P7 — Keychain saves happen in `runInstallJob` before anything is persisted** (review C5): plan → keychain → `persist()` → `.env`, and the vault copy before any image pull.
- **P8 — Deploy targets:**
  - crow: `crow-gateway.service` + `crow-r4-gateway.service`;
  - grackle: `crow-gateway.service`;
  - raven's paired instance (raven:3009): unit confirmed with `systemctl list-units '*crow*'` at deploy;
  - **black-swan:** auto-update, verified after merge, no manual step;
  - **dayane's container instance:** pinned, deliberate rebuild only, so no deploy step (Kevin Q5). **But one operator step comes first** (re-review B3):
    - Its nightly `crow-dayane-backup.timer` (03:40) runs `~/crow-dayane/backup.sh`, which does `docker cp crow-dayane:/crow - | gzip` to the `[crow-external]` share.
    - dayane's `CROW_HOME=/crow`, so after its next rebuild that tar would carry `secrets/keychain.key`.
    - The kit lives in `~/crow-dayane` (Gitea `kh0pp/crow-dayane`), not in this repo, so the change is listed as an operator follow-up.
    - The exact change is in Task 14 Step 6 and spec §9.7. It must land before dayane is rebuilt onto this code.
- **P9 — Found while dry-running the plan:** the Extensions `#addon-registry` blob (Configure's form source) dropped `pattern` and would have dropped `generatable`/`keychain`. Task 9 adds them.
- **P10 — The keychain key is never created on read.** `GET /entries` and `/reveal` use `create:false`; only a save, an add or an import creates it. A corrupt key file is never overwritten.
- **P11 — The vault spike runs before the vault-save code (Task 6), with the fallback pre-decided** (spec R18).
- **P12 — Bundle version bumps in this PR,** and exactly what each bump refreshes on an existing install (re-review B1). A docker bundle's refresh copies only:
  - `manifest.json`, `settings-section.js`, and now `package.json` / `package-lock.json`;
  - `server/`, `panel/`, `skills/`;
  - manifest-declared roots: the `server` entry, the `panel` / `panelRoutes` files, the `postInstall` script directory, and the skills.

  It never copies `scripts/`, `config/`, `docker-compose.yml` or `.env*`.
  - **browser 1.3.3→1.3.4:** refreshes `server/instance.js` + the new `server/app-root.js`.
  - **companion 1.0.0→1.0.1:** refreshes `settings-section.js`.
  - **peertube / pixelfed / funkwhale / mastodon 1.0.0→1.0.1:** the changed files are in `scripts/`, so these bumps refresh nothing on existing installs; only fresh installs get the new `configure-storage.mjs` + `env-codec-fallback.mjs`. That is acceptable: the old script still works on installs whose S3 values are bare (every value Crow wrote before this PR), and the scripts are run by hand.
  - **workspace 0.1.1→0.1.2:** refreshes `panel/` and `ops/` (the postInstall root: `bootstrap.sh`, `lib.sh`, `reset-password.sh`, `restore-scratch.sh`, `envfile.py`).
  - **vaultwarden 1.0.0→1.1.0:** refreshes `manifest.json`, `package.json` + lock (then `npm ci`), `server/`, `panel/`, `skills/`. **It does not refresh `docker-compose.yml`**, so an existing install keeps its old image (1.32.7) until it is reinstalled. `vaultwardenStatus` reports that, and the vault option says "reinstall" (m4).
- **P13 — B1:** each storage script resolves the codec from `CROW_APP_ROOT`, then the in-repo path, inside try/catch, and otherwise imports `./env-codec-fallback.mjs` shipped beside it. A test runs each script from a tmpdir outside the repo with no `CROW_APP_ROOT`. Another test keeps the four fallback copies equivalent to the codec.
- **P14 — B2:** import accepts only the exact v1 KDF constants (m=65536, t=3, p=4), checks salt 16 / nonce 12 / tag 16 bytes and a 4 MiB ciphertext cap before any derivation, passes `authTagLength: 16`, and runs Argon2 with async `crypto.argon2` (libuv threadpool, off the event loop) for both export and import.
- **P15 — m1/m2:**
  - Key creation is crash-atomic: write a 600 temp file, fsync, `linkSync` to the final name (never overwrites; EEXIST takes theirs), unlink the temp, fsync the dir.
  - An empty or damaged key is replaced (moved aside, never deleted) only while `crow_keychain` is empty. Otherwise saves refuse with `KEYCHAIN_KEY_INVALID`, naming the file path.
  - A key created while rows exist is audited (`keychain_key_created`) and raises one notification: "N entries need Import".
- **P16 — m4 refresh:** for `npm_required` bundles, the boot refresh runs `npm ci --omit=dev --ignore-scripts` when a lock exists, the same as the install path. On failure it leaves the installed manifest at the old version, so the next boot retries. It stays warn-only. Other bundles are unchanged (`npm install --omit=dev`).
- **P17 — m3/m5/m6 (documentation):**
  - container deployments must keep `CROW_HOME` on a volume (spec §6);
  - the codec's decode comment no longer claims `${VAR}` interpolation;
  - Configure resubmits default-prefilled fields, so those keys are rewritten every save. That is pre-existing; only untouched blank fields' lines are preserved byte-for-byte (spec §5.1).
  - browser 1.3.3→1.3.4
  - companion 1.0.0→1.0.1
  - peertube / pixelfed / funkwhale / mastodon 1.0.0→1.0.1
  - workspace 0.1.1→0.1.2
  - vaultwarden 1.0.0→1.1.0

### Review item → ruling map

| item | ruling | where |
|---|---|---|
| C1 Generate on 80+ third-party fields | `generatable: true` opt-in (requires `secret`, no `generate`, `propagate:false`); Show/Copy stay on all typed secrets | Tasks 3, 9, 11; spec R16 |
| C2 bare `~` bash-expanded | `~` removed from bare; `~/…` bare only in path fields (`path:true` or `~/` default); generator has no `~` | Task 1; spec §5.1 |
| C3 generated `#` + missed readers | generator emits only codec-bare symbols; every raw reader moved to the codec | Tasks 1, 2, 9 |
| C4 Configure re-encodes legacy lines | `updateEnvText` line-preserving for Configure and install seeding | Task 1; spec R19 |
| C5 lost Argon2 token | `planGeneratedEnv` + keychain-first + `persist()`; abort with nothing written; `resolveGeneratedEnv` refuses keychain manifests; delete of an active generated token needs `confirm_generated` | Tasks 3, 5, 8, 10 |
| C6 docker refresh never installs new deps | refresh copies `package.json` + lock for docker bundles | Task 7; spec R20 |
| C7 backups vs local-only | **Kevin:** own key file `<CROW_HOME>/secrets/keychain.key`, never backed up; Export/Import; unreadable-key UX; D3 importer skips the table | Tasks 4, 5, 10 |
| C8 CLI vs Vaultwarden too late | pin 1.37.3 (release notes: 1.37.0 required for 2026.7.0+ clients); live spike before Task 7; fallback pre-decided | Tasks 6, 11; spec R18 |
| S1 per-session lockout only | + 20 failures/hour instance-wide ceiling, audit + one notification | Task 5 |
| S2 plaintext lingers | revealed / first-view cells wiped after 30 s and on `pagehide`; Passwords HTML `no-store` | Tasks 9, 10 |
| S3 crash residue | bw temp under `<CROW_HOME>/tmp` (700), stale-dir sweep, `prlimit --core=0` | Task 7 |
| S4 deadlines / Configure reporting | 90 s overall vault deadline; Configure shows keychain/vault messages | Tasks 7, 9 |
| S5 CLI in the MCP package / unaudited | `npm_required` + `verify_paths` (lock-file `npm ci`, hard-fail); CI blocking audit of `bundles/vaultwarden`. Separate `cli/` package **not** adopted (spec R21) | Tasks 11, 12 |
| S6 plaintext copies in the gateway `.env` | `generatable` requires `propagate:false`; spec §6 lists the copies | Task 3; spec §6 |
| S7 threat model | stated in spec §6 | spec |
| S8 CHECK constraints | dropped; validated in `store.js` | Task 4 |
| S9 smoke hygiene | `unset CROW_DB_PATH` and other `CROW_*`; sampler only matches `bw.js`; bw installed with the installer's own `npm ci` flags; `http://localhost` URL. Serve 8461 kept for the [KEVIN] registration (it is the verified path; an `ssh -L` alternative is noted) | Task 13 |
| S10 reset-password length, ambiguous grep | UTF-16 length via python on stdin; unambiguous PASS/FAIL checks | Tasks 11, 13 |
| Q5 dayane / black-swan | P8 | Task 14 |
| B1 storage scripts crash when installed | P13 + P12 precision | Task 2; spec §5.1 |
| B2 crafted import wedges the event loop | P14 | Task 4 |
| B3 dayane backup carries the key | P8 operator step, exact `backup.sh` change | Task 14; spec §3, §9.7 |
| m1 non-atomic key creation | P15 | Task 4 |
| m2 silent re-keying | P15 (`onNewKey` audit + notification) | Tasks 4, 5, 8 |
| m3 Docker deployment loses the key | documented: `CROW_HOME` on a volume | spec §6 |
| m4 refresh npm / old VW image / legacy token | P16; `serverOutdated`; skill note | Tasks 7, 11 |
| m5 decoder comment overclaims | reworded | Task 1 |
| m6 Configure resubmits defaults | documented (pre-existing) | spec §5.1 |
| m7 spike edge cases | if no CLI passes → ship without the vault option (decided below); `tailscale set --operator` noted as Kevin's option | Task 6 |
| Q6 no password and no TOTP | `method()==="none"` → 403 `reauth_unavailable`; the page disables and explains | Tasks 5, 10 |

## Global Constraints

- **Codec refusals:** only CR/LF/NUL and a backtick with `'` or a trailing `\`. Bare-safe values are byte-identical to before. Every update of an existing `.env` is line-preserving.
- **Generated passwords** use only `a-z A-Z 2-9 ! % * + , - . / : = ? @ ^ _`.
- **Keychain table:** `crow_keychain`, additive, **no `SCHEMA_GENERATION` bump**, in `LOCAL_ONLY_TABLES`, never in `SYNCED_TABLES`.
- **Keychain key:** `<CROW_HOME>/secrets/keychain.key` (600, dir 700).
  - Created crash-atomically (temp, fsync, link) and only on save/add/import.
  - Never overwritten; a damaged one is replaced only while the table is empty.
  - Referenced by no backup / export / sync code in this repo.
- **Export import accepts only the v1 KDF constants;** Argon2 runs async.
- **Re-auth:**
  - TOTP when `is2faEnabled()`; else the dashboard password; else `none`, which disables everything that needs it.
  - The grant lasts 5 minutes, per session.
  - 5 failures → 15-minute lock; 20 failures/hour → instance-wide lock.
- **Audit:** every reveal/copy/delete/first-view/vault-save/add/save/export/import writes `audit_log` via `auditLog(db, "keychain_*", …)`. Details hold ids/labels/keys/counts, never values.
- **Plaintext never appears in:** job logs, audit details, error messages, URLs, argv (except the vault email, R11), or `console.*`.
- **Argon2id PHC:** `$argon2id$v=19$m=65540,t=3,p=4$<salt>$<hash>`. Export KDF: argon2id m=65536, t=3, p=4.
- **Vaultwarden:** `@bitwarden/cli` exactly `2026.9.1` in `bundles/vaultwarden/package.json` (never root). Image `vaultwarden/server:1.37.3`, unless Task 6 rules otherwise.
- **Version bumps** as in P12, then `node scripts/build-registry.mjs` and `--check`.
- **i18n:** every new key has en + es, es ≠ en (`tests/i18n-global-parity.test.js`).
- **Template-literal clients** (`extensions/client.js`, `sections/passwords.js`): no backticks, no stray `${`, no backslashes in literal client code.
- **Repo rules (`CLAUDE.md`):**
  - positional-path commits (`git add <new files>`, then `git commit <paths> -m …`, then `git show --stat HEAD`);
  - `git pull --rebase` before a push;
  - `npm test -- tests/<file>.test.js`, never raw `node --test`;
  - never `git checkout` in `~/crow`;
  - check-runs all `completed/success` before merge;
  - no AI attribution.
- **Live windows:** registered in `~/CROW-SCHEDULE.md` first, with an out-of-process deadman (`systemd-run --user --on-active`), and cleared after.
- **PRs:** go through the GitHub MCP tools (`kh0pp/crow`); `gh` is not installed on crow.

## Review Focus

1. **A typed password with `$ ' " \ # ~`, a space, or unicode, and legacy `.env` lines.**
   - Compose, bash `. .env`, Crow's readers and the Workspace ops scripts must all see exactly the typed bytes.
   - An untouched legacy line must survive a Configure save byte-for-byte.
   - *Pinned:*
     - Task 1: `REVIEW FOCUS 1` (compose + bash, tildes included) and `C4 — a Configure save never rewrites (or 500s on) untouched legacy lines`;
     - Task 11: `REVIEW FOCUS 1 (ops)`.
2. **The gateway restarts or the page reloads between install and the first look at a generated token.** It must be showable exactly once; after that it needs re-auth.
   - *Pinned:* Task 4 `REVIEW FOCUS 2`; Task 5 `REVIEW FOCUS 2 (API)`.
3. **Keychain rows or the key reaching another machine** through sync, the grackle D3 importer, or any backup path.
   - *Pinned:* Task 4 `REVIEW FOCUS 3` and `C7 — no backup path can carry the key`.
4. **A stale grant, another session's grant, guessed codes across fresh SSO sessions, or an instance with no re-auth method.** None may reveal anything.
   - *Pinned:* Task 5 `REVIEW FOCUS 4` (incl. the instance-wide ceiling) and `Q6`.
5. **The vault save failing:** wrong password, vault down, CLI missing, two-step, hang. The install must still succeed and the failure must be reported in words. The master password must never appear in argv, logs, the job, or a leftover temp dir.
   - *Pinned:* Task 7 `REVIEW FOCUS 5`; Task 8 `REVIEW FOCUS 5 (install)`.

---

## File Structure

| Path | Status | Task | Responsibility |
|---|---|---|---|
| `servers/gateway/bundle-env-codec.js` | Create | 1 | Encode/decode/parse/format/line-preserving update, path keys |
| `servers/gateway/bundle-env-secrets.js` | Modify | 1, 3 | Codec re-export; `planGeneratedEnv`, `keychainEligibleKeys`, templates |
| `servers/gateway/routes/bundles.js` | Modify | 1, 7, 8 | Codec writes/reads; refresh copies package files; keychain wiring |
| `servers/gateway/bundles-config.js`, `servers/gateway/routes/extension-proxy.js`, `servers/gateway/migrations.js` | Modify | 1, 2 | Codec readers |
| `bundles/browser/server/{app-root.js,instance.js}` | Create/Modify | 2 | Codec reader via `CROW_APP_ROOT` |
| `bundles/companion/settings-section.js` | Modify | 2 | Codec reader + line-preserving writer |
| `bundles/workspace/{panel/workspace.js,ops/envfile.py,ops/restore-scratch.sh}` | Modify/Create | 2 | Codec reader; no-eval shell reader |
| `bundles/{peertube,pixelfed,funkwhale,mastodon}/scripts/configure-storage.mjs` | Modify | 2 | Codec reader + encoded writes |
| `servers/gateway/keychain/argon2-phc.js` | Create | 3 | Argon2id PHC |
| `registry/manifest.schema.json`, `scripts/lib/bundle-contract.mjs` | Modify | 3 | `generatable`, `keychain`, `store_as`, `path`, `keychain_*` |
| `servers/gateway/keychain/{key,schema,store,export}.js` | Create | 4 | Own key file; table; sealed CRUD; Export/Import |
| `scripts/init-db.js`, `servers/sharing/instance-sync.js`, `scripts/ops/grackle-d3-import.mjs` | Modify | 4 | Table; local-only guard; D3 skip |
| `servers/gateway/keychain/{reauth,api}.js` | Create | 5 | Re-auth gate; JSON API |
| `servers/gateway/dashboard/index.js` | Modify | 5 | Mount |
| `servers/gateway/keychain/vault-save.js` | Create (5) / Replace (7) | 5, 7 | Bitwarden-CLI save |
| `servers/gateway/keychain/install-hooks.js` | Create | 8 | Installer side |
| `servers/gateway/dashboard/shared/password-generator.js` | Create | 9 | Generator |
| `servers/gateway/dashboard/panels/{extensions.js,extensions/html.js,extensions/client.js}` | Modify | 9 | Modal, banner, registry blob |
| `servers/gateway/dashboard/settings/sections/passwords.js`, `servers/gateway/dashboard/panels/settings.js` | Create/Modify | 10 | Settings → Passwords |
| `servers/gateway/dashboard/shared/i18n.js` | Modify | 9, 10 | `keychain.*`, `passwords.*` |
| `bundles/vaultwarden/*`, `bundles/workspace/{manifest.json,ops/*.sh}` | Modify | 11 | Adopters |
| `.github/workflows/test.yml` | Modify | 12 | Blocking audit of `bundles/vaultwarden` |
| `registry/add-ons.json` | Regenerate | 2, 11 | — |
| Tests: `bundle-env-codec`, `bundle-env-readers`, `bundle-env-keychain-generate`, `keychain-store`, `keychain-api`, `keychain-vault-save`, `keychain-install-wiring`, `extensions-keychain-client`, `settings-passwords-section`, `vaultwarden-bundle` (create); `bundle-version-refresh`, `workspace-bundle`, `workspace-bootstrap` (modify) | | 1–11 | |

**CI tasks:** 1–5, 7–12. **Attended LIVE:** 6 (spike, one [KEVIN] step), 13 (pre-merge smoke, [KEVIN] steps), 14 (PR, merge after Kevin's OK, deploy, acceptance).

---

### Task 0: Worktree and dependencies (setup, no commit)

- [ ] **Step 1: Confirm the worktree and install deps**

```bash
cd ~/crow-wt-keychain
git branch --show-current            # feat/crow-keychain
git pull --rebase origin main
npm ci
node --version                       # v24.x
docker compose version               # Docker Compose version v5.1.2
node -e 'console.log(typeof require("node:crypto").argon2Sync)'   # function
command -v prlimit                   # /usr/bin/prlimit (used by Task 7; absent is tolerated)
```

- [ ] **Step 2: Baseline suite** (so a later red is known to be ours)

```bash
npm test 2>&1 | tail -6              # record pass/fail counts in the task notes
```

---

### Task 1: Compose-exact `.env` codec; line-preserving updates; gateway readers/writers

**Files:**
- Create: `servers/gateway/bundle-env-codec.js`, `tests/bundle-env-codec.test.js`
- Modify:
  - `servers/gateway/bundle-env-secrets.js` (drop the local `parseEnvText`, re-export the codec's; retained copy via `formatEnvLines`);
  - `servers/gateway/routes/bundles.js`:
    - imports;
    - `composeBuildContexts` env read;
    - `appendManagedBlock`;
    - `findInvalidEnv`;
    - `writeInstallEnv` (new `{ baseText }` option);
    - `runInstallJob` seeding (line-preserving);
    - the Configure route (line-preserving);
  - `servers/gateway/bundles-config.js` (`parseEnvFile`);
  - `servers/gateway/routes/extension-proxy.js` (`readBundleEnv`).

**Interfaces:**
- Produces:
  - `envValueProblem(value): string|null`
  - `encodeEnvValue(value, { path?: boolean }): string` (throws on a problem)
  - `decodeEnvValue(raw): string`
  - `parseEnvText(text): Record<string,string>`
  - `pathEnvKeys(manifest): Set<string>`
  - `formatEnvLines(vars, { pathKeys? }): string`
  - `updateEnvText(text, updates, { pathKeys?, remove?: string[] }): string`
  - `writeInstallEnv(destDir, envVars, manifest, log?, { baseText? })`
- `bundle-env-secrets.js` keeps exporting `parseEnvText` (now the codec's).

- [ ] **Step 1: Write the failing test** — create `tests/bundle-env-codec.test.js`:

````js
/**
 * Compose-exact bundle .env codec (Crow keychain, Task 1).
 * The docker test runs real `docker compose config` and is skipped when compose is absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import express from "express";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-codec-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-codec-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const C = await import("../servers/gateway/bundle-env-codec.js");
const S = await import("../servers/gateway/bundle-env-secrets.js");
const B = await import("../servers/gateway/routes/bundles.js");

const BT = "\u0060";
const TILDES = ["~", "~+", "~-", "~root", "~/x", "a:~/y", "x=~", "~~", "p~q"];
const WIDE = [
  "", "plain", "Correct-Horse-1", "a=b", "p a$s'w\"d#1", "$argon2id$v=19$m=65540,t=3,p=4$abc$def",
  "it's $HOME", "a\\'b", "x\\", "\\", "  lead", "trail  ", "#hash", "a #b", "${A}", "$(id)",
  "back" + BT + "tick", "tab\there", "é😀ü", "{}~!@%^&*()[]|;:,.<>?/", ...TILDES,
];

function randomPrintable() {
  const pool = [];
  for (let c = 0x20; c < 0x7f; c++) pool.push(String.fromCharCode(c));
  pool.push("é", "😀", "\t");
  let s = "";
  const n = randomInt(1, 30);
  for (let i = 0; i < n; i++) s += pool[randomInt(pool.length)];
  // A third of the values get a tilde in a position bash would expand (C2).
  const r = randomInt(3);
  if (r === 0) s = "~" + s;
  else if (r === 1) s = s + ":~" + s;
  return s;
}

test("bare-safe values are written byte-identically to before (no churn of existing .env files)", () => {
  for (const v of ["", "abc", "Correct-Horse-1", "http://localhost:8097", "a=b", "x.y/z:1@2%3+4,5^7!8?9*0-_"]) {
    assert.equal(C.encodeEnvValue(v), v);
  }
});

test("single quotes when possible, double quotes with \\ \" $ escapes otherwise", () => {
  assert.equal(C.encodeEnvValue("p a$s#1"), "'p a$s#1'");
  assert.equal(C.encodeEnvValue("$argon2id$v=19$m=1$a$b"), "'$argon2id$v=19$m=1$a$b'");
  assert.equal(C.encodeEnvValue("it's $HOME"), "\"it's \\$HOME\"");
  assert.equal(C.encodeEnvValue("x\\"), "\"x\\\\\"");
  assert.equal(C.encodeEnvValue("say \"hi\" it's"), "\"say \\\"hi\\\" it's\"");
});

test("C2 — every tilde form is quoted, except a `~/…` value in a declared path field", () => {
  for (const v of TILDES) assert.equal(C.encodeEnvValue(v), `'${v}'`, v);
  assert.equal(C.encodeEnvValue("~/x", { path: true }), "~/x", "path fields keep bash's $HOME expansion");
  assert.equal(C.encodeEnvValue("~root/x", { path: true }), "'~root/x'", "only the ~/ shape stays bare");
  assert.equal(C.encodeEnvValue("~/a b", { path: true }), "'~/a b'");
  const keys = C.pathEnvKeys({ env_vars: [{ name: "DATA", default: "~/.crow/x" }, { name: "P2", path: true }, { name: "PW", secret: true }] });
  assert.deepEqual([...keys].sort(), ["DATA", "P2"]);
});

test("refusals: CR, LF, NUL, and a backtick that would need double quotes", () => {
  assert.match(C.envValueProblem("a\nb"), /line break or NUL/);
  assert.match(C.envValueProblem("a\rb"), /line break or NUL/);
  assert.match(C.envValueProblem("a\0b"), /line break or NUL/);
  assert.match(C.envValueProblem("it's" + BT), /backtick/);
  assert.match(C.envValueProblem(BT + "x\\"), /backtick/);
  assert.equal(C.envValueProblem("only" + BT + "tick"), null, "a backtick alone single-quotes fine");
  assert.throws(() => C.encodeEnvValue("a\nb"), /line break/);
});

test("decode(encode(v)) === v for the wide set and 500 random printable values", () => {
  const vals = [...WIDE, ...Array.from({ length: 500 }, randomPrintable)].filter((v) => !C.envValueProblem(v));
  for (const v of vals) assert.equal(C.decodeEnvValue(C.encodeEnvValue(v)), v, JSON.stringify(v));
});

test("parseEnvText: export prefix, comments, CRLF, trailing #comment on bare, last occurrence wins", () => {
  const env = C.parseEnvText("# c\nexport A=1\r\nB=x #note\nC='q #not a comment'\nB=two\n\nD=\"a\\zb\"\n");
  assert.deepEqual(env, { A: "1", B: "two", C: "q #not a comment", D: "a\\zb" });
});

test("formatEnvLines skips undefined/null, keeps empty as KEY=, newline-terminated", () => {
  assert.equal(C.formatEnvLines({ A: "x", B: undefined, C: null, D: "" }), "A=x\nD=\n");
  assert.equal(C.formatEnvLines({}), "");
  assert.equal(C.formatEnvLines({ P: "~/d", Q: "~/d" }, { pathKeys: new Set(["P"]) }), "P=~/d\nQ='~/d'\n");
});

const LEGACY = [
  "# operator comment — keep me",
  "P=p$ss",
  "Q=\"a\\nb\"",
  "R=it's" + BT + "x",
  "DATA=~/.crow/data",
  "KEEP=1",
  "",
].join("\n");

test("C4 — updateEnvText is line-preserving: untouched legacy lines stay byte-for-byte", () => {
  const out = C.updateEnvText(LEGACY, { KEEP: "2", NEW: "a b" }, { remove: [] });
  assert.equal(out, LEGACY.replace("KEEP=1", "KEEP=2") + "NEW='a b'\n");
  assert.equal(C.updateEnvText("A=1\nA=2\n", { A: "3" }), "A=1\nA=3\n", "the LAST occurrence (compose's) is updated");
  assert.equal(C.updateEnvText("A=1\nB=2\n", {}, { remove: ["A"] }), "B=2\n");
  assert.equal(C.updateEnvText("", { A: "" }), "A=\n");
});

test("bundle-env-secrets re-exports the codec's parseEnvText", () => {
  assert.equal(S.parseEnvText, C.parseEnvText);
});

test("findInvalidEnv refuses with the codec's reason and names only the key", () => {
  assert.deepEqual(B.findInvalidEnv({ OK: "p a$s'w\"d" }), null);
  const bad = B.findInvalidEnv({ PW: "it's" + BT + "x" });
  assert.equal(bad.key, "PW");
  assert.match(bad.why, /backtick/);
  assert.ok(!JSON.stringify(bad).includes("it's"), "the value is never echoed");
});

test("writeInstallEnv writes encoded lines that parse back to the exact values", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-codec-dest-"));
  const vals = Object.fromEntries(WIDE.filter((v) => v !== "" && !C.envValueProblem(v)).map((v, i) => [`K${i}`, v]));
  B.writeInstallEnv(dir, vals, { env_vars: [] });
  assert.deepEqual(C.parseEnvText(readFileSync(join(dir, ".env"), "utf8")), vals);
});

test("C4 — writeInstallEnv with a base text keeps the base's lines and only sets the given keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-codec-base-"));
  B.writeInstallEnv(dir, { NEW: "x y", KEEP: "9" }, { env_vars: [{ name: "DATA", default: "~/.crow/data" }] }, () => {}, { baseText: LEGACY });
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), LEGACY.replace("KEEP=1", "KEEP=9") + "NEW='x y'\n");
});

test("C4 — a Configure save never rewrites (or 500s on) untouched legacy lines", async () => {
  const id = "codec-legacy";
  const dir = join(process.env.CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, name: id, type: "bundle", version: "0.1.0", env_vars: [{ name: "KEEP" }, { name: "PW", secret: true }] }));
  writeFileSync(join(dir, ".env"), LEGACY);
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/bundles/api/env`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle_id: id, env_vars: { PW: "new pass $1" } }),
    });
    assert.equal(r.status, 200, await r.text());
  } finally { server.close(); }
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), LEGACY + "PW='new pass $1'\n");
});

const hasCompose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;

test("REVIEW FOCUS 1 — compose sees the exact value (real docker compose config)", { skip: !hasCompose && "docker compose not available" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-codec-compose-"));
  const vals = [...WIDE, ...Array.from({ length: 150 }, randomPrintable)].filter((v) => !C.envValueProblem(v));
  const vars = Object.fromEntries(vals.map((v, i) => [`K${i}`, v]));
  writeFileSync(join(dir, ".env"), C.formatEnvLines(vars));
  writeFileSync(join(dir, "docker-compose.yml"),
    "services:\n  t:\n    image: busybox\n    env_file: .env\n    environment:\n"
    + Object.keys(vars).map((k) => `      ${k}x: \${${k}}\n`).join(""));
  const r = spawnSync("docker", ["compose", "config", "--format", "json"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const env = JSON.parse(r.stdout).services.t.environment;
  // `config` re-escapes a literal $ as $$ in its output; undo that one transformation.
  const seen = (s) => (s === undefined ? "<unset>" : String(s).replace(/\$\$/g, "$"));
  for (const [k, v] of Object.entries(vars)) {
    assert.equal(seen(env[k]), v, `env_file ${k} ${JSON.stringify(v)}`);
    assert.equal(seen(env[`${k}x`]), v, `interpolated ${k} ${JSON.stringify(v)}`);
  }
});

test("REVIEW FOCUS 1 (bash) — `set -a; . ./.env` sees the exact value, tildes included", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-codec-bash-"));
  const vals = [...WIDE, ...Array.from({ length: 150 }, randomPrintable)].filter((v) => !C.envValueProblem(v));
  const vars = Object.fromEntries(vals.map((v, i) => [`K${i}`, v]));
  writeFileSync(join(dir, ".env"), C.formatEnvLines(vars));
  const r = spawnSync("bash", ["-c", "set -a; . ./.env; set +a; node -e 'const o={};for(const[k,v]of Object.entries(process.env))if(/^K[0-9]+$/.test(k))o[k]=v;process.stdout.write(JSON.stringify(o))'"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), vars);
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/bundle-env-codec.test.js`
Expected: FAIL with `Cannot find module '…/servers/gateway/bundle-env-codec.js'`.

- [ ] **Step 3: Create `servers/gateway/bundle-env-codec.js`**

````js
/**
 * Compose-exact bundle .env codec.
 *
 * Crow writes every bundle .env value through encodeEnvValue and reads it back through
 * parseEnvText, so a value survives `docker compose` (both `${VAR}` interpolation and
 * `env_file:`), POSIX `set -a; . ./.env` (the hand-run post-install scripts) and Crow's
 * own readers byte-for-byte. Verified against Docker Compose v5.1.2 on crow (2026-10-03)
 * and pinned by tests/bundle-env-codec.test.js (real compose + real bash).
 *
 *   bare      A-Z a-z 0-9 _ . / : @ % + , = ^ ! ? * -   (no `~`: bash expands it)
 *   'single'  anything else without ' and not ending in \  (literal: no $ or ~ expansion)
 *   "double"  the rest, with \ " $ backslash-escaped
 *
 * PATH fields (pathEnvKeys: manifest `path: true`, or a `default` starting with `~/`) keep
 * a `~/…` value bare, because the post-install scripts that source .env rely on bash
 * expanding it to $HOME (frigate, motioneye). Every other tilde form is quoted.
 *
 * Refused (envValueProblem): CR, LF, NUL (one value per line), and a backtick in a value
 * that needs double quotes (it contains ' or ends in \), because `. ./.env` would execute
 * it there. NOT used for the gateway's own .env (literal loader, not a compose file).
 */
const BARE_SAFE = /^[A-Za-z0-9_./:@%+,=^!?*-]*$/;
const PATH_BARE = /^~\/[A-Za-z0-9_./:@%+,=^!?*-]*$/;
const BACKTICK = "`";
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const DQ_ESCAPES = { "\\": "\\", '"': '"', $: "$", n: "\n", t: "\t", r: "\r" };

/** Why `value` cannot be written to a bundle .env, or null. Never includes the value. */
export function envValueProblem(value) {
  const s = String(value);
  if (/[\r\n\0]/.test(s)) return "contains a line break or NUL character";
  if (s.includes(BACKTICK) && (s.includes("'") || s.endsWith("\\"))) {
    return "cannot contain a backtick together with a single quote or a trailing backslash";
  }
  return null;
}

export function encodeEnvValue(value, { path = false } = {}) {
  const s = String(value);
  const problem = envValueProblem(s);
  if (problem) throw new Error(`env value ${problem}`);
  if (BARE_SAFE.test(s)) return s;
  if (path && PATH_BARE.test(s)) return s;
  if (!s.includes("'") && !s.endsWith("\\")) return `'${s}'`;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;
}

/**
 * The literal value for the text after `KEY=`, decoded the way compose's dotenv parser
 * decodes quoting and escapes. It does NOT perform compose's own `${VAR}` interpolation of
 * unquoted or double-quoted LEGACY values (no Crow writer emits such a value unescaped, and
 * the old raw readers did not interpolate either) — re-review m5.
 */
export function decodeEnvValue(raw) {
  const s = String(raw).trimStart();
  if (s.startsWith("'")) {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "\\" && s[i + 1] === "'") { out += "'"; i++; continue; }
      if (s[i] === "'") return out;
      out += s[i];
    }
    return s; // unterminated: compose refuses the whole file; keep the raw text
  }
  if (s.startsWith('"')) {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "\\" && i + 1 < s.length) {
        const n = s[i + 1];
        if (Object.hasOwn(DQ_ESCAPES, n)) { out += DQ_ESCAPES[n]; i++; continue; }
        out += "\\";
        continue;
      }
      if (s[i] === '"') return out;
      out += s[i];
    }
    return s;
  }
  return s.split(/\s+#/, 1)[0].trim();
}

/** KEY → decoded value. Last occurrence wins; comments, blank lines and CRs are skipped. */
export function parseEnvText(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const m = line.replace(/\r$/, "").match(LINE);
    if (m) out[m[1]] = decodeEnvValue(m[2]);
  }
  return out;
}

/** Keys whose values are filesystem paths (bare `~/…` allowed). */
export function pathEnvKeys(manifest) {
  const out = new Set();
  for (const v of manifest?.env_vars || []) {
    if (!v || typeof v.name !== "string") continue;
    if (v.path === true || (typeof v.default === "string" && v.default.startsWith("~/"))) out.add(v.name);
  }
  return out;
}

const lineFor = (k, v, pathKeys) => `${k}=${encodeEnvValue(v, { path: !!pathKeys?.has?.(k) })}`;

/** One `KEY=<encoded>` line per entry (undefined/null skipped), newline-terminated. */
export function formatEnvLines(vars, { pathKeys = null } = {}) {
  const lines = [];
  for (const [k, v] of Object.entries(vars || {})) {
    if (v === undefined || v === null) continue;
    lines.push(lineFor(k, v, pathKeys));
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

/**
 * LINE-PRESERVING update of an existing .env text. Only the keys in `updates` (written
 * encoded) and `remove` (dropped) are touched; every other line — comments, legacy
 * unquoted values compose already interpolated, hand edits — stays byte-for-byte.
 * An updated key replaces its LAST occurrence (the one compose uses) in place; a new
 * key is appended. undefined/null updates are ignored; "" writes `KEY=`.
 */
export function updateEnvText(text, updates = {}, { pathKeys = null, remove = [] } = {}) {
  const src = String(text || "");
  const lines = src === "" ? [] : src.replace(/\n$/, "").split("\n");
  const drop = new Set(remove);
  const lastIdx = new Map();
  lines.forEach((line, i) => {
    const m = line.replace(/\r$/, "").match(LINE);
    if (m) lastIdx.set(m[1], i);
  });
  const out = [];
  lines.forEach((line, i) => {
    const m = line.replace(/\r$/, "").match(LINE);
    if (m && drop.has(m[1])) return;
    if (m && Object.hasOwn(updates, m[1]) && updates[m[1]] !== undefined && updates[m[1]] !== null) {
      if (lastIdx.get(m[1]) === i) out.push(lineFor(m[1], updates[m[1]], pathKeys));
      else out.push(line);
      return;
    }
    out.push(line);
  });
  for (const [k, v] of Object.entries(updates || {})) {
    if (v === undefined || v === null || drop.has(k) || lastIdx.has(k)) continue;
    out.push(lineFor(k, v, pathKeys));
  }
  return out.length ? out.join("\n") + "\n" : "";
}
````

- [ ] **Step 4: Switch the gateway writers and readers** (the patch removes the now-unused `readEnvFile` import from `bundles.js`)

````bash
cd ~/crow-wt-keychain && git apply <<'PATCH'
diff --git a/servers/gateway/bundle-env-secrets.js b/servers/gateway/bundle-env-secrets.js
index f0fb02f..48f89f5 100644
--- a/servers/gateway/bundle-env-secrets.js
+++ b/servers/gateway/bundle-env-secrets.js
@@ -13,17 +13,11 @@
 import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, rmSync } from "node:fs";
 import { join, dirname, basename } from "node:path";
 import { randomBytes, createHash } from "node:crypto";
+import { parseEnvText, formatEnvLines } from "./bundle-env-codec.js";
+export { parseEnvText };
 
 const GENERATE_KINDS = new Set(["secret"]);
 
-export function parseEnvText(text) {
-  const out = {};
-  for (const line of String(text || "").split("\n")) {
-    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
-    if (m) out[m[1]] = m[2];
-  }
-  return out;
-}
 
 function readEnvSafe(path) {
   try { return existsSync(path) ? parseEnvText(readFileSync(path, "utf8")) : {}; } catch { return {}; }
@@ -78,7 +72,7 @@ export function resolveGeneratedEnv(bundleId, manifest, { destDir, crowHome }) {
     retainedPath,
     `# Crow-generated secrets for bundle '${bundleId}'. Kept across uninstall so a\n` +
       `# reinstall reuses them (the bundle's data still expects them). Do not edit.\n` +
-      Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
+      formatEnvLines(merged),
   );
   return out;
 }
diff --git a/servers/gateway/bundles-config.js b/servers/gateway/bundles-config.js
index 5c481a6..66d1da5 100644
--- a/servers/gateway/bundles-config.js
+++ b/servers/gateway/bundles-config.js
@@ -12,6 +12,7 @@
  * Imports node builtins ONLY — no circular-import risk with routes/bundles.js.
  */
 
+import { parseEnvText } from "./bundle-env-codec.js";
 import { existsSync, readFileSync } from "node:fs";
 import { join, resolve, dirname } from "node:path";
 import { homedir } from "node:os";
@@ -79,14 +80,7 @@ export function getInstalledFirstManifest(bundleId) {
 
 /** Parse a KEY=value .env file into a plain object (same grammar as the installer writes). */
 function parseEnvFile(path) {
-  const env = {};
-  try {
-    for (const line of readFileSync(path, "utf8").split("\n")) {
-      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
-      if (m) env[m[1]] = m[2];
-    }
-  } catch { /* unreadable → treat as empty */ }
-  return env;
+  try { return parseEnvText(readFileSync(path, "utf8")); } catch { return {}; }
 }
 
 /** The bundle's ~/.crow/mcp-addons.json entry, or null if it registers no MCP server. */
diff --git a/servers/gateway/routes/bundles.js b/servers/gateway/routes/bundles.js
index 2a35325..96cfb4d 100644
--- a/servers/gateway/routes/bundles.js
+++ b/servers/gateway/routes/bundles.js
@@ -52,7 +52,7 @@ import {
   _setAppBundlesForTest,
 } from "../bundles-config.js";
 import { isModelOrchestrationDisabled, isModelBundleManifest } from "../../shared/model-orchestration.js";
-import { readEnvFile } from "../env-manager.js";
+import { envValueProblem, encodeEnvValue, formatEnvLines, updateEnvText, pathEnvKeys } from "../bundle-env-codec.js";
 import { precreateDirs, runPostInstall, hookEnv, spawnGroup, pullTimeoutMs, resolveComposeProject, classifyProjectOwners } from "../bundle-lifecycle.js";
 import { resolveGeneratedEnv, stripGeneratedKeys, parseEnvText, writePrivateFile, gatewayExcludedKeys, envPatternViolation, breachedValueViolation } from "../bundle-env-secrets.js";
 
@@ -572,7 +572,7 @@ function composeBuildContexts(appSrc, { manifest = null, destDir = appSrc, env =
   const expandEnv = env || (() => {
     const fileVars = {};
     try {
-      for (const [k, { value }] of readEnvFile(join(destDir, ".env")).vars) fileVars[k] = value;
+      Object.assign(fileVars, parseEnvText(readFileSync(join(destDir, ".env"), "utf8")));
     } catch { /* no .env → process env only */ }
     // compose: shell env wins over .env; composeEnv() adds the CROW_HOME every
     // compose run gets (the prod gateway unit may not export it).
@@ -1140,7 +1140,7 @@ function appendManagedBlock(envPath, blockName, kvPairs, version) {
   const end = `# crow-${blockName} END`;
   const lines = [begin];
   if (version) lines.push(`# crow-${blockName}-version: ${version}`);
-  for (const [k, v] of Object.entries(kvPairs)) lines.push(`${k}=${v}`);
+  for (const [k, v] of Object.entries(kvPairs)) lines.push(`${k}=${encodeEnvValue(v)}`);
   lines.push(end, "");
   const block = lines.join("\n");
 
@@ -1684,7 +1684,10 @@ export function findInvalidEnv(envVars) {
   if (!envVars || typeof envVars !== "object") return null;
   for (const [k, v] of Object.entries(envVars)) {
     if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) return { key: k, why: "is not a valid environment variable name" };
-    if (v !== undefined && v !== null && /[\r\n\0]/.test(String(v))) return { key: k, why: "contains a line break or NUL character" };
+    if (v !== undefined && v !== null) {
+      const problem = envValueProblem(v);
+      if (problem) return { key: k, why: problem };
+    }
   }
   return null;
 }
@@ -1905,17 +1908,25 @@ export async function validateInstall(bundleId, { envVars = {}, consentToken = n
  *
  * Every rung writes mode 600 — bundle .env files hold secrets.
  */
-export function writeInstallEnv(destDir, envVars, manifest, log = () => {}) {
+export function writeInstallEnv(destDir, envVars, manifest, log = () => {}, { baseText = null } = {}) {
   const envPath = join(destDir, ".env");
   const examplePath = join(destDir, ".env.example");
-  const envLines = (envVars && typeof envVars === "object")
-    ? Object.entries(envVars)
-        .filter(([, v]) => v !== undefined && v !== "")
-        .map(([k, v]) => `${k}=${v}`)
-    : [];
-  if (envLines.length > 0) {
-    writePrivateFile(envPath, envLines.join("\n") + "\n");
-    log(`Wrote ${envLines.length} env vars`);
+  const usable = {};
+  if (envVars && typeof envVars === "object") {
+    for (const [k, v] of Object.entries(envVars)) if (v !== undefined && v !== "") usable[k] = v;
+  }
+  const count = Object.keys(usable).length;
+  const pathKeys = pathEnvKeys(manifest);
+  if (typeof baseText === "string") {
+    // Seeded from an existing .env / .env.example: line-preserving (C4) — the base's
+    // own lines (comments, legacy values, ${VAR} references) stay byte-for-byte.
+    writePrivateFile(envPath, updateEnvText(baseText, usable, { pathKeys }));
+    log(`Wrote ${count} env vars`);
+    return;
+  }
+  if (count > 0) {
+    writePrivateFile(envPath, formatEnvLines(usable, { pathKeys }));
+    log(`Wrote ${count} env vars`);
     return;
   }
   if (existsSync(envPath)) { chmodSync(envPath, 0o600); return; }
@@ -2029,20 +2040,22 @@ export async function runInstallJob(bundleId, envVars, { job, installedSnapshot,
     // generated keys stripped, and is the only request env used below.
     const reqEnv = stripGeneratedKeys(manifest, envVars);
     const generated = resolveGeneratedEnv(bundleId, manifest, { destDir, crowHome: CROW_HOME });
-    let installEnv = { ...(reqEnv || {}), ...generated };
+    const writeEnv = { ...(reqEnv || {}), ...generated };
+    let installEnv = writeEnv;
+    let baseText = null;
     if (Object.keys(generated).length > 0) {
       // Writing values bypasses the .env / .env.example rungs, so seed from them:
-      // existing .env entries, else .env.example defaults, then request, then generated.
+      // existing .env, else .env.example — LINE-PRESERVING (C4): the base's own lines are
+      // kept verbatim and only the request + generated keys are set on top.
       const envP = join(destDir, ".env");
       const exP = join(destDir, ".env.example");
-      let base = {};
       try {
-        if (existsSync(envP)) base = parseEnvText(readFileSync(envP, "utf8"));
-        else if (existsSync(exP)) base = parseEnvText(readFileSync(exP, "utf8"));
+        if (existsSync(envP)) baseText = readFileSync(envP, "utf8");
+        else if (existsSync(exP)) baseText = readFileSync(exP, "utf8");
       } catch { /* unreadable base: fall back to provided values only */ }
-      installEnv = { ...base, ...installEnv };
+      if (baseText !== null) installEnv = { ...parseEnvText(baseText), ...writeEnv };
     }
-    writeInstallEnv(destDir, installEnv, manifest, (msg) => appendLog(job, msg));
+    writeInstallEnv(destDir, writeEnv, manifest, (msg) => appendLog(job, msg), { baseText });
     if (Object.keys(generated).length > 0) {
       appendLog(job, `Generated ${Object.keys(generated).length} internal secret(s) — stored at mode 600, never shown`);
     }
@@ -3214,15 +3227,11 @@ export default function bundlesRouter() {
         return res.status(400).json({ code: "invalid_env", key: badPattern.key, error: `Environment variable '${badPattern.key}' ${badPattern.why}` });
       }
 
-      // Read existing .env, merge with new values
+      // Read the existing .env. The save is LINE-PRESERVING (C4): only the submitted
+      // keys change; every other line (legacy values, comments) stays byte-for-byte.
       const envPath = join(bundleDir, ".env");
-      const existing = {};
-      if (existsSync(envPath)) {
-        for (const line of readFileSync(envPath, "utf8").split("\n")) {
-          const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
-          if (match) existing[match[1]] = match[2];
-        }
-      }
+      const oldEnvText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
+      const existing = parseEnvText(oldEnvText);
 
       // Keys whose value this save actually changes (names only, never values).
       const changedKeys = Object.keys(env_vars).filter((k) => {
@@ -3231,12 +3240,8 @@ export default function bundlesRouter() {
         return existing[k] === undefined ? String(next) !== "" : String(existing[k]) !== String(next);
       });
 
-      Object.assign(existing, env_vars);
-      const envContent = Object.entries(existing)
-        .filter(([, v]) => v !== undefined)
-        .map(([k, v]) => `${k}=${v}`)
-        .join("\n") + "\n";
-      writePrivateFile(envPath, envContent);
+      Object.assign(existing, env_vars); // the effective env after this save
+      writePrivateFile(envPath, updateEnvText(oldEnvText, env_vars, { pathKeys: pathEnvKeys(getInstalledFirstManifest(bundle_id)) }));
 
       // Also configure the MCP child, which reads mcp-addons.json — not this .env.
       const mcpUpdated = applyEnvToMcpAddons(bundle_id, env_vars);
diff --git a/servers/gateway/routes/extension-proxy.js b/servers/gateway/routes/extension-proxy.js
index d3c549d..e1fb4cd 100644
--- a/servers/gateway/routes/extension-proxy.js
+++ b/servers/gateway/routes/extension-proxy.js
@@ -14,6 +14,7 @@
  *   /proxy/minio/              instead of   http://localhost:9001/
  */
 
+import { parseEnvText } from "../bundle-env-codec.js";
 import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
 import { Router } from "express";
 import { existsSync, readFileSync } from "node:fs";
@@ -45,20 +46,11 @@ function getManifest(bundleId) {
  * normal, not an error.
  */
 function readBundleEnv(bundleId) {
-  const path = join(BUNDLES_DIR, bundleId, ".env");
-  const values = {};
   try {
-    for (const line of readFileSync(path, "utf8").split("\n")) {
-      const trimmed = line.trim();
-      if (!trimmed || trimmed.startsWith("#")) continue;
-      const eq = trimmed.indexOf("=");
-      if (eq === -1) continue;
-      values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
-    }
+    return parseEnvText(readFileSync(join(BUNDLES_DIR, bundleId, ".env"), "utf8"));
   } catch {
-    // No .env for this bundle — defaults apply.
+    return {}; // No .env for this bundle — defaults apply.
   }
-  return values;
 }
 
 /**
PATCH
git diff --stat
````

- [ ] **Step 5: Run the new test and the neighbours that exercise these paths**

```bash
npm test -- tests/bundle-env-codec.test.js
npm test -- tests/bundle-env-secrets.test.js
npm test -- tests/bundle-env-scoping.test.js
npm test -- tests/extensions-needs-config.test.js
grep -n "readEnvFile" servers/gateway/routes/bundles.js || echo "readEnvFile gone"
```

Expected: all PASS. The compose test runs on crow; it is not skipped.

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/bundle-env-codec.js tests/bundle-env-codec.test.js
git commit servers/gateway/bundle-env-codec.js tests/bundle-env-codec.test.js servers/gateway/bundle-env-secrets.js servers/gateway/routes/bundles.js servers/gateway/bundles-config.js servers/gateway/routes/extension-proxy.js -m "feat(bundles): compose-exact .env codec — tilde-safe, line-preserving updates; nearly any printable character survives compose, bash and Crow"
git show --stat HEAD
```

---

### Task 2: Every other raw bundle-`.env` reader moves to the codec

**Files:**
- Create: `bundles/browser/server/app-root.js` (a verbatim copy of `bundles/maker-lab/server/app-root.js`), `bundles/workspace/ops/envfile.py`, `tests/bundle-env-readers.test.js`
- Modify:
  - `bundles/browser/server/instance.js`
  - `bundles/companion/settings-section.js`
  - `servers/gateway/migrations.js`
  - `bundles/workspace/panel/workspace.js`
  - `bundles/workspace/ops/restore-scratch.sh`
  - `bundles/{peertube,pixelfed,funkwhale,mastodon}/scripts/configure-storage.mjs`
  - the six manifests' versions (P12)
- Regenerate: `registry/add-ons.json`

**Interfaces:**
- Consumes: Task 1 `parseEnvText`, `updateEnvText`, `encodeEnvValue`.
- Produces:
  - `bundles/workspace/ops/envfile.py get <file> <KEY>`. It prints the decoded value without a trailing newline; exit 0 when the key is absent, 2 on bad usage.
  - `bundles/<storage>/scripts/env-codec-fallback.mjs`, exporting `encodeEnvValue`, `decodeEnvValue`, `parseEnvText` (a codec subset with no path logic).

- [ ] **Step 1: Write the failing test** — create `tests/bundle-env-readers.test.js`:

````js
/**
 * Every OTHER reader of an installer-written bundle .env decodes with the codec (C3b).
 * Behavioural where the reader is exported; a static guard for the rest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const HOME = mkdtempSync(join(tmpdir(), "crow-readers-home-"));
process.env.CROW_HOME = HOME;
const ROOT = join(import.meta.dirname, "..");

test("browser panel/server decode a quoted value from the bundle .env", async () => {
  mkdirSync(join(HOME, "bundles", "browser"), { recursive: true });
  writeFileSync(join(HOME, "bundles", "browser", ".env"), "CROW_BROWSER_CONTAINER_NAME='crow-browser-r4'\n");
  delete process.env.CROW_BROWSER_CONTAINER_NAME;
  const m = await import("../bundles/browser/server/instance.js");
  assert.equal(m.containerName(), "crow-browser-r4");
});

test("workspace Office page reads decoded public settings", async () => {
  mkdirSync(join(HOME, "bundles", "workspace"), { recursive: true });
  writeFileSync(join(HOME, "bundles", "workspace", ".env"), "WORKSPACE_PUBLIC_HOST='box.example.ts.net'\nWORKSPACE_ADMIN_PASSWORD='never read'\n");
  const { readPublicSettings } = await import("../bundles/workspace/panel/workspace.js");
  const s = readPublicSettings(HOME);
  assert.equal(s.WORKSPACE_PUBLIC_HOST, "box.example.ts.net");
  assert.equal(s.WORKSPACE_ADMIN_PASSWORD, undefined);
});

test("restore-scratch.sh reads the admin user through envfile.py (no sed)", () => {
  const sh = readFileSync(join(ROOT, "bundles/workspace/ops/restore-scratch.sh"), "utf8");
  assert.doesNotMatch(sh, /sed -n 's\/\^WORKSPACE_ADMIN_USER=/);
  assert.match(sh, /envfile\.py" get "\$SCRATCH\/unpacked\/bundle\.env" WORKSPACE_ADMIN_USER/);
  const dir = mkdtempSync(join(tmpdir(), "crow-readers-py-"));
  writeFileSync(join(dir, ".env"), "WORKSPACE_ADMIN_USER='kevin'\n");
  const r = spawnSync("python3", [join(ROOT, "bundles/workspace/ops/envfile.py"), "get", join(dir, ".env"), "WORKSPACE_ADMIN_USER"], { encoding: "utf8" });
  assert.equal(r.stdout, "kevin");
});

test("static guard: the remaining raw readers import the codec and dropped their ad-hoc parsers", () => {
  const files = [
    "bundles/companion/settings-section.js",
    "servers/gateway/migrations.js",
    "bundles/peertube/scripts/configure-storage.mjs",
    "bundles/pixelfed/scripts/configure-storage.mjs",
    "bundles/funkwhale/scripts/configure-storage.mjs",
    "bundles/mastodon/scripts/configure-storage.mjs",
  ];
  for (const f of files) {
    const s = readFileSync(join(ROOT, f), "utf8");
    assert.match(s, /bundle-env-codec\.js/, `${f} must decode with the codec`);
    assert.doesNotMatch(s, /line\.match\(\/\^/, `${f} still has a raw line-regex .env parser`);
    assert.doesNotMatch(s, /`\$\{k\}=\$\{v\}`/, `${f} still writes raw KEY=value lines`);
  }
});

const STORAGE_BUNDLES = ["peertube", "pixelfed", "funkwhale", "mastodon"];

test("B1 — each shipped fallback codec is equivalent to the real codec (encode + parse)", async () => {
  const C = await import("../servers/gateway/bundle-env-codec.js");
  const pool = []; for (let c = 0x20; c < 0x7f; c++) pool.push(String.fromCharCode(c)); pool.push("é", "😀", "\t");
  const vals = ["", "plain", "p a$s'w\"d #1", "~/x", "it's $HOME", "x\\"];
  for (let i = 0; i < 400; i++) { let v = ""; const n = randomInt(1, 25); for (let j = 0; j < n; j++) v += pool[randomInt(pool.length)]; vals.push(v); }
  const ok = vals.filter((v) => !C.envValueProblem(v));
  for (const b of STORAGE_BUNDLES) {
    const F = await import(`../bundles/${b}/scripts/env-codec-fallback.mjs`);
    for (const v of ok) assert.equal(F.encodeEnvValue(v), C.encodeEnvValue(v), `${b} encode ${JSON.stringify(v)}`);
    const text = C.formatEnvLines(Object.fromEntries(ok.map((v, i) => [`K${i}`, v])));
    assert.deepEqual(F.parseEnvText(text), C.parseEnvText(text), `${b} parse`);
  }
});

test("B1 — an INSTALLED copy (outside the repo, no CROW_APP_ROOT) still runs and writes an encoded block", () => {
  for (const b of STORAGE_BUNDLES) {
    const root = mkdtempSync(join(tmpdir(), `crow-storage-${b}-`));
    mkdirSync(join(root, "scripts"));
    for (const f of ["configure-storage.mjs", "env-codec-fallback.mjs"]) copyFileSync(join(ROOT, "bundles", b, "scripts", f), join(root, "scripts", f));
    const prefix = b.toUpperCase();
    writeFileSync(join(root, ".env"), [
      `${prefix}_S3_ENDPOINT='http://minio.example:9000'`,
      `${prefix}_S3_BUCKET=media`,
      `${prefix}_S3_ACCESS_KEY='access key'`,
      `${prefix}_S3_SECRET_KEY='s3cr3t with space $x'`,
      "",
    ].join("\n"));
    const env = { ...process.env };
    delete env.CROW_APP_ROOT;
    const r = spawnSync(process.execPath, [join(root, "scripts", "configure-storage.mjs")], { cwd: root, env, encoding: "utf8" });
    assert.equal(r.status, 0, `${b}: ${r.stderr}`);
    const out = readFileSync(join(root, ".env"), "utf8");
    assert.match(out, /BEGIN/, `${b}: managed block written`);
    assert.ok(out.includes("'s3cr3t with space $x'"), `${b}: the secret is decoded, then re-encoded (not double-quoted text)`);
  }
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/bundle-env-readers.test.js`
Expected: FAIL. The browser test reads `'crow-browser-r4'` with its quotes, `envfile.py` and the fallback codecs are missing, and the out-of-repo storage run dies with `ERR_MODULE_NOT_FOUND` (the B1 regression this task must not ship).

- [ ] **Step 3: Create the two new files**

`bundles/browser/server/app-root.js`:

````js
/**
 * Resolve the Crow app repo root from an INSTALLED copy (~/.crow/bundles/…)
 * or an in-repo run. The gateway exports CROW_APP_ROOT for itself and its
 * spawned addon children; the relative guess covers direct in-repo runs.
 * The W2-5 migration's static `../../../servers/...` imports only resolved
 * in-repo — this resolver is what lets the installed copy run at all.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
function looksLikeAppRoot(p) { return !!p && existsSync(join(p, "servers", "db.js")); }
const guess = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const APP_ROOT = looksLikeAppRoot(process.env.CROW_APP_ROOT) ? process.env.CROW_APP_ROOT
  : looksLikeAppRoot(guess) ? guess
  : (process.env.CROW_APP_ROOT || guess);
export const appImport = (rel) => import(pathToFileURL(join(APP_ROOT, rel)).href);
````

`bundles/workspace/ops/envfile.py` (then `chmod 755` it):

````python
#!/usr/bin/env python3
"""Read one key from a Crow bundle .env without any shell evaluation.

Decodes exactly what Crow's installer writes (servers/gateway/bundle-env-codec.js):
bare values, 'single-quoted' (backslash-quote -> quote) and "double-quoted"
(escapes for backslash, double quote, $, n, t, r) values, an optional `export `
prefix and a trailing ` #comment` on bare values. Last occurrence wins.
Usage: envfile.py get <file> <KEY>   -> prints the value (no newline); exit 0 if absent.
"""
import re
import sys

LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")
DQ = {"\\": "\\", '"': '"', "$": "$", "n": "\n", "t": "\t", "r": "\r"}


def decode(raw):
    s = raw.lstrip()
    if s.startswith("'"):
        out, i = [], 1
        while i < len(s):
            c = s[i]
            if c == "\\" and i + 1 < len(s) and s[i + 1] == "'":
                out.append("'")
                i += 2
                continue
            if c == "'":
                return "".join(out)
            out.append(c)
            i += 1
        return s
    if s.startswith('"'):
        out, i = [], 1
        while i < len(s):
            c = s[i]
            if c == "\\" and i + 1 < len(s):
                n = s[i + 1]
                if n in DQ:
                    out.append(DQ[n])
                    i += 2
                    continue
                out.append(c)
                i += 1
                continue
            if c == '"':
                return "".join(out)
            out.append(c)
            i += 1
        return s
    return re.split(r"\s+#", s, maxsplit=1)[0].strip()


def get(path, key):
    val = ""
    with open(path, encoding="utf-8") as f:
        for line in f.read().split("\n"):
            m = LINE.match(line.rstrip("\r"))
            if m and m.group(1) == key:
                val = decode(m.group(2))
    return val


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] != "get":
        sys.stderr.write("usage: envfile.py get <file> <KEY>\n")
        sys.exit(2)
    sys.stdout.write(get(sys.argv[2], sys.argv[3]))
````

`bundles/peertube/scripts/env-codec-fallback.mjs` (B1). Then copy it unchanged into the other three storage bundles; the test keeps all four equivalent to the codec:

````js
/**
 * Fallback copy of the Crow .env codec's decode/encode (servers/gateway/bundle-env-codec.js),
 * used by ./configure-storage.mjs only when the Crow app cannot be found (an installed copy
 * run without CROW_APP_ROOT). tests/bundle-env-readers.test.js keeps it byte-for-byte
 * equivalent to the real codec on a fuzzed value set. Do not edit one without the other.
 */
const BARE_SAFE = /^[A-Za-z0-9_./:@%+,=^!?*-]*$/;
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const DQ_ESCAPES = { "\\": "\\", '"': '"', $: "$", n: "\n", t: "\t", r: "\r" };

export function encodeEnvValue(value) {
  const s = String(value);
  if (/[\r\n\0]/.test(s)) throw new Error("env value contains a line break or NUL character");
  if (BARE_SAFE.test(s)) return s;
  if (!s.includes("'") && !s.endsWith("\\")) return `'${s}'`;
  if (s.includes("`")) throw new Error("env value cannot contain a backtick together with a single quote or a trailing backslash");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;
}

export function decodeEnvValue(raw) {
  const s = String(raw).trimStart();
  if (s.startsWith("'")) {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "\\" && s[i + 1] === "'") { out += "'"; i++; continue; }
      if (s[i] === "'") return out;
      out += s[i];
    }
    return s;
  }
  if (s.startsWith('"')) {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "\\" && i + 1 < s.length) {
        const n = s[i + 1];
        if (Object.hasOwn(DQ_ESCAPES, n)) { out += DQ_ESCAPES[n]; i++; continue; }
        out += "\\";
        continue;
      }
      if (s[i] === '"') return out;
      out += s[i];
    }
    return s;
  }
  return s.split(/\s+#/, 1)[0].trim();
}

export function parseEnvText(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const m = line.replace(/\r$/, "").match(LINE);
    if (m) out[m[1]] = decodeEnvValue(m[2]);
  }
  return out;
}
````

```bash
for b in pixelfed funkwhale mastodon; do cp bundles/peertube/scripts/env-codec-fallback.mjs bundles/$b/scripts/env-codec-fallback.mjs; done
```

- [ ] **Step 4: Switch the readers and bump the versions**

````bash
cd ~/crow-wt-keychain && git apply <<'PATCH'
diff --git a/bundles/browser/manifest.json b/bundles/browser/manifest.json
index 3282926..cfe1825 100644
--- a/bundles/browser/manifest.json
+++ b/bundles/browser/manifest.json
@@ -1,7 +1,7 @@
 {
   "id": "browser",
   "name": "Browser Automation",
-  "version": "1.3.3",
+  "version": "1.3.4",
   "description": "Stealth browser automation — navigate, fill forms, take screenshots, extract content via Chrome DevTools Protocol with VNC viewing",
   "type": "bundle",
   "author": "Crow",
diff --git a/bundles/browser/server/instance.js b/bundles/browser/server/instance.js
index 33a89bf..e0a607e 100644
--- a/bundles/browser/server/instance.js
+++ b/bundles/browser/server/instance.js
@@ -9,6 +9,8 @@
 import { homedir } from "node:os";
 import { join } from "node:path";
 import { readFileSync } from "node:fs";
+import { appImport } from "./app-root.js";
+const { parseEnvText } = await appImport("servers/gateway/bundle-env-codec.js");
 
 /** This instance's home. Falls back to the primary, which is correct only for the primary. */
 export function stateRoot() {
@@ -32,15 +34,11 @@ let envCache = null;
 function bundleEnv() {
   const path = join(stateRoot(), "bundles", "browser", ".env");
   if (envCache && envCache.path === path) return envCache.values;
-  const values = {};
+  let values = {};
   try {
-    for (const line of readFileSync(path, "utf8").split("\n")) {
-      const trimmed = line.trim();
-      if (!trimmed || trimmed.startsWith("#")) continue;
-      const eq = trimmed.indexOf("=");
-      if (eq === -1) continue;
-      values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
-    }
+    // Compose-exact decoding (bundle-env-codec.js): the installer quotes a typed
+    // CROW_BROWSER_VNC_PASSWORD with spaces or symbols; the container sees it unquoted.
+    values = parseEnvText(readFileSync(path, "utf8"));
   } catch {
     // No .env (fresh checkout, bundle not installed) — defaults apply.
   }
diff --git a/bundles/companion/manifest.json b/bundles/companion/manifest.json
index 979fd2d..6a852c6 100644
--- a/bundles/companion/manifest.json
+++ b/bundles/companion/manifest.json
@@ -1,7 +1,7 @@
 {
   "id": "companion",
   "name": "AI Companion",
-  "version": "1.0.0",
+  "version": "1.0.1",
   "description": "Voice-interactive AI companion with animated Live2D avatar. Powered by Open-LLM-VTuber with Crow's BYOAI profiles.",
   "type": "bundle",
   "author": "Crow",
diff --git a/bundles/companion/settings-section.js b/bundles/companion/settings-section.js
index 39459a0..9ba261f 100644
--- a/bundles/companion/settings-section.js
+++ b/bundles/companion/settings-section.js
@@ -14,7 +14,8 @@
  */
 
 import { existsSync, readFileSync, writeFileSync } from "fs";
-import { join } from "path";
+import { join, dirname } from "path";
+import { fileURLToPath, pathToFileURL } from "url";
 import { homedir } from "os";
 import { execFileSync } from "child_process";
 
@@ -61,23 +62,34 @@ const BUNDLE_DIR = join(homedir(), ".crow", "bundles", "companion");
 
 /* ---------- .env helpers ---------- */
 
+// Compose-exact .env codec from the Crow app (bundle-env-codec.js). This file is loaded
+// from ~/.crow/bundles/companion/, so resolve the app root the way maker-lab does.
+const __companionAppRoot = (() => {
+  const ok = (p) => !!p && existsSync(join(p, "servers", "db.js"));
+  const guess = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
+  return ok(process.env.CROW_APP_ROOT) ? process.env.CROW_APP_ROOT : guess;
+})();
+const { parseEnvText, updateEnvText } = await import(pathToFileURL(join(__companionAppRoot, "servers", "gateway", "bundle-env-codec.js")).href);
+
 function readBundleEnv() {
   const envPath = join(BUNDLE_DIR, ".env");
   if (!existsSync(envPath)) return {};
-  const env = {};
-  for (const line of readFileSync(envPath, "utf8").split("\n")) {
-    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
-    if (match) env[match[1]] = match[2];
-  }
-  return env;
+  return parseEnvText(readFileSync(envPath, "utf8"));
 }
 
+/** Line-preserving: only keys whose value changed are rewritten; blanked/removed keys are dropped. */
 function writeBundleEnv(env) {
   const envPath = join(BUNDLE_DIR, ".env");
-  const lines = Object.entries(env)
-    .filter(([, v]) => v !== undefined && v !== "")
-    .map(([k, v]) => `${k}=${v}`);
-  writeFileSync(envPath, lines.join("\n") + "\n");
+  const oldText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
+  const old = parseEnvText(oldText);
+  const updates = {};
+  const remove = [];
+  for (const [k, v] of Object.entries(env)) {
+    if (v === undefined || v === "") { if (Object.hasOwn(old, k)) remove.push(k); }
+    else if (old[k] !== String(v)) updates[k] = v;
+  }
+  for (const k of Object.keys(old)) if (!Object.hasOwn(env, k)) remove.push(k);
+  writeFileSync(envPath, updateEnvText(oldText, updates, { remove }));
 }
 
 function escapeHtml(s) {
diff --git a/bundles/funkwhale/manifest.json b/bundles/funkwhale/manifest.json
index 977dba6..d4e9c6c 100644
--- a/bundles/funkwhale/manifest.json
+++ b/bundles/funkwhale/manifest.json
@@ -1,7 +1,7 @@
 {
   "id": "funkwhale",
   "name": "Funkwhale",
-  "version": "1.0.0",
+  "version": "1.0.1",
   "description": "Federated music server — self-hosted audio library + podcast streaming + fediverse-federated listening over ActivityPub. Upload your own library; follow remote channels and artists across the fediverse.",
   "type": "bundle",
   "author": "Crow",
diff --git a/bundles/funkwhale/scripts/configure-storage.mjs b/bundles/funkwhale/scripts/configure-storage.mjs
index fc15c3c..bd6b4f3 100755
--- a/bundles/funkwhale/scripts/configure-storage.mjs
+++ b/bundles/funkwhale/scripts/configure-storage.mjs
@@ -15,18 +15,28 @@
 
 import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
 import { join, dirname, resolve } from "node:path";
-import { fileURLToPath } from "node:url";
+import { fileURLToPath, pathToFileURL } from "node:url";
 
 const __dirname = dirname(fileURLToPath(import.meta.url));
 const ENV_PATH = resolve(__dirname, "..", ".env");
 
-function parseEnv(text) {
-  const out = {};
-  for (const line of text.split("\n")) {
-    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
-    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
+// Compose-exact .env codec (servers/gateway/bundle-env-codec.js): the installer quotes values
+// with spaces, quotes, $ or #. An INSTALLED copy runs from ~/.crow/bundles/<id>/scripts/, where
+// the repo-relative path does not exist — so resolve the app from CROW_APP_ROOT, then the
+// in-repo location, and otherwise use the copy shipped beside this script. A failed import
+// must never leave S3 storage silently unconfigured.
+async function loadCodec() {
+  for (const root of [process.env.CROW_APP_ROOT, resolve(__dirname, "..", "..", "..")]) {
+    if (!root) continue;
+    const p = resolve(root, "servers", "gateway", "bundle-env-codec.js");
+    if (!existsSync(p)) continue;
+    try { return await import(pathToFileURL(p).href); } catch { /* try the next location */ }
   }
-  return out;
+  return import(new URL("./env-codec-fallback.mjs", import.meta.url).href);
+}
+const codec = await loadCodec();
+function parseEnv(text) {
+  return codec.parseEnvText(text);
 }
 
 function loadEnv() {
@@ -73,7 +83,7 @@ async function main() {
 
   const BEGIN = "# crow-funkwhale-storage BEGIN (managed by scripts/configure-storage.mjs — do not edit)";
   const END = "# crow-funkwhale-storage END";
-  const block = [BEGIN, ...Object.entries(mapped).map(([k, v]) => `${k}=${v}`), END, ""].join("\n");
+  const block = [BEGIN, ...Object.entries(mapped).map(([k, v]) => `${k}=${codec.encodeEnvValue(v)}`), END, ""].join("\n");
 
   let cur = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
   if (cur.includes(BEGIN)) {
diff --git a/bundles/mastodon/manifest.json b/bundles/mastodon/manifest.json
index 944311b..9056eb4 100644
--- a/bundles/mastodon/manifest.json
+++ b/bundles/mastodon/manifest.json
@@ -1,7 +1,7 @@
 {
   "id": "mastodon",
   "name": "Mastodon",
-  "version": "1.0.0",
+  "version": "1.0.1",
   "description": "The flagship ActivityPub server — federated microblogging at scale. Heaviest of the small-AP bundles. Hosts a public (or invite-only) Mastodon instance with the full v1/v2 API surface, web UI, and Sidekiq background job processing.",
   "type": "bundle",
   "author": "Crow",
diff --git a/bundles/mastodon/scripts/configure-storage.mjs b/bundles/mastodon/scripts/configure-storage.mjs
index 919dd3e..6e9649e 100755
--- a/bundles/mastodon/scripts/configure-storage.mjs
+++ b/bundles/mastodon/scripts/configure-storage.mjs
@@ -12,18 +12,28 @@
 
 import { readFileSync, writeFileSync, existsSync } from "node:fs";
 import { dirname, resolve } from "node:path";
-import { fileURLToPath } from "node:url";
+import { fileURLToPath, pathToFileURL } from "node:url";
 
 const __dirname = dirname(fileURLToPath(import.meta.url));
 const ENV_PATH = resolve(__dirname, "..", ".env");
 
-function parseEnv(text) {
-  const out = {};
-  for (const line of text.split("\n")) {
-    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
-    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
+// Compose-exact .env codec (servers/gateway/bundle-env-codec.js): the installer quotes values
+// with spaces, quotes, $ or #. An INSTALLED copy runs from ~/.crow/bundles/<id>/scripts/, where
+// the repo-relative path does not exist — so resolve the app from CROW_APP_ROOT, then the
+// in-repo location, and otherwise use the copy shipped beside this script. A failed import
+// must never leave S3 storage silently unconfigured.
+async function loadCodec() {
+  for (const root of [process.env.CROW_APP_ROOT, resolve(__dirname, "..", "..", "..")]) {
+    if (!root) continue;
+    const p = resolve(root, "servers", "gateway", "bundle-env-codec.js");
+    if (!existsSync(p)) continue;
+    try { return await import(pathToFileURL(p).href); } catch { /* try the next location */ }
   }
-  return out;
+  return import(new URL("./env-codec-fallback.mjs", import.meta.url).href);
+}
+const codec = await loadCodec();
+function parseEnv(text) {
+  return codec.parseEnvText(text);
 }
 
 function loadEnv() {
@@ -78,7 +88,7 @@ async function main() {
 
   const BEGIN = "# crow-mastodon-storage BEGIN (managed by scripts/configure-storage.mjs — do not edit)";
   const END = "# crow-mastodon-storage END";
-  const block = [BEGIN, ...Object.entries(mapped).map(([k, v]) => `${k}=${v}`), END, ""].join("\n");
+  const block = [BEGIN, ...Object.entries(mapped).map(([k, v]) => `${k}=${codec.encodeEnvValue(v)}`), END, ""].join("\n");
 
   let cur = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
   if (cur.includes(BEGIN)) {
diff --git a/bundles/peertube/manifest.json b/bundles/peertube/manifest.json
index c23023b..93ae060 100644
--- a/bundles/peertube/manifest.json
+++ b/bundles/peertube/manifest.json
@@ -1,7 +1,7 @@
 {
   "id": "peertube",
   "name": "PeerTube",
-  "version": "1.0.0",
+  "version": "1.0.1",
   "description": "Federated video platform over ActivityPub — YouTube-alternative on the fediverse. Upload and transcode video, federate channels, stream via WebTorrent or HLS. Heaviest bundle in the federated line — S3 storage + aggressive transcoding policy are load-bearing, not optional.",
   "type": "bundle",
   "author": "Crow",
diff --git a/bundles/peertube/scripts/configure-storage.mjs b/bundles/peertube/scripts/configure-storage.mjs
index 0672270..4b4b6e4 100755
--- a/bundles/peertube/scripts/configure-storage.mjs
+++ b/bundles/peertube/scripts/configure-storage.mjs
@@ -13,18 +13,28 @@
 
 import { readFileSync, writeFileSync, existsSync } from "node:fs";
 import { dirname, resolve } from "node:path";
-import { fileURLToPath } from "node:url";
+import { fileURLToPath, pathToFileURL } from "node:url";
 
 const __dirname = dirname(fileURLToPath(import.meta.url));
 const ENV_PATH = resolve(__dirname, "..", ".env");
 
-function parseEnv(text) {
-  const out = {};
-  for (const line of text.split("\n")) {
-    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
-    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
+// Compose-exact .env codec (servers/gateway/bundle-env-codec.js): the installer quotes values
+// with spaces, quotes, $ or #. An INSTALLED copy runs from ~/.crow/bundles/<id>/scripts/, where
+// the repo-relative path does not exist — so resolve the app from CROW_APP_ROOT, then the
+// in-repo location, and otherwise use the copy shipped beside this script. A failed import
+// must never leave S3 storage silently unconfigured.
+async function loadCodec() {
+  for (const root of [process.env.CROW_APP_ROOT, resolve(__dirname, "..", "..", "..")]) {
+    if (!root) continue;
+    const p = resolve(root, "servers", "gateway", "bundle-env-codec.js");
+    if (!existsSync(p)) continue;
+    try { return await import(pathToFileURL(p).href); } catch { /* try the next location */ }
   }
-  return out;
+  return import(new URL("./env-codec-fallback.mjs", import.meta.url).href);
+}
+const codec = await loadCodec();
+function parseEnv(text) {
+  return codec.parseEnvText(text);
 }
 
 function loadEnv() {
@@ -75,7 +85,7 @@ async function main() {
 
   const BEGIN = "# crow-peertube-storage BEGIN (managed by scripts/configure-storage.mjs — do not edit)";
   const END = "# crow-peertube-storage END";
-  const block = [BEGIN, ...Object.entries(mapped).map(([k, v]) => `${k}=${v}`), END, ""].join("\n");
+  const block = [BEGIN, ...Object.entries(mapped).map(([k, v]) => `${k}=${codec.encodeEnvValue(v)}`), END, ""].join("\n");
 
   let cur = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
   if (cur.includes(BEGIN)) {
diff --git a/bundles/pixelfed/manifest.json b/bundles/pixelfed/manifest.json
index c9e6cdd..0617dc7 100644
--- a/bundles/pixelfed/manifest.json
+++ b/bundles/pixelfed/manifest.json
@@ -1,7 +1,7 @@
 {
   "id": "pixelfed",
   "name": "Pixelfed",
-  "version": "1.0.0",
+  "version": "1.0.1",
   "description": "Federated photo-sharing server over ActivityPub — Instagram-alternative on the fediverse. Publish photos/stories/collections; remote Mastodon/GoToSocial/Funkwhale followers see your posts in their timelines.",
   "type": "bundle",
   "author": "Crow",
diff --git a/bundles/pixelfed/scripts/configure-storage.mjs b/bundles/pixelfed/scripts/configure-storage.mjs
index a60b772..f783c6d 100755
--- a/bundles/pixelfed/scripts/configure-storage.mjs
+++ b/bundles/pixelfed/scripts/configure-storage.mjs
@@ -15,18 +15,28 @@
 
 import { readFileSync, writeFileSync, existsSync } from "node:fs";
 import { dirname, resolve } from "node:path";
-import { fileURLToPath } from "node:url";
+import { fileURLToPath, pathToFileURL } from "node:url";
 
 const __dirname = dirname(fileURLToPath(import.meta.url));
 const ENV_PATH = resolve(__dirname, "..", ".env");
 
-function parseEnv(text) {
-  const out = {};
-  for (const line of text.split("\n")) {
-    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
-    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
+// Compose-exact .env codec (servers/gateway/bundle-env-codec.js): the installer quotes values
+// with spaces, quotes, $ or #. An INSTALLED copy runs from ~/.crow/bundles/<id>/scripts/, where
+// the repo-relative path does not exist — so resolve the app from CROW_APP_ROOT, then the
+// in-repo location, and otherwise use the copy shipped beside this script. A failed import
+// must never leave S3 storage silently unconfigured.
+async function loadCodec() {
+  for (const root of [process.env.CROW_APP_ROOT, resolve(__dirname, "..", "..", "..")]) {
+    if (!root) continue;
+    const p = resolve(root, "servers", "gateway", "bundle-env-codec.js");
+    if (!existsSync(p)) continue;
+    try { return await import(pathToFileURL(p).href); } catch { /* try the next location */ }
   }
-  return out;
+  return import(new URL("./env-codec-fallback.mjs", import.meta.url).href);
+}
+const codec = await loadCodec();
+function parseEnv(text) {
+  return codec.parseEnvText(text);
 }
 
 function loadEnv() {
@@ -74,7 +84,7 @@ async function main() {
 
   const BEGIN = "# crow-pixelfed-storage BEGIN (managed by scripts/configure-storage.mjs — do not edit)";
   const END = "# crow-pixelfed-storage END";
-  const block = [BEGIN, ...Object.entries(mapped).map(([k, v]) => `${k}=${v}`), END, ""].join("\n");
+  const block = [BEGIN, ...Object.entries(mapped).map(([k, v]) => `${k}=${codec.encodeEnvValue(v)}`), END, ""].join("\n");
 
   let cur = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
   if (cur.includes(BEGIN)) {
diff --git a/bundles/workspace/ops/restore-scratch.sh b/bundles/workspace/ops/restore-scratch.sh
index 58f723e..d811f92 100755
--- a/bundles/workspace/ops/restore-scratch.sh
+++ b/bundles/workspace/ops/restore-scratch.sh
@@ -28,7 +28,7 @@ ARCHIVE="${1:?usage: restore-scratch.sh <archive.tar> [passphrase-file] | --clea
 case "${2:-}" in *.tar) die "second argument looks like an archive ($2); usage: restore-scratch.sh <archive.tar> [passphrase-file]";; esac
 [ ! -e "$SCRATCH" ] || die "$SCRATCH already exists. Run: $0 --clean"
 bash "$BUNDLE_DIR/ops/restore.sh" "$ARCHIVE" "$SCRATCH/unpacked" "${2:-${CROW_HOME:-$HOME/.crow}/workspace/backup-passphrase}"
-ADMIN="$(sed -n 's/^WORKSPACE_ADMIN_USER=//p' "$SCRATCH/unpacked/bundle.env" | tail -n 1)"; ADMIN="${ADMIN:-admin}"
+ADMIN="$(python3 "$(dirname "${BASH_SOURCE[0]}")/envfile.py" get "$SCRATCH/unpacked/bundle.env" WORKSPACE_ADMIN_USER)"; ADMIN="${ADMIN:-admin}"
 mkdir -p "$SCRATCH/workspace/nextcloud" "$SCRATCH/workspace/db"
 docker run --rm -v "$SCRATCH/workspace/nextcloud:/dst" -v "$SCRATCH/unpacked:/src:ro" "$IMAGE" \
   sh -c 'tar -C /dst -xpf /src/nextcloud-files.tar && chown -R www-data:www-data /dst'
diff --git a/bundles/workspace/panel/workspace.js b/bundles/workspace/panel/workspace.js
index 8034b36..7ca9ac2 100644
--- a/bundles/workspace/panel/workspace.js
+++ b/bundles/workspace/panel/workspace.js
@@ -8,8 +8,19 @@
  * $CROW_HOME/panels/workspace.js, so it imports nothing from the bundle.
  */
 import { readFileSync, existsSync } from "node:fs";
-import { join } from "node:path";
+import { join, dirname } from "node:path";
 import { homedir } from "node:os";
+import { fileURLToPath, pathToFileURL } from "node:url";
+
+// The installer quotes .env values (bundle-env-codec.js); decode them the same way. This
+// file runs from $CROW_HOME/panels/, so the app root comes from CROW_APP_ROOT (set by the
+// gateway), falling back to the in-repo location for tests.
+const __wsAppRoot = (() => {
+  const ok = (p) => !!p && existsSync(join(p, "servers", "db.js"));
+  const guess = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
+  return ok(process.env.CROW_APP_ROOT) ? process.env.CROW_APP_ROOT : guess;
+})();
+const { parseEnvText } = await import(pathToFileURL(join(__wsAppRoot, "servers", "gateway", "bundle-env-codec.js")).href);
 
 const T = {
   en: {
@@ -77,11 +88,9 @@ const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "
 export function readPublicSettings(crowHome) {
   const p = join(crowHome, "bundles", "workspace", ".env");
   if (!existsSync(p)) return null;
+  const all = parseEnvText(readFileSync(p, "utf8"));
   const out = {};
-  for (const line of readFileSync(p, "utf8").split("\n")) {
-    const m = line.replace(/\r$/, "").match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
-    if (m && PUBLIC_KEYS.includes(m[1])) out[m[1]] = m[2];
-  }
+  for (const k of PUBLIC_KEYS) if (Object.hasOwn(all, k)) out[k] = all[k];
   return out;
 }
 
diff --git a/servers/gateway/migrations.js b/servers/gateway/migrations.js
index c7fead9..542fe1b 100644
--- a/servers/gateway/migrations.js
+++ b/servers/gateway/migrations.js
@@ -9,6 +9,7 @@
  * half-state.
  */
 
+import { parseEnvText } from "./bundle-env-codec.js";
 import { existsSync, readFileSync } from "node:fs";
 import { homedir } from "node:os";
 import { join } from "node:path";
@@ -31,12 +32,7 @@ async function readMigrationsState(db) {
 function readCompanionEnv() {
   const envPath = join(homedir(), ".crow", "bundles", "companion", ".env");
   if (!existsSync(envPath)) return {};
-  const env = {};
-  for (const line of readFileSync(envPath, "utf8").split("\n")) {
-    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
-    if (m) env[m[1]] = m[2];
-  }
-  return env;
+  return parseEnvText(readFileSync(envPath, "utf8"));
 }
 
 /** Read dashboard_settings by key (string). */
PATCH
git diff --stat
````

Then rebuild the registry:

```bash
chmod 755 bundles/workspace/ops/envfile.py
node scripts/build-registry.mjs && node scripts/build-registry.mjs --check
```

- [ ] **Step 5: Run the tests**

```bash
npm test -- tests/bundle-env-readers.test.js
npm test -- tests/workspace-panel.test.js
npm test -- tests/workspace-backup.test.js
npm test -- tests/workspace-bootstrap.test.js
node -e 'import("./bundles/companion/settings-section.js").then(m=>console.log("companion loads", !!m.default))'
```

Expected: all PASS; "companion loads true".

- [ ] **Step 6: Commit**

```bash
git add bundles/browser/server/app-root.js bundles/workspace/ops/envfile.py tests/bundle-env-readers.test.js bundles/peertube/scripts/env-codec-fallback.mjs bundles/pixelfed/scripts/env-codec-fallback.mjs bundles/funkwhale/scripts/env-codec-fallback.mjs bundles/mastodon/scripts/env-codec-fallback.mjs
git commit bundles/browser/server/app-root.js bundles/browser/server/instance.js bundles/browser/manifest.json bundles/companion/settings-section.js bundles/companion/manifest.json servers/gateway/migrations.js bundles/workspace/panel/workspace.js bundles/workspace/ops/envfile.py bundles/workspace/ops/restore-scratch.sh bundles/peertube bundles/pixelfed bundles/funkwhale bundles/mastodon registry/add-ons.json tests/bundle-env-readers.test.js -m "fix(bundles): every bundle .env reader decodes with the codec (browser, companion, workspace, storage scripts, migrations)"
git show --stat HEAD
```

---

### Task 3: `generatable`, `keychain`, `store_as: "argon2id"`, keychain-first generation

**Files:**
- Create: `servers/gateway/keychain/argon2-phc.js`, `tests/bundle-env-keychain-generate.test.js`
- Modify: `servers/gateway/bundle-env-secrets.js`, `registry/manifest.schema.json`, `scripts/lib/bundle-contract.mjs`

**Interfaces:**
- Consumes: Task 1 `formatEnvLines`, `parseEnvText`.
- Produces:
  - `argon2idPhc(plaintext, { salt? }): string`
  - `verifyArgon2idPhc(plaintext, phc): boolean`
  - `ARGON2_PARAMS`
  - `planGeneratedEnv(bundleId, manifest, { destDir, crowHome }): { env, minted, persist(): void }`. Nothing is written until `persist()`.
  - `resolveGeneratedEnv(...)`: same signature as before; it **throws** for manifests with `keychain:true` generated vars, and persists otherwise.
  - `keychainGeneratedKeys(manifest): string[]`
  - `keychainEligibleKeys(manifest): string[]` (`secret && !generate && (generatable || keychain)`)
  - `expandKeychainTemplate(template, env): string|null`
- `validateManifest` (`scripts/lib/bundle-contract.mjs:130`) gains the combination rules.

- [ ] **Step 1: Write the failing test** — create `tests/bundle-env-keychain-generate.test.js`:

````js
/** generate + keychain + store_as, generatable opt-in (Crow keychain, Task 2). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";

const S = await import("../servers/gateway/bundle-env-secrets.js");
const P = await import("../servers/gateway/keychain/argon2-phc.js");
const scratch = (p) => mkdtempSync(join(tmpdir(), p));

const VW = {
  id: "vw-demo",
  env_vars: [
    { name: "VW_DOMAIN", default: "http://localhost:8097" },
    { name: "VW_ADMIN_TOKEN", secret: true, generate: "secret", keychain: true, store_as: "argon2id", keychain_url: "${VW_DOMAIN}/admin" },
    { name: "VW_PLAIN", secret: true, generate: "secret", keychain: true },
    { name: "VW_INTERNAL", generate: "secret" },
    { name: "VW_ADMIN_PASSWORD", secret: true, generatable: true, propagate: false },
    { name: "VW_API_KEY", secret: true },
  ],
};

test("argon2idPhc emits the exact Vaultwarden-accepted PHC shape and verifies", () => {
  const phc = P.argon2idPhc("token-123");
  assert.match(phc, /^\$argon2id\$v=19\$m=65540,t=3,p=4\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  assert.equal(P.verifyArgon2idPhc("token-123", phc), true);
  assert.equal(P.verifyArgon2idPhc("token-124", phc), false);
  assert.equal(P.verifyArgon2idPhc("token-123", "$argon2id$garbage"), false);
});

test("a fixed salt gives a deterministic hash (the format is not a random blob)", () => {
  const salt = Buffer.alloc(16, 7);
  assert.equal(P.argon2idPhc("x", { salt }), P.argon2idPhc("x", { salt }));
});

test("C5 — planGeneratedEnv persists NOTHING until persist(); then the retained copy holds the HASH", () => {
  const home = scratch("h-");
  const plan = S.planGeneratedEnv("vw-demo", VW, { destDir: scratch("d-"), crowHome: home });
  assert.deepEqual(Object.keys(plan.minted).sort(), ["VW_ADMIN_TOKEN", "VW_PLAIN"], "VW_INTERNAL is not keychain:true");
  assert.match(plan.minted.VW_ADMIN_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(P.verifyArgon2idPhc(plan.minted.VW_ADMIN_TOKEN, plan.env.VW_ADMIN_TOKEN), true);
  assert.equal(plan.env.VW_PLAIN, plan.minted.VW_PLAIN, "no store_as → plaintext in .env");
  assert.equal(existsSync(S.retainedEnvPath(home, "vw-demo")), false, "nothing on disk before the keychain save");
  plan.persist();
  const text = readFileSync(S.retainedEnvPath(home, "vw-demo"), "utf8");
  assert.equal(S.parseEnvText(text).VW_ADMIN_TOKEN, plan.env.VW_ADMIN_TOKEN);
  assert.ok(!text.includes(plan.minted.VW_ADMIN_TOKEN));
});

test("C5 — an un-persisted plan (keychain save failed) mints a NEW token on retry", () => {
  const home = scratch("h-");
  const a = S.planGeneratedEnv("vw-demo", VW, { destDir: scratch("d1-"), crowHome: home });
  const b = S.planGeneratedEnv("vw-demo", VW, { destDir: scratch("d2-"), crowHome: home });
  assert.notEqual(b.minted.VW_ADMIN_TOKEN, a.minted.VW_ADMIN_TOKEN);
});

test("reinstall after persist mints nothing: the stored hash is reused and `minted` is empty", () => {
  const home = scratch("h-");
  const first = S.planGeneratedEnv("vw-demo", VW, { destDir: scratch("d1-"), crowHome: home });
  first.persist();
  const second = S.planGeneratedEnv("vw-demo", VW, { destDir: scratch("d2-"), crowHome: home });
  assert.deepEqual(second.env, first.env);
  assert.deepEqual(second.minted, {});
});

test("an installed .env value (e.g. a typed legacy plaintext token) wins and is not re-hashed", () => {
  const dest = scratch("d-");
  writeFileSync(join(dest, ".env"), "VW_ADMIN_TOKEN=legacy-typed-token\n");
  const { env, minted } = S.planGeneratedEnv("vw-demo", VW, { destDir: dest, crowHome: scratch("h-") });
  assert.equal(env.VW_ADMIN_TOKEN, "legacy-typed-token");
  assert.equal(minted.VW_ADMIN_TOKEN, undefined);
});

test("C5 — resolveGeneratedEnv refuses keychain manifests; still works (and persists) for plain ones", () => {
  assert.throws(() => S.resolveGeneratedEnv("vw-demo", VW, { destDir: scratch("d-"), crowHome: scratch("h-") }), /planGeneratedEnv/);
  const home = scratch("h-");
  const out = S.resolveGeneratedEnv("plain", { env_vars: [{ name: "X", generate: "secret" }] }, { destDir: scratch("d-"), crowHome: home });
  assert.match(out.X, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(existsSync(S.retainedEnvPath(home, "plain")));
});

test("Q1 — keychain eligibility is opt-in; third-party secrets are not offered", () => {
  assert.deepEqual(S.keychainGeneratedKeys(VW), ["VW_ADMIN_TOKEN", "VW_PLAIN"]);
  assert.deepEqual(S.keychainEligibleKeys(VW), ["VW_ADMIN_PASSWORD"], "VW_API_KEY (third-party) is not eligible");
  assert.equal(S.expandKeychainTemplate("${VW_DOMAIN}/admin", { VW_DOMAIN: "http://h:1" }), "http://h:1/admin");
  assert.equal(S.expandKeychainTemplate("${VW_DOMAIN}/admin", { VW_DOMAIN: "" }), null, "a blank var drops the field");
  assert.equal(S.expandKeychainTemplate("${NOPE}", {}), null);
  assert.equal(S.expandKeychainTemplate("admin", {}), "admin");
  assert.equal(S.expandKeychainTemplate(undefined, {}), null);
});

test("bundle contract: store_as / keychain / generatable combinations", () => {
  const base = { id: "x", name: "x", description: "d", type: "bundle", category: "productivity", version: "1.0.0" };
  const errs = (env_vars) => validateManifest({ ...base, env_vars }, scratch("b-")).errors.join("\n");
  assert.match(errs([{ name: "A", store_as: "argon2id", generate: "secret" }]), /store_as.*keychain/);
  assert.match(errs([{ name: "A", store_as: "argon2id", keychain: true }]), /store_as.*generate/);
  assert.match(errs([{ name: "A", store_as: "bcrypt", generate: "secret", keychain: true }]), /store_as/);
  assert.match(errs([{ name: "A", keychain: true }]), /keychain.*secret/);
  assert.match(errs([{ name: "A", generatable: true, propagate: false }]), /generatable needs secret/);
  assert.match(errs([{ name: "A", generatable: true, secret: true }]), /generatable needs propagate: false/);
  assert.match(errs([{ name: "A", generatable: true, secret: true, propagate: false, generate: "secret" }]), /cannot be combined with generate/);
  assert.doesNotMatch(errs([
    { name: "A", secret: true, generate: "secret", keychain: true, store_as: "argon2id" },
    { name: "B", secret: true, generatable: true, propagate: false },
  ]), /store_as|keychain|generatable/);
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/bundle-env-keychain-generate.test.js`
Expected: FAIL with `Cannot find module '…/keychain/argon2-phc.js'`.

- [ ] **Step 3: Create `servers/gateway/keychain/argon2-phc.js`**

````js
/**
 * Argon2id PHC strings with Node 24's built-in crypto.argon2Sync (no dependency).
 *
 * Format Vaultwarden 1.32.7 parses (src/api/admin.rs _validate_token →
 * argon2::password_hash::PasswordHash::new; params are read from the string):
 *   $argon2id$v=19$m=65540,t=3,p=4$<salt>$<hash>
 * salt/hash: standard base64 WITHOUT padding (PHC). Params = Vaultwarden wiki's
 * "Bitwarden defaults" preset. ~60 ms on crow; called once per install.
 */
import { argon2Sync, randomBytes, timingSafeEqual } from "node:crypto";

export const ARGON2_PARAMS = Object.freeze({ memory: 65540, passes: 3, parallelism: 4, tagLength: 32 });

const b64 = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "");

function derive(plaintext, salt, p) {
  return argon2Sync("argon2id", {
    message: Buffer.from(String(plaintext), "utf8"),
    nonce: salt,
    memory: p.memory,
    passes: p.passes,
    parallelism: p.parallelism,
    tagLength: p.tagLength,
  });
}

export function argon2idPhc(plaintext, { salt = randomBytes(16) } = {}) {
  const p = ARGON2_PARAMS;
  const hash = derive(plaintext, salt, p);
  return `$argon2id$v=19$m=${p.memory},t=${p.passes},p=${p.parallelism}$${b64(salt)}$${b64(hash)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export function verifyArgon2idPhc(plaintext, phc) {
  const m = PHC.exec(String(phc || ""));
  if (!m) return false;
  try {
    const salt = Buffer.from(m[4], "base64");
    const want = Buffer.from(m[5], "base64");
    const got = derive(plaintext, salt, { memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]), tagLength: want.length });
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}
````

- [ ] **Step 4: Extend `bundle-env-secrets.js`, the schema and the contract**

````bash
cd ~/crow-wt-keychain && git apply <<'PATCH'
diff --git a/registry/manifest.schema.json b/registry/manifest.schema.json
index bcffb45..0cfcd65 100644
--- a/registry/manifest.schema.json
+++ b/registry/manifest.schema.json
@@ -76,6 +76,13 @@
           "required": { "type": "boolean" },
           "secret": { "type": "boolean" },
           "generate": { "type": "string", "enum": ["secret"] },
+          "keychain": { "type": "boolean" },
+          "store_as": { "type": "string", "enum": ["argon2id"] },
+          "generatable": { "type": "boolean" },
+          "path": { "type": "boolean" },
+          "keychain_label": { "type": "string" },
+          "keychain_username": { "type": "string" },
+          "keychain_url": { "type": "string" },
           "propagate": { "type": "boolean" },
           "install_required": { "type": "boolean" },
           "check": { "type": "string", "enum": ["not_breached"] },
diff --git a/scripts/lib/bundle-contract.mjs b/scripts/lib/bundle-contract.mjs
index 6d74133..e12d237 100644
--- a/scripts/lib/bundle-contract.mjs
+++ b/scripts/lib/bundle-contract.mjs
@@ -177,6 +177,23 @@ export function validateManifest(manifest, bundleDir, opts = {}) {
     }
   }
 
+  for (const v of (manifest && Array.isArray(manifest.env_vars)) ? manifest.env_vars : []) {
+    if (!v || typeof v !== "object") continue;
+    if (v.store_as !== undefined) {
+      if (v.store_as !== "argon2id") errors.push(`env_vars ${v.name}: store_as must be "argon2id"`);
+      if (v.generate !== "secret") errors.push(`env_vars ${v.name}: store_as needs generate: "secret"`);
+      if (v.keychain !== true) errors.push(`env_vars ${v.name}: store_as needs keychain: true (or the plaintext is lost)`);
+    }
+    if (v.keychain === true && v.secret !== true && v.generate !== "secret") {
+      errors.push(`env_vars ${v.name}: keychain needs secret: true or generate: "secret"`);
+    }
+    if (v.generatable === true) {
+      if (v.secret !== true) errors.push(`env_vars ${v.name}: generatable needs secret: true`);
+      if (v.generate !== undefined) errors.push(`env_vars ${v.name}: generatable is for typed fields; it cannot be combined with generate`);
+      if (v.propagate !== false) errors.push(`env_vars ${v.name}: generatable needs propagate: false (a human password must not be copied into the gateway .env)`);
+    }
+  }
+
   // 4. Dependency bundles exist (via injected resolver)
   const deps = [
     ...(manifest && manifest.requires && Array.isArray(manifest.requires.bundles) ? manifest.requires.bundles : []),
diff --git a/servers/gateway/bundle-env-secrets.js b/servers/gateway/bundle-env-secrets.js
index 48f89f5..1453b65 100644
--- a/servers/gateway/bundle-env-secrets.js
+++ b/servers/gateway/bundle-env-secrets.js
@@ -4,6 +4,13 @@
  *   env_vars[].generate: "secret"   → 32 random bytes, base64url (43 chars; no `$`,
  *                                     quotes or spaces: safe in compose .env, URLs, bash)
  *
+ *   env_vars[].keychain: true        → the minted plaintext goes to the Crow keychain BEFORE
+ *                                     anything is persisted (planGeneratedEnv → persist())
+ *   env_vars[].store_as: "argon2id"  → the .env and the retained copy hold an Argon2id PHC
+ *                                     hash of it instead (Vaultwarden ADMIN_TOKEN)
+ *   env_vars[].generatable: true     → a HUMAN password field: the forms offer Generate and
+ *                                     "Save to Crow keychain" (keychainEligibleKeys)
+ *
  * NEVER regenerated on reinstall: bundles bind-mount their data and the kept DB still
  * expects the old password. Order: installed .env → retained copy at
  * <CROW_HOME>/secrets/bundle-env/<id>.env (dir 700, file 600; uninstall never deletes
@@ -15,6 +22,7 @@ import { join, dirname, basename } from "node:path";
 import { randomBytes, createHash } from "node:crypto";
 import { parseEnvText, formatEnvLines } from "./bundle-env-codec.js";
 export { parseEnvText };
+import { argon2idPhc } from "./keychain/argon2-phc.js";
 
 const GENERATE_KINDS = new Set(["secret"]);
 
@@ -53,28 +61,88 @@ export function retainedEnvPath(crowHome, bundleId) {
   return join(crowHome, "secrets", "bundle-env", `${bundleId}.env`);
 }
 
-export function resolveGeneratedEnv(bundleId, manifest, { destDir, crowHome }) {
+export function keychainGeneratedKeys(manifest) {
+  return (manifest?.env_vars || [])
+    .filter((v) => v && typeof v.name === "string" && GENERATE_KINDS.has(v.generate) && v.keychain === true)
+    .map((v) => v.name);
+}
+
+/** Typed fields the forms may offer to save to the keychain: opt-in only (Kevin Q1). */
+export function keychainEligibleKeys(manifest) {
+  return (manifest?.env_vars || [])
+    .filter((v) => v && typeof v.name === "string" && v.secret === true && !v.generate && (v.generatable === true || v.keychain === true))
+    .map((v) => v.name);
+}
+
+/**
+ * Mint or reuse every generated secret WITHOUT persisting anything (C5). Returns
+ * { env, minted, persist }:
+ *   env      values for the bundle .env (a PHC hash for store_as:"argon2id")
+ *   minted   plaintext of keychain:true keys created by THIS call (empty on reinstall)
+ *   persist  writes the retained copy; call it only after `minted` is safely in the
+ *            keychain — otherwise a lost plaintext would leave an unusable hash behind.
+ * Order per key: installed .env → retained copy → new value (never regenerated).
+ */
+export function planGeneratedEnv(bundleId, manifest, { destDir, crowHome }) {
   const keys = generatedEnvKeys(manifest);
-  if (keys.length === 0) return {};
+  if (keys.length === 0) return { env: {}, minted: {}, persist() {} };
   if (typeof bundleId !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(bundleId) || bundleId.length > 64) {
     throw new Error(`Invalid bundle ID: ${JSON.stringify(bundleId)}`);
   }
+  const byName = new Map((manifest.env_vars || []).map((v) => [v.name, v]));
   const installed = readEnvSafe(join(destDir, ".env"));
   const retainedPath = retainedEnvPath(crowHome, bundleId);
   const retained = readEnvSafe(retainedPath);
-  const out = {};
-  for (const k of keys) out[k] = installed[k] || retained[k] || newSecretValue();
-  const dir = dirname(retainedPath);
-  mkdirSync(dir, { recursive: true, mode: 0o700 });
-  chmodSync(dir, 0o700);
-  const merged = { ...retained, ...out };
-  writePrivateFile(
-    retainedPath,
-    `# Crow-generated secrets for bundle '${bundleId}'. Kept across uninstall so a\n` +
-      `# reinstall reuses them (the bundle's data still expects them). Do not edit.\n` +
-      formatEnvLines(merged),
-  );
-  return out;
+  const env = {};
+  const minted = {};
+  for (const k of keys) {
+    const existing = installed[k] || retained[k];
+    if (existing) { env[k] = existing; continue; }
+    const plain = newSecretValue();
+    const spec = byName.get(k) || {};
+    env[k] = spec.store_as === "argon2id" ? argon2idPhc(plain) : plain;
+    if (spec.keychain === true) minted[k] = plain;
+  }
+  const persist = () => {
+    const dir = dirname(retainedPath);
+    mkdirSync(dir, { recursive: true, mode: 0o700 });
+    chmodSync(dir, 0o700);
+    writePrivateFile(
+      retainedPath,
+      `# Crow-generated secrets for bundle '${bundleId}'. Kept across uninstall so a\n` +
+        `# reinstall reuses them (the bundle's data still expects them). Do not edit.\n` +
+        formatEnvLines({ ...retained, ...env }),
+    );
+  };
+  return { env, minted, persist };
+}
+
+/**
+ * Back-compat: mint/reuse AND persist in one call. Refuses keychain:true manifests —
+ * their plaintext must reach the keychain first (planGeneratedEnv), never be dropped.
+ */
+export function resolveGeneratedEnv(bundleId, manifest, opts) {
+  if (keychainGeneratedKeys(manifest).length > 0) {
+    throw new Error("resolveGeneratedEnv cannot handle keychain:true env vars; use planGeneratedEnv and save `minted` first");
+  }
+  const plan = planGeneratedEnv(bundleId, manifest, opts);
+  plan.persist();
+  return plan.env;
+}
+
+/**
+ * `keychain_label` / `keychain_username` / `keychain_url` templates: `${VAR}` from the
+ * install env. Any referenced var that is unset or blank → null (the field is dropped).
+ */
+export function expandKeychainTemplate(template, env) {
+  if (typeof template !== "string" || template === "") return null;
+  let blank = false;
+  const out = template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
+    const v = env && env[name];
+    if (v === undefined || v === null || String(v) === "") { blank = true; return ""; }
+    return String(v);
+  });
+  return blank ? null : out;
 }
 
 export function stripGeneratedKeys(manifest, envVars) {
PATCH
git diff --stat
````

- [ ] **Step 5: Run the tests**

```bash
npm test -- tests/bundle-env-keychain-generate.test.js
npm test -- tests/bundle-env-secrets.test.js
npm test -- tests/bundle-env-scoping.test.js
npm test -- tests/bundle-lifecycle-hooks.test.js
node scripts/build-registry.mjs --check
```

Expected: all PASS / OK. `runInstallJob` still calls `resolveGeneratedEnv`, which is correct until Task 8, because no manifest uses `keychain` yet.

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/keychain/argon2-phc.js tests/bundle-env-keychain-generate.test.js
git commit servers/gateway/keychain/argon2-phc.js tests/bundle-env-keychain-generate.test.js servers/gateway/bundle-env-secrets.js registry/manifest.schema.json scripts/lib/bundle-contract.mjs -m "feat(bundles): generatable/keychain/store_as env vars — opt-in Generate, keychain-first minting, Argon2id PHC"
git show --stat HEAD
```

---

### Task 4: The keychain key, the store, Export/Import, local-only by construction

**Files:**
- Create: `servers/gateway/keychain/{key,schema,store,export}.js`, `tests/keychain-store.test.js`
- Modify: `scripts/init-db.js`, `servers/sharing/instance-sync.js`, `scripts/ops/grackle-d3-import.mjs`

**Interfaces:**
- Consumes: `sealSecret` / `openSecret` (`servers/sharing/secret-box.js`), called with `{ seed: key.seed }`.
- Produces:
  - `key.js`:
    - `keychainKeyPath(crowHome?): string`
    - `keychainKeyState({ crowHome? }) → { state: "ok"|"missing"|"invalid", path, key }`
    - `loadKeychainKey({ crowHome? }): { id, seed } | null` (read-only, never creates)
    - `createKeychainKey({ crowHome?, replaceInvalid? }) → key` (crash-atomic; throws `KeychainKeyInvalidError` (`code: "KEYCHAIN_KEY_INVALID"`, `.path`) for a damaged file unless `replaceInvalid`)
  - `store.js` (all `async`):
    - `ensureKeychainTable(db)`
    - `countEntries(db) → number`
    - `ensureWriteKey(db, { crowHome?, onNewKey?({ orphaned }) }) → key`: missing → create; invalid → replace only when the table is empty, else throw `KeychainKeyInvalidError`; calls `onNewKey` when created while rows exist
    - `saveExtensionSecret(db, key, { bundleId, envKey, label, username?, url?, secret, origin: "typed"|"generated", firstView?, now? }) → { id, created }`
    - `addManualSecret(db, key, { label, username?, url?, secret }) → { id }`
    - `listEntries(db, { now?, keyId? }) → Entry[]`, where `Entry = { id, kind, label, bundle_id, env_key, username, url, origin, status, created_at, updated_at, readable, first_view_pending }`
    - `getEntry(db, id, { keyId? })`
    - `pendingFirstViews(db, { now?, keyId? })` (readable only)
    - `openEntrySecret(db, key, id)` (throws `KeychainKeyMissingError`, `code: "KEYCHAIN_KEY_MISSING"`)
    - `consumeFirstView(db, key, id, { now? })`
    - `deleteEntry`, `markBundleRemoved`, `reactivateBundleEntries`
    - `exportableEntries(db, key)`
    - `importEntries(db, key, entries) → { imported, skipped }`
    - `FIRST_VIEW_MS`, `KeychainKeyMissingError`
  - `export.js`:
    - `async sealExport(entries, passphrase) → file`
    - `async openExport(file, passphrase) → entries | null` (only v1 KDF constants; salt/nonce/tag lengths checked; 4 MiB cap)
    - `MIN_PASSPHRASE = 12`, `EXPORT_FORMAT`, `KDF_V1`
  - `instance-sync.js`: `LOCAL_ONLY_TABLES`, `assertLocalOnlyDisjoint(synced, localOnly)`.
  - `grackle-d3-import.mjs`: `SKIP_REASONS.crow_keychain`.

- [ ] **Step 1: Write the failing test** — create `tests/keychain-store.test.js`:

````js
/** Crow keychain store + its own key + export file (Task 3). Scratch DB/home; never touches ~/.crow. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-kc-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const { createDbClient } = await import("../servers/db.js");
const K = await import("../servers/gateway/keychain/store.js");
const KEY = await import("../servers/gateway/keychain/key.js");
const X = await import("../servers/gateway/keychain/export.js");
const SYNC = await import("../servers/sharing/instance-sync.js");
const { emitOrQueue } = await import("../servers/shared/sync-emit.js");
const D3 = await import("../scripts/ops/grackle-d3-import.mjs");

const home = () => mkdtempSync(join(tmpdir(), "crow-kc-home-"));
const freshDb = () => createDbClient(join(mkdtempSync(join(tmpdir(), "crow-kc-db-")), "crow.db"));
const mode = (p) => statSync(p).mode & 0o777;

test("C7 — the keychain key is its own random file: 600 in a 700 dir, created only on demand", () => {
  const h = home();
  assert.equal(KEY.loadKeychainKey({ crowHome: h }), null, "no key until something is saved");
  assert.equal(KEY.keychainKeyState({ crowHome: h }).state, "missing");
  const k = KEY.createKeychainKey({ crowHome: h });
  assert.equal(k.seed.length, 32);
  assert.match(k.id, /^[0-9a-f]{16}$/);
  const p = KEY.keychainKeyPath(h);
  assert.equal(p, join(h, "secrets", "keychain.key"));
  assert.equal(mode(p), 0o600);
  assert.equal(mode(join(h, "secrets")), 0o700);
  assert.deepEqual(KEY.createKeychainKey({ crowHome: h }), k, "a second create reuses the file");
  assert.deepEqual(readdirSync(join(h, "secrets")), ["keychain.key"], "m1: no temp file left behind");
});

test("m1 — an empty/damaged key is replaced only while the table is empty; otherwise a clear refusal", async () => {
  const h = home();
  const db = freshDb();
  const k = KEY.createKeychainKey({ crowHome: h });
  await K.addManualSecret(db, k, { label: "Phone", secret: "app-pass" });
  writeFileSync(KEY.keychainKeyPath(h), "");
  assert.equal(KEY.keychainKeyState({ crowHome: h }).state, "invalid");
  assert.throws(() => KEY.createKeychainKey({ crowHome: h }), (e) => e.code === "KEYCHAIN_KEY_INVALID" && e.message.includes(KEY.keychainKeyPath(h)));
  await assert.rejects(K.ensureWriteKey(db, { crowHome: h }), (e) => e.code === "KEYCHAIN_KEY_INVALID", "rows exist → refuse, never silently re-key");
  assert.equal(readFileSync(KEY.keychainKeyPath(h), "utf8"), "", "the damaged file is left for the user to restore");

  const h2 = home();
  const db2 = freshDb();
  KEY.createKeychainKey({ crowHome: h2 });
  writeFileSync(KEY.keychainKeyPath(h2), "{\"v\":1,\"id\":\"short\"}");
  const fresh = await K.ensureWriteKey(db2, { crowHome: h2 });
  assert.equal(fresh.seed.length, 32, "empty table → replaced");
  assert.ok(readdirSync(join(h2, "secrets")).some((n) => n.startsWith("keychain.key.invalid-")), "the damaged file is moved aside, never deleted");
});

test("m2 — a new key created while rows exist (old key lost) is reported through onNewKey", async () => {
  const db = freshDb();
  const lost = KEY.createKeychainKey({ crowHome: home() });
  await K.addManualSecret(db, lost, { label: "Old", secret: "x" });
  const seen = [];
  const k = await K.ensureWriteKey(db, { crowHome: home(), onNewKey: (info) => seen.push(info) });
  assert.ok(k);
  assert.deepEqual(seen, [{ orphaned: 1 }]);
});

test("C7 — no backup path can carry the key: it lives outside the data dir and no backup code names it", () => {
  const h = home();
  assert.ok(!KEY.keychainKeyPath(h).startsWith(process.env.CROW_DATA_DIR), "crow.db copies never include it");
  for (const f of ["servers/gateway/routes/admin-backup.js", "servers/sharing/identity.js", "bundles/workspace/ops/backup.sh"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /keychain\.key|secrets\/keychain/, `${f} must never copy the keychain key`);
  }
});

test("save → list carries metadata only; open returns the plaintext; the column holds ciphertext", async () => {
  const db = freshDb();
  const key = KEY.createKeychainKey({ crowHome: home() });
  const { id, created } = await K.saveExtensionSecret(db, key, { bundleId: "workspace", envKey: "WORKSPACE_ADMIN_PASSWORD", label: "Crow Workspace — admin password", username: "admin", url: null, secret: "p a$s'w\"d", origin: "typed", firstView: false });
  assert.equal(created, true);
  const [e] = await K.listEntries(db, { keyId: key.id });
  assert.equal(e.id, id);
  assert.equal(e.readable, true);
  assert.equal(e.status, "active");
  assert.ok(!JSON.stringify(e).includes("p a$s"), "list never carries the secret");
  assert.equal(await K.openEntrySecret(db, key, id), "p a$s'w\"d");
  const raw = (await db.execute({ sql: "SELECT secret_sealed FROM crow_keychain WHERE id = ?", args: [id] })).rows[0].secret_sealed;
  assert.match(raw, /^enc:v1:/);
});

test("C7 — restored without the key: entries list as unreadable, open/first-view throw KEYCHAIN_KEY_MISSING, never crash", async () => {
  const db = freshDb();
  const oldKey = KEY.createKeychainKey({ crowHome: home() });
  const { id } = await K.saveExtensionSecret(db, oldKey, { bundleId: "vaultwarden", envKey: "VAULTWARDEN_ADMIN_TOKEN", label: "L", secret: "tok", origin: "generated", firstView: true });
  const newKey = KEY.createKeychainKey({ crowHome: home() });
  const [e] = await K.listEntries(db, { keyId: newKey.id });
  assert.equal(e.readable, false);
  assert.equal((await K.listEntries(db, { keyId: null }))[0].readable, false, "no key at all → unreadable too");
  await assert.rejects(K.openEntrySecret(db, newKey, id), (err) => err.code === "KEYCHAIN_KEY_MISSING");
  await assert.rejects(K.openEntrySecret(db, null, id), (err) => err.code === "KEYCHAIN_KEY_MISSING");
  await assert.rejects(K.consumeFirstView(db, newKey, id), (err) => err.code === "KEYCHAIN_KEY_MISSING");
  assert.deepEqual(await K.pendingFirstViews(db, { keyId: newKey.id }), [], "no banner for an unreadable token");
  assert.equal(await K.deleteEntry(db, id), true, "an unreadable entry can still be deleted");
});

test("a second save for the same bundle+key updates in place (no duplicates)", async () => {
  const db = freshDb();
  const key = KEY.createKeychainKey({ crowHome: home() });
  const a = await K.saveExtensionSecret(db, key, { bundleId: "b", envKey: "K", label: "L", secret: "one", origin: "typed" });
  const b = await K.saveExtensionSecret(db, key, { bundleId: "b", envKey: "K", label: "L2", secret: "two", origin: "typed" });
  assert.equal(b.id, a.id);
  assert.equal(b.created, false);
  assert.equal((await K.listEntries(db)).length, 1);
  assert.equal(await K.openEntrySecret(db, key, a.id), "two");
  await assert.rejects(K.saveExtensionSecret(db, key, { bundleId: "b", envKey: "K", label: "L", secret: "x", origin: "bogus" }), /origin/);
});

test("manual entries; delete; uninstall marks extension entries and a later save reactivates them", async () => {
  const db = freshDb();
  const key = KEY.createKeychainKey({ crowHome: home() });
  const m = await K.addManualSecret(db, key, { label: "Phone app password", username: "kevin", url: "https://ws.example:8456", secret: "abcd-efgh" });
  const x = await K.saveExtensionSecret(db, key, { bundleId: "vaultwarden", envKey: "VAULTWARDEN_ADMIN_TOKEN", label: "Vaultwarden — admin token", secret: "t", origin: "generated" });
  assert.equal(await K.markBundleRemoved(db, "vaultwarden"), 1);
  assert.equal((await K.getEntry(db, x.id)).status, "extension_removed");
  assert.equal((await K.getEntry(db, m.id)).status, "active", "manual entries are never touched by uninstall");
  assert.equal(await K.reactivateBundleEntries(db, "vaultwarden", ["VAULTWARDEN_ADMIN_TOKEN"]), 1);
  assert.equal((await K.getEntry(db, x.id)).status, "active");
  assert.equal(await K.deleteEntry(db, m.id), true);
  assert.equal(await K.deleteEntry(db, m.id), false);
  assert.equal(await K.getEntry(db, m.id), null);
});

test("REVIEW FOCUS 2 — first view is single-use and expires", async () => {
  const db = freshDb();
  const key = KEY.createKeychainKey({ crowHome: home() });
  const t0 = new Date("2026-10-03T12:00:00Z");
  const { id } = await K.saveExtensionSecret(db, key, { bundleId: "vaultwarden", envKey: "VAULTWARDEN_ADMIN_TOKEN", label: "L", secret: "tok", origin: "generated", firstView: true, now: t0 });
  assert.equal((await K.pendingFirstViews(db, { now: t0, keyId: key.id })).length, 1);
  assert.equal(await K.consumeFirstView(db, key, id, { now: new Date(t0.getTime() + 60_000) }), "tok");
  assert.equal(await K.consumeFirstView(db, key, id, { now: new Date(t0.getTime() + 61_000) }), null, "second look refused");
  const late = await K.saveExtensionSecret(db, key, { bundleId: "x", envKey: "Y", label: "L", secret: "tok2", origin: "generated", firstView: true, now: t0 });
  assert.equal(await K.consumeFirstView(db, key, late.id, { now: new Date(t0.getTime() + K.FIRST_VIEW_MS + 1) }), null, "expired after 30 min");
});

test("Export → Import round-trips through a passphrase file; wrong passphrase opens nothing; readable entries are never overwritten", async () => {
  const db = freshDb();
  const key = KEY.createKeychainKey({ crowHome: home() });
  await K.saveExtensionSecret(db, key, { bundleId: "workspace", envKey: "WORKSPACE_ADMIN_PASSWORD", label: "WS admin", username: "admin", secret: "ws-pass 1", origin: "typed" });
  await K.addManualSecret(db, key, { label: "Phone", username: "kevin", secret: "app-pass" });
  const entries = await K.exportableEntries(db, key);
  assert.equal(entries.length, 2);
  const file = await X.sealExport(entries, "correct horse battery");
  assert.equal(file.format, "crow-keychain-export");
  assert.ok(!JSON.stringify(file).includes("ws-pass") && !JSON.stringify(file).includes("WS admin"), "nothing readable in the file");
  assert.equal(await X.openExport(file, "wrong passphrase!!"), null);
  await assert.rejects(X.sealExport(entries, "short"), /at least 12/);

  // New machine: fresh DB + new key, the old crow.db rows restored (unreadable there).
  const db2 = freshDb();
  const key2 = KEY.createKeychainKey({ crowHome: home() });
  await K.saveExtensionSecret(db2, key, { bundleId: "workspace", envKey: "WORKSPACE_ADMIN_PASSWORD", label: "WS admin", secret: "stale", origin: "typed" });
  const out = await K.importEntries(db2, key2, await X.openExport(file, "correct horse battery"));
  assert.deepEqual(out, { imported: 2, skipped: 0 }, "the unreadable restored row is replaced");
  const list = await K.listEntries(db2, { keyId: key2.id });
  assert.ok(list.every((e) => e.readable));
  const ws = list.find((e) => e.env_key === "WORKSPACE_ADMIN_PASSWORD");
  assert.equal(await K.openEntrySecret(db2, key2, ws.id), "ws-pass 1");
  assert.deepEqual(await K.importEntries(db2, key2, await X.openExport(file, "correct horse battery")), { imported: 0, skipped: 2 }, "re-import overwrites nothing");
});

test("init-db creates crow_keychain with the same columns as the store's lazy ensure (no CHECK constraints)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-kc-initdb-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe" });
  const a = new Database(join(dir, "crow.db"), { readonly: true });
  const fromInit = a.prepare("PRAGMA table_info(crow_keychain)").all().map((c) => c.name);
  const ddl = a.prepare("SELECT sql FROM sqlite_master WHERE name = 'crow_keychain'").get().sql;
  a.close();
  const db = freshDb();
  await K.ensureKeychainTable(db);
  const fromLazy = (await db.execute("PRAGMA table_info(crow_keychain)")).rows.map((c) => c.name);
  assert.deepEqual(fromInit, fromLazy);
  assert.ok(fromInit.includes("key_id") && fromInit.includes("first_view_until"));
  assert.doesNotMatch(ddl, /CHECK/);
});

test("REVIEW FOCUS 3 — crow_keychain can never replicate (and the grackle D3 importer skips it)", async () => {
  assert.ok(SYNC.LOCAL_ONLY_TABLES.includes("crow_keychain"));
  assert.ok(!SYNC.SYNCED_TABLES.includes("crow_keychain"));
  assert.throws(() => SYNC.assertLocalOnlyDisjoint(["memories", "crow_keychain"], SYNC.LOCAL_ONLY_TABLES), /local-only/);
  assert.equal(SYNC.shouldSyncRowForTest("crow_keychain", { id: 1 }), false);
  const row = { id: 1, secret_sealed: "enc:v1:x" };
  assert.equal(await SYNC.InstanceSyncManager.prototype.emitChange.call({ feedsDisabled: false }, "crow_keychain", "insert", row), null);
  const db = freshDb();
  assert.equal(await emitOrQueue(null, db, "crow_keychain", "insert", row), null);
  assert.equal((await db.execute("SELECT name FROM sqlite_master WHERE name = 'sync_outbox'")).rows.length, 0, "nothing was even queued");
  const writes = [];
  const fakeThis = { db: { execute: async (q) => { writes.push(q); return { rows: [] }; } } };
  await SYNC.InstanceSyncManager.prototype._applyEntry.call(fakeThis, "peer", { table: "crow_keychain", op: "insert", row, lamport_ts: 1, instance_id: "peer" });
  assert.equal(writes.length, 0);
  assert.match(D3.SKIP_REASONS.crow_keychain, /Export/);
  const offenders = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (n === "node_modules") continue; if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".js") && /emit(OrQueue|Change)\([^)]*crow_keychain/.test(readFileSync(p, "utf8"))) offenders.push(p); } };
  walk("servers");
  assert.deepEqual(offenders, []);
});

test("B2 — a crafted export is refused fast: only the v1 KDF constants and exact salt/nonce/tag lengths", async () => {
  const db = freshDb();
  const key = KEY.createKeychainKey({ crowHome: home() });
  await K.addManualSecret(db, key, { label: "Phone", secret: "app-pass" });
  const good = await X.sealExport(await K.exportableEntries(db, key), "correct horse battery");
  const variants = [
    { ...good, kdf: { ...good.kdf, memory: 2097152 } },
    { ...good, kdf: { ...good.kdf, passes: 2097152 } },
    { ...good, kdf: { ...good.kdf, parallelism: 64 } },
    { ...good, kdf: { ...good.kdf, salt: Buffer.alloc(8).toString("base64") } },
    { ...good, nonce: Buffer.alloc(16).toString("base64") },
    { ...good, tag: Buffer.alloc(4).toString("base64") },
    { ...good, version: 2 },
    { ...good, ciphertext: "x".repeat(5 * 1024 * 1024) },
  ];
  const t0 = Date.now();
  for (const v of variants) assert.equal(await X.openExport(v, "correct horse battery"), null);
  assert.ok(Date.now() - t0 < 1000, "refused before any key derivation");
  assert.equal((await X.openExport(good, "correct horse battery")).length, 1, "the genuine file still opens");
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/keychain-store.test.js`
Expected: FAIL with `Cannot find module '…/keychain/store.js'`.

- [ ] **Step 3: Create the four modules**

`servers/gateway/keychain/key.js`:

````js
/**
 * The Crow keychain's OWN key (Kevin, 2026-10-03, review C7): 32 random bytes in
 * <CROW_HOME>/secrets/keychain.key (dir 700, file 600). It is NOT the identity seed, so
 * nothing that copies identity.json or crow.db (product /api/admin/backup + Nest "Run
 * backup now", onboarding identity export, r4-backup.sh, crow-db-backup.sh, instance sync)
 * can make keychain ciphertext readable elsewhere. The only way entries leave the machine is
 * the user's own passphrase-encrypted Export (keychain/export.js). Container deployments
 * must keep CROW_HOME on a volume, or every recreate loses the key (spec §6).
 *
 * States (keychainKeyState): "ok" | "missing" | "invalid" (present but empty/short/corrupt).
 * Creation is crash-atomic (re-review m1): a 600 temp file is written and fsync'd, then
 * hard-linked to the final name (link never overwrites; EEXIST = another writer won, use
 * theirs), then the temp is removed — a crash can leave only a stray temp, never an empty
 * keychain.key. An INVALID file is replaced only when the keychain table is empty (the
 * caller decides, store.ensureWriteKey) and is then moved aside, never deleted.
 */
import { existsSync, readFileSync, mkdirSync, chmodSync, openSync, writeSync, fsyncSync, closeSync, linkSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";

export class KeychainKeyInvalidError extends Error {
  constructor(path) {
    super(`The keychain key file ${path} is unreadable (empty or damaged) and saved passwords depend on it. Restore it from where you keep it, or delete the saved passwords first, then try again.`);
    this.code = "KEYCHAIN_KEY_INVALID";
    this.path = path;
  }
}

export function keychainKeyPath(crowHome = process.env.CROW_HOME || join(homedir(), ".crow")) {
  return join(crowHome, "secrets", "keychain.key");
}

export function keychainKeyState({ crowHome } = {}) {
  const path = keychainKeyPath(crowHome);
  if (!existsSync(path)) return { state: "missing", path, key: null };
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const seed = Buffer.from(String(j.key || ""), "base64");
    if (j.v !== 1 || typeof j.id !== "string" || !/^[0-9a-f]{16}$/.test(j.id) || seed.length !== 32) return { state: "invalid", path, key: null };
    return { state: "ok", path, key: { id: j.id, seed } };
  } catch {
    return { state: "invalid", path, key: null };
  }
}

/** Read-only: `{ id, seed }`, or null when the key file is missing or invalid. Never creates. */
export function loadKeychainKey({ crowHome } = {}) {
  return keychainKeyState({ crowHome }).key;
}

/**
 * Create the key if it is missing (or, with replaceInvalid, if it is invalid). Returns the
 * key that is on disk afterwards. Throws KeychainKeyInvalidError for an invalid file unless
 * replaceInvalid is set.
 */
export function createKeychainKey({ crowHome, replaceInvalid = false } = {}) {
  const st = keychainKeyState({ crowHome });
  if (st.state === "ok") return st.key;
  if (st.state === "invalid") {
    if (!replaceInvalid) throw new KeychainKeyInvalidError(st.path);
    renameSync(st.path, `${st.path}.invalid-${Date.now()}`);
  }
  const dir = dirname(st.path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const seed = randomBytes(32);
  const id = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  const tmp = `${st.path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify({ v: 1, id, key: seed.toString("base64") }) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, st.path);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
  try { const dfd = openSync(dir, "r"); fsyncSync(dfd); closeSync(dfd); } catch { /* best effort */ }
  const after = keychainKeyState({ crowHome });
  if (after.state !== "ok") throw new KeychainKeyInvalidError(after.path);
  return after.key;
}
````

`servers/gateway/keychain/schema.js`:

````js
/**
 * crow_keychain DDL — side-effect free; imported by scripts/init-db.js (fresh installs)
 * and by keychain/store.js ensureKeychainTable (existing installs). Additive: no
 * SCHEMA_GENERATION bump. LOCAL-ONLY: listed in instance-sync LOCAL_ONLY_TABLES.
 * No CHECK constraints (review S8): enum values are validated in store.js, so a new
 * value never needs a table rebuild.
 */
export const KEYCHAIN_DDL = `
  CREATE TABLE IF NOT EXISTS crow_keychain (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    kind             TEXT NOT NULL,
    label            TEXT NOT NULL,
    bundle_id        TEXT,
    env_key          TEXT,
    username         TEXT,
    url              TEXT,
    secret_sealed    TEXT NOT NULL,
    key_id           TEXT NOT NULL,
    origin           TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'active',
    first_view_until TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_crow_keychain_ext
    ON crow_keychain (bundle_id, env_key) WHERE kind = 'extension';
`;
````

`servers/gateway/keychain/store.js`:

````js
/**
 * Crow keychain — human-facing passwords, sealed with secret-box under the keychain's OWN
 * key (keychain/key.js), LOCAL ONLY (instance-sync LOCAL_ONLY_TABLES). Secrets leave this
 * module only through openEntrySecret / consumeFirstView / exportableEntries, whose callers
 * gate and audit them. Rows sealed under another key (a crow.db restored onto a machine
 * without the key file) are listed as readable:false and throw KeychainKeyMissingError on
 * open — never a crash, never a wrong plaintext.
 */
import { sealSecret, openSecret } from "../../sharing/secret-box.js";
import { KEYCHAIN_DDL } from "./schema.js";
import { keychainKeyState, createKeychainKey, KeychainKeyInvalidError } from "./key.js";

export const KEYCHAIN_TABLE = "crow_keychain";
export const FIRST_VIEW_MS = 30 * 60 * 1000;
const KINDS = new Set(["extension", "manual"]);
const ORIGINS = new Set(["typed", "generated", "manual"]);

export class KeychainKeyMissingError extends Error {
  constructor() {
    super("The keychain key for this password is not on this machine.");
    this.code = "KEYCHAIN_KEY_MISSING";
  }
}

const META_COLS = "id, kind, label, bundle_id, env_key, username, url, origin, status, key_id, created_at, updated_at, first_view_until";
const iso = (d) => (d instanceof Date ? d : new Date()).toISOString();
const cleanText = (v, max = 512) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).slice(0, max));
const box = (key) => ({ seed: key.seed });

function requireKey(key) {
  if (!key || typeof key.id !== "string" || !Buffer.isBuffer(key.seed)) throw new KeychainKeyMissingError();
}

const ensured = new WeakSet();
export async function ensureKeychainTable(db) {
  if (ensured.has(db)) return;
  await db.executeMultiple(KEYCHAIN_DDL);
  ensured.add(db);
}

function toEntry(r, { now, keyId } = {}) {
  if (!r) return null;
  const { first_view_until: fvu, key_id: kid, ...rest } = r;
  return { ...rest, id: Number(r.id), readable: !!keyId && kid === keyId, first_view_pending: !!fvu && fvu > iso(now) };
}

export async function countEntries(db) {
  await ensureKeychainTable(db);
  return Number((await db.execute("SELECT COUNT(*) AS n FROM crow_keychain")).rows[0].n);
}

/**
 * The key to SAVE with (re-review m1/m2). Missing → created. Invalid (empty/damaged file) →
 * replaced only while the table is empty; otherwise KeychainKeyInvalidError, because those
 * rows may still be recoverable by restoring the file. When a key is created while rows
 * already exist (the old key was lost), onNewKey({ orphaned }) lets the caller audit it and
 * tell the user those entries need an Import.
 */
export async function ensureWriteKey(db, { crowHome, onNewKey } = {}) {
  const st = keychainKeyState({ crowHome });
  if (st.state === "ok") return st.key;
  const n = await countEntries(db);
  if (st.state === "invalid" && n > 0) throw new KeychainKeyInvalidError(st.path);
  const key = createKeychainKey({ crowHome, replaceInvalid: st.state === "invalid" });
  if (n > 0 && typeof onNewKey === "function") {
    try { await onNewKey({ orphaned: n }); } catch { /* reporting must never block a save */ }
  }
  return key;
}

export async function saveExtensionSecret(db, key, { bundleId, envKey, label, username = null, url = null, secret, origin, firstView = false, now }) {
  await ensureKeychainTable(db);
  requireKey(key);
  if (!bundleId || !envKey || typeof secret !== "string" || secret === "") throw new Error("keychain: bundleId, envKey and a secret are required");
  if (!ORIGINS.has(origin) || origin === "manual") throw new Error("keychain: origin must be typed or generated");
  const sealed = sealSecret(secret, box(key));
  const ts = iso(now);
  const fvu = firstView ? new Date((now || new Date()).getTime() + FIRST_VIEW_MS).toISOString() : null;
  const existing = (await db.execute({ sql: "SELECT id FROM crow_keychain WHERE kind = 'extension' AND bundle_id = ? AND env_key = ?", args: [bundleId, envKey] })).rows[0];
  if (existing) {
    await db.execute({
      sql: "UPDATE crow_keychain SET label = ?, username = ?, url = ?, secret_sealed = ?, key_id = ?, origin = ?, status = 'active', first_view_until = ?, updated_at = ? WHERE id = ?",
      args: [cleanText(label) || envKey, cleanText(username), cleanText(url, 2048), sealed, key.id, origin, fvu, ts, existing.id],
    });
    return { id: Number(existing.id), created: false };
  }
  const r = await db.execute({
    sql: "INSERT INTO crow_keychain (kind, label, bundle_id, env_key, username, url, secret_sealed, key_id, origin, first_view_until, created_at, updated_at) VALUES ('extension', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [cleanText(label) || envKey, bundleId, envKey, cleanText(username), cleanText(url, 2048), sealed, key.id, origin, fvu, ts, ts],
  });
  return { id: Number(r.lastInsertRowid), created: true };
}

export async function addManualSecret(db, key, { label, username = null, url = null, secret }) {
  await ensureKeychainTable(db);
  requireKey(key);
  if (!cleanText(label) || typeof secret !== "string" || secret === "") throw new Error("keychain: a label and a secret are required");
  const ts = iso();
  const r = await db.execute({
    sql: "INSERT INTO crow_keychain (kind, label, username, url, secret_sealed, key_id, origin, created_at, updated_at) VALUES ('manual', ?, ?, ?, ?, ?, 'manual', ?, ?)",
    args: [cleanText(label), cleanText(username), cleanText(url, 2048), sealSecret(secret, box(key)), key.id, ts, ts],
  });
  return { id: Number(r.lastInsertRowid) };
}

export async function listEntries(db, { now, keyId = null } = {}) {
  await ensureKeychainTable(db);
  const { rows } = await db.execute(`SELECT ${META_COLS} FROM crow_keychain ORDER BY status ASC, label COLLATE NOCASE ASC, id ASC`);
  return rows.map((r) => toEntry(r, { now, keyId }));
}

export async function getEntry(db, id, { now, keyId = null } = {}) {
  await ensureKeychainTable(db);
  const { rows } = await db.execute({ sql: `SELECT ${META_COLS} FROM crow_keychain WHERE id = ?`, args: [Number(id)] });
  return toEntry(rows[0], { now, keyId });
}

export async function pendingFirstViews(db, { now, keyId = null } = {}) {
  await ensureKeychainTable(db);
  const { rows } = await db.execute({ sql: `SELECT ${META_COLS} FROM crow_keychain WHERE first_view_until IS NOT NULL AND first_view_until > ? ORDER BY id`, args: [iso(now)] });
  return rows.map((r) => toEntry(r, { now, keyId })).filter((e) => e.readable);
}

async function sealedRow(db, id) {
  const { rows } = await db.execute({ sql: "SELECT secret_sealed, key_id FROM crow_keychain WHERE id = ?", args: [Number(id)] });
  return rows[0] || null;
}

/** Plaintext; null when the id does not exist; KeychainKeyMissingError when sealed under another key. */
export async function openEntrySecret(db, key, id) {
  await ensureKeychainTable(db);
  const row = await sealedRow(db, id);
  if (!row) return null;
  if (!key || row.key_id !== key.id) throw new KeychainKeyMissingError();
  return openSecret(row.secret_sealed, box(key));
}

/** Atomically spends a live first-view grant. Plaintext once, then null forever. */
export async function consumeFirstView(db, key, id, { now } = {}) {
  await ensureKeychainTable(db);
  const row = await sealedRow(db, id);
  if (row && (!key || row.key_id !== key.id)) throw new KeychainKeyMissingError();
  const { rows } = await db.execute({
    sql: "UPDATE crow_keychain SET first_view_until = NULL WHERE id = ? AND first_view_until IS NOT NULL AND first_view_until > ? RETURNING secret_sealed",
    args: [Number(id), iso(now)],
  });
  if (!rows[0]) return null;
  return openSecret(rows[0].secret_sealed, box(key));
}

export async function deleteEntry(db, id) {
  await ensureKeychainTable(db);
  const r = await db.execute({ sql: "DELETE FROM crow_keychain WHERE id = ?", args: [Number(id)] });
  return r.rowsAffected > 0;
}

export async function markBundleRemoved(db, bundleId) {
  await ensureKeychainTable(db);
  const r = await db.execute({ sql: "UPDATE crow_keychain SET status = 'extension_removed', first_view_until = NULL, updated_at = ? WHERE kind = 'extension' AND bundle_id = ? AND status = 'active'", args: [iso(), bundleId] });
  return r.rowsAffected;
}

export async function reactivateBundleEntries(db, bundleId, envKeys) {
  await ensureKeychainTable(db);
  let n = 0;
  for (const k of envKeys || []) {
    const r = await db.execute({ sql: "UPDATE crow_keychain SET status = 'active', updated_at = ? WHERE kind = 'extension' AND bundle_id = ? AND env_key = ? AND status = 'extension_removed'", args: [iso(), bundleId, k] });
    n += r.rowsAffected;
  }
  return n;
}

/** Every READABLE entry with its plaintext, for the user's passphrase-encrypted Export. */
export async function exportableEntries(db, key) {
  requireKey(key);
  const out = [];
  for (const e of await listEntries(db, { keyId: key.id })) {
    if (!e.readable) continue;
    out.push({ kind: e.kind, label: e.label, bundle_id: e.bundle_id, env_key: e.env_key, username: e.username, url: e.url, origin: e.origin, status: e.status, secret: await openEntrySecret(db, key, e.id) });
  }
  return out;
}

/**
 * Import entries from a decrypted Export. Never overwrites a READABLE entry: an extension
 * entry whose bundle+key already has a readable row is skipped, and so is a manual entry
 * with the same label+username+url as a readable one. Unreadable rows (old key) for the
 * same bundle+key ARE replaced — that is the "restored on a new machine" recovery path.
 */
export async function importEntries(db, key, entries) {
  requireKey(key);
  const current = await listEntries(db, { keyId: key.id });
  let imported = 0;
  let skipped = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.secret !== "string" || e.secret === "" || !KINDS.has(e.kind) || !cleanText(e.label)) { skipped++; continue; }
    if (e.kind === "extension") {
      if (!e.bundle_id || !e.env_key) { skipped++; continue; }
      if (current.some((c) => c.kind === "extension" && c.bundle_id === e.bundle_id && c.env_key === e.env_key && c.readable)) { skipped++; continue; }
      const origin = e.origin === "generated" ? "generated" : "typed";
      const { id } = await saveExtensionSecret(db, key, { bundleId: e.bundle_id, envKey: e.env_key, label: e.label, username: e.username, url: e.url, secret: e.secret, origin });
      if (e.status === "extension_removed") await db.execute({ sql: "UPDATE crow_keychain SET status = 'extension_removed' WHERE id = ?", args: [id] });
      imported++;
    } else {
      const dup = current.some((c) => c.kind === "manual" && c.readable && c.label === cleanText(e.label) && (c.username || null) === cleanText(e.username) && (c.url || null) === cleanText(e.url, 2048));
      if (dup) { skipped++; continue; }
      await addManualSecret(db, key, { label: e.label, username: e.username, url: e.url, secret: e.secret });
      imported++;
    }
  }
  return { imported, skipped };
}
````

`servers/gateway/keychain/export.js`:

````js
/**
 * Passphrase-encrypted keychain Export / Import (Kevin, 2026-10-03): the ONLY way keychain
 * entries leave the machine, and only on the user's explicit, re-authenticated request.
 * KDF: Argon2id (Node 24 crypto.argon2, ASYNC — off the event loop) over the passphrase
 * with a random 16-byte salt → 32-byte key. Cipher: AES-256-GCM, 12-byte nonce, 16-byte tag.
 *
 * Import trusts NOTHING in the file (re-review B2): only the exact v1 KDF constants are
 * accepted (a crafted file cannot ask for gigabytes of memory or hours of passes), and the
 * salt / nonce / tag lengths are checked before any work is done.
 */
import { argon2, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { promisify } from "node:util";

const argon2Async = promisify(argon2);

export const EXPORT_FORMAT = "crow-keychain-export";
export const KDF_V1 = Object.freeze({ alg: "argon2id", memory: 65536, passes: 3, parallelism: 4 });
export const MIN_PASSPHRASE = 12;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const MAX_CIPHERTEXT_B64 = 4 * 1024 * 1024;

function deriveKey(passphrase, salt) {
  return argon2Async("argon2id", {
    message: Buffer.from(String(passphrase), "utf8"),
    nonce: salt,
    memory: KDF_V1.memory,
    passes: KDF_V1.passes,
    parallelism: KDF_V1.parallelism,
    tagLength: 32,
  });
}

export async function sealExport(entries, passphrase, { now = new Date() } = {}) {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_LEN });
  const ct = Buffer.concat([cipher.update(JSON.stringify({ entries }), "utf8"), cipher.final()]);
  return {
    format: EXPORT_FORMAT, version: 1, created_at: now.toISOString(), count: entries.length,
    kdf: { ...KDF_V1, salt: salt.toString("base64") },
    cipher: "aes-256-gcm", nonce: nonce.toString("base64"),
    ciphertext: ct.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
  };
}

const b64 = (v, len) => {
  if (typeof v !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
  const buf = Buffer.from(v, "base64");
  return len === undefined || buf.length === len ? buf : null;
};

/** The entries array, or null when the passphrase is wrong or the file is not a v1 export. */
export async function openExport(file, passphrase) {
  try {
    if (!file || typeof file !== "object" || file.format !== EXPORT_FORMAT || file.version !== 1 || file.cipher !== "aes-256-gcm") return null;
    const k = file.kdf || {};
    if (k.alg !== KDF_V1.alg || k.memory !== KDF_V1.memory || k.passes !== KDF_V1.passes || k.parallelism !== KDF_V1.parallelism) return null;
    const salt = b64(k.salt, SALT_LEN);
    const nonce = b64(file.nonce, NONCE_LEN);
    const tag = b64(file.tag, TAG_LEN);
    if (!salt || !nonce || !tag || typeof file.ciphertext !== "string" || file.ciphertext.length > MAX_CIPHERTEXT_B64) return null;
    const ct = b64(file.ciphertext);
    if (!ct) return null;
    if (typeof passphrase !== "string" || passphrase === "") return null;
    const key = await deriveKey(passphrase, salt);
    const d = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_LEN });
    d.setAuthTag(tag);
    const pt = Buffer.concat([d.update(ct), d.final()]).toString("utf8");
    const parsed = JSON.parse(pt);
    return Array.isArray(parsed.entries) ? parsed.entries : null;
  } catch {
    return null;
  }
}
````

- [ ] **Step 4: Table in init-db; local-only guard; D3 skip**

````bash
cd ~/crow-wt-keychain && git apply <<'PATCH'
diff --git a/scripts/init-db.js b/scripts/init-db.js
index b5452b3..0377d12 100644
--- a/scripts/init-db.js
+++ b/scripts/init-db.js
@@ -6,6 +6,7 @@ import { resolve } from "path";
 import { slugify, workspacePathFor, storagePrefixFor } from "../servers/shared/slugify.js";
 import { BOT_JOBS_DDL, missingBotJobsColumns } from "./pi-bots/bot-jobs-schema.mjs";
 import { SCHEMA_GENERATION } from "../servers/shared/schema-version.js";
+import { KEYCHAIN_DDL } from "../servers/gateway/keychain/schema.js";
 
 // Ensure data directory exists
 const dataDir = process.env.CROW_DB_PATH
@@ -3088,6 +3089,14 @@ await db.execute({ sql: "UPDATE contacts SET is_bot = 1 WHERE origin = 'advertis
 // whose advertised-bot directory this contact was added from. Set at INSERT only.
 await addColumnIfMissing("contacts", "advertised_by_instance_id", "TEXT"); // NULL=manual/pasted-invite contact, NEVER prunable
 
+// --- Crow keychain (2026-10-03) ---
+// Human-facing passwords, sealed with secret-box under the keychain's OWN key
+// (<CROW_HOME>/secrets/keychain.key — never the identity seed, never in a backup).
+// LOCAL ONLY: listed in instance-sync LOCAL_ONLY_TABLES and never in SYNCED_TABLES.
+// Additive: keychain/store.js also CREATE-IF-NOT-EXISTS this lazily, so existing
+// installs need no SCHEMA_GENERATION bump.
+await initTable("crow_keychain table", KEYCHAIN_DDL);
+
 // Stamp the schema generation so the gateway boot gate can detect when an
 // out-of-band code update introduced migrations that a plain restart missed.
 // (PRAGMA values can't be bound params — interpolate the coerced Number.)
diff --git a/scripts/ops/grackle-d3-import.mjs b/scripts/ops/grackle-d3-import.mjs
index 4a94bb3..5c92f5d 100644
--- a/scripts/ops/grackle-d3-import.mjs
+++ b/scripts/ops/grackle-d3-import.mjs
@@ -347,6 +347,7 @@ export const SKIP_REASONS = {
   mcp_sessions: "per-host session state",
   sync_conflicts: "grackle-local sync bookkeeping",
   audit_log: "grackle-local audit trail",
+  crow_keychain: "machine-local passwords sealed with that machine's own keychain key (move them with Settings → Passwords → Export / Import)",
   cross_host_calls: "grackle-local bookkeeping",
   providers: "already synced (grackle's provider rows are being retired)",
   data_backends: "keep crow's rows (map: grackle's point at ~/spring-2026)",
@@ -359,6 +360,7 @@ export const SKIP_REASONS = {
 /** Never written to the extract: credentials / sync internals (the archived full backup keeps them). */
 const NO_EXTRACT = new Set([
   "oauth_clients", "oauth_tokens", "mcp_sessions", "dashboard_pending_2fa", "push_subscriptions",
+  "crow_keychain",
   "crow_instances", "sync_state", "sync_outbox", "rate_limit_buckets", "sqlite_sequence",
   "dashboard_settings", "dashboard_settings_overrides",
 ]);
diff --git a/servers/sharing/instance-sync.js b/servers/sharing/instance-sync.js
index c28561e..0a082ff 100644
--- a/servers/sharing/instance-sync.js
+++ b/servers/sharing/instance-sync.js
@@ -107,6 +107,16 @@ export const SYNCED_TABLES = [
   "ramble_wallet",
 ];
 
+// Tables that must NEVER leave this machine (Crow keychain: human passwords). The
+// keychain has its own key file, but its rows are still never replicated. Checked at load.
+export const LOCAL_ONLY_TABLES = Object.freeze(["crow_keychain"]);
+export function assertLocalOnlyDisjoint(synced, localOnly) {
+  for (const t of localOnly) {
+    if (synced.includes(t)) throw new Error(`instance-sync: table ${t} is local-only and must never be in SYNCED_TABLES`);
+  }
+}
+assertLocalOnlyDisjoint(SYNCED_TABLES, LOCAL_ONLY_TABLES);
+
 // Columns to exclude from sync payloads (security-sensitive or instance-local)
 export const EXCLUDED_COLUMNS = {
   crow_instances: ["auth_token_hash"],
@@ -269,6 +279,7 @@ export function isLocalOnlyMemorySource(source) {
 }
 
 export function shouldSyncRow(table, row) {
+  if (LOCAL_ONLY_TABLES.includes(table)) return false;
   if (table === "contacts") {
     if (!row) return false;
     // local-bot contacts are hosted on THIS instance (instance-local secp key);
PATCH
git diff --stat
````

- [ ] **Step 5: Run the tests**

```bash
npm test -- tests/keychain-store.test.js
npm test -- tests/grackle-d3-import.test.js
npm test -- tests/migration-guard.test.js
npm test -- tests/schema-version-gate.test.js
```

Expected: all PASS. `migration-guard` stays green: this is a new table, with no DROP/DELETE expectation.

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/keychain/key.js servers/gateway/keychain/schema.js servers/gateway/keychain/store.js servers/gateway/keychain/export.js tests/keychain-store.test.js
git commit servers/gateway/keychain/key.js servers/gateway/keychain/schema.js servers/gateway/keychain/store.js servers/gateway/keychain/export.js tests/keychain-store.test.js scripts/init-db.js servers/sharing/instance-sync.js scripts/ops/grackle-d3-import.mjs -m "feat(keychain): own key file (never backed up), sealed local-only store, passphrase export/import; LOCAL_ONLY_TABLES + D3 skip"
git show --stat HEAD
```

---

### Task 5: Re-auth gate and the keychain JSON API

**Files:**
- Create:
  - `servers/gateway/keychain/reauth.js`
  - `servers/gateway/keychain/api.js`
  - `servers/gateway/keychain/vault-save.js` (a placeholder, replaced in Task 7)
  - `tests/keychain-api.test.js`
- Modify: `servers/gateway/dashboard/index.js` (P4)

**Interfaces:**
- Consumes:
  - Task 4 store, key and export;
  - `auditLog` (`servers/db.js`);
  - `createNotification` (`servers/shared/notifications.js`);
  - `verifyPassword` (`dashboard/auth.js`);
  - `is2faEnabled`, `getTotpSecret`, `verifyTotp` (`dashboard/totp.js`).
- Produces:
  - `createReauthGate({ now?, ttlMs?, maxFailures?, lockMs?, globalMaxFailures?, globalWindowMs?, is2faEnabled, hasDashboardPassword, verifyTotpCode, verifyDashboardPassword })`. It returns:
    - `method(): Promise<"totp"|"password"|"none">`
    - `verify(token, { password?, totp_code? })`, resolving to `{ ok:true, method, expires_at }` or `{ ok:false, locked?, unavailable?, global_lock_started?, locked_until?, error }`
    - `isGranted(token)`, `expiresAt(token)`, `revoke(token)`
  - `defaultReauthGate()`
  - `keychainApiRouter({ openDb?, crowHome?, gate?, vault?, audit?, notify? }): Router` (routes in spec §5.4)
    - reads use `loadKeychainKey`; add/import use `ensureWriteKey`;
    - a damaged key with entries answers 409 `key_invalid` with the file path;
    - a lost key re-created while rows exist is audited and notified once (m2).
  - placeholder `vaultwardenStatus()` / `saveToVault()` (same signatures as Task 7)

- [ ] **Step 1: Write the failing test** — create `tests/keychain-api.test.js`:

````js
/** Re-auth gate + keychain API (Task 4). Express on 127.0.0.1:0, scratch DB + key, stub verifiers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-kcapi-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const { createDbClient } = await import("../servers/db.js");
const { createReauthGate } = await import("../servers/gateway/keychain/reauth.js");
const { keychainApiRouter } = await import("../servers/gateway/keychain/api.js");
const { createKeychainKey, keychainKeyPath } = await import("../servers/gateway/keychain/key.js");
import { writeFileSync } from "node:fs";
const K = await import("../servers/gateway/keychain/store.js");

const AUDIT_DDL = "CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, actor TEXT, ip_address TEXT, details TEXT, created_at TEXT DEFAULT (datetime('now')))";

async function setup({ twoFa = false, hasPassword = true, clock = { t: Date.parse("2026-10-03T12:00:00Z") }, vault } = {}) {
  const dbPath = join(mkdtempSync(join(tmpdir(), "crow-kcapi-db-")), "crow.db");
  const crowHome = mkdtempSync(join(tmpdir(), "crow-kcapi-home-"));
  const seedDb = createDbClient(dbPath);
  await seedDb.execute(AUDIT_DDL);
  const gate = createReauthGate({
    now: () => clock.t,
    is2faEnabled: async () => twoFa,
    hasDashboardPassword: async () => hasPassword,
    verifyTotpCode: async (c) => c === "123456",
    verifyDashboardPassword: async (p) => p === "right-password",
  });
  const vaultCalls = [];
  const notes = [];
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => { req.dashboardSession = req.headers["x-test-session"] || null; next(); });
  app.use(keychainApiRouter({
    openDb: () => createDbClient(dbPath),
    crowHome,
    gate,
    notify: async (_db, n) => { notes.push(n); },
    vault: vault || { status: () => ({ installed: true, cliPath: "/x/bw.js", serverUrl: "http://localhost:18097" }), save: async (o) => { vaultCalls.push(o); return { ok: true }; } },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/dashboard/keychain/api`;
  const call = (path, { session = "S1", body, method = body ? "POST" : "GET", headers = {} } = {}) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...(session ? { "x-test-session": session } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json(), cache: r.headers.get("cache-control"), disposition: r.headers.get("content-disposition") }));
  const audits = async () => (await seedDb.execute("SELECT event_type, details FROM audit_log ORDER BY id")).rows;
  const key = () => createKeychainKey({ crowHome });
  return { db: seedDb, crowHome, key, call, audits, clock, vaultCalls, notes, close: () => server.close() };
}

test("entries list never carries a secret; reveal without a grant is 403 reauth_required", async () => {
  const s = await setup();
  try {
    const { id } = await K.saveExtensionSecret(s.db, s.key(), { bundleId: "workspace", envKey: "WORKSPACE_ADMIN_PASSWORD", label: "Workspace admin", secret: "s3cr3t-value", origin: "typed" });
    const list = await s.call("/entries");
    assert.equal(list.status, 200);
    assert.equal(list.body.entries[0].id, id);
    assert.equal(list.body.entries[0].readable, true);
    assert.equal(list.body.reauth_method, "password");
    assert.ok(!JSON.stringify(list.body).includes("s3cr3t-value"));
    const r = await s.call("/reveal", { body: { id, purpose: "reveal" } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "reauth_required");
  } finally { s.close(); }
});

test("re-auth with the password → reveal and copy work, are no-store, and are audited without the value", async () => {
  const s = await setup();
  try {
    const { id } = await K.saveExtensionSecret(s.db, s.key(), { bundleId: "workspace", envKey: "WORKSPACE_ADMIN_PASSWORD", label: "Workspace admin", secret: "s3cr3t-value", origin: "typed" });
    assert.equal((await s.call("/reauth", { body: { password: "right-password" } })).status, 200);
    const r = await s.call("/reveal", { body: { id, purpose: "reveal" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.secret, "s3cr3t-value");
    assert.equal(r.cache, "no-store");
    assert.equal((await s.call("/reveal", { body: { id, purpose: "copy" } })).body.secret, "s3cr3t-value");
    const ev = await s.audits();
    assert.deepEqual(ev.map((e) => e.event_type), ["keychain_reauth_ok", "keychain_reveal", "keychain_copy"]);
    assert.ok(!JSON.stringify(ev).includes("s3cr3t-value"), "audit details never hold the value");
  } finally { s.close(); }
});

test("REVIEW FOCUS 4 — grants are per session, expire at 5 min, lock after 5 failures, and 20/hour locks the whole instance", async () => {
  const s = await setup();
  try {
    const { id } = await K.addManualSecret(s.db, s.key(), { label: "Phone", secret: "app-pass" });
    await s.call("/reauth", { session: "S1", body: { password: "right-password" } });
    assert.equal((await s.call("/reveal", { session: "S2", body: { id } })).status, 403, "another session's grant does not count");
    assert.equal((await s.call("/reveal", { session: "S1", body: { id } })).status, 200);
    s.clock.t += 5 * 60 * 1000 + 1;
    assert.equal((await s.call("/reveal", { session: "S1", body: { id } })).status, 403, "expired after 5 minutes");

    for (let i = 0; i < 5; i++) assert.equal((await s.call("/reauth", { session: "S3", body: { password: "wrong" } })).status, 401);
    const locked = await s.call("/reauth", { session: "S3", body: { password: "right-password" } });
    assert.equal(locked.status, 429, "the right password is refused while locked");
    s.clock.t += 15 * 60 * 1000 + 1;
    assert.equal((await s.call("/reauth", { session: "S3", body: { password: "right-password" } })).status, 200, "lock lifts after 15 minutes");

    // S1: a peer minting fresh sessions gets 4 tries each, but the instance-wide ceiling still trips.
    for (let i = 0; i < 15; i++) await s.call("/reauth", { session: `P${Math.floor(i / 4)}`, body: { password: "wrong" } });
    const global = await s.call("/reauth", { session: "FRESH", body: { password: "right-password" } });
    assert.equal(global.status, 429, "20 failures in an hour lock re-auth for every session");
    assert.equal(s.notes.length, 1, "the owner is notified once");
    assert.ok((await s.audits()).some((e) => e.event_type === "keychain_reauth_lockout"));
    s.clock.t += 60 * 60 * 1000 + 1;
    assert.equal((await s.call("/reauth", { session: "FRESH", body: { password: "right-password" } })).status, 200);
  } finally { s.close(); }
});

test("with dashboard 2FA on, only the TOTP code re-authenticates", async () => {
  const s = await setup({ twoFa: true });
  try {
    assert.equal((await s.call("/entries")).body.reauth_method, "totp");
    assert.equal((await s.call("/reauth", { body: { password: "right-password" } })).status, 401, "the password alone is not enough");
    assert.equal((await s.call("/reauth", { body: { totp_code: "123456" } })).status, 200);
  } finally { s.close(); }
});

test("Q6 — no dashboard password and no 2FA: reveal/export are refused with an explanation, no bypass", async () => {
  const s = await setup({ hasPassword: false });
  try {
    const { id } = await K.addManualSecret(s.db, s.key(), { label: "Phone", secret: "app-pass" });
    assert.equal((await s.call("/entries")).body.reauth_method, "none");
    const r = await s.call("/reauth", { body: { password: "" } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "reauth_unavailable");
    for (const [path, body] of [["/reveal", { id }], ["/export", { passphrase: "x".repeat(12) }], ["/delete", { id }]]) {
      const x = await s.call(path, { body });
      assert.equal(x.status, 403, path);
      assert.equal(x.body.code, "reauth_unavailable", path);
    }
  } finally { s.close(); }
});

test("REVIEW FOCUS 2 (API) — first-view works once without re-auth, then 410", async () => {
  const s = await setup();
  try {
    const { id } = await K.saveExtensionSecret(s.db, s.key(), { bundleId: "vaultwarden", envKey: "VAULTWARDEN_ADMIN_TOKEN", label: "Vaultwarden admin token", secret: "tok-1", origin: "generated", firstView: true });
    const one = await s.call("/first-view", { body: { id } });
    assert.equal(one.status, 200);
    assert.equal(one.body.secret, "tok-1");
    const two = await s.call("/first-view", { body: { id } });
    assert.equal(two.status, 410);
    assert.equal(two.body.code, "first_view_spent");
  } finally { s.close(); }
});

test("C7 — entries sealed under a missing key list as unreadable and reveal answers 409 key_missing", async () => {
  const s = await setup();
  try {
    const other = createKeychainKey({ crowHome: mkdtempSync(join(tmpdir(), "crow-kcapi-other-")) });
    const { id } = await K.addManualSecret(s.db, other, { label: "From the old machine", secret: "old" });
    const list = await s.call("/entries");
    assert.equal(list.body.entries[0].readable, false);
    assert.equal(list.body.key_present, false);
    await s.call("/reauth", { body: { password: "right-password" } });
    const r = await s.call("/reveal", { body: { id } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "key_missing");
  } finally { s.close(); }
});

test("C5 — deleting an in-use generated token needs an explicit confirmation", async () => {
  const s = await setup();
  try {
    const { id } = await K.saveExtensionSecret(s.db, s.key(), { bundleId: "vaultwarden", envKey: "VAULTWARDEN_ADMIN_TOKEN", label: "Vaultwarden admin token", secret: "tok", origin: "generated" });
    await s.call("/reauth", { body: { password: "right-password" } });
    const r = await s.call("/delete", { body: { id } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "generated_in_use");
    assert.equal((await s.call("/delete", { body: { id, confirm_generated: true } })).status, 200);
  } finally { s.close(); }
});

test("Export then Import (re-auth required): the file round-trips; a wrong passphrase imports nothing", async () => {
  const s = await setup();
  try {
    await K.addManualSecret(s.db, s.key(), { label: "Phone", username: "kevin", secret: "app-pass" });
    assert.equal((await s.call("/export", { body: { passphrase: "correct horse battery" } })).status, 403);
    await s.call("/reauth", { body: { password: "right-password" } });
    assert.equal((await s.call("/export", { body: { passphrase: "short" } })).status, 400);
    const ex = await s.call("/export", { body: { passphrase: "correct horse battery" } });
    assert.equal(ex.status, 200);
    assert.match(ex.disposition, /attachment; filename="crow-keychain-\d{4}-\d{2}-\d{2}\.json"/);
    assert.equal(ex.body.count, 1);
    assert.ok(!JSON.stringify(ex.body).includes("app-pass"));

    const t = await setup();
    try {
      await t.call("/reauth", { body: { password: "right-password" } });
      assert.equal((await t.call("/import", { body: { file: ex.body, passphrase: "wrong passphrase!!" } })).status, 400);
      const im = await t.call("/import", { body: { file: ex.body, passphrase: "correct horse battery" } });
      assert.deepEqual(im.body, { ok: true, imported: 1, skipped: 0 });
      const [e] = (await t.call("/entries")).body.entries;
      assert.equal(e.readable, true);
      assert.equal((await t.call("/reveal", { body: { id: e.id } })).body.secret, "app-pass");
      assert.deepEqual((await t.audits()).filter((a) => a.event_type === "keychain_import").map((a) => JSON.parse(a.details)), [{ imported: 1, skipped: 0 }]);
    } finally { t.close(); }
  } finally { s.close(); }
});

test("add needs no grant; delete needs one; both audited", async () => {
  const s = await setup();
  try {
    const add = await s.call("/add", { body: { label: "Workspace phone (Kevin)", username: "kevin", url: "https://ws:8456", secret: "abcd-efgh-ijkl" } });
    assert.equal(add.status, 200);
    assert.equal((await s.call("/delete", { body: { id: add.body.id } })).status, 403);
    await s.call("/reauth", { body: { password: "right-password" } });
    assert.equal((await s.call("/delete", { body: { id: add.body.id } })).status, 200);
    assert.deepEqual((await s.audits()).map((e) => e.event_type), ["keychain_add", "keychain_reauth_ok", "keychain_delete"]);
    assert.equal((await s.call("/add", { body: { label: "", secret: "x" } })).status, 400);
    assert.equal((await s.call("/add", { body: { label: "x", secret: "" } })).status, 400);
  } finally { s.close(); }
});

test("vault-save: grant required, credentials passed through once, never audited", async () => {
  const s = await setup();
  try {
    const { id } = await K.addManualSecret(s.db, s.key(), { label: "Phone", username: "kevin", secret: "app-pass" });
    assert.equal((await s.call("/vault-save", { body: { id, vault_email: "k@example.invalid", vault_password: "Master-PW" } })).status, 403);
    await s.call("/reauth", { body: { password: "right-password" } });
    const r = await s.call("/vault-save", { body: { id, vault_email: "k@example.invalid", vault_password: "Master-PW" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(s.vaultCalls[0].masterPassword, "Master-PW");
    assert.equal(s.vaultCalls[0].item.password, "app-pass");
    const ev = JSON.stringify(await s.audits());
    assert.ok(!ev.includes("Master-PW") && !ev.includes("app-pass"));
  } finally { s.close(); }
});

test("peer-signed and session-less requests are refused", async () => {
  const s = await setup();
  try {
    assert.equal((await s.call("/entries", { headers: { "x-crow-signature": "abc" } })).status, 403);
    assert.equal((await s.call("/entries", { session: null })).status, 401);
  } finally { s.close(); }
});

test("m1/m2 — a damaged key with entries refuses saves (409 key_invalid); a lost key is re-created once and reported", async () => {
  const s = await setup();
  try {
    await K.addManualSecret(s.db, s.key(), { label: "Phone", secret: "app-pass" });
    writeFileSync(keychainKeyPath(s.crowHome), "");
    const r = await s.call("/add", { body: { label: "New", secret: "x-1" } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "key_invalid");
    assert.match(r.body.error, /keychain\.key/);

    const { rmSync } = await import("node:fs");
    rmSync(keychainKeyPath(s.crowHome));
    const ok = await s.call("/add", { body: { label: "New", secret: "x-1" } });
    assert.equal(ok.status, 200, "a MISSING key is simply created");
    assert.equal(s.notes.length, 1, "the user is told the older entries need an Import");
    assert.match(s.notes[0].body, /1 saved password/);
    assert.ok((await s.audits()).some((e) => e.event_type === "keychain_key_created"));
  } finally { s.close(); }
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/keychain-api.test.js`
Expected: FAIL with `Cannot find module '…/keychain/reauth.js'`.

- [ ] **Step 3: Create the modules**

`servers/gateway/keychain/reauth.js`:

````js
/**
 * Fresh re-auth for keychain reveal/copy/delete/export/import/vault-save (spec §5.4).
 * Per dashboard session (sha256 of the session token), in memory: a 5-minute grant;
 * 5 consecutive failures lock re-auth for that session for 15 minutes. An INSTANCE-WIDE
 * ceiling (review S1: a paired peer can mint fresh SSO sessions, each with its own
 * 5 tries) locks re-auth for everyone after 20 failures in an hour.
 * With dashboard 2FA on, ONLY a TOTP code counts; otherwise the dashboard password.
 * With neither (Kevin Q6), method() is "none" and nothing can be granted — no bypass.
 * A gateway restart forgets everything, which only means "ask again".
 */
import { createHash } from "node:crypto";

export function createReauthGate({
  now = () => Date.now(),
  ttlMs = 5 * 60 * 1000,
  maxFailures = 5,
  lockMs = 15 * 60 * 1000,
  globalMaxFailures = 20,
  globalWindowMs = 60 * 60 * 1000,
  is2faEnabled,
  hasDashboardPassword,
  verifyTotpCode,
  verifyDashboardPassword,
}) {
  const grants = new Map();   // key → expiresAt (ms)
  const failures = new Map(); // key → { count, lockedUntil }
  let recentFailures = [];    // instance-wide failure timestamps
  const keyOf = (token) => createHash("sha256").update(String(token)).digest("hex");

  async function method() {
    if (await is2faEnabled()) return "totp";
    return (await hasDashboardPassword()) ? "password" : "none";
  }

  function globalLockedUntil(t) {
    recentFailures = recentFailures.filter((x) => x > t - globalWindowMs);
    return recentFailures.length >= globalMaxFailures ? recentFailures[0] + globalWindowMs : 0;
  }

  async function verify(token, { password, totp_code } = {}) {
    if (!token) return { ok: false, error: "No dashboard session." };
    const m = await method();
    if (m === "none") return { ok: false, unavailable: true, method: m, error: "Set a dashboard password or two-factor authentication first." };
    const k = keyOf(token);
    const t = now();
    const g = globalLockedUntil(t);
    if (g > t) return { ok: false, locked: true, global: true, locked_until: g, error: "Too many wrong attempts on this Crow. Try again later." };
    const f = failures.get(k);
    if (f && f.lockedUntil > t) {
      return { ok: false, locked: true, locked_until: f.lockedUntil, error: "Too many wrong attempts. Try again later." };
    }
    let ok = false;
    try {
      ok = m === "totp"
        ? await verifyTotpCode(String(totp_code ?? "").trim())
        : await verifyDashboardPassword(String(password ?? ""));
    } catch {
      ok = false;
    }
    if (!ok) {
      const count = (f && f.lockedUntil <= t && f.lockedUntil !== 0 ? 0 : (f?.count || 0)) + 1;
      if (count >= maxFailures) failures.set(k, { count: 0, lockedUntil: t + lockMs });
      else failures.set(k, { count, lockedUntil: 0 });
      recentFailures.push(t);
      const justLockedGlobally = recentFailures.length === globalMaxFailures;
      return { ok: false, method: m, global_lock_started: justLockedGlobally, error: m === "totp" ? "That code is not valid." : "That password is not correct." };
    }
    failures.delete(k);
    grants.set(k, t + ttlMs);
    return { ok: true, method: m, expires_at: t + ttlMs };
  }

  function isGranted(token) {
    if (!token) return false;
    const k = keyOf(token);
    const exp = grants.get(k);
    if (!exp) return false;
    if (exp <= now()) { grants.delete(k); return false; }
    return true;
  }

  function expiresAt(token) {
    return isGranted(token) ? grants.get(keyOf(token)) : null;
  }

  function revoke(token) {
    if (token) grants.delete(keyOf(token));
  }

  return { method, verify, isGranted, expiresAt, revoke };
}
````

`servers/gateway/keychain/api.js`:

````js
/**
 * /dashboard/keychain/api/* — the only door through which keychain plaintext reaches a
 * browser. Mounted after dashboardAuth + csrfMiddleware (dashboard/index.js), so every
 * request is a signed-in dashboard session with a valid CSRF echo; peer-signed requests
 * are refused here. Plaintext is returned only by /reveal and /export (re-auth grant) and
 * /first-view (one-time grant), always with Cache-Control: no-store, and is never logged.
 */
import { Router } from "express";
import { createDbClient, auditLog } from "../../db.js";
import { createNotification } from "../../shared/notifications.js";
import { verifyPassword } from "../dashboard/auth.js";
import { is2faEnabled, getTotpSecret, verifyTotp } from "../dashboard/totp.js";
import { createReauthGate } from "./reauth.js";
import { loadKeychainKey } from "./key.js";
import { sealExport, openExport, MIN_PASSPHRASE } from "./export.js";
import {
  listEntries, getEntry, openEntrySecret, consumeFirstView, addManualSecret, deleteEntry,
  exportableEntries, importEntries, ensureWriteKey,
} from "./store.js";
import { vaultwardenStatus, saveToVault } from "./vault-save.js";

const BASE = "/dashboard/keychain/api";

async function readPasswordHash() {
  const db = createDbClient();
  try {
    const r = await db.execute("SELECT value FROM dashboard_settings WHERE key = 'password_hash'");
    return r.rows[0]?.value || null;
  } finally {
    db.close();
  }
}

export function defaultReauthGate() {
  return createReauthGate({
    is2faEnabled,
    hasDashboardPassword: async () => !!(await readPasswordHash()),
    verifyTotpCode: async (code) => verifyTotp(code, await getTotpSecret()),
    verifyDashboardPassword: async (pw) => {
      const stored = await readPasswordHash();
      if (!stored || !pw) return false;
      try { return await verifyPassword(pw, stored); } catch { return false; }
    },
  });
}

const auditDetails = (e) => ({ entry_id: e.id, label: e.label, bundle_id: e.bundle_id || null, env_key: e.env_key || null });
const str = (v, max) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const KEY_MISSING = { code: "key_missing", error: "This password was saved under a keychain key that is not on this machine. Import an Export file to recover it, or delete it." };

export function keychainApiRouter({
  openDb = () => createDbClient(),
  crowHome = undefined, // the keychain key lives in <crowHome>/secrets (default: CROW_HOME)
  gate = defaultReauthGate(),
  vault = { status: vaultwardenStatus, save: saveToVault },
  audit = auditLog,
  notify = createNotification,
} = {}) {
  const router = Router();

  router.use(BASE, (req, res, next) => {
    if (req.headers["x-crow-signature"]) return res.status(403).json({ error: "The keychain is not available to paired instances." });
    if (!req.dashboardSession) return res.status(401).json({ error: "Sign in first." });
    res.set("Cache-Control", "no-store");
    next();
  });

  const readKey = () => loadKeychainKey({ crowHome });
  // Saving creates the key on first use; a key created while entries already exist means
  // the old key was lost — audit it and tell the user once (re-review m2).
  const writeKey = (db, ip) => ensureWriteKey(db, {
    crowHome,
    onNewKey: async ({ orphaned }) => {
      await audit(db, "keychain_key_created", { ip, details: { orphaned } });
      try { await notify(db, { title: "New Crow keychain key created", body: `${orphaned} saved password(s) were sealed with a key that is no longer on this machine. Import an Export file in Settings → Passwords to recover them.`, type: "system", source: "keychain" }); } catch {}
    },
  });

  const withDb = (handler) => async (req, res) => {
    const db = openDb();
    try {
      await handler(req, res, db);
    } catch (err) {
      if (err?.code === "KEYCHAIN_KEY_MISSING") { if (!res.headersSent) res.status(409).json(KEY_MISSING); return; }
      if (err?.code === "KEYCHAIN_KEY_INVALID") { if (!res.headersSent) res.status(409).json({ code: "key_invalid", error: err.message }); return; }
      console.error("[keychain] request failed:", err?.code || err?.name || "error");
      if (!res.headersSent) res.status(500).json({ error: "Keychain error. Nothing was revealed." });
    } finally {
      try { db.close(); } catch {}
    }
  };

  const requireGrant = async (req, res) => {
    if ((await gate.method()) === "none") {
      res.status(403).json({ code: "reauth_unavailable", error: "Set a dashboard password or two-factor authentication first: Crow needs one to confirm it's you." });
      return false;
    }
    if (gate.isGranted(req.dashboardSession)) return true;
    res.status(403).json({ code: "reauth_required", error: "Confirm it's you first." });
    return false;
  };

  router.get(`${BASE}/entries`, withDb(async (req, res, db) => {
    const st = vault.status();
    const key = readKey();
    res.json({
      entries: await listEntries(db, { keyId: key?.id || null }),
      key_present: !!key,
      reauth_method: await gate.method(),
      granted_until: gate.expiresAt(req.dashboardSession),
      vault_available: !!(st && st.installed && st.cliPath && !st.serverOutdated),
    });
  }));

  router.post(`${BASE}/reauth`, withDb(async (req, res, db) => {
    const out = await gate.verify(req.dashboardSession, { password: req.body?.password, totp_code: req.body?.totp_code });
    if (out.ok) {
      await audit(db, "keychain_reauth_ok", { ip: req.ip, details: { method: out.method } });
      return res.json({ ok: true, method: out.method, expires_at: out.expires_at });
    }
    if (out.unavailable) return res.status(403).json({ code: "reauth_unavailable", error: out.error });
    if (out.locked) return res.status(429).json({ error: out.error, locked_until: out.locked_until });
    await audit(db, "keychain_reauth_failed", { ip: req.ip, details: { method: out.method || null } });
    if (out.global_lock_started) {
      await audit(db, "keychain_reauth_lockout", { ip: req.ip, details: { scope: "instance" } });
      try { await notify(db, { title: "Crow keychain locked for an hour", body: "Too many wrong confirmations to reveal saved passwords. If this was not you, change your dashboard password.", type: "system", source: "keychain" }); } catch {}
    }
    return res.status(401).json({ error: out.error });
  }));

  router.post(`${BASE}/reveal`, withDb(async (req, res, db) => {
    if (!(await requireGrant(req, res))) return;
    const purpose = req.body?.purpose === "copy" ? "copy" : "reveal";
    const entry = await getEntry(db, Number(req.body?.id));
    if (!entry) return res.status(404).json({ error: "No such password." });
    const secret = await openEntrySecret(db, readKey(), entry.id);
    await audit(db, purpose === "copy" ? "keychain_copy" : "keychain_reveal", { ip: req.ip, details: auditDetails(entry) });
    res.json({ secret });
  }));

  router.post(`${BASE}/first-view`, withDb(async (req, res, db) => {
    const entry = await getEntry(db, Number(req.body?.id));
    if (!entry) return res.status(404).json({ error: "No such password." });
    const secret = await consumeFirstView(db, readKey(), entry.id);
    if (secret === null) return res.status(410).json({ code: "first_view_spent", error: "Already shown. Open Settings → Passwords to see it again." });
    await audit(db, "keychain_first_view", { ip: req.ip, details: auditDetails(entry) });
    res.json({ secret });
  }));

  router.post(`${BASE}/add`, withDb(async (req, res, db) => {
    const label = str(req.body?.label?.trim?.(), 200);
    const secret = str(req.body?.secret, 1024);
    if (!label || !secret || /[\0]/.test(secret)) return res.status(400).json({ error: "A label and a password are required." });
    const username = str(req.body?.username, 256);
    const url = str(req.body?.url, 2048);
    const { id } = await addManualSecret(db, await writeKey(db, req.ip), { label, username, url, secret });
    await audit(db, "keychain_add", { ip: req.ip, details: { entry_id: id, label } });
    res.json({ ok: true, id });
  }));

  router.post(`${BASE}/delete`, withDb(async (req, res, db) => {
    if (!(await requireGrant(req, res))) return;
    const entry = await getEntry(db, Number(req.body?.id));
    if (!entry) return res.status(404).json({ error: "No such password." });
    // C5: a generated token may be the ONLY plaintext of a hash the extension still uses.
    if (entry.origin === "generated" && entry.status === "active" && req.body?.confirm_generated !== true) {
      return res.status(409).json({ code: "generated_in_use", error: `Crow generated this token and keeps no other copy: without it you cannot sign in to ${entry.bundle_id || "the extension"}'s admin page. Export or save it elsewhere first.` });
    }
    await deleteEntry(db, entry.id);
    await audit(db, "keychain_delete", { ip: req.ip, details: auditDetails(entry) });
    res.json({ ok: true });
  }));

  router.post(`${BASE}/export`, withDb(async (req, res, db) => {
    if (!(await requireGrant(req, res))) return;
    const passphrase = typeof req.body?.passphrase === "string" ? req.body.passphrase : "";
    if (passphrase.length < MIN_PASSPHRASE) return res.status(400).json({ error: `Choose a passphrase of at least ${MIN_PASSPHRASE} characters.` });
    const key = readKey();
    if (!key) return res.status(409).json(KEY_MISSING);
    const entries = await exportableEntries(db, key);
    const file = await sealExport(entries, passphrase);
    await audit(db, "keychain_export", { ip: req.ip, details: { count: entries.length } });
    res.set("Content-Disposition", `attachment; filename="crow-keychain-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(file);
  }));

  router.post(`${BASE}/import`, withDb(async (req, res, db) => {
    if (!(await requireGrant(req, res))) return;
    const entries = await openExport(req.body?.file, typeof req.body?.passphrase === "string" ? req.body.passphrase : "");
    if (!entries) return res.status(400).json({ error: "That passphrase does not open this file, or it is not a Crow keychain export." });
    const out = await importEntries(db, await writeKey(db, req.ip), entries);
    await audit(db, "keychain_import", { ip: req.ip, details: out });
    res.json({ ok: true, ...out });
  }));

  router.post(`${BASE}/vault-save`, withDb(async (req, res, db) => {
    if (!(await requireGrant(req, res))) return;
    const st = vault.status();
    if (!st || !st.installed || !st.cliPath) return res.status(409).json({ ok: false, reason: "Install or update the Vaultwarden extension first." });
    if (st.serverOutdated) return res.status(409).json({ ok: false, reason: st.serverOutdated });
    const email = str(req.body?.vault_email?.trim?.(), 320);
    const masterPassword = str(req.body?.vault_password, 1024);
    if (!email || !masterPassword) return res.status(400).json({ ok: false, reason: "Enter your vault email and master password." });
    const entry = await getEntry(db, Number(req.body?.id));
    if (!entry) return res.status(404).json({ ok: false, reason: "No such password." });
    const secret = await openEntrySecret(db, readKey(), entry.id);
    const out = await vault.save({
      cliPath: st.cliPath, serverUrl: st.serverUrl, email, masterPassword,
      item: { name: entry.label, username: entry.username, password: secret, url: entry.url, notes: entry.bundle_id ? `Saved by Crow (${entry.bundle_id} / ${entry.env_key})` : "Saved by Crow" },
    });
    await audit(db, "keychain_vault_save", { ip: req.ip, details: { ...auditDetails(entry), ok: !!out.ok, reason: out.ok ? null : out.reason } });
    res.json(out.ok ? { ok: true } : { ok: false, reason: out.reason });
  }));

  router.get(`${BASE}/activity`, withDb(async (_req, res, db) => {
    const { rows } = await db.execute("SELECT event_type, created_at, details FROM audit_log WHERE event_type LIKE 'keychain_%' ORDER BY id DESC LIMIT 25");
    res.json({ events: rows.map((r) => ({ event: r.event_type, at: r.created_at, details: (() => { try { return JSON.parse(r.details || "{}"); } catch { return {}; } })() })) });
  }));

  return router;
}
````

`servers/gateway/keychain/vault-save.js` (placeholder; Task 7 replaces it wholesale):

```js
// servers/gateway/keychain/vault-save.js — placeholder; replaced wholesale in Task 7.
export function vaultwardenStatus() { return { installed: false, cliPath: null, serverUrl: null }; }
export async function saveToVault() { return { ok: false, reason: "Saving to Vaultwarden is not available yet." }; }
```

- [ ] **Step 4: Mount it** (P4)

````bash
cd ~/crow-wt-keychain && git apply <<'PATCH'
diff --git a/servers/gateway/dashboard/index.js b/servers/gateway/dashboard/index.js
index ed54089..9ac3270 100644
--- a/servers/gateway/dashboard/index.js
+++ b/servers/gateway/dashboard/index.js
@@ -82,6 +82,7 @@ import meteringPanel from "./panels/metering.js";
 import perchHubPanel from "./panels/perch-hub.js";
 import { handleFixItAction } from "../fix-it/index.js";
 import bundlesRouterFactory from "../routes/bundles.js";
+import { keychainApiRouter } from "../keychain/api.js";
 import perchApiRouter from "../routes/perch.js";
 import perchInteractiveApiRouter from "../routes/perch-interactive-api.js";
 
@@ -620,6 +621,11 @@ export default function dashboardRouter(mcpAuthMiddleware) {
   // pre-auth flows (no session cookie yet), and CROW_CSRF_STRICT=0 rollback.
   router.use("/dashboard", csrfMiddleware);
 
+  // Crow keychain API (Settings → Passwords + the Extensions first-view banner).
+  // Session-authed + CSRF-protected by the two middlewares above; the router itself
+  // refuses peer-signed requests and serves every response no-store.
+  router.use(keychainApiRouter());
+
   // Perch Hub P1 (C-5): the gateway API the proxied bots lens calls.
   // Mounted HERE — inside the dashboard router, after dashboardAuth AND after
   // csrfMiddleware — rather than at app root beside bot-board-api, because
PATCH
git diff --stat
````

- [ ] **Step 5: Run the tests**

```bash
npm test -- tests/keychain-api.test.js
npm test -- tests/auth-network.test.js
```

Expected: PASS. `auth-network` is unchanged, because no Funnel prefix moved.

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/keychain/reauth.js servers/gateway/keychain/api.js servers/gateway/keychain/vault-save.js tests/keychain-api.test.js
git commit servers/gateway/keychain/reauth.js servers/gateway/keychain/api.js servers/gateway/keychain/vault-save.js tests/keychain-api.test.js servers/gateway/dashboard/index.js -m "feat(keychain): re-auth gate (TOTP/password/none, session + instance-wide lockout) and the audited keychain API with export/import"
git show --stat HEAD
```

---

### Task 6: LIVE compatibility spike — Bitwarden CLI 2026.9.1 ⇄ Vaultwarden 1.37.3 (before any vault-save code; one [KEVIN] step)

**Why now:** review C8 and Kevin Q3.
- The evidence so far comes from the Vaultwarden 1.37.0 release notes: "required for support with clients with version 2026.7.0+". That rules out the bundle's 1.32.7 for CLI 2026.9.1.
- 1.37.3 is the current stable release; its admin token path is unchanged (spec §3).
- This spike proves the pair live before Tasks 7–11 build on it.

**Pre-decided fallback (spec R18):** if any PASS line below fails on 1.37.3, repeat Steps 3–4 with the newest `@bitwarden/cli` release that passes (`npm view @bitwarden/cli versions`, newest first). Pin that version in Tasks 7 and 11 instead of `2026.9.1`, and record the finding.

**If no CLI release passes (re-review m7, decided now):** ship the keychain without the vault option.
- Keep Task 5's placeholder `vault-save.js` (its `vaultwardenStatus()` reports not installed, so no vault UI ever shows).
- In Task 7, do only the refresh fix (Step 4 and its test).
- In Task 11, drop the `@bitwarden/cli` dependency, `npm_required` and `verify_paths`.
- Record it in the findings, and add "vault save" back as a §9 follow-up.

**Serve teardown without sudo (optional, Kevin's call):** a one-time `sudo tailscale set --operator=kh0pp` lets the deadman's teardown run `tailscale serve --https=8461 off` itself. This plan does not make that host change on its own.

**Touches:**
- a throwaway `vaultwarden/server:1.37.3` (compose project `crow-kc-spike`, container `crow-kc-spike-vw`, `127.0.0.1:18097`, `restart: "no"`, data under the scratch dir);
- a temporary tailnet-only Serve mapping HTTPS `8461` → `127.0.0.1:18097` for the [KEVIN] registration;
- a scratch npm install of the CLI.

Prod is untouched. 18097 and 8461 were free on 2026-10-03; Step 1 re-checks.

**Files:** none in the repo. Scratch: `/tmp/claude-1000/kc-spike`.

- [ ] **Step 1: Check, register, arm the deadman**

```bash
ss -ltn | grep -qE ':18097\b' && echo "18097 BUSY" || echo "18097 free"
tailscale serve status | grep -q ':8461' && echo "8461 BUSY" || echo "8461 free"
```

Read `~/CROW-SCHEDULE.md`, then add a Reservations row:

```markdown
| **2026-10-0X HH:MM → +90 min hard cap (attended; transient unit kc-spike-deadman tears down at the cap)** | **Crow keychain CLI⇄Vaultwarden spike**: throwaway vaultwarden/server:1.37.3 `crow-kc-spike` on 127.0.0.1:18097 + temp Serve 8461 (tailnet only); scratch /tmp/claude-1000/kc-spike. No GPU, no model containers, prod untouched. | Claude session (crow) + Kevin | manual | no crow-kc-spike* containers AND `systemctl --user list-units 'kc-spike-*'` empty AND serve 8461 off AND row moved to Done |
```

Then:

```bash
SP=/tmp/claude-1000/kc-spike; rm -rf $SP; mkdir -p $SP/vwdata $SP/cli; chmod 700 $SP
cat > $SP/docker-compose.yml <<'EOF'
services:
  vaultwarden:
    image: vaultwarden/server:1.37.3
    container_name: crow-kc-spike-vw
    restart: "no"
    ports: ["127.0.0.1:18097:80"]
    volumes: ["./vwdata:/data"]
    environment:
      - DOMAIN=https://crow.dachshund-chromatic.ts.net:8461
      - SIGNUPS_ALLOWED=true
EOF
cat > $SP/teardown.sh <<'EOF'
#!/usr/bin/env bash
SP=/tmp/claude-1000/kc-spike
(cd $SP && docker compose -p crow-kc-spike down -v --remove-orphans) 2>/dev/null
docker ps -aq --filter label=com.docker.compose.project=crow-kc-spike | xargs -r docker rm -f 2>/dev/null
docker run --rm -v $SP:/s alpine:latest rm -rf /s/vwdata 2>/dev/null
echo "teardown $(date +%T). Serve 8461 needs: sudo tailscale serve --https=8461 off (deadman cannot sudo; a stale mapping only 502s)" >> $SP/teardown.log
EOF
chmod +x $SP/teardown.sh
systemd-run --user --unit=kc-spike-deadman --on-active=5400 /bin/bash $SP/teardown.sh
(cd $SP && docker compose -p crow-kc-spike up -d)
for i in $(seq 1 30); do curl -fsS http://localhost:18097/alive >/dev/null 2>&1 && break; sleep 2; done; curl -fsS http://localhost:18097/alive && echo " alive"
(cd $SP/cli && npm init -y >/dev/null && npm install --omit=optional --no-audit --no-fund --ignore-scripts @bitwarden/cli@2026.9.1 >/dev/null && node node_modules/@bitwarden/cli/build/bw.js --version)
```

PASS: `alive`, then `2026.9.1`.

- [ ] **Step 2: [KEVIN] Register a throwaway account**

```bash
sudo -S tailscale serve --bg --https=8461 http://127.0.0.1:18097   # credential per global CLAUDE.md, or Kevin runs it
```

**[KEVIN]:**
1. Open `https://crow.dachshund-chromatic.ts.net:8461/`.
2. Create `kc-spike@example.invalid` with a throwaway master password (never a real one, and never typed into the Claude session).
3. Say "registered".

- [ ] **Step 3: [KEVIN] CLI round-trip in his own terminal** (Claude writes the script; Kevin runs it and pastes back only its output)

```bash
SP=/tmp/claude-1000/kc-spike
cat > $SP/spike.sh <<'EOF'
#!/usr/bin/env bash
# Kevin runs: bash /tmp/claude-1000/kc-spike/spike.sh
SP=/tmp/claude-1000/kc-spike; BW="node $SP/cli/node_modules/@bitwarden/cli/build/bw.js"
read -rp "vault email: " EMAIL; read -rsp "throwaway master password: " CROW_BW_MASTER; echo; export CROW_BW_MASTER
run() { D=$(mktemp -d "$SP/bw.XXXXXX"); export BITWARDENCLI_APPDATA_DIR=$D HOME=$D BW_NOINTERACTION=true; "$@"; }
D=$(mktemp -d "$SP/bw.XXXXXX"); export BITWARDENCLI_APPDATA_DIR=$D HOME=$D BW_NOINTERACTION=true
$BW config server http://localhost:18097 >/dev/null && echo "PASS config server"
S=$($BW login "$EMAIL" --passwordenv CROW_BW_MASTER --raw 2>$SP/login.err) && [ -n "$S" ] && echo "PASS login" || { echo "FAIL login: $(head -c 300 $SP/login.err)"; }
ITEM=$(printf '{"type":1,"name":"kc-spike","notes":null,"favorite":false,"folderId":null,"organizationId":null,"collectionIds":null,"reprompt":0,"fields":[],"login":{"username":"admin","password":"p a$s'"'"'w\\"d #1","totp":null,"uris":[{"match":null,"uri":"https://example.invalid"}]}}' | base64 -w0)
printf '%s' "$ITEM" | BW_SESSION=$S $BW create item >/dev/null 2>$SP/create.err && echo "PASS create item (stdin)" || echo "FAIL create: $(head -c 300 $SP/create.err)"
BW_SESSION=$S $BW logout >/dev/null 2>&1 && echo "PASS logout"
CROW_BW_MASTER="${CROW_BW_MASTER}-wrong" $BW login "$EMAIL" --passwordenv CROW_BW_MASTER --raw >/dev/null 2>$SP/wrong.err; echo "WRONG-PASSWORD TEXT: $(head -c 300 $SP/wrong.err)"
rm -rf "$SP"/bw.*; unset CROW_BW_MASTER
EOF
chmod 700 $SP/spike.sh; echo "Kevin: bash $SP/spike.sh"
```

PASS: `PASS config server / login / create item (stdin) / logout`.

Record the `WRONG-PASSWORD TEXT` verbatim in the findings. Task 7's `classifyLogin` must map it to the "did not accept that email or master password" sentence; add a unit case with this exact text in Task 7 if it does not already match.

- [ ] **Step 4: [KEVIN] Two-step text, item check, device count**

**[KEVIN]**, in the web vault:
1. Check that item `kc-spike` exists with password exactly ``p a$s'w"d #1``.
2. Enable an authenticator two-step login on the throwaway account.
3. Re-run only the login line, then paste the error text:

```bash
SP=/tmp/claude-1000/kc-spike; D=$(mktemp -d "$SP/bw.XXXXXX"); BITWARDENCLI_APPDATA_DIR=$D HOME=$D BW_NOINTERACTION=true node $SP/cli/node_modules/@bitwarden/cli/build/bw.js config server http://localhost:18097 >/dev/null; read -rsp "master: " M; echo; CROW_BW_MASTER="$M" BITWARDENCLI_APPDATA_DIR=$D HOME=$D BW_NOINTERACTION=true node $SP/cli/node_modules/@bitwarden/cli/build/bw.js login kc-spike@example.invalid --passwordenv CROW_BW_MASTER --raw; rm -rf $D; unset M
```

Record the two-step error text. Task 7's `classifyLogin` must map it to the two-step sentence.

Record the number of devices under the account (web vault → Settings → Security → Devices, or `/admin/users` → Devices). If it grew by one per login, spec §9 item 5 (stable device id) stands as written.

- [ ] **Step 5: Teardown, findings, clear the row**

```bash
SP=/tmp/claude-1000/kc-spike
sudo -S tailscale serve --https=8461 off           # or Kevin
systemctl --user stop kc-spike-deadman.timer 2>/dev/null
bash $SP/teardown.sh
docker ps -a --format '{{.Names}}' | grep -q '^crow-kc-spike' && echo "FAIL containers left" || echo "PASS no spike containers"
tailscale serve status | grep -q ':8461' && echo "FAIL 8461 still mapped" || echo "PASS 8461 off"
```

Write `~/crow-weekend-push/reports/crow-keychain-spike-findings.md`:
- every PASS/FAIL line;
- the two error texts;
- the device observation;
- the ruling: "1.37.3 + 2026.9.1 confirmed", or the fallback CLI version.

Move the schedule row to Done, then `rm -rf $SP`.

---

### Task 7: The Bitwarden-CLI vault save; docker-bundle refresh ships package files

**Files:**
- Replace: `servers/gateway/keychain/vault-save.js` (the whole file)
- Modify: `servers/gateway/routes/bundles.js` (refresh `topFiles`), `tests/bundle-version-refresh.test.js` (append)
- Create: `tests/keychain-vault-save.test.js`

**Interfaces:**
- Consumes: `BUNDLES_DIR` and `CROW_HOME` (`servers/gateway/bundles-config.js`), `parseEnvText` (Task 1).
- Produces:
  - `vaultwardenStatus({ bundlesDir? }) → { installed, cliPath, serverUrl, serverOutdated: string|null }` (`serverOutdated` is the "reinstall" sentence when the installed compose pins Vaultwarden < 1.37)
  - refresh (P16): `npm_required` bundles use `npm ci --omit=dev --ignore-scripts` with a lock; on npm failure the manifest marker is left at the old version
  - `saveToVault({ cliPath, serverUrl, email, masterPassword, item:{ name, username?, password, url?, notes? }, deadlineMs?=90000, tmpRoot?=<CROW_HOME>/tmp, nodePath? }) → { ok:true } | { ok:false, reason }` (never throws)
  - `sweepStaleVaultDirs(tmpRoot, { now? }) → number`
  - `classifyLogin(stderr) → reason`
  - `VAULT_REASONS`

- [ ] **Step 1: Write the failing tests**

Create `tests/keychain-vault-save.test.js`:

````js
/** Bitwarden-CLI vault save against a FAKE bw (Task 5). No network, no real vault. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const V = await import("../servers/gateway/keychain/vault-save.js");

// The fake bw: behaviour from mode.txt beside it, one JSON line per call to calls.jsonl.
const FAKE_BW = String.raw`
const fs = require("node:fs"), path = require("node:path");
const dir = __dirname;
const mode = fs.existsSync(path.join(dir, "mode.txt")) ? fs.readFileSync(path.join(dir, "mode.txt"), "utf8").trim() : "ok";
const args = process.argv.slice(2);
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
const appdata = process.env.BITWARDENCLI_APPDATA_DIR || "";
if (appdata) fs.writeFileSync(path.join(appdata, "data.json"), "{}");
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({
  args, stdin, appdata, envKeys: Object.keys(process.env).sort(),
  master: process.env.CROW_BW_MASTER || null, session: process.env.BW_SESSION || null,
}) + "\n");
const cmd = args[0];
if (mode === "hang" && cmd === "login") setTimeout(() => {}, 1e9);
else if (cmd === "login" && mode === "wrong") { process.stderr.write("Username or password is incorrect. Try again.\n"); process.exit(1); }
else if (cmd === "login" && mode === "twostep") { process.stderr.write("Two-step login is required\n"); process.exit(1); }
else if (cmd === "login" && mode === "down") { process.stderr.write("request to http://127.0.0.1:18097/identity/connect/token failed, reason: connect ECONNREFUSED\n"); process.exit(1); }
else if (cmd === "login") { process.stdout.write("FAKE-SESSION-KEY\n"); }
else if (cmd === "create" && mode === "createfail") { process.stderr.write("boom\n"); process.exit(1); }
else if (cmd === "create") { process.stdout.write("{\"id\":\"x\"}\n"); }
`;

function fakeCli(mode = "ok") {
  const dir = mkdtempSync(join(tmpdir(), "crow-fakebw-"));
  writeFileSync(join(dir, "bw.cjs"), FAKE_BW);
  writeFileSync(join(dir, "mode.txt"), mode);
  const tmpRoot = mkdtempSync(join(tmpdir(), "crow-bwtmp-"));
  const calls = () => (existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { cliPath: join(dir, "bw.cjs"), tmpRoot, calls };
}

const ITEM = { name: "Workspace admin", username: "admin", password: "p a$s'w\"d", url: "https://ws.example:8456", notes: "Saved by Crow" };
const BASE = { serverUrl: "http://localhost:18097", email: "k@example.invalid", masterPassword: "Master-PW-1", item: ITEM };

test("happy path: config server → login (password via env) → create item (stdin) → logout", async () => {
  const f = fakeCli("ok");
  const out = await V.saveToVault({ ...BASE, cliPath: f.cliPath, tmpRoot: f.tmpRoot });
  assert.deepEqual(out, { ok: true });
  const c = f.calls();
  assert.deepEqual(c.map((x) => x.args[0]), ["config", "login", "create", "logout"]);
  assert.deepEqual(c[0].args, ["config", "server", "http://localhost:18097"]);
  assert.deepEqual(c[1].args, ["login", "k@example.invalid", "--passwordenv", "CROW_BW_MASTER", "--raw"]);
  assert.equal(c[1].master, "Master-PW-1");
  assert.equal(c[2].session, "FAKE-SESSION-KEY");
  const item = JSON.parse(Buffer.from(c[2].stdin.trim(), "base64").toString("utf8"));
  assert.equal(item.type, 1);
  assert.equal(item.name, "Workspace admin");
  assert.equal(item.login.username, "admin");
  assert.equal(item.login.password, "p a$s'w\"d");
  assert.deepEqual(item.login.uris, [{ match: null, uri: "https://ws.example:8456" }]);
  for (const x of c) {
    assert.ok(!x.args.join(" ").includes("Master-PW-1"), "master password never in argv");
    assert.ok(!x.args.join(" ").includes("p a$s"), "item password never in argv");
    assert.ok(!x.envKeys.includes("CROW_SESSION") && !x.envKeys.includes("CROW_HOME"), "minimal env");
  }
  assert.equal(c[0].master, null, "the master password is only in the login step's env");
});

test("REVIEW FOCUS 5 — failures are sentences; secrets never in argv; temp dir removed", async () => {
  for (const [mode, re] of [["wrong", /email or master password/i], ["twostep", /two-step login/i], ["down", /could not reach/i], ["createfail", /could not create/i]]) {
    const f = fakeCli(mode);
    const out = await V.saveToVault({ ...BASE, cliPath: f.cliPath, tmpRoot: f.tmpRoot });
    assert.equal(out.ok, false, mode);
    assert.match(out.reason, re, mode);
    assert.ok(!out.reason.includes("Master-PW-1") && !out.reason.includes("ECONNREFUSED") && !out.reason.includes("boom"), "no CLI output echoed");
    assert.deepEqual(readdirSync(f.tmpRoot), [], `${mode}: the private appdata dir is gone`);
    for (const x of f.calls()) assert.ok(!x.args.join(" ").includes("Master-PW-1"));
  }
});

test("S4 — a hung CLI is killed at the overall deadline and reported", async () => {
  const f = fakeCli("hang");
  const t0 = Date.now();
  const out = await V.saveToVault({ ...BASE, cliPath: f.cliPath, tmpRoot: f.tmpRoot, deadlineMs: 800 });
  assert.equal(out.ok, false);
  assert.match(out.reason, /took too long/i);
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(readdirSync(f.tmpRoot), []);
});

test("missing CLI or bad input → a reason, never a throw", async () => {
  assert.match((await V.saveToVault({ ...BASE, cliPath: "/nonexistent/bw.js" })).reason, /Bitwarden command-line tool/i);
  assert.match((await V.saveToVault({ ...BASE, cliPath: fakeCli().cliPath, email: "" })).reason, /email and master password/i);
});

test("vaultwardenStatus: installed + CLI present + decoded VAULTWARDEN_URL", () => {
  const bundles = mkdtempSync(join(tmpdir(), "crow-vwstatus-"));
  assert.deepEqual(V.vaultwardenStatus({ bundlesDir: bundles }), { installed: false, cliPath: null, serverUrl: null, serverOutdated: null });
  const vw = join(bundles, "vaultwarden");
  mkdirSync(join(vw, "node_modules", "@bitwarden", "cli", "build"), { recursive: true });
  writeFileSync(join(vw, ".env"), "VAULTWARDEN_URL='http://127.0.0.1:18097/'\n");
  assert.equal(V.vaultwardenStatus({ bundlesDir: bundles }).cliPath, null, "no bw.js yet");
  writeFileSync(join(vw, "node_modules", "@bitwarden", "cli", "build", "bw.js"), "");
  const st = V.vaultwardenStatus({ bundlesDir: bundles });
  assert.equal(st.installed, true);
  assert.match(st.cliPath, /@bitwarden\/cli\/build\/bw\.js$/);
  assert.equal(st.serverUrl, "http://127.0.0.1:18097");
});

test("S3 — stale crow-bw-* dirs (a crashed save's tokens) are swept; fresh ones are left alone", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-bwsweep-"));
  for (const n of ["crow-bw-old", "crow-bw-new", "other"]) mkdirSync(join(root, n));
  const old = new Date(Date.now() - 11 * 60 * 1000);
  utimesSync(join(root, "crow-bw-old"), old, old);
  utimesSync(join(root, "other"), old, old);
  assert.equal(V.sweepStaleVaultDirs(root), 1);
  assert.deepEqual(readdirSync(root).sort(), ["crow-bw-new", "other"]);
});

test("the default temp root is <CROW_HOME>/tmp, not /tmp", () => {
  const src = readFileSync(new URL("../servers/gateway/keychain/vault-save.js", import.meta.url), "utf8");
  assert.match(src, /tmpRoot = join\(CROW_HOME, "tmp"\)/);
  assert.match(src, /--core=0/, "core dumps off when prlimit exists");
});

test("m4 — an install still on an old Vaultwarden image is reported as needing a reinstall", () => {
  const bundles = mkdtempSync(join(tmpdir(), "crow-vwold-"));
  const vw = join(bundles, "vaultwarden");
  mkdirSync(vw, { recursive: true });
  writeFileSync(join(vw, "docker-compose.yml"), "services:\n  vaultwarden:\n    image: vaultwarden/server:1.32.7\n");
  assert.match(V.vaultwardenStatus({ bundlesDir: bundles }).serverOutdated, /Reinstall the Vaultwarden extension.*1\.32\.7/);
  writeFileSync(join(vw, "docker-compose.yml"), "services:\n  vaultwarden:\n    image: vaultwarden/server:1.37.3\n");
  assert.equal(V.vaultwardenStatus({ bundlesDir: bundles }).serverOutdated, null);
});
````

Append to `tests/bundle-version-refresh.test.js`:

````bash
cd ~/crow-wt-keychain && git apply <<'PATCH'
diff --git a/tests/bundle-version-refresh.test.js b/tests/bundle-version-refresh.test.js
index ec1b99e..498b0bd 100644
--- a/tests/bundle-version-refresh.test.js
+++ b/tests/bundle-version-refresh.test.js
@@ -474,6 +474,8 @@ describe("npm_required refresh at boot stays warn-only (hard-fail must never lea
     assert.deepEqual(errors, [], "a failing npm step at boot must never surface as an error — warn-only even for npm_required");
     assert.ok(repaired.some((r) => r.includes(id)), "the refresh itself must still be reported as having run");
     assert.ok(existsSync(destBundleDir(id)), "destDir must NOT be removed — boot-time refresh never hard-fails, unlike the install-time path");
+    assert.equal(JSON.parse(readAt(destBundleDir(id), "manifest.json")).version, "1.0.0",
+      "m4: the commit marker stays at the old version, so the next boot retries the npm step");
   });
 });
 
@@ -721,3 +723,52 @@ describe("B3 — build-context refresh hardening", () => {
     assert.equal(JSON.parse(readAt(destBundleDir(id), "manifest.json")).version, "0.2.0");
   });
 });
+
+// ---------------------------------------------------------------------------
+// C6 (Crow keychain): a docker bundle's package.json/package-lock.json ARE refreshed
+// (they are never bind-mounted into a container), so a dependency added in a version
+// bump (vaultwarden → @bitwarden/cli) is actually installed by the npm step.
+// ---------------------------------------------------------------------------
+describe("C6 — docker bundle refresh ships package.json + lock and installs the added dependency", () => {
+  test("added dep in a docker bundle → package files copied, npm install runs in the installed dir", async () => {
+    const id = "widget-docker-dep";
+    const repoRoot = freshRoot("crowrepo-dockerdep-");
+    put(repoRoot, `${id}/manifest.json`, JSON.stringify({
+      id, name: "WD", version: "1.1.0", type: "bundle", category: "misc", description: "d",
+      docker: { composefile: "docker-compose.yml" }, server: { command: "node", args: ["server/index.js"] },
+    }));
+    put(repoRoot, `${id}/docker-compose.yml`, "services: {}\n");
+    put(repoRoot, `${id}/server/index.js`, "v2\n");
+    put(repoRoot, `${id}/package.json`, JSON.stringify({ name: id, dependencies: { "@bitwarden/cli": "2026.9.1", zod: "^3.24.0" } }));
+    put(repoRoot, `${id}/package-lock.json`, JSON.stringify({ name: id, lockfileVersion: 3 }));
+    put(CROW_HOME, `bundles/${id}/manifest.json`, JSON.stringify({ id, version: "1.0.0", type: "bundle", docker: { composefile: "docker-compose.yml" } }));
+    put(CROW_HOME, `bundles/${id}/package.json`, JSON.stringify({ name: id, dependencies: { zod: "^3.24.0" } }));
+    put(CROW_HOME, `bundles/${id}/node_modules/zod/package.json`, JSON.stringify({ name: "zod", version: "3.24.0" }));
+    setInstalled([id]);
+    const runner = fakeRunner();
+    await repairInstalledBundleAssets({ appBundles: repoRoot, run: runner });
+    assert.deepEqual(JSON.parse(readAt(destBundleDir(id), "package.json")).dependencies["@bitwarden/cli"], "2026.9.1");
+    assert.ok(existsSync(join(destBundleDir(id), "package-lock.json")));
+    const npm = runner.calls.filter((c) => c.cmd === "npm");
+    assert.equal(npm.length, 1, "npm runs once for the added dependency");
+    assert.equal(npm[0].opts.cwd, destBundleDir(id));
+  });
+
+  test("m4 — an npm_required docker bundle refreshes with the lock file and no lifecycle scripts", async () => {
+    const id = "widget-docker-required";
+    const repoRoot = freshRoot("crowrepo-dockerreq-");
+    put(repoRoot, `${id}/manifest.json`, JSON.stringify({
+      id, name: "WR", version: "1.1.0", type: "bundle", category: "misc", description: "d", npm_required: true,
+      docker: { composefile: "docker-compose.yml" },
+    }));
+    put(repoRoot, `${id}/docker-compose.yml`, "services: {}\n");
+    put(repoRoot, `${id}/package.json`, JSON.stringify({ name: id, dependencies: { "@bitwarden/cli": "2026.9.1" } }));
+    put(repoRoot, `${id}/package-lock.json`, JSON.stringify({ name: id, lockfileVersion: 3 }));
+    put(CROW_HOME, `bundles/${id}/manifest.json`, JSON.stringify({ id, version: "1.0.0", type: "bundle", docker: { composefile: "docker-compose.yml" } }));
+    setInstalled([id]);
+    const runner = fakeRunner();
+    await repairInstalledBundleAssets({ appBundles: repoRoot, run: runner });
+    assert.deepEqual(runner.calls.filter((c) => c.cmd === "npm").map((c) => c.args), [["ci", "--omit=dev", "--ignore-scripts"]]);
+    assert.equal(JSON.parse(readAt(destBundleDir(id), "manifest.json")).version, "1.1.0");
+  });
+});
PATCH
git diff --stat
````

If Task 6 recorded wrong-password or two-step texts that the current `classifyLogin` regexes do not match, add one `assert.equal(V.classifyLogin("<exact text>"), V.VAULT_REASONS.<reason>)` line per text to `tests/keychain-vault-save.test.js` now, and widen the regex in Step 3.

- [ ] **Step 2: Run them to verify they fail**

```bash
npm test -- tests/keychain-vault-save.test.js        # FAIL: the placeholder returns {ok:false}
npm test -- tests/bundle-version-refresh.test.js     # FAIL: package.json not copied for the docker bundle
```

- [ ] **Step 3: Replace `servers/gateway/keychain/vault-save.js`**

````js
/**
 * Save one login item into the user's own local Vaultwarden with the official Bitwarden
 * CLI (@bitwarden/cli, a dependency of the vaultwarden bundle — installed beside it).
 *
 * Secrets: the master password travels ONLY in the login step's env (--passwordenv);
 * the item JSON travels on stdin (base64, `create item` reads it when no arg is given);
 * the session key travels in BW_SESSION. The vault email IS a `login` argument (bw has no
 * env/stdin form for it; spec R11). Every step runs with a minimal env inside a private
 * mkdtemp dir under <CROW_HOME>/tmp (BITWARDENCLI_APPDATA_DIR = HOME = that dir), removed
 * in finally; dirs a crash left behind are swept on the next run. When `prlimit` exists the
 * CLI runs with core dumps off, so a crash cannot write the master password to disk.
 * One overall deadline (90 s) bounds the whole save. Failures come back as fixed
 * sentences; CLI output is never echoed.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, chmodSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { BUNDLES_DIR, CROW_HOME } from "../bundles-config.js";
import { parseEnvText } from "../bundle-env-codec.js";

export const VAULT_REASONS = Object.freeze({
  missingCli: "The Bitwarden command-line tool is not installed. Update the Vaultwarden extension, then try again.",
  badInput: "Enter your vault email and master password.",
  wrongCredentials: "Vaultwarden did not accept that email or master password.",
  twoStep: "Your vault account uses two-step login, which Crow cannot complete. Add this password to your vault by hand (Settings → Passwords shows it).",
  unreachable: "Crow could not reach your Vaultwarden. Is it running?",
  timeout: "Vaultwarden took too long to answer.",
  createFailed: "Crow signed in to your vault but could not create the item.",
  failed: "Saving to Vaultwarden did not work.",
});

const STALE_MS = 10 * 60 * 1000;
const PRLIMIT = ["/usr/bin/prlimit", "/bin/prlimit"].find((p) => existsSync(p)) || null;

/**
 * serverOutdated: an install that predates vaultwarden 1.1.0 keeps its OLD compose file (a
 * docker refresh never touches docker-compose.yml), and Vaultwarden < 1.37 does not support
 * Bitwarden clients 2026.7.0+ (re-review m4) — say so instead of failing with "create failed".
 */
export function vaultwardenStatus({ bundlesDir = BUNDLES_DIR } = {}) {
  const dir = join(bundlesDir, "vaultwarden");
  if (!existsSync(dir)) return { installed: false, cliPath: null, serverUrl: null, serverOutdated: null };
  const cli = join(dir, "node_modules", "@bitwarden", "cli", "build", "bw.js");
  let url = "http://localhost:8097";
  try { url = parseEnvText(readFileSync(join(dir, ".env"), "utf8")).VAULTWARDEN_URL || url; } catch { /* default */ }
  let serverOutdated = null;
  try {
    const m = readFileSync(join(dir, "docker-compose.yml"), "utf8").match(/vaultwarden\/server:(\d+)\.(\d+)\.(\d+)/);
    if (m && (Number(m[1]) < 1 || (Number(m[1]) === 1 && Number(m[2]) < 37))) {
      serverOutdated = `Reinstall the Vaultwarden extension to update its server: saving to the vault needs Vaultwarden 1.37 or newer, and this install runs ${m[1]}.${m[2]}.${m[3]}. Your vault data is kept.`;
    }
  } catch { /* no compose file: nothing to judge */ }
  return { installed: true, cliPath: existsSync(cli) ? cli : null, serverUrl: url.replace(/\/+$/, ""), serverOutdated };
}

/** Remove crow-bw-* dirs older than 10 minutes (a crashed save's data.json holds tokens). */
export function sweepStaleVaultDirs(tmpRoot, { now = Date.now() } = {}) {
  let n = 0;
  try {
    for (const name of readdirSync(tmpRoot)) {
      if (!name.startsWith("crow-bw-")) continue;
      const p = join(tmpRoot, name);
      try { if (now - statSync(p).mtimeMs > STALE_MS) { rmSync(p, { recursive: true, force: true }); n++; } } catch {}
    }
  } catch { /* no tmp root yet */ }
  return n;
}

function runStep({ nodePath, cliPath, args, env, stdin = "", timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    const argv = [cliPath, ...args];
    try {
      child = PRLIMIT
        ? spawn(PRLIMIT, ["--core=0", "--", nodePath, ...argv], { env, stdio: ["pipe", "pipe", "pipe"] })
        : spawn(nodePath, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return resolve({ code: -1, stdout: "", stderr: "", spawnError: true });
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, Math.max(1, timeoutMs));
    child.stdout.on("data", (d) => { if (stdout.length < 65536) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < 65536) stderr += d; });
    child.on("error", () => { clearTimeout(timer); resolve({ code: -1, stdout, stderr, spawnError: true }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

export function classifyLogin(stderr) {
  if (/two[- ]?step|two[- ]?factor|2fa/i.test(stderr)) return VAULT_REASONS.twoStep;
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|connect|getaddrinfo|socket hang up/i.test(stderr)) return VAULT_REASONS.unreachable;
  if (/password|credential|incorrect|invalid|username/i.test(stderr)) return VAULT_REASONS.wrongCredentials;
  return VAULT_REASONS.failed;
}

export async function saveToVault({
  cliPath, serverUrl, email, masterPassword, item,
  deadlineMs = 90_000, tmpRoot = join(CROW_HOME, "tmp"), nodePath = process.execPath,
} = {}) {
  if (!cliPath || !existsSync(cliPath)) return { ok: false, reason: VAULT_REASONS.missingCli };
  if (!email || !masterPassword || !item || typeof item.password !== "string" || !serverUrl) return { ok: false, reason: VAULT_REASONS.badInput };
  const deadline = Date.now() + deadlineMs;
  let dir = null;
  try {
    mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
    chmodSync(tmpRoot, 0o700);
    sweepStaleVaultDirs(tmpRoot);
    dir = mkdtempSync(join(tmpRoot, "crow-bw-"));
    chmodSync(dir, 0o700);
    const baseEnv = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: dir, BITWARDENCLI_APPDATA_DIR: dir, BW_NOINTERACTION: "true", NODE_OPTIONS: "" };
    const step = (args, extra = {}, stdin = "") => runStep({ nodePath, cliPath, args, env: { ...baseEnv, ...extra }, stdin, timeoutMs: deadline - Date.now() });

    const cfg = await step(["config", "server", serverUrl]);
    if (cfg.timedOut) return { ok: false, reason: VAULT_REASONS.timeout };
    if (cfg.spawnError || cfg.code !== 0) return { ok: false, reason: VAULT_REASONS.failed };

    const login = await step(["login", email, "--passwordenv", "CROW_BW_MASTER", "--raw"], { CROW_BW_MASTER: masterPassword });
    if (login.timedOut) return { ok: false, reason: VAULT_REASONS.timeout };
    const session = login.stdout.trim();
    if (login.code !== 0 || !session) return { ok: false, reason: classifyLogin(login.stderr) };

    const payload = {
      type: 1, name: String(item.name || "Crow password").slice(0, 200), notes: item.notes || null,
      favorite: false, folderId: null, organizationId: null, collectionIds: null, reprompt: 0, fields: [],
      login: { username: item.username || null, password: item.password, totp: null, uris: item.url ? [{ match: null, uri: item.url }] : [] },
    };
    const created = await step(["create", "item"], { BW_SESSION: session }, Buffer.from(JSON.stringify(payload), "utf8").toString("base64"));
    if (Date.now() < deadline) await step(["logout"], { BW_SESSION: session });
    if (created.timedOut) return { ok: false, reason: VAULT_REASONS.timeout };
    if (created.code !== 0) return { ok: false, reason: VAULT_REASONS.createFailed };
    return { ok: true };
  } catch {
    return { ok: false, reason: VAULT_REASONS.failed };
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
}
````

- [ ] **Step 4: Refresh copies `package.json` + lock for docker bundles (review C6), and `npm_required` refreshes like the install path (P16).** No compose file in the repo mounts a `package.json`; check with `grep -l package.json bundles/*/docker-compose.yml`.

````bash
cd ~/crow-wt-keychain && git apply <<'PATCH'
diff --git a/servers/gateway/routes/bundles.js b/servers/gateway/routes/bundles.js
index 96cfb4d..2a4c356 100644
--- a/servers/gateway/routes/bundles.js
+++ b/servers/gateway/routes/bundles.js
@@ -699,8 +699,11 @@ async function refreshVersionedBundle({ id, appSrc, destDir, runner }) {
   // bundles get ONLY manifest.json/settings-section.js/server//panel//skills/
   // + validated manifest-declared roots, NEVER config/scripts/templates/src
   // (existing bundles bind-mount exactly those into live containers).
+  // package.json/package-lock.json are never bind-mounted into containers, so docker
+  // bundles get them too — otherwise a dependency added in a version bump (vaultwarden →
+  // @bitwarden/cli) would be "installed" against the OLD package.json (review C6).
   const topFiles = isDocker
-    ? ["manifest.json", "settings-section.js"]
+    ? ["manifest.json", "settings-section.js", "package.json", "package-lock.json"]
     : ["manifest.json", "package.json", "package-lock.json", "pyproject.toml", "uv.lock", "settings-section.js", "main.py", "run.sh", "config.py"];
   const dirs = isDocker
     ? ["server", "panel", "skills"]
@@ -792,11 +795,23 @@ async function refreshVersionedBundle({ id, appSrc, destDir, runner }) {
   // npm step: narrow, added-dep-name-only trigger; warn-only; via the
   // injected runner so tests never shell out to a real npm.
   if (bundleNeedsNpmInstall(appSrc, destDir)) {
+    // npm_required bundles (vaultwarden: the Bitwarden CLI) install exactly as the install
+    // path does — lock file, no lifecycle scripts — and are never blessed half-installed:
+    // on failure the installed manifest (the commit marker) keeps the OLD version, so the
+    // next boot retries (re-review m4). Still warn-only: boot never hard-fails.
+    const required = repoManifest.npm_required === true;
+    const npmArgs = required
+      ? [existsSync(join(destDir, "package-lock.json")) ? "ci" : "install", "--omit=dev", "--ignore-scripts"]
+      : ["install", "--omit=dev"];
     try {
-      await runner("npm", ["install", "--omit=dev"], { cwd: destDir });
-      touched.push("npm install");
+      await runner("npm", npmArgs, { cwd: destDir });
+      touched.push(`npm ${npmArgs[0]}`);
     } catch (err) {
-      console.warn(`[bundles] npm install failed for ${id}: ${err.message}`);
+      console.warn(`[bundles] npm ${npmArgs[0]} failed for ${id}: ${err.message}`);
+      if (required) {
+        console.warn(`[bundles] ${id}: left at ${oldVersion} so the next boot retries the dependency install`);
+        return { oldVersion, newVersion: oldVersion, touched: [...touched, "npm failed — will retry"] };
+      }
     }
   }
 
PATCH
git diff --stat
````

- [ ] **Step 5: Run the tests**

```bash
npm test -- tests/keychain-vault-save.test.js
npm test -- tests/keychain-api.test.js
npm test -- tests/bundle-version-refresh.test.js
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/keychain-vault-save.test.js
git commit servers/gateway/keychain/vault-save.js tests/keychain-vault-save.test.js servers/gateway/routes/bundles.js tests/bundle-version-refresh.test.js -m "feat(keychain): Vaultwarden save via the Bitwarden CLI (env/stdin only, CROW_HOME/tmp, swept, no cores, 90 s, outdated-server notice); docker refresh ships package files, npm_required refresh retries"
git show --stat HEAD
```

---

### Task 8: Installer wiring — install, Configure and uninstall talk to the keychain

**Files:**
- Create: `servers/gateway/keychain/install-hooks.js`, `tests/keychain-install-wiring.test.js`
- Modify: `servers/gateway/routes/bundles.js`:
  - imports (`planGeneratedEnv` replaces `resolveGeneratedEnv`);
  - `runInstallJob` (keychain first, P7);
  - `POST /bundles/api/install`;
  - `POST /bundles/api/env`;
  - uninstall.

**Interfaces:**
- Consumes: Task 3 `planGeneratedEnv`, `keychainGeneratedKeys`, `keychainEligibleKeys`, `expandKeychainTemplate`; Task 4 store and key; Task 7 `vaultwardenStatus`, `saveToVault`, `VAULT_REASONS`.
- Produces:
  - `sanitizeKeychainRequest(raw, { localSession }) → { save, vault }`
  - `recordKeychainForInstall({ bundleId, manifest, env, minted, keychainReq, log }) → { saved, firstView, vault, mintedSaved }` (never throws)
  - `markBundleKeychainRemoved(bundleId) → number`
  - `_setKeychainDepsForTest({ openDb?, writeKey?(db), vault?, audit? } | null)`
    - the default `writeKey` is `ensureWriteKey`, with an audit + notification on a re-created key;
    - a damaged key makes a `keychain:true` install fail with "keychain key file unreadable at <path>" and nothing written;
    - typed fields are then skipped, and the install continues.
  - `runInstallJob(…, { …, keychain = null })`, which returns `{ ok:false, reason:"could not save the generated password to Crow keychain; nothing was written — retry the install" }` when a generated token cannot be saved
  - the Configure response gains `keychain: { saved, vault, messages } | null`

- [ ] **Step 1: Write the failing test** — create `tests/keychain-install-wiring.test.js`:

````js
/** Installer ↔ keychain wiring (Task 6). Real init-db in a scratch data dir; no docker. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-kcwire-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-kcwire-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe" });

const CROW_HOME = process.env.CROW_HOME;
const B = await import("../servers/gateway/routes/bundles.js");
const H = await import("../servers/gateway/keychain/install-hooks.js");
const K = await import("../servers/gateway/keychain/store.js");
const P = await import("../servers/gateway/keychain/argon2-phc.js");
const { parseEnvText } = await import("../servers/gateway/bundle-env-codec.js");
const { createDbClient } = await import("../servers/db.js");
const { loadKeychainKey } = await import("../servers/gateway/keychain/key.js");
const S = await import("../servers/gateway/bundle-env-secrets.js");

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-kcwire-app-"));
B._setAppBundlesForTest(FIXTURES);
B._setAppEnvPathForTest(join(mkdtempSync(join(tmpdir(), "crow-kcwire-gw-")), ".env"));
const vaultCalls = [];
let vaultResult = { ok: true };
H._setKeychainDepsForTest({ vault: { status: () => ({ installed: true, cliPath: "/fake/bw.js", serverUrl: "http://127.0.0.1:18097" }), save: async (o) => { vaultCalls.push(o); return vaultResult; } } });
after(() => {
  H._setKeychainDepsForTest(null);
  B._setAppEnvPathForTest(null);
  for (const d of [CROW_HOME, process.env.CROW_DATA_DIR, FIXTURES]) rmSync(d, { recursive: true, force: true });
});

const MANIFEST = (id) => ({
  id, name: "Demo Vault", description: "d", type: "bundle", category: "infrastructure", version: "0.1.0",
  env_vars: [
    { name: "DEMO_DOMAIN", default: "http://localhost:18097" },
    { name: "DEMO_ADMIN_TOKEN", secret: true, generate: "secret", keychain: true, store_as: "argon2id", keychain_label: "admin token", keychain_url: "${DEMO_DOMAIN}/admin" },
    { name: "DEMO_USER", default: "admin" },
    { name: "DEMO_PASSWORD", secret: true, generatable: true, propagate: false, keychain_label: "admin password", keychain_username: "${DEMO_USER}" },
    { name: "DEMO_API_KEY", secret: true },
  ],
});
function fixture(id) {
  mkdirSync(join(FIXTURES, id), { recursive: true });
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify(MANIFEST(id)));
  return MANIFEST(id);
}
const db = () => createDbClient();
const ID = () => loadKeychainKey();

test("sanitizeKeychainRequest: only local sessions, only env-name keys, vault needs both fields", () => {
  assert.deepEqual(H.sanitizeKeychainRequest({ save: ["A"], vault: { email: "e", password: "p" } }, { localSession: false }), { save: [], vault: null });
  assert.deepEqual(H.sanitizeKeychainRequest({ save: ["A", "bad key", 3], vault: { email: " e@x ", password: "p" } }, { localSession: true }), { save: ["A"], vault: { email: "e@x", password: "p" } });
  assert.deepEqual(H.sanitizeKeychainRequest({ save: ["A"], vault: { email: "e", password: "" } }, { localSession: true }).vault, null);
  assert.deepEqual(S.keychainEligibleKeys(MANIFEST("x")), ["DEMO_PASSWORD"], "the third-party DEMO_API_KEY is never eligible");
});

test("install: generated token → keychain (first view) + PHC hash in .env; checked human field → keychain; unchecked is not saved", async () => {
  const id = "demo-kc-a"; const manifest = fixture(id);
  const job = B._createJobForTest(id, "install");
  const keychain = { save: ["DEMO_PASSWORD", "DEMO_API_KEY"], vault: null };
  const out = await B.runInstallJob(id, { DEMO_DOMAIN: "http://localhost:18097", DEMO_USER: "kevin", DEMO_PASSWORD: "p a$s'w\"d #1", DEMO_API_KEY: "api-123" }, { job, installedSnapshot: [], consentVerified: false, manifest, keychain });
  assert.equal(out.ok, true, out.reason);
  const env = parseEnvText(readFileSync(join(CROW_HOME, "bundles", id, ".env"), "utf8"));
  assert.match(env.DEMO_ADMIN_TOKEN, /^\$argon2id\$v=19\$m=65540,t=3,p=4\$/);
  assert.equal(env.DEMO_PASSWORD, "p a$s'w\"d #1", "the wide-charset value round-trips through the installer");
  const d = db();
  try {
    const entries = await K.listEntries(d);
    const byKey = Object.fromEntries(entries.map((e) => [e.env_key, e]));
    assert.deepEqual(Object.keys(byKey).sort(), ["DEMO_ADMIN_TOKEN", "DEMO_PASSWORD"], "DEMO_API_KEY is not eligible even when the request asks");
    assert.equal(byKey.DEMO_ADMIN_TOKEN.label, "Demo Vault — admin token");
    assert.equal(byKey.DEMO_ADMIN_TOKEN.url, "http://localhost:18097/admin");
    assert.equal(byKey.DEMO_ADMIN_TOKEN.first_view_pending, true);
    assert.equal(byKey.DEMO_PASSWORD.username, "kevin");
    assert.equal(byKey.DEMO_PASSWORD.first_view_pending, false);
    const token = await K.openEntrySecret(d, ID(), byKey.DEMO_ADMIN_TOKEN.id);
    assert.equal(P.verifyArgon2idPhc(token, env.DEMO_ADMIN_TOKEN), true, "the keychain plaintext matches the .env hash");
    assert.equal(await K.openEntrySecret(d, ID(), byKey.DEMO_PASSWORD.id), "p a$s'w\"d #1");
    const ev = (await d.execute("SELECT event_type, details FROM audit_log WHERE event_type = 'keychain_save'")).rows;
    assert.equal(ev.length, 2);
    assert.ok(!JSON.stringify(ev).includes(token) && !JSON.stringify(ev).includes("p a$s"));
  } finally { d.close(); }
  const logText = job.log.join("\n");
  assert.match(logText, /Saved 2 password\(s\) to Crow keychain/);
  assert.ok(!logText.includes("p a$s"), "no value in the job log");
});

test("REVIEW FOCUS 5 (install) — a failed vault save never fails the install or leaks", async () => {
  const id = "demo-kc-b"; const manifest = fixture(id);
  vaultCalls.length = 0;
  vaultResult = { ok: false, reason: "Vaultwarden did not accept that email or master password." };
  const job = B._createJobForTest(id, "install");
  const keychain = { save: ["DEMO_PASSWORD"], vault: { email: "k@example.invalid", password: "Master-PW-9" } };
  const out = await B.runInstallJob(id, { DEMO_PASSWORD: "Typed-Pass-123" }, { job, installedSnapshot: [], consentVerified: false, manifest, keychain });
  assert.equal(out.ok, true, "the install itself succeeds");
  assert.ok(vaultCalls.length >= 1);
  assert.equal(vaultCalls[0].masterPassword, "Master-PW-9");
  assert.match(job.log.join("\n"), /Vaultwarden save did not complete: Vaultwarden did not accept/);
  assert.ok(!JSON.stringify(job).includes("Master-PW-9") && !JSON.stringify(job).includes("Typed-Pass-123"));
  assert.equal(keychain.vault, null, "the master password is dropped after use");
  vaultResult = { ok: true };
});

test("reinstall reuses the generated token: no new plaintext, no first view, entry reactivated after uninstall", async () => {
  const id = "demo-kc-c"; const manifest = fixture(id);
  const install = async () => {
    const job = B._createJobForTest(id, "install");
    const out = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
    assert.equal(out.ok, true, out.reason);
  };
  await install();
  const d = db();
  try {
    const e1 = (await K.listEntries(d, { keyId: ID().id })).find((e) => e.bundle_id === id);
    await K.consumeFirstView(d, ID(), e1.id);
    assert.equal(await H.markBundleKeychainRemoved(id), 1);
    assert.equal((await K.getEntry(d, e1.id)).status, "extension_removed");
    rmSync(join(CROW_HOME, "bundles", id), { recursive: true, force: true });
    await install();
    const e2 = await K.getEntry(d, e1.id);
    assert.equal(e2.status, "active");
    assert.equal(e2.first_view_pending, false, "nothing new was minted, so nothing new to show");
    assert.equal((await K.listEntries(d, { keyId: ID().id })).filter((e) => e.bundle_id === id).length, 1);
  } finally { d.close(); }
});

test("Configure: a local session saves a checked human field; a peer-signed request never does", async () => {
  const id = "demo-kc-d"; const manifest = MANIFEST(id);
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, ".env"), "DEMO_USER=admin\n");
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers["x-test-peer"]) req.crossHostAuth = { sourceInstanceId: "peer" };
    else req.dashboardSession = "S";
    next();
  });
  app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/bundles/api/env`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const peer = await post({ bundle_id: id, env_vars: { DEMO_PASSWORD: "Peer-Typed-1" }, keychain: { save: ["DEMO_PASSWORD"] } }, { "x-test-peer": "1" });
    assert.equal(peer.status, 200, JSON.stringify(peer.body));
    const d = db();
    try { assert.equal((await K.listEntries(d, { keyId: ID().id })).filter((e) => e.bundle_id === id).length, 0, "peer request saved nothing"); } finally { d.close(); }
    const local = await post({ bundle_id: id, env_vars: { DEMO_PASSWORD: "Local-Typed-1" }, keychain: { save: ["DEMO_PASSWORD"] } });
    assert.equal(local.status, 200, JSON.stringify(local.body));
    assert.equal(local.body.keychain.saved, 1);
    const d2 = db();
    try {
      const e = (await K.listEntries(d2, { keyId: ID().id })).find((x) => x.bundle_id === id);
      assert.equal(await K.openEntrySecret(d2, ID(), e.id), "Local-Typed-1");
    } finally { d2.close(); }
  } finally { server.close(); }
});

test("C5 — if the generated token cannot be saved, the install fails with NOTHING persisted; a retry mints a new token", async () => {
  const id = "demo-kc-e"; const manifest = fixture(id);
  H._setKeychainDepsForTest({ writeKey: async () => null, vault: { status: () => ({ installed: false }), save: async () => ({ ok: true }) } });
  try {
    const job = B._createJobForTest(id, "install");
    const out = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
    assert.equal(out.ok, false);
    assert.match(out.reason, /nothing was written/);
    assert.equal(existsSync(join(CROW_HOME, "bundles", id)), false, "install dir removed");
    assert.equal(existsSync(S.retainedEnvPath(CROW_HOME, id)), false, "no orphan hash in the retained copy");
  } finally {
    H._setKeychainDepsForTest({ vault: { status: () => ({ installed: true, cliPath: "/fake/bw.js", serverUrl: "http://127.0.0.1:18097" }), save: async (o) => { vaultCalls.push(o); return vaultResult; } } });
  }
  const job = B._createJobForTest(id, "install");
  assert.equal((await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest })).ok, true);
  const env = parseEnvText(readFileSync(join(CROW_HOME, "bundles", id, ".env"), "utf8"));
  const d = db();
  try {
    const e = (await K.listEntries(d, { keyId: ID().id })).find((x) => x.bundle_id === id);
    assert.equal(P.verifyArgon2idPhc(await K.openEntrySecret(d, ID(), e.id), env.DEMO_ADMIN_TOKEN), true, "the saved token matches the persisted hash");
  } finally { d.close(); }
});

test("m1 — a damaged key file with entries: a keychain:true install fails with the file path in the log, nothing written", async () => {
  const { keychainKeyPath } = await import("../servers/gateway/keychain/key.js");
  const id = "demo-kc-f"; const manifest = fixture(id);
  const p = keychainKeyPath(CROW_HOME);
  const { readFileSync: rf, writeFileSync: wf } = await import("node:fs");
  const saved = rf(p, "utf8");
  wf(p, "");
  try {
    const job = B._createJobForTest(id, "install");
    const out = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
    assert.equal(out.ok, false);
    assert.ok(job.log.some((l) => l.includes(`unreadable at ${p}`)), job.log.join("\n"));
    assert.equal(existsSync(S.retainedEnvPath(CROW_HOME, id)), false);
  } finally { wf(p, saved); }
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/keychain-install-wiring.test.js`
Expected: FAIL with `Cannot find module '…/keychain/install-hooks.js'`.

- [ ] **Step 3: Create `servers/gateway/keychain/install-hooks.js`**

````js
/**
 * The installer's side of the keychain (spec §5.7).
 *  - generated keychain:true tokens (planGeneratedEnv().minted) are ALWAYS saved, with a
 *    30-minute first-view grant, and they are saved FIRST: if that save fails the caller
 *    aborts before any hash reaches .env or the retained copy (review C5), so a retry
 *    simply mints a new token instead of leaving an unusable hash behind;
 *  - typed fields are saved only when the manifest opts them in (generatable / keychain,
 *    Kevin Q1) AND the request is a LOCAL dashboard session that ticked "Save to Crow
 *    keychain" (sanitizeKeychainRequest); a failure there is a job-log line, not a failure;
 *  - the optional vault copy uses the typed vault credentials once, then drops them.
 */
import { createDbClient, auditLog } from "../../db.js";
import { keychainGeneratedKeys, keychainEligibleKeys, expandKeychainTemplate } from "../bundle-env-secrets.js";
import { createNotification } from "../../shared/notifications.js";
import { saveExtensionSecret, reactivateBundleEntries, markBundleRemoved, ensureWriteKey } from "./store.js";
import { vaultwardenStatus, saveToVault, VAULT_REASONS } from "./vault-save.js";

let _override = null;
export function _setKeychainDepsForTest(deps) { _override = deps || null; }
function deps() {
  return {
    openDb: () => createDbClient(),
    // The key to save with (created on first use; refuses a damaged key while entries exist).
    writeKey: (db) => ensureWriteKey(db, {
      onNewKey: async ({ orphaned }) => {
        await auditLog(db, "keychain_key_created", { details: { orphaned } });
        try { await createNotification(db, { title: "New Crow keychain key created", body: `${orphaned} saved password(s) were sealed with a key that is no longer on this machine. Import an Export file in Settings → Passwords to recover them.`, type: "system", source: "keychain" }); } catch {}
      },
    }),
    vault: { status: vaultwardenStatus, save: saveToVault },
    audit: auditLog,
    ...(_override || {}),
  };
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function sanitizeKeychainRequest(raw, { localSession }) {
  if (!localSession || !raw || typeof raw !== "object") return { save: [], vault: null };
  const save = Array.isArray(raw.save) ? raw.save.filter((k) => typeof k === "string" && ENV_NAME.test(k)).slice(0, 32) : [];
  let vault = null;
  const v = raw.vault;
  if (v && typeof v === "object" && typeof v.email === "string" && typeof v.password === "string" && v.email.trim() && v.password) {
    vault = { email: v.email.trim().slice(0, 320), password: v.password.slice(0, 1024) };
  }
  return { save, vault };
}

function templateEnv(manifest, env) {
  const out = {};
  for (const v of manifest?.env_vars || []) if (v && v.default !== undefined && v.default !== null) out[v.name] = String(v.default);
  return { ...out, ...(env || {}) };
}

/**
 * @returns {Promise<{ saved: number, firstView: number[], vault: {ok:boolean, reason?:string}|null, mintedSaved: boolean }>}
 * Never throws. `mintedSaved` is false only when a GENERATED token could not be saved —
 * the caller must then abort the install without persisting anything.
 */
export async function recordKeychainForInstall({ bundleId, manifest, env, minted, keychainReq, log = () => {} }) {
  const d = deps();
  const out = { saved: 0, firstView: [], vault: null, mintedSaved: true };
  const specs = new Map((manifest?.env_vars || []).map((v) => [v.name, v]));
  const eligible = new Set(keychainEligibleKeys(manifest));
  const tEnv = templateEnv(manifest, env);
  const mintedList = Object.entries(minted || {}).map(([k, plain]) => ({ k, plain, origin: "generated", firstView: true }));
  const typedList = (keychainReq?.save || [])
    .filter((k) => eligible.has(k) && typeof env?.[k] === "string" && env[k] !== "")
    .map((k) => ({ k, plain: env[k], origin: "typed", firstView: false }));
  const reused = keychainGeneratedKeys(manifest).filter((k) => !Object.hasOwn(minted || {}, k));
  if (mintedList.length === 0 && typedList.length === 0 && reused.length === 0) return out;

  let db;
  const saved = [];
  const saveOne = async (key, s) => {
    const spec = specs.get(s.k) || {};
    const label = `${manifest?.name || bundleId} — ${spec.keychain_label || s.k}`;
    const username = expandKeychainTemplate(spec.keychain_username, tEnv);
    const url = expandKeychainTemplate(spec.keychain_url, tEnv);
    const r = await saveExtensionSecret(db, key, { bundleId, envKey: s.k, label, username, url, secret: s.plain, origin: s.origin, firstView: s.firstView });
    out.saved++;
    if (s.firstView) out.firstView.push(r.id);
    saved.push({ id: r.id, label, username, url, plain: s.plain, envKey: s.k });
    await d.audit(db, "keychain_save", { details: { entry_id: r.id, bundle_id: bundleId, env_key: s.k, origin: s.origin } });
  };
  try {
    db = d.openDb();
    if (reused.length) await reactivateBundleEntries(db, bundleId, reused);
    let key = null;
    try {
      if (mintedList.length || typedList.length) key = await d.writeKey(db);
      for (const s of mintedList) await saveOne(key, s);
    } catch (err) {
      if (mintedList.length) {
        out.mintedSaved = false;
        log(err?.code === "KEYCHAIN_KEY_INVALID"
          ? `Crow keychain key file unreadable at ${err.path}: restore it (or delete the saved passwords in Settings → Passwords), then install again. Nothing was written.`
          : `Could not save the generated password(s) to Crow keychain (${err?.code || err?.name || "error"}); nothing was written, so retrying the install mints a new one`);
        return out;
      }
      log(err?.code === "KEYCHAIN_KEY_INVALID"
        ? `Passwords were not saved to Crow keychain: its key file is unreadable at ${err.path}. The install continues.`
        : `Passwords were not saved to Crow keychain (${err?.code || err?.name || "error"}). The install continues.`);
    }
    for (const s of key ? typedList : []) {
      try { await saveOne(key, s); } catch (err) { log(`Could not save ${s.k} to Crow keychain (${err?.code || err?.name || "error"}); the install continues`); }
    }
    if (out.saved) log(`Saved ${out.saved} password(s) to Crow keychain (Settings → Passwords)`);

    if (keychainReq?.vault && saved.length) {
      const st = d.vault.status();
      if (!st || !st.installed || !st.cliPath) {
        out.vault = { ok: false, reason: VAULT_REASONS.missingCli };
      } else if (st.serverOutdated) {
        out.vault = { ok: false, reason: st.serverOutdated };
      } else {
        out.vault = { ok: true };
        for (const e of saved) {
          const r = await d.vault.save({
            cliPath: st.cliPath, serverUrl: st.serverUrl, email: keychainReq.vault.email, masterPassword: keychainReq.vault.password,
            item: { name: e.label, username: e.username, password: e.plain, url: e.url, notes: `Saved by Crow (${bundleId} / ${e.envKey})` },
          });
          await d.audit(db, "keychain_vault_save", { details: { entry_id: e.id, bundle_id: bundleId, env_key: e.envKey, ok: !!r.ok, reason: r.ok ? null : r.reason } });
          if (!r.ok) { out.vault = { ok: false, reason: r.reason }; break; }
        }
      }
      log(out.vault.ok ? "Vaultwarden: saved to your vault" : `Vaultwarden save did not complete: ${out.vault.reason} The password is in Crow keychain; you can retry from Settings → Passwords.`);
    }
  } catch (err) {
    if (mintedList.length && out.firstView.length < mintedList.length) out.mintedSaved = false;
    log(`Crow keychain save did not complete (${err?.code || err?.name || "error"})`);
  } finally {
    if (keychainReq) keychainReq.vault = null;
    for (const e of saved) e.plain = null;
    try { db?.close(); } catch {}
  }
  return out;
}

export async function markBundleKeychainRemoved(bundleId) {
  let db;
  try {
    db = deps().openDb();
    return await markBundleRemoved(db, bundleId);
  } catch {
    return 0;
  } finally {
    try { db?.close(); } catch {}
  }
}
````

- [ ] **Step 4: Wire `bundles.js`**

````bash
cd ~/crow-wt-keychain && git apply <<'PATCH'
diff --git a/servers/gateway/routes/bundles.js b/servers/gateway/routes/bundles.js
index 2a4c356..6ebbeab 100644
--- a/servers/gateway/routes/bundles.js
+++ b/servers/gateway/routes/bundles.js
@@ -53,8 +53,9 @@ import {
 } from "../bundles-config.js";
 import { isModelOrchestrationDisabled, isModelBundleManifest } from "../../shared/model-orchestration.js";
 import { envValueProblem, encodeEnvValue, formatEnvLines, updateEnvText, pathEnvKeys } from "../bundle-env-codec.js";
+import { sanitizeKeychainRequest, recordKeychainForInstall, markBundleKeychainRemoved } from "../keychain/install-hooks.js";
 import { precreateDirs, runPostInstall, hookEnv, spawnGroup, pullTimeoutMs, resolveComposeProject, classifyProjectOwners } from "../bundle-lifecycle.js";
-import { resolveGeneratedEnv, stripGeneratedKeys, parseEnvText, writePrivateFile, gatewayExcludedKeys, envPatternViolation, breachedValueViolation } from "../bundle-env-secrets.js";
+import { planGeneratedEnv, stripGeneratedKeys, parseEnvText, writePrivateFile, gatewayExcludedKeys, envPatternViolation, breachedValueViolation } from "../bundle-env-secrets.js";
 
 /**
  * Seed an STT/TTS profile from a bundle manifest's {stt,tts}ProfileSeed into the
@@ -1956,7 +1957,7 @@ export function writeInstallEnv(destDir, envVars, manifest, log = () => {}, { ba
   }
 }
 
-export async function runInstallJob(bundleId, envVars, { job, installedSnapshot, consentVerified, manifest }) {
+export async function runInstallJob(bundleId, envVars, { job, installedSnapshot, consentVerified, manifest, keychain = null }) {
   let needsRestart = false;
   // Set when `docker compose up` fails. The install does NOT stop there: the
   // non-container steps (gateway env, MCP registration, panel + routes,
@@ -2054,7 +2055,8 @@ export async function runInstallJob(bundleId, envVars, { job, installedSnapshot,
     // never shown, never sent to the gateway .env. reqEnv is the request env with
     // generated keys stripped, and is the only request env used below.
     const reqEnv = stripGeneratedKeys(manifest, envVars);
-    const generated = resolveGeneratedEnv(bundleId, manifest, { destDir, crowHome: CROW_HOME });
+    const plan = planGeneratedEnv(bundleId, manifest, { destDir, crowHome: CROW_HOME });
+    const generated = plan.env;
     const writeEnv = { ...(reqEnv || {}), ...generated };
     let installEnv = writeEnv;
     let baseText = null;
@@ -2070,6 +2072,17 @@ export async function runInstallJob(bundleId, envVars, { job, installedSnapshot,
       } catch { /* unreadable base: fall back to provided values only */ }
       if (baseText !== null) installEnv = { ...parseEnvText(baseText), ...writeEnv };
     }
+    // Keychain FIRST (review C5, plan P7): a generated token's plaintext must be safely in
+    // the keychain before its hash reaches .env or the retained copy; if that save fails,
+    // abort with nothing persisted so a retry mints a fresh token. Typed fields and the
+    // optional vault copy run here too — before any pull, so the master password lives
+    // for seconds and a later compose failure still leaves the password saved.
+    const kc = await recordKeychainForInstall({ bundleId, manifest, env: installEnv, minted: plan.minted, keychainReq: keychain, log: (m) => appendLog(job, m) });
+    if (!kc.mintedSaved) {
+      rmSync(destDir, { recursive: true, force: true });
+      return { ok: false, reason: "could not save the generated password to Crow keychain; nothing was written — retry the install" };
+    }
+    plan.persist();
     writeInstallEnv(destDir, writeEnv, manifest, (msg) => appendLog(job, msg), { baseText });
     if (Object.keys(generated).length > 0) {
       appendLog(job, `Generated ${Object.keys(generated).length} internal secret(s) — stored at mode 600, never shown`);
@@ -2763,6 +2776,7 @@ export default function bundlesRouter() {
     }
 
     // Create job for async tracking
+    const keychainReq = sanitizeKeychainRequest(req.body?.keychain, { localSession: !!req.dashboardSession && !req.crossHostAuth });
     const job = createJob(bundle_id, "install");
     res.json({ ok: true, job_id: job.id, message: `Installing ${bundle_id}...` });
 
@@ -2774,6 +2788,7 @@ export default function bundlesRouter() {
         installedSnapshot: v.installed,
         consentVerified: v.consentVerified,
         manifest: v.manifest,
+        keychain: keychainReq,
       });
       if (!out.ok) {
         finishJob(job, "failed");
@@ -3047,6 +3062,8 @@ export default function bundlesRouter() {
         const installed = getInstalled().filter((i) => i.id !== bundle_id);
         saveInstalled(installed);
         appendLog(job, "Installation record removed");
+        const keptPasswords = await markBundleKeychainRemoved(bundle_id);
+        if (keptPasswords) appendLog(job, `Kept ${keptPasswords} saved password(s) in Crow keychain, marked "extension removed" (Settings → Passwords)`);
 
         let notifDb;
         try {
@@ -3257,6 +3274,11 @@ export default function bundlesRouter() {
 
       Object.assign(existing, env_vars); // the effective env after this save
       writePrivateFile(envPath, updateEnvText(oldEnvText, env_vars, { pathKeys: pathEnvKeys(getInstalledFirstManifest(bundle_id)) }));
+      const keychainReq = sanitizeKeychainRequest(req.body?.keychain, { localSession: !!req.dashboardSession && !req.crossHostAuth });
+      const kcLog = [];
+      const kc = keychainReq.save.length
+        ? await recordKeychainForInstall({ bundleId: bundle_id, manifest: getInstalledFirstManifest(bundle_id), env: existing, minted: {}, keychainReq, log: (m) => kcLog.push(m) })
+        : null;
 
       // Also configure the MCP child, which reads mcp-addons.json — not this .env.
       const mcpUpdated = applyEnvToMcpAddons(bundle_id, env_vars);
@@ -3316,6 +3338,7 @@ export default function bundlesRouter() {
         applies_on_next_start: appliesOnNextStart,
         bundle_restart_keys: bundleRestartKeys,
         needs_config: needsConfigKeys(bundle_id),
+        keychain: kc ? { saved: kc.saved, vault: kc.vault, messages: kcLog } : null,
       });
     } catch (err) {
       console.warn(`[bundles] POST /bundles/api/env failed: ${err?.message || err}`);
PATCH
git diff --stat
````

- [ ] **Step 5: Run the tests**

```bash
npm test -- tests/keychain-install-wiring.test.js
npm test -- tests/bundle-env-secrets.test.js
npm test -- tests/bundle-env-scoping.test.js
npm test -- tests/bundles-install-set.test.js
npm test -- tests/bundle-env-codec.test.js
grep -n "resolveGeneratedEnv(" servers/gateway/routes/bundles.js || echo "installer uses planGeneratedEnv only"
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/keychain/install-hooks.js tests/keychain-install-wiring.test.js
git commit servers/gateway/keychain/install-hooks.js tests/keychain-install-wiring.test.js servers/gateway/routes/bundles.js -m "feat(keychain): install saves generated tokens first (abort, nothing written, on failure), opt-in typed fields, optional vault copy; uninstall keeps entries"
git show --stat HEAD
```

---

### Task 9: Extensions modal — opt-in Generate, Show/Copy everywhere, keychain box, vault block, first-view banner

**Files:**
- Create: `servers/gateway/dashboard/shared/password-generator.js`, `tests/extensions-keychain-client.test.js`
- Modify:
  - `servers/gateway/dashboard/panels/extensions/html.js`: `keychainPending` param, `#ext-keychain-config`, banner, and the `#addon-registry` blob gains `generatable` / `keychain` / `pattern` (P9);
  - `servers/gateway/dashboard/panels/extensions.js`;
  - `servers/gateway/dashboard/panels/extensions/client.js`;
  - `servers/gateway/dashboard/shared/i18n.js` (`keychain.*`).

**Interfaces:**
- Produces:
  - `generatePassword(length, pattern, randomUint32): string|null` (ES5, backtick-free, embedded with `.toString()`)
  - `PASSWORD_LENGTH = 24`
- The install / Configure request gains `keychain: { save: string[], vault?: { email, password } }`.
- The client calls `POST /dashboard/keychain/api/first-view { id }`.

- [ ] **Step 1: Write the failing test** — create `tests/extensions-keychain-client.test.js`:

````js
/**
 * Extensions modal keychain behaviour, EXECUTED (Task 7): real markup (buildExtensionsHTML)
 * + real client (extensionsClientJS) in linkedom + node:vm, network stubbed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto, randomInt } from "node:crypto";
import { parseHTML } from "linkedom";

import { buildExtensionsHTML } from "../servers/gateway/dashboard/panels/extensions/html.js";
import { extensionsClientJS } from "../servers/gateway/dashboard/panels/extensions/client.js";
import { generatePassword, PASSWORD_LENGTH } from "../servers/gateway/dashboard/shared/password-generator.js";

const CLIENT_HTML = extensionsClientJS("en");
const CLIENT_JS = CLIENT_HTML.slice(CLIENT_HTML.indexOf("<script>") + "<script>".length, CLIENT_HTML.lastIndexOf("</script>"));
const OVERLAY_HTML = CLIENT_HTML.slice(0, CLIENT_HTML.indexOf("<script>"));
const WIDE = "^[^\\x00-\\x1f\\x7f]{12,128}$";

const AVAILABLE = [
  { id: "demo", name: "Demo", description: "d", type: "bundle", category: "productivity", version: "1.0.0", author: "Crow", tags: [],
    env_vars: [
      { name: "DEMO_USER", description: "user", default: "admin" },
      { name: "DEMO_PASSWORD", description: "admin password", secret: true, generatable: true, propagate: false, pattern: WIDE },
      { name: "DEMO_API_KEY", description: "a third-party API key", secret: true },
      { name: "DEMO_TOKEN", description: "generated", secret: true, generate: "secret", keychain: true },
    ] },
  { id: "vaultwarden", name: "Vaultwarden", description: "vault", type: "bundle", category: "infrastructure", version: "1.1.0", author: "Crow", tags: [] },
];

function boot({ installed = {}, keychainPending = [], needsConfig = {}, fetchImpl } = {}) {
  const { viewsHtml, addonRegistryScript, collectionsScript } = buildExtensionsHTML({
    installed, available: AVAILABLE, collections: [], needsConfig, keychainPending,
    registrySource: "local", communityStores: [], bundleStatus: {}, lang: "en",
  });
  const { window, document } = parseHTML(`<html><body><div class="main-content">${viewsHtml}${addonRegistryScript}${collectionsScript}${OVERLAY_HTML}</div></body></html>`);
  const calls = [];
  const clipboard = [];
  const fetchStub = (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return Promise.resolve(fetchImpl ? fetchImpl(String(url), init) : { ok: true, status: 200, json: () => Promise.resolve({}) });
  };
  const location = { hash: "", href: "https://crow.test/dashboard/extensions", reload() {} };
  const timers = [];
  const ctx = vm.createContext({
    window, document, location, console, AbortController,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: fetchStub,
    crypto: webcrypto,
    navigator: { clipboard: { writeText: (s) => { clipboard.push(s); return Promise.resolve(); } } },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
  });
  window.location = location;
  vm.runInContext(CLIENT_JS, ctx);
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  return { window, document, click, settle, calls, clipboard, timers };
}
const consentOk = (url) => (url.includes("/consent-challenge/")
  ? { ok: true, status: 200, json: () => Promise.resolve({ required: false, install_required: [] }) }
  : { ok: true, status: 200, json: () => Promise.resolve({ ok: true, job_id: "1" }) });

test("generatePassword: 24 chars, all four classes, honours a pattern, null when impossible", () => {
  const r = () => randomInt(0, 2 ** 32 - 1);
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword(PASSWORD_LENGTH, null, r);
    assert.equal(pw.length, 24);
    assert.match(pw, /[a-z]/); assert.match(pw, /[A-Z]/); assert.match(pw, /[2-9]/); assert.match(pw, /[!%*+,\-./:=?@^_]/);
    assert.doesNotMatch(pw, /[lIO01'"`$\\ #~]/, "no look-alikes, and only .env-bare-safe symbols (C2/C3)");
    assert.match(pw, /^[A-Za-z0-9_./:@%+,=^!?*-]+$/, "written to .env bare, byte-identical, never bash-expanded");
  }
  assert.match(generatePassword(24, "^[A-Za-z0-9]{24}$", r), /^[A-Za-z0-9]{24}$/, "falls back to alphanumerics");
  assert.equal(generatePassword(24, "^x$", r), null);
  assert.equal(generatePassword(24, "([", r), null, "an invalid pattern never throws");
  assert.ok(!generatePassword.toString().includes(String.fromCharCode(96)), "embeddable in the template-literal client");
});

test("C1/Q1 — Generate and the keychain box only on generatable fields; Show/Copy on every typed secret; generated fields stay hidden", async () => {
  const { document, click, settle } = boot({ fetchImpl: consentOk });
  click(document.querySelector('.bundle-install[data-id="demo"]'));
  await settle();
  assert.equal(document.querySelectorAll(".ext-secret-generate").length, 1);
  assert.ok(document.querySelector('.ext-secret-generate[data-key="DEMO_PASSWORD"]'));
  assert.equal(document.querySelector('.ext-secret-generate[data-key="DEMO_API_KEY"]'), null, "no Generate on a third-party API key");
  assert.equal(document.querySelector('.ext-keychain-save[data-key="DEMO_API_KEY"]'), null, "no keychain box on a third-party API key");
  assert.equal(document.querySelectorAll(".ext-secret-toggle").length, 2, "Show/Hide on both typed secrets");
  assert.equal(document.getElementById("env_DEMO_TOKEN"), null, "generate:secret fields are never shown");
  const box = document.querySelector('.ext-keychain-save[data-key="DEMO_PASSWORD"]');
  assert.equal(box.checked, true, "Save to Crow keychain defaults on");
  assert.equal(document.getElementById("ext-vault-save"), null, "no vault block without the vaultwarden bundle");
});

test("Generate fills a pattern-matching 24-char password and reveals it; Show/Hide toggles; Copy copies", async () => {
  const { document, click, settle, clipboard } = boot({ fetchImpl: consentOk });
  click(document.querySelector('.bundle-install[data-id="demo"]'));
  await settle();
  const input = document.getElementById("env_DEMO_PASSWORD");
  assert.equal(input.type, "password");
  click(document.querySelector(".ext-secret-generate"));
  assert.equal(input.value.length, 24);
  assert.match(input.value, new RegExp(WIDE));
  assert.equal(input.type, "text", "a generated password is shown so the user can see it");
  click(document.querySelector(".ext-secret-toggle"));
  assert.equal(input.type, "password");
  click(document.querySelector(".ext-secret-copy"));
  await settle();
  assert.deepEqual(clipboard, [input.value]);
});

test("Install sends keychain.save for checked fields; unchecking sends no keychain at all", async () => {
  let s = boot({ fetchImpl: consentOk });
  s.click(s.document.querySelector('.bundle-install[data-id="demo"]'));
  await s.settle();
  s.document.getElementById("env_DEMO_PASSWORD").value = "Typed pass with spaces & $ 1";
  s.click(s.document.querySelector("#modal-content .btn-primary"));
  await s.settle();
  let install = s.calls.find((c) => c.url.endsWith("/bundles/api/install"));
  assert.deepEqual(install.body.keychain, { save: ["DEMO_PASSWORD"] });
  assert.equal(install.body.env_vars.DEMO_PASSWORD, "Typed pass with spaces & $ 1");

  s = boot({ fetchImpl: consentOk });
  s.click(s.document.querySelector('.bundle-install[data-id="demo"]'));
  await s.settle();
  s.document.getElementById("env_DEMO_PASSWORD").value = "Typed-Pass-123";
  s.document.querySelector('.ext-keychain-save[data-key="DEMO_PASSWORD"]').checked = false;
  s.click(s.document.querySelector("#modal-content .btn-primary"));
  await s.settle();
  install = s.calls.find((c) => c.url.endsWith("/bundles/api/install"));
  assert.equal(install.body.keychain, undefined);
});

test("with Vaultwarden installed: the vault block appears, and only a ticked + filled block is sent", async () => {
  const s = boot({ installed: { vaultwarden: { version: "1.1.0" } }, fetchImpl: consentOk });
  s.click(s.document.querySelector('.bundle-install[data-id="demo"]'));
  await s.settle();
  const tick = s.document.getElementById("ext-vault-save");
  assert.ok(tick);
  const fields = s.document.getElementById("ext-vault-fields");
  assert.equal(fields.style.display, "none");
  tick.checked = true;
  tick.dispatchEvent(new s.window.Event("change", { bubbles: true }));
  assert.notEqual(fields.style.display, "none");
  assert.equal(s.document.getElementById("ext-vault-password").type, "password");
  assert.equal(s.document.getElementById("ext-vault-password").getAttribute("autocomplete"), "off");
  s.document.getElementById("env_DEMO_PASSWORD").value = "Typed-Pass-123";
  s.document.getElementById("ext-vault-email").value = "k@example.invalid";
  s.document.getElementById("ext-vault-password").value = "Master-PW";
  s.click(s.document.querySelector("#modal-content .btn-primary"));
  await s.settle();
  const install = s.calls.find((c) => c.url.endsWith("/bundles/api/install"));
  assert.deepEqual(install.body.keychain, { save: ["DEMO_PASSWORD"], vault: { email: "k@example.invalid", password: "Master-PW" } });
});

test("first-view banner: Show once fetches the secret a single time and offers Copy; a spent grant explains", async () => {
  let n = 0;
  const s = boot({
    keychainPending: [{ id: 7, label: "Vaultwarden — admin token" }],
    fetchImpl: (url) => (url.endsWith("/dashboard/keychain/api/first-view")
      ? (++n === 1 ? { ok: true, status: 200, json: () => Promise.resolve({ secret: "tok-xyz" }) } : { ok: false, status: 410, json: () => Promise.resolve({ code: "first_view_spent", error: "Already shown." }) })
      : { ok: true, status: 200, json: () => Promise.resolve({}) }),
  });
  const banner = s.document.querySelector('.ext-firstview[data-entry-id="7"]');
  assert.match(banner.textContent, /Vaultwarden — admin token/);
  s.click(banner.querySelector(".ext-firstview-show"));
  await s.settle();
  assert.deepEqual(s.calls.filter((c) => c.url.endsWith("/first-view")).map((c) => c.body), [{ id: 7 }]);
  assert.equal(banner.querySelector(".ext-firstview__secret").textContent, "tok-xyz");
  assert.equal(banner.querySelector(".ext-firstview-show").hidden, true, "no second click");
  s.click(banner.querySelector(".ext-firstview-copy"));
  await s.settle();
  assert.deepEqual(s.clipboard, ["tok-xyz"]);
  s.timers.splice(0).forEach((fn) => fn());
  assert.equal(banner.querySelector(".ext-firstview__secret").textContent, "", "S2: the plaintext is wiped after 30 s");
  assert.equal(banner.querySelector(".ext-firstview__secret").hidden, true);
});

test("S4 — a Configure save shows the keychain / vault outcome before the modal moves on", async () => {
  const s = boot({
    installed: { demo: { version: "1.0.0" } },
    needsConfig: { demo: ["DEMO_PASSWORD"] },
    fetchImpl: (url) => (url.endsWith("/bundles/api/env")
      ? { ok: true, status: 200, json: () => Promise.resolve({ ok: true, needs_config: [], keychain: { saved: 1, vault: { ok: false, reason: "R" }, messages: ["Saved 1 password(s) to Crow keychain (Settings → Passwords)", "Vaultwarden save did not complete: R"] } }) }
      : { ok: true, status: 200, json: () => Promise.resolve({}) }),
  });
  s.click(s.document.querySelector('.bundle-configure[data-id="demo"]'));
  await s.settle();
  s.document.getElementById("env_DEMO_PASSWORD").value = "Typed-Pass-123";
  s.click(s.document.querySelector("#modal-content .btn-primary"));
  await s.settle();
  const body = s.calls.find((c) => c.url.endsWith("/bundles/api/env")).body;
  assert.deepEqual(body.keychain, { save: ["DEMO_PASSWORD"] });
  assert.match(s.document.getElementById("install-status").textContent, /Vaultwarden save did not complete: R/);
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/extensions-keychain-client.test.js`
Expected: FAIL with `Cannot find module '…/shared/password-generator.js'`.

- [ ] **Step 3: Create `servers/gateway/dashboard/shared/password-generator.js`**

````js
/**
 * The Generate button's password generator (spec §5.5). ES5 on purpose and free of
 * backticks: extensions/client.js embeds it with Function.prototype.toString() inside its
 * template literal, and the same function is unit-tested in Node.
 * 24 chars; at least one lower/upper/digit/symbol; look-alikes (l I O 0 1) left out, and
 * ONLY .env-bare-safe symbols (no # ~ $ quotes backslash backtick space — review C2/C3):
 * a generated password is written to a bundle .env byte-identically to before and is
 * never expanded by bash. randomUint32 MUST be a CSPRNG
 * (crypto.getRandomValues in the browser); rejection sampling keeps every pick uniform.
 * A manifest `pattern` is honoured by retrying, then by falling back to alphanumerics;
 * null means "cannot satisfy it" and the client hides the button.
 */
export const PASSWORD_LENGTH = 24;

export function generatePassword(length, pattern, randomUint32) {
  var lower = "abcdefghijkmnopqrstuvwxyz";
  var upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  var digits = "23456789";
  var symbols = "!%*+,-./:=?@^_";
  var re = null;
  if (pattern) {
    try { re = new RegExp(pattern); } catch (e) { return null; }
  }
  function uniform(n) {
    var limit = Math.floor(4294967296 / n) * n;
    var r;
    do { r = randomUint32(); } while (!(r < limit));
    return r % n;
  }
  function attempt(sets) {
    var all = sets.join("");
    var out = [];
    for (var i = 0; i < sets.length; i++) out.push(sets[i].charAt(uniform(sets[i].length)));
    while (out.length < length) out.push(all.charAt(uniform(all.length)));
    for (var j = out.length - 1; j > 0; j--) {
      var k = uniform(j + 1);
      var tmp = out[j]; out[j] = out[k]; out[k] = tmp;
    }
    return out.join("");
  }
  var plans = [[lower, upper, digits, symbols], [lower, upper, digits]];
  for (var p = 0; p < plans.length; p++) {
    for (var n = 0; n < 50; n++) {
      var pw = attempt(plans[p]);
      if (!re || re.test(pw)) return pw;
    }
  }
  return null;
}
````

- [ ] **Step 4: Modal, banner, registry blob, i18n**

````bash
cd ~/crow-wt-keychain && git apply <<'PATCH'
diff --git a/servers/gateway/dashboard/panels/extensions.js b/servers/gateway/dashboard/panels/extensions.js
index 41d1b9c..63c1a19 100644
--- a/servers/gateway/dashboard/panels/extensions.js
+++ b/servers/gateway/dashboard/panels/extensions.js
@@ -36,9 +36,16 @@ export default {
     // Docker banner state (Item 4-PR5): cached ~60s with a short probe timeout,
     // so a hung docker daemon can never block the page render.
     const dockerOk = await dockerAvailable();
+    // First-view banner (Crow keychain): ids + labels only, never secrets.
+    let keychainPending = [];
+    try {
+      const { pendingFirstViews } = await import("../../keychain/store.js");
+      const { loadKeychainKey } = await import("../../keychain/key.js");
+      keychainPending = (await pendingFirstViews(db, { keyId: loadKeychainKey()?.id || null })).map((e) => ({ id: e.id, label: e.label }));
+    } catch { /* no banner rather than no page */ }
 
     const { viewsHtml, addonRegistryScript, collectionsScript } = buildExtensionsHTML({
-      installed, available, collections, registrySource, communityStores, bundleStatus, needsConfig, dockerOk, lang,
+      installed, available, collections, registrySource, communityStores, bundleStatus, needsConfig, dockerOk, keychainPending, lang,
     });
 
     // ─── Modal + client-side JavaScript ───
diff --git a/servers/gateway/dashboard/panels/extensions/client.js b/servers/gateway/dashboard/panels/extensions/client.js
index a67dcc7..48d8281 100644
--- a/servers/gateway/dashboard/panels/extensions/client.js
+++ b/servers/gateway/dashboard/panels/extensions/client.js
@@ -1,3 +1,4 @@
+import { generatePassword, PASSWORD_LENGTH } from "../../shared/password-generator.js";
 /**
  * Extensions Panel — Client-side JavaScript
  *
@@ -19,6 +20,23 @@ export function extensionsClientJS(lang) {
     <script>
       (function() {
         var API = "/dashboard/bundles/api";
+        // --- Crow keychain helpers (password-generator.js is ES5 + backtick-free) ---
+        var crowGeneratePassword = ${generatePassword.toString()};
+        var CROW_PW_LENGTH = ${PASSWORD_LENGTH};
+        var CAN_GENERATE = typeof crypto !== "undefined" && !!crypto.getRandomValues;
+        function crowRandomUint32() { var a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; }
+        function vaultInstalled() {
+          var c = document.getElementById("ext-keychain-config");
+          return !!c && c.getAttribute("data-vault") === "1";
+        }
+        function copyText(text, btn) {
+          if (typeof navigator === "undefined" || !navigator.clipboard || !text) return;
+          navigator.clipboard.writeText(text).then(function() {
+            var was = btn.textContent;
+            btn.textContent = '${tJs("keychain.copied", lang)}';
+            setTimeout(function() { btn.textContent = was; }, 1500);
+          }).catch(function() {});
+        }
 
         // --- Modal helpers ---
         function showModal() { document.getElementById("modal-overlay").style.display = "flex"; }
@@ -127,6 +145,20 @@ export function extensionsClientJS(lang) {
             // SERVER's: keys compose hard-fails on (a manifest "required" alone does
             // not block — a post-install token is configured later). Install mode
             // only: a configureOnly save may legitimately fill just some keys.
+            function collectKeychain(envData) {
+              var save = [];
+              keychainKeys.forEach(function(k) {
+                var cb = document.querySelector('.ext-keychain-save[data-key="' + k + '"]');
+                if (cb && cb.checked && envData[k]) save.push(k);
+              });
+              if (save.length === 0) return null;
+              var out = { save: save };
+              var vt = document.getElementById("ext-vault-save");
+              var ve = document.getElementById("ext-vault-email");
+              var vp = document.getElementById("ext-vault-password");
+              if (vt && vt.checked && ve && vp && ve.value && vp.value) out.vault = { email: ve.value, password: vp.value };
+              return out;
+            }
             function missingRequired() {
               if (configureOnly) return [];
               return requiredNames.filter(function(n) {
@@ -348,6 +380,7 @@ export function extensionsClientJS(lang) {
             }
 
             var envNames = [];
+            var keychainKeys = [];
             if (envVars.length > 0) {
               var configH = document.createElement("h4");
               configH.style.cssText = "margin:0 0 0.5rem;font-size:0.9rem;color:var(--crow-text-secondary)";
@@ -373,6 +406,60 @@ export function extensionsClientJS(lang) {
                 input.placeholder = ev.description || "";
                 input.style.cssText = "width:100%;padding:0.5rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg-deep);color:var(--crow-text-primary);font-family:JetBrains Mono,monospace;font-size:0.85rem;box-sizing:border-box";
                 wrap.appendChild(input);
+                if (ev.secret && !ev.generate) {
+                  // Show/Hide/Copy on every typed secret; Generate and "Save to Crow keychain"
+                  // only where the manifest opts in (generatable / keychain — review C1, Kevin Q1).
+                  input.setAttribute("autocomplete", "new-password");
+                  var canKeychain = ev.generatable === true || ev.keychain === true;
+                  if (canKeychain) keychainKeys.push(ev.name);
+                  var tools = document.createElement("div");
+                  tools.className = "ext-secret-tools";
+                  tools.style.cssText = "display:flex;gap:0.4rem;flex-wrap:wrap;align-items:center;margin-top:0.3rem";
+                  var genBtn = document.createElement("button");
+                  genBtn.type = "button";
+                  genBtn.className = "btn btn-sm btn-secondary ext-secret-generate";
+                  genBtn.setAttribute("data-key", ev.name);
+                  genBtn.textContent = '${tJs("keychain.generate", lang)}';
+                  var showBtn = document.createElement("button");
+                  showBtn.type = "button";
+                  showBtn.className = "btn btn-sm btn-secondary ext-secret-toggle";
+                  showBtn.textContent = '${tJs("keychain.show", lang)}';
+                  var copyBtn = document.createElement("button");
+                  copyBtn.type = "button";
+                  copyBtn.className = "btn btn-sm btn-secondary ext-secret-copy";
+                  copyBtn.textContent = '${tJs("keychain.copy", lang)}';
+                  if (ev.generatable !== true || !CAN_GENERATE || crowGeneratePassword(CROW_PW_LENGTH, ev.pattern || null, crowRandomUint32) === null) genBtn = null;
+                  if (genBtn) genBtn.addEventListener("click", function() {
+                    var pw = crowGeneratePassword(CROW_PW_LENGTH, ev.pattern || null, crowRandomUint32);
+                    if (!pw) return;
+                    input.value = pw;
+                    input.type = "text";
+                    showBtn.textContent = '${tJs("keychain.hide", lang)}';
+                    refreshInstallBtnState();
+                  });
+                  showBtn.addEventListener("click", function() {
+                    var hidden = input.type === "password";
+                    input.type = hidden ? "text" : "password";
+                    showBtn.textContent = hidden ? '${tJs("keychain.hide", lang)}' : '${tJs("keychain.show", lang)}';
+                  });
+                  copyBtn.addEventListener("click", function() { copyText(input.value, copyBtn); });
+                  if (genBtn) tools.appendChild(genBtn);
+                  tools.appendChild(showBtn);
+                  tools.appendChild(copyBtn);
+                  if (canKeychain) {
+                    var kcLabel = document.createElement("label");
+                    kcLabel.style.cssText = "display:inline-flex;gap:0.3rem;align-items:center;font-size:0.8rem;color:var(--crow-text-secondary)";
+                    var kcBox = document.createElement("input");
+                    kcBox.type = "checkbox";
+                    kcBox.className = "ext-keychain-save";
+                    kcBox.setAttribute("data-key", ev.name);
+                    kcBox.checked = true;
+                    kcLabel.appendChild(kcBox);
+                    kcLabel.appendChild(document.createTextNode('${tJs("keychain.saveToKeychain", lang)}'));
+                    tools.appendChild(kcLabel);
+                  }
+                  wrap.appendChild(tools);
+                }
 
                 var hint = document.createElement("div");
                 hint.style.cssText = "font-size:0.7rem;color:var(--crow-text-muted);margin-top:0.2rem";
@@ -381,6 +468,39 @@ export function extensionsClientJS(lang) {
 
                 frag.appendChild(wrap);
               });
+              if (keychainKeys.length > 0 && vaultInstalled()) {
+                var vWrap = document.createElement("div");
+                vWrap.className = "ext-vault";
+                vWrap.style.cssText = "margin:0.5rem 0 0.75rem;padding:0.6rem;border:1px solid var(--crow-border);border-radius:6px";
+                var vLabel = document.createElement("label");
+                vLabel.style.cssText = "display:flex;gap:0.4rem;align-items:center;font-size:0.85rem";
+                var vTick = document.createElement("input");
+                vTick.type = "checkbox";
+                vTick.id = "ext-vault-save";
+                vLabel.appendChild(vTick);
+                vLabel.appendChild(document.createTextNode('${tJs("keychain.vaultSave", lang)}'));
+                vWrap.appendChild(vLabel);
+                var vFields = document.createElement("div");
+                vFields.id = "ext-vault-fields";
+                vFields.style.cssText = "display:none;margin-top:0.5rem";
+                [["ext-vault-email", "email", '${tJs("keychain.vaultEmail", lang)}'], ["ext-vault-password", "password", '${tJs("keychain.vaultPassword", lang)}']].forEach(function(f) {
+                  var inp = document.createElement("input");
+                  inp.id = f[0];
+                  inp.type = f[1];
+                  inp.placeholder = f[2];
+                  inp.setAttribute("aria-label", f[2]);
+                  inp.setAttribute("autocomplete", "off");
+                  inp.style.cssText = "width:100%;padding:0.45rem;margin-bottom:0.4rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg-deep);color:var(--crow-text-primary);box-sizing:border-box";
+                  vFields.appendChild(inp);
+                });
+                var vNote = document.createElement("div");
+                vNote.style.cssText = "font-size:0.75rem;color:var(--crow-text-muted)";
+                vNote.textContent = '${tJs("keychain.vaultNote", lang)}';
+                vFields.appendChild(vNote);
+                vWrap.appendChild(vFields);
+                vTick.addEventListener("change", function() { vFields.style.display = vTick.checked ? "block" : "none"; });
+                frag.appendChild(vWrap);
+              }
             }
 
             var statusDiv = document.createElement("div");
@@ -491,7 +611,10 @@ export function extensionsClientJS(lang) {
               statusDiv.style.color = "var(--crow-accent)";
               statusDiv.textContent = '${tJs("extensions.saving", lang)}';
 
-              apiCall("env", { bundle_id: id, env_vars: envData }).then(function(res) {
+              var cfgPayload = { bundle_id: id, env_vars: envData };
+              var cfgKc = collectKeychain(envData);
+              if (cfgKc) cfgPayload.keychain = cfgKc;
+              apiCall("env", cfgPayload).then(function(res) {
                 if (res.ok && res.data && res.data.ok && res.data.needs_bundle_restart) {
                   offerBundleRestart(res.data);
                 } else if (res.ok && res.data && res.data.ok) {
@@ -502,12 +625,15 @@ export function extensionsClientJS(lang) {
                     (res.data.applies_on_next_start
                       ? " " + '${tJs("extensions.configureAppliesOnNextStart", lang)}'
                       : "");
+                  // Keychain / vault outcome (review S4): shown, and given time to be read.
+                  var kcMsgs = (res.data.keychain && res.data.keychain.messages) || [];
+                  if (kcMsgs.length) statusDiv.textContent += " " + kcMsgs.join(" ");
                   setTimeout(function() {
                     // Hand the WHOLE response to onSaved: needs_config is the server's
                     // re-derived truth about what is still missing, and the only thing
                     // allowed to decide whether the "Needs setup" badge may come off.
                     if (typeof onSaved === "function") onSaved(res.data);
-                  }, 1200);
+                  }, kcMsgs.length ? 4000 : 1200);
                 } else {
                   statusDiv.style.color = "var(--crow-error, #e74c3c)";
                   statusDiv.textContent = (res.data && res.data.error) || '${tJs("extensions.configureFailed", lang)}';
@@ -541,6 +667,8 @@ export function extensionsClientJS(lang) {
 
               var payload = { bundle_id: id, env_vars: envData };
               if (consentToken) payload.consent_token = consentToken;
+              var kcReq = collectKeychain(envData);
+              if (kcReq) payload.keychain = kcReq;
 
               apiCall("install", payload).then(function(res) {
                 if (res.ok && res.data.job_id) {
@@ -1662,6 +1790,39 @@ export function extensionsClientJS(lang) {
             }
           });
         }
+        // --- Crow keychain first-view banner (server-rendered; survives reload/restart) ---
+        document.querySelectorAll(".ext-firstview").forEach(function(banner) {
+          var showBtn = banner.querySelector(".ext-firstview-show");
+          var code = banner.querySelector(".ext-firstview__secret");
+          var copyBtn = banner.querySelector(".ext-firstview-copy");
+          var note = banner.querySelector(".ext-firstview__note");
+          if (!showBtn) return;
+          showBtn.addEventListener("click", function() {
+            showBtn.disabled = true;
+            fetch("/dashboard/keychain/api/first-view", {
+              method: "POST",
+              headers: { "Content-Type": "application/json" },
+              body: JSON.stringify({ id: Number(showBtn.getAttribute("data-id")) }),
+            }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); }).then(function(res) {
+              showBtn.hidden = true;
+              if (res.ok && res.d && typeof res.d.secret === "string") {
+                code.textContent = res.d.secret;
+                code.hidden = false;
+                copyBtn.hidden = false;
+                // Plaintext stays on screen 30 s at most, and never into bfcache (review S2).
+                var wipe = function() {
+                  code.textContent = ""; code.hidden = true; copyBtn.hidden = true;
+                  note.textContent = '${tJs("keychain.firstViewSpent", lang)}';
+                };
+                setTimeout(wipe, 30000);
+                window.addEventListener("pagehide", wipe);
+              } else {
+                note.textContent = '${tJs("keychain.firstViewSpent", lang)}';
+              }
+            }).catch(function() { showBtn.disabled = false; });
+          });
+          copyBtn.addEventListener("click", function() { copyText(code.textContent, copyBtn); });
+        });
       })();
     <\/script>`;
 }
diff --git a/servers/gateway/dashboard/panels/extensions/html.js b/servers/gateway/dashboard/panels/extensions/html.js
index 1ac08a7..72d44b6 100644
--- a/servers/gateway/dashboard/panels/extensions/html.js
+++ b/servers/gateway/dashboard/panels/extensions/html.js
@@ -6,7 +6,7 @@
  */
 
 import { escapeHtml, badge, formatDate } from "../../shared/components.js";
-import { t } from "../../shared/i18n.js";
+import { t, fill } from "../../shared/i18n.js";
 import { getAddonLogo } from "../../shared/logos.js";
 import { detectGpuArch, checkGpuArchCompatible, detectGpuVramGb } from "../../../gpu-arch.js";
 import { DISPLAY_GROUPS, groupAddons, groupForCategory } from "./groups.js";
@@ -170,6 +170,7 @@ export function buildExtensionsHTML({
   bundleStatus,
   needsConfig = {},
   dockerOk = true,
+  keychainPending = [],
   lang,
 }) {
   const installedCount = Object.keys(installed).length;
@@ -242,6 +243,19 @@ export function buildExtensionsHTML({
         <p style="margin:0.25rem 0 0">${t("extensions.dockerUnavailableDesc", lang)}</p>
       </div>`;
 
+  // ─── Crow keychain: vault flag + first-view banner (plan P5/P6) ───
+  const keychainConfigHtml = `<div id="ext-keychain-config" data-vault="${installed.vaultwarden ? "1" : "0"}" hidden></div>`;
+  const firstViewHtml = (keychainPending || []).map((e) => `<div class="callout callout-info ext-firstview" data-entry-id="${Number(e.id)}" role="status">
+        <strong>${escapeHtml(fill(t("keychain.firstViewTitle", lang), { label: e.label }))}</strong>
+        <p style="margin:0.25rem 0 0.5rem">${t("keychain.firstViewBody", lang)}</p>
+        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
+          <button type="button" class="btn btn-sm btn-secondary ext-firstview-show" data-id="${Number(e.id)}">${t("keychain.showOnce", lang)}</button>
+          <code class="ext-firstview__secret" hidden style="font-family:'JetBrains Mono',monospace;word-break:break-all"></code>
+          <button type="button" class="btn btn-sm btn-secondary ext-firstview-copy" hidden>${t("keychain.copy", lang)}</button>
+          <span class="ext-firstview__note" style="font-size:0.8rem"></span>
+          <a href="/dashboard/settings?section=passwords">${t("keychain.openPasswords", lang)}</a>
+        </div>
+      </div>`).join("");
   // ─── Segmented control ───
   const viewTabsHtml = `<div class="ext-viewtabs" id="ext-viewtabs" role="tablist" aria-label="${t("extensions.pageTitle", lang)}">
       <button type="button" class="ext-viewtab ext-viewtab--active" data-view="browse" role="tab" aria-selected="true" aria-controls="ext-view-browse">${t("extensions.viewBrowse", lang)}</button>
@@ -407,7 +421,7 @@ export function buildExtensionsHTML({
       ${t("extensions.toCreateOwn", lang)} <a href="/crow/developers/creating-addons" style="color:var(--crow-accent)">${t("extensions.devGuide", lang)}</a>.
     </div>`;
 
-  const viewsHtml = `${dockerBannerHtml}${viewTabsHtml}
+  const viewsHtml = `${keychainConfigHtml}${firstViewHtml}${dockerBannerHtml}${viewTabsHtml}
     <div class="ext-view" id="ext-view-browse" role="tabpanel">
       ${searchHtml}
       ${collectionsHtml}
@@ -443,6 +457,9 @@ export function buildExtensionsHTML({
       env_vars: visibleEnvVars(addon).map((ev) => ({
         name: ev.name, description: ev.description,
         default: ev.secret ? "" : (ev.default || ""), required: ev.required, secret: !!ev.secret,
+        // Configure builds its form from THIS blob: it needs the same opt-ins as Install.
+        generatable: ev.generatable === true, keychain: ev.keychain === true,
+        pattern: typeof ev.pattern === "string" ? ev.pattern : undefined,
       })),
       official: !addon._community,
       featured: !!addon.featured,
diff --git a/servers/gateway/dashboard/shared/i18n.js b/servers/gateway/dashboard/shared/i18n.js
index a7be386..63f4a9d 100644
--- a/servers/gateway/dashboard/shared/i18n.js
+++ b/servers/gateway/dashboard/shared/i18n.js
@@ -1820,6 +1820,21 @@ export const translations = {
   "settings.section.companionVoice": { en: "Companion Voice", es: "Voz del compañero" },
   "settings.section.companion": { en: "Companion", es: "Compañero" },
   "settings.section.twoFactor": { en: "Two-Factor Auth", es: "Autenticación 2FA" },
+  "keychain.generate": { en: "Generate", es: "Generar" },
+  "keychain.show": { en: "Show", es: "Mostrar" },
+  "keychain.hide": { en: "Hide", es: "Ocultar" },
+  "keychain.copy": { en: "Copy", es: "Copiar" },
+  "keychain.copied": { en: "Copied", es: "Copiado" },
+  "keychain.saveToKeychain": { en: "Save to Crow keychain", es: "Guardar en el llavero de Crow" },
+  "keychain.vaultSave": { en: "Also save to my Vaultwarden vault", es: "Guardar también en mi bóveda de Vaultwarden" },
+  "keychain.vaultEmail": { en: "Vault email", es: "Correo de la bóveda" },
+  "keychain.vaultPassword": { en: "Vault master password", es: "Contraseña maestra de la bóveda" },
+  "keychain.vaultNote": { en: "Used once to save this password, then forgotten. Crow never stores it.", es: "Se usa una vez para guardar esta contraseña y luego se olvida. Crow nunca la guarda." },
+  "keychain.firstViewTitle": { en: "A password was generated for {label}", es: "Se generó una contraseña para {label}" },
+  "keychain.firstViewBody": { en: "It is shown here once. It is also saved in Settings → Passwords.", es: "Se muestra aquí una sola vez. También queda guardada en Ajustes → Contraseñas." },
+  "keychain.showOnce": { en: "Show once", es: "Mostrar una vez" },
+  "keychain.firstViewSpent": { en: "Already shown. Open Settings → Passwords to see it again.", es: "Ya se mostró. Abre Ajustes → Contraseñas para verla de nuevo." },
+  "keychain.openPasswords": { en: "Open Passwords", es: "Abrir Contraseñas" },
   "settings.2faEnabled": { en: "Two-factor authentication enabled.", es: "Autenticación de dos factores activada." },
   "settings.2faDisabled": { en: "Two-factor authentication disabled.", es: "Autenticación de dos factores desactivada." },
   "settings.2faCodesRegenerated": { en: "Recovery codes regenerated.", es: "Códigos de recuperación regenerados." },
PATCH
git diff --stat
````

Check the template-literal rule:

```bash
node -e 'const s=require("fs").readFileSync("servers/gateway/dashboard/panels/extensions/client.js","utf8"); const b=s.slice(s.indexOf("return `")+8, s.lastIndexOf("`")); if (b.includes(String.fromCharCode(96))) { console.error("BACKTICK inside client template"); process.exit(1) } console.log("ok")'
```

- [ ] **Step 5: Run the tests**

```bash
npm test -- tests/extensions-keychain-client.test.js
npm test -- tests/extensions-client-contract.test.js
npm test -- tests/extensions-page-render.test.js
npm test -- tests/extensions-needs-config.test.js
npm test -- tests/i18n-global-parity.test.js
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/dashboard/shared/password-generator.js tests/extensions-keychain-client.test.js
git commit servers/gateway/dashboard/shared/password-generator.js tests/extensions-keychain-client.test.js servers/gateway/dashboard/panels/extensions/html.js servers/gateway/dashboard/panels/extensions.js servers/gateway/dashboard/panels/extensions/client.js servers/gateway/dashboard/shared/i18n.js -m "feat(extensions): opt-in Generate + Save to Crow keychain, Show/Copy on secrets, vault copy, first-view banner; Configure gets field opt-ins"
git show --stat HEAD
```

---

### Task 10: Settings → Passwords (reveal/copy/delete, add, export/import, unreadable-key and no-re-auth states)

**Files:**
- Create: `servers/gateway/dashboard/settings/sections/passwords.js`, `tests/settings-passwords-section.test.js`
- Modify: `servers/gateway/dashboard/panels/settings.js` (register after Two-Factor), `servers/gateway/dashboard/shared/i18n.js` (`settings.section.passwords`, `passwords.*`)

**Interfaces:**
- Consumes: Task 4 `listEntries`, `loadKeychainKey`; Task 5 API and `defaultReauthGate`; Task 7 `vaultwardenStatus`.
- Produces:
  - default export section `{ id:"passwords", group:"account", navOrder:12, … }`
  - `renderPasswordsPage({ entries, method: "totp"|"password"|"none", vaultAvailable, lang })` (pure)
  - `passwordsClientJS(lang)`

- [ ] **Step 1: Write the failing test** — create `tests/settings-passwords-section.test.js`:

````js
/** Settings → Passwords (Task 8): pure render + the client executed in linkedom/vm. */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { renderPasswordsPage, passwordsClientJS } from "../servers/gateway/dashboard/settings/sections/passwords.js";
import section from "../servers/gateway/dashboard/settings/sections/passwords.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const ENTRIES = [
  { id: 1, kind: "extension", label: "Crow Workspace — WORKSPACE_ADMIN_PASSWORD", bundle_id: "workspace", env_key: "WORKSPACE_ADMIN_PASSWORD", username: "admin", url: null, origin: "typed", status: "active", updated_at: "2026-10-03T12:00:00.000Z" },
  { id: 2, kind: "manual", label: "<script>alert(1)</script>", bundle_id: null, env_key: null, username: "kevin", url: "https://ws.example:8456", origin: "manual", status: "active", updated_at: "2026-10-03T12:00:00.000Z" },
  { id: 3, kind: "extension", label: "Vaultwarden — admin token", bundle_id: "vaultwarden", env_key: "VAULTWARDEN_ADMIN_TOKEN", username: null, url: "http://localhost:8097/admin", origin: "generated", status: "extension_removed", updated_at: "2026-10-03T12:00:00.000Z", readable: true },
  { id: 4, kind: "manual", label: "From the old machine", bundle_id: null, env_key: null, username: null, url: null, origin: "manual", status: "active", updated_at: "2026-10-03T12:00:00.000Z", readable: false },
  { id: 5, kind: "extension", label: "Vaultwarden — live token", bundle_id: "vaultwarden", env_key: "X", username: null, url: null, origin: "generated", status: "active", updated_at: "2026-10-03T12:00:00.000Z", readable: true },
];

function boot({ method = "password", vaultAvailable = true, routes = {}, confirmAnswer = true } = {}) {
  const html = renderPasswordsPage({ entries: ENTRIES, method, vaultAvailable, lang: "en" });
  const client = passwordsClientJS("en");
  const js = client.slice(client.indexOf("<script>") + 8, client.lastIndexOf("</script>"));
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  const calls = [];
  const clipboard = [];
  const fetchStub = (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    const path = String(url).replace("/dashboard/keychain/api", "");
    const h = routes[path] || (() => ({ status: 200, d: {} }));
    const { status, d } = h(body, calls);
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(d) });
  };
  const reloads = { n: 0 };
  const confirms = [];
  const timers = [];
  const ctx = vm.createContext({
    window, document, console, fetch: fetchStub,
    location: { reload() { reloads.n++; } },
    navigator: { clipboard: { writeText: (s) => { clipboard.push(s); return Promise.resolve(); } } },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {}, Date,
  });
  ctx.confirm = (q) => { confirms.push(q); return confirmAnswer; };
  vm.runInContext(js, ctx);
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  return { document, click, settle, calls, clipboard, reloads, confirms, timers };
}

test("the page lists metadata only, escapes labels, marks removed extensions, and asks for the right re-auth", () => {
  const html = renderPasswordsPage({ entries: ENTRIES, method: "totp", vaultAvailable: false, lang: "en" });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, new RegExp(t("passwords.statusRemoved", "en")));
  assert.match(html, /id="pw-root"[^>]*data-method="totp"/);
  assert.match(html, /id="pw-reauth-input"[^>]*inputmode="numeric"/);
  assert.equal((html.match(/class="[^"]*pw-vault[ "]/g) || []).length, 0, "no vault buttons without the CLI");
  assert.equal((renderPasswordsPage({ entries: ENTRIES, method: "password", vaultAvailable: true, lang: "en" }).match(/class="[^"]*pw-vault[ "]/g) || []).length, 5);
  assert.match(renderPasswordsPage({ entries: [], method: "password", vaultAvailable: false, lang: "es" }), new RegExp(t("passwords.empty", "es")));
  assert.equal(section.id, "passwords");
  assert.equal(section.group, "account");
  assert.notEqual(t("settings.section.passwords", "es"), "settings.section.passwords");
});

test("Reveal without a grant opens the re-auth panel; confirming retries and shows the secret", async () => {
  let granted = false;
  const s = boot({ routes: {
    "/reveal": () => (granted ? { status: 200, d: { secret: "p a$s'w\"d" } } : { status: 403, d: { code: "reauth_required" } }),
    "/reauth": (b) => (b.password === "right" ? ((granted = true), { status: 200, d: { ok: true, expires_at: Date.now() + 300000 } }) : { status: 401, d: { error: "That password is not correct." } }),
    "/activity": () => ({ status: 200, d: { events: [] } }),
  } });
  await s.settle();
  const row = s.document.querySelector('tr.pw-row[data-id="1"]');
  s.click(row.querySelector(".pw-reveal"));
  await s.settle();
  const panel = s.document.getElementById("pw-reauth");
  assert.equal(panel.hidden, false);
  s.document.getElementById("pw-reauth-input").value = "wrong";
  s.click(s.document.getElementById("pw-reauth-go"));
  await s.settle();
  assert.match(s.document.getElementById("pw-reauth-error").textContent, /not correct/);
  s.document.getElementById("pw-reauth-input").value = "right";
  s.click(s.document.getElementById("pw-reauth-go"));
  await s.settle();
  assert.equal(panel.hidden, true);
  assert.equal(s.document.getElementById("pw-reauth-input").value, "", "the typed password is cleared");
  const cell = row.querySelector(".pw-secret");
  assert.equal(cell.hidden, false);
  assert.equal(cell.textContent, "p a$s'w\"d");
  assert.deepEqual(s.calls.filter((c) => c.url.endsWith("/reveal")).map((c) => c.body), [{ id: 1, purpose: "reveal" }, { id: 1, purpose: "reveal" }]);
});

test("TOTP mode sends totp_code, never password", async () => {
  const s = boot({ method: "totp", routes: { "/reveal": () => ({ status: 403, d: { code: "reauth_required" } }), "/reauth": () => ({ status: 401, d: { error: "That code is not valid." } }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  s.click(s.document.querySelector('tr.pw-row[data-id="1"] .pw-reveal'));
  await s.settle();
  s.document.getElementById("pw-reauth-input").value = "123456";
  s.click(s.document.getElementById("pw-reauth-go"));
  await s.settle();
  assert.deepEqual(s.calls.find((c) => c.url.endsWith("/reauth")).body, { totp_code: "123456" });
});

test("Copy copies, Delete removes the row, Save to vault sends the typed credentials once", async () => {
  const s = boot({ routes: {
    "/reveal": () => ({ status: 200, d: { secret: "copied-secret" } }),
    "/delete": () => ({ status: 200, d: { ok: true } }),
    "/vault-save": () => ({ status: 200, d: { ok: false, reason: "Vaultwarden did not accept that email or master password." } }),
    "/activity": () => ({ status: 200, d: { events: [] } }),
  } });
  s.click(s.document.querySelector('tr.pw-row[data-id="2"] .pw-copy'));
  await s.settle();
  assert.deepEqual(s.clipboard, ["copied-secret"]);
  assert.equal(s.document.querySelector('tr.pw-row[data-id="2"] .pw-secret').hidden, true, "copy never paints the secret");

  s.click(s.document.querySelector('tr.pw-row[data-id="2"] .pw-delete'));
  await s.settle();
  assert.equal(s.document.querySelector('tr.pw-row[data-id="2"]'), null);

  s.click(s.document.querySelector('tr.pw-row[data-id="1"] .pw-vault'));
  s.document.getElementById("pw-vault-email").value = "k@example.invalid";
  s.document.getElementById("pw-vault-password").value = "Master-PW";
  s.click(s.document.getElementById("pw-vault-go"));
  await s.settle();
  assert.deepEqual(s.calls.find((c) => c.url.endsWith("/vault-save")).body, { id: 1, vault_email: "k@example.invalid", vault_password: "Master-PW" });
  assert.equal(s.document.getElementById("pw-vault-password").value, "", "master password field cleared after the attempt");
  assert.match(s.document.getElementById("pw-vault-msg").textContent, /did not accept/);
});

test("Add posts the form and reloads; an empty form is refused client-side", async () => {
  const s = boot({ routes: { "/add": () => ({ status: 200, d: { ok: true, id: 9 } }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  s.click(s.document.getElementById("pw-add-go"));
  await s.settle();
  assert.equal(s.calls.filter((c) => c.url.endsWith("/add")).length, 0);
  s.document.getElementById("pw-add-label").value = "Workspace phone (Kevin)";
  s.document.getElementById("pw-add-secret").value = "abcd-efgh";
  s.click(s.document.getElementById("pw-add-go"));
  await s.settle();
  assert.deepEqual(s.calls.find((c) => c.url.endsWith("/add")).body, { label: "Workspace phone (Kevin)", username: "", url: "", secret: "abcd-efgh" });
  assert.equal(s.reloads.n, 1);
});

test("C7 — an entry sealed under a missing key shows as unreadable: no reveal/copy/vault, delete still allowed", () => {
  const { document } = boot();
  const row = document.querySelector('tr.pw-row[data-id="4"]');
  assert.match(row.textContent, new RegExp(t("passwords.statusUnreadable", "en")));
  for (const c of [".pw-reveal", ".pw-copy", ".pw-vault"]) assert.equal(row.querySelector(c).hasAttribute("disabled"), true, c);
  assert.equal(row.querySelector(".pw-delete").hasAttribute("disabled"), false);
});

test("Q6 — with no dashboard password and no 2FA the page explains and disables everything that needs re-auth", () => {
  const html = renderPasswordsPage({ entries: ENTRIES, method: "none", vaultAvailable: true, lang: "en" });
  assert.match(html, /id="pw-noreauth"/);
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  for (const sel of [".pw-reveal", ".pw-copy", ".pw-delete", "#pw-export-go", "#pw-import-go"]) {
    for (const el of document.querySelectorAll(sel)) assert.equal(el.hasAttribute("disabled"), true, sel);
  }
  assert.equal(document.getElementById("pw-add-go").hasAttribute("disabled"), false, "adding needs no re-auth");
});

test("C5 — deleting an in-use generated token asks a stronger question and sends confirm_generated", async () => {
  const s = boot({ routes: { "/delete": () => ({ status: 200, d: { ok: true } }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  s.click(s.document.querySelector('tr.pw-row[data-id="5"] .pw-delete'));
  await s.settle();
  assert.match(s.confirms[0], /keeps no other copy/);
  assert.deepEqual(s.calls.find((c) => c.url.endsWith("/delete")).body, { id: 5, confirm_generated: true });
});

test("S2 — a revealed password is wiped after 30 s", async () => {
  const s = boot({ routes: { "/reveal": () => ({ status: 200, d: { secret: "shown-once" } }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  s.click(s.document.querySelector('tr.pw-row[data-id="1"] .pw-reveal'));
  await s.settle();
  const cell = s.document.querySelector('tr.pw-row[data-id="1"] .pw-secret');
  assert.equal(cell.textContent, "shown-once");
  s.timers.splice(0).forEach((fn) => fn());
  assert.equal(cell.textContent, "");
  assert.equal(cell.hidden, true);
});

test("Export checks the passphrase pair client-side, then posts it (re-auth flow applies); Import posts the parsed file", async () => {
  const exported = { format: "crow-keychain-export", version: 1, count: 2 };
  const s = boot({ routes: {
    "/export": () => ({ status: 200, d: exported }),
    "/import": () => ({ status: 200, d: { ok: true, imported: 2, skipped: 0 } }),
    "/activity": () => ({ status: 200, d: { events: [] } }),
  } });
  s.document.getElementById("pw-export-pass").value = "short";
  s.click(s.document.getElementById("pw-export-go"));
  assert.equal(s.calls.filter((c) => c.url.endsWith("/export")).length, 0);
  s.document.getElementById("pw-export-pass").value = "correct horse battery";
  s.document.getElementById("pw-export-confirm").value = "correct horse batteryX";
  s.click(s.document.getElementById("pw-export-go"));
  assert.equal(s.calls.filter((c) => c.url.endsWith("/export")).length, 0, "mismatch refused");
  s.document.getElementById("pw-export-confirm").value = "correct horse battery";
  s.click(s.document.getElementById("pw-export-go"));
  await s.settle();
  assert.deepEqual(s.calls.find((c) => c.url.endsWith("/export")).body, { passphrase: "correct horse battery" });
  assert.match(s.document.getElementById("pw-export-msg").textContent, /Exported 2/);
  assert.equal(s.document.getElementById("pw-export-pass").value, "", "passphrase cleared");

  const input = s.document.getElementById("pw-import-file");
  Object.defineProperty(input, "files", { value: [{ text: () => Promise.resolve(JSON.stringify(exported)) }] });
  s.document.getElementById("pw-import-pass").value = "correct horse battery";
  s.click(s.document.getElementById("pw-import-go"));
  await s.settle();
  assert.deepEqual(s.calls.find((c) => c.url.endsWith("/import")).body, { file: exported, passphrase: "correct horse battery" });
  assert.match(s.document.getElementById("pw-import-msg").textContent, /2 imported, 0 already here/);
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/settings-passwords-section.test.js`
Expected: FAIL with `Cannot find module '…/sections/passwords.js'`.

- [ ] **Step 3: Create `servers/gateway/dashboard/settings/sections/passwords.js`**

````js
/**
 * Settings Section: Passwords (Crow keychain, spec §5.5).
 * Server-renders METADATA only. Every secret moves through /dashboard/keychain/api
 * (re-auth gated, audited, no-store). The client is a template literal: no backticks,
 * no backslashes, and only the ${...} interpolations below are intended.
 */
import { t, tJs, fill } from "../../shared/i18n.js";
import { escapeHtml } from "../../shared/components.js";

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>`;

export function renderPasswordsPage({ entries, method, vaultAvailable, lang }) {
  const none = method === "none";
  const dis = none ? " disabled" : "";
  const rows = (entries || []).map((e) => {
    const ext = e.kind === "manual" ? t("passwords.manual", lang) : escapeHtml(e.bundle_id || "");
    const status = e.readable === false
      ? `<span class="pw-unreadable">${t("passwords.statusUnreadable", lang)}</span>`
      : e.status === "extension_removed" ? t("passwords.statusRemoved", lang) : t("passwords.statusActive", lang);
    const url = e.url ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.url)}</a>` : "";
    const readable = e.readable !== false;
    const rdis = readable ? dis : " disabled";
    return `<tr class="pw-row" data-id="${Number(e.id)}" data-origin="${escapeHtml(e.origin || "")}" data-status="${escapeHtml(e.status || "")}">
        <td>${escapeHtml(e.label)}<div><code class="pw-secret" hidden style="font-family:'JetBrains Mono',monospace;word-break:break-all"></code></div></td>
        <td>${ext}</td>
        <td>${escapeHtml(e.username || "")}</td>
        <td style="word-break:break-all">${url}</td>
        <td>${status}</td>
        <td style="white-space:nowrap">${escapeHtml(String(e.updated_at || "").slice(0, 16).replace("T", " "))}</td>
        <td style="white-space:nowrap">
          <button type="button" class="btn btn-sm btn-secondary pw-reveal"${rdis}>${t("passwords.reveal", lang)}</button>
          <button type="button" class="btn btn-sm btn-secondary pw-copy"${rdis}>${t("passwords.copy", lang)}</button>
          ${vaultAvailable ? `<button type="button" class="btn btn-sm btn-secondary pw-vault"${rdis}>${t("passwords.vault", lang)}</button>` : ""}
          <button type="button" class="btn btn-sm btn-secondary pw-delete"${dis}>${t("passwords.delete", lang)}</button>
        </td>
      </tr>`;
  }).join("");

  const table = rows
    ? `<div class="table-scroll"><table class="pw-table" style="width:100%;border-collapse:collapse;font-size:0.85rem">
        <thead><tr>
          <th>${t("passwords.colLabel", lang)}</th><th>${t("passwords.colExtension", lang)}</th><th>${t("passwords.colUsername", lang)}</th>
          <th>${t("passwords.colUrl", lang)}</th><th>${t("passwords.colStatus", lang)}</th><th>${t("passwords.colUpdated", lang)}</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
    : `<p class="pw-empty" style="color:var(--crow-text-muted)">${t("passwords.empty", lang)}</p>`;

  const totp = method === "totp";
  const reauthInput = totp
    ? `<input id="pw-reauth-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-label="${t("passwords.reauthTotp", lang)}" placeholder="${t("passwords.reauthTotp", lang)}">`
    : `<input id="pw-reauth-input" type="password" autocomplete="current-password" aria-label="${t("passwords.reauthPassword", lang)}" placeholder="${t("passwords.reauthPassword", lang)}">`;

  const inputCss = "width:100%;padding:0.45rem;margin-bottom:0.4rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg-deep);color:var(--crow-text-primary);box-sizing:border-box";
  const noReauth = none ? `<div class="alert alert-error" id="pw-noreauth">${t("passwords.noReauth", lang)}</div>` : "";

  return `<style>
      .pw-table th { text-align:left; padding:6px 8px; color:var(--crow-text-muted); font-weight:500; font-size:0.72rem; text-transform:uppercase; }
      .pw-table td { padding:6px 8px; border-top:1px solid var(--crow-border); vertical-align:top; }
      .pw-panel { margin:1rem 0; padding:0.8rem; border:1px solid var(--crow-border); border-radius:8px; max-width:28rem; }
      .pw-panel input { ${inputCss} }
      .pw-unreadable { color:var(--crow-error,#e55); }
    </style>
    <div id="pw-root" data-method="${escapeHtml(method)}">
      <p style="color:var(--crow-text-secondary);font-size:0.9rem">${t("passwords.intro", lang)}</p>
      ${noReauth}
      <p id="pw-grant" style="font-size:0.8rem;color:var(--crow-text-muted)"></p>
      ${table}
      <div id="pw-reauth" class="pw-panel" hidden>
        <strong>${t("passwords.reauthTitle", lang)}</strong>
        <p style="font-size:0.8rem;color:var(--crow-text-muted);margin:0.25rem 0 0.5rem">${t("passwords.reauthHint", lang)}</p>
        ${reauthInput}
        <div id="pw-reauth-error" role="alert" style="font-size:0.8rem;color:var(--crow-error,#e55);min-height:1em"></div>
        <button type="button" id="pw-reauth-go" class="btn btn-sm btn-primary">${t("passwords.confirm", lang)}</button>
        <button type="button" id="pw-reauth-cancel" class="btn btn-sm btn-secondary">${t("common.cancel", lang)}</button>
      </div>
      <div id="pw-vault" class="pw-panel" hidden>
        <strong>${t("passwords.vaultTitle", lang)}</strong>
        <input id="pw-vault-email" type="email" autocomplete="off" placeholder="${t("keychain.vaultEmail", lang)}" aria-label="${t("keychain.vaultEmail", lang)}">
        <input id="pw-vault-password" type="password" autocomplete="off" placeholder="${t("keychain.vaultPassword", lang)}" aria-label="${t("keychain.vaultPassword", lang)}">
        <p style="font-size:0.75rem;color:var(--crow-text-muted)">${t("keychain.vaultNote", lang)}</p>
        <div id="pw-vault-msg" role="status" style="font-size:0.8rem;min-height:1em"></div>
        <button type="button" id="pw-vault-go" class="btn btn-sm btn-primary">${t("passwords.vault", lang)}</button>
        <button type="button" id="pw-vault-cancel" class="btn btn-sm btn-secondary">${t("common.cancel", lang)}</button>
      </div>
      <h3 style="margin-top:1.5rem;font-size:1rem">${t("passwords.addTitle", lang)}</h3>
      <p style="font-size:0.8rem;color:var(--crow-text-muted)">${t("passwords.addHint", lang)}</p>
      <div class="pw-panel" id="pw-add-form">
        <input id="pw-add-label" type="text" placeholder="${t("passwords.colLabel", lang)}" aria-label="${t("passwords.colLabel", lang)}">
        <input id="pw-add-username" type="text" autocomplete="off" placeholder="${t("passwords.colUsername", lang)}" aria-label="${t("passwords.colUsername", lang)}">
        <input id="pw-add-url" type="url" placeholder="${t("passwords.colUrl", lang)}" aria-label="${t("passwords.colUrl", lang)}">
        <input id="pw-add-secret" type="password" autocomplete="new-password" placeholder="${t("passwords.secret", lang)}" aria-label="${t("passwords.secret", lang)}">
        <div id="pw-add-msg" role="status" style="font-size:0.8rem;min-height:1em"></div>
        <button type="button" id="pw-add-go" class="btn btn-sm btn-primary">${t("passwords.add", lang)}</button>
      </div>
      <h3 style="margin-top:1.5rem;font-size:1rem">${t("passwords.exportTitle", lang)}</h3>
      <p style="font-size:0.8rem;color:var(--crow-text-muted)">${t("passwords.exportHint", lang)}</p>
      <div class="pw-panel" id="pw-export-form">
        <input id="pw-export-pass" type="password" autocomplete="new-password" placeholder="${t("passwords.exportPassphrase", lang)}" aria-label="${t("passwords.exportPassphrase", lang)}">
        <input id="pw-export-confirm" type="password" autocomplete="new-password" placeholder="${t("passwords.exportConfirm", lang)}" aria-label="${t("passwords.exportConfirm", lang)}">
        <div id="pw-export-msg" role="status" style="font-size:0.8rem;min-height:1em"></div>
        <button type="button" id="pw-export-go" class="btn btn-sm btn-secondary"${dis}>${t("passwords.export", lang)}</button>
      </div>
      <div class="pw-panel" id="pw-import-form">
        <strong>${t("passwords.importTitle", lang)}</strong>
        <input id="pw-import-file" type="file" accept="application/json,.json" aria-label="${t("passwords.importFile", lang)}">
        <input id="pw-import-pass" type="password" autocomplete="off" placeholder="${t("passwords.exportPassphrase", lang)}" aria-label="${t("passwords.exportPassphrase", lang)}">
        <div id="pw-import-msg" role="status" style="font-size:0.8rem;min-height:1em"></div>
        <button type="button" id="pw-import-go" class="btn btn-sm btn-secondary"${dis}>${t("passwords.import", lang)}</button>
      </div>
      <h3 style="margin-top:1.5rem;font-size:1rem">${t("passwords.activityTitle", lang)}</h3>
      <ul id="pw-activity" style="font-size:0.8rem;color:var(--crow-text-secondary)"></ul>
    </div>`;
}

export function passwordsClientJS(lang) {
  const eventNames = ["keychain_reveal", "keychain_copy", "keychain_delete", "keychain_add", "keychain_save", "keychain_first_view", "keychain_vault_save", "keychain_reauth_ok", "keychain_reauth_failed", "keychain_reauth_lockout", "keychain_export", "keychain_import"];
  const eventMap = JSON.stringify(Object.fromEntries(eventNames.map((n) => [n, t(`passwords.event.${n}`, lang)])));
  return `<script>
    (function() {
      var API = "/dashboard/keychain/api";
      var root = document.getElementById("pw-root");
      if (!root) return;
      var METHOD = root.getAttribute("data-method");
      var EVENTS = ${eventMap};
      var pending = null;
      var vaultTarget = null;
      var shown = [];

      function post(path, body) {
        return fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
          .then(function(r) { return r.json().then(function(d) { return { status: r.status, d: d || {} }; }); });
      }
      function wipeShown() {
        shown.forEach(function(cell) { cell.textContent = ""; cell.hidden = true; });
        shown = [];
      }
      // Revealed plaintext stays on screen 30 s at most and never into bfcache (review S2).
      window.addEventListener("pagehide", wipeShown);
      function showGrant(expiresAt) {
        if (!expiresAt) return;
        var d = new Date(expiresAt);
        var hh = String(d.getHours()); var mm = String(d.getMinutes());
        if (mm.length < 2) mm = "0" + mm;
        document.getElementById("pw-grant").textContent = '${tJs("passwords.grantActive", lang)}'.split("{time}").join(hh + ":" + mm);
      }
      function needAuth(retry) {
        pending = retry;
        var p = document.getElementById("pw-reauth");
        p.hidden = false;
        document.getElementById("pw-reauth-error").textContent = "";
        var i = document.getElementById("pw-reauth-input");
        i.value = "";
        if (i.focus) i.focus();
      }
      function guarded(path, body, onDone) {
        post(path, body).then(function(res) {
          if (res.status === 403 && res.d.code === "reauth_required") { needAuth(function() { guarded(path, body, onDone); }); return; }
          onDone(res);
        }).catch(function() { onDone({ status: 0, d: { error: '${tJs("passwords.error", lang)}' } }); });
      }

      document.getElementById("pw-reauth-go").addEventListener("click", function() {
        var input = document.getElementById("pw-reauth-input");
        var v = input.value;
        var body = METHOD === "totp" ? { totp_code: v } : { password: v };
        post("/reauth", body).then(function(res) {
          input.value = "";
          if (res.status === 200) {
            document.getElementById("pw-reauth").hidden = true;
            showGrant(res.d.expires_at);
            var next = pending; pending = null;
            if (next) next();
          } else {
            document.getElementById("pw-reauth-error").textContent = res.d.error || '${tJs("passwords.error", lang)}';
          }
        });
      });
      document.getElementById("pw-reauth-cancel").addEventListener("click", function() {
        pending = null;
        document.getElementById("pw-reauth-input").value = "";
        document.getElementById("pw-reauth").hidden = true;
      });

      document.querySelectorAll("tr.pw-row").forEach(function(row) {
        var id = Number(row.getAttribute("data-id"));
        var cell = row.querySelector(".pw-secret");
        row.querySelector(".pw-reveal").addEventListener("click", function() {
          guarded("/reveal", { id: id, purpose: "reveal" }, function(res) {
            if (res.status === 200 && typeof res.d.secret === "string") {
              cell.textContent = res.d.secret; cell.hidden = false; shown.push(cell);
              setTimeout(wipeShown, 30000);
            }
          });
        });
        var copyBtn = row.querySelector(".pw-copy");
        copyBtn.addEventListener("click", function() {
          guarded("/reveal", { id: id, purpose: "copy" }, function(res) {
            if (res.status === 200 && typeof res.d.secret === "string" && typeof navigator !== "undefined" && navigator.clipboard) {
              navigator.clipboard.writeText(res.d.secret).then(function() { copyBtn.textContent = '${tJs("passwords.copied", lang)}'; }).catch(function() {});
            }
          });
        });
        row.querySelector(".pw-delete").addEventListener("click", function() {
          var generated = row.getAttribute("data-origin") === "generated" && row.getAttribute("data-status") === "active";
          if (!confirm(generated ? '${tJs("passwords.deleteGeneratedConfirm", lang)}' : '${tJs("passwords.deleteConfirm", lang)}')) return;
          guarded("/delete", generated ? { id: id, confirm_generated: true } : { id: id }, function(res) { if (res.status === 200) row.remove(); });
        });
        var vaultBtn = row.querySelector(".pw-vault");
        if (vaultBtn) vaultBtn.addEventListener("click", function() {
          vaultTarget = id;
          document.getElementById("pw-vault-msg").textContent = "";
          document.getElementById("pw-vault").hidden = false;
        });
      });

      document.getElementById("pw-vault-go").addEventListener("click", function() {
        var em = document.getElementById("pw-vault-email");
        var pw = document.getElementById("pw-vault-password");
        var msg = document.getElementById("pw-vault-msg");
        if (!vaultTarget || !em.value || !pw.value) return;
        var body = { id: vaultTarget, vault_email: em.value, vault_password: pw.value };
        pw.value = "";
        guarded("/vault-save", body, function(res) {
          msg.textContent = res.d.ok ? '${tJs("passwords.vaultSaved", lang)}' : (res.d.reason || res.d.error || '${tJs("passwords.error", lang)}');
        });
      });
      document.getElementById("pw-vault-cancel").addEventListener("click", function() {
        document.getElementById("pw-vault-password").value = "";
        document.getElementById("pw-vault").hidden = true;
        vaultTarget = null;
      });

      document.getElementById("pw-add-go").addEventListener("click", function() {
        var label = document.getElementById("pw-add-label").value.trim();
        var secret = document.getElementById("pw-add-secret").value;
        var msg = document.getElementById("pw-add-msg");
        if (!label || !secret) { msg.textContent = '${tJs("passwords.addMissing", lang)}'; return; }
        post("/add", { label: label, username: document.getElementById("pw-add-username").value.trim(), url: document.getElementById("pw-add-url").value.trim(), secret: secret }).then(function(res) {
          document.getElementById("pw-add-secret").value = "";
          if (res.status === 200) location.reload();
          else msg.textContent = res.d.error || '${tJs("passwords.error", lang)}';
        });
      });

      document.getElementById("pw-export-go").addEventListener("click", function() {
        var p1 = document.getElementById("pw-export-pass");
        var p2 = document.getElementById("pw-export-confirm");
        var msg = document.getElementById("pw-export-msg");
        if (p1.value.length < 12) { msg.textContent = '${tJs("passwords.passphraseShort", lang)}'; return; }
        if (p1.value !== p2.value) { msg.textContent = '${tJs("passwords.passphraseMismatch", lang)}'; return; }
        var body = { passphrase: p1.value };
        guarded("/export", body, function(res) {
          p1.value = ""; p2.value = "";
          if (res.status !== 200) { msg.textContent = res.d.error || '${tJs("passwords.error", lang)}'; return; }
          msg.textContent = '${tJs("passwords.exportDone", lang)}'.split("{n}").join(String(res.d.count));
          if (typeof Blob === "function" && typeof URL !== "undefined" && URL.createObjectURL) {
            var a = document.createElement("a");
            a.href = URL.createObjectURL(new Blob([JSON.stringify(res.d)], { type: "application/json" }));
            a.download = "crow-keychain-" + new Date().toISOString().slice(0, 10) + ".json";
            document.body.appendChild(a); a.click(); a.remove();
          }
        });
      });

      document.getElementById("pw-import-go").addEventListener("click", function() {
        var input = document.getElementById("pw-import-file");
        var pass = document.getElementById("pw-import-pass");
        var msg = document.getElementById("pw-import-msg");
        var f = input.files && input.files[0];
        if (!f || !pass.value) { msg.textContent = '${tJs("passwords.importMissing", lang)}'; return; }
        f.text().then(function(text) {
          var file;
          try { file = JSON.parse(text); } catch (e) { msg.textContent = '${tJs("passwords.importBadFile", lang)}'; return; }
          var body = { file: file, passphrase: pass.value };
          guarded("/import", body, function(res) {
            pass.value = "";
            if (res.status !== 200) { msg.textContent = res.d.error || '${tJs("passwords.error", lang)}'; return; }
            msg.textContent = '${tJs("passwords.importDone", lang)}'.split("{imported}").join(String(res.d.imported)).split("{skipped}").join(String(res.d.skipped));
            setTimeout(function() { location.reload(); }, 1500);
          });
        });
      });

      fetch(API + "/activity").then(function(r) { return r.json(); }).then(function(d) {
        var ul = document.getElementById("pw-activity");
        var events = (d && d.events) || [];
        if (!events.length) { var li0 = document.createElement("li"); li0.textContent = '${tJs("passwords.activityEmpty", lang)}'; ul.appendChild(li0); return; }
        events.forEach(function(e) {
          var li = document.createElement("li");
          var what = EVENTS[e.event] || e.event;
          var label = (e.details && e.details.label) ? " — " + e.details.label : "";
          li.textContent = String(e.at || "") + " · " + what + label;
          ul.appendChild(li);
        });
      }).catch(function() {});
    })();
  </script>`;
}

export default {
  id: "passwords",
  group: "account",
  icon: ICON,
  labelKey: "settings.section.passwords",
  navOrder: 12, // after Change Password (10) and Two-Factor (11)

  async getPreview({ db, lang }) {
    try {
      const { listEntries } = await import("../../../keychain/store.js");
      return fill(t("passwords.preview", lang), { n: (await listEntries(db)).length });
    } catch {
      return "-";
    }
  },

  async render({ res, db, lang }) {
    const { listEntries } = await import("../../../keychain/store.js");
    const { loadKeychainKey } = await import("../../../keychain/key.js");
    const { vaultwardenStatus } = await import("../../../keychain/vault-save.js");
    const { defaultReauthGate } = await import("../../../keychain/api.js");
    // The page lists metadata only, but keep it out of the bfcache and HTTP caches anyway.
    try { res?.set?.("Cache-Control", "no-store"); } catch {}
    const entries = await listEntries(db, { keyId: loadKeychainKey()?.id || null });
    const vs = vaultwardenStatus();
    const method = await defaultReauthGate().method();
    return renderPasswordsPage({ entries, method, vaultAvailable: !!(vs.installed && vs.cliPath), lang }) + passwordsClientJS(lang);
  },
};
````

- [ ] **Step 4: Register the section and add the strings**

````bash
cd ~/crow-wt-keychain && git apply <<'PATCH'
diff --git a/servers/gateway/dashboard/panels/settings.js b/servers/gateway/dashboard/panels/settings.js
index 207cc64..d6349c1 100644
--- a/servers/gateway/dashboard/panels/settings.js
+++ b/servers/gateway/dashboard/panels/settings.js
@@ -43,6 +43,7 @@ import deviceContextSection from "../settings/sections/device-context.js";
 import identitySection from "../settings/sections/identity.js";
 import passwordSection from "../settings/sections/password.js";
 import twoFactorSection from "../settings/sections/two-factor.js";
+import passwordsSection from "../settings/sections/passwords.js";
 import navGroupsSection from "../settings/sections/nav-groups.js";
 import llmSection from "../settings/sections/llm.js";
 import unifiedDashboardSection from "../settings/sections/unified-dashboard.js";
@@ -85,6 +86,7 @@ registerSettingsSection(deviceContextSection);
 registerSettingsSection(identitySection);
 registerSettingsSection(passwordSection);
 registerSettingsSection(twoFactorSection);
+registerSettingsSection(passwordsSection);
 
 // Load add-on settings (async, non-blocking), then run the advisory
 // sync-allowlist drift check once every section (built-in + add-on) is
diff --git a/servers/gateway/dashboard/shared/i18n.js b/servers/gateway/dashboard/shared/i18n.js
index 63f4a9d..ae01556 100644
--- a/servers/gateway/dashboard/shared/i18n.js
+++ b/servers/gateway/dashboard/shared/i18n.js
@@ -1835,6 +1835,70 @@ export const translations = {
   "keychain.showOnce": { en: "Show once", es: "Mostrar una vez" },
   "keychain.firstViewSpent": { en: "Already shown. Open Settings → Passwords to see it again.", es: "Ya se mostró. Abre Ajustes → Contraseñas para verla de nuevo." },
   "keychain.openPasswords": { en: "Open Passwords", es: "Abrir Contraseñas" },
+  "settings.section.passwords": { en: "Passwords", es: "Contraseñas" },
+  "passwords.preview": { en: "{n} saved", es: "{n} guardadas" },
+  "passwords.intro": { en: "Passwords Crow saved for your extensions, plus any you add. They stay on this machine, encrypted with a key that never leaves it and is never part of a backup; use Export to keep a copy.", es: "Contraseñas que Crow guardó para tus extensiones y las que añadas tú. Se quedan en esta máquina, cifradas con una clave que nunca sale de ella ni entra en ninguna copia de seguridad; usa Exportar para guardar una copia." },
+  "passwords.empty": { en: "No saved passwords yet.", es: "Aún no hay contraseñas guardadas." },
+  "passwords.colLabel": { en: "Name", es: "Nombre" },
+  "passwords.colExtension": { en: "Extension", es: "Extensión" },
+  "passwords.colUsername": { en: "Username", es: "Usuario" },
+  "passwords.colUrl": { en: "Address", es: "Dirección" },
+  "passwords.colStatus": { en: "Status", es: "Estado" },
+  "passwords.colUpdated": { en: "Updated", es: "Actualizada" },
+  "passwords.statusActive": { en: "In use", es: "En uso" },
+  "passwords.statusRemoved": { en: "Extension removed", es: "Extensión eliminada" },
+  "passwords.statusUnreadable": { en: "Unreadable — key missing", es: "Ilegible: falta la clave" },
+  "passwords.noReauth": { en: "Revealing, copying, deleting and exporting passwords need Crow to confirm it's you, but this Crow has no dashboard password and no two-factor authentication. Set one in Settings → Change Password or Two-Factor Auth first.", es: "Para mostrar, copiar, eliminar o exportar contraseñas, Crow tiene que confirmar que eres tú, pero esta instancia no tiene contraseña del panel ni autenticación de dos factores. Configura una primero en Ajustes → Cambiar contraseña o Autenticación 2FA." },
+  "passwords.deleteGeneratedConfirm": { en: "Crow generated this token and keeps no other copy. Without it you cannot sign in to the extension's admin page. Delete it anyway?", es: "Crow generó este token y no guarda otra copia. Sin él no podrás entrar en la página de administración de la extensión. ¿Eliminarlo de todos modos?" },
+  "passwords.exportTitle": { en: "Export and import", es: "Exportar e importar" },
+  "passwords.exportHint": { en: "Export writes every readable password into one file encrypted with a passphrase you choose. Keep it offline. Import it here, or on a new machine, to get the passwords back.", es: "Exportar guarda todas las contraseñas legibles en un archivo cifrado con una frase de paso que eliges tú. Guárdalo fuera de línea. Impórtalo aquí, o en una máquina nueva, para recuperar las contraseñas." },
+  "passwords.exportPassphrase": { en: "Passphrase (at least 12 characters)", es: "Frase de paso (al menos 12 caracteres)" },
+  "passwords.exportConfirm": { en: "Repeat the passphrase", es: "Repite la frase de paso" },
+  "passwords.export": { en: "Export", es: "Exportar" },
+  "passwords.exportDone": { en: "Exported {n} passwords. Keep the file and the passphrase in different places.", es: "Se exportaron {n} contraseñas. Guarda el archivo y la frase de paso en lugares distintos." },
+  "passwords.passphraseShort": { en: "Use at least 12 characters.", es: "Usa al menos 12 caracteres." },
+  "passwords.passphraseMismatch": { en: "The two passphrases differ.", es: "Las dos frases de paso no coinciden." },
+  "passwords.importTitle": { en: "Import an export file", es: "Importar un archivo exportado" },
+  "passwords.importFile": { en: "Export file", es: "Archivo exportado" },
+  "passwords.import": { en: "Import", es: "Importar" },
+  "passwords.importMissing": { en: "Choose the file and type its passphrase.", es: "Elige el archivo y escribe su frase de paso." },
+  "passwords.importBadFile": { en: "That is not a Crow keychain export file.", es: "Ese no es un archivo exportado del llavero de Crow." },
+  "passwords.importDone": { en: "{imported} imported, {skipped} already here.", es: "{imported} importadas, {skipped} ya estaban." },
+  "passwords.manual": { en: "Added by you", es: "Añadida por ti" },
+  "passwords.reveal": { en: "Reveal", es: "Revelar" },
+  "passwords.copy": { en: "Copy", es: "Copiar" },
+  "passwords.copied": { en: "Copied", es: "Copiada" },
+  "passwords.delete": { en: "Delete", es: "Eliminar" },
+  "passwords.vault": { en: "Save to vault", es: "Guardar en la bóveda" },
+  "passwords.deleteConfirm": { en: "Delete this saved password? This cannot be undone.", es: "¿Eliminar esta contraseña guardada? No se puede deshacer." },
+  "passwords.reauthTitle": { en: "Confirm it's you", es: "Confirma que eres tú" },
+  "passwords.reauthPassword": { en: "Your Crow's Nest password", es: "Tu contraseña de Crow's Nest" },
+  "passwords.reauthTotp": { en: "The 6-digit code from your authenticator app", es: "El código de 6 dígitos de tu app de autenticación" },
+  "passwords.reauthHint": { en: "Stays confirmed for 5 minutes.", es: "La confirmación dura 5 minutos." },
+  "passwords.confirm": { en: "Confirm", es: "Confirmar" },
+  "passwords.grantActive": { en: "Confirmed until {time}", es: "Confirmado hasta las {time}" },
+  "passwords.addTitle": { en: "Add a password", es: "Añadir una contraseña" },
+  "passwords.addHint": { en: "For app passwords and the like (for example a Workspace phone app password). This is not a general password manager.", es: "Para contraseñas de aplicaciones y similares (por ejemplo, la contraseña de la app del teléfono de Workspace). No es un gestor de contraseñas general." },
+  "passwords.secret": { en: "Password", es: "Contraseña" },
+  "passwords.add": { en: "Add", es: "Añadir" },
+  "passwords.addMissing": { en: "A name and a password are required.", es: "Hacen falta un nombre y una contraseña." },
+  "passwords.vaultTitle": { en: "Save to your Vaultwarden vault", es: "Guardar en tu bóveda de Vaultwarden" },
+  "passwords.vaultSaved": { en: "Saved to your vault.", es: "Guardada en tu bóveda." },
+  "passwords.activityTitle": { en: "Recent activity", es: "Actividad reciente" },
+  "passwords.activityEmpty": { en: "Nothing yet.", es: "Nada todavía." },
+  "passwords.error": { en: "Something went wrong. Nothing was revealed.", es: "Algo salió mal. No se reveló nada." },
+  "passwords.event.keychain_reveal": { en: "Revealed", es: "Revelada" },
+  "passwords.event.keychain_copy": { en: "Copied", es: "Copiada al portapapeles" },
+  "passwords.event.keychain_delete": { en: "Deleted", es: "Eliminada" },
+  "passwords.event.keychain_add": { en: "Added", es: "Añadida" },
+  "passwords.event.keychain_save": { en: "Saved by an extension install", es: "Guardada al instalar una extensión" },
+  "passwords.event.keychain_first_view": { en: "Shown once after install", es: "Mostrada una vez tras la instalación" },
+  "passwords.event.keychain_vault_save": { en: "Sent to Vaultwarden", es: "Enviada a Vaultwarden" },
+  "passwords.event.keychain_reauth_ok": { en: "Identity confirmed", es: "Identidad confirmada" },
+  "passwords.event.keychain_reauth_failed": { en: "Confirmation failed", es: "Confirmación fallida" },
+  "passwords.event.keychain_reauth_lockout": { en: "Locked after too many wrong confirmations", es: "Bloqueado tras demasiadas confirmaciones fallidas" },
+  "passwords.event.keychain_export": { en: "Exported", es: "Exportadas" },
+  "passwords.event.keychain_import": { en: "Imported", es: "Importadas" },
   "settings.2faEnabled": { en: "Two-factor authentication enabled.", es: "Autenticación de dos factores activada." },
   "settings.2faDisabled": { en: "Two-factor authentication disabled.", es: "Autenticación de dos factores desactivada." },
   "settings.2faCodesRegenerated": { en: "Recovery codes regenerated.", es: "Códigos de recuperación regenerados." },
PATCH
git diff --stat
````

Check the template-literal rule:

```bash
node -e 'const s=require("fs").readFileSync("servers/gateway/dashboard/settings/sections/passwords.js","utf8"); const a=s.indexOf("return `<script>"); const b=s.indexOf("</script>`;"); const body=s.slice(a+8,b); if (body.includes(String.fromCharCode(96))||body.includes(String.fromCharCode(92))) { console.error("backtick/backslash in client"); process.exit(1) } console.log("ok")'
```

- [ ] **Step 5: Run the tests**

```bash
npm test -- tests/settings-passwords-section.test.js
npm test -- tests/i18n-global-parity.test.js
npm test -- tests/settings-i18n-section-labels.test.js
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/dashboard/settings/sections/passwords.js tests/settings-passwords-section.test.js
git commit servers/gateway/dashboard/settings/sections/passwords.js tests/settings-passwords-section.test.js servers/gateway/dashboard/panels/settings.js servers/gateway/dashboard/shared/i18n.js -m "feat(settings): Passwords page — re-auth gated reveal/copy/delete, add, passphrase export/import, unreadable-key + no-re-auth states (en/es)"
git show --stat HEAD
```

---

### Task 11: Adopters — Vaultwarden (1.37.3, generated Argon2id admin token, CLI) and Workspace (generatable admin password)

**Files:**
- Modify:
  - `bundles/vaultwarden/{manifest.json,package.json,docker-compose.yml,server/server.js,skills/vaultwarden.md}`;
  - `bundles/workspace/{manifest.json,ops/lib.sh,ops/bootstrap.sh,ops/reset-password.sh}`;
  - `tests/workspace-bundle.test.js`, `tests/workspace-bootstrap.test.js`.
- Create: `tests/vaultwarden-bundle.test.js`
- Regenerate: `bundles/vaultwarden/package-lock.json`, `registry/add-ons.json`

**Interfaces:**
- Consumes: Task 1 codec, Task 2 `envfile.py`, Task 3 fields and argon2.
- Produces: `env_get KEY` in `lib.sh`, which reads `${ENV_FILE:-$BUNDLE_DIR/.env}` through `envfile.py`.

If Task 6 ruled a different CLI version, use it everywhere this task says `2026.9.1`.

- [ ] **Step 1: Write the failing tests**

Create `tests/vaultwarden-bundle.test.js`:

````js
/** Vaultwarden adopts generate+keychain+argon2id (Task 9). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { formatEnvLines } from "../servers/gateway/bundle-env-codec.js";
import { argon2idPhc, verifyArgon2idPhc } from "../servers/gateway/keychain/argon2-phc.js";

const DIR = join(import.meta.dirname, "..", "bundles", "vaultwarden");
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8"));
const token = manifest.env_vars.find((v) => v.name === "VAULTWARDEN_ADMIN_TOKEN");

test("the admin token is generated, kept in the keychain, and stored as an Argon2id hash", () => {
  assert.equal(manifest.version, "1.1.0");
  assert.equal(token.generate, "secret");
  assert.equal(token.keychain, true);
  assert.equal(token.store_as, "argon2id");
  assert.equal(token.keychain_url, "${VAULTWARDEN_DOMAIN}/admin");
  assert.doesNotMatch(token.description, /openssl|vaultwarden hash|paste/i, "no terminal instructions");
  assert.ok(!manifest.server.envKeys.includes("VAULTWARDEN_ADMIN_TOKEN"), "the MCP child never gets generated values");
  assert.ok(!JSON.stringify(manifest.requires).includes("VAULTWARDEN_ADMIN_TOKEN"));
  for (const lang of ["en", "es"]) assert.doesNotMatch(manifest.install_consent_messages[lang], /plaintext|texto plano/i);
});

test("the bundle pins the Bitwarden CLI exactly, installs it as a hard requirement, and runs a Vaultwarden it supports", () => {
  const pkg = JSON.parse(readFileSync(join(DIR, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["@bitwarden/cli"], "2026.9.1");
  assert.equal(manifest.npm_required, true, "S5: npm ci with the lock file, hard-fail instead of a half-installed MCP server");
  assert.ok(manifest.verify_paths.includes("node_modules/@bitwarden/cli/build/bw.js"));
  // Vaultwarden 1.37.0 release notes: "required for support with clients with version 2026.7.0+".
  assert.match(readFileSync(join(DIR, "docker-compose.yml"), "utf8"), /image: vaultwarden\/server:1\.37\.3\n/);
});

test("skill and MCP server no longer describe the old flow", () => {
  const skill = readFileSync(join(DIR, "skills", "vaultwarden.md"), "utf8");
  assert.doesNotMatch(skill, /openssl rand/);
  assert.match(skill, /Settings → Passwords/);
  const server = readFileSync(join(DIR, "server", "server.js"), "utf8");
  assert.doesNotMatch(server, /Bearer/, "the admin API is cookie-only on 1.32.7; a Bearer call can never work");
});

const hasCompose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
test("compose hands the container the exact PHC string (real docker compose config)", { skip: !hasCompose && "docker compose not available" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vw-compose-"));
  writeFileSync(join(dir, "docker-compose.yml"), readFileSync(join(DIR, "docker-compose.yml"), "utf8"));
  const phc = argon2idPhc("the-token");
  writeFileSync(join(dir, ".env"), formatEnvLines({ VAULTWARDEN_ADMIN_TOKEN: phc, VAULTWARDEN_DATA_DIR: join(dir, "data") }));
  const r = spawnSync("docker", ["compose", "config", "--format", "json"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const envList = JSON.parse(r.stdout).services.vaultwarden.environment;
  const admin = String(envList.ADMIN_TOKEN).replace(/\$\$/g, "$");
  assert.equal(admin, phc);
  assert.equal(verifyArgon2idPhc("the-token", admin), true);
});
````

Update the Workspace tests:

````bash
cd ~/crow-wt-keychain && git apply <<'PATCH'
diff --git a/tests/workspace-bootstrap.test.js b/tests/workspace-bootstrap.test.js
index dd31f91..e977913 100644
--- a/tests/workspace-bootstrap.test.js
+++ b/tests/workspace-bootstrap.test.js
@@ -9,6 +9,8 @@ import { spawnSync } from "node:child_process";
 import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync } from "node:fs";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
+import { formatEnvLines } from "../servers/gateway/bundle-env-codec.js";
+import { randomInt } from "node:crypto";
 
 const OPS = join(import.meta.dirname, "..", "bundles", "workspace", "ops");
 
@@ -301,3 +303,43 @@ test("restore-scratch.sh refuses a glob that matched several archives", () => {
   assert.notEqual(r2.status, 0);
   assert.match(r2.out, /looks like an archive/);
 });
+
+const WIDE_PW = "p a$s'w\"d #1 \\ é😀 ok";
+
+test("REVIEW FOCUS 1 (ops) — bootstrap pipes the exact wide-charset admin password", () => {
+  const ctx = setup();
+  const vars = { WORKSPACE_ADMIN_USER: "admin", ...SECRETS, WORKSPACE_ADMIN_PASSWORD: WIDE_PW, WORKSPACE_PUBLIC_HOST: "", WORKSPACE_NC_SERVE_PORT: "8456", WORKSPACE_OO_SERVE_PORT: "8457" };
+  writeFileSync(join(ctx.bundle, ".env"), formatEnvLines(vars), { mode: 0o600 });
+  const r = run("bootstrap.sh", ctx);
+  assert.equal(r.status, 0, r.out);
+  assert.ok(read(ctx, "stdin.log").includes(`user:resetpassword --password-from-env admin] ${vars.WORKSPACE_ADMIN_PASSWORD}\n`), "byte-exact on stdin");
+  assert.ok(!read(ctx, "calls.log").includes("p a$s"), "never argv");
+  assert.ok(!r.out.includes("p a$s"), "never printed");
+});
+
+test("reset-password.sh accepts any printable 12-128 chars, refuses control characters", () => {
+  const ctx = setup();
+  const ok = run("reset-password.sh", ctx, ["admin"], { input: "it's a $ \"wide\" pass #1\n" });
+  assert.equal(ok.status, 0, ok.out);
+  assert.match(read(ctx, "stdin.log"), /user:resetpassword --password-from-env admin\] it's a \$ "wide" pass #1/);
+  assert.notEqual(run("reset-password.sh", ctx, ["admin"], { input: "tab\there-123456\n" }).status, 0);
+  assert.notEqual(run("reset-password.sh", ctx, ["admin"], { input: "short\n" }).status, 0);
+});
+
+test("envfile.py decodes exactly what the gateway codec writes", () => {
+  const dir = mkdtempSync(join(tmpdir(), "ws-envfile-"));
+  const pool = []; for (let c = 0x20; c < 0x7f; c++) pool.push(String.fromCharCode(c)); pool.push("é", "😀");
+  const vals = {};
+  for (let i = 0; i < 40; i++) {
+    let s = ""; const n = randomInt(1, 24); for (let j = 0; j < n; j++) s += pool[randomInt(pool.length)];
+    if (s.includes("`") && (s.includes("'") || s.endsWith("\\"))) s = s.replace(/`/g, "");
+    vals[`K${i}`] = s;
+  }
+  writeFileSync(join(dir, ".env"), "# comment\nexport KX=plain\n" + formatEnvLines(vals));
+  for (const [k, v] of Object.entries({ ...vals, KX: "plain" })) {
+    const r = spawnSync("python3", [join(OPS, "envfile.py"), "get", join(dir, ".env"), k], { encoding: "utf8" });
+    assert.equal(r.status, 0, r.stderr);
+    assert.equal(r.stdout, v, `${k} ${JSON.stringify(v)}`);
+  }
+  assert.equal(spawnSync("python3", [join(OPS, "envfile.py"), "get", join(dir, ".env"), "MISSING"], { encoding: "utf8" }).stdout, "");
+});
diff --git a/tests/workspace-bundle.test.js b/tests/workspace-bundle.test.js
index 42b1987..21d51f2 100644
--- a/tests/workspace-bundle.test.js
+++ b/tests/workspace-bundle.test.js
@@ -78,8 +78,11 @@ test("the human admin password never reaches a container and is install-gated, n
   assert.equal(v.secret, true);
   assert.equal(v.propagate, false);
   assert.equal(v.default, undefined);
-  assert.ok(new RegExp(v.pattern).test("Correct-Horse-Battery-9"));
-  assert.ok(!new RegExp(v.pattern).test("has $ dollar 123"));
+  const re = new RegExp(v.pattern);
+  for (const ok of ["Correct-Horse-Battery-9", "has $ dollar 123", "it's \"quoted\" #1", "back\\slash and é😀 ok"]) assert.ok(re.test(ok), ok);
+  for (const bad of ["short-1", "tab\there-123456", "line\nbreak-123456", "x".repeat(129)]) assert.ok(!re.test(bad), JSON.stringify(bad));
+  assert.equal(v.keychain_username, "${WORKSPACE_ADMIN_USER}");
+  assert.equal(v.generatable, true, "Generate + keychain box are opt-in (C1)");
   for (const v2 of manifest.env_vars) assert.ok(v2.propagate === false || v2.generate === "secret", `${v2.name} must stay out of the gateway .env`);
   for (const n of ["WORKSPACE_NC_SERVE_PORT", "WORKSPACE_OO_SERVE_PORT", "WORKSPACE_PUBLIC_HOST", "WORKSPACE_ADMIN_USER"]) assert.ok(envVar(n).pattern, `${n} must be pattern-gated (rendered into shell commands)`);
   assert.ok(new RegExp(envVar("WORKSPACE_PUBLIC_HOST").pattern).test("crow.example-tailnet.ts.net"));
PATCH
git diff --stat
````

- [ ] **Step 2: Run them to verify they fail**

```bash
npm test -- tests/vaultwarden-bundle.test.js       # FAIL: version 1.0.0
npm test -- tests/workspace-bundle.test.js         # FAIL: "has $ dollar 123" refused / generatable missing
npm test -- tests/workspace-bootstrap.test.js      # FAIL: wide password reaches occ quoted / reset refuses it
```

- [ ] **Step 2b: Confirm the CLI's binary path before relying on it**

```bash
npm view @bitwarden/cli@2026.9.1 bin           # { bw: 'build/bw.js' }
```

- [ ] **Step 3: Apply the adopter changes**

````bash
cd ~/crow-wt-keychain && git apply <<'PATCH'
diff --git a/bundles/vaultwarden/docker-compose.yml b/bundles/vaultwarden/docker-compose.yml
index ba7bdf0..e930614 100644
--- a/bundles/vaultwarden/docker-compose.yml
+++ b/bundles/vaultwarden/docker-compose.yml
@@ -10,7 +10,8 @@
 
 services:
   vaultwarden:
-    image: vaultwarden/server:1.32.7
+    # 1.37.0+ is required by Bitwarden clients 2026.7.0+ (release notes), incl. the CLI Crow uses.
+    image: vaultwarden/server:1.37.3
     container_name: crow-vaultwarden
     ports:
       - "127.0.0.1:8097:80"
diff --git a/bundles/vaultwarden/manifest.json b/bundles/vaultwarden/manifest.json
index 727c32f..645ff7b 100644
--- a/bundles/vaultwarden/manifest.json
+++ b/bundles/vaultwarden/manifest.json
@@ -1,7 +1,7 @@
 {
   "id": "vaultwarden",
   "name": "Vaultwarden",
-  "version": "1.0.0",
+  "version": "1.1.0",
   "description": "Bitwarden-compatible password manager — self-hosted vault for passwords, notes, and 2FA, used with the Bitwarden browser and mobile apps",
   "type": "bundle",
   "author": "Crow",
@@ -9,19 +9,21 @@
   "tags": ["passwords", "vault", "bitwarden", "secrets", "security", "self-hosted"],
   "icon": "lock",
   "docker": { "composefile": "docker-compose.yml" },
-  "server": { "command": "node", "args": ["server/index.js"], "envKeys": ["VAULTWARDEN_URL", "VAULTWARDEN_ADMIN_TOKEN"] },
+  "server": { "command": "node", "args": ["server/index.js"], "envKeys": ["VAULTWARDEN_URL"] },
+  "npm_required": true,
+  "verify_paths": ["node_modules/@bitwarden/cli/build/bw.js", "node_modules/@modelcontextprotocol/sdk/package.json"],
   "panel": "panel/vaultwarden.js",
   "panelRoutes": "panel/routes.js",
   "skills": ["skills/vaultwarden.md"],
   "consent_required": true,
   "install_consent_messages": {
-    "en": "Vaultwarden stores the passwords and secrets for your entire digital life. Before you install: (1) this bundle will hold every credential you import, so back up ~/.crow/vaultwarden/data on a recurring schedule — losing it means losing everything; (2) the admin token sits in your .env file in plaintext — anyone with shell access on this host can administer the vault; (3) signups default to OPEN — without the admin token, anyone who can reach http://localhost:8097 can create the first account and lock you out. Create your account immediately after first start, then set VAULTWARDEN_SIGNUPS_ALLOWED=false and restart the bundle. The Crow MCP tools intentionally do NOT expose vault contents — use the official Bitwarden browser extension or mobile app as your working client.",
-    "es": "Vaultwarden guardará las contraseñas y secretos de toda tu vida digital. Antes de instalar: (1) este bundle contendrá todas tus credenciales, haz copias de seguridad periódicas de ~/.crow/vaultwarden/data — perderlo significa perderlo todo; (2) el token de administrador queda en el archivo .env en texto plano — cualquiera con acceso al shell puede administrar el vault; (3) por defecto se permiten registros — sin proteger el token, cualquiera que pueda alcanzar http://localhost:8097 puede crear la primera cuenta y dejarte fuera. Crea tu cuenta inmediatamente tras el primer arranque, luego pon VAULTWARDEN_SIGNUPS_ALLOWED=false y reinicia. Las herramientas MCP de Crow intencionalmente NO exponen el contenido del vault — usa la extensión oficial de Bitwarden o la app móvil como cliente."
+    "en": "Vaultwarden stores the passwords and secrets for your entire digital life. Before you install: (1) this bundle will hold every credential you import, so back up ~/.crow/vaultwarden/data on a recurring schedule — losing it means losing everything; (2) Crow generates the admin token, keeps only its Argon2id hash in the extension's settings, and saves the token in Settings → Passwords (encrypted, this machine only); (3) signups default to OPEN — without the admin token, anyone who can reach http://localhost:8097 can create the first account and lock you out. Create your account immediately after first start, then set VAULTWARDEN_SIGNUPS_ALLOWED=false and restart the bundle. The Crow MCP tools intentionally do NOT expose vault contents — use the official Bitwarden browser extension or mobile app as your working client.",
+    "es": "Vaultwarden guardará las contraseñas y secretos de toda tu vida digital. Antes de instalar: (1) este bundle contendrá todas tus credenciales, haz copias de seguridad periódicas de ~/.crow/vaultwarden/data — perderlo significa perderlo todo; (2) Crow genera el token de administrador, guarda solo su hash Argon2id en la configuración de la extensión y guarda el token en Ajustes → Contraseñas (cifrado, solo en esta máquina); (3) por defecto se permiten registros — sin proteger el token, cualquiera que pueda alcanzar http://localhost:8097 puede crear la primera cuenta y dejarte fuera. Crea tu cuenta inmediatamente tras el primer arranque, luego pon VAULTWARDEN_SIGNUPS_ALLOWED=false y reinicia. Las herramientas MCP de Crow intencionalmente NO exponen el contenido del vault — usa la extensión oficial de Bitwarden o la app móvil como cliente."
   },
-  "requires": { "env": ["VAULTWARDEN_ADMIN_TOKEN"], "min_ram_mb": 256, "min_disk_mb": 200 },
+  "requires": { "min_ram_mb": 256, "min_disk_mb": 200 },
   "env_vars": [
     { "name": "VAULTWARDEN_URL", "description": "Vaultwarden server URL", "default": "http://localhost:8097", "required": true },
-    { "name": "VAULTWARDEN_ADMIN_TOKEN", "description": "Argon2id or Bcrypt hash protecting /admin. Generate with: openssl rand -base64 48 (store the output, then run `vaultwarden hash` inside the container to get the hash to paste here). For a simpler MVP you may paste the plain random string — Vaultwarden accepts both.", "required": true, "secret": true },
+    { "name": "VAULTWARDEN_ADMIN_TOKEN", "description": "Token for the /admin page. Crow generates it at install, keeps only an Argon2id hash in this extension's settings, saves the token itself in Settings → Passwords (encrypted, this machine only) and shows it to you once after install.", "required": true, "secret": true, "generate": "secret", "keychain": true, "store_as": "argon2id", "keychain_label": "admin page token", "keychain_url": "${VAULTWARDEN_DOMAIN}/admin" },
     { "name": "VAULTWARDEN_DOMAIN", "description": "Public URL Vaultwarden advertises to clients (set to https://... when put behind Caddy)", "default": "http://localhost:8097", "required": false },
     { "name": "VAULTWARDEN_SIGNUPS_ALLOWED", "description": "Whether new users can sign up via the web UI. Start true, create your admin account, then flip to false and restart.", "default": "true", "required": false }
   ],
diff --git a/bundles/vaultwarden/package.json b/bundles/vaultwarden/package.json
index a137007..e0ac23d 100644
--- a/bundles/vaultwarden/package.json
+++ b/bundles/vaultwarden/package.json
@@ -5,6 +5,7 @@
   "type": "module",
   "main": "server/index.js",
   "dependencies": {
+    "@bitwarden/cli": "2026.9.1",
     "@modelcontextprotocol/sdk": "^1.12.0",
     "zod": "^3.24.0"
   }
diff --git a/bundles/vaultwarden/server/server.js b/bundles/vaultwarden/server/server.js
index 7e5282e..2df1680 100644
--- a/bundles/vaultwarden/server/server.js
+++ b/bundles/vaultwarden/server/server.js
@@ -6,7 +6,7 @@
  * are for. The tools here only surface operational health:
  *
  *   - vaultwarden_status       Is the server reachable? Build version?
- *   - vaultwarden_user_count   How many accounts exist? (via /admin)
+ *   - vaultwarden_user_count   Explains where to see accounts (the admin API is browser-session only)
  *   - vaultwarden_backup_info  Size and age of ~/.crow/vaultwarden/data
  *
  * Any tool that could expose secrets is intentionally not provided.
@@ -19,7 +19,6 @@ import { join } from "node:path";
 import { homedir } from "node:os";
 
 const VAULTWARDEN_URL = () => (process.env.VAULTWARDEN_URL || "http://localhost:8097").replace(/\/+$/, "");
-const ADMIN_TOKEN = () => process.env.VAULTWARDEN_ADMIN_TOKEN || "";
 
 function resolveDataDir() {
   const env = process.env.VAULTWARDEN_DATA_DIR;
@@ -124,43 +123,14 @@ export function createVaultwardenServer(options = {}) {
 
   server.tool(
     "vaultwarden_user_count",
-    "Return the number of registered Vaultwarden users. Requires a valid VAULTWARDEN_ADMIN_TOKEN — the admin API does not expose passwords, only account metadata.",
+    "Explain how to see Vaultwarden's accounts. Vaultwarden's admin API only accepts the browser session created by its /admin login page, and Crow keeps the admin token as a hash, so this tool cannot list accounts itself.",
     {},
-    async () => {
-      try {
-        const token = ADMIN_TOKEN();
-        if (!token) {
-          return { content: [{ type: "text", text: "Error: VAULTWARDEN_ADMIN_TOKEN is not set" }] };
-        }
-        const res = await vwFetch("/admin/users", {
-          headers: { "Authorization": `Bearer ${token}` },
-        });
-        if (!res.ok) {
-          if (res.status === 401 || res.status === 403) {
-            return { content: [{ type: "text", text: "Error: admin token rejected — check VAULTWARDEN_ADMIN_TOKEN" }] };
-          }
-          return { content: [{ type: "text", text: `Error: admin API returned ${res.status}` }] };
-        }
-        const users = await res.json();
-        const list = Array.isArray(users) ? users : [];
-        return {
-          content: [{
-            type: "text",
-            text: JSON.stringify({
-              user_count: list.length,
-              accounts: list.map((u) => ({
-                email: u.Email || u.email || null,
-                disabled: !!(u.Disabled ?? u.disabled),
-                two_factor: !!(u.TwoFactorEnabled ?? u.two_factor_enabled),
-                last_active: u.LastActive || u.last_active || null,
-              })),
-            }, null, 2),
-          }],
-        };
-      } catch (err) {
-        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
-      }
-    },
+    async () => ({
+      content: [{
+        type: "text",
+        text: `Not available from here: Vaultwarden's admin API only accepts the browser session created by its /admin login page, and Crow stores the admin token as an Argon2id hash. Open ${VAULTWARDEN_URL()}/admin and sign in with the token from Crow's Settings → Passwords to see accounts.`,
+      }],
+    }),
   );
 
   server.tool(
diff --git a/bundles/vaultwarden/skills/vaultwarden.md b/bundles/vaultwarden/skills/vaultwarden.md
index fa38615..d9b10de 100644
--- a/bundles/vaultwarden/skills/vaultwarden.md
+++ b/bundles/vaultwarden/skills/vaultwarden.md
@@ -23,13 +23,19 @@ connect to it over HTTP(S).
 
 ## One-time setup (do this in order)
 
-1. **Generate an admin token:**
-   ```
-   openssl rand -base64 48
-   ```
-   Store the output in `.env` as `VAULTWARDEN_ADMIN_TOKEN`. Vaultwarden
-   accepts the raw token (simplest) or a hashed form — for MVP, use the
-   raw token and keep `.env` readable only by your user.
+1. **Admin token: nothing to do.** Crow generates it when you install the
+   extension, keeps only an Argon2id hash in the extension's settings, and
+   saves the token itself in **Settings → Passwords** (encrypted, this machine
+   only). The Extensions page shows it to you once right after install; later,
+   reveal it from Settings → Passwords (Crow asks you to confirm it's you).
+   Use it to sign in at `/admin`.
+
+   **Installed before Crow generated tokens?** Your typed token keeps working: Crow
+   reuses it as it is (plaintext in the extension's settings, not in the keychain) — add
+   it to Settings → Passwords yourself if you want it there. Such an install also keeps
+   its older Vaultwarden server image until you reinstall the extension (your vault data
+   in `~/.crow/vaultwarden/data` is kept); saving passwords to the vault from Crow needs
+   Vaultwarden 1.37 or newer, and Crow tells you when a reinstall is needed.
 
 2. **Start the bundle** from the Extensions panel.
 
diff --git a/bundles/workspace/manifest.json b/bundles/workspace/manifest.json
index 1dc5dfb..07142ee 100644
--- a/bundles/workspace/manifest.json
+++ b/bundles/workspace/manifest.json
@@ -1,7 +1,7 @@
 {
   "id": "workspace",
   "name": "Crow Workspace",
-  "version": "0.1.1",
+  "version": "0.1.2",
   "description": "Your own private office on this machine: files, documents you can edit together (ONLYOFFICE), calendars and contacts that sync to your phones, and forms, built on Nextcloud. Tailnet only, never public.",
   "type": "bundle",
   "author": "Crow",
@@ -32,10 +32,12 @@
     },
     {
       "name": "WORKSPACE_ADMIN_PASSWORD",
-      "description": "Password for that administrator account. Used once by setup, then removed from this machine's config; change it later inside Workspace (Settings, Security). 12-128 characters: letters, digits and ! % * + , - . / : = ? @ ^ _ ~ (no spaces, quotes, $ or #).",
-      "install_required": true, "secret": true, "propagate": false, "check": "not_breached",
-      "pattern": "^[A-Za-z0-9!%*+,./:=?@^_~-]{12,128}$",
-      "pattern_hint": "12-128 letters, digits or ! % * + , - . / : = ? @ ^ _ ~"
+      "description": "Password for that administrator account. Use Generate for a strong one or type your own: 12-128 characters, any letters, digits, spaces or symbols. Keep 'Save to Crow keychain' ticked to find it later in Settings → Passwords. Setup uses it once, then removes it from this machine's config; change it later inside Workspace (Settings, Security).",
+      "install_required": true, "secret": true, "propagate": false, "check": "not_breached", "generatable": true,
+      "pattern": "^[^\\x00-\\x1f\\x7f]{12,128}$",
+      "pattern_hint": "12-128 characters, without tabs or line breaks",
+      "keychain_label": "admin password",
+      "keychain_username": "${WORKSPACE_ADMIN_USER}"
     },
     { "name": "WORKSPACE_FIRSTRUN_ADMIN_PASSWORD", "description": "Throwaway password for the image's first install (generated; replaced by setup).", "required": true, "secret": true, "generate": "secret" },
     { "name": "WORKSPACE_DB_ROOT_PASSWORD", "description": "MariaDB root password (generated).", "required": true, "secret": true, "generate": "secret" },
diff --git a/bundles/workspace/ops/bootstrap.sh b/bundles/workspace/ops/bootstrap.sh
index b097d2d..a64d827 100755
--- a/bundles/workspace/ops/bootstrap.sh
+++ b/bundles/workspace/ops/bootstrap.sh
@@ -22,7 +22,6 @@ RETAINED_DIR="$CROW_HOME/secrets/bundle-env"
 RETAINED="$RETAINED_DIR/workspace.env"
 HOST_RE='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
 
-env_get() { [ -f "$ENV_FILE" ] || return 0; sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
 env_rewrite() {  # $1 = key to drop; $2 = optional "KEY=value" line to append. Atomic, 600.
   local tmp
   tmp="$(mktemp "$BUNDLE_DIR/.env.XXXXXX")"
diff --git a/bundles/workspace/ops/lib.sh b/bundles/workspace/ops/lib.sh
index 190d05e..e1f594d 100755
--- a/bundles/workspace/ops/lib.sh
+++ b/bundles/workspace/ops/lib.sh
@@ -9,6 +9,15 @@
 BUNDLE_DIR="${CROW_BUNDLE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
 export CROW_HOME="${CROW_HOME:-$HOME/.crow}"
 DC="${WORKSPACE_DC:-docker compose}"
+OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
+# env_get KEY: the value compose would see, decoded by ops/envfile.py (no eval, no sed):
+# the installer quotes values with spaces, quotes, $ or # (bundle-env-codec.js), so a
+# raw `sed s/^KEY=//` would return the QUOTED text. ENV_FILE defaults to the bundle .env.
+env_get() {
+  local f="${ENV_FILE:-$BUNDLE_DIR/.env}"
+  [ -f "$f" ] || return 0
+  python3 "$OPS_DIR/envfile.py" get "$f" "$1"
+}
 
 log() { printf '[workspace] %s\n' "$*"; }
 die() { printf '[workspace] ERROR: %s\n' "$*" >&2; exit 1; }
diff --git a/bundles/workspace/ops/reset-password.sh b/bundles/workspace/ops/reset-password.sh
index c0563fa..adce2bd 100755
--- a/bundles/workspace/ops/reset-password.sh
+++ b/bundles/workspace/ops/reset-password.sh
@@ -8,7 +8,11 @@ umask 077
 LOGIN="${1:-}"
 [[ "$LOGIN" =~ ^[a-z][a-z0-9._-]{1,31}$ ]] || die "usage: reset-password.sh <login>"
 if [ -t 0 ]; then IFS= read -rsp "New password for $LOGIN: " PW; echo; else IFS= read -r PW; fi
-[[ "$PW" =~ ^[A-Za-z0-9!%*+,./:=?@^_~-]{12,128}$ ]] || die "password must be 12-128 letters, digits or ! % * + , - . / : = ? @ ^ _ ~"
+# Same rule as the manifest pattern ^[^\x00-\x1f\x7f]{12,128}$, counted the same way (UTF-16
+# code units, like the install form's JavaScript RegExp — review S10), via stdin, never argv.
+PW_LEN="$(printf '%s' "$PW" | python3 -c 'import sys; s=sys.stdin.buffer.read().decode("utf-8","replace"); print(len(s.encode("utf-16-le"))//2)')"
+{ [ "$PW_LEN" -ge 12 ] && [ "$PW_LEN" -le 128 ]; } || die "password must be 12-128 characters"
+case "$PW" in *[[:cntrl:]]*) die "password must not contain tabs, line breaks or other control characters" ;; esac
 step "resetting the password"
 printf '%s\n' "$PW" | occ_with_pass user:resetpassword --password-from-env "$LOGIN" >/dev/null
 unset PW
PATCH
git diff --stat
````

- [ ] **Step 4: Lock file and registry**

```bash
(cd bundles/vaultwarden && npm install --package-lock-only --omit=dev --no-audit --no-fund)
grep -c '"node_modules/@bitwarden/cli"' bundles/vaultwarden/package-lock.json    # 1
npm audit --prefix bundles/vaultwarden --omit=dev --audit-level=critical          # must exit 0 (Task 12 makes this a CI gate)
node scripts/build-registry.mjs && node scripts/build-registry.mjs --check
```

If the audit reports a critical advisory in the CLI's tree: stop and tell Kevin. Do not ship a credential-handling dependency with a known critical.

- [ ] **Step 5: Run the tests**

```bash
npm test -- tests/vaultwarden-bundle.test.js
npm test -- tests/workspace-bundle.test.js
npm test -- tests/workspace-bootstrap.test.js
npm test -- tests/workspace-panel.test.js
npm test -- tests/bundle-server-deps.test.js
npm test -- tests/bundle-env-keychain-generate.test.js
```

Expected: all PASS. The real-compose test renders `ADMIN_TOKEN` as the exact PHC.

- [ ] **Step 6: Commit**

```bash
git add tests/vaultwarden-bundle.test.js
git commit bundles/vaultwarden/manifest.json bundles/vaultwarden/package.json bundles/vaultwarden/package-lock.json bundles/vaultwarden/docker-compose.yml bundles/vaultwarden/server/server.js bundles/vaultwarden/skills/vaultwarden.md bundles/workspace/manifest.json bundles/workspace/ops/lib.sh bundles/workspace/ops/bootstrap.sh bundles/workspace/ops/reset-password.sh tests/vaultwarden-bundle.test.js tests/workspace-bundle.test.js tests/workspace-bootstrap.test.js registry/add-ons.json -m "feat(bundles): Vaultwarden 1.1.0 (image 1.37.3, generated Argon2id admin token in the keychain, Bitwarden CLI); Workspace 0.1.2 generatable admin password"
git show --stat HEAD
```

---

### Task 12: Full local gates + CI audit of the vaultwarden bundle

**Files:** Modify `.github/workflows/test.yml`. A new step in the existing `audit` job; the job key and the job name are unchanged, as branch protection requires.

- [ ] **Step 1: Add the blocking audit step**

````bash
cd ~/crow-wt-keychain && git apply <<'PATCH'
diff --git a/.github/workflows/test.yml b/.github/workflows/test.yml
index b8701a0..83789b3 100644
--- a/.github/workflows/test.yml
+++ b/.github/workflows/test.yml
@@ -106,6 +106,15 @@ jobs:
             echo "npm audit failed, retry $i/3"; sleep $((i*10))
           done
           exit 1
+      # The vaultwarden bundle carries the Bitwarden CLI, which handles vault credentials
+      # (Crow keychain): its own lock file gets the same blocking critical-tier audit.
+      - name: npm audit (blocking, critical, vaultwarden bundle production deps)
+        run: |
+          for i in 1 2 3; do
+            npm audit --prefix bundles/vaultwarden --omit=dev --audit-level=critical && exit 0
+            echo "npm audit failed, retry $i/3"; sleep $((i*10))
+          done
+          exit 1
       - name: npm audit (informational, full)
         continue-on-error: true
         run: npm audit || true
PATCH
git diff --stat
````

- [ ] **Step 2: Every CI gate locally**

```bash
cd ~/crow-wt-keychain
npm test                                   # FULL suite; 0 failures vs the Task 0 baseline
node scripts/check-port-allocation.js      # OK (no new ports)
node scripts/build-registry.mjs --check    # OK
npm audit --omit=dev --audit-level=critical
npm audit --prefix bundles/vaultwarden --omit=dev --audit-level=critical
npm test -- tests/auth-network.test.js
```

- [ ] **Step 3: Secret-hygiene review.** Read every hit; each must log a fixed string, a key name or a count, never a value.

```bash
git diff origin/main --name-only | grep -E '\.(js|mjs)$' | xargs grep -nE "console\.(log|error|warn)\(" | grep -iE "secret|password|master|plain|token" || echo "no suspicious log lines"
grep -rn "keychain.key" servers scripts bundles --include=*.js --include=*.mjs --include=*.sh | grep -v "servers/gateway/keychain/key.js" || echo "only key.js names the key file"
```

- [ ] **Step 4: Commit and push**

```bash
git commit .github/workflows/test.yml -m "ci: blocking critical-tier npm audit of the vaultwarden bundle (Bitwarden CLI)"
git show --stat HEAD
git pull --rebase origin main
git push -u origin feat/crow-keychain
```

---

### Task 13: PRE-MERGE attended smoke window on crow (throwaway CROW_HOME, deadman-guarded) — LIVE

**What it proves before anything merges:**
1. A generated token's Argon2id PHC, written by the branch's installer code, opens a real Vaultwarden 1.37.3 `/admin`, and a wrong token does not.
2. The keychain entry is sealed under the scratch key file, and a crow.db copy without that file reads as unreadable.
3. The Bitwarden-CLI save works through `http://localhost`, with the master password never in argv and no appdata left.
4. Wide-charset values, tildes included, survive a real container start.

**Touches:**
- scratch dirs under `/tmp/claude-1000/kc-smoke`;
- a throwaway Vaultwarden (compose project `crow-kc-smoke`, container `crow-kc-smoke-vw`, `127.0.0.1:18097`, `restart: "no"`);
- a one-shot `alpine` env-check container;
- temporary tailnet-only Serve `8461` for the [KEVIN] registration. An `ssh -L 18097:127.0.0.1:18097` tunnel works too: `http://localhost` is a WebCrypto secure context.

Prod is never stopped, and no model container is touched.

**Helpers:**
- `kc-smoke-deadman` (a timer, 2 h);
- `kc-smoke-sampler` (`RuntimeMaxSec=7200`), matching only `bw.js` processes (review S9).

Every step starts with `source /tmp/claude-1000/kc-smoke/vars.sh`.

**Deviations recorded by the 2026-10-03 live run:** the Bitwarden CLI (pinned 2026.8.0) refuses plain `http://`, so the CLI/`saveToVault` use the https Serve URL (`vaultwardenStatus` already prefers `VAULTWARDEN_DOMAIN`); only curl/fetch checks use `http://localhost:18097`. Step 6's argv sampler as a systemd user unit captured nothing, so its "never in argv" PASS was vacuous: validate the sampler with a canary login first, or poll inline.

**Sudo** (Serve only): `sudo -S` with the credential from the global CLAUDE.md, never written to a file or this plan; or Kevin runs those lines.

**Findings** go in `$SMOKE/findings.md`. Any FAIL means a fix commit with its unit test, plus a re-run of the affected step in a new registered window, before Task 14.

**Files:** none in the repo.

- [ ] **Step 1: Check, register, write helpers, arm the deadman**

```bash
ss -ltn | grep -qE ':18097\b' && echo "18097 BUSY" || echo "18097 free"
tailscale serve status | grep -q ':8461' && echo "8461 BUSY" || echo "8461 free"
docker ps -a --format '{{.Names}}' | grep -qE '^crow-kc-smoke' && echo "stale smoke containers: run teardown first" || echo "clean"
```

Read `~/CROW-SCHEDULE.md`, then add a Reservations row:

```markdown
| **2026-10-0X HH:MM → +2 h hard cap (attended; transient units kc-smoke-{deadman,sampler}; deadman tears down at the cap)** | **Crow keychain PRE-MERGE smoke**: throwaway Vaultwarden 1.37.3 `crow-kc-smoke` on 127.0.0.1:18097 + temp Serve 8461 (tailnet only); one-shot alpine env-check; scratch CROW_HOME/CROW_DATA_DIR under /tmp/claude-1000/kc-smoke. No GPU, no model containers, prod untouched. | Claude session (crow) + Kevin | manual | no crow-kc-smoke* containers AND `systemctl --user list-units 'kc-smoke-*'` empty AND serve 8461 off AND no crow-bw-* dirs under the scratch home AND row moved to Done |
```

Then:

```bash
SMOKE=/tmp/claude-1000/kc-smoke; rm -rf $SMOKE; mkdir -p $SMOKE; chmod 700 $SMOKE
cat > $SMOKE/vars.sh <<'EOF'
# Sourced at the top of EVERY smoke step.
SMOKE=/tmp/claude-1000/kc-smoke
REPO=$HOME/crow-wt-keychain
B=$SMOKE/home/bundles/vaultwarden
unset CROW_DB_PATH CROW_APP_ROOT CROW_BACKUP_DIR        # review S9: nothing may point at prod
export CROW_HOME=$SMOKE/home CROW_DATA_DIR=$SMOKE/data CROW_AUTO_UPDATE=0 CROW_DISABLE_INSTANCE_SYNC=1 CROW_DISABLE_HEALTH_MONITOR=1 CROW_DISABLE_NOSTR=1
SDC="docker compose -p crow-kc-smoke -f docker-compose.yml -f smoke.override.yml"
sdc() { (cd $B && $SDC "$@"); }
EOF
cat > $SMOKE/teardown.sh <<'EOF'
#!/usr/bin/env bash
SMOKE=/tmp/claude-1000/kc-smoke
systemctl --user stop kc-smoke-sampler.service 2>/dev/null
B=$SMOKE/home/bundles/vaultwarden
[ -f $B/.env ] && (cd $B && docker compose -p crow-kc-smoke -f docker-compose.yml -f smoke.override.yml down -v --remove-orphans) 2>/dev/null
for p in crow-kc-smoke crow-kc-envcheck; do
  docker ps -aq --filter label=com.docker.compose.project=$p | xargs -r docker rm -f 2>/dev/null
  docker network rm ${p}_default 2>/dev/null
done
rm -rf $SMOKE/home/tmp/crow-bw-* 2>/dev/null
[ -d $SMOKE/vwdata ] && docker run --rm -v $SMOKE:/s alpine:latest rm -rf /s/vwdata 2>/dev/null
echo "teardown done $(date +%T). Serve 8461 needs: sudo tailscale serve --https=8461 off (the deadman cannot sudo; a stale mapping only 502s)" >> $SMOKE/teardown.log
EOF
cat > $SMOKE/sampler.sh <<'EOF'
#!/usr/bin/env bash
# kc-smoke-sampler: every 0.1 s, argv of bw.js processes ONLY (no other node process on the box).
while :; do ps -eo args | grep -F 'bw.js' | grep -v grep; sleep 0.1; done \
  | awk '!seen[$0]++ { print; fflush() }' > /tmp/claude-1000/kc-smoke/argv.log
EOF
chmod +x $SMOKE/teardown.sh $SMOKE/sampler.sh
systemd-run --user --unit=kc-smoke-deadman --on-active=7200 /bin/bash $SMOKE/teardown.sh
systemctl --user list-timers kc-smoke-deadman.timer
```

- [ ] **Step 2: Scratch install copy; the CLI installed with the installer's OWN npm flags** (review S9)

```bash
source /tmp/claude-1000/kc-smoke/vars.sh
docker pull vaultwarden/server:1.37.3
mkdir -p $SMOKE/home/bundles $CROW_DATA_DIR $SMOKE/vwdata
cp -r $REPO/bundles/vaultwarden $B
# Exactly runInstallJob's npm_required command (servers/gateway/routes/bundles.js, the npm_required branch):
(cd $B && npm ci --omit=optional --no-audit --no-fund --ignore-scripts)
node $B/node_modules/@bitwarden/cli/build/bw.js --version        # 2026.9.1 (or Task 6's pin)
test -f $B/node_modules/@modelcontextprotocol/sdk/package.json && echo "PASS verify_paths"
cat > $B/smoke.override.yml <<'EOF'
services:
  vaultwarden:
    container_name: crow-kc-smoke-vw
    restart: "no"
    ports: !override
      - "127.0.0.1:18097:80"
EOF
(cd $REPO && node scripts/init-db.js >/dev/null) && echo "scratch db ready"
```

- [ ] **Step 3: The `.env` and the keychain entry, written by the BRANCH's installer code, in order** (plan → keychain → persist → `.env`)

```bash
source /tmp/claude-1000/kc-smoke/vars.sh
cd $REPO && B=$B SMOKE=$SMOKE node --input-type=module -e '
import { readFileSync } from "node:fs";
const B = process.env.B, SMOKE = process.env.SMOKE;
const { planGeneratedEnv } = await import("./servers/gateway/bundle-env-secrets.js");
const { writeInstallEnv } = await import("./servers/gateway/routes/bundles.js");
const { recordKeychainForInstall } = await import("./servers/gateway/keychain/install-hooks.js");
const manifest = JSON.parse(readFileSync(`${B}/manifest.json`, "utf8"));
const plan = planGeneratedEnv("vaultwarden", manifest, { destDir: B, crowHome: process.env.CROW_HOME });
const installEnv = { VAULTWARDEN_URL: "http://localhost:18097", VAULTWARDEN_DOMAIN: "https://crow.dachshund-chromatic.ts.net:8461", VAULTWARDEN_SIGNUPS_ALLOWED: "true", VAULTWARDEN_DATA_DIR: `${SMOKE}/vwdata`, ...plan.env };
const out = await recordKeychainForInstall({ bundleId: "vaultwarden", manifest, env: installEnv, minted: plan.minted, keychainReq: null, log: (m) => console.log("[job]", m) });
if (!out.mintedSaved) { console.log("FAIL keychain save"); process.exit(1); }
plan.persist();
writeInstallEnv(B, installEnv, manifest);
console.log("minted:", Object.keys(plan.minted), "saved:", out.saved, "first-view ids:", out.firstView);
process.exit(0);
'
grep -cF "VAULTWARDEN_ADMIN_TOKEN='\$argon2id\$v=19\$m=65540,t=3,p=4\$" $B/.env    # 1
stat -c '%a %n' $B/.env $SMOKE/home/secrets/keychain.key $SMOKE/home/secrets          # 600 600 700
```

PASS: `minted: [ 'VAULTWARDEN_ADMIN_TOKEN' ] saved: 1`, a single-quoted PHC line, and modes `600 600 700`.

- [ ] **Step 4: Start Vaultwarden; the PHC reached the container intact; `/admin` accepts the keychain plaintext**

```bash
source /tmp/claude-1000/kc-smoke/vars.sh
sdc up -d
for i in $(seq 1 30); do curl -fsS http://localhost:18097/alive >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://localhost:18097/alive >/dev/null && echo "PASS alive" || echo "FAIL not alive"
A=$(docker exec crow-kc-smoke-vw printenv ADMIN_TOKEN | sha256sum | cut -c1-16)
E=$(cd $REPO && B=$B node --input-type=module -e 'import { readFileSync } from "node:fs"; import { parseEnvText } from "./servers/gateway/bundle-env-codec.js"; process.stdout.write(parseEnvText(readFileSync(process.env.B + "/.env","utf8")).VAULTWARDEN_ADMIN_TOKEN + "\n")' | sha256sum | cut -c1-16)
[ "$A" = "$E" ] && echo "PASS container ADMIN_TOKEN == .env PHC" || echo "FAIL $A != $E"
N=$(docker logs crow-kc-smoke-vw 2>&1 | grep -ciE "plain text ADMIN_TOKEN|PHC in .ADMIN_TOKEN. is invalid"); [ "$N" = 0 ] && echo "PASS no token warnings" || echo "FAIL $N token warnings"
cd $REPO && node --input-type=module -e '
const { createDbClient } = await import("./servers/db.js");
const { loadKeychainKey } = await import("./servers/gateway/keychain/key.js");
const K = await import("./servers/gateway/keychain/store.js");
const db = createDbClient();
const key = loadKeychainKey();
const e = (await K.listEntries(db, { keyId: key.id })).find((x) => x.env_key === "VAULTWARDEN_ADMIN_TOKEN");
const tok = await K.openEntrySecret(db, key, e.id);
const login = (t) => fetch("http://localhost:18097/admin", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: t }) });
const good = await login(tok); const bad = await login(tok + "x");
console.log(/VW_ADMIN=/.test(good.headers.get("set-cookie") || "") ? "PASS good token → VW_ADMIN cookie" : "FAIL no cookie for the right token");
console.log(/VW_ADMIN=/.test(bad.headers.get("set-cookie") || "") ? "FAIL cookie for a wrong token" : "PASS wrong token refused");
console.log(e.url === "https://crow.dachshund-chromatic.ts.net:8461/admin" && e.first_view_pending ? "PASS entry url + first view" : "FAIL entry " + JSON.stringify(e));
const none = (await K.listEntries(db, { keyId: null })).find((x) => x.id === e.id);
console.log(none.readable === false ? "PASS without the key file the entry reads as unreadable" : "FAIL readable without key");
db.close();
process.exit(0);   // the libsql client keeps the loop alive otherwise (smoke 2026-10-03)
'
```

- [ ] **Step 5: [KEVIN] Register a throwaway vault account**

```bash
sudo -S tailscale serve --bg --https=8461 http://127.0.0.1:18097     # credential per global CLAUDE.md, or Kevin runs it
```

**[KEVIN]:**
1. Open `https://crow.dachshund-chromatic.ts.net:8461/`.
2. Create `kc-smoke@example.invalid` with a throwaway master password, never typed into the Claude session.
3. Say "registered".

- [ ] **Step 6: [KEVIN] The branch's `saveToVault` through `http://localhost`, run in Kevin's terminal**

```bash
source /tmp/claude-1000/kc-smoke/vars.sh
systemd-run --user --unit=kc-smoke-sampler -p RuntimeMaxSec=7200 /bin/bash $SMOKE/sampler.sh
cat > $SMOKE/vault-save.sh <<'EOF'
#!/usr/bin/env bash
# Kevin runs: bash /tmp/claude-1000/kc-smoke/vault-save.sh
source /tmp/claude-1000/kc-smoke/vars.sh
read -rp "vault email: " EMAIL
read -rsp "vault master password (throwaway): " MASTER; echo
cd $REPO
run() {  # $1 = master password; the node child reads both lines from stdin (never argv/env)
  printf '%s\n%s\n' "$EMAIL" "$1" | node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const [email, master] = readFileSync(0, "utf8").split("\n");
    const { vaultwardenStatus, saveToVault } = await import("./servers/gateway/keychain/vault-save.js");
    const st = vaultwardenStatus();
    const out = await saveToVault({ cliPath: st.cliPath, serverUrl: st.serverUrl, email, masterPassword: master,
      item: { name: "kc-smoke wide", username: "admin", password: "p a$s\x27w\"d #1 \\ é😀 ~/x ok", url: "https://example.invalid", notes: "Crow keychain smoke" } });
    console.log(st.serverUrl, JSON.stringify(out));'
}
echo "== right password ==";  run "$MASTER"
echo "== wrong password ==";  run "${MASTER}-wrong"
sleep 1
if grep -qF -- "$MASTER" $SMOKE/argv.log; then echo "FAIL: master password seen in argv"; else echo "PASS: master password never in argv"; fi
if ls -d $SMOKE/home/tmp/crow-bw-* >/dev/null 2>&1; then echo "FAIL: appdata left behind"; else echo "PASS: no appdata left"; fi
unset MASTER
EOF
chmod 700 $SMOKE/vault-save.sh
echo "Kevin: bash $SMOKE/vault-save.sh"
```

**[KEVIN]** runs it and pastes back only the output. PASS:
- `http://localhost:18097 {"ok":true}`;
- then `{"ok":false,"reason":"Vaultwarden did not accept that email or master password."}`;
- `PASS: master password never in argv`;
- `PASS: no appdata left`.

**[KEVIN]** then checks in the web vault that item `kc-smoke wide` has password exactly ``p a$s'w"d #1 \ é😀 ~/x ok``.

- [ ] **Step 7: Wide-charset (tildes included) through a real container start**

```bash
source /tmp/claude-1000/kc-smoke/vars.sh
mkdir -p $SMOKE/envcheck
cd $REPO && SMOKE=$SMOKE node --input-type=module -e '
import { writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
const { formatEnvLines, envValueProblem } = await import("./servers/gateway/bundle-env-codec.js");
const pool = []; for (let c = 0x20; c < 0x7f; c++) pool.push(String.fromCharCode(c)); pool.push("é", "😀", "\t");
const vals = { K0: "p a$s\x27w\"d #1 \\ é😀 ok", K1: "$argon2id$v=19$m=65540,t=3,p=4$abc$def", K2: "${HOME}", K3: "$(id)", K4: "~", K5: "~/x", K6: "a:~/y", K7: "~+" };
for (let i = 8; i < 300; i++) { let s = ""; const n = randomInt(1, 30); for (let j = 0; j < n; j++) s += pool[randomInt(pool.length)]; if (i % 3 === 0) s = "~" + s; if (!envValueProblem(s)) vals["K" + i] = s; }
const dir = process.env.SMOKE + "/envcheck";
writeFileSync(dir + "/.env", formatEnvLines(vals));
writeFileSync(dir + "/expected.json", JSON.stringify(vals));
'
{ printf 'services:\n  t:\n    image: alpine:latest\n    entrypoint: ["/bin/sh", "-c", "env -0"]\n    env_file: .env\n    environment:\n'
  node -e 'const v=require(process.argv[1]); for (const k of Object.keys(v)) console.log("      "+k+"x: ${"+k+"}")' $SMOKE/envcheck/expected.json; } > $SMOKE/envcheck/docker-compose.yml
(cd $SMOKE/envcheck && docker compose -p crow-kc-envcheck run --rm -T t > got.bin 2>err.txt; echo "rc=$?")
cd $REPO && SMOKE=$SMOKE node --input-type=module -e '
import { readFileSync } from "node:fs";
const dir = process.env.SMOKE + "/envcheck";
const want = JSON.parse(readFileSync(dir + "/expected.json", "utf8"));
const got = {};
for (const rec of readFileSync(dir + "/got.bin", "utf8").split("\0")) { const i = rec.indexOf("="); if (i > 0) got[rec.slice(0, i)] = rec.slice(i + 1); }
let bad = 0;
for (const [k, v] of Object.entries(want)) for (const kk of [k, k + "x"]) if (got[kk] !== v) { bad++; if (bad < 6) console.log("MISMATCH", kk, JSON.stringify(v), JSON.stringify(got[kk])); }
console.log(bad === 0 ? `PASS ${Object.keys(want).length} values x2 (env_file + interpolation) exact in a running container` : `FAIL ${bad}`);
'
docker compose -p crow-kc-envcheck -f $SMOKE/envcheck/docker-compose.yml down --remove-orphans 2>/dev/null
```

- [ ] **Step 8: Teardown, verify, clear the row, record findings**

```bash
source /tmp/claude-1000/kc-smoke/vars.sh
sudo -S tailscale serve --https=8461 off            # or Kevin
systemctl --user stop kc-smoke-deadman.timer kc-smoke-sampler.service 2>/dev/null
bash $SMOKE/teardown.sh
docker ps -a --format '{{.Names}}' | grep -qE '^crow-kc' && echo "FAIL smoke containers left" || echo "PASS no smoke containers"
[ "$(systemctl --user list-units 'kc-smoke-*' --no-legend | wc -l)" = 0 ] && echo "PASS no smoke units" || echo "FAIL smoke units left"
tailscale serve status | grep -q ':8461' && echo "FAIL 8461 mapped" || echo "PASS 8461 off"
```

Write `$SMOKE/findings.md`: each step PASS/FAIL with its evidence line. Copy it to `~/crow-weekend-push/reports/crow-keychain-smoke-findings.md`, move the schedule row to Done, and `rm -rf $SMOKE`.

---

### Task 14: PR, merge (after Kevin's OK), deploy, post-deploy acceptance

**Files:** none.

- [ ] **Step 1: Gates on the final branch, then push**

```bash
cd ~/crow-wt-keychain
git pull --rebase origin main
npm test
node scripts/build-registry.mjs --check
git push origin feat/crow-keychain
```

- [ ] **Step 2: Open the PR** with `mcp__github__create_pull_request`:
- owner `kh0pp`, repo `crow`, head `feat/crow-keychain`, base `main`;
- title "Crow keychain: opt-in Generate, compose-exact .env quoting, own-key local Passwords page with export, Vaultwarden 1.37.3 adopter";
- body:
  - one paragraph per spec §5 area;
  - the review→ruling table;
  - the spike and smoke findings inline, plus their report paths;
  - flagged for Kevin: R11 (vault email in `bw login` argv);
  - **Operator follow-ups:** the dayane `backup.sh` change (Task 14 Step 6); existing Vaultwarden installs keep the old image until reinstalled;
  - the P12 version bumps.
- No AI attribution.

- [ ] **Step 3: Gate on check-runs**

```bash
SHA=$(git -C ~/crow-wt-keychain rev-parse HEAD)
curl -s "https://api.github.com/repos/kh0pp/crow/commits/$SHA/check-runs" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); runs=d["check_runs"]; print(len(runs)); [print(r["name"], r["status"], r["conclusion"]) for r in runs]'
```

Every run must be `completed success` (`suite`, `static-checks`, `audit`, including the new vaultwarden audit step inside `audit`). An empty list on a current sha is wrong.

- [ ] **Step 4: [KEVIN] Approve the merge.** No merge without Kevin's explicit OK in chat. Then `mcp__github__merge_pull_request` (squash), and record the sha.

- [ ] **Step 5: Deploy — crow** (never `git checkout` in `~/crow`)

```bash
git -C ~/crow branch --show-current                  # main
git -C ~/crow pull --ff-only origin main
git -C ~/crow log --oneline -1                       # the merge sha
sudo -S systemctl restart crow-gateway crow-r4-gateway
sleep 20; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/health   # 200
systemctl is-active crow-gateway crow-r4-gateway
node -e 'const D=require(process.env.HOME+"/crow/node_modules/better-sqlite3"); const d=new D(process.env.HOME+"/.crow/data/crow.db",{readonly:true}); console.log(d.prepare("SELECT value FROM dashboard_settings WHERE key=\x27auto_update_last_result\x27").get()?.value)'
ls ~/.crow/secrets/keychain.key 2>/dev/null || echo "no keychain key yet (created on the first save) — expected"
```

The `auto_update_last_result` line must not start with "Skipped".

- [ ] **Step 6: Deploy — grackle, raven; verify black-swan; dayane: no action** (P8)

```bash
grackle "git -C ~/crow branch --show-current && git -C ~/crow pull --ff-only origin main && git -C ~/crow log --oneline -1"
grackle "sudo -S systemctl restart crow-gateway"     # credential per global CLAUDE.md
grackle "sleep 20; systemctl is-active crow-gateway; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3002/health"
ssh kh0pp@100.67.188.54 "systemctl list-units --type=service --no-legend '*crow*'; systemctl --user list-units --no-legend '*crow*'"
```

- **raven:** pull its checkout (it must be on `main`; otherwise stop and tell Kevin), restart the unit the last command shows, and check `/health` on 3009.
- **black-swan:** `ssh black-swan "git -C ~/crow log --oneline -1"` within the auto-update interval. It must show the merge sha; if it still shows the old sha after one interval, report it.
- **dayane (operator follow-up, re-review B3):** its container instance is pinned (deliberate rebuild only), so there is no deploy step here. Before dayane is next rebuilt onto this code, its backup must stop carrying the key.
  - The kit lives in `~/crow-dayane` (Gitea `kh0pp/crow-dayane`), not in this repo.
  - The exact change, for Kevin or a session in that repo: in `~/crow-dayane/backup.sh`, replace

    ```bash
    docker cp crow-dayane:/crow - | gzip > "$DEST/volume-$TS.tar.gz.part"
    ```

    with

    ```bash
    # Never back up the Crow keychain key (Crow keychain spec §3/§9.7): entries stay readable only on this host.
    docker exec crow-dayane tar -C / --exclude=crow/secrets/keychain.key -cf - crow | gzip > "$DEST/volume-$TS.tar.gz.part"
    ```

    The archive layout (`crow/...`) is unchanged, and the image's `/usr/bin/tar` was verified present.
  - Then verify:

    ```bash
    bash ~/crow-dayane/backup.sh && tar -tzf "$(ls -t /mnt/external/crow-db-backups/crow-dayane/volume-*.tar.gz | head -1)" | grep -c keychain.key   # 0
    ```

  - Put this in the PR body under "Operator follow-ups".

- [ ] **Step 7: [KEVIN] Post-deploy acceptance on crow** (prod, harmless)
1. **Settings → Passwords** appears under Account, showing "No saved passwords yet."
2. **Add and reveal.** Add `kc-accept` with password `it's a $ "test" #1 ~/x`. Reveal it: Crow asks for the TOTP code or the dashboard password. After confirming, the exact text shows, and it disappears after 30 s. Copy, paste and compare.
3. **Key file.** `~/.crow/secrets/keychain.key` now exists, mode 600, in a 700 dir.
4. **Export.** Export with a 12+ character passphrase: a `crow-keychain-YYYY-MM-DD.json` downloads and contains no readable password.
5. **Delete.** Delete `kc-accept` (no second prompt within 5 minutes). Recent activity lists add / identity confirmed / revealed / exported / deleted.
6. **Extensions, Workspace.** Open the Install dialog for Workspace (do not install). The admin password field has Generate / Show / Copy and a ticked "Save to Crow keychain"; Generate fills 24 characters. Cancel.
7. **Extensions, negative check (C1).** Open the Install dialog for `media`. `BRAVE_API_KEY` has Show / Copy but **no** Generate and **no** keychain box. Cancel.

Record the results as a PR comment (`mcp__github__add_issue_comment`).

---

## Self-Review

**Spec coverage** (spec section → task):

| spec | task |
|---|---|
| §5.1 codec, tilde/path, line-preserving, readers | 1, 2 |
| §5.2 capability, generator, keychain-first | 3, 8, 9 |
| §5.3 key file, store, Export/Import, local-only | 4, 5, 10 |
| §5.4 re-auth (incl. `none`, global ceiling), API | 5 |
| §5.5 UI (modal, Configure blob, banner, Passwords page) | 9, 10 |
| §5.6 vault save (+ spike first) | 6, 7 |
| §5.7 installer wiring, refresh fix | 7, 8 |
| §5.8 adopters | 11 |
| §8 gates, smoke | 12, 13 |
| PR / merge / deploy | 14 |
| §9 follow-ups | listed only |

**Placeholder scan:** no TBD/TODO. Every code step carries code: full files, or `git apply` patches cut from a tested scratch history. Task 5's `vault-save.js` is an explicit two-function placeholder, replaced in Task 7 with its own failing tests.

**Type consistency:**
- `planGeneratedEnv → { env, minted, persist }`: Tasks 3, 8, 13.
- `loadKeychainKey → { id, seed } | null`: Tasks 4, 5, 8, 9, 10, 13.
- `saveExtensionSecret(db, key, …)`: Tasks 4, 8, 13.
- `vaultwardenStatus` / `saveToVault`: Tasks 5, 7, 8, 13.
- The client `keychain: { save, vault }` matches `sanitizeKeychainRequest`.
- `/first-view` returns `{ secret }` or 410 `first_view_spent` in Tasks 5 and 9.
- `reauth_method: "totp"|"password"|"none"` in Tasks 5 and 10.

**Review Focus:** all five lines are pinned in their owning tasks.

**Dry run (revision 3):**
- The patches and files above were replayed in order on a git-tracked scratch copy, and each task's tests passed at its commit.
- Final full suite **6059 / 6059**; `build-registry --check` and `check-port-allocation` OK.
- The B1 regression was reproduced first (`ERR_MODULE_NOT_FOUND` from an installed copy) and is now pinned by a test.

**Unverified until live:**
- CLI 2026.9.1 ⇄ Vaultwarden 1.37.3 (Task 6, before any vault code);
- the real wrong-password and two-step texts (Task 6, folded into Task 7);
- the PHC accepted at `/admin` on 1.37.3 (Task 13 Step 4);
- the per-save device growth (Task 6 Step 4).
