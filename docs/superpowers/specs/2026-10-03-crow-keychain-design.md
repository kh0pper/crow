# Crow Keychain: Generated Passwords, Wider Charset and a Local Password Store (Design)

**Date:** 2026-10-03.
**Revision 2** follows the adversarial review `~/crow-weekend-push/reports/keychain-plan-review.md` (C1–C8, S1–S10) and Kevin's answers to its questions Q1–Q6.

**Status:** Approved in chat by Kevin, 2026-10-03.
- Decisions 1–7 below are his and are binding, as amended by his review answers.
- This document grounds them in the code on `main` @ `ec197558` (#408, Crow Workspace W1).
- It records the rulings the decisions left open.

**Plan:** `docs/superpowers/plans/2026-10-03-crow-keychain.md`

## 1. Problem

Installing an extension that needs a human password today means:

- **Inventing a strong password yourself, under a narrow charset.** Workspace refuses `$`, spaces, quotes and `#`. The reason: `writeInstallEnv` writes `KEY=value` raw, and Docker Compose would interpolate or truncate those characters.
- **Remembering it outside Crow.** The Workspace bootstrap deliberately scrubs `WORKSPACE_ADMIN_PASSWORD` from `.env` after first use.
- **For Vaultwarden, running terminal commands** (`openssl rand`, then `vaultwarden hash` inside the container) and pasting the result.

Kevin's decisions turn this into: a Generate button on the extension's own password fields, any printable character, a local encrypted keychain with its own key, a re-auth-gated Settings page with a passphrase Export/Import, and an optional copy into the user's own Vaultwarden vault.

## 2. Decisions (Kevin, 2026-10-03; binding)

1. **Generate button** on human password fields in an extension's install/configure form.
   - *Amended by Q1 / review C1:* only on fields the manifest opts in with `generatable: true`. Third-party credentials (API keys, tokens; 80+ of them across the store) get Show/Hide/Copy but no Generate.
   - The password is 24 characters, from the field's allowed charset.
   - The user may still type their own.
2. **Wider charset.**
   - The installer writes bundle `.env` values with correct docker-compose quoting, so nearly any printable character works.
   - It refuses only newline/NUL, plus what quoting cannot express safely (§5.1).
   - Bundle ops scripts read values without shell eval.
   - Relax Workspace's `WORKSPACE_ADMIN_PASSWORD` pattern accordingly.
   - Verify the rules against the installed compose (v5.1.2).
3. **Crow keychain.**
   - Local-only and NEVER synced; human-facing passwords only; not a general password manager.
   - *Amended by Kevin (review C7):* encrypted with **its own random key file**, never the identity seed, and **never backed up**. An explicit passphrase-encrypted **Export / Import** on the Passwords page is the way to keep a copy. A crow.db restored without the key shows entries as "unreadable — key missing" and never crashes.
   - "Save to Crow keychain" (default on) follows the same opt-in as Generate (`generatable` or `keychain`), plus manual "add" (Q1).
   - Entries carry: label, bundle, env key, username, URL, created/updated, and a status. After uninstall the status is "extension removed", and the entry is kept until the user deletes it.
4. **Settings → Passwords.**
   - List, reveal, copy and delete.
   - Reveal/copy/delete/export/import need a fresh re-auth, valid 5 minutes: the TOTP code if dashboard 2FA is on, otherwise the dashboard password.
   - *Q6:* with neither, those actions are disabled with an explanation. There is no bypass.
   - Every reveal/copy/delete/export/import is audited.
   - en+es strings.
   - No plaintext reaches the browser except on an explicit, re-authenticated request (plus the one-time first view, §5.4). No plaintext in logs.
5. **Optional "Also save to my Vaultwarden vault"** when the vaultwarden bundle is installed.
   - Email and master password are typed per save: never stored, never logged; the master password is never in argv.
   - Uses the official Bitwarden CLI (`@bitwarden/cli`) against the local Vaultwarden.
   - Private appdata, removed afterwards.
   - A failure does not fail the install; it is reported.
6. **Generated-and-known secrets.** A new capability, `generate: "secret"` + `keychain: true`, optionally with `store_as: "argon2id"`.
   - Crow generates the token, saves the plaintext to the keychain, and shows it once.
   - The `.env` gets the plaintext or a PHC Argon2id hash (Node 24 `crypto.argon2Sync`).
   - First adopters: Vaultwarden `VAULTWARDEN_ADMIN_TOKEN` and Workspace `WORKSPACE_ADMIN_PASSWORD`, both with version bumps and a registry rebuild.
7. **Follow-ups** are listed in §9, not built.

## 3. Ground truth (verified 2026-10-03)

### Compose `.env` parsing (Docker Compose v5.1.2 on crow)

Probed with `docker compose config --environment` and `--format json`:

| line in `.env` | compose sees |
|---|---|
| ``A='p$a ss#w"d\n`x'`` | literal: no `$` interpolation, no escapes |
| `A='a\'b'` | `a'b` (the one escape inside single quotes) |
| `A='\'` | **parse error** (unterminated) |
| `A="a\$b"` / `A="d$$x"` | `a$b` / `d$x` |
| `A="q\nz"` | `q`, newline, `z` |
| `A="a\zb"` | `a\zb` (unknown escapes kept) |
| `A=x #c` / `A=x#c` | `x` / `x#c` |
| `A='$argon2id$v=19$m=65540,t=3,p=4$abc$def'` | verbatim |

### Bash vs compose on a bare tilde (review C2)

| `.env` line | bash sees | compose sees |
|---|---|---|
| `A=~` | `/home/kh0pp` | `~` |
| `B=~/x` | `/home/kh0pp/x` | `~/x` |
| `C=ab:~/y` | `ab:/home/kh0pp/y` | `ab:~/y` |
| `D=~+` | `$PWD` | `~+` |

Eight manifest defaults are bare `~/` paths: caddy, frigate×2, homepage, iptv, motioneye×2, rookery. The frigate and motioneye post-install scripts rely on bash expanding them.

### Who reads and writes bundle `.env` files

**Writers:**
- `writeInstallEnv`
- the Configure route
- `appendManagedBlock`
- the retained-secrets copy
- companion `settings-section.js`
- the four `configure-storage.mjs` scripts (peertube, pixelfed, funkwhale, mastodon)

**Raw readers:**
- `parseEnvText`
- `composeBuildContexts` (via `env-manager.readEnvFile`)
- `bundles-config.parseEnvFile`
- `extension-proxy.readBundleEnv`
- browser `server/instance.js` (reads the typed `CROW_BROWSER_VNC_PASSWORD`)
- companion `settings-section.js`
- `migrations.js readCompanionEnv`
- workspace `panel/workspace.js`
- the four `configure-storage.mjs` scripts
- workspace `ops/bootstrap.sh` and `ops/restore-scratch.sh` (sed)

Out of scope: `port-inventory.js` (digits only).

**Scripts that source `.env`:** eleven post-install scripts run `set -a; . .env`. They are run by hand; none is a manifest `postInstall`.

The **gateway's own** `.env` is loaded literally by `servers/gateway/index.js`. It is not a compose file.

### Backups and the identity seed (review C7)

- `secret-box` derives its key from the identity seed, and same-identity instances share it.
- These paths copy crow.db and/or `identity.json`:
  - product `/api/admin/backup` + Nest "Run backup now": crow.db → `~/backups/crow`;
  - the onboarding identity export: the seed;
  - `~/r4-tehcy/scripts/r4-backup.sh`: crow.db + `identity.json` + `~/.crow-r4/env`, uploaded to Google Drive;
  - `pi-lab/scripts/crow-db-backup.sh`: crow.db only, to `/mnt/external`.
- **None of them copies `<CROW_HOME>/secrets/`.** That is where the keychain key lives (§5.3).

### Vaultwarden

**1.32.7** (the bundle's pin) parses an `ADMIN_TOKEN` that starts `$argon2` as a PHC string and verifies the trimmed submitted token against it. Its admin API is authenticated only by the `VW_ADMIN` cookie from `POST /admin`. The bundle's `vaultwarden_user_count` MCP tool sends `Authorization: Bearer`, so it never worked.

**1.37.0 release notes:**

> This update is required for support with clients with version 2026.7.0+

`@bitwarden/cli` 2026.9.1 is such a client. **1.37.3** is the current stable release (2026-09-13, Docker Hub digest `sha256:1587c45f…`). Its `admin.rs` `validate_token` uses the same PHC path and the same cookie-only admin guard. Its image ships `curl` for the healthcheck.

Vaultwarden is not installed on any fleet host, so the pin can move freely.

### Node 24.21.0

`crypto.argon2Sync("argon2id", …)` exists and takes about 58 ms at m=65540, t=3, p=4.

### `@bitwarden/cli` 2026.9.1

From `apps/cli/src/program.ts` and `vault.program.ts`:
- `login [email] --passwordenv <ENV>`;
- global `--raw`;
- `create item` reads base64 JSON from stdin;
- `BITWARDENCLI_APPDATA_DIR`;
- `BW_SESSION`.

Its dependencies are pure JS (no native modules), so the installer's `--ignore-scripts` is fine.

### Bundle refresh (review C6)

`refreshVersionedBundle` copied only `manifest.json` and `settings-section.js` at the top level of **docker** bundles, so a dependency added in a version bump was never installed. Today no compose file bind-mounts a bundle's `package.json`.

### Configure registry blob

The Extensions client builds the Configure form from `#addon-registry`. That blob dropped every env_vars field except name/description/default/required/secret, so `generatable`, `keychain` and `pattern` never reached Configure. Found while dry-running the plan; fixed in the plan's Task 9.

## 4. Scope

**In scope:**
- the `.env` codec and every reader/writer above;
- the env_vars capability (`generatable`, `keychain`, `store_as`, `keychain_label`, `keychain_username`, `keychain_url`, `path`) with Argon2id PHC;
- the keychain key file;
- the store (local-only table) and Export/Import;
- the re-auth gate and JSON API;
- Settings → Passwords;
- the Extensions modal (Generate, Show/Hide, Copy, keychain checkbox, vault option) and the first-view banner;
- the Bitwarden-CLI vault save;
- the docker-bundle refresh fix;
- Vaultwarden (pin 1.37.3) and Workspace adoption;
- a live compatibility spike before the vault-save code;
- a pre-merge live smoke;
- PR, merge and deploy.

**Out of scope:** everything in §9.

## 5. Design

### 5.1 Compose-exact `.env` codec (`servers/gateway/bundle-env-codec.js`)

| value | written as |
|---|---|
| only `A-Z a-z 0-9 _ . / : @ % + , = ^ ! ? * -` (incl. empty) | bare, byte-identical to before |
| `~/…` made of those characters, in a **path field** | bare: bash expands it, as the post-install scripts expect |
| anything else without `'` and not ending in `\` (every other tilde form included) | `'value'`: literal in compose AND bash |
| the rest | `"value"` with `\ " $` escaped |

A **path field** is one whose manifest declares `path: true`, or whose `default` starts with `~/`. No existing manifest needs an edit (Kevin Q4).

**Refused** with the existing 400 `invalid_env` (key named, value never echoed):
- CR, LF, NUL;
- a backtick in a value that needs double quotes, because `. ./.env` would execute it.

**Decoding** mirrors compose: `export ` prefix, trailing ` #comment` on bare values, `\n \t \r`, unknown escapes kept.

**Line-preserving updates** (review C4): `updateEnvText` changes only the requested keys and keeps every other line byte-for-byte. Configure and the installer's `.env`/`.env.example` seeding use it, so:
- a legacy unquoted `P=p$ss` that compose already interpolated (possibly into a database) is never silently re-quoted;
- a legacy line the codec would refuse never turns Configure into a 500.

All bundle-`.env` readers in §3 switch to the codec:
- shell scripts through `bundles/workspace/ops/envfile.py`, a decoder byte-identical to the codec;
- bundle code that runs outside the gateway module graph through the maker-lab `CROW_APP_ROOT` resolver pattern.

Each touched bundle gets a version bump: browser 1.3.4, companion 1.0.1, peertube, pixelfed, funkwhale and mastodon 1.0.1, workspace 0.1.2.

### 5.2 Manifest capability

`env_vars[]` gains:

- `generatable: true` — a human password field. The forms offer Generate and "Save to Crow keychain". Requires `secret: true`, no `generate`, and `propagate: false`, so a human password is never copied into the gateway `.env` or `mcp-addons.json` (review S6).
- `keychain: true`:
  - with `generate: "secret"`, the minted plaintext goes to the keychain (with a 30-minute first-view grant);
  - on a typed `secret` field, it offers "Save to Crow keychain" without Generate.
- `store_as: "argon2id"` — needs `generate` + `keychain`. The `.env` and the retained copy hold `$argon2id$v=19$m=65540,t=3,p=4$<salt>$<hash>`: 16-byte salt, 32-byte tag, unpadded standard base64.
- `keychain_label`, `keychain_username`, `keychain_url` — `${VAR}` templates over the install env, manifest defaults included. A blank var drops the field.
- `path: true` — see §5.1.

**Generator.** 24 characters from `a-z A-Z 2-9 ! % * + , - . / : = ? @ ^ _` (look-alikes dropped). Every symbol is codec-bare, so a generated password is written byte-identically to before and is never bash-expanded (review C2/C3).

**Generated tokens** stay the existing 43-character base64url `newSecretValue()`.

**Keychain before persistence** (review C5):
- `planGeneratedEnv` mints without writing anything.
- The installer saves `minted` to the keychain first, then calls `persist()` (retained copy) and writes `.env`.
- If the keychain save fails, the install fails and leaves nothing behind, so a retry mints a fresh token.
- `resolveGeneratedEnv` (the old one-call API) refuses `keychain` manifests.
- A reinstall reuses the stored hash and reactivates the existing entry.

### 5.3 The keychain key, the store, Export/Import

**Key file** (`keychain/key.js`):
- `<CROW_HOME>/secrets/keychain.key`, file 600 in a 700 dir;
- JSON `{v:1, id, key}`: 32 random bytes and a 16-hex fingerprint id;
- created only on the first save;
- **never overwritten**: a corrupt file is left alone and saves report "key missing".

Entries are sealed with the existing `secret-box` (AES-256-GCM, HKDF), using this key as its seed.

**Why no backup carries the key:** the file is outside the data dir and outside `identity.json`. No product backup, identity export or sync path references it, and a test pins that.

**Store** (`crow_keychain`):

```
id, kind, label, bundle_id, env_key, username, url, secret_sealed, key_id, origin,
status, first_view_until, created_at, updated_at
UNIQUE (bundle_id, env_key) WHERE kind = 'extension'
```

- No CHECK constraints (review S8): enums are validated in `store.js`.
- The table is created by `scripts/init-db.js` and lazily by `ensureKeychainTable`. It is additive: **no `SCHEMA_GENERATION` bump**.
- Rows whose `key_id` differs from the present key (or with no key at all) list as `readable:false`. Opening them throws `KEYCHAIN_KEY_MISSING`, and the API answers 409 `key_missing`. They can still be deleted.

**Local-only, made impossible to replicate:**
- `LOCAL_ONLY_TABLES = ["crow_keychain"]` in `instance-sync.js`;
- a load-time assertion that it is disjoint from `SYNCED_TABLES`;
- a `shouldSyncRow` refusal;
- a test over the live emit, stdio-queue and inbound-apply doors;
- the grackle D3 importer skips the table, with a reason that points at Export/Import.

**Export / Import** (`keychain/export.js`):
- Export writes every readable entry into `{format:"crow-keychain-export", version:1, created_at, count, kdf:{argon2id, m=65536, t=3, p=4, salt}, cipher:"aes-256-gcm", nonce, ciphertext, tag}`. The passphrase is at least 12 characters.
- Import never overwrites a readable entry.
  - An extension entry is skipped when its bundle+key has a readable row. It **replaces** an unreadable row (that is the new-machine recovery path).
  - A manual entry is skipped when an identical label+username+URL exists.
- Both are re-auth gated and audited, with counts only.

### 5.4 Re-auth gate and the keychain API

**Re-auth gate:**
- `method()` is `totp` when 2FA is on, else `password` when a dashboard password exists, else `none` (Q6).
- A success grants **this dashboard session** (sha256 of the session token) 5 minutes.
- 5 consecutive failures lock that session for 15 minutes.
- **Instance-wide ceiling** (review S1, because peers can mint fresh SSO sessions): 20 failures in an hour lock re-auth for everyone. That is audited as `keychain_reauth_lockout` and raises one dashboard notification.
- TOTP codes have no replay tracking (`totp.js:69-89`). That is accepted, given the 5-minute grant and session binding.

**API** (`/dashboard/keychain/api/*`, mounted after `dashboardAuth` + `csrfMiddleware`; refuses `x-crow-signature`; every response `no-store`):

| route | needs grant | effect / audit event |
|---|---|---|
| `GET /entries` | no | metadata + `readable`, `key_present`, `reauth_method`, `vault_available` |
| `POST /reauth` | — | `keychain_reauth_ok` / `_failed` / `_lockout` |
| `POST /reveal {id, purpose}` | yes | `{secret}`; `keychain_reveal` / `keychain_copy` |
| `POST /first-view {id}` | no (one-time, ≤30 min) | `keychain_first_view` |
| `POST /add` | no | `keychain_add` |
| `POST /delete {id, confirm_generated?}` | yes | an active generated token needs `confirm_generated` (C5); `keychain_delete` |
| `POST /export {passphrase}` | yes | the export file as an attachment; `keychain_export` |
| `POST /import {file, passphrase}` | yes | `{imported, skipped}`; `keychain_import` |
| `POST /vault-save {id, vault_email, vault_password}` | yes | §5.6; `keychain_vault_save` |
| `GET /activity` | no | last 25 `keychain_*` audit rows |

With `method()==="none"`, every grant-requiring route answers 403 `reauth_unavailable`.

### 5.5 UI

**Extensions modal** (template-literal rules):
- Show/Hide/Copy on every typed secret.
- Generate only where `generatable`.
- "Save to Crow keychain" (checked) only where `generatable` or `keychain`.
- One vault block when the vaultwarden bundle is installed.
- Configure gets the same, because the registry blob now carries `generatable`, `keychain` and `pattern`.
- Configure shows the keychain/vault outcome before the modal closes (review S4).

**First-view banner:**
- server-rendered, so it survives the post-install reload and restart;
- readable entries only;
- the plaintext is wiped after 30 s and on `pagehide` (review S2).

**Settings → Passwords** (account group, after Two-Factor):
- the table: label, extension, user, URL, status, with "Unreadable — key missing";
- Reveal/Copy/Delete/Save-to-vault, all behind the re-auth panel;
- revealed values are wiped after 30 s and on `pagehide`;
- Add;
- Export (passphrase + confirm, downloaded as a file) and Import (file + passphrase);
- recent activity;
- the page HTML is sent `no-store`;
- with `method==="none"`, an explanation and disabled re-auth actions.

All strings are en+es.

### 5.6 Vaultwarden save (`servers/gateway/keychain/vault-save.js`)

**Availability:**
- the bundle is installed and `node_modules/@bitwarden/cli/build/bw.js` exists;
- the CLI is pinned `2026.9.1` in `bundles/vaultwarden/package.json`;
- the manifest sets `npm_required: true` + `verify_paths`, so the installer uses `npm ci` with the lock file (300 s) and hard-fails rather than leaving the MCP server half-installed (review S5).

**Flow:**
1. Steps run as `node bw.js …` under `prlimit --core=0` when present (review S3), with env `{PATH, HOME=tmp, BITWARDENCLI_APPDATA_DIR=tmp, BW_NOINTERACTION=true, NODE_OPTIONS=""}`.
2. The temp dir is under **`<CROW_HOME>/tmp`** (mode 700). Stale `crow-bw-*` dirs older than 10 minutes are swept first.
3. `config server <VAULTWARDEN_URL>` (default `http://localhost:8097`).
4. `login <email> --passwordenv CROW_BW_MASTER --raw`.
5. `create item` with base64 JSON on stdin and `BW_SESSION`.
6. `logout`.
7. `rm -rf` the temp dir.

**Bounds and errors:**
- One overall 90 s deadline (review S4).
- Errors are fixed sentences: wrong credentials / two-step login / unreachable / timeout / create failed / CLI missing.

**Devices:** each save logs in with fresh appdata, so Vaultwarden may register a new device each time. The spike (plan Task 6) measures this; pinning a per-instance device id is a §9 follow-up if it does.

**Where it runs:** during install, right after the keychain save and before images are pulled (the credentials are then dropped). On the Passwords page it is a per-entry action.

### 5.7 Installer wiring

- `/bundles/api/install` and `/bundles/api/env` accept `keychain: {save:[KEY…], vault?:{email,password}}`.
- Typed saves and vault saves happen only for a **local dashboard session**. Peer-signed requests never write typed secrets or touch a vault.
- Generated `keychain` tokens are always saved, first (§5.2).
- Uninstall marks the bundle's entries "extension removed".
- Job logs carry counts and fixed sentences, never values.
- The docker-bundle refresh now copies `package.json` + `package-lock.json`, which are never container-mounted (review C6).

### 5.8 Adopters

**Vaultwarden** `1.0.0 → 1.1.0`:
- image `1.32.7 → 1.37.3` (§3);
- `VAULTWARDEN_ADMIN_TOKEN` becomes `generate:"secret"`, `keychain`, `store_as:"argon2id"`, `keychain_url:"${VAULTWARDEN_DOMAIN}/admin"`;
- skill step 1 is rewritten, and the consent text no longer says "plaintext";
- `server.envKeys` drops the token, and `requires.env` drops it too;
- `vaultwarden_user_count` explains instead of calling;
- the CLI dependency is added with `npm_required` + `verify_paths`.

**Workspace** `0.1.1 → 0.1.2`:
- `WORKSPACE_ADMIN_PASSWORD` becomes `generatable`, with pattern `^[^\x00-\x1f\x7f]{12,128}$` and `keychain_username:"${WORKSPACE_ADMIN_USER}"`;
- the ops scripts read through `envfile.py`;
- `reset-password.sh` counts length in UTF-16 units like the form's RegExp (review S10), refuses control characters, and still passes the password on stdin only.

## 6. Security properties and threat model

**Plaintext at rest:**
- Bundle `.env` files (600), as today. Workspace scrubs its admin password, and Vaultwarden now stores only a hash.
- Typed secrets **without** `propagate:false` are also copied into the gateway `.env` and `mcp-addons.json`, as today (review S6). `generatable` fields must be `propagate:false`, so human passwords never are.
- The keychain itself is AES-256-GCM sealed under its own key file.

**Off-host:**
- No backup path copies the key, so backups carry ciphertext only.
- Rows never replicate.
- The only way entries leave the machine is the user's passphrase Export.

**Browser:**
- Plaintext reaches it only on a re-authed reveal/copy/export, or the one-time first view (≤30 min, single use, audited).
- It is wiped from the page after 30 s or on navigation.
- Any dashboard session, including an agent driving the crow-browser, can consume a pending first view; that is why it is short and single-use (review S7).

**Argv:** the vault master password goes through `--passwordenv`, item JSON through stdin and the session through env. The vault email IS in `bw login` argv (R11).

**Not protected against:** code running as the same OS user (including a pi-bot with a shell) can read the key file and crow.db and decrypt everything. The keychain protects against off-host copies, not against the local account (review S7).

## 7. Rulings

- **R1** Encoder: bare / path-bare / single / double, as in §5.1. The only refusals beyond CR/LF/NUL are a backtick combined with `'` or a trailing `\`.
- **R2** The gateway `.env` is untouched: it is literal, not a compose file.
- **R3** Workspace pattern: `^[^\x00-\x1f\x7f]{12,128}$`. `not_breached` stays.
- **R4** The table is additive. No SCHEMA_GENERATION bump, so no dry-run rail.
- **R5** *(revised, Kevin C7)* The keychain has its own key file and is never backed up. Export/Import is the user's own copy.
- **R6** Re-auth: per session, 5-minute grant, 5 failures → 15-minute lock, plus a 20/hour instance-wide ceiling. TOTP only when 2FA is on; `none` disables (Q6).
- **R7** Delete requires re-auth. An active generated token also needs `confirm_generated`.
- **R8** First view: 30 minutes, single use, server-rendered, readable entries only.
- **R9** Peer-signed requests never save typed fields and never use the vault.
- **R10** `keychain_label` and the `keychain_username` / `keychain_url` templates; blank vars drop the field.
- **R11** The vault email is the `bw login` positional argument: the CLI has no env/stdin form and its prompt is disabled. **Flagged for Kevin.**
- **R12** Two-step-login vault accounts are not driven. The save reports it. The spike captures the real CLI text.
- **R13** `vaultwarden_user_count` explains instead of calling.
- **R14** Argon2id: m=65540, t=3, p=4, `argon2Sync` (about 60 ms).
- **R15** No rotate action (§9).
- **R16** *(revised, Kevin Q1 / review C1)* Generate and "Save to Crow keychain" are opt-in per field (`generatable` / `keychain`). Show/Hide/Copy go on every typed secret.
- **R17** The pre-merge smoke and the spike each need one **[KEVIN]** step: registering a throwaway vault account in the web vault.
- **R18** *(C8 / Q3)* The Vaultwarden pin moves to 1.37.3 on release-note evidence. A live spike (plan Task 6) confirms CLI 2026.9.1 against it **before** the vault-save code. Fallback, decided now: if 2026.9.1 fails against 1.37.3, pin the newest CLI release that passes the same spike, and record it.
- **R19** *(C4)* Configure and install seeding are line-preserving.
- **R20** *(C6)* Docker-bundle refresh copies `package.json` + lock.
- **R21** *(S5)* Not adopted as written: one `package.json` instead of a separate `cli/` package. Adopted instead: `npm_required` + `verify_paths` (lock-file `npm ci`, 300 s, hard-fail) and a blocking critical-tier `npm audit` of `bundles/vaultwarden` in CI.

## 8. Testing

**Unit tests** (no containers):
- the codec, with real `docker compose config` and real bash round-trips (tilde forms included);
- the other readers;
- argon2 and plan/persist;
- the key file, store, Export/Import and locality guard (incl. D3);
- re-auth and the API (Q6, global ceiling, key_missing, export/import);
- vault-save with a fake `bw`;
- the refresh fix;
- installer wiring (C5 failure path);
- the extensions client (C1/Q1, S2, S4);
- the Passwords section;
- the adopters;
- i18n parity.

The plan's code was dry-run in full: 6050/6050 on a staged copy.

**Live:**
- the spike (Vaultwarden 1.37.3 + CLI 2026.9.1) before the vault-save task;
- the pre-merge smoke: argon2 `/admin` login, `bw` save through `http://localhost`, two-step text, wide-charset values through a running container;
- post-deploy acceptance.

## 9. Follow-ups (listed, not built)

1. **Vaultwarden default URL** is `http://localhost:8097` (loopback-only). It should default to a Tailscale Serve HTTPS address: phones and the web vault's WebCrypto need HTTPS.
2. **Vaultwarden "signups allowed"** is still a manual `.env` flip + restart after the first account. It needs a guided "Close signups" action.
3. Regenerate/rotate a keychain-held generated token.
4. Move the eleven `set -a; . .env` post-install scripts onto `envfile.py`. The codec already makes every line Crow writes safe to source.
5. A stable per-instance Bitwarden device id for vault saves, if the spike shows a new device per save.
6. Mark more extension-created passwords `generatable`: `CROW_BROWSER_VNC_PASSWORD`, `MINIO_ROOT_PASSWORD`, `MINIFLUX_ADMIN_PASSWORD`, `MLA_ADMIN_PASSWORD`. Move `*_DB_PASSWORD` fields to `generate:"secret"`.
7. **Operator (not product):**
   - If `~/r4-tehcy/scripts/r4-backup.sh` or `pi-lab/scripts/crow-db-backup.sh` ever start copying `<CROW_HOME>/secrets/`, they would carry the keychain key. Today neither does. The owners keep it that way, or exclude `secrets/keychain.key` explicitly.
   - The dayane container instance is pinned (deliberate rebuild only): it picks this up on its next rebuild.
