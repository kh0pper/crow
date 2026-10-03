# Crow Keychain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Generate/show/copy on every human password field, compose-exact `.env` quoting that accepts nearly any printable character, a local-only encrypted Crow keychain with a re-auth-gated Settings → Passwords page, an optional copy into the user's own Vaultwarden vault via the Bitwarden CLI, and a generic `generate`+`keychain`(+`store_as: argon2id`) manifest capability adopted by Vaultwarden and Workspace.

**Architecture:**
- One codec module owns every byte Crow writes to or reads from a bundle `.env`.
- The installer gains a "generated and known" path: mint → keychain → optional Argon2id PHC in `.env`.
- The keychain is one additive, never-synced SQLite table, sealed with the existing secret-box. A small JSON API sits behind a per-session 5-minute re-auth gate.
- The UI touches the existing extensions modal (template-literal client) and adds a new Settings section. The Vaultwarden save shells out to `@bitwarden/cli`, installed as a dependency of the vaultwarden bundle.

**Tech Stack:** Node 24 (`node:crypto` `argon2Sync`, `node:test`, express, better-sqlite3 via `servers/db.js`), linkedom + `node:vm` for client tests, Docker Compose v5.1.2 (dotenv rules), bash + python3 (Workspace ops), `@bitwarden/cli` 2026.9.1.

**Spec:** `docs/superpowers/specs/2026-10-03-crow-keychain-design.md`. It is binding: where this plan and the spec disagree, the spec wins. The spec's §7 Rulings R1–R17 apply here; this plan adds P1–P8 below.

## Rulings added by this plan (evidence gathered 2026-10-03)

- **P1 — Encoder proven, not assumed.** The bare/single/double encoder in Task 1 was fuzzed on crow before this plan was written:
  - 604 random printable + unicode values, 0 mismatches between the intended value and each of: compose `${VAR}` interpolation, compose `env_file: .env`, and bash `set -a; . ./.env`;
  - 17 values were refused (backtick plus quote or trailing backslash).

  The Python decoder (`bundles/workspace/ops/envfile.py`) and the JS decoder both matched bash on the same 604-value file. Task 1 pins this with a compose round-trip test (skipped if `docker compose` is absent). Task 11 re-runs it live.
- **P2 — Readers switched.** These move to `parseEnvText` from the codec:
  - `composeBuildContexts` (`bundles.js:575`, replacing `env-manager.readEnvFile`);
  - the Configure route read (`bundles.js:3220-3226`);
  - `bundles-config.parseEnvFile`;
  - `extension-proxy.readBundleEnv`.

  `port-inventory.js:248` (digits only) is left alone. `env-manager.js` (the gateway `.env`) is untouched (R2).
- **P3 — One shared test harness file per surface.** Client behavior is tested in a new `tests/extensions-keychain-client.test.js` with its own copy of the `boot()` harness, so `extensions-client-contract.test.js` does not change. The generator buttons use `btn-secondary`, never `btn-primary`: existing tests select `#modal-content .btn-primary` as the Install button.
- **P4 — API mount point.** The keychain API mounts in `servers/gateway/dashboard/index.js` immediately after `router.use("/dashboard", csrfMiddleware);` (line 621), as `router.use(keychainApiRouter())`. It is therefore session-authed and CSRF-protected like the Perch API. The router also refuses any request that carries `x-crow-signature`.
- **P5 — The first-view banner is server-rendered** on the Extensions page (`buildExtensionsHTML({ keychainPending })`), so it survives the post-install `location.reload()` and gateway restart (`client.js:843-856`).
- **P6 — The vault option needs `#ext-keychain-config[data-vault="1"]`**, rendered by `html.js` when `installed.vaultwarden` is present. The client never probes.
- **P7 — Install-path keychain saves happen in `runInstallJob` right after `writeInstallEnv`**, before shared-storage injection and before any image pull. That way a later compose failure still leaves the password in the keychain, and the vault master password is held for seconds, not for the length of a pull.
- **P8 — Deploy targets** are the gateways that were live on 2026-10-03:
  - crow: `crow-gateway.service` and `crow-r4-gateway.service`;
  - grackle: `crow-gateway.service`;
  - raven's paired instance (raven:3009): its unit name is confirmed with `systemctl list-units '*crow*'` at deploy time, because it was not visible from crow today.

## Global Constraints

- The codec refuses only CR/LF/NUL and a backtick combined with `'` or a trailing `\` (spec §5.1). Bare-safe values are written byte-identically to today.
- The keychain table is `crow_keychain`. It is additive (`scripts/init-db.js` + `ensureKeychainTable`), with **no `SCHEMA_GENERATION` bump**, and it is listed in `LOCAL_ONLY_TABLES`, which must never intersect `SYNCED_TABLES`.
- Encryption is only `servers/sharing/secret-box.js` `sealSecret` / `openSecret` with `loadOrCreateIdentity()`.
- Re-auth: TOTP when `is2faEnabled()`, else the dashboard password. The grant lasts 5 minutes, per dashboard session; 5 failures lock for 15 minutes.
- Every reveal/copy/delete/first-view/vault-save/add/save writes `audit_log` via `auditLog(db, "keychain_*", { details })`. Details hold ids/labels/keys, never values.
- Plaintext never goes in job logs, audit details, error messages, URLs, argv (except the vault email, R11) or `console.*`.
- Argon2id PHC: `$argon2id$v=19$m=65540,t=3,p=4$<salt>$<hash>`, 16-byte salt, 32-byte tag, unpadded standard base64.
- `@bitwarden/cli` is pinned exactly `2026.9.1` in `bundles/vaultwarden/package.json` (never root).
- Version bumps: vaultwarden `1.0.0 → 1.1.0`, workspace `0.1.1 → 0.1.2`. Then `node scripts/build-registry.mjs` and `--check`.
- i18n: every new key has en + es, the es differing from the en (`tests/i18n-global-parity.test.js`).
- `servers/gateway/dashboard/panels/extensions/client.js` and every section's client script are template literals:
  - **no backticks**;
  - no `${` except deliberate interpolation;
  - no backslashes in literal client code.
- Repo rules (`CLAUDE.md`):
  - positional-path commits (`git add <new files>` first, then `git commit <paths> -m …`, then `git show --stat HEAD`);
  - `git pull --rebase` before a push;
  - tests via `npm test -- tests/<file>.test.js` (never raw `node --test`);
  - never `git checkout` in `~/crow`;
  - check-runs all `completed/success` before merge;
  - no AI attribution.
- Every live window is registered in `~/CROW-SCHEDULE.md` before it starts and cleared after, with an out-of-process deadman (`systemd-run --user --on-active`).
- `gh` is not installed on crow: PRs go through the GitHub MCP tools (`kh0pp/crow`).

## Review Focus

1. **A typed or generated password containing `$`, `'`, `"`, `\`, `#`, a space or unicode.** Docker Compose, a bash `. .env`, Crow's readers and the Workspace ops scripts must all see exactly the typed bytes. *Pinned:*
   - Task 1 `REVIEW FOCUS 1 — compose sees the exact value (real docker compose config)`;
   - Task 9 `REVIEW FOCUS 1 (ops) — bootstrap pipes the exact wide-charset admin password`.
2. **The gateway restarts (or the page reloads) between install and the first look at a generated token.** The token must still be showable exactly once, and a second look must demand re-auth. *Pinned:* Task 3 `REVIEW FOCUS 2 — first view is single-use and expires`; Task 4 `REVIEW FOCUS 2 (API) — first-view works once without re-auth, then 410`.
3. **Keychain rows reaching a paired instance** through any sync door (live emit, stdio queue, inbound apply, or a future edit to `SYNCED_TABLES`). *Pinned:* Task 3 `REVIEW FOCUS 3 — crow_keychain can never replicate`.
4. **A stale grant, another session's grant, or a guessed TOTP/password.** None may reveal a secret, and five wrong guesses must lock. *Pinned:* Task 4 `REVIEW FOCUS 4 — grants are per session, expire at 5 min, lock after 5 failures`.
5. **The Vaultwarden save failing** (wrong master password, vault down, CLI missing, two-step login, hang). The install must still succeed, the failure must be reported in words, and the master password must never appear in argv, logs, the job or the temp dir after the run. *Pinned:* Task 5 `REVIEW FOCUS 5 — failures are sentences; secrets never in argv; temp dir removed`; Task 6 `REVIEW FOCUS 5 (install) — a failed vault save never fails the install or leaks`.

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `servers/gateway/bundle-env-codec.js` | Create | Compose-exact encode/decode/parse/format of bundle `.env` values |
| `servers/gateway/bundle-env-secrets.js` | Modify | Re-export codec `parseEnvText`; `keychain`/`store_as` generation (`resolveGeneratedEnvDetailed`); template expansion |
| `servers/gateway/keychain/argon2-phc.js` | Create | Argon2id PHC hash + verify (Node 24 `crypto.argon2Sync`) |
| `servers/gateway/keychain/store.js` | Create | `crow_keychain` table, sealed CRUD, first-view, bundle status |
| `servers/gateway/keychain/reauth.js` | Create | Per-session 5-minute re-auth grants, failure lock |
| `servers/gateway/keychain/vault-save.js` | Create | Bitwarden-CLI save into the local Vaultwarden |
| `servers/gateway/keychain/install-hooks.js` | Create | Installer-side: sanitize the `keychain` request, save human + generated secrets, vault save, job-log lines |
| `servers/gateway/keychain/api.js` | Create | `/dashboard/keychain/api/*` router |
| `servers/gateway/routes/bundles.js` | Modify | Codec writes/reads, `findInvalidEnv`, install/configure/uninstall wiring |
| `servers/gateway/bundles-config.js` | Modify | `parseEnvFile` → codec |
| `servers/gateway/routes/extension-proxy.js` | Modify | `readBundleEnv` → codec |
| `servers/sharing/instance-sync.js` | Modify | `LOCAL_ONLY_TABLES` + load-time assertion + `shouldSyncRow` refusal |
| `scripts/init-db.js` | Modify | `crow_keychain` table (fresh installs) |
| `servers/gateway/dashboard/index.js` | Modify | Mount the keychain API |
| `servers/gateway/dashboard/shared/password-generator.js` | Create | The 24-char generator (Node + embedded client) |
| `servers/gateway/dashboard/panels/extensions/html.js` | Modify | `#ext-keychain-config`, first-view banner, `keychainPending` param |
| `servers/gateway/dashboard/panels/extensions.js` | Modify | Query pending first-view entries |
| `servers/gateway/dashboard/panels/extensions/client.js` | Modify | Generate/show/copy, keychain checkbox, vault block, first-view buttons |
| `servers/gateway/dashboard/settings/sections/passwords.js` | Create | Settings → Passwords |
| `servers/gateway/dashboard/panels/settings.js` | Modify | Register the section |
| `servers/gateway/dashboard/shared/i18n.js` | Modify | `keychain.*`, `passwords.*`, `settings.section.passwords` |
| `registry/manifest.schema.json` | Modify | `keychain`, `store_as`, `keychain_username`, `keychain_url` |
| `scripts/lib/bundle-contract.mjs` | Modify | `store_as`/`keychain` combination rules |
| `bundles/vaultwarden/{manifest.json,package.json,package-lock.json,server/server.js,skills/vaultwarden.md}` | Modify | Adopter; bw CLI dependency; user_count explanation |
| `bundles/workspace/{manifest.json,ops/lib.sh,ops/bootstrap.sh,ops/reset-password.sh}` | Modify | Relaxed pattern; no-eval reads |
| `bundles/workspace/ops/envfile.py` | Create | No-eval `.env` reader for ops scripts |
| `registry/add-ons.json` | Regenerate | — |
| `tests/bundle-env-codec.test.js` | Create | Task 1 |
| `tests/bundle-env-keychain-generate.test.js` | Create | Task 2 |
| `tests/keychain-store.test.js` | Create | Task 3 |
| `tests/keychain-api.test.js` | Create | Task 4 |
| `tests/keychain-vault-save.test.js` | Create | Task 5 |
| `tests/keychain-install-wiring.test.js` | Create | Task 6 |
| `tests/extensions-keychain-client.test.js` | Create | Task 7 |
| `tests/settings-passwords-section.test.js` | Create | Task 8 |
| `tests/workspace-bootstrap.test.js`, `tests/workspace-bundle.test.js` | Modify | Task 9 |
| `tests/vaultwarden-bundle.test.js` | Create | Task 9 |

**CI tasks** (code + unit tests): 1–10. **Attended LIVE**: 11 (pre-merge smoke, one **[KEVIN]** step), 12 (PR/merge after Kevin's OK, deploy).

---

### Task 0: Worktree and dependencies (setup, no commit)

- [ ] **Step 1: Confirm the worktree and install deps**

```bash
cd ~/crow-wt-keychain
git branch --show-current            # feat/crow-keychain
git log --oneline -1                 # ec197558 or later main
npm ci
node --version                       # v24.x
docker compose version               # Docker Compose version v5.1.2
node -e 'console.log(typeof require("node:crypto").argon2Sync)'   # function
```

- [ ] **Step 2: Baseline suite** (so a later red is known to be ours)

```bash
npm test 2>&1 | tail -5              # record pass/fail counts in the task notes
```

---
### Task 1: Compose-exact `.env` codec, and every bundle `.env` reader/writer on it

**Files:**
- Create: `servers/gateway/bundle-env-codec.js`
- Modify: `servers/gateway/bundle-env-secrets.js` (drop local `parseEnvText`, re-export the codec's; retained copy written with `formatEnvLines`)
- Modify: `servers/gateway/routes/bundles.js`:
  - `findInvalidEnv` (~:1683);
  - `writeInstallEnv` (~:1908);
  - `composeBuildContexts` env read (~:575) and its now-unused `readEnvFile` import (:55);
  - `appendManagedBlock` (~:1138);
  - the Configure route read/write (`POST /bundles/api/env`, ~:3215-3232).
- Modify: `servers/gateway/bundles-config.js:81-90` (`parseEnvFile`)
- Modify: `servers/gateway/routes/extension-proxy.js:47-60` (`readBundleEnv`)
- Test: `tests/bundle-env-codec.test.js`

**Interfaces:**
- Produces:
  - `envValueProblem(value: any): string|null`
  - `encodeEnvValue(value: any): string` (throws on a problem)
  - `decodeEnvValue(raw: string): string`
  - `parseEnvText(text: string): Record<string,string>`
  - `formatEnvLines(vars: Record<string,any>): string` (skips undefined/null; `""` → `KEY=`; newline-terminated; `""` for no vars)
- `bundle-env-secrets.js` keeps exporting `parseEnvText` (now the codec's), so every existing import site keeps working.

- [ ] **Step 1: Write the failing test**

Create `tests/bundle-env-codec.test.js`:

```js
/**
 * Compose-exact bundle .env codec (Crow keychain, Task 1).
 * The docker test runs real `docker compose config` and is skipped when compose is absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-codec-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-codec-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const C = await import("../servers/gateway/bundle-env-codec.js");
const S = await import("../servers/gateway/bundle-env-secrets.js");
const B = await import("../servers/gateway/routes/bundles.js");

const BT = "\u0060";
const WIDE = [
  "", "plain", "Correct-Horse-1", "a=b", "p a$s'w\"d#1", "$argon2id$v=19$m=65540,t=3,p=4$abc$def",
  "it's $HOME", "a\\'b", "x\\", "\\", "  lead", "trail  ", "#hash", "a #b", "${A}", "$(id)",
  "back" + BT + "tick", "tab\there", "é😀ü", "{}~!@%^&*()[]|;:,.<>?/",
];

function randomPrintable() {
  const pool = [];
  for (let c = 0x20; c < 0x7f; c++) pool.push(String.fromCharCode(c));
  pool.push("é", "😀", "\t");
  let s = "";
  const n = randomInt(1, 30);
  for (let i = 0; i < n; i++) s += pool[randomInt(pool.length)];
  return s;
}

test("bare-safe values are written byte-identically to before (no churn of existing .env files)", () => {
  for (const v of ["", "abc", "Correct-Horse-1", "http://localhost:8097", "a=b", "x.y/z:1@2%3+4,5~6^7!8?9*0-_"]) {
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

test("REVIEW FOCUS 1 (bash) — `set -a; . ./.env` sees the exact value", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-codec-bash-"));
  const vals = [...WIDE, ...Array.from({ length: 150 }, randomPrintable)].filter((v) => !C.envValueProblem(v));
  const vars = Object.fromEntries(vals.map((v, i) => [`K${i}`, v]));
  writeFileSync(join(dir, ".env"), C.formatEnvLines(vars));
  const r = spawnSync("bash", ["-c", "set -a; . ./.env; set +a; node -e 'const o={};for(const[k,v]of Object.entries(process.env))if(/^K[0-9]+$/.test(k))o[k]=v;process.stdout.write(JSON.stringify(o))'"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), vars);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/bundle-env-codec.test.js`
Expected: FAIL with `Cannot find module '…/servers/gateway/bundle-env-codec.js'`.

- [ ] **Step 3: Create `servers/gateway/bundle-env-codec.js`**

```js
/**
 * Compose-exact bundle .env codec.
 *
 * Crow writes every bundle .env through encodeEnvValue/formatEnvLines and reads it back
 * through parseEnvText, so a value survives `docker compose` (both `${VAR}` interpolation
 * and `env_file:`), POSIX `set -a; . ./.env` (the hand-run post-install scripts) and
 * Crow's own readers byte-for-byte. Verified against Docker Compose v5.1.2 on crow
 * (2026-10-03: 604 fuzzed values, 0 mismatches) and pinned by tests/bundle-env-codec.test.js.
 *
 *   bare      A-Z a-z 0-9 _ . / : @ % + , = ~ ^ ! ? * -   (byte-identical to before)
 *   'single'  anything else without ' and not ending in \  (literal: no $ expansion)
 *   "double"  the rest, with \ " $ backslash-escaped
 *
 * Refused (envValueProblem): CR, LF, NUL (one value per line), and a backtick in a value
 * that needs double quotes (it contains ' or ends in \), because `. ./.env` would
 * execute it there. NOT used for the gateway's own .env (literal loader, not compose).
 */
const BARE_SAFE = /^[A-Za-z0-9_./:@%+,=~^!?*-]*$/;
const BACKTICK = "\u0060";
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

export function encodeEnvValue(value) {
  const s = String(value);
  const problem = envValueProblem(s);
  if (problem) throw new Error(`env value ${problem}`);
  if (BARE_SAFE.test(s)) return s;
  if (!s.includes("'") && !s.endsWith("\\")) return `'${s}'`;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;
}

/** The value compose would see for the text after `KEY=`. */
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

/** One `KEY=<encoded>` line per entry (undefined/null skipped), newline-terminated. */
export function formatEnvLines(vars) {
  const lines = [];
  for (const [k, v] of Object.entries(vars || {})) {
    if (v === undefined || v === null) continue;
    lines.push(`${k}=${encodeEnvValue(v)}`);
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}
```

- [ ] **Step 4: Point `bundle-env-secrets.js` at the codec**

In `servers/gateway/bundle-env-secrets.js`:

1. Delete the local `export function parseEnvText(text) { … }` (lines 19-26).
2. After the `node:crypto` import, add:

```js
import { parseEnvText, formatEnvLines } from "./bundle-env-codec.js";
export { parseEnvText };
```

3. In `resolveGeneratedEnv`, replace the `writePrivateFile(retainedPath, …)` argument's last line, ``Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",``, with:

```js
      formatEnvLines(merged),
```

- [ ] **Step 5: Switch the writers and readers in `servers/gateway/routes/bundles.js`**

a. Imports. Delete line 55, `import { readEnvFile } from "../env-manager.js";`. Its only use was `composeBuildContexts`; `grep -n "readEnvFile" servers/gateway/routes/bundles.js` must print nothing after (b). Add:

```js
import { envValueProblem, encodeEnvValue, formatEnvLines } from "../bundle-env-codec.js";
```

b. In `composeBuildContexts`, replace

```js
      for (const [k, { value }] of readEnvFile(join(destDir, ".env")).vars) fileVars[k] = value;
```

with

```js
      Object.assign(fileVars, parseEnvText(readFileSync(join(destDir, ".env"), "utf8")));
```

c. In `appendManagedBlock`, replace ``for (const [k, v] of Object.entries(kvPairs)) lines.push(`${k}=${v}`);`` with:

```js
  for (const [k, v] of Object.entries(kvPairs)) lines.push(`${k}=${encodeEnvValue(v)}`);
```

d. Replace `findInvalidEnv`'s value check:

```js
export function findInvalidEnv(envVars) {
  if (!envVars || typeof envVars !== "object") return null;
  for (const [k, v] of Object.entries(envVars)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) return { key: k, why: "is not a valid environment variable name" };
    if (v !== undefined && v !== null) {
      const problem = envValueProblem(v);
      if (problem) return { key: k, why: problem };
    }
  }
  return null;
}
```

Update its doc comment's second sentence to: "a value may not carry CR, LF or NUL, nor a backtick that would need double quotes (bundle-env-codec.js)".

e. In `writeInstallEnv`, replace the `envLines` computation and the first `if` with:

```js
  const usable = {};
  if (envVars && typeof envVars === "object") {
    for (const [k, v] of Object.entries(envVars)) if (v !== undefined && v !== "") usable[k] = v;
  }
  const count = Object.keys(usable).length;
  if (count > 0) {
    writePrivateFile(envPath, formatEnvLines(usable));
    log(`Wrote ${count} env vars`);
    return;
  }
```

and change rung 1 of the doc comment to "Provided non-empty values → written compose-quoted (bundle-env-codec.js)".

f. In `POST /bundles/api/env`, replace the read loop

```js
      const existing = {};
      if (existsSync(envPath)) {
        for (const line of readFileSync(envPath, "utf8").split("\n")) {
          const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
          if (match) existing[match[1]] = match[2];
        }
      }
```

with

```js
      const existing = existsSync(envPath) ? parseEnvText(readFileSync(envPath, "utf8")) : {};
```

and the write

```js
      const envContent = Object.entries(existing)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") + "\n";
      writePrivateFile(envPath, envContent);
```

with

```js
      writePrivateFile(envPath, formatEnvLines(existing));
```

- [ ] **Step 6: Switch `bundles-config.js` and `extension-proxy.js`**

`servers/gateway/bundles-config.js`: add `import { parseEnvText } from "./bundle-env-codec.js";` and replace the body of `parseEnvFile`:

```js
function parseEnvFile(path) {
  try { return parseEnvText(readFileSync(path, "utf8")); } catch { return {}; }
}
```

`servers/gateway/routes/extension-proxy.js`: add `import { parseEnvText } from "../bundle-env-codec.js";` and replace the body of `readBundleEnv`:

```js
function readBundleEnv(bundleId) {
  try {
    return parseEnvText(readFileSync(join(BUNDLES_DIR, bundleId, ".env"), "utf8"));
  } catch {
    return {}; // No .env for this bundle — defaults apply.
  }
}
```

Update its doc comment: "Decoded with the compose-exact codec (bundle-env-codec.js)".

- [ ] **Step 7: Run the new test and the neighbours that exercise these paths**

Run:

```bash
npm test -- tests/bundle-env-codec.test.js
npm test -- tests/bundle-env-secrets.test.js
npm test -- tests/bundle-env-scoping.test.js
npm test -- tests/extensions-needs-config.test.js
```

Expected: all PASS. The compose test runs on crow (not skipped).

- [ ] **Step 8: Commit**

```bash
git add servers/gateway/bundle-env-codec.js tests/bundle-env-codec.test.js
git commit servers/gateway/bundle-env-codec.js tests/bundle-env-codec.test.js servers/gateway/bundle-env-secrets.js servers/gateway/routes/bundles.js servers/gateway/bundles-config.js servers/gateway/routes/extension-proxy.js -m "feat(bundles): compose-exact .env codec — nearly any printable character survives compose, bash and every Crow reader"
git show --stat HEAD
```

---

### Task 2: `generate` + `keychain` (+ `store_as: "argon2id"`) manifest capability

**Files:**
- Create: `servers/gateway/keychain/argon2-phc.js`
- Modify: `servers/gateway/bundle-env-secrets.js` (`resolveGeneratedEnvDetailed`, `keychainGeneratedKeys`, `expandKeychainTemplate`)
- Modify: `registry/manifest.schema.json` (env_vars item properties `keychain`, `store_as`, `keychain_label`, `keychain_username`, `keychain_url`)
- Modify: `scripts/lib/bundle-contract.mjs` (combination rules)
- Test: `tests/bundle-env-keychain-generate.test.js`

**Interfaces:**
- Consumes: `formatEnvLines`, `parseEnvText` (Task 1).
- Produces:
  - `argon2idPhc(plaintext: string, { salt?: Buffer } = {}): string`
  - `verifyArgon2idPhc(plaintext: string, phc: string): boolean`
  - `ARGON2_PARAMS = { memory: 65540, passes: 3, parallelism: 4, tagLength: 32 }`
  - `resolveGeneratedEnvDetailed(bundleId, manifest, { destDir, crowHome }): { env: Record<string,string>, minted: Record<string,string> }`. `env` is what goes in `.env` (hash for `store_as`); `minted` holds the plaintext of keys that are `keychain: true` AND were newly created by this call.
  - `resolveGeneratedEnv(...)`: unchanged signature, returns `.env` of the detailed call.
  - `keychainGeneratedKeys(manifest): string[]`
  - `expandKeychainTemplate(template: string|undefined, env: object): string|null`

- [ ] **Step 1: Write the failing test**

Create `tests/bundle-env-keychain-generate.test.js`:

```js
/** generate + keychain + store_as (Crow keychain, Task 2). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("fresh install: keychain keys are minted, store_as writes a hash, plaintext only in `minted`", () => {
  const home = scratch("h-");
  const { env, minted } = S.resolveGeneratedEnvDetailed("vw-demo", VW, { destDir: scratch("d-"), crowHome: home });
  assert.deepEqual(Object.keys(minted).sort(), ["VW_ADMIN_TOKEN", "VW_PLAIN"], "VW_INTERNAL is not keychain:true");
  assert.match(minted.VW_ADMIN_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(P.verifyArgon2idPhc(minted.VW_ADMIN_TOKEN, env.VW_ADMIN_TOKEN), true);
  assert.equal(env.VW_PLAIN, minted.VW_PLAIN, "no store_as → plaintext in .env");
  const retained = S.parseEnvText(readFileSync(S.retainedEnvPath(home, "vw-demo"), "utf8"));
  assert.equal(retained.VW_ADMIN_TOKEN, env.VW_ADMIN_TOKEN, "the retained copy holds the HASH");
  assert.ok(!readFileSync(S.retainedEnvPath(home, "vw-demo"), "utf8").includes(minted.VW_ADMIN_TOKEN));
});

test("reinstall mints nothing: the stored hash is reused and `minted` is empty", () => {
  const home = scratch("h-");
  const first = S.resolveGeneratedEnvDetailed("vw-demo", VW, { destDir: scratch("d1-"), crowHome: home });
  const second = S.resolveGeneratedEnvDetailed("vw-demo", VW, { destDir: scratch("d2-"), crowHome: home });
  assert.deepEqual(second.env, first.env);
  assert.deepEqual(second.minted, {});
});

test("an installed .env value (e.g. a typed legacy plaintext token) wins and is not re-hashed", () => {
  const home = scratch("h-"); const dest = scratch("d-");
  writeFileSync(join(dest, ".env"), "VW_ADMIN_TOKEN=legacy-typed-token\n");
  const { env, minted } = S.resolveGeneratedEnvDetailed("vw-demo", VW, { destDir: dest, crowHome: home });
  assert.equal(env.VW_ADMIN_TOKEN, "legacy-typed-token");
  assert.equal(minted.VW_ADMIN_TOKEN, undefined);
});

test("resolveGeneratedEnv (old signature) still returns just the .env map", () => {
  const out = S.resolveGeneratedEnv("vw-demo", VW, { destDir: scratch("d-"), crowHome: scratch("h-") });
  assert.deepEqual(Object.keys(out).sort(), ["VW_ADMIN_TOKEN", "VW_INTERNAL", "VW_PLAIN"]);
});

test("keychainGeneratedKeys + expandKeychainTemplate", () => {
  assert.deepEqual(S.keychainGeneratedKeys(VW), ["VW_ADMIN_TOKEN", "VW_PLAIN"]);
  assert.equal(S.expandKeychainTemplate("${VW_DOMAIN}/admin", { VW_DOMAIN: "http://h:1" }), "http://h:1/admin");
  assert.equal(S.expandKeychainTemplate("${VW_DOMAIN}/admin", { VW_DOMAIN: "" }), null, "a blank var drops the field");
  assert.equal(S.expandKeychainTemplate("${NOPE}", {}), null);
  assert.equal(S.expandKeychainTemplate("admin", {}), "admin");
  assert.equal(S.expandKeychainTemplate(undefined, {}), null);
});

test("bundle contract: store_as needs generate+keychain; keychain on a typed field needs secret", () => {
  const base = { id: "x", name: "x", description: "d", type: "bundle", category: "productivity", version: "1.0.0" };
  const errs = (env_vars) => validateManifest({ ...base, env_vars }, scratch("b-")).errors.join("\n");
  assert.match(errs([{ name: "A", store_as: "argon2id", generate: "secret" }]), /store_as.*keychain/);
  assert.match(errs([{ name: "A", store_as: "argon2id", keychain: true }]), /store_as.*generate/);
  assert.match(errs([{ name: "A", store_as: "bcrypt", generate: "secret", keychain: true }]), /store_as/);
  assert.match(errs([{ name: "A", keychain: true }]), /keychain.*secret/);
  assert.doesNotMatch(errs([{ name: "A", secret: true, generate: "secret", keychain: true, store_as: "argon2id" }]), /store_as|keychain/);
});
```

`validateManifest(manifest, bundleDir, opts)` (`scripts/lib/bundle-contract.mjs:130`) returns `{ ok, errors, warnings }`. An unknown `store_as` value fails at the ajv shape stage, with a message naming `/store_as`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/bundle-env-keychain-generate.test.js`
Expected: FAIL with `Cannot find module '…/keychain/argon2-phc.js'`.

- [ ] **Step 3: Create `servers/gateway/keychain/argon2-phc.js`**

```js
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
```

- [ ] **Step 4: Extend `servers/gateway/bundle-env-secrets.js`**

Add `import { argon2idPhc } from "./keychain/argon2-phc.js";` with the other imports. Update the header comment's first bullet list with:

```js
 *   env_vars[].keychain: true        → the minted plaintext is also returned to the caller
 *                                     (resolveGeneratedEnvDetailed().minted) for the keychain
 *   env_vars[].store_as: "argon2id"  → the .env and the retained copy hold an Argon2id PHC
 *                                     hash of it instead (Vaultwarden ADMIN_TOKEN)
```

Then replace the whole `resolveGeneratedEnv` function with:

```js
export function keychainGeneratedKeys(manifest) {
  return (manifest?.env_vars || [])
    .filter((v) => v && typeof v.name === "string" && GENERATE_KINDS.has(v.generate) && v.keychain === true)
    .map((v) => v.name);
}

/**
 * Mint or reuse every generated secret. Returns { env, minted }:
 *   env     the values to write into the bundle .env (a PHC hash for store_as:"argon2id")
 *   minted  plaintext of keychain:true keys created by THIS call (empty on reinstall)
 * Order per key: installed .env → retained copy → new value (never regenerated).
 */
export function resolveGeneratedEnvDetailed(bundleId, manifest, { destDir, crowHome }) {
  const keys = generatedEnvKeys(manifest);
  if (keys.length === 0) return { env: {}, minted: {} };
  if (typeof bundleId !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(bundleId) || bundleId.length > 64) {
    throw new Error(`Invalid bundle ID: ${JSON.stringify(bundleId)}`);
  }
  const byName = new Map((manifest.env_vars || []).map((v) => [v.name, v]));
  const installed = readEnvSafe(join(destDir, ".env"));
  const retainedPath = retainedEnvPath(crowHome, bundleId);
  const retained = readEnvSafe(retainedPath);
  const env = {};
  const minted = {};
  for (const k of keys) {
    const existing = installed[k] || retained[k];
    if (existing) { env[k] = existing; continue; }
    const plain = newSecretValue();
    const spec = byName.get(k) || {};
    env[k] = spec.store_as === "argon2id" ? argon2idPhc(plain) : plain;
    if (spec.keychain === true) minted[k] = plain;
  }
  const dir = dirname(retainedPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writePrivateFile(
    retainedPath,
    `# Crow-generated secrets for bundle '${bundleId}'. Kept across uninstall so a\n` +
      `# reinstall reuses them (the bundle's data still expects them). Do not edit.\n` +
      formatEnvLines({ ...retained, ...env }),
  );
  return { env, minted };
}

export function resolveGeneratedEnv(bundleId, manifest, opts) {
  return resolveGeneratedEnvDetailed(bundleId, manifest, opts).env;
}

/**
 * `keychain_username` / `keychain_url` templates: `${VAR}` from the install env.
 * Any referenced var that is unset or blank → null (the field is dropped, never half-filled).
 */
export function expandKeychainTemplate(template, env) {
  if (typeof template !== "string" || template === "") return null;
  let blank = false;
  const out = template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    const v = env && env[name];
    if (v === undefined || v === null || String(v) === "") { blank = true; return ""; }
    return String(v);
  });
  return blank ? null : out;
}
```

- [ ] **Step 5: Schema and contract rules**

`registry/manifest.schema.json`: in `env_vars.items.properties`, after `"generate": …`, add:

```json
          "keychain": { "type": "boolean" },
          "store_as": { "type": "string", "enum": ["argon2id"] },
          "keychain_label": { "type": "string" },
          "keychain_username": { "type": "string" },
          "keychain_url": { "type": "string" },
```

`scripts/lib/bundle-contract.mjs`: after the `docker.precreate` loop, add:

```js
  for (const v of (manifest && Array.isArray(manifest.env_vars)) ? manifest.env_vars : []) {
    if (!v || typeof v !== "object") continue;
    if (v.store_as !== undefined) {
      if (v.store_as !== "argon2id") errors.push(`env_vars ${v.name}: store_as must be "argon2id"`);
      if (v.generate !== "secret") errors.push(`env_vars ${v.name}: store_as needs generate: "secret"`);
      if (v.keychain !== true) errors.push(`env_vars ${v.name}: store_as needs keychain: true (or the plaintext is lost)`);
    }
    if (v.keychain === true && v.secret !== true && v.generate !== "secret") {
      errors.push(`env_vars ${v.name}: keychain needs secret: true or generate: "secret"`);
    }
  }
```

- [ ] **Step 6: Run the tests**

```bash
npm test -- tests/bundle-env-keychain-generate.test.js
npm test -- tests/bundle-env-secrets.test.js
node scripts/build-registry.mjs --check
```

Expected: all PASS / OK.

- [ ] **Step 7: Commit**

```bash
git add servers/gateway/keychain/argon2-phc.js tests/bundle-env-keychain-generate.test.js
git commit servers/gateway/keychain/argon2-phc.js tests/bundle-env-keychain-generate.test.js servers/gateway/bundle-env-secrets.js registry/manifest.schema.json scripts/lib/bundle-contract.mjs -m "feat(bundles): generate+keychain env vars — minted plaintext for the keychain, optional Argon2id PHC in .env"
git show --stat HEAD
```

---
### Task 3: The keychain store (`crow_keychain`), local-only by construction

**Files:**
- Create: `servers/gateway/keychain/schema.js` (the DDL, side-effect free, shared by init-db and the store)
- Create: `servers/gateway/keychain/store.js`
- Modify: `scripts/init-db.js` (one `initTable` call before the `PRAGMA user_version` stamp)
- Modify: `servers/sharing/instance-sync.js` (`LOCAL_ONLY_TABLES`, `assertLocalOnlyDisjoint`, `shouldSyncRow` refusal)
- Test: `tests/keychain-store.test.js`

**Interfaces:**
- Consumes: `sealSecret`, `openSecret` (`servers/sharing/secret-box.js`).
- Produces (all `async`, `db` = a `createDbClient()` handle, `identity` = `loadOrCreateIdentity()`):
  - `KEYCHAIN_TABLE = "crow_keychain"`, `FIRST_VIEW_MS = 1800000`
  - `ensureKeychainTable(db): Promise<void>`
  - `saveExtensionSecret(db, identity, { bundleId, envKey, label, username, url, secret, origin: "typed"|"generated", firstView: boolean, now?: Date }): Promise<{ id: number, created: boolean }>`
  - `addManualSecret(db, identity, { label, username, url, secret }): Promise<{ id: number }>`
  - `listEntries(db, { now?: Date } = {}): Promise<Entry[]>`, where `Entry = { id, kind, label, bundle_id, env_key, username, url, origin, status, created_at, updated_at, first_view_pending: boolean }` and no secret
  - `getEntry(db, id): Promise<Entry|null>`
  - `openEntrySecret(db, identity, id): Promise<string|null>`
  - `consumeFirstView(db, identity, id, { now?: Date } = {}): Promise<string|null>`
  - `deleteEntry(db, id): Promise<boolean>`
  - `markBundleRemoved(db, bundleId): Promise<number>`
  - `reactivateBundleEntries(db, bundleId, envKeys: string[]): Promise<number>`
  - `pendingFirstViews(db, { now?: Date } = {}): Promise<Entry[]>`
- From `instance-sync.js`: `LOCAL_ONLY_TABLES: readonly string[]`, `assertLocalOnlyDisjoint(synced: string[], localOnly: string[]): void` (throws).

- [ ] **Step 1: Write the failing test**

Create `tests/keychain-store.test.js`:

```js
/** Crow keychain store (Task 3). Scratch DB + fixed identity; never touches ~/.crow. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-kc-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const { createDbClient } = await import("../servers/db.js");
const K = await import("../servers/gateway/keychain/store.js");
const SYNC = await import("../servers/sharing/instance-sync.js");
const { emitOrQueue } = await import("../servers/shared/sync-emit.js");

const ID = { seed: Buffer.alloc(32, 9) };
const OTHER = { seed: Buffer.alloc(32, 8) };
const freshDb = () => createDbClient(join(mkdtempSync(join(tmpdir(), "crow-kc-db-")), "crow.db"));

test("save → list carries metadata only; open returns the plaintext; the column holds ciphertext", async () => {
  const db = freshDb();
  const { id, created } = await K.saveExtensionSecret(db, ID, { bundleId: "workspace", envKey: "WORKSPACE_ADMIN_PASSWORD", label: "Crow Workspace — admin password", username: "admin", url: null, secret: "p a$s'w\"d", origin: "typed", firstView: false });
  assert.equal(created, true);
  const [e] = await K.listEntries(db);
  assert.equal(e.id, id);
  assert.equal(e.kind, "extension");
  assert.equal(e.status, "active");
  assert.equal(e.username, "admin");
  assert.ok(!JSON.stringify(e).includes("p a$s"), "list never carries the secret");
  assert.equal(await K.openEntrySecret(db, ID, id), "p a$s'w\"d");
  const raw = (await db.execute({ sql: "SELECT secret_sealed FROM crow_keychain WHERE id = ?", args: [id] })).rows[0].secret_sealed;
  assert.match(raw, /^enc:v1:/);
  await assert.rejects(K.openEntrySecret(db, OTHER, id), "a different identity cannot open it");
});

test("a second save for the same bundle+key updates in place (no duplicates)", async () => {
  const db = freshDb();
  const a = await K.saveExtensionSecret(db, ID, { bundleId: "b", envKey: "K", label: "L", secret: "one", origin: "typed" });
  const b = await K.saveExtensionSecret(db, ID, { bundleId: "b", envKey: "K", label: "L2", secret: "two", origin: "typed" });
  assert.equal(b.id, a.id);
  assert.equal(b.created, false);
  assert.equal((await K.listEntries(db)).length, 1);
  assert.equal(await K.openEntrySecret(db, ID, a.id), "two");
});

test("manual entries; delete; uninstall marks extension entries and a later save reactivates them", async () => {
  const db = freshDb();
  const m = await K.addManualSecret(db, ID, { label: "Phone app password", username: "kevin", url: "https://ws.example:8456", secret: "abcd-efgh" });
  const x = await K.saveExtensionSecret(db, ID, { bundleId: "vaultwarden", envKey: "VAULTWARDEN_ADMIN_TOKEN", label: "Vaultwarden — admin token", secret: "t", origin: "generated" });
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
  const t0 = new Date("2026-10-03T12:00:00Z");
  const { id } = await K.saveExtensionSecret(db, ID, { bundleId: "vaultwarden", envKey: "VAULTWARDEN_ADMIN_TOKEN", label: "L", secret: "tok", origin: "generated", firstView: true, now: t0 });
  assert.equal((await K.pendingFirstViews(db, { now: t0 })).length, 1);
  assert.equal(await K.consumeFirstView(db, ID, id, { now: new Date(t0.getTime() + 60_000) }), "tok");
  assert.equal(await K.consumeFirstView(db, ID, id, { now: new Date(t0.getTime() + 61_000) }), null, "second look refused");
  assert.equal((await K.pendingFirstViews(db, { now: t0 })).length, 0);

  const late = await K.saveExtensionSecret(db, ID, { bundleId: "x", envKey: "Y", label: "L", secret: "tok2", origin: "generated", firstView: true, now: t0 });
  assert.equal(await K.consumeFirstView(db, ID, late.id, { now: new Date(t0.getTime() + K.FIRST_VIEW_MS + 1) }), null, "expired after 30 min");
  assert.equal((await K.listEntries(db, { now: t0 })).find((e) => e.id === late.id).first_view_pending, true);
});

test("init-db creates crow_keychain with the same columns as the store's lazy ensure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-kc-initdb-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe" });
  const a = new Database(join(dir, "crow.db"), { readonly: true });
  const fromInit = a.prepare("PRAGMA table_info(crow_keychain)").all().map((c) => c.name);
  a.close();
  const db = freshDb();
  await K.ensureKeychainTable(db);
  const fromLazy = (await db.execute("PRAGMA table_info(crow_keychain)")).rows.map((c) => c.name);
  assert.deepEqual(fromInit, fromLazy);
  assert.ok(fromInit.includes("secret_sealed") && fromInit.includes("first_view_until"));
});

test("REVIEW FOCUS 3 — crow_keychain can never replicate", async () => {
  assert.ok(SYNC.LOCAL_ONLY_TABLES.includes("crow_keychain"));
  assert.ok(!SYNC.SYNCED_TABLES.includes("crow_keychain"));
  assert.throws(() => SYNC.assertLocalOnlyDisjoint(["memories", "crow_keychain"], SYNC.LOCAL_ONLY_TABLES), /local-only/);
  assert.equal(SYNC.shouldSyncRowForTest("crow_keychain", { id: 1 }), false);

  // Outbound doors: live emit and the stdio queue.
  const row = { id: 1, secret_sealed: "enc:v1:x" };
  assert.equal(await SYNC.InstanceSyncManager.prototype.emitChange.call({ feedsDisabled: false }, "crow_keychain", "insert", row), null);
  const db = freshDb();
  assert.equal(await emitOrQueue(null, db, "crow_keychain", "insert", row), null);
  const outbox = await db.execute("SELECT name FROM sqlite_master WHERE name = 'sync_outbox'");
  assert.equal(outbox.rows.length, 0, "nothing was even queued");

  // Inbound door: a peer claiming a crow_keychain row is dropped before any write.
  const writes = [];
  const fakeThis = { db: { execute: async (q) => { writes.push(q); return { rows: [] }; } } };
  await SYNC.InstanceSyncManager.prototype._applyEntry.call(fakeThis, "peer", { table: "crow_keychain", op: "insert", row, lamport_ts: 1, instance_id: "peer" });
  assert.equal(writes.length, 0);

  // Static: no source file hands crow_keychain to a sync emitter.
  const offenders = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (n === "node_modules") continue; if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".js") && /emit(OrQueue|Change)\([^)]*crow_keychain/.test(readFileSync(p, "utf8"))) offenders.push(p); } };
  walk("servers");
  assert.deepEqual(offenders, []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/keychain-store.test.js`
Expected: FAIL with `Cannot find module '…/keychain/store.js'`.

- [ ] **Step 3: Create `servers/gateway/keychain/schema.js`**

```js
/**
 * crow_keychain DDL — side-effect free; imported by scripts/init-db.js (fresh installs)
 * and by keychain/store.js ensureKeychainTable (existing installs). Additive: no
 * SCHEMA_GENERATION bump. LOCAL-ONLY: listed in instance-sync LOCAL_ONLY_TABLES.
 */
export const KEYCHAIN_DDL = `
  CREATE TABLE IF NOT EXISTS crow_keychain (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    kind             TEXT NOT NULL CHECK (kind IN ('extension', 'manual')),
    label            TEXT NOT NULL,
    bundle_id        TEXT,
    env_key          TEXT,
    username         TEXT,
    url              TEXT,
    secret_sealed    TEXT NOT NULL,
    origin           TEXT NOT NULL CHECK (origin IN ('typed', 'generated', 'manual')),
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'extension_removed')),
    first_view_until TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_crow_keychain_ext
    ON crow_keychain (bundle_id, env_key) WHERE kind = 'extension';
`;
```

- [ ] **Step 4: Create `servers/gateway/keychain/store.js`**

```js
/**
 * Crow keychain — human-facing passwords, sealed with secret-box, LOCAL ONLY.
 * Never synced (instance-sync LOCAL_ONLY_TABLES). Secrets leave this module only
 * through openEntrySecret / consumeFirstView, whose callers gate and audit them.
 */
import { sealSecret, openSecret } from "../../sharing/secret-box.js";
import { KEYCHAIN_DDL } from "./schema.js";

export const KEYCHAIN_TABLE = "crow_keychain";
export const FIRST_VIEW_MS = 30 * 60 * 1000;

const META_COLS = "id, kind, label, bundle_id, env_key, username, url, origin, status, created_at, updated_at, first_view_until";
const iso = (d) => (d instanceof Date ? d : new Date()).toISOString();
const cleanText = (v, max = 512) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).slice(0, max));

const ensured = new WeakSet();
export async function ensureKeychainTable(db) {
  if (ensured.has(db)) return;
  await db.executeMultiple(KEYCHAIN_DDL);
  ensured.add(db);
}

function toEntry(r, now) {
  if (!r) return null;
  const { first_view_until: fvu, ...rest } = r;
  return { ...rest, id: Number(r.id), first_view_pending: !!fvu && fvu > iso(now) };
}

export async function saveExtensionSecret(db, identity, { bundleId, envKey, label, username = null, url = null, secret, origin, firstView = false, now }) {
  await ensureKeychainTable(db);
  if (!bundleId || !envKey || typeof secret !== "string" || secret === "") throw new Error("keychain: bundleId, envKey and a secret are required");
  const sealed = sealSecret(secret, identity);
  const ts = iso(now);
  const fvu = firstView ? new Date((now || new Date()).getTime() + FIRST_VIEW_MS).toISOString() : null;
  const existing = (await db.execute({ sql: "SELECT id FROM crow_keychain WHERE kind = 'extension' AND bundle_id = ? AND env_key = ?", args: [bundleId, envKey] })).rows[0];
  if (existing) {
    await db.execute({
      sql: "UPDATE crow_keychain SET label = ?, username = ?, url = ?, secret_sealed = ?, origin = ?, status = 'active', first_view_until = ?, updated_at = ? WHERE id = ?",
      args: [cleanText(label) || envKey, cleanText(username), cleanText(url, 2048), sealed, origin, fvu, ts, existing.id],
    });
    return { id: Number(existing.id), created: false };
  }
  const r = await db.execute({
    sql: "INSERT INTO crow_keychain (kind, label, bundle_id, env_key, username, url, secret_sealed, origin, first_view_until, created_at, updated_at) VALUES ('extension', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [cleanText(label) || envKey, bundleId, envKey, cleanText(username), cleanText(url, 2048), sealed, origin, fvu, ts, ts],
  });
  return { id: Number(r.lastInsertRowid), created: true };
}

export async function addManualSecret(db, identity, { label, username = null, url = null, secret }) {
  await ensureKeychainTable(db);
  if (!cleanText(label) || typeof secret !== "string" || secret === "") throw new Error("keychain: a label and a secret are required");
  const ts = iso();
  const r = await db.execute({
    sql: "INSERT INTO crow_keychain (kind, label, username, url, secret_sealed, origin, created_at, updated_at) VALUES ('manual', ?, ?, ?, ?, 'manual', ?, ?)",
    args: [cleanText(label), cleanText(username), cleanText(url, 2048), sealSecret(secret, identity), ts, ts],
  });
  return { id: Number(r.lastInsertRowid) };
}

export async function listEntries(db, { now } = {}) {
  await ensureKeychainTable(db);
  const { rows } = await db.execute(`SELECT ${META_COLS} FROM crow_keychain ORDER BY status ASC, label COLLATE NOCASE ASC, id ASC`);
  return rows.map((r) => toEntry(r, now));
}

export async function getEntry(db, id, { now } = {}) {
  await ensureKeychainTable(db);
  const { rows } = await db.execute({ sql: `SELECT ${META_COLS} FROM crow_keychain WHERE id = ?`, args: [Number(id)] });
  return toEntry(rows[0], now);
}

export async function pendingFirstViews(db, { now } = {}) {
  await ensureKeychainTable(db);
  const { rows } = await db.execute({ sql: `SELECT ${META_COLS} FROM crow_keychain WHERE first_view_until IS NOT NULL AND first_view_until > ? ORDER BY id`, args: [iso(now)] });
  return rows.map((r) => toEntry(r, now));
}

/** Plaintext, or null when the id does not exist. Throws on a tampered/foreign blob. */
export async function openEntrySecret(db, identity, id) {
  await ensureKeychainTable(db);
  const { rows } = await db.execute({ sql: "SELECT secret_sealed FROM crow_keychain WHERE id = ?", args: [Number(id)] });
  if (!rows[0]) return null;
  return openSecret(rows[0].secret_sealed, identity);
}

/** Atomically spends a live first-view grant. Plaintext once, then null forever. */
export async function consumeFirstView(db, identity, id, { now } = {}) {
  await ensureKeychainTable(db);
  const { rows } = await db.execute({
    sql: "UPDATE crow_keychain SET first_view_until = NULL WHERE id = ? AND first_view_until IS NOT NULL AND first_view_until > ? RETURNING secret_sealed",
    args: [Number(id), iso(now)],
  });
  if (!rows[0]) return null;
  return openSecret(rows[0].secret_sealed, identity);
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
```

- [ ] **Step 5: init-db table**

In `scripts/init-db.js`, add next to the other imports:

```js
import { KEYCHAIN_DDL } from "../servers/gateway/keychain/schema.js";
```

Immediately before `// Stamp the schema generation so the gateway boot gate…`, add:

```js
// --- Crow keychain (2026-10-03) ---
// Human-facing passwords, sealed with secret-box. LOCAL ONLY: listed in
// instance-sync LOCAL_ONLY_TABLES and never in SYNCED_TABLES. Additive: the store
// also CREATE-IF-NOT-EXISTS this lazily (keychain/store.js ensureKeychainTable), so
// existing installs need no SCHEMA_GENERATION bump.
await initTable("crow_keychain table", KEYCHAIN_DDL);
```

- [ ] **Step 6: Local-only guard in `servers/sharing/instance-sync.js`**

Directly after the closing `];` of `export const SYNCED_TABLES = [ … ];`, add:

```js
// Tables that must NEVER leave this machine (Crow keychain: human passwords).
// secret-box keys derive from the identity seed, so a same-identity peer COULD open
// the ciphertext — locality rests on never replicating these rows. Checked at load.
export const LOCAL_ONLY_TABLES = Object.freeze(["crow_keychain"]);
export function assertLocalOnlyDisjoint(synced, localOnly) {
  for (const t of localOnly) {
    if (synced.includes(t)) throw new Error(`instance-sync: table ${t} is local-only and must never be in SYNCED_TABLES`);
  }
}
assertLocalOnlyDisjoint(SYNCED_TABLES, LOCAL_ONLY_TABLES);
```

Make the first statement of `shouldSyncRow(table, row)`:

```js
  if (LOCAL_ONLY_TABLES.includes(table)) return false;
```

- [ ] **Step 7: Run the tests**

```bash
npm test -- tests/keychain-store.test.js
npm test -- tests/migration-guard.test.js
npm test -- tests/schema-version-gate.test.js
```

Expected: all PASS. `migration-guard` stays green because this is a new table, with no DROP/DELETE expectation.

- [ ] **Step 8: Commit**

```bash
git add servers/gateway/keychain/schema.js servers/gateway/keychain/store.js tests/keychain-store.test.js
git commit servers/gateway/keychain/schema.js servers/gateway/keychain/store.js tests/keychain-store.test.js scripts/init-db.js servers/sharing/instance-sync.js -m "feat(keychain): local-only sealed crow_keychain store; LOCAL_ONLY_TABLES guard on every sync door"
git show --stat HEAD
```

---
### Task 4: Re-auth gate and the keychain JSON API

**Files:**
- Create: `servers/gateway/keychain/reauth.js`
- Create: `servers/gateway/keychain/api.js`
- Modify: `servers/gateway/dashboard/index.js` (import + mount right after `router.use("/dashboard", csrfMiddleware);`, ~:621)
- Test: `tests/keychain-api.test.js`

**Interfaces:**
- Consumes: the Task 3 store functions; `auditLog` (`servers/db.js`); `verifyPassword` (`dashboard/auth.js`); `is2faEnabled`, `getTotpSecret`, `verifyTotp` (`dashboard/totp.js`); `loadOrCreateIdentity` (`sharing/identity.js`).
- Consumes from Task 5 (stubbed in this task's tests, injected): `vaultwardenStatus(): { installed, cliPath, serverUrl }` and `saveToVault(opts): Promise<{ ok, reason? }>`. Until Task 5 lands, `api.js` imports them from `./vault-save.js`. **Do Task 5 Step 3 (create `vault-save.js`) before running this task's Step 4 if executing out of order.** In order, Task 4 creates a two-function placeholder module that Task 5 replaces in full:

```js
// servers/gateway/keychain/vault-save.js — replaced wholesale in Task 5.
export function vaultwardenStatus() { return { installed: false, cliPath: null, serverUrl: null }; }
export async function saveToVault() { return { ok: false, reason: "Saving to Vaultwarden is not available yet." }; }
```

- Produces:
  - `createReauthGate({ now?, ttlMs?=300000, maxFailures?=5, lockMs?=900000, is2faEnabled, verifyTotpCode, verifyDashboardPassword })`. It returns `{ method(): Promise<"totp"|"password">, verify(sessionToken, { password?, totp_code? }): Promise<{ ok: true, method, expires_at } | { ok: false, locked?: true, locked_until?: number, error: string }>, isGranted(token): boolean, expiresAt(token): number|null, revoke(token): void }`.
  - `keychainApiRouter({ openDb?, identity?, gate?, vault?, audit? } = {}): express.Router` serving `/dashboard/keychain/api/*` (routes in spec §5.4).

- [ ] **Step 1: Write the failing test**

Create `tests/keychain-api.test.js`:

```js
/** Re-auth gate + keychain API (Task 4). Express on 127.0.0.1:0, scratch DB, stub verifiers. */
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
const K = await import("../servers/gateway/keychain/store.js");

const ID = { seed: Buffer.alloc(32, 3) };
const AUDIT_DDL = "CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, actor TEXT, ip_address TEXT, details TEXT, created_at TEXT DEFAULT (datetime('now')))";

async function setup({ twoFa = false, clock = { t: Date.parse("2026-10-03T12:00:00Z") }, vault } = {}) {
  const dbPath = join(mkdtempSync(join(tmpdir(), "crow-kcapi-db-")), "crow.db");
  const seedDb = createDbClient(dbPath);
  await seedDb.execute(AUDIT_DDL);
  const gate = createReauthGate({
    now: () => clock.t,
    is2faEnabled: async () => twoFa,
    verifyTotpCode: async (c) => c === "123456",
    verifyDashboardPassword: async (p) => p === "right-password",
  });
  const vaultCalls = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.dashboardSession = req.headers["x-test-session"] || null; next(); });
  app.use(keychainApiRouter({
    openDb: () => createDbClient(dbPath),
    identity: () => ID,
    gate,
    vault: vault || { status: () => ({ installed: true, cliPath: "/x/bw.js", serverUrl: "http://127.0.0.1:18097" }), save: async (o) => { vaultCalls.push(o); return { ok: true }; } },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/dashboard/keychain/api`;
  const call = (path, { session = "S1", body, method = body ? "POST" : "GET", headers = {} } = {}) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...(session ? { "x-test-session": session } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json(), cache: r.headers.get("cache-control") }));
  const audits = async () => (await seedDb.execute("SELECT event_type, details FROM audit_log ORDER BY id")).rows;
  return { db: seedDb, call, audits, clock, vaultCalls, close: () => server.close() };
}

test("entries list never carries a secret; reveal without a grant is 403 reauth_required", async () => {
  const s = await setup();
  try {
    const { id } = await K.saveExtensionSecret(s.db, ID, { bundleId: "workspace", envKey: "WORKSPACE_ADMIN_PASSWORD", label: "Workspace admin", secret: "s3cr3t-value", origin: "typed" });
    const list = await s.call("/entries");
    assert.equal(list.status, 200);
    assert.equal(list.body.entries[0].id, id);
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
    const { id } = await K.saveExtensionSecret(s.db, ID, { bundleId: "workspace", envKey: "WORKSPACE_ADMIN_PASSWORD", label: "Workspace admin", secret: "s3cr3t-value", origin: "typed" });
    assert.equal((await s.call("/reauth", { body: { password: "right-password" } })).status, 200);
    const r = await s.call("/reveal", { body: { id, purpose: "reveal" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.secret, "s3cr3t-value");
    assert.equal(r.cache, "no-store");
    assert.equal((await s.call("/reveal", { body: { id, purpose: "copy" } })).body.secret, "s3cr3t-value");
    const ev = await s.audits();
    assert.deepEqual(ev.map((e) => e.event_type), ["keychain_reauth_ok", "keychain_reveal", "keychain_copy"]);
    assert.ok(!JSON.stringify(ev).includes("s3cr3t-value"), "audit details never hold the value");
    assert.equal(JSON.parse(ev[1].details).env_key, "WORKSPACE_ADMIN_PASSWORD");
  } finally { s.close(); }
});

test("REVIEW FOCUS 4 — grants are per session, expire at 5 min, lock after 5 failures", async () => {
  const s = await setup();
  try {
    const { id } = await K.addManualSecret(s.db, ID, { label: "Phone", secret: "app-pass" });
    await s.call("/reauth", { session: "S1", body: { password: "right-password" } });
    assert.equal((await s.call("/reveal", { session: "S2", body: { id } })).status, 403, "another session's grant does not count");
    assert.equal((await s.call("/reveal", { session: "S1", body: { id } })).status, 200);
    s.clock.t += 5 * 60 * 1000 + 1;
    assert.equal((await s.call("/reveal", { session: "S1", body: { id } })).status, 403, "expired after 5 minutes");

    for (let i = 0; i < 5; i++) assert.equal((await s.call("/reauth", { session: "S3", body: { password: "wrong" } })).status, 401);
    const locked = await s.call("/reauth", { session: "S3", body: { password: "right-password" } });
    assert.equal(locked.status, 429, "the right password is refused while locked");
    assert.ok(locked.body.locked_until > s.clock.t);
    s.clock.t += 15 * 60 * 1000 + 1;
    assert.equal((await s.call("/reauth", { session: "S3", body: { password: "right-password" } })).status, 200, "lock lifts after 15 minutes");
    const failed = (await s.audits()).filter((e) => e.event_type === "keychain_reauth_failed").length;
    assert.equal(failed, 5);
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

test("REVIEW FOCUS 2 (API) — first-view works once without re-auth, then 410", async () => {
  const s = await setup();
  try {
    const { id } = await K.saveExtensionSecret(s.db, ID, { bundleId: "vaultwarden", envKey: "VAULTWARDEN_ADMIN_TOKEN", label: "Vaultwarden admin token", secret: "tok-1", origin: "generated", firstView: true });
    const one = await s.call("/first-view", { body: { id } });
    assert.equal(one.status, 200);
    assert.equal(one.body.secret, "tok-1");
    const two = await s.call("/first-view", { body: { id } });
    assert.equal(two.status, 410);
    assert.equal(two.body.code, "first_view_spent");
    assert.deepEqual((await s.audits()).map((e) => e.event_type), ["keychain_first_view"]);
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
    assert.equal((await s.call("/entries")).body.entries.length, 0);
    assert.deepEqual((await s.audits()).map((e) => e.event_type), ["keychain_add", "keychain_reauth_ok", "keychain_delete"]);
    assert.equal((await s.call("/add", { body: { label: "", secret: "x" } })).status, 400);
    assert.equal((await s.call("/add", { body: { label: "x", secret: "" } })).status, 400);
  } finally { s.close(); }
});

test("vault-save: grant required, credentials passed through once, never audited", async () => {
  const s = await setup();
  try {
    const { id } = await K.addManualSecret(s.db, ID, { label: "Phone", username: "kevin", secret: "app-pass" });
    assert.equal((await s.call("/vault-save", { body: { id, vault_email: "k@example.invalid", vault_password: "Master-PW" } })).status, 403);
    await s.call("/reauth", { body: { password: "right-password" } });
    const r = await s.call("/vault-save", { body: { id, vault_email: "k@example.invalid", vault_password: "Master-PW" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(s.vaultCalls.length, 1);
    assert.equal(s.vaultCalls[0].masterPassword, "Master-PW");
    assert.equal(s.vaultCalls[0].item.password, "app-pass");
    const ev = JSON.stringify(await s.audits());
    assert.ok(!ev.includes("Master-PW") && !ev.includes("app-pass"));
    assert.match(ev, /keychain_vault_save/);
  } finally { s.close(); }
});

test("peer-signed and session-less requests are refused", async () => {
  const s = await setup();
  try {
    assert.equal((await s.call("/entries", { headers: { "x-crow-signature": "abc" } })).status, 403);
    assert.equal((await s.call("/entries", { session: null })).status, 401);
  } finally { s.close(); }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/keychain-api.test.js`
Expected: FAIL with `Cannot find module '…/keychain/reauth.js'`.

- [ ] **Step 3: Create `servers/gateway/keychain/reauth.js`**

```js
/**
 * Fresh re-auth for keychain reveal/copy/delete/vault-save (spec §5.4, R6).
 * Per dashboard session (sha256 of the session token), in memory: a 5-minute grant;
 * 5 consecutive failures lock re-auth for that session for 15 minutes. A gateway
 * restart forgets everything, which only means "ask again".
 * With dashboard 2FA on, ONLY a TOTP code counts; otherwise the dashboard password.
 */
import { createHash } from "node:crypto";

export function createReauthGate({
  now = () => Date.now(),
  ttlMs = 5 * 60 * 1000,
  maxFailures = 5,
  lockMs = 15 * 60 * 1000,
  is2faEnabled,
  verifyTotpCode,
  verifyDashboardPassword,
}) {
  const grants = new Map();   // key → expiresAt (ms)
  const failures = new Map(); // key → { count, lockedUntil }
  const keyOf = (token) => createHash("sha256").update(String(token)).digest("hex");

  async function method() {
    return (await is2faEnabled()) ? "totp" : "password";
  }

  async function verify(token, { password, totp_code } = {}) {
    if (!token) return { ok: false, error: "No dashboard session." };
    const k = keyOf(token);
    const t = now();
    const f = failures.get(k);
    if (f && f.lockedUntil > t) {
      return { ok: false, locked: true, locked_until: f.lockedUntil, error: "Too many wrong attempts. Try again later." };
    }
    const m = await method();
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
      return { ok: false, method: m, error: m === "totp" ? "That code is not valid." : "That password is not correct." };
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
```

- [ ] **Step 4: Create the Task 5 placeholder `servers/gateway/keychain/vault-save.js`** (the two-function module shown in **Interfaces** above; Task 5 replaces it), then create `servers/gateway/keychain/api.js`:

```js
/**
 * /dashboard/keychain/api/* — the only door through which keychain plaintext reaches a
 * browser. Mounted after dashboardAuth + csrfMiddleware (dashboard/index.js), so every
 * request is a signed-in dashboard session with a valid CSRF echo; peer-signed requests
 * are refused here. Plaintext is returned only by /reveal (re-auth grant) and
 * /first-view (one-time grant), always with Cache-Control: no-store, and is never logged.
 */
import { Router } from "express";
import { createDbClient, auditLog } from "../../db.js";
import { loadOrCreateIdentity } from "../../sharing/identity.js";
import { verifyPassword } from "../dashboard/auth.js";
import { is2faEnabled, getTotpSecret, verifyTotp } from "../dashboard/totp.js";
import { createReauthGate } from "./reauth.js";
import {
  listEntries, getEntry, openEntrySecret, consumeFirstView, addManualSecret, deleteEntry,
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

export function keychainApiRouter({
  openDb = () => createDbClient(),
  identity = () => loadOrCreateIdentity(),
  gate = defaultReauthGate(),
  vault = { status: vaultwardenStatus, save: saveToVault },
  audit = auditLog,
} = {}) {
  const router = Router();

  router.use(BASE, (req, res, next) => {
    if (req.headers["x-crow-signature"]) return res.status(403).json({ error: "The keychain is not available to paired instances." });
    if (!req.dashboardSession) return res.status(401).json({ error: "Sign in first." });
    res.set("Cache-Control", "no-store");
    next();
  });

  const withDb = (handler) => async (req, res) => {
    const db = openDb();
    try {
      await handler(req, res, db);
    } catch (err) {
      console.error("[keychain] request failed:", err?.code || err?.name || "error");
      if (!res.headersSent) res.status(500).json({ error: "Keychain error. Nothing was revealed." });
    } finally {
      try { db.close(); } catch {}
    }
  };

  const requireGrant = (req, res) => {
    if (gate.isGranted(req.dashboardSession)) return true;
    res.status(403).json({ code: "reauth_required", error: "Confirm it's you first." });
    return false;
  };

  router.get(`${BASE}/entries`, withDb(async (req, res, db) => {
    const st = vault.status();
    res.json({
      entries: await listEntries(db),
      reauth_method: await gate.method(),
      granted_until: gate.expiresAt(req.dashboardSession),
      vault_available: !!(st && st.installed && st.cliPath),
    });
  }));

  router.post(`${BASE}/reauth`, withDb(async (req, res, db) => {
    const out = await gate.verify(req.dashboardSession, { password: req.body?.password, totp_code: req.body?.totp_code });
    if (out.ok) {
      await audit(db, "keychain_reauth_ok", { ip: req.ip, details: { method: out.method } });
      return res.json({ ok: true, method: out.method, expires_at: out.expires_at });
    }
    if (out.locked) return res.status(429).json({ error: out.error, locked_until: out.locked_until });
    await audit(db, "keychain_reauth_failed", { ip: req.ip, details: { method: out.method || null } });
    return res.status(401).json({ error: out.error });
  }));

  router.post(`${BASE}/reveal`, withDb(async (req, res, db) => {
    if (!requireGrant(req, res)) return;
    const purpose = req.body?.purpose === "copy" ? "copy" : "reveal";
    const entry = await getEntry(db, Number(req.body?.id));
    if (!entry) return res.status(404).json({ error: "No such password." });
    const secret = await openEntrySecret(db, identity(), entry.id);
    await audit(db, purpose === "copy" ? "keychain_copy" : "keychain_reveal", { ip: req.ip, details: auditDetails(entry) });
    res.json({ secret });
  }));

  router.post(`${BASE}/first-view`, withDb(async (req, res, db) => {
    const entry = await getEntry(db, Number(req.body?.id));
    if (!entry) return res.status(404).json({ error: "No such password." });
    const secret = await consumeFirstView(db, identity(), entry.id);
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
    const { id } = await addManualSecret(db, identity(), { label, username, url, secret });
    await audit(db, "keychain_add", { ip: req.ip, details: { entry_id: id, label } });
    res.json({ ok: true, id });
  }));

  router.post(`${BASE}/delete`, withDb(async (req, res, db) => {
    if (!requireGrant(req, res)) return;
    const entry = await getEntry(db, Number(req.body?.id));
    if (!entry) return res.status(404).json({ error: "No such password." });
    await deleteEntry(db, entry.id);
    await audit(db, "keychain_delete", { ip: req.ip, details: auditDetails(entry) });
    res.json({ ok: true });
  }));

  router.post(`${BASE}/vault-save`, withDb(async (req, res, db) => {
    if (!requireGrant(req, res)) return;
    const st = vault.status();
    if (!st || !st.installed || !st.cliPath) return res.status(409).json({ ok: false, reason: "Install or update the Vaultwarden extension first." });
    const email = str(req.body?.vault_email?.trim?.(), 320);
    const masterPassword = str(req.body?.vault_password, 1024);
    if (!email || !masterPassword) return res.status(400).json({ ok: false, reason: "Enter your vault email and master password." });
    const entry = await getEntry(db, Number(req.body?.id));
    if (!entry) return res.status(404).json({ ok: false, reason: "No such password." });
    const secret = await openEntrySecret(db, identity(), entry.id);
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
```

- [ ] **Step 5: Mount it**

In `servers/gateway/dashboard/index.js`, add with the other imports:

```js
import { keychainApiRouter } from "../keychain/api.js";
```

Directly after `router.use("/dashboard", csrfMiddleware);` (~:621), add:

```js
  // Crow keychain API (Settings → Passwords + the Extensions first-view banner).
  // Session-authed + CSRF-protected by the two middlewares above; the router itself
  // refuses peer-signed requests and serves every response no-store.
  router.use(keychainApiRouter());
```

- [ ] **Step 6: Run the tests**

```bash
npm test -- tests/keychain-api.test.js
npm test -- tests/auth-network.test.js
```

Expected: PASS. `auth-network` must stay green, because no Funnel prefix changed.

- [ ] **Step 7: Commit**

```bash
git add servers/gateway/keychain/reauth.js servers/gateway/keychain/api.js servers/gateway/keychain/vault-save.js tests/keychain-api.test.js
git commit servers/gateway/keychain/reauth.js servers/gateway/keychain/api.js servers/gateway/keychain/vault-save.js tests/keychain-api.test.js servers/gateway/dashboard/index.js -m "feat(keychain): re-auth gate (TOTP or password, 5 min, lockout) and the audited keychain API"
git show --stat HEAD
```

---
### Task 5: Save to the user's Vaultwarden vault with the Bitwarden CLI

**Files:**
- Modify (replace the Task 4 placeholder entirely): `servers/gateway/keychain/vault-save.js`
- Modify: `bundles/vaultwarden/package.json` (+ regenerate `bundles/vaultwarden/package-lock.json`)
- Test: `tests/keychain-vault-save.test.js`

**Interfaces:**
- Consumes: `BUNDLES_DIR` (`servers/gateway/bundles-config.js`), `parseEnvText` (Task 1).
- Produces:
  - `vaultwardenStatus({ bundlesDir?: string } = {}): { installed: boolean, cliPath: string|null, serverUrl: string|null }`
  - `saveToVault({ cliPath, serverUrl, email, masterPassword, item: { name, username?, password, url?, notes? }, timeoutMs?=60000, tmpRoot?=os.tmpdir(), nodePath?=process.execPath }): Promise<{ ok: true } | { ok: false, reason: string }>` (never throws)
  - `VAULT_REASONS`: the fixed sentences used for `reason`.

- [ ] **Step 1: Write the failing test** (a fake `bw` written as a Node script)

Create `tests/keychain-vault-save.test.js`:

```js
/** Bitwarden-CLI vault save against a FAKE bw (Task 5). No network, no real vault. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
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
const BASE = { serverUrl: "http://127.0.0.1:18097", email: "k@example.invalid", masterPassword: "Master-PW-1", item: ITEM };

test("happy path: config server → login (password via env) → create item (stdin) → logout", async () => {
  const f = fakeCli("ok");
  const out = await V.saveToVault({ ...BASE, cliPath: f.cliPath, tmpRoot: f.tmpRoot });
  assert.deepEqual(out, { ok: true });
  const c = f.calls();
  assert.deepEqual(c.map((x) => x.args[0]), ["config", "login", "create", "logout"]);
  assert.deepEqual(c[0].args, ["config", "server", "http://127.0.0.1:18097"]);
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

test("a hung CLI is killed at the timeout and reported", async () => {
  const f = fakeCli("hang");
  const t0 = Date.now();
  const out = await V.saveToVault({ ...BASE, cliPath: f.cliPath, tmpRoot: f.tmpRoot, timeoutMs: 800 });
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
  assert.deepEqual(V.vaultwardenStatus({ bundlesDir: bundles }), { installed: false, cliPath: null, serverUrl: null });
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/keychain-vault-save.test.js`
Expected: FAIL. The Task 4 placeholder has no real `saveToVault` behavior, so the first assertion (`deepEqual {ok:true}`) fails.

- [ ] **Step 3: Replace `servers/gateway/keychain/vault-save.js`**

```js
/**
 * Save one login item into the user's own local Vaultwarden with the official Bitwarden
 * CLI (@bitwarden/cli, a dependency of the vaultwarden bundle — installed beside it).
 *
 * Secrets: the master password travels ONLY in the login step's env (--passwordenv);
 * the item JSON travels on stdin (base64, `create item` reads it when no arg is given);
 * the session key travels in BW_SESSION. The vault email IS a `login` argument (bw has
 * no env/stdin form for it; spec R11). Every step runs with a minimal env inside a
 * private mkdtemp dir (BITWARDENCLI_APPDATA_DIR = HOME = that dir), removed in finally.
 * Failures come back as fixed sentences; CLI output is never echoed.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLES_DIR } from "../bundles-config.js";
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

export function vaultwardenStatus({ bundlesDir = BUNDLES_DIR } = {}) {
  const dir = join(bundlesDir, "vaultwarden");
  if (!existsSync(dir)) return { installed: false, cliPath: null, serverUrl: null };
  const cli = join(dir, "node_modules", "@bitwarden", "cli", "build", "bw.js");
  let url = "http://localhost:8097";
  try { url = parseEnvText(readFileSync(join(dir, ".env"), "utf8")).VAULTWARDEN_URL || url; } catch { /* default */ }
  return { installed: true, cliPath: existsSync(cli) ? cli : null, serverUrl: url.replace(/\/+$/, "") };
}

function runStep({ nodePath, cliPath, args, env, stdin = "", timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(nodePath, [cliPath, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return resolve({ code: -1, stdout: "", stderr: "", spawnError: true });
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => { if (stdout.length < 65536) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < 65536) stderr += d; });
    child.on("error", () => { clearTimeout(timer); resolve({ code: -1, stdout, stderr, spawnError: true }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

function classifyLogin(stderr) {
  if (/two[- ]?step|two[- ]?factor|2fa/i.test(stderr)) return VAULT_REASONS.twoStep;
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|connect|getaddrinfo|socket hang up/i.test(stderr)) return VAULT_REASONS.unreachable;
  if (/password|credential|incorrect|invalid|username/i.test(stderr)) return VAULT_REASONS.wrongCredentials;
  return VAULT_REASONS.failed;
}

export async function saveToVault({ cliPath, serverUrl, email, masterPassword, item, timeoutMs = 60_000, tmpRoot = tmpdir(), nodePath = process.execPath } = {}) {
  if (!cliPath || !existsSync(cliPath)) return { ok: false, reason: VAULT_REASONS.missingCli };
  if (!email || !masterPassword || !item || typeof item.password !== "string" || !serverUrl) return { ok: false, reason: VAULT_REASONS.badInput };
  let dir = null;
  try {
    dir = mkdtempSync(join(tmpRoot, "crow-bw-"));
    chmodSync(dir, 0o700);
    const baseEnv = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: dir, BITWARDENCLI_APPDATA_DIR: dir, BW_NOINTERACTION: "true", NODE_OPTIONS: "" };
    const step = (args, extra = {}, stdin = "") => runStep({ nodePath, cliPath, args, env: { ...baseEnv, ...extra }, stdin, timeoutMs });

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
    await step(["logout"], { BW_SESSION: session });
    if (created.timedOut) return { ok: false, reason: VAULT_REASONS.timeout };
    if (created.code !== 0) return { ok: false, reason: VAULT_REASONS.createFailed };
    return { ok: true };
  } catch {
    return { ok: false, reason: VAULT_REASONS.failed };
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
}
```

- [ ] **Step 4: Declare the CLI in the vaultwarden bundle**

Edit `bundles/vaultwarden/package.json` `dependencies` so it reads:

```json
  "dependencies": {
    "@bitwarden/cli": "2026.9.1",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.24.0"
  }
```

Then regenerate the lock file and confirm the binary path the code expects:

```bash
cd ~/crow-wt-keychain/bundles/vaultwarden
npm install --package-lock-only --omit=dev
npm view @bitwarden/cli@2026.9.1 bin          # { bw: 'build/bw.js' }
cd ~/crow-wt-keychain
npm test -- tests/bundle-server-deps.test.js  # still PASS: the bundle server imports nothing new
```

The binary path `node_modules/@bitwarden/cli/build/bw.js` comes from that `bin` entry. It is installed into `~/.crow/bundles/vaultwarden/` by `npm install --omit=dev` (`bundleNeedsNpmInstall` → the exact pin triggers it on the version-bumped refresh in Task 9).

- [ ] **Step 5: Run the tests**

```bash
npm test -- tests/keychain-vault-save.test.js
npm test -- tests/keychain-api.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/keychain-vault-save.test.js
git commit servers/gateway/keychain/vault-save.js tests/keychain-vault-save.test.js bundles/vaultwarden/package.json bundles/vaultwarden/package-lock.json -m "feat(keychain): optional save to the user's Vaultwarden via the Bitwarden CLI — env/stdin only, private appdata, sentence errors"
git show --stat HEAD
```

---
### Task 6: Installer wiring — install, Configure and uninstall talk to the keychain

**Files:**
- Create: `servers/gateway/keychain/install-hooks.js`
- Modify: `servers/gateway/routes/bundles.js`:
  - `POST /bundles/api/install` (~:2692): sanitize and pass `keychain`;
  - `runInstallJob` (~:1933, signature + step 2 at ~:2027-2050);
  - `POST /bundles/api/env` (Configure, after the `.env` write);
  - the uninstall job (after "Installation record removed", ~:3021).
- Test: `tests/keychain-install-wiring.test.js`

**Interfaces:**
- Consumes:
  - `resolveGeneratedEnvDetailed`, `keychainGeneratedKeys`, `expandKeychainTemplate` (Task 2);
  - `saveExtensionSecret`, `reactivateBundleEntries`, `markBundleRemoved` (Task 3);
  - `vaultwardenStatus`, `saveToVault`, `VAULT_REASONS` (Task 5);
  - `auditLog`.
- Produces:
  - `sanitizeKeychainRequest(raw, { localSession: boolean }): { save: string[], vault: { email, password } | null }`. A non-local session always gets `{ save: [], vault: null }`.
  - `humanSecretKeys(manifest): string[]` (`secret === true && !generate`)
  - `recordKeychainForInstall({ bundleId, manifest, env, minted, keychainReq, log }): Promise<{ saved: number, firstView: number[], vault: { ok, reason? } | null }>` (never throws)
  - `markBundleKeychainRemoved(bundleId): Promise<number>` (never throws)
  - `_setKeychainDepsForTest(deps | null)`: overrides `{ openDb, identity, vault: { status, save } }`
  - `runInstallJob(bundleId, envVars, { job, installedSnapshot, consentVerified, manifest, keychain = null })`: the new optional `keychain` is the sanitized request.

- [ ] **Step 1: Write the failing test**

Create `tests/keychain-install-wiring.test.js`:

```js
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
const { loadOrCreateIdentity } = await import("../servers/sharing/identity.js");

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
    { name: "DEMO_PASSWORD", secret: true, keychain_label: "admin password", keychain_username: "${DEMO_USER}" },
    { name: "DEMO_API_KEY", secret: true },
  ],
});
function fixture(id) {
  mkdirSync(join(FIXTURES, id), { recursive: true });
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify(MANIFEST(id)));
  return MANIFEST(id);
}
const db = () => createDbClient();
const ID = () => loadOrCreateIdentity();

test("sanitizeKeychainRequest: only local sessions, only env-name keys, vault needs both fields", () => {
  assert.deepEqual(H.sanitizeKeychainRequest({ save: ["A"], vault: { email: "e", password: "p" } }, { localSession: false }), { save: [], vault: null });
  assert.deepEqual(H.sanitizeKeychainRequest({ save: ["A", "bad key", 3], vault: { email: " e@x ", password: "p" } }, { localSession: true }), { save: ["A"], vault: { email: "e@x", password: "p" } });
  assert.deepEqual(H.sanitizeKeychainRequest({ save: ["A"], vault: { email: "e", password: "" } }, { localSession: true }).vault, null);
  assert.deepEqual(H.humanSecretKeys(MANIFEST("x")), ["DEMO_PASSWORD", "DEMO_API_KEY"]);
});

test("install: generated token → keychain (first view) + PHC hash in .env; checked human field → keychain; unchecked is not saved", async () => {
  const id = "demo-kc-a"; const manifest = fixture(id);
  const job = B._createJobForTest(id, "install");
  const keychain = { save: ["DEMO_PASSWORD"], vault: null };
  const out = await B.runInstallJob(id, { DEMO_DOMAIN: "http://localhost:18097", DEMO_USER: "kevin", DEMO_PASSWORD: "p a$s'w\"d #1", DEMO_API_KEY: "api-123" }, { job, installedSnapshot: [], consentVerified: false, manifest, keychain });
  assert.equal(out.ok, true, out.reason);
  const env = parseEnvText(readFileSync(join(CROW_HOME, "bundles", id, ".env"), "utf8"));
  assert.match(env.DEMO_ADMIN_TOKEN, /^\$argon2id\$v=19\$m=65540,t=3,p=4\$/);
  assert.equal(env.DEMO_PASSWORD, "p a$s'w\"d #1", "the wide-charset value round-trips through the installer");
  const d = db();
  try {
    const entries = await K.listEntries(d);
    const byKey = Object.fromEntries(entries.map((e) => [e.env_key, e]));
    assert.deepEqual(Object.keys(byKey).sort(), ["DEMO_ADMIN_TOKEN", "DEMO_PASSWORD"], "DEMO_API_KEY was not checked");
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
    const e1 = (await K.listEntries(d)).find((e) => e.bundle_id === id);
    await K.consumeFirstView(d, ID(), e1.id);
    assert.equal(await H.markBundleKeychainRemoved(id), 1);
    assert.equal((await K.getEntry(d, e1.id)).status, "extension_removed");
    rmSync(join(CROW_HOME, "bundles", id), { recursive: true, force: true });
    await install();
    const e2 = await K.getEntry(d, e1.id);
    assert.equal(e2.status, "active");
    assert.equal(e2.first_view_pending, false, "nothing new was minted, so nothing new to show");
    assert.equal((await K.listEntries(d)).filter((e) => e.bundle_id === id).length, 1);
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
    try { assert.equal((await K.listEntries(d)).filter((e) => e.bundle_id === id).length, 0, "peer request saved nothing"); } finally { d.close(); }
    const local = await post({ bundle_id: id, env_vars: { DEMO_PASSWORD: "Local-Typed-1" }, keychain: { save: ["DEMO_PASSWORD"] } });
    assert.equal(local.status, 200, JSON.stringify(local.body));
    assert.equal(local.body.keychain.saved, 1);
    const d2 = db();
    try {
      const e = (await K.listEntries(d2)).find((x) => x.bundle_id === id);
      assert.equal(await K.openEntrySecret(d2, ID(), e.id), "Local-Typed-1");
    } finally { d2.close(); }
  } finally { server.close(); }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/keychain-install-wiring.test.js`
Expected: FAIL with `Cannot find module '…/keychain/install-hooks.js'`.

- [ ] **Step 3: Create `servers/gateway/keychain/install-hooks.js`**

```js
/**
 * The installer's side of the keychain (spec §5.7). Never throws into the install:
 * a keychain or vault problem is a job-log line, not a failed install.
 *  - generated keychain:true tokens (minted by resolveGeneratedEnvDetailed) are ALWAYS
 *    saved, with a 30-minute first-view grant — otherwise the plaintext is lost;
 *  - human fields (secret && !generate) are saved only when the request is a LOCAL
 *    dashboard session that ticked "Save to Crow keychain" (sanitizeKeychainRequest);
 *  - the optional vault copy uses the typed vault credentials once, then drops them.
 */
import { createDbClient, auditLog } from "../../db.js";
import { loadOrCreateIdentity } from "../../sharing/identity.js";
import { keychainGeneratedKeys, expandKeychainTemplate } from "../bundle-env-secrets.js";
import { saveExtensionSecret, reactivateBundleEntries, markBundleRemoved } from "./store.js";
import { vaultwardenStatus, saveToVault, VAULT_REASONS } from "./vault-save.js";

let _override = null;
export function _setKeychainDepsForTest(deps) { _override = deps || null; }
function deps() {
  return {
    openDb: () => createDbClient(),
    identity: () => loadOrCreateIdentity(),
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

export function humanSecretKeys(manifest) {
  return (manifest?.env_vars || []).filter((v) => v && typeof v.name === "string" && v.secret === true && !v.generate).map((v) => v.name);
}

function templateEnv(manifest, env) {
  const out = {};
  for (const v of manifest?.env_vars || []) if (v && v.default !== undefined && v.default !== null) out[v.name] = String(v.default);
  return { ...out, ...(env || {}) };
}

export async function recordKeychainForInstall({ bundleId, manifest, env, minted, keychainReq, log = () => {} }) {
  const d = deps();
  const out = { saved: 0, firstView: [], vault: null };
  const specs = new Map((manifest?.env_vars || []).map((v) => [v.name, v]));
  const humans = new Set(humanSecretKeys(manifest));
  const tEnv = templateEnv(manifest, env);
  const toSave = [];
  for (const [k, plain] of Object.entries(minted || {})) toSave.push({ k, plain, origin: "generated", firstView: true });
  for (const k of keychainReq?.save || []) {
    if (humans.has(k) && typeof env?.[k] === "string" && env[k] !== "") toSave.push({ k, plain: env[k], origin: "typed", firstView: false });
  }
  const reused = keychainGeneratedKeys(manifest).filter((k) => !Object.hasOwn(minted || {}, k));
  if (toSave.length === 0 && reused.length === 0) return out;

  let db;
  const saved = [];
  try {
    db = d.openDb();
    if (reused.length) await reactivateBundleEntries(db, bundleId, reused);
    const identity = d.identity();
    for (const s of toSave) {
      const spec = specs.get(s.k) || {};
      const label = `${manifest?.name || bundleId} — ${spec.keychain_label || s.k}`;
      const username = expandKeychainTemplate(spec.keychain_username, tEnv);
      const url = expandKeychainTemplate(spec.keychain_url, tEnv);
      const r = await saveExtensionSecret(db, identity, { bundleId, envKey: s.k, label, username, url, secret: s.plain, origin: s.origin, firstView: s.firstView });
      out.saved++;
      if (s.firstView) out.firstView.push(r.id);
      saved.push({ id: r.id, label, username, url, plain: s.plain, envKey: s.k });
      await d.audit(db, "keychain_save", { details: { entry_id: r.id, bundle_id: bundleId, env_key: s.k, origin: s.origin } });
    }
    if (out.saved) log(`Saved ${out.saved} password(s) to Crow keychain (Settings → Passwords)`);

    if (keychainReq?.vault && saved.length) {
      const st = d.vault.status();
      if (!st || !st.installed || !st.cliPath) {
        out.vault = { ok: false, reason: VAULT_REASONS.missingCli };
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
    log(`Crow keychain save did not complete (${err?.code || err?.name || "error"}); the install continues`);
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
```

- [ ] **Step 4: Wire `servers/gateway/routes/bundles.js`**

a. Imports: extend the `bundle-env-secrets.js` import list with `resolveGeneratedEnvDetailed`, and add:

```js
import { sanitizeKeychainRequest, recordKeychainForInstall, markBundleKeychainRemoved } from "../keychain/install-hooks.js";
```

b. `runInstallJob` signature:

```js
export async function runInstallJob(bundleId, envVars, { job, installedSnapshot, consentVerified, manifest, keychain = null }) {
```

c. In step 2 of `runInstallJob`, replace

```js
    const generated = resolveGeneratedEnv(bundleId, manifest, { destDir, crowHome: CROW_HOME });
```

with

```js
    const { env: generated, minted } = resolveGeneratedEnvDetailed(bundleId, manifest, { destDir, crowHome: CROW_HOME });
```

Directly after the existing `if (Object.keys(generated).length > 0) { appendLog(job, "Generated … never shown"); }` block, add:

```js
    // Keychain (spec §5.7, plan P7): before any pull, so a later compose failure still
    // leaves the password saved, and the vault master password lives for seconds.
    await recordKeychainForInstall({ bundleId, manifest, env: installEnv, minted, keychainReq: keychain, log: (m) => appendLog(job, m) });
```

`resolveGeneratedEnv` must still be imported only if used elsewhere. If `grep -n "resolveGeneratedEnv(" servers/gateway/routes/bundles.js` prints nothing after this edit, remove it from the import list.

d. `POST /bundles/api/install`: before `const job = createJob(bundle_id, "install");`, add

```js
    const keychainReq = sanitizeKeychainRequest(req.body?.keychain, { localSession: !!req.dashboardSession && !req.crossHostAuth });
```

and pass `keychain: keychainReq,` in the `runInstallJob(bundle_id, env_vars, { … })` options object.

e. `POST /bundles/api/env`: after `writePrivateFile(envPath, formatEnvLines(existing));` add

```js
      const keychainReq = sanitizeKeychainRequest(req.body?.keychain, { localSession: !!req.dashboardSession && !req.crossHostAuth });
      const kcLog = [];
      const kc = keychainReq.save.length
        ? await recordKeychainForInstall({ bundleId: bundle_id, manifest: getInstalledFirstManifest(bundle_id), env: existing, minted: {}, keychainReq, log: (m) => kcLog.push(m) })
        : null;
```

and add to the `res.json({ … })` object:

```js
        keychain: kc ? { saved: kc.saved, vault: kc.vault, messages: kcLog } : null,
```

f. Uninstall job: directly after `appendLog(job, "Installation record removed");` add

```js
        const keptPasswords = await markBundleKeychainRemoved(bundle_id);
        if (keptPasswords) appendLog(job, `Kept ${keptPasswords} saved password(s) in Crow keychain, marked "extension removed" (Settings → Passwords)`);
```

- [ ] **Step 5: Run the tests**

```bash
npm test -- tests/keychain-install-wiring.test.js
npm test -- tests/bundle-env-secrets.test.js
npm test -- tests/bundle-env-scoping.test.js
npm test -- tests/bundles-install-set.test.js
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/keychain/install-hooks.js tests/keychain-install-wiring.test.js
git commit servers/gateway/keychain/install-hooks.js tests/keychain-install-wiring.test.js servers/gateway/routes/bundles.js -m "feat(keychain): install/Configure save human + generated passwords, optional vault copy, uninstall keeps entries as extension-removed"
git show --stat HEAD
```

---
### Task 7: Extensions modal — Generate / Show / Copy, "Save to Crow keychain", the vault block, the first-view banner

**Files:**
- Create: `servers/gateway/dashboard/shared/password-generator.js`
- Modify: `servers/gateway/dashboard/panels/extensions/html.js` (`buildExtensionsHTML` param `keychainPending = []`; `#ext-keychain-config`; banner; `escapeHtml`/`t` already imported, add `fill` to the i18n import)
- Modify: `servers/gateway/dashboard/panels/extensions.js` (query `pendingFirstViews`)
- Modify: `servers/gateway/dashboard/panels/extensions/client.js` (generator embed; field tools; keychain/vault payload; banner buttons)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (`keychain.*` keys)
- Test: `tests/extensions-keychain-client.test.js`

**Interfaces:**
- Produces:
  - `generatePassword(length: number, pattern: string|null, randomUint32: () => number): string|null` (ES5 source, no backticks; it is embedded into the client with `.toString()`);
  - `PASSWORD_LENGTH = 24`.
- The install/configure request gains `keychain: { save: string[], vault?: { email, password } }`, consumed by Task 6's `sanitizeKeychainRequest`.
- The client calls `POST /dashboard/keychain/api/first-view { id }` (Task 4).

- [ ] **Step 1: Write the failing test**

Create `tests/extensions-keychain-client.test.js`:

```js
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
      { name: "DEMO_PASSWORD", description: "admin password", secret: true, pattern: WIDE },
      { name: "DEMO_TOKEN", description: "generated", secret: true, generate: "secret", keychain: true },
    ] },
  { id: "vaultwarden", name: "Vaultwarden", description: "vault", type: "bundle", category: "infrastructure", version: "1.1.0", author: "Crow", tags: [] },
];

function boot({ installed = {}, keychainPending = [], fetchImpl } = {}) {
  const { viewsHtml, addonRegistryScript, collectionsScript } = buildExtensionsHTML({
    installed, available: AVAILABLE, collections: [], needsConfig: {}, keychainPending,
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
  const ctx = vm.createContext({
    window, document, location, console, AbortController,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: fetchStub,
    crypto: webcrypto,
    navigator: { clipboard: { writeText: (s) => { clipboard.push(s); return Promise.resolve(); } } },
    setTimeout: () => 0, clearTimeout: () => {},
  });
  window.location = location;
  vm.runInContext(CLIENT_JS, ctx);
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  return { window, document, click, settle, calls, clipboard };
}
const consentOk = (url) => (url.includes("/consent-challenge/")
  ? { ok: true, status: 200, json: () => Promise.resolve({ required: false, install_required: [] }) }
  : { ok: true, status: 200, json: () => Promise.resolve({ ok: true, job_id: "1" }) });

test("generatePassword: 24 chars, all four classes, honours a pattern, null when impossible", () => {
  const r = () => randomInt(0, 2 ** 32 - 1);
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword(PASSWORD_LENGTH, null, r);
    assert.equal(pw.length, 24);
    assert.match(pw, /[a-z]/); assert.match(pw, /[A-Z]/); assert.match(pw, /[2-9]/); assert.match(pw, /[!#%*+,\-./:=?@^_~]/);
    assert.doesNotMatch(pw, /[lIO01'"`$\\ ]/);
  }
  assert.match(generatePassword(24, "^[A-Za-z0-9]{24}$", r), /^[A-Za-z0-9]{24}$/, "falls back to alphanumerics");
  assert.equal(generatePassword(24, "^x$", r), null);
  assert.equal(generatePassword(24, "([", r), null, "an invalid pattern never throws");
  assert.ok(!generatePassword.toString().includes(String.fromCharCode(96)), "embeddable in the template-literal client");
});

test("only human secret fields get Generate/Show/Copy + a checked keychain box; generated fields stay hidden", async () => {
  const { document, click, settle } = boot({ fetchImpl: consentOk });
  click(document.querySelector('.bundle-install[data-id="demo"]'));
  await settle();
  assert.equal(document.querySelectorAll(".ext-secret-generate").length, 1);
  assert.ok(document.querySelector('.ext-secret-generate[data-key="DEMO_PASSWORD"]'));
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
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/extensions-keychain-client.test.js`
Expected: FAIL with `Cannot find module '…/shared/password-generator.js'`.

- [ ] **Step 3: Create `servers/gateway/dashboard/shared/password-generator.js`**

```js
/**
 * The Generate button's password generator (spec §5.5). ES5 on purpose and free of
 * backticks: extensions/client.js embeds it with Function.prototype.toString() inside its
 * template literal, and the same function is unit-tested in Node.
 * 24 chars; at least one lower/upper/digit/symbol; look-alikes (l I O 0 1) and
 * quote/backslash/backtick/$/space left out. randomUint32 MUST be a CSPRNG
 * (crypto.getRandomValues in the browser); rejection sampling keeps every pick uniform.
 * A manifest `pattern` is honoured by retrying, then by falling back to alphanumerics;
 * null means "cannot satisfy it" and the client hides the button.
 */
export const PASSWORD_LENGTH = 24;

export function generatePassword(length, pattern, randomUint32) {
  var lower = "abcdefghijkmnopqrstuvwxyz";
  var upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  var digits = "23456789";
  var symbols = "!#%*+,-./:=?@^_~";
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
```

- [ ] **Step 4: i18n keys**

In `servers/gateway/dashboard/shared/i18n.js`, directly after the `"settings.section.twoFactor"` line, add:

```js
  "keychain.generate": { en: "Generate", es: "Generar" },
  "keychain.show": { en: "Show", es: "Mostrar" },
  "keychain.hide": { en: "Hide", es: "Ocultar" },
  "keychain.copy": { en: "Copy", es: "Copiar" },
  "keychain.copied": { en: "Copied", es: "Copiado" },
  "keychain.saveToKeychain": { en: "Save to Crow keychain", es: "Guardar en el llavero de Crow" },
  "keychain.vaultSave": { en: "Also save to my Vaultwarden vault", es: "Guardar también en mi bóveda de Vaultwarden" },
  "keychain.vaultEmail": { en: "Vault email", es: "Correo de la bóveda" },
  "keychain.vaultPassword": { en: "Vault master password", es: "Contraseña maestra de la bóveda" },
  "keychain.vaultNote": { en: "Used once to save this password, then forgotten. Crow never stores it.", es: "Se usa una vez para guardar esta contraseña y luego se olvida. Crow nunca la guarda." },
  "keychain.firstViewTitle": { en: "A password was generated for {label}", es: "Se generó una contraseña para {label}" },
  "keychain.firstViewBody": { en: "It is shown here once. It is also saved in Settings → Passwords.", es: "Se muestra aquí una sola vez. También queda guardada en Ajustes → Contraseñas." },
  "keychain.showOnce": { en: "Show once", es: "Mostrar una vez" },
  "keychain.firstViewSpent": { en: "Already shown. Open Settings → Passwords to see it again.", es: "Ya se mostró. Abre Ajustes → Contraseñas para verla de nuevo." },
  "keychain.openPasswords": { en: "Open Passwords", es: "Abrir Contraseñas" },
```

- [ ] **Step 5: `html.js` — config flag and banner**

Add `fill` to the existing `../../shared/i18n.js` import in `servers/gateway/dashboard/panels/extensions/html.js`. Add `keychainPending = [],` to `buildExtensionsHTML`'s destructured parameters (after `dockerOk = true,`), and document it in the JSDoc:

```js
 * @param {Array<{id:number,label:string}>} [keychainPending] entries with a live
 *   first-view grant (computed in panels/extensions.js; never queried here)
```

Before the `// ─── Segmented control ───` block, add:

```js
  // ─── Crow keychain: vault flag + first-view banner (plan P5/P6) ───
  const keychainConfigHtml = `<div id="ext-keychain-config" data-vault="${installed.vaultwarden ? "1" : "0"}" hidden></div>`;
  const firstViewHtml = (keychainPending || []).map((e) => `<div class="callout callout-info ext-firstview" data-entry-id="${Number(e.id)}" role="status">
        <strong>${escapeHtml(fill(t("keychain.firstViewTitle", lang), { label: e.label }))}</strong>
        <p style="margin:0.25rem 0 0.5rem">${t("keychain.firstViewBody", lang)}</p>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
          <button type="button" class="btn btn-sm btn-secondary ext-firstview-show" data-id="${Number(e.id)}">${t("keychain.showOnce", lang)}</button>
          <code class="ext-firstview__secret" hidden style="font-family:'JetBrains Mono',monospace;word-break:break-all"></code>
          <button type="button" class="btn btn-sm btn-secondary ext-firstview-copy" hidden>${t("keychain.copy", lang)}</button>
          <span class="ext-firstview__note" style="font-size:0.8rem"></span>
          <a href="/dashboard/settings?section=passwords">${t("keychain.openPasswords", lang)}</a>
        </div>
      </div>`).join("");
```

Then change the start of the `viewsHtml` template from `` `${dockerBannerHtml}${viewTabsHtml} `` to `` `${keychainConfigHtml}${firstViewHtml}${dockerBannerHtml}${viewTabsHtml} ``.

- [ ] **Step 6: `panels/extensions.js` — pass the pending first views**

After `const dockerOk = await dockerAvailable();` add:

```js
    // First-view banner (Crow keychain): ids + labels only, never secrets.
    let keychainPending = [];
    try {
      const { pendingFirstViews } = await import("../../keychain/store.js");
      keychainPending = (await pendingFirstViews(db)).map((e) => ({ id: e.id, label: e.label }));
    } catch { /* no banner rather than no page */ }
```

and add `keychainPending,` to the `buildExtensionsHTML({ … })` call.

- [ ] **Step 7: `client.js` — embed the generator and build the field tools**

At the top of the file add:

```js
import { generatePassword, PASSWORD_LENGTH } from "../../shared/password-generator.js";
```

Inside the IIFE, right after `var API = "/dashboard/bundles/api";`, add (the `${…}` here are deliberate interpolations):

```js
        // --- Crow keychain helpers (password-generator.js is ES5 + backtick-free) ---
        var crowGeneratePassword = ${generatePassword.toString()};
        var CROW_PW_LENGTH = ${PASSWORD_LENGTH};
        var CAN_GENERATE = typeof crypto !== "undefined" && !!crypto.getRandomValues;
        function crowRandomUint32() { var a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; }
        function vaultInstalled() {
          var c = document.getElementById("ext-keychain-config");
          return !!c && c.getAttribute("data-vault") === "1";
        }
        function copyText(text, btn) {
          if (typeof navigator === "undefined" || !navigator.clipboard || !text) return;
          navigator.clipboard.writeText(text).then(function() {
            var was = btn.textContent;
            btn.textContent = '${tJs("keychain.copied", lang)}';
            setTimeout(function() { btn.textContent = was; }, 1500);
          }).catch(function() {});
        }
```

In `showInstallModal`, declare `var keychainKeys = [];` next to `var envNames = [];`. Inside `envVars.forEach(function(ev) { … })`, directly after `wrap.appendChild(input);`, add:

```js
                if (ev.secret && !ev.generate) {
                  input.setAttribute("autocomplete", "new-password");
                  keychainKeys.push(ev.name);
                  var tools = document.createElement("div");
                  tools.className = "ext-secret-tools";
                  tools.style.cssText = "display:flex;gap:0.4rem;flex-wrap:wrap;align-items:center;margin-top:0.3rem";
                  var genBtn = document.createElement("button");
                  genBtn.type = "button";
                  genBtn.className = "btn btn-sm btn-secondary ext-secret-generate";
                  genBtn.setAttribute("data-key", ev.name);
                  genBtn.textContent = '${tJs("keychain.generate", lang)}';
                  var showBtn = document.createElement("button");
                  showBtn.type = "button";
                  showBtn.className = "btn btn-sm btn-secondary ext-secret-toggle";
                  showBtn.textContent = '${tJs("keychain.show", lang)}';
                  var copyBtn = document.createElement("button");
                  copyBtn.type = "button";
                  copyBtn.className = "btn btn-sm btn-secondary ext-secret-copy";
                  copyBtn.textContent = '${tJs("keychain.copy", lang)}';
                  if (!CAN_GENERATE || crowGeneratePassword(CROW_PW_LENGTH, ev.pattern || null, crowRandomUint32) === null) genBtn.style.display = "none";
                  genBtn.addEventListener("click", function() {
                    var pw = crowGeneratePassword(CROW_PW_LENGTH, ev.pattern || null, crowRandomUint32);
                    if (!pw) return;
                    input.value = pw;
                    input.type = "text";
                    showBtn.textContent = '${tJs("keychain.hide", lang)}';
                    refreshInstallBtnState();
                  });
                  showBtn.addEventListener("click", function() {
                    var hidden = input.type === "password";
                    input.type = hidden ? "text" : "password";
                    showBtn.textContent = hidden ? '${tJs("keychain.hide", lang)}' : '${tJs("keychain.show", lang)}';
                  });
                  copyBtn.addEventListener("click", function() { copyText(input.value, copyBtn); });
                  tools.appendChild(genBtn);
                  tools.appendChild(showBtn);
                  tools.appendChild(copyBtn);
                  var kcLabel = document.createElement("label");
                  kcLabel.style.cssText = "display:inline-flex;gap:0.3rem;align-items:center;font-size:0.8rem;color:var(--crow-text-secondary)";
                  var kcBox = document.createElement("input");
                  kcBox.type = "checkbox";
                  kcBox.className = "ext-keychain-save";
                  kcBox.setAttribute("data-key", ev.name);
                  kcBox.checked = true;
                  kcLabel.appendChild(kcBox);
                  kcLabel.appendChild(document.createTextNode('${tJs("keychain.saveToKeychain", lang)}'));
                  tools.appendChild(kcLabel);
                  wrap.appendChild(tools);
                }
```

After the `envVars.forEach` block (still inside `if (envVars.length > 0) { … }`), add the vault block:

```js
              if (keychainKeys.length > 0 && vaultInstalled()) {
                var vWrap = document.createElement("div");
                vWrap.className = "ext-vault";
                vWrap.style.cssText = "margin:0.5rem 0 0.75rem;padding:0.6rem;border:1px solid var(--crow-border);border-radius:6px";
                var vLabel = document.createElement("label");
                vLabel.style.cssText = "display:flex;gap:0.4rem;align-items:center;font-size:0.85rem";
                var vTick = document.createElement("input");
                vTick.type = "checkbox";
                vTick.id = "ext-vault-save";
                vLabel.appendChild(vTick);
                vLabel.appendChild(document.createTextNode('${tJs("keychain.vaultSave", lang)}'));
                vWrap.appendChild(vLabel);
                var vFields = document.createElement("div");
                vFields.id = "ext-vault-fields";
                vFields.style.cssText = "display:none;margin-top:0.5rem";
                [["ext-vault-email", "email", '${tJs("keychain.vaultEmail", lang)}'], ["ext-vault-password", "password", '${tJs("keychain.vaultPassword", lang)}']].forEach(function(f) {
                  var inp = document.createElement("input");
                  inp.id = f[0];
                  inp.type = f[1];
                  inp.placeholder = f[2];
                  inp.setAttribute("aria-label", f[2]);
                  inp.setAttribute("autocomplete", "off");
                  inp.style.cssText = "width:100%;padding:0.45rem;margin-bottom:0.4rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg-deep);color:var(--crow-text-primary);box-sizing:border-box";
                  vFields.appendChild(inp);
                });
                var vNote = document.createElement("div");
                vNote.style.cssText = "font-size:0.75rem;color:var(--crow-text-muted)";
                vNote.textContent = '${tJs("keychain.vaultNote", lang)}';
                vFields.appendChild(vNote);
                vWrap.appendChild(vFields);
                vTick.addEventListener("change", function() { vFields.style.display = vTick.checked ? "block" : "none"; });
                frag.appendChild(vWrap);
              }
```

Add this helper inside `showInstallModal` (next to `missingRequired`):

```js
            function collectKeychain(envData) {
              var save = [];
              keychainKeys.forEach(function(k) {
                var cb = document.querySelector('.ext-keychain-save[data-key="' + k + '"]');
                if (cb && cb.checked && envData[k]) save.push(k);
              });
              if (save.length === 0) return null;
              var out = { save: save };
              var vt = document.getElementById("ext-vault-save");
              var ve = document.getElementById("ext-vault-email");
              var vp = document.getElementById("ext-vault-password");
              if (vt && vt.checked && ve && vp && ve.value && vp.value) out.vault = { email: ve.value, password: vp.value };
              return out;
            }
```

In the install click handler, after `if (consentToken) payload.consent_token = consentToken;` add:

```js
              var kcReq = collectKeychain(envData);
              if (kcReq) payload.keychain = kcReq;
```

In `submitConfigureOnly`, change `apiCall("env", { bundle_id: id, env_vars: envData })` to:

```js
              var cfgPayload = { bundle_id: id, env_vars: envData };
              var cfgKc = collectKeychain(envData);
              if (cfgKc) cfgPayload.keychain = cfgKc;
              apiCall("env", cfgPayload).then(function(res) {
```

(keep the rest of that `.then` chain unchanged).

Immediately before the IIFE's closing `})();` (the last lines of the template are `})();` then `<\/script>`), add the banner buttons:

```js
        // --- Crow keychain first-view banner (server-rendered; survives reload/restart) ---
        document.querySelectorAll(".ext-firstview").forEach(function(banner) {
          var showBtn = banner.querySelector(".ext-firstview-show");
          var code = banner.querySelector(".ext-firstview__secret");
          var copyBtn = banner.querySelector(".ext-firstview-copy");
          var note = banner.querySelector(".ext-firstview__note");
          if (!showBtn) return;
          showBtn.addEventListener("click", function() {
            showBtn.disabled = true;
            fetch("/dashboard/keychain/api/first-view", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: Number(showBtn.getAttribute("data-id")) }),
            }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); }).then(function(res) {
              showBtn.hidden = true;
              if (res.ok && res.d && typeof res.d.secret === "string") {
                code.textContent = res.d.secret;
                code.hidden = false;
                copyBtn.hidden = false;
              } else {
                note.textContent = '${tJs("keychain.firstViewSpent", lang)}';
              }
            }).catch(function() { showBtn.disabled = false; });
          });
          copyBtn.addEventListener("click", function() { copyText(code.textContent, copyBtn); });
        });
```

Check the template-literal rule before running:

```bash
node -e 'const s=require("fs").readFileSync("servers/gateway/dashboard/panels/extensions/client.js","utf8"); const body=s.slice(s.indexOf("return `")+8, s.lastIndexOf("`")); if (body.includes(String.fromCharCode(96))) { console.error("BACKTICK inside client template"); process.exit(1); } console.log("ok")'
```

- [ ] **Step 8: Run the tests**

```bash
npm test -- tests/extensions-keychain-client.test.js
npm test -- tests/extensions-client-contract.test.js
npm test -- tests/extensions-page-render.test.js
npm test -- tests/i18n-global-parity.test.js
```

Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add servers/gateway/dashboard/shared/password-generator.js tests/extensions-keychain-client.test.js
git commit servers/gateway/dashboard/shared/password-generator.js tests/extensions-keychain-client.test.js servers/gateway/dashboard/panels/extensions/html.js servers/gateway/dashboard/panels/extensions.js servers/gateway/dashboard/panels/extensions/client.js servers/gateway/dashboard/shared/i18n.js -m "feat(extensions): Generate/Show/Copy on password fields, Save to Crow keychain, optional vault copy, first-view banner"
git show --stat HEAD
```

---
### Task 8: Settings → Passwords

**Files:**
- Create: `servers/gateway/dashboard/settings/sections/passwords.js`
- Modify: `servers/gateway/dashboard/panels/settings.js` (import + `registerSettingsSection(passwordsSection);` right after `registerSettingsSection(twoFactorSection);`; find it with `grep -n "twoFactorSection" servers/gateway/dashboard/panels/settings.js`)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (`settings.section.passwords`, `passwords.*`)
- Test: `tests/settings-passwords-section.test.js`

**Interfaces:**
- Consumes:
  - `listEntries` (Task 3);
  - `vaultwardenStatus` (Task 5);
  - `is2faEnabled` (`dashboard/totp.js`);
  - the Task 4 API (`/dashboard/keychain/api/{entries,reauth,reveal,delete,add,vault-save,activity}`).
- Produces:
  - default export section `{ id: "passwords", group: "account", navOrder: 12, labelKey: "settings.section.passwords", getPreview, render }`;
  - `renderPasswordsPage({ entries, method: "totp"|"password", vaultAvailable: boolean, lang }): string` (pure);
  - `passwordsClientJS(lang): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/settings-passwords-section.test.js`:

```js
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
  { id: 3, kind: "extension", label: "Vaultwarden — admin token", bundle_id: "vaultwarden", env_key: "VAULTWARDEN_ADMIN_TOKEN", username: null, url: "http://localhost:8097/admin", origin: "generated", status: "extension_removed", updated_at: "2026-10-03T12:00:00.000Z" },
];

function boot({ method = "password", vaultAvailable = true, routes = {} } = {}) {
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
  const ctx = vm.createContext({
    window, document, console, fetch: fetchStub,
    location: { reload() { reloads.n++; } },
    navigator: { clipboard: { writeText: (s) => { clipboard.push(s); return Promise.resolve(); } } },
    setTimeout: () => 0, clearTimeout: () => {}, Date,
  });
  window.confirm = () => true;
  ctx.confirm = () => true;
  vm.runInContext(js, ctx);
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  return { document, click, settle, calls, clipboard, reloads };
}

test("the page lists metadata only, escapes labels, marks removed extensions, and asks for the right re-auth", () => {
  const html = renderPasswordsPage({ entries: ENTRIES, method: "totp", vaultAvailable: false, lang: "en" });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, new RegExp(t("passwords.statusRemoved", "en")));
  assert.match(html, /id="pw-root"[^>]*data-method="totp"/);
  assert.match(html, /id="pw-reauth-input"[^>]*inputmode="numeric"/);
  assert.equal((html.match(/class="[^"]*pw-vault[ "]/g) || []).length, 0, "no vault buttons without the CLI");
  assert.equal((renderPasswordsPage({ entries: ENTRIES, method: "password", vaultAvailable: true, lang: "en" }).match(/class="[^"]*pw-vault[ "]/g) || []).length, 3);
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/settings-passwords-section.test.js`
Expected: FAIL with `Cannot find module '…/sections/passwords.js'`.

- [ ] **Step 3: i18n keys**

In `servers/gateway/dashboard/shared/i18n.js`, after the `keychain.*` block from Task 7, add:

```js
  "settings.section.passwords": { en: "Passwords", es: "Contraseñas" },
  "passwords.preview": { en: "{n} saved", es: "{n} guardadas" },
  "passwords.intro": { en: "Passwords Crow saved for your extensions, plus any you add. They stay on this machine, encrypted, and are never synced to your other Crow instances.", es: "Contraseñas que Crow guardó para tus extensiones y las que añadas tú. Se quedan en esta máquina, cifradas, y nunca se sincronizan con tus otras instancias de Crow." },
  "passwords.empty": { en: "No saved passwords yet.", es: "Aún no hay contraseñas guardadas." },
  "passwords.colLabel": { en: "Name", es: "Nombre" },
  "passwords.colExtension": { en: "Extension", es: "Extensión" },
  "passwords.colUsername": { en: "Username", es: "Usuario" },
  "passwords.colUrl": { en: "Address", es: "Dirección" },
  "passwords.colStatus": { en: "Status", es: "Estado" },
  "passwords.colUpdated": { en: "Updated", es: "Actualizada" },
  "passwords.statusActive": { en: "In use", es: "En uso" },
  "passwords.statusRemoved": { en: "Extension removed", es: "Extensión eliminada" },
  "passwords.manual": { en: "Added by you", es: "Añadida por ti" },
  "passwords.reveal": { en: "Reveal", es: "Revelar" },
  "passwords.copy": { en: "Copy", es: "Copiar" },
  "passwords.copied": { en: "Copied", es: "Copiada" },
  "passwords.delete": { en: "Delete", es: "Eliminar" },
  "passwords.vault": { en: "Save to vault", es: "Guardar en la bóveda" },
  "passwords.deleteConfirm": { en: "Delete this saved password? This cannot be undone.", es: "¿Eliminar esta contraseña guardada? No se puede deshacer." },
  "passwords.reauthTitle": { en: "Confirm it's you", es: "Confirma que eres tú" },
  "passwords.reauthPassword": { en: "Your Crow's Nest password", es: "Tu contraseña de Crow's Nest" },
  "passwords.reauthTotp": { en: "The 6-digit code from your authenticator app", es: "El código de 6 dígitos de tu app de autenticación" },
  "passwords.reauthHint": { en: "Stays confirmed for 5 minutes.", es: "La confirmación dura 5 minutos." },
  "passwords.confirm": { en: "Confirm", es: "Confirmar" },
  "passwords.grantActive": { en: "Confirmed until {time}", es: "Confirmado hasta las {time}" },
  "passwords.addTitle": { en: "Add a password", es: "Añadir una contraseña" },
  "passwords.addHint": { en: "For app passwords and the like (for example a Workspace phone app password). This is not a general password manager.", es: "Para contraseñas de aplicaciones y similares (por ejemplo, la contraseña de la app del teléfono de Workspace). No es un gestor de contraseñas general." },
  "passwords.secret": { en: "Password", es: "Contraseña" },
  "passwords.add": { en: "Add", es: "Añadir" },
  "passwords.addMissing": { en: "A name and a password are required.", es: "Hacen falta un nombre y una contraseña." },
  "passwords.vaultTitle": { en: "Save to your Vaultwarden vault", es: "Guardar en tu bóveda de Vaultwarden" },
  "passwords.vaultSaved": { en: "Saved to your vault.", es: "Guardada en tu bóveda." },
  "passwords.activityTitle": { en: "Recent activity", es: "Actividad reciente" },
  "passwords.activityEmpty": { en: "Nothing yet.", es: "Nada todavía." },
  "passwords.error": { en: "Something went wrong. Nothing was revealed.", es: "Algo salió mal. No se reveló nada." },
  "passwords.event.keychain_reveal": { en: "Revealed", es: "Revelada" },
  "passwords.event.keychain_copy": { en: "Copied", es: "Copiada al portapapeles" },
  "passwords.event.keychain_delete": { en: "Deleted", es: "Eliminada" },
  "passwords.event.keychain_add": { en: "Added", es: "Añadida" },
  "passwords.event.keychain_save": { en: "Saved by an extension install", es: "Guardada al instalar una extensión" },
  "passwords.event.keychain_first_view": { en: "Shown once after install", es: "Mostrada una vez tras la instalación" },
  "passwords.event.keychain_vault_save": { en: "Sent to Vaultwarden", es: "Enviada a Vaultwarden" },
  "passwords.event.keychain_reauth_ok": { en: "Identity confirmed", es: "Identidad confirmada" },
  "passwords.event.keychain_reauth_failed": { en: "Confirmation failed", es: "Confirmación fallida" },
```

- [ ] **Step 4: Create `servers/gateway/dashboard/settings/sections/passwords.js`**

```js
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
  const rows = (entries || []).map((e) => {
    const ext = e.kind === "manual" ? t("passwords.manual", lang) : escapeHtml(e.bundle_id || "");
    const status = e.status === "extension_removed" ? t("passwords.statusRemoved", lang) : t("passwords.statusActive", lang);
    const url = e.url ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.url)}</a>` : "";
    return `<tr class="pw-row" data-id="${Number(e.id)}">
        <td>${escapeHtml(e.label)}<div><code class="pw-secret" hidden style="font-family:'JetBrains Mono',monospace;word-break:break-all"></code></div></td>
        <td>${ext}</td>
        <td>${escapeHtml(e.username || "")}</td>
        <td style="word-break:break-all">${url}</td>
        <td>${status}</td>
        <td style="white-space:nowrap">${escapeHtml(String(e.updated_at || "").slice(0, 16).replace("T", " "))}</td>
        <td style="white-space:nowrap">
          <button type="button" class="btn btn-sm btn-secondary pw-reveal">${t("passwords.reveal", lang)}</button>
          <button type="button" class="btn btn-sm btn-secondary pw-copy">${t("passwords.copy", lang)}</button>
          ${vaultAvailable ? `<button type="button" class="btn btn-sm btn-secondary pw-vault">${t("passwords.vault", lang)}</button>` : ""}
          <button type="button" class="btn btn-sm btn-secondary pw-delete">${t("passwords.delete", lang)}</button>
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

  return `<style>
      .pw-table th { text-align:left; padding:6px 8px; color:var(--crow-text-muted); font-weight:500; font-size:0.72rem; text-transform:uppercase; }
      .pw-table td { padding:6px 8px; border-top:1px solid var(--crow-border); vertical-align:top; }
      .pw-panel { margin:1rem 0; padding:0.8rem; border:1px solid var(--crow-border); border-radius:8px; max-width:28rem; }
      .pw-panel input { ${inputCss} }
    </style>
    <div id="pw-root" data-method="${totp ? "totp" : "password"}">
      <p style="color:var(--crow-text-secondary);font-size:0.9rem">${t("passwords.intro", lang)}</p>
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
      <h3 style="margin-top:1.5rem;font-size:1rem">${t("passwords.activityTitle", lang)}</h3>
      <ul id="pw-activity" style="font-size:0.8rem;color:var(--crow-text-secondary)"></ul>
    </div>`;
}

export function passwordsClientJS(lang) {
  const eventNames = ["keychain_reveal", "keychain_copy", "keychain_delete", "keychain_add", "keychain_save", "keychain_first_view", "keychain_vault_save", "keychain_reauth_ok", "keychain_reauth_failed"];
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

      function post(path, body) {
        return fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
          .then(function(r) { return r.json().then(function(d) { return { status: r.status, d: d || {} }; }); });
      }
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
          if (res.status === 200) {
            input.value = "";
            document.getElementById("pw-reauth").hidden = true;
            showGrant(res.d.expires_at);
            var next = pending; pending = null;
            if (next) next();
          } else {
            input.value = "";
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
            if (res.status === 200 && typeof res.d.secret === "string") { cell.textContent = res.d.secret; cell.hidden = false; }
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
          if (!confirm('${tJs("passwords.deleteConfirm", lang)}')) return;
          guarded("/delete", { id: id }, function(res) { if (res.status === 200) row.remove(); });
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

  async render({ db, lang }) {
    const { listEntries } = await import("../../../keychain/store.js");
    const { vaultwardenStatus } = await import("../../../keychain/vault-save.js");
    const { is2faEnabled } = await import("../../totp.js");
    const entries = await listEntries(db);
    const vs = vaultwardenStatus();
    const method = (await is2faEnabled()) ? "totp" : "password";
    return renderPasswordsPage({ entries, method, vaultAvailable: !!(vs.installed && vs.cliPath), lang }) + passwordsClientJS(lang);
  },
};
```

- [ ] **Step 5: Register the section**

In `servers/gateway/dashboard/panels/settings.js`:
- add `import passwordsSection from "../settings/sections/passwords.js";` after the `twoFactorSection` import;
- add `registerSettingsSection(passwordsSection);` directly after `registerSettingsSection(twoFactorSection);`.

Check the client for template-literal hazards:

```bash
node -e 'const s=require("fs").readFileSync("servers/gateway/dashboard/settings/sections/passwords.js","utf8"); const a=s.indexOf("return `<script>"); const b=s.indexOf("</script>`;"); const body=s.slice(a+8,b); if (body.includes(String.fromCharCode(96))||body.includes(String.fromCharCode(92))) { console.error("backtick/backslash in client"); process.exit(1);} console.log("ok")'
```

- [ ] **Step 6: Run the tests**

```bash
npm test -- tests/settings-passwords-section.test.js
npm test -- tests/i18n-global-parity.test.js
npm test -- tests/settings-i18n-section-labels.test.js
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add servers/gateway/dashboard/settings/sections/passwords.js tests/settings-passwords-section.test.js
git commit servers/gateway/dashboard/settings/sections/passwords.js tests/settings-passwords-section.test.js servers/gateway/dashboard/panels/settings.js servers/gateway/dashboard/shared/i18n.js -m "feat(settings): Passwords page — re-auth gated reveal/copy/delete, add, save to vault, recent activity (en/es)"
git show --stat HEAD
```

---
### Task 9: Adopters — Vaultwarden (generated Argon2id admin token) and Workspace (wide-charset admin password)

**Files:**
- Modify: `bundles/vaultwarden/manifest.json`, `bundles/vaultwarden/server/server.js`, `bundles/vaultwarden/skills/vaultwarden.md`
- Modify: `bundles/workspace/manifest.json`, `bundles/workspace/ops/lib.sh`, `bundles/workspace/ops/bootstrap.sh`, `bundles/workspace/ops/reset-password.sh`
- Create: `bundles/workspace/ops/envfile.py`
- Modify: `tests/workspace-bundle.test.js:81-82` (the old narrow-charset assertions), `tests/workspace-bootstrap.test.js` (new tests)
- Create: `tests/vaultwarden-bundle.test.js`
- Regenerate: `registry/add-ons.json`

**Interfaces:**
- Consumes: Task 1 `formatEnvLines`/`parseEnvText`, Task 2 `argon2idPhc`/`verifyArgon2idPhc`, `env_vars` fields `generate`/`keychain`/`store_as`/`keychain_label`/`keychain_username`/`keychain_url`.
- Produces:
  - `bundles/workspace/ops/envfile.py get <file> <KEY>`: prints the decoded value with no newline; exit 0 when the key is absent; exit 2 on bad usage.
  - `env_get KEY` in `lib.sh`, which reads `$ENV_FILE` (default `$BUNDLE_DIR/.env`) through it.

- [ ] **Step 1: Write the failing tests**

Create `tests/vaultwarden-bundle.test.js`:

```js
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

test("the bundle pins the Bitwarden CLI exactly", () => {
  const pkg = JSON.parse(readFileSync(join(DIR, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["@bitwarden/cli"], "2026.9.1");
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
```

In `tests/workspace-bundle.test.js`, replace the two lines

```js
  assert.ok(new RegExp(v.pattern).test("Correct-Horse-Battery-9"));
  assert.ok(!new RegExp(v.pattern).test("has $ dollar 123"));
```

with

```js
  const re = new RegExp(v.pattern);
  for (const ok of ["Correct-Horse-Battery-9", "has $ dollar 123", "it's \"quoted\" #1", "back\\slash and é😀 ok"]) assert.ok(re.test(ok), ok);
  for (const bad of ["short-1", "tab\there-123456", "line\nbreak-123456", "x".repeat(129)]) assert.ok(!re.test(bad), JSON.stringify(bad));
  assert.equal(v.keychain_username, "${WORKSPACE_ADMIN_USER}");
```

Add `import { formatEnvLines } from "../servers/gateway/bundle-env-codec.js";` and `import { randomInt } from "node:crypto";` to the imports at the top of `tests/workspace-bootstrap.test.js`, then append:

```js
const WIDE_PW = "p a$s'w\"d #1 \\ é😀 ok";

test("REVIEW FOCUS 1 (ops) — bootstrap pipes the exact wide-charset admin password", () => {
  const ctx = setup();
  const vars = { WORKSPACE_ADMIN_USER: "admin", ...SECRETS, WORKSPACE_ADMIN_PASSWORD: WIDE_PW, WORKSPACE_PUBLIC_HOST: "", WORKSPACE_NC_SERVE_PORT: "8456", WORKSPACE_OO_SERVE_PORT: "8457" };
  writeFileSync(join(ctx.bundle, ".env"), formatEnvLines(vars), { mode: 0o600 });
  const r = run("bootstrap.sh", ctx);
  assert.equal(r.status, 0, r.out);
  assert.ok(read(ctx, "stdin.log").includes(`user:resetpassword --password-from-env admin] ${vars.WORKSPACE_ADMIN_PASSWORD}\n`), "byte-exact on stdin");
  assert.ok(!read(ctx, "calls.log").includes("p a$s"), "never argv");
  assert.ok(!r.out.includes("p a$s"), "never printed");
});

test("reset-password.sh accepts any printable 12-128 chars, refuses control characters", () => {
  const ctx = setup();
  const ok = run("reset-password.sh", ctx, ["admin"], { input: "it's a $ \"wide\" pass #1\n" });
  assert.equal(ok.status, 0, ok.out);
  assert.match(read(ctx, "stdin.log"), /user:resetpassword --password-from-env admin\] it's a \$ "wide" pass #1/);
  assert.notEqual(run("reset-password.sh", ctx, ["admin"], { input: "tab\there-123456\n" }).status, 0);
  assert.notEqual(run("reset-password.sh", ctx, ["admin"], { input: "short\n" }).status, 0);
});

test("envfile.py decodes exactly what the gateway codec writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-envfile-"));
  const pool = []; for (let c = 0x20; c < 0x7f; c++) pool.push(String.fromCharCode(c)); pool.push("é", "😀");
  const vals = {};
  for (let i = 0; i < 40; i++) {
    let s = ""; const n = randomInt(1, 24); for (let j = 0; j < n; j++) s += pool[randomInt(pool.length)];
    if (s.includes("`") && (s.includes("'") || s.endsWith("\\"))) s = s.replace(/`/g, "");
    vals[`K${i}`] = s;
  }
  writeFileSync(join(dir, ".env"), "# comment\nexport KX=plain\n" + formatEnvLines(vals));
  for (const [k, v] of Object.entries({ ...vals, KX: "plain" })) {
    const r = spawnSync("python3", [join(OPS, "envfile.py"), "get", join(dir, ".env"), k], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, v, `${k} ${JSON.stringify(v)}`);
  }
  assert.equal(spawnSync("python3", [join(OPS, "envfile.py"), "get", join(dir, ".env"), "MISSING"], { encoding: "utf8" }).stdout, "");
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
npm test -- tests/vaultwarden-bundle.test.js
npm test -- tests/workspace-bundle.test.js
npm test -- tests/workspace-bootstrap.test.js
```

Expected:
- vaultwarden: FAIL on `version` (`1.0.0`);
- workspace-bundle: FAIL on `"has $ dollar 123"`;
- workspace-bootstrap: FAIL on the new tests (`envfile.py` is missing, the pattern is narrow).

- [ ] **Step 3: Create `bundles/workspace/ops/envfile.py`**

```python
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
```

Then `chmod 755 bundles/workspace/ops/envfile.py`.

- [ ] **Step 4: No-eval reads in the Workspace ops scripts**

`bundles/workspace/ops/lib.sh`: after the `DC="${WORKSPACE_DC:-docker compose}"` line, add:

```bash
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# env_get KEY: the value compose would see, decoded by ops/envfile.py (no eval, no sed):
# the installer quotes values with spaces, quotes, $ or # (bundle-env-codec.js), so a
# raw `sed s/^KEY=//` would return the QUOTED text. ENV_FILE defaults to the bundle .env.
env_get() {
  local f="${ENV_FILE:-$BUNDLE_DIR/.env}"
  [ -f "$f" ] || return 0
  python3 "$OPS_DIR/envfile.py" get "$f" "$1"
}
```

`bundles/workspace/ops/bootstrap.sh`: delete its own definition line

```bash
env_get() { [ -f "$ENV_FILE" ] || return 0; sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
```

so that `lib.sh`'s `env_get` is used. `ENV_FILE` is already set to `"$BUNDLE_DIR/.env"` above it. `env_set`/`env_unset` are unchanged: they write hostnames, the occ-minted alphanumeric token and `1`, all bare-safe.

`bundles/workspace/ops/reset-password.sh`: replace

```bash
[[ "$PW" =~ ^[A-Za-z0-9!%*+,./:=?@^_~-]{12,128}$ ]] || die "password must be 12-128 letters, digits or ! % * + , - . / : = ? @ ^ _ ~"
```

with

```bash
{ [ "${#PW}" -ge 12 ] && [ "${#PW}" -le 128 ]; } || die "password must be 12-128 characters"
case "$PW" in *[[:cntrl:]]*) die "password must not contain tabs, line breaks or other control characters" ;; esac
```

- [ ] **Step 5: Workspace manifest**

In `bundles/workspace/manifest.json`, set `"version": "0.1.2"` and replace the `WORKSPACE_ADMIN_PASSWORD` entry with:

```json
    {
      "name": "WORKSPACE_ADMIN_PASSWORD",
      "description": "Password for that administrator account. Use Generate for a strong one or type your own: 12-128 characters, any letters, digits, spaces or symbols. Keep 'Save to Crow keychain' ticked to find it later in Settings → Passwords. Setup uses it once, then removes it from this machine's config; change it later inside Workspace (Settings, Security).",
      "install_required": true, "secret": true, "propagate": false, "check": "not_breached",
      "pattern": "^[^\\x00-\\x1f\\x7f]{12,128}$",
      "pattern_hint": "12-128 characters, without tabs or line breaks",
      "keychain_label": "admin password",
      "keychain_username": "${WORKSPACE_ADMIN_USER}"
    },
```

- [ ] **Step 6: Vaultwarden manifest, MCP tool and skill**

`bundles/vaultwarden/manifest.json`:

1. `"version": "1.1.0"`.
2. `"server": { "command": "node", "args": ["server/index.js"], "envKeys": ["VAULTWARDEN_URL"] }`.
3. `"requires": { "min_ram_mb": 256, "min_disk_mb": 200 }`.
4. Replace the `VAULTWARDEN_ADMIN_TOKEN` entry with:

```json
    { "name": "VAULTWARDEN_ADMIN_TOKEN", "description": "Token for the /admin page. Crow generates it at install, keeps only an Argon2id hash in this extension's settings, saves the token itself in Settings → Passwords (encrypted, this machine only) and shows it to you once after install.", "required": true, "secret": true, "generate": "secret", "keychain": true, "store_as": "argon2id", "keychain_label": "admin page token", "keychain_url": "${VAULTWARDEN_DOMAIN}/admin" },
```

5. In `install_consent_messages.en`, replace `(2) the admin token sits in your .env file in plaintext — anyone with shell access on this host can administer the vault;` with `(2) Crow generates the admin token, keeps only its Argon2id hash in the extension's settings, and saves the token in Settings → Passwords (encrypted, this machine only);`.
6. In `.es`, replace `(2) el token de administrador queda en el archivo .env en texto plano — cualquiera con acceso al shell puede administrar el vault;` with `(2) Crow genera el token de administrador, guarda solo su hash Argon2id en la configuración de la extensión y guarda el token en Ajustes → Contraseñas (cifrado, solo en esta máquina);`.

`bundles/vaultwarden/server/server.js`:
- delete the `const ADMIN_TOKEN = () => …;` line;
- in the header list, change `vaultwarden_user_count   How many accounts exist? (via /admin)` to `vaultwarden_user_count   Explains where to see accounts (the admin API is browser-session only)`;
- replace the whole `server.tool("vaultwarden_user_count", …)` call with:

```js
  server.tool(
    "vaultwarden_user_count",
    "Explain how to see Vaultwarden's accounts. Vaultwarden's admin API only accepts the browser session created by its /admin login page, and Crow keeps the admin token as a hash, so this tool cannot list accounts itself.",
    {},
    async () => ({
      content: [{
        type: "text",
        text: `Not available from here: Vaultwarden's admin API only accepts the browser session created by its /admin login page, and Crow stores the admin token as an Argon2id hash. Open ${VAULTWARDEN_URL()}/admin and sign in with the token from Crow's Settings → Passwords to see accounts.`,
      }],
    }),
  );
```

`bundles/vaultwarden/skills/vaultwarden.md`: replace step 1 (from `1. **Generate an admin token:**` through `raw token and keep \`.env\` readable only by your user.`) with:

```markdown
1. **Admin token: nothing to do.** Crow generates it when you install the
   extension, keeps only an Argon2id hash in the extension's settings, and
   saves the token itself in **Settings → Passwords** (encrypted, this machine
   only). The Extensions page shows it to you once right after install; later,
   reveal it from Settings → Passwords (Crow asks you to confirm it's you).
   Use it to sign in at `/admin`.
```

- [ ] **Step 7: Rebuild the registry and run everything touched**

```bash
node scripts/build-registry.mjs
node scripts/build-registry.mjs --check
npm test -- tests/vaultwarden-bundle.test.js
npm test -- tests/workspace-bundle.test.js
npm test -- tests/workspace-bootstrap.test.js
npm test -- tests/workspace-panel.test.js
npm test -- tests/bundle-server-deps.test.js
```

Expected: all PASS; `--check` OK.

- [ ] **Step 8: Commit**

```bash
git add bundles/workspace/ops/envfile.py tests/vaultwarden-bundle.test.js
git commit bundles/workspace/ops/envfile.py tests/vaultwarden-bundle.test.js bundles/vaultwarden/manifest.json bundles/vaultwarden/server/server.js bundles/vaultwarden/skills/vaultwarden.md bundles/workspace/manifest.json bundles/workspace/ops/lib.sh bundles/workspace/ops/bootstrap.sh bundles/workspace/ops/reset-password.sh tests/workspace-bundle.test.js tests/workspace-bootstrap.test.js registry/add-ons.json -m "feat(bundles): Vaultwarden generates an Argon2id admin token into the keychain; Workspace admin password takes any printable character (vaultwarden 1.1.0, workspace 0.1.2)"
git show --stat HEAD
```

---

### Task 10: Full local gates

**Files:** none (verification only; fix commits go to the task that owns the code).

- [ ] **Step 1: Every CI gate locally**

```bash
cd ~/crow-wt-keychain
npm test                                   # FULL suite; 0 failures (compare with the Task 0 baseline)
node scripts/check-port-allocation.js      # OK (no new ports)
node scripts/build-registry.mjs --check    # OK
npm audit --omit=dev --audit-level=critical || true   # root deps unchanged; record the result
npm test -- tests/auth-network.test.js     # PASS
```

- [ ] **Step 2: Secret-hygiene greps** (each must print nothing)

```bash
git diff origin/main --name-only | xargs grep -nE "console\.(log|error|warn)\([^)]*(secret|password|masterPassword|plain)\b" || true
grep -rnE "argv|args:.*(masterPassword|password)" servers/gateway/keychain/vault-save.js | grep -v "passwordenv" || true
```

Read every hit. A hit is acceptable only if the logged text is a fixed string or a key name.

- [ ] **Step 3: Push the branch**

```bash
git pull --rebase origin main
git push -u origin feat/crow-keychain
```

---
### Task 11: PRE-MERGE attended smoke window on crow (throwaway CROW_HOME, deadman-guarded) — LIVE

**What it proves**, before anything merges:
1. a generated token's Argon2id PHC, written by the branch's installer code, is accepted by a real Vaultwarden 1.32.7 at `/admin` (and a wrong token is refused);
2. the Bitwarden CLI save works against that Vaultwarden, with the master password never in argv and no appdata left behind;
3. wide-charset values survive a real `docker compose` container start.

**What it touches:**
- scratch dirs only, under `/tmp/claude-1000/kc-smoke`;
- one throwaway Vaultwarden (compose project `crow-kc-smoke`, container `crow-kc-smoke-vw`, `127.0.0.1:18097`, `restart: "no"`);
- a one-shot `alpine` env-check container;
- a temporary tailnet-only Serve mapping, HTTPS `8461` → `127.0.0.1:18097`, for the [KEVIN] registration step.

Prod is never stopped and no model container is touched. 18097 and 8461 were verified free on 2026-10-03 (`ss -ltn`; `tailscale serve status` shows 8444–8455, 8600, 12393 and others, but not 8461). Re-check both in Step 1.

**Helpers** are transient user units, each with its own cap:
- `kc-smoke-deadman` (a timer, 2 h);
- `kc-smoke-sampler` (`RuntimeMaxSec=7200`), which records argv.

Every step starts with `source /tmp/claude-1000/kc-smoke/vars.sh`, because tool calls do not keep shell state.

**Sudo** (Serve only): `sudo -S` with the credential from the global CLAUDE.md, never written to a file or into this plan; or Kevin runs those two lines. The deadman cannot sudo, so a stale Serve mapping (tailnet-only, it just 502s) is the only possible deadman-path leftover. The teardown log says so.

**Findings** go in `$SMOKE/findings.md`. Any FAIL means a fix commit on the branch with its unit test, and a re-run of the affected step in a new registered window, all before Task 12.

**Files:** no repo files.

- [ ] **Step 1: Check, register, write helpers, arm the deadman**

```bash
ss -ltn | grep -E ':(18097)\b' && echo "18097 BUSY — pick another and update vars" || echo "18097 free"
tailscale serve status | grep -q ':8461' && echo "8461 BUSY" || echo "8461 free"
docker ps -a --format '{{.Names}}' | grep -E '^crow-kc-smoke' && echo "stale smoke containers — run teardown first" || echo "clean"
```

Read `~/CROW-SCHEDULE.md`, check for conflicts, then add a Reservations row:

```markdown
| **2026-10-0X HH:MM → +2 h hard cap (attended; transient units kc-smoke-{deadman,sampler}; deadman tears down at the cap)** | **Crow keychain PRE-MERGE smoke**: throwaway Vaultwarden 1.32.7 `crow-kc-smoke` on 127.0.0.1:18097 + temp Serve 8461 (tailnet only); one-shot alpine env-check; scratch CROW_HOME/CROW_DATA_DIR under /tmp/claude-1000/kc-smoke. No GPU, no model containers, prod untouched. | Claude session (crow) + Kevin | manual | no crow-kc-smoke* containers AND `systemctl --user list-units 'kc-smoke-*'` empty AND serve 8461 off AND no /tmp/crow-bw-* dirs AND row moved to Done |
```

Then:

```bash
SMOKE=/tmp/claude-1000/kc-smoke; rm -rf $SMOKE; mkdir -p $SMOKE; chmod 700 $SMOKE
cat > $SMOKE/vars.sh <<'EOF'
# Sourced at the top of EVERY smoke step.
SMOKE=/tmp/claude-1000/kc-smoke
REPO=$HOME/crow-wt-keychain
B=$SMOKE/vaultwarden
H=crow.dachshund-chromatic.ts.net
export CROW_HOME=$SMOKE/home CROW_DATA_DIR=$SMOKE/data CROW_AUTO_UPDATE=0 CROW_DISABLE_INSTANCE_SYNC=1 CROW_DISABLE_HEALTH_MONITOR=1 CROW_DISABLE_NOSTR=1
SDC="docker compose -p crow-kc-smoke -f docker-compose.yml -f smoke.override.yml"
sdc() { (cd $B && $SDC "$@"); }
EOF
cat > $SMOKE/teardown.sh <<'EOF'
#!/usr/bin/env bash
# Out-of-process teardown (deadman + normal end). Idempotent; label-based fallback.
SMOKE=/tmp/claude-1000/kc-smoke
systemctl --user stop kc-smoke-sampler.service 2>/dev/null
[ -f $SMOKE/vaultwarden/.env ] && (cd $SMOKE/vaultwarden && docker compose -p crow-kc-smoke -f docker-compose.yml -f smoke.override.yml down -v --remove-orphans) 2>/dev/null
for p in crow-kc-smoke crow-kc-envcheck; do
  docker ps -aq --filter label=com.docker.compose.project=$p | xargs -r docker rm -f 2>/dev/null
  docker network rm ${p}_default 2>/dev/null
done
rm -rf /tmp/crow-bw-* 2>/dev/null
[ -d $SMOKE/vwdata ] && docker run --rm -v $SMOKE:/s alpine:latest rm -rf /s/vwdata 2>/dev/null
echo "teardown done $(date +%T). Serve 8461 needs: sudo tailscale serve --https=8461 off (the deadman cannot sudo; a stale mapping only 502s)" >> $SMOKE/teardown.log
EOF
cat > $SMOKE/sampler.sh <<'EOF'
#!/usr/bin/env bash
# kc-smoke-sampler: every 0.1 s, record argv of node/bw processes (dedup, flushed per line).
while :; do ps -eo args | grep -E 'bw\.js|node ' | grep -v grep; sleep 0.1; done \
  | awk '!seen[$0]++ { print; fflush() }' > /tmp/claude-1000/kc-smoke/argv.log
EOF
chmod +x $SMOKE/teardown.sh $SMOKE/sampler.sh
systemd-run --user --unit=kc-smoke-deadman --on-active=7200 /bin/bash $SMOKE/teardown.sh
systemctl --user list-timers kc-smoke-deadman.timer
```

- [ ] **Step 2: Scratch Vaultwarden copy with the CLI; pull the image**

```bash
source /tmp/claude-1000/kc-smoke/vars.sh
docker pull vaultwarden/server:1.32.7
cp -r $REPO/bundles/vaultwarden $B
(cd $B && npm install --omit=dev --no-audit --no-fund)
node $B/node_modules/@bitwarden/cli/build/bw.js --version        # 2026.9.1
cat > $B/smoke.override.yml <<'EOF'
services:
  vaultwarden:
    container_name: crow-kc-smoke-vw
    restart: "no"
    ports: !override
      - "127.0.0.1:18097:80"
EOF
mkdir -p $CROW_HOME $CROW_DATA_DIR $SMOKE/vwdata
(cd $REPO && node scripts/init-db.js >/dev/null) && echo "scratch db ready"
```

- [ ] **Step 3: Write the `.env` and the keychain entry with the BRANCH's installer code**

```bash
source /tmp/claude-1000/kc-smoke/vars.sh
cd $REPO && B=$B SMOKE=$SMOKE node --input-type=module -e '
import { readFileSync } from "node:fs";
const B = process.env.B, SMOKE = process.env.SMOKE;
const { resolveGeneratedEnvDetailed } = await import("./servers/gateway/bundle-env-secrets.js");
const { writeInstallEnv } = await import("./servers/gateway/routes/bundles.js");
const { recordKeychainForInstall } = await import("./servers/gateway/keychain/install-hooks.js");
const manifest = JSON.parse(readFileSync(`${B}/manifest.json`, "utf8"));
const { env, minted } = resolveGeneratedEnvDetailed("vaultwarden", manifest, { destDir: B, crowHome: process.env.CROW_HOME });
const installEnv = { VAULTWARDEN_URL: "http://127.0.0.1:18097", VAULTWARDEN_DOMAIN: "https://crow.dachshund-chromatic.ts.net:8461", VAULTWARDEN_SIGNUPS_ALLOWED: "true", VAULTWARDEN_DATA_DIR: `${SMOKE}/vwdata`, ...env };
writeInstallEnv(B, installEnv, manifest);
const out = await recordKeychainForInstall({ bundleId: "vaultwarden", manifest, env: installEnv, minted, keychainReq: null, log: (m) => console.log("[job]", m) });
console.log("minted keys:", Object.keys(minted), "keychain saved:", out.saved, "first-view ids:", out.firstView);
console.log(".env token starts:", env.VAULTWARDEN_ADMIN_TOKEN.slice(0, 32));
process.exit(0);
'
grep -c '^VAULTWARDEN_ADMIN_TOKEN=.\$argon2id' $B/.env    # 1 (single-quoted PHC)
stat -c '%a' $B/.env                                       # 600
```

PASS: `minted keys: [ 'VAULTWARDEN_ADMIN_TOKEN' ]`, `keychain saved: 1`, a `$argon2id$v=19$m=65540,t=3,p=4$` prefix, and the `.env` line single-quoted.

- [ ] **Step 4: Start the throwaway Vaultwarden; prove the PHC reached the container intact and is accepted**

```bash
source /tmp/claude-1000/kc-smoke/vars.sh
sdc up -d
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:18097/alive >/dev/null 2>&1 && break; sleep 2; done; curl -fsS http://127.0.0.1:18097/alive && echo " alive"
# container env == .env value (compared by hash; nothing printed)
A=$(docker exec crow-kc-smoke-vw printenv ADMIN_TOKEN | sha256sum | cut -c1-16)
E=$(cd $REPO && B=$B node --input-type=module -e 'import { readFileSync } from "node:fs"; import { parseEnvText } from "./servers/gateway/bundle-env-codec.js"; process.stdout.write(parseEnvText(readFileSync(process.env.B + "/.env","utf8")).VAULTWARDEN_ADMIN_TOKEN + "\n")' | sha256sum | cut -c1-16)
[ "$A" = "$E" ] && echo "PASS container ADMIN_TOKEN == .env PHC" || echo "FAIL $A != $E"
docker logs crow-kc-smoke-vw 2>&1 | grep -ci "plain text ADMIN_TOKEN\|invalid.*argon2\|PHC" || echo "PASS no plaintext/PHC warnings"
# /admin login with the KEYCHAIN plaintext (read in-process; never printed, never argv)
cd $REPO && node --input-type=module -e '
const { createDbClient } = await import("./servers/db.js");
const { loadOrCreateIdentity } = await import("./servers/sharing/identity.js");
const K = await import("./servers/gateway/keychain/store.js");
const db = createDbClient();
const e = (await K.listEntries(db)).find((x) => x.env_key === "VAULTWARDEN_ADMIN_TOKEN");
const tok = await K.openEntrySecret(db, loadOrCreateIdentity(), e.id);
const login = (t) => fetch("http://127.0.0.1:18097/admin", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: t }) });
const good = await login(tok);
const bad = await login(tok + "x");
console.log("good:", good.status, /VW_ADMIN=/.test(good.headers.get("set-cookie") || "") ? "VW_ADMIN cookie set" : "NO COOKIE");
console.log("bad:", bad.status, /VW_ADMIN=/.test(bad.headers.get("set-cookie") || "") ? "COOKIE SET (FAIL)" : "no cookie");
console.log("entry url:", e.url, "first_view_pending:", e.first_view_pending);
db.close();
'
```

PASS:
- `good: 200 VW_ADMIN cookie set` (or 303 with the cookie);
- `bad: 401 no cookie`;
- `entry url: https://crow.dachshund-chromatic.ts.net:8461/admin first_view_pending: true`.

- [ ] **Step 5: [KEVIN] Register a throwaway vault account**

```bash
sudo -S tailscale serve --bg --https=8461 http://127.0.0.1:18097     # credential per global CLAUDE.md, or Kevin runs it
tailscale serve status | grep -A1 8461
```

**[KEVIN]:**
1. Open `https://crow.dachshund-chromatic.ts.net:8461/`.
2. Create account `kc-smoke@example.invalid` with a throwaway master password (**not** a real one). Do not type it into the Claude session.
3. Say "registered".

- [ ] **Step 6: [KEVIN] Bitwarden-CLI save, run by Kevin in his own terminal (the master password never enters the transcript)**

Write the script (Claude), then Kevin runs it:

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
run() {  # $1 = master password to use; the node child reads both lines from stdin (never argv/env)
  printf '%s\n%s\n' "$EMAIL" "$1" | node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const [email, master] = readFileSync(0, "utf8").split("\n");
    const { vaultwardenStatus, saveToVault } = await import("./servers/gateway/keychain/vault-save.js");
    const st = vaultwardenStatus({ bundlesDir: process.env.SMOKE });
    const out = await saveToVault({ cliPath: st.cliPath, serverUrl: "http://127.0.0.1:18097", email, masterPassword: master,
      item: { name: "kc-smoke wide", username: "admin", password: "p a$s\x27w\"d #1 \\ é😀 ok", url: "https://example.invalid", notes: "Crow keychain smoke" } });
    console.log(JSON.stringify(out));'
}
echo "== right password ==";  run "$MASTER"
echo "== wrong password ==";  run "${MASTER}-wrong"
sleep 1
grep -cF -- "$MASTER" $SMOKE/argv.log && echo "FAIL: master password seen in argv" || echo "PASS: master password never in argv"
ls -d /tmp/crow-bw-* 2>/dev/null && echo "FAIL: appdata left behind" || echo "PASS: no appdata left"
unset MASTER
EOF
chmod 700 $SMOKE/vault-save.sh
echo "Kevin: bash $SMOKE/vault-save.sh"
```

**[KEVIN]** runs it, then pastes back only its output. PASS:
- `{"ok":true}`;
- then `{"ok":false,"reason":"Vaultwarden did not accept that email or master password."}`;
- `PASS: master password never in argv`;
- `PASS: no appdata left`.

**[KEVIN]** then opens the web vault and checks that the item `kc-smoke wide` exists with username `admin`, URL `https://example.invalid`, and password exactly ``p a$s'w"d #1 \ é😀 ok`` (reveal it in the web vault).

If the real CLI's wrong-password text does not map to that sentence, record it in findings. Adjust `classifyLogin` with a unit-test case using the real text, and re-run this step.

- [ ] **Step 7: Wide-charset values through a real container start**

```bash
source /tmp/claude-1000/kc-smoke/vars.sh
mkdir -p $SMOKE/envcheck
cd $REPO && SMOKE=$SMOKE node --input-type=module -e '
import { writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
const { formatEnvLines, envValueProblem } = await import("./servers/gateway/bundle-env-codec.js");
const pool = []; for (let c = 0x20; c < 0x7f; c++) pool.push(String.fromCharCode(c)); pool.push("é", "😀", "\t");
const vals = { K0: "p a$s\x27w\"d #1 \\ é😀 ok", K1: "$argon2id$v=19$m=65540,t=3,p=4$abc$def", K2: "${HOME}", K3: "$(id)" };
for (let i = 4; i < 300; i++) { let s = ""; const n = randomInt(1, 30); for (let j = 0; j < n; j++) s += pool[randomInt(pool.length)]; if (!envValueProblem(s)) vals["K" + i] = s; }
const dir = process.env.SMOKE + "/envcheck";
writeFileSync(dir + "/.env", formatEnvLines(vals));
writeFileSync(dir + "/expected.json", JSON.stringify(vals));
writeFileSync(dir + "/docker-compose.yml", "services:\n  t:\n    image: alpine:latest\n    entrypoint: [\"/bin/sh\", \"-c\", \"for k in $$(env | cut -d= -f1 | grep -E \x27^K[0-9]+x?$$\x27); do printf \x27%s\\\\0%s\\\\0\x27 \\\"$$k\\\" \\\"$$(printenv $$k)\\\"; done\"]\n    env_file: .env\n    environment:\n" + Object.keys(vals).map((k) => "      " + k + "x: ${" + k + "}\n").join(""));
'
cd $SMOKE/envcheck && docker compose -p crow-kc-envcheck run --rm -T t > got.bin 2>err.txt; echo "rc=$?"
cd $REPO && SMOKE=$SMOKE node --input-type=module -e '
import { readFileSync } from "node:fs";
const dir = process.env.SMOKE + "/envcheck";
const want = JSON.parse(readFileSync(dir + "/expected.json", "utf8"));
const parts = readFileSync(dir + "/got.bin", "utf8").split("\0"); const got = {};
for (let i = 0; i + 1 < parts.length; i += 2) got[parts[i]] = parts[i + 1];
let bad = 0;
for (const [k, v] of Object.entries(want)) for (const kk of [k, k + "x"]) if (got[kk] !== v) { bad++; if (bad < 6) console.log("MISMATCH", kk, JSON.stringify(v), JSON.stringify(got[kk])); }
console.log(bad === 0 ? `PASS ${Object.keys(want).length} values x2 (env_file + interpolation) exact in a running container` : `FAIL ${bad}`);
'
docker compose -p crow-kc-envcheck -f $SMOKE/envcheck/docker-compose.yml down --remove-orphans 2>/dev/null
```

`printenv` drops a value's trailing newline only, and the codec refuses newlines, so the comparison is exact. If the generated compose YAML fails to parse (quoting in the one-liner), write the file with a heredoc instead. The assertion is the deliverable, not the one-liner.

- [ ] **Step 8: Teardown, verify, clear the schedule row, record findings**

```bash
source /tmp/claude-1000/kc-smoke/vars.sh
sudo -S tailscale serve --https=8461 off            # or Kevin
systemctl --user stop kc-smoke-deadman.timer kc-smoke-sampler.service 2>/dev/null
bash $SMOKE/teardown.sh
docker ps -a --format '{{.Names}}' | grep -E '^crow-kc' || echo "no smoke containers"
systemctl --user list-units 'kc-smoke-*' --no-legend | wc -l          # 0
tailscale serve status | grep -c 8461                                   # 0
ls -d /tmp/crow-bw-* 2>/dev/null | wc -l                                # 0
```

Write `$SMOKE/findings.md`: each step PASS/FAIL with its evidence line. Copy it to `~/crow-weekend-push/reports/crow-keychain-smoke-findings.md`, move the schedule row to Done, and `rm -rf $SMOKE` after copying.

---

### Task 12: PR, merge (after Kevin's OK), deploy, post-deploy acceptance

**Files:** none (PR/deploy).

- [ ] **Step 1: Re-run the gates on the final branch and push**

```bash
cd ~/crow-wt-keychain
git pull --rebase origin main
npm test
node scripts/build-registry.mjs --check
git push origin feat/crow-keychain
```

- [ ] **Step 2: Open the PR** with `mcp__github__create_pull_request`:
- owner `kh0pp`, repo `crow`, head `feat/crow-keychain`, base `main`;
- title "Crow keychain: Generate on password fields, compose-exact .env quoting, local Passwords page, Vaultwarden adopters";
- body:
  - one paragraph per spec §5 area;
  - the Rulings (spec R1–R17, plan P1–P8);
  - the smoke findings summary inline plus the path `~/crow-weekend-push/reports/crow-keychain-smoke-findings.md`;
  - the flagged items for Kevin (R11 vault email in `bw login` argv; R16 Generate on API-key fields);
  - "Version bumps: vaultwarden 1.1.0, workspace 0.1.2".
- No AI attribution.

- [ ] **Step 3: Gate on check-runs**

```bash
SHA=$(git -C ~/crow-wt-keychain rev-parse HEAD)
curl -s "https://api.github.com/repos/kh0pp/crow/commits/$SHA/check-runs" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); runs=d["check_runs"]; print(len(runs)); [print(r["name"], r["status"], r["conclusion"]) for r in runs]'
```

Every run must be `completed success` (`suite`, `static-checks`, `audit`). An empty list on a current sha is wrong, not normal.

- [ ] **Step 4: [KEVIN] Approve the merge.** Do not merge without Kevin's explicit OK in chat. Then `mcp__github__merge_pull_request` (squash) and record the merge sha.

- [ ] **Step 5: Deploy — crow** (never `git checkout` in `~/crow`)

```bash
git -C ~/crow branch --show-current                  # main
git -C ~/crow pull --ff-only origin main
git -C ~/crow log --oneline -1                       # the merge sha
sudo -S systemctl restart crow-gateway crow-r4-gateway
sleep 20; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/health   # 200
systemctl is-active crow-gateway crow-r4-gateway
node -e 'const D=require(process.env.HOME+"/crow/node_modules/better-sqlite3"); const d=new D(process.env.HOME+"/.crow/data/crow.db",{readonly:true}); console.log(d.prepare("SELECT name FROM sqlite_master WHERE name=\x27crow_keychain\x27").all().length ? "crow_keychain present" : "crow_keychain will be created on first use"); console.log(d.prepare("SELECT value FROM dashboard_settings WHERE key=\x27auto_update_last_result\x27").get()?.value)'
```

The last line must not start with "Skipped".

- [ ] **Step 6: Deploy — grackle and raven**

```bash
grackle "git -C ~/crow branch --show-current && git -C ~/crow pull --ff-only origin main && git -C ~/crow log --oneline -1"
grackle "sudo -S systemctl restart crow-gateway"     # credential per global CLAUDE.md
grackle "sleep 20; systemctl is-active crow-gateway; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3002/health"
ssh kh0pp@100.67.188.54 "systemctl list-units --type=service --no-legend '*crow*'; systemctl --user list-units --no-legend '*crow*'"
```

Use the raven unit the last command shows. Pull its checkout the same way (branch must be `main`), restart that one unit, and check its `/health` on 3009. If raven's gateway runs from a checkout that is not on `main`, stop and tell Kevin (CLAUDE.md "parked off main" rule).

- [ ] **Step 7: [KEVIN] Post-deploy acceptance on crow** (prod, harmless):
1. Settings → Passwords appears under Account, with "No saved passwords yet."
2. Add a test entry `kc-accept` / password `it's a $ "test" #1`.
3. Reveal it. Crow asks for the TOTP code or the dashboard password; after confirming, the exact text shows. Copy, then paste somewhere to compare.
4. Delete it (no second prompt within 5 minutes). Recent activity lists add / identity confirmed / revealed / copied / deleted.
5. Extensions → open the Install dialog for Workspace (do not install). The admin password field has Generate / Show / Copy and a ticked "Save to Crow keychain". Generate fills 24 characters. Cancel.

Record the results in the PR as a comment (`mcp__github__add_issue_comment`).

---

## Self-Review

**Spec coverage** (spec section → task):

| spec | task |
|---|---|
| §5.1 codec + readers/writers | 1 |
| §5.2 capability, argon2 PHC, templates, schema/contract | 2 |
| §5.3 table, lazy ensure, no gen bump, local-only guard | 3 |
| §5.4 re-auth + API + audit | 4 |
| §5.6 vault save, CLI dependency | 5 |
| §5.7 installer wiring | 6 |
| §5.5 modal, generator, first-view banner | 7 |
| §5.5 Settings → Passwords | 8 |
| §5.8 adopters, version bumps, registry | 9 |
| §8 unit gates | 10 |
| §8 live smoke | 11 |
| PR / merge / deploy | 12 |
| §9 follow-ups | listed only (no task, by decision 7) |

**Placeholder scan:** no TBD/TODO. Every code step carries code. Task 4's vault-save module is an explicit two-function placeholder, fully replaced in Task 5 Step 3, with its own failing test.

**Type consistency:**
- `resolveGeneratedEnvDetailed → { env, minted }` (Task 2) is used in Tasks 6 and 11.
- `saveExtensionSecret(db, identity, { bundleId, envKey, label, username, url, secret, origin, firstView, now })` (Task 3) is used in Tasks 4, 6 and 11.
- `vaultwardenStatus() → { installed, cliPath, serverUrl }` and `saveToVault({ cliPath, serverUrl, email, masterPassword, item })` (Task 5) are used in Tasks 4, 6, 8 and 11.
- `sanitizeKeychainRequest → { save, vault }` (Task 6) matches the client payload `keychain: { save, vault: { email, password } }` (Task 7).
- `/first-view` returns `{ secret }` or 410 `{ code: "first_view_spent" }` in both Task 4 and Task 7.

**Review Focus:** all five lines have pinned tests in their owning tasks (1, 2, 3, 4, 5, 6, 9).

**Unverified until the smoke, by design:**
- the real Vaultwarden accepting the PHC (Task 11 Step 4);
- the real `bw` 2026.9.1 messages and flow against Vaultwarden 1.32.7, including whether this Vaultwarden demands new-device verification (Step 6);
- the env-check one-liner's YAML quoting (Step 7 allows a heredoc fallback).

**Pre-flight (2026-10-03, while writing this plan):**

Every code block in Tasks 1–9 was applied mechanically to a throwaway copy of this branch (`rsync --exclude .git`) and run.
- Each task's new tests passed.
- `build-registry --check` was OK.
- The full suite (`node scripts/run-suite.mjs`) ran **6022 / 6023**. The single failure is `tests/convergence-unit.test.js` "a DISABLED instance still records its ACTUAL running sha"; it needs a `.git` checkout, which the copy deliberately lacked. The real worktree has one.
- The real-compose tests ran; they were not skipped.

This is evidence the code is internally consistent. It does not replace executing the plan task by task with TDD.
