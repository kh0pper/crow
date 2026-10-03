# Crow Keychain: Generated Passwords, Wider Charset and a Local Password Store (Design)

**Date:** 2026-10-03
**Status:** Approved in chat by Kevin, 2026-10-03 (decisions 1-7 below are his and are binding). This document grounds them in the code on `main` @ `ec197558` (#408, Crow Workspace W1) and records the rulings the decisions left open.
**Plan:** `docs/superpowers/plans/2026-10-03-crow-keychain.md`

## 1. Problem

Installing an extension that needs a human password today means:

- inventing a strong password yourself, under a narrow charset. Workspace refuses `$`, spaces, quotes and `#` because `writeInstallEnv` writes `KEY=value` raw and Docker Compose would interpolate or truncate those characters;
- remembering it somewhere outside Crow. The Workspace bootstrap deliberately scrubs `WORKSPACE_ADMIN_PASSWORD` from `.env` after first use, so Crow forgets it;
- for Vaultwarden, running terminal commands (`openssl rand`, then `vaultwarden hash` inside the container) and pasting the result.

Kevin's decisions turn this into: a Generate button, any printable character, a local encrypted keychain, a re-auth-gated Settings page, and an optional copy into the user's own Vaultwarden vault.

## 2. Decisions (Kevin, 2026-10-03; binding)

1. **Generate button** on every human password field in any extension's install/configure form. A human password field is an `env_vars` entry with `secret: true` that is not installer-generated (`!generate`). It produces a 24-char strong password from the field's allowed charset. The field gets show/hide and copy, and the user may still type their own.
2. **Wider charset.** The installer writes bundle `.env` values with correct docker-compose `.env` quoting, so nearly any printable character works. It refuses only newline/NUL and what compose quoting truly cannot express. Bundle ops scripts read values safely (no shell eval). Relax the Workspace `WORKSPACE_ADMIN_PASSWORD` pattern and audit its ops scripts. Compose's rules are verified against the installed compose (v5.1.2) with real `docker compose config`.
3. **Crow keychain.** It is local-only and NEVER synced, encrypted at rest with `servers/sharing/secret-box.js`, and holds human-facing passwords only:
   - human secret fields from install/configure (checkbox "Save to Crow keychain", default on);
   - manual "add" entries (e.g. Workspace phone app passwords).

   Entries are labelled by extension + field and carry: label, bundle_id, env key, username, url, created/updated, and a status (e.g. "extension removed" after uninstall, kept until the user deletes it). It is not a general password manager.
4. **Settings → Passwords page.**
   - It lists the entries.
   - Reveal/copy needs a fresh re-auth: the TOTP code if dashboard 2FA is on, otherwise the dashboard password. The re-auth is valid 5 minutes.
   - Every reveal/copy/delete goes in the audit log.
   - Strings are en+es.
   - Plaintext reaches the browser only on an explicit reveal/copy after re-auth, and never appears in logs.
5. **Optional "Also save to my Vaultwarden vault"** when the vaultwarden bundle is installed.
   - The user types the vault email + master password once per save. They are never stored, never in argv, never logged.
   - Crow uses the official Bitwarden CLI (`@bitwarden/cli`, an npm dependency) pointed at the local Vaultwarden to log in, create a login item and log out.
   - BW session/appdata live in a private temp dir that is removed afterwards.
   - A failure does not fail the install; it is reported.
6. **Generated-and-known secrets.** A new generic env_vars capability, `generate: "secret"` + `keychain: true` (+ optional `store_as: "argon2id"`):
   - Crow generates the token, saves the plaintext to the keychain and shows it once with copy.
   - The bundle `.env` gets either the plaintext or a PHC Argon2id hash computed with Node 24's built-in `crypto.argon2`.
   - First adopters: Vaultwarden `VAULTWARDEN_ADMIN_TOKEN` (replacing its terminal instructions) and Workspace `WORKSPACE_ADMIN_PASSWORD` (Generate button + keychain save).
   - Both manifest versions are bumped and the registry rebuilt.
7. **Follow-ups to list, not build:** Vaultwarden default URL localhost-only → Serve/tailnet address, and the manual "signups allowed" flip (§9).

## 3. Ground truth (verified 2026-10-03)

**Compose `.env` parsing, Docker Compose v5.1.2 on crow** (probed with `docker compose config --environment` and `--format json`):

| line in `.env` | value compose sees |
|---|---|
| ``A='p$a ss#w"d\n`x'`` | ``p$a ss#w"d\n`x`` literally: no `$` interpolation, no escapes |
| `A='a\'b'` | `a'b` (the one escape inside single quotes) |
| `A='\'` | **parse error** (unterminated) |
| `A="a\$b"` / `A="d$$x"` | `a$b` / `d$x` |
| `A="q\nz"` | `q`, a newline, `z` |
| `A="a\zb"` | `a\zb` (unknown escapes stay literal) |
| `A=x #c` / `A=x#c` | `x` / `x#c` |
| `A='$argon2id$v=19$m=65540,t=3,p=4$abc$def'` | the PHC string, verbatim |

A fuzz of 604 random printable/unicode values run through the chosen encoder (§5.1) gave 0 mismatches across all three readers: `${VAR}` interpolation, `env_file: .env`, and bash `set -a; . ./.env`.

**Bundle `.env` writers and readers on `main`:**
- `writeInstallEnv` (raw `${k}=${v}`);
- the Configure route `POST /bundles/api/env` (raw regex read, raw write);
- `appendManagedBlock` (shared storage);
- `resolveGeneratedEnv`'s retained copy;
- `parseEnvText` (raw);
- `composeBuildContexts` via `env-manager.readEnvFile` (strips quotes, no unescape);
- `bundles-config.parseEnvFile` (raw);
- `extension-proxy.readBundleEnv` (raw, trimmed);
- `port-inventory` (numeric regex only).

The **gateway's own** `.env` is loaded literally by `servers/gateway/index.js` (`/^([A-Z_][A-Z0-9_]*)=(.*)$/`, no unquoting) and is not a compose file.

**Bundle scripts.**
- Eleven bundle post-install scripts run `set -a; . "$ENV_FILE"; set +a`: motioneye, writefreely, frigate, lemmy, mastodon, funkwhale, peertube, gotosocial, pixelfed, matrix-bridges, matrix-dendrite. None is wired as a manifest `postInstall`; they are run by hand.
- The Workspace bootstrap reads with `sed -n "s/^KEY=//p"`, which returns the encoded form, not the value.

**secret-box.** `sealSecret` / `openSecret` use AES-256-GCM with a key HKDF'd from the identity seed (`crow-secret-box-v1`). Instances that share a Crow identity derive the same key. Keeping keychain rows local therefore rests on **non-replication**, not on the key.

**Sync.** `servers/sharing/instance-sync.js` `SYNCED_TABLES` gates both `emitChange` and `_applyEntry`, and `servers/shared/sync-emit.js` gates the stdio queue door on the same list.

**Auth.**
- `servers/gateway/dashboard/auth.js` holds `verifyPassword(password, stored)` (scrypt) over `dashboard_settings.password_hash`.
- `servers/gateway/dashboard/totp.js` holds `is2faEnabled()`, `getTotpSecret()` and `verifyTotp(code, secret)`.
- `dashboardAuth` sets `req.dashboardSession` (the raw session token).
- CSRF is a double-submit `X-Crow-Csrf` header or `_csrf` field.

**Audit.** `servers/db.js` `auditLog(db, eventType, { actor, ip, details })` writes the `audit_log` table, which already exists in `scripts/init-db.js`.

**Vaultwarden 1.32.7** (`src/api/admin.rs`, `src/config.rs` at tag 1.32.7):
- `ADMIN_TOKEN` starting `$argon2` is parsed as a PHC string by `argon2::password_hash::PasswordHash::new` and verified against the trimmed submitted token. Hash params come from the PHC string.
- The admin API is authenticated **only by the `VW_ADMIN` cookie** set by `POST /admin` (form field `token`). The bundle's `vaultwarden_user_count` MCP tool sends `Authorization: Bearer`, so it can never have worked on this version (pre-existing bug).
- Wiki presets: Bitwarden `m=65540,t=3,p=4`; OWASP `m=19456,t=2,p=1`.

**Node 24.21.0.** `crypto.argon2Sync("argon2id", { message, nonce, parallelism, tagLength, memory, passes })` exists, as does async `crypto.argon2`. It takes about 58 ms at m=65540,t=3,p=4 on crow.

**`@bitwarden/cli` 2026.9.1** (npm; `bin: build/bw.js`, engines node >= 22; ~18 MB unpacked). From `apps/cli/src/program.ts` / `vault.program.ts`:
- `login [email] [password]` takes `--passwordenv <ENV>`;
- global `--raw` prints the bare session key;
- `create item [encodedJson]` reads the base64 JSON from stdin when the argument is omitted;
- `BITWARDENCLI_APPDATA_DIR` relocates `data.json`;
- `BW_SESSION` carries the session.

## 4. Scope

**In scope:**
- the `.env` codec and the reader/writer switch;
- the env_vars capability (`keychain`, `store_as`, `keychain_username`, `keychain_url`) with Argon2id PHC;
- the keychain store (local-only table), the re-auth gate and the JSON API;
- Settings → Passwords;
- the Extensions modal (Generate, show/hide, copy, keychain checkbox, vault option) and the first-view banner;
- the Bitwarden-CLI vault save;
- Workspace and Vaultwarden adoption;
- a pre-merge live smoke, then PR/merge/deploy.

**Out of scope:** everything in §9.

## 5. Design

### 5.1 Compose-exact `.env` codec (`servers/gateway/bundle-env-codec.js`)

Encoding, applied to every value Crow writes into a bundle `.env` and to the retained-secrets copy:

| value | written as |
|---|---|
| only `A-Z a-z 0-9 _ . / : @ % + , = ~ ^ ! ? * -` (incl. empty) | bare, **byte-identical to what Crow writes today**, so existing files never churn |
| anything else, with no `'` and not ending in `\` | `'value'`: literal in compose AND in bash |
| the rest | `"value"` with `\`, `"` and `$` backslash-escaped: identical in compose and bash |

Refused, with the existing 400 `invalid_env` (key named, value never echoed):
- CR, LF or NUL;
- a backtick in a value that needs double quotes (it contains `'` or ends in `\`).

Compose could express the backtick case, but bash's `. ./.env` (the eleven manual post-install scripts) would execute it there. Refusing that one combination keeps every line Crow writes safe to source. That is the only refusal beyond Kevin's "newline/NUL".

Decoding (`parseEnvText` / `decodeEnvValue`) mirrors compose for every form Crow writes, plus hand edits:
- an `export ` prefix;
- a trailing ` #comment` on bare values;
- `\n \t \r` in double quotes;
- unknown escapes kept literal.

Every bundle-`.env` reader listed in §3 switches to it, except `port-inventory` (digits only). The gateway's own `.env` is **not** a compose file and keeps its literal writer and reader.

### 5.2 Manifest capability

`env_vars[]` gains:

- `keychain: true`. With `generate: "secret"`, the minted plaintext is saved to the keychain (origin `generated`) with a 30-minute first-view grant.
- `store_as: "argon2id"`. Needs `generate` + `keychain`. The bundle `.env` and the retained copy hold `$argon2id$v=19$m=65540,t=3,p=4$<salt b64>$<hash b64>`:
  - 16-byte random salt and 32-byte tag;
  - standard base64 without padding (PHC);
  - Bitwarden preset params.

  The `$` characters survive because the codec single-quotes the value.
- `keychain_label` / `keychain_username` / `keychain_url`. The label names the entry "<extension name> — <keychain_label or env key>". The other two are templates with `${VAR}` substitution from the install env (manifest defaults included); an unset or blank var drops that field. All three apply to human fields too.

The generated plaintext is the existing 43-char base64url `newSecretValue()`; generated tokens are not the 24-char human generator. A token is minted only when neither the installed `.env` nor the retained copy has a value, as today. So **a reinstall never mints a new token**: it reuses the stored hash and reactivates the existing keychain entry.

`registry/manifest.schema.json` and `scripts/lib/bundle-contract.mjs` enforce the combinations.

### 5.3 The keychain store (`crow_keychain`)

```
id INTEGER PK, kind 'extension'|'manual', label, bundle_id, env_key, username, url,
secret_sealed (secret-box "enc:v1:…"), origin 'typed'|'generated'|'manual',
status 'active'|'extension_removed', first_view_until, created_at, updated_at
UNIQUE (bundle_id, env_key) WHERE kind='extension'
```

**Schema.** The table is created by `scripts/init-db.js` (fresh installs) **and** lazily by `ensureKeychainTable(db)` on first use (existing installs), with `CREATE TABLE IF NOT EXISTS`. That makes it additive, with **no `SCHEMA_GENERATION` bump** and no migration-guard expectations. This follows the precedent of `sync-outbox-drain.js` `ensureSyncTables`.

**Local-only, made impossible to replicate:**
- `LOCAL_ONLY_TABLES = ["crow_keychain"]` is exported by `instance-sync.js`;
- a module-load assertion throws if any of them is in `SYNCED_TABLES`;
- `shouldSyncRow` returns false for them;
- a test drives the outbound (`emitChange`, `emitOrQueue`) and inbound (`_applyEntry`) doors with a `crow_keychain` row and asserts nothing is emitted, queued or written.

**Extension saves** upsert on (bundle_id, env_key). Uninstall flips the bundle's entries to `extension_removed`, and they are kept until the user deletes them. A later save, or a reinstall that reuses a generated value, flips them back to `active`.

### 5.4 Re-auth gate and the keychain API

**Re-auth gate.** `POST /dashboard/keychain/api/reauth` takes `{ totp_code }` when `is2faEnabled()`, else `{ password }`. On success it grants **this dashboard session** (keyed by sha256 of `req.dashboardSession`) a 5-minute window.
- Five failures in a row lock re-auth for that session for 15 minutes.
- Grants and locks live in memory, so a gateway restart simply asks again.
- The API is mounted after `dashboardAuth` + `csrfMiddleware` and refuses HMAC-signed peer requests.

| route | needs grant | effect / audit event |
|---|---|---|
| `GET /entries` | no | metadata only, never secrets |
| `POST /reauth` | — | `keychain_reauth_ok` / `keychain_reauth_failed` |
| `POST /reveal {id, purpose: reveal\|copy}` | yes | returns `{ secret }`; `keychain_reveal` / `keychain_copy` |
| `POST /first-view {id}` | no (one-time) | atomically consumes a live first-view grant; `keychain_first_view` |
| `POST /add {label, username, url, secret}` | no | manual entry; `keychain_add` |
| `POST /delete {id}` | yes | `keychain_delete` |
| `POST /vault-save {id, vault_email, vault_password}` | yes | §5.6; `keychain_vault_save` (ok / reason) |
| `GET /activity` | no | last 25 `keychain_*` audit rows |

Audit `details` carry `{ entry_id, label, bundle_id, env_key }` and never a secret. Responses that carry a secret set `Cache-Control: no-store`.

### 5.5 UI

**Extensions install/configure modal** (`client.js`, template-literal rules: no backticks):
- every human secret field gets **Generate**, **Show/Hide** and **Copy**;
- below each one, **"Save to Crow keychain"** (checked);
- when the vaultwarden bundle is installed, one **"Also save to my Vaultwarden vault"** block with email + master password inputs (`autocomplete="off"`, never persisted client-side);
- the request carries `keychain: { save: [KEY…], vault: { email, password } }` beside `env_vars`.

**Generator** (`dashboard/shared/password-generator.js`): 24 chars from `a-z A-Z 2-9` plus `!#%*+,-./:=?@^_~` (look-alikes dropped), with at least one of each class and rejection-sampled `crypto.getRandomValues`. When the field has a `pattern`, it retries until the result matches, then falls back to alphanumerics, then hides the button. The same function is embedded in the client via `Function.prototype.toString` and unit-tested in Node.

**First-view banner.** The Extensions page renders a banner for each entry with a live first-view grant: "A password was generated for <label>. Show once / Copy", via `/first-view`. It is server-rendered, so it survives the reload and gateway restart that follow an install.

**Settings → Passwords** (group `account`, after Two-Factor):
- the entries table (label, extension, username, URL, status, updated);
- Reveal / Copy / Delete / Save to vault per row, all behind a re-auth dialog (TOTP or password) whose 5-minute grant is shown with a countdown;
- an "Add a password" form;
- recent activity.

All strings are en+es under `passwords.*` and pass `tests/i18n-global-parity.test.js`.

### 5.6 Vaultwarden save (`servers/gateway/keychain/vault-save.js`)

**Availability.** The vaultwarden bundle is installed **and** `~/.crow/bundles/vaultwarden/node_modules/@bitwarden/cli/build/bw.js` exists. `@bitwarden/cli` is pinned exactly (`2026.9.1`) in **`bundles/vaultwarden/package.json`**, so the installer's `npm install` puts it next to the bundle. Root `package.json` stays lean, and CI's prod audit is unaffected. The server URL is `VAULTWARDEN_URL` from the bundle `.env`, decoded, defaulting to `http://localhost:8097`.

**Flow.** Each step is run as `process.execPath bw.js …` with a 60 s timeout, `env = { PATH, HOME=tmp, BITWARDENCLI_APPDATA_DIR=tmp, BW_NOINTERACTION=true, NODE_OPTIONS="" }`, inside `mkdtemp` (mode 700):
1. `config server <url>`;
2. `login <email> --passwordenv CROW_BW_MASTER --raw`, with the master password only in that env var;
3. `create item` with base64 JSON on **stdin**, session in `BW_SESSION`;
4. `logout`;
5. `rm -rf` the temp dir in `finally`.

**Outcome.** It returns `{ ok }` or `{ ok:false, reason }`. The reason is a fixed, sanitized sentence (wrong credentials / vault unreachable / two-step login enabled / CLI missing / timeout); CLI output is never echoed.

**During install,** the vault save runs right after the keychain save (before images are pulled), then the credentials are dropped. **On the Passwords page** it is a per-entry action (re-auth required).

### 5.7 Installer wiring

- `/bundles/api/install` and `/bundles/api/env` accept `keychain`.
- Human-field saves and vault saves are honoured **only for a local dashboard session**. Peer-signed (`req.crossHostAuth`) requests never write human secrets to the keychain and never touch a vault.
- Generated `keychain: true` tokens are always saved: otherwise the plaintext would be lost.
- Job logs say "Saved N password(s) to Crow keychain" and "Vaultwarden: saved" / "Vaultwarden save did not complete: <reason>". Values never appear.
- Uninstall calls `markBundleRemoved`.

### 5.8 Adopters

**Vaultwarden** (`1.0.0 → 1.1.0`):
- `VAULTWARDEN_ADMIN_TOKEN` becomes `generate:"secret"`, `keychain:true`, `store_as:"argon2id"`, `keychain_url:"${VAULTWARDEN_DOMAIN}/admin"`, with a new description;
- the skill's step 1 is rewritten;
- the consent text no longer says "plaintext";
- `server.envKeys` drops the token, because the MCP child never receives generated values;
- `vaultwarden_user_count` returns an explanation instead of a request that could never authenticate;
- `@bitwarden/cli` is added.

Existing installs keep their typed token: it is reused from the installed `.env`.

**Workspace** (`0.1.1 → 0.1.2`):
- `WORKSPACE_ADMIN_PASSWORD` pattern becomes `^[^\x00-\x1f\x7f]{12,128}$` (any printable character incl. space and unicode; no control chars), with `keychain_username: "${WORKSPACE_ADMIN_USER}"`;
- the ops scripts read `.env` through `ops/envfile.py`, a no-eval decoder byte-identical to the codec;
- `reset-password.sh` accepts the same set;
- secrets still travel by `printf '%s\n' | … IFS= read -r`, which is byte-exact for every allowed character.

## 6. Security properties

- Plaintext at rest only in bundle `.env` files (mode 600, as today). Workspace scrubs its admin password, and Vaultwarden now stores only a hash. The keychain is AES-256-GCM sealed.
- Plaintext reaches the browser only on reveal/copy after re-auth, or once via first-view (≤30 min, single use, audited).
- Never in argv: the master password goes through `--passwordenv`, item JSON through stdin, the session through env. The vault email IS in `bw login` argv (ruling R11).
- Never logged: job logs, audit details and errors carry key names and labels only.
- Never replicated: `LOCAL_ONLY_TABLES` plus the test.
- Same-identity peers could decrypt a stolen ciphertext, but no code path ever sends one.

## 7. Rulings (where Kevin's decisions were silent)

- **R1** The encoder is bare / single / double as in §5.1. Bare output is byte-identical to today's, so existing `.env` files never change. The backtick+(quote or trailing backslash) refusal is the only extra refusal.
- **R2** The gateway `.env` is untouched (it is not a compose file and has a literal loader).
- **R3** Workspace pattern: `^[^\x00-\x1f\x7f]{12,128}$`. Tabs are refused as unprintable. `not_breached` stays.
- **R4** The table is additive (init-db + lazy ensure). No SCHEMA_GENERATION bump, so no dry-run rail.
- **R5** It uses secret-box's existing key, per Kevin. Locality is enforced by non-replication plus the test.
- **R6** Re-auth is per dashboard session and held in memory: a 5-minute grant; 5 failures lock for 15 minutes. With 2FA on, only TOTP is accepted (recovery codes stay a login-only tool).
- **R7** Delete also requires re-auth: it is destructive and audited.
- **R8** First view: generated tokens get `first_view_until = created + 30 min`, consumed atomically, so it survives the post-install reload/restart.
- **R9** Peer-signed requests never save human fields and never use the vault.
- **R10** `keychain_label` plus the `keychain_username` / `keychain_url` templates; unset vars drop the field.
- **R11** The vault email is passed as the `bw login` positional argument. `bw` has no env/stdin option for it, and the interactive prompt is disabled. It is an identifier, not a secret, and visible to local `ps` for at most 60 s. **Flagged for Kevin.**
- **R12** Two-step-login vault accounts are not driven. The save reports "your vault account uses two-step login; add the password from Settings → Passwords by hand".
- **R13** `vaultwarden_user_count` explains instead of calling: it never worked on 1.32.7 (cookie-only admin API), and the token is now hashed.
- **R14** Argon2id: m=65540, t=3, p=4, 16-byte salt, 32-byte tag, unpadded standard base64. It is computed with `argon2Sync` (~60 ms, once per install).
- **R15** No regenerate/rotate action in this arc (§9).
- **R16** Kevin's definition of "human field" (`secret && !generate`) is applied as written, so API-key fields also get the button and the checkbox. Harmless; the user can ignore them. **Flagged.**
- **R17** The pre-merge smoke needs one **[KEVIN]** step: registering a throwaway vault account in the web vault over a temporary Serve port (8461). `bw` has no `register` command, and the web vault needs HTTPS for WebCrypto.

## 8. Testing

Unit tests (no containers) cover:
- the codec, including a real `docker compose config` round-trip that is skipped when compose is absent;
- argon2 PHC;
- the generated-keychain resolve path;
- the store and the locality guard;
- the re-auth gate and API;
- vault-save with a fake `bw`;
- installer wiring;
- the extensions client run in linkedom/vm;
- the Passwords section;
- the Workspace ops scripts with the fake compose;
- the Vaultwarden bundle;
- i18n parity.

Live pre-merge smoke on crow, registered in `~/CROW-SCHEDULE.md` with a deadman, in a throwaway `CROW_HOME`:
- a throwaway Vaultwarden on 127.0.0.1:18097 with a generated argon2 token: log in to `/admin` with the keychain plaintext;
- `bw` save into a throwaway account;
- wide-charset values end-to-end through `docker compose`.

## 9. Follow-ups (listed, not built)

1. **Vaultwarden default URL** is `http://localhost:8097` (loopback-only). It should default to a Tailscale Serve HTTPS address on the tailnet: phones' Bitwarden apps and the web vault's WebCrypto need HTTPS.
2. **Vaultwarden "signups allowed"** is still a manual `.env` flip + restart after creating the first account. A guided "Close signups" action belongs in the panel.
3. Regenerate/rotate a keychain-held generated token (today: delete the retained line and reinstall).
4. Moving the eleven `set -a; . .env` post-install scripts onto the no-eval reader.
5. Optional per-field opt-out of the Generate button for non-password API tokens (`generate_button: false`).
