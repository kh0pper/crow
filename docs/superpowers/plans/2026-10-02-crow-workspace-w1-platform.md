# Crow Workspace W1 (Platform) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `workspace` store extension (Nextcloud + MariaDB + Redis + ONLYOFFICE + cron) that installs on crow with only an admin password typed, configures itself, shows a phone-setup page, and backs itself up nightly, encrypted, to the external drive.

**Architecture:** Two generic installer features land first, and every bundle benefits from them. (1) `env_vars[].generate: "secret"` makes the installer mint internal secrets, keep them across reinstall, and write every bundle `.env` at mode 600. `propagate: false` and `pattern` keep values out of the gateway `.env` and reject unsafe input. (2) A first-party `postInstall` hook runs a bundle-local script after `docker compose up -d`, and `docker.precreate` creates host data folders first. The `workspace` bundle sits on top of them: a pinned, loopback-only compose file; an idempotent `ops/bootstrap.sh` that drives `occ`; `ops/backup.sh` with gpg plus a user systemd timer; and a server-rendered en/es setup panel. A live, registered acceptance window on crow closes it out.

**Tech Stack:** Node 24 (gateway, `node:test`), bash + `docker compose` + Nextcloud `occ`, gpg 2.4 (symmetric AES256), systemd user units, Tailscale Serve.

**Spec:** `docs/superpowers/specs/2026-10-02-crow-workspace-design.md` (§4 = W1). It is binding: where this plan and the spec disagree, the spec wins, and any deviation is listed under Rulings.

## Rulings (where the spec is silent; each grounded in evidence gathered 2026-10-02)

1. **Host ports: `127.0.0.1:3070` (Nextcloud) and `127.0.0.1:3071` (ONLYOFFICE). Serve HTTPS ports: `8456` → 3070 and `8457` → 3071.** Evidence that these are free:
   - not in `docs/developers/port-allocation.md`;
   - not in any of the 2,143 compose files under `/home/kh0pp` (depth 5, incl. `~/.crow/bundles` and crow-addons);
   - not in live `ss -ltn`;
   - not in `tailscale serve status`, which shows 8444–8446 and 8448–8455 plus 12393. 8447 is currently unused but was reserved by the caller, so it is skipped.

   3070/3071 sit in the "admin UIs 3000–3099" range. The only "3070" string in the repo is a source line number in an old spec.
2. **Pinned images** (Docker Hub API, 2026-10-02). They are recorded in the compose file, which `scripts/extract-bundle-images.py` and image-freshness read, and mirrored in `manifest.images`; a test keeps the two equal.
   - `nextcloud:34.0.4-apache`: same digest as `stable-apache`, `sha256:37b10988…`. `latest` is 35.0.1, a brand-new major, so it is not used.
   - `mariadb:11.8.9`: Nextcloud stable34's own system_requirements.rst lists "MariaDB 10.6 / 10.11 / 11.4 / **11.8** (recommended)".
   - `redis:8.2.10-alpine`.
   - `onlyoffice/documentserver:9.4.0.1`: same digest as `latest`, `sha256:3ab6ebc7…`.
3. **The generic secret generator** (config-friction stage 1; survey category F1):
   - Manifest field: `env_vars[].generate: "secret"`. The value is 32 random bytes, base64url, 43 chars, with no `$`, quote or space characters, so it is safe in compose `.env`, URLs and bash.
   - Values are **never regenerated on reinstall**, because a bind-mounted DB keeps the old password (the survey's own warning). The order is: installed `.env` value, then the retained copy, then a new value.
   - The retained copy lives at `${CROW_HOME}/secrets/bundle-env/<id>.env`: dir 700, file 600, and never deleted by uninstall. That is the survey's "one path `~/.crow/secrets/`" direction.
   - Generated keys are hidden from the install/Configure form, ignored if a request sends them, never install-blocking, and never propagated to the gateway `.env`.
4. **Every bundle `.env` is written at mode 600**, both at install (all three ladder rungs) and on Configure. No shipped bundle bind-mounts its own `.env` into a container (checked: the only `.env` mounts are `~/.crow/env/*.env` in capstone-tracker and the llamacpp bundles), so 600 is safe fleet-wide. It fixes the survey's 644/777 finding for `phone/.env` and `media/.env`.
5. **`env_vars[].propagate: false`** keeps a declared var out of the gateway `.env`. Without it, `declaredEnvSubset` would copy `WORKSPACE_ADMIN_PASSWORD` into `~/crow/.env`.
6. **`env_vars[].pattern`** (an anchored regex) is enforced by `validateInstall` and the Configure route with a 400 `invalid_env`, before any file is written. Workspace uses it to restrict the admin password to `A–Z a–z 0–9 ! % * + , - . / : = ? @ ^ _ ~`, 12–128 chars. Those characters are inert in a compose `.env` (no `$` interpolation, no ` #` comment), in bash, and in `occ` arguments. Kevin types the password once, so a clear up-front refusal beats a half-installed bundle.
7. **The `postInstall` hook** is `{ "script": "<relative .sh>", "timeout_s": ≤1800 }`.
   - It runs `bash <installed dir>/<script>` after a *successful* `up -d`, with `cwd` = the bundle dir and `env` = `composeEnv` + `CROW_BUNDLE_DIR`.
   - It is honored for **first-party bundles only**: a manifest with `origin: "community"` is refused, because the hook runs host shell code.
   - If it fails, the install is still recorded (the same semantics as a compose-up failure), the job ends not-ok, and the exact re-run command is logged.
   - Its script's top-level dir is a manifest-declared refresh root, so a version bump re-copies `ops/`.
   - Alongside it: compose `pull`/`up` timeouts are raised from the 300 s `run()` default to 30 min. The ONLYOFFICE image is about 1.5 GB, and a slow pull would otherwise fail every first install.
8. **`docker.precreate`**: paths relative to `CROW_HOME`, created 0700 before `up`. Docker creates missing bind sources as **root**, which would leave `~/.crow/workspace` unwritable for the host-side backup script. Workspace precreates only `workspace` and `workspace/backups-staging`. The images create and chown their own subdirectories (the MariaDB entrypoint chowns its datadir; the Nextcloud entrypoint rsyncs with `--chown www-data`).
9. **Data layout** is `~/.crow/workspace/`:
   - `nextcloud/` holds the whole `/var/www/html`: code, config, `data/` and apps. The spec's `data/` is `nextcloud/data/`;
   - `db/`;
   - `backups-staging/`;
   - `backup-passphrase` (600).

   It sits on the main NVMe, never on `/mnt/external` or `/mnt/data`, as §4.4 requires. The backup tars **all** of `/var/www/html`. A restore that brings back only config+data finds `version.php` equal to the image version, so the entrypoint never re-copies the code.
10. **The compose project name is fixed: `name: crow-workspace`.** That means one Workspace per host, which matches the fixed ports. It also stops a second Crow instance's `~/.crow-r4/bundles/workspace` from silently sharing the project name `workspace`.
11. **No `ports` and no `webUI` in the manifest.** The installer turns `manifest.ports` into `sudo -n ufw allow` rules and `webUI.proxyMode: direct` into a same-number Serve port, which §4.2 does not want. On crow, `sudo -n` fails ("a password is required") and Tailscale has no operator user, so the installer cannot configure Serve anyway. Serve setup is therefore an **operator step**: the panel shows the two exact commands and the live task runs them.
12. **The tailnet hostname is derived at bootstrap** from `tailscale status --json` and stored as `WORKSPACE_PUBLIC_HOST` (overridable). A manifest may not contain `*.ts.net`, because the contract leak scan rejects it.
    - `overwritehost`/`overwriteprotocol`/`overwrite.cli.url` apply only to requests from the docker bridge gateway, via `overwritecondaddr`. ONLYOFFICE's server-to-server callbacks on `http://nextcloud/` therefore keep internal URLs.
    - `trusted_proxies` = that gateway IP.
13. **Backup timer.**
    - A bundle script the operator runs, `ops/install-backup-timer.sh`, writes **user** units, the same pattern as `crow-dayane-backup.timer`; `Linger=yes` is verified for kh0pp.
    - The timer fires at `04:20` daily. That is after crow-db-backup (03:15) and the dayane backup (03:40), and outside the 02:15–04:15 window-refusal band.
    - Two caps bound it: `TimeoutStartSec=2h` is the out-of-process cap, and an inner `timeout` limits maintenance mode to 30 min.
    - The archive is staged under `backups-staging` (newest kept) and copied to `/mnt/external/crow-workspace-backups` (14 days kept).
    - The file tar is taken **inside the container**, because the data is uid 33 / mode 0770 and the host user can't read it.
14. **Dayane's first-login password change**: Nextcloud core has no "must change password" flag. `ops/add-user.sh` prints a one-time password once, and changing it is a human acceptance step.
15. **MariaDB runs without `--log-bin`.** There is no replication, and binlogs would grow without bound (the default expiry is 0).
16. **The `nextcloud` bundle becomes `type: "skill"`, v1.1.0, with `deprecated.superseded_by: "workspace"`.** Its compose, `ports` and `webUI` are removed. The `8080` localai/nextcloud entry leaves `scripts/known-port-conflicts.json` and the doc's conflict table.
17. **`workspace` stays at version `0.1.0` for the whole PR.** It is installed nowhere until after merge, so the refresh-on-bump rule has no installed copy to miss.
18. **Panel strings are bundle-local en/es**, following the `phone` panel pattern (`T = { en, es }` plus a parity test), not the global dashboard i18n table. The panel is server-rendered and has no client script.
19. **Execution branch:** `feat/workspace-w1-platform`, cut from `docs/crow-workspace-spec` in `~/crow-wt-workspace`, so the spec and this plan travel in the same PR. Never `git checkout` in `~/crow`.

## Global Constraints

- Tailnet only, through Tailscale Serve HTTPS ports. **Never Funnel** (the network-exposure invariant). `tests/auth-network.test.js` must still pass, and a public-internet probe of both Serve ports must fail.
- All five services `restart: unless-stopped`, all published on `127.0.0.1` only; MariaDB healthchecked; ONLYOFFICE `JWT_ENABLED=true` with a generated secret.
- Images pinned by tag (no `latest`) and recorded in the manifest.
- Manifest declares `requires.min_ram_mb` and `min_disk_mb` (≈3–5 GB RAM, no GPU).
- The installer generates every internal secret into the bundle `.env` at **mode 600**; the only operator input is the admin password (never defaulted).
- Bootstrap is idempotent: each step checks existing state first.
- Data dir under `~/.crow/workspace/`, never NTFS `/mnt/external`, never `/mnt/data`.
- Backups are `gpg --symmetric` AES256 (no new package; `age` is NOT installed), maintenance mode is held only for dump + snapshot, a trap guarantees `--off`, the runtime is bounded by `timeout`, and 14 days are kept on `/mnt/external/crow-workspace-backups/`.
- Every window, first start and upgrade on crow is registered in `~/CROW-SCHEDULE.md` before it starts and cleared after.
- Repo rules (`CLAUDE.md`):
  - commit with positional paths: `git add <new files> && git commit <paths> -m …`, then `git show --stat HEAD`;
  - `git pull --rebase` before a push;
  - run tests via `npm test -- tests/<file>.test.js`, never raw `node --test`;
  - new host ports go in `docs/developers/port-allocation.md`;
  - `node scripts/build-registry.mjs --check` must pass;
  - bundle code changes need a `manifest.json` version bump;
  - no attribution of Claude in commits or PRs;
  - never `git checkout` in `~/crow`;
  - check-runs must all be `completed/success` before merge (CI red blocks every merge).
- `gh` is not installed on crow: PRs go through the GitHub MCP tools (repo `kh0pper/crow`).

## Review Focus

1. **Uninstall then reinstall Workspace** (or reinstall after a failed install): the household's DB and files are still on disk, so the reinstall must reuse the same DB/Redis/JWT secrets. A fresh random set would leave Nextcloud unable to log into its own database. *Pinned in Task 1:* `REVIEW FOCUS 1 — reinstall reuses retained secrets`.
2. **An admin password containing `$`, a space, `#`, a quote or `;`**: install must refuse up front with a clear message and leave nothing half-installed. Silently writing a value that compose interpolates or bash executes is the failure. *Pinned in Task 2:* `REVIEW FOCUS 2 — unsafe admin password refused before anything is written`.
3. **Re-running the bootstrap by hand** (after a timeout, or months later) must not create a second crow-bot, a second Menu calendar, or a pile of app passwords. If the bot's app password was lost from `.env`, it must mint exactly one new one. *Pinned in Task 5:* `REVIEW FOCUS 3 — second run changes nothing; lost token is re-minted once`.
4. **The nightly backup failing mid-run** (dump error, a hang, the external drive unplugged) must never leave Nextcloud in maintenance mode, which would lock the household out of their files, and must never leave a plaintext archive behind. *Pinned in Task 6:* `REVIEW FOCUS 4 — failure and hang still turn maintenance off; no plaintext left`.
5. **Secrets ending up where people can see them**: the gateway `.env`, the install job log, the Workspace page HTML, or process argv. Each is pinned by its owner:
   - Task 2: `REVIEW FOCUS 5a — generated and propagate:false keys never reach the gateway .env`;
   - Task 5: `REVIEW FOCUS 5b — bootstrap output never contains a secret; JWT not in argv`;
   - Task 7: `REVIEW FOCUS 5c — the page renders no secret value`.

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `servers/gateway/bundle-env-secrets.js` | Create | Generated secrets (resolve/retain), private file writes, gateway-exclusion and pattern checks: pure helpers, no route logic |
| `servers/gateway/bundle-lifecycle.js` | Create | `docker.precreate` dirs and the `postInstall` hook plan/runner: pure helpers with an injectable runner |
| `servers/gateway/routes/bundles.js` | Modify | Wire both helper modules into `writeInstallEnv`, `runInstallJob`, `validateInstall`, `installBlockingEnvKeys`, `declaredEnvSubset`, the Configure route, and `refreshVersionedBundle`; raise compose timeouts |
| `servers/gateway/dashboard/panels/extensions/html.js` | Modify | Hide `generate` vars from the client's install/Configure form data |
| `registry/manifest.schema.json` | Modify | Schema for `env_vars[].generate/propagate/pattern`, `docker.precreate`, `postInstall`, `images`, `deprecated` |
| `scripts/lib/bundle-contract.mjs` | Modify | Referential checks: `postInstall.script` exists, `docker.precreate` entries are safe relative paths |
| `bundles/workspace/manifest.json` | Create | The store entry |
| `bundles/workspace/docker-compose.yml` | Create | The five pinned, loopback-only services |
| `bundles/workspace/ops/bootstrap.sh` | Create | Idempotent `occ` configuration (the post-install hook) |
| `bundles/workspace/ops/add-user.sh` | Create | Household account plus a one-time password |
| `bundles/workspace/ops/backup.sh` | Create | Nightly encrypted backup |
| `bundles/workspace/ops/restore.sh` | Create | Decrypt and unpack an archive |
| `bundles/workspace/ops/restore-scratch.sh` | Create | Boot an archive in a throwaway compose project (acceptance §4.7-6) |
| `bundles/workspace/ops/restore-scratch.override.yml` | Create | Strip published ports for the scratch project |
| `bundles/workspace/ops/install-backup-timer.sh` | Create | User systemd units plus the passphrase |
| `bundles/workspace/panel/workspace.js` | Create | Server-rendered en/es phone/laptop setup page |
| `bundles/nextcloud/manifest.json` | Modify | Deprecated WebDAV-connect skill entry |
| `bundles/nextcloud/docker-compose.yml` | Delete | Removes the `changeme` defaults and the 8080 collision |
| `scripts/known-port-conflicts.json` | Modify | Drop the resolved 8080 entry |
| `docs/developers/port-allocation.md` | Modify | Rows 3070/3071/8456/8457; 8080 conflict resolved |
| `registry/add-ons.json` | Regenerate | `node scripts/build-registry.mjs` |
| `docs/guide/workspace.md` | Create | Operator guide: install, Serve, phones, backups, restore, upgrades |
| `docs/.vitepress/config.ts` | Modify | Sidebar entry |
| `tests/bundle-env-secrets.test.js` | Create | Task 1 |
| `tests/bundle-env-scoping.test.js` | Create | Task 2 |
| `tests/bundle-lifecycle-hooks.test.js` | Create | Task 3 |
| `tests/workspace-bundle.test.js` | Create | Task 4 |
| `tests/workspace-bootstrap.test.js` | Create | Task 5 |
| `tests/workspace-backup.test.js` | Create | Task 6 |
| `tests/workspace-panel.test.js` | Create | Task 7 |

Tasks 1–8 are **CI tasks**: code plus unit tests, and no container is ever started. Task 9 is the **LIVE task**: it runs on crow in a registered window and contains steps only Kevin can do. Those steps are marked **[KEVIN]**.

---

### Task 0: Branch and dependencies (setup, no commit)

- [ ] **Step 1: Cut the execution branch in the worktree**

```bash
cd ~/crow-wt-workspace
git status --short            # expect clean (spec + this plan committed on docs/crow-workspace-spec)
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
- Modify: `servers/gateway/routes/bundles.js`: fs import (line 25), `writeInstallEnv` (~1836–1859), `runInstallJob` step 2 (~1960), Configure route `POST /bundles/api/env` (~3042–3090)
- Modify: `registry/manifest.schema.json` (`env_vars.items.properties`)
- Test: `tests/bundle-env-secrets.test.js`

**Interfaces:**
- Consumes: `CROW_HOME`, `getInstalledFirstManifest` (from `servers/gateway/bundles-config.js`, already imported in bundles.js).
- Produces (later tasks rely on these exact names):
  - `parseEnvText(text: string): Record<string,string>`
  - `generatedEnvKeys(manifest): string[]` returns the names whose `generate === "secret"`
  - `newSecretValue(): string` returns 43 base64url chars
  - `writePrivateFile(path: string, content: string): void` writes at mode 600 even if the file already exists
  - `retainedEnvPath(crowHome: string, bundleId: string): string` → `<crowHome>/secrets/bundle-env/<id>.env`
  - `resolveGeneratedEnv(bundleId, manifest, { destDir, crowHome }): Record<string,string>`
  - `stripGeneratedKeys(manifest, envVars): object` returns a copy without generated keys (non-objects are returned unchanged)
  - Manifest field: `env_vars[].generate: "secret"`

- [ ] **Step 1: Write the failing test**

Create `tests/bundle-env-secrets.test.js`:

```js
/**
 * Installer-generated bundle secrets + .env hygiene (Crow Workspace W1, Task 1).
 * bundles.js resolves CROW_HOME at import — scratch dirs are set BEFORE the import
 * (tests/bundles-install-job.test.js header explains the live incident).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, chmodSync, rmSync } from "node:fs";
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
const GATEWAY_ENV = join(mkdtempSync(join(tmpdir(), "crow-envsec-gwenv-")), ".env");
B._setAppEnvPathForTest(GATEWAY_ENV);

after(() => {
  B._setAppEnvPathForTest(null);
  rmSync(CROW_HOME, { recursive: true, force: true });
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

test("REVIEW FOCUS 1 — reinstall reuses retained secrets (uninstall removed the bundle dir, not the data)", () => {
  const home = scratch("h-");
  const first = S.resolveGeneratedEnv("demo", MANIFEST, { destDir: scratch("d1-"), crowHome: home });
  const second = S.resolveGeneratedEnv("demo", MANIFEST, { destDir: scratch("d2-"), crowHome: home });
  assert.deepEqual(second, first, "a regenerated DB password would lock Nextcloud out of its kept database");
});

test("an existing installed .env value wins over the retained copy", () => {
  const home = scratch("h-"); const dest = scratch("d-");
  S.resolveGeneratedEnv("demo", MANIFEST, { destDir: dest, crowHome: home });
  writeFileSync(join(dest, ".env"), "DEMO_DB_PASSWORD=from-installed-env\n");
  const out = S.resolveGeneratedEnv("demo", MANIFEST, { destDir: dest, crowHome: home });
  assert.equal(out.DEMO_DB_PASSWORD, "from-installed-env");
});

test("a manifest with no generated vars returns {} and writes no retained file", () => {
  const home = scratch("h-");
  assert.deepEqual(S.resolveGeneratedEnv("plain", { env_vars: [{ name: "A" }] }, { destDir: scratch("d-"), crowHome: home }), {});
  assert.equal(existsSync(S.retainedEnvPath(home, "plain")), false);
});

test("stripGeneratedKeys drops generated keys from a request body", () => {
  assert.deepEqual(
    S.stripGeneratedKeys(MANIFEST, { DEMO_DB_PASSWORD: "attacker", DEMO_ADMIN_PASSWORD: "ok" }),
    { DEMO_ADMIN_PASSWORD: "ok" },
  );
  assert.equal(S.stripGeneratedKeys(MANIFEST, null), null);
});

test("writePrivateFile tightens an existing 644 file to 600", () => {
  const p = join(scratch("w-"), ".env");
  writeFileSync(p, "A=1\n", { mode: 0o644 });
  S.writePrivateFile(p, "A=2\n");
  assert.equal(mode(p), 0o600);
  assert.equal(readFileSync(p, "utf8"), "A=2\n");
});

test("writeInstallEnv writes .env at 600 on all three rungs (values, example copy, placeholder)", () => {
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
  assert.equal(readFileSync(join(d4, ".env"), "utf8"), "KEEP=1\n", "never clobbered");
  assert.equal(mode(join(d4, ".env")), 0o600, "but tightened");
});

// ── Configure route (POST /bundles/api/env) ──
function seedInstalled(id, manifest, envText) {
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, name: id, type: "bundle", version: "0.1.0", ...manifest }));
  writeFileSync(join(dir, ".env"), envText, { mode: 0o644 });
  chmodSync(join(dir, ".env"), 0o644);
  return dir;
}
async function postEnv(bundleId, envVars) {
  const app = express();
  app.use(express.json());
  app.use(B.default());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/bundles/api/env`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle_id: bundleId, env_vars: envVars }),
    });
    return { status: r.status, body: await r.json() };
  } finally {
    server.close();
  }
}

test("Configure leaves the .env at 600 and ignores attempts to overwrite a generated key", async () => {
  const dir = seedInstalled("demo-cfg", { env_vars: MANIFEST.env_vars }, "DEMO_DB_PASSWORD=original\nDEMO_ADMIN_PASSWORD=old\n");
  const r = await postEnv("demo-cfg", { DEMO_DB_PASSWORD: "attacker", DEMO_ADMIN_PASSWORD: "newpass" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const env = S.parseEnvText(readFileSync(join(dir, ".env"), "utf8"));
  assert.equal(env.DEMO_DB_PASSWORD, "original");
  assert.equal(env.DEMO_ADMIN_PASSWORD, "newpass");
  assert.equal(mode(join(dir, ".env")), 0o600);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/bundle-env-secrets.test.js`
Expected: FAIL with `Cannot find module '…/servers/gateway/bundle-env-secrets.js'`.

- [ ] **Step 3: Implement `servers/gateway/bundle-env-secrets.js`**

```js
/**
 * Installer-generated bundle secrets + bundle .env hygiene.
 *
 * Config-friction stage 1 (~/crow-weekend-push/reports/config-friction-survey.md,
 * category F1): internal plumbing secrets — DB passwords, JWT secrets, cache
 * passwords — are minted by the installer instead of typed by the operator.
 *
 *   env_vars[].generate: "secret"   → 32 random bytes, base64url (43 chars; no
 *                                     `$`, quotes or spaces: safe in a compose
 *                                     .env, a URL, and bash)
 *
 * A generated value is NEVER regenerated on reinstall: bundles bind-mount their
 * data, and the kept database still expects the old password. Resolution order
 * is installed .env → the retained copy at <CROW_HOME>/secrets/bundle-env/<id>.env
 * (dir 700, file 600; uninstall never deletes it) → a new value.
 *
 * Generated keys are invisible to the install/Configure form (html.js), ignored
 * when a request carries them (stripGeneratedKeys), never install-blocking, and
 * never propagated to the gateway's own .env.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const GENERATE_KINDS = new Set(["secret"]);

/** KEY=value lines → object. Same line grammar as the Configure route's reader. */
export function parseEnvText(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function readEnvSafe(path) {
  try {
    return existsSync(path) ? parseEnvText(readFileSync(path, "utf8")) : {};
  } catch {
    return {};
  }
}

/** Names of the env vars the installer must generate. */
export function generatedEnvKeys(manifest) {
  return (manifest?.env_vars || [])
    .filter((v) => v && typeof v.name === "string" && GENERATE_KINDS.has(v.generate))
    .map((v) => v.name);
}

export function newSecretValue() {
  return randomBytes(32).toString("base64url");
}

/** Write a file at mode 600 — chmod too, because `mode` only applies on create. */
export function writePrivateFile(path, content) {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function retainedEnvPath(crowHome, bundleId) {
  return join(crowHome, "secrets", "bundle-env", `${bundleId}.env`);
}

/**
 * The generated secrets for one install: reuse before mint, and (re)write the
 * retained copy so a later reinstall finds them.
 * @returns {Record<string,string>} generated key → value ({} when none declared)
 */
export function resolveGeneratedEnv(bundleId, manifest, { destDir, crowHome }) {
  const keys = generatedEnvKeys(manifest);
  if (keys.length === 0) return {};
  const installed = readEnvSafe(join(destDir, ".env"));
  const retainedPath = retainedEnvPath(crowHome, bundleId);
  const retained = readEnvSafe(retainedPath);
  const out = {};
  for (const k of keys) out[k] = installed[k] || retained[k] || newSecretValue();

  const dir = join(crowHome, "secrets", "bundle-env");
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

/** A request-body copy without the generated keys (they are never operator input). */
export function stripGeneratedKeys(manifest, envVars) {
  if (!envVars || typeof envVars !== "object") return envVars;
  const drop = new Set(generatedEnvKeys(manifest));
  const out = {};
  for (const [k, v] of Object.entries(envVars)) if (!drop.has(k)) out[k] = v;
  return out;
}
```

- [ ] **Step 4: Wire it into `servers/gateway/routes/bundles.js`**

(a) fs import, line 25: add `chmodSync`:

```js
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, copyFileSync, unlinkSync, symlinkSync, statSync, realpathSync, chmodSync } from "node:fs";
```

(b) Below the `import { readEnvFile } from "../env-manager.js";` line, add:

```js
import { resolveGeneratedEnv, stripGeneratedKeys, writePrivateFile } from "../bundle-env-secrets.js";
```

(c) Replace the body of `writeInstallEnv` (keep its doc comment; append one line to it: ` * Every rung writes mode 600 — bundle .env files hold secrets.`):

```js
export function writeInstallEnv(destDir, envVars, manifest, log = () => {}) {
  const envPath = join(destDir, ".env");
  const examplePath = join(destDir, ".env.example");
  const envLines = (envVars && typeof envVars === "object")
    ? Object.entries(envVars)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => `${k}=${v}`)
    : [];
  if (envLines.length > 0) {
    writePrivateFile(envPath, envLines.join("\n") + "\n");
    log(`Wrote ${envLines.length} env vars`);
    return;
  }
  if (existsSync(envPath)) {
    chmodSync(envPath, 0o600);
    return;
  }
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

(d) In `runInstallJob`, replace the step-2 call `writeInstallEnv(destDir, envVars, manifest, (msg) => appendLog(job, msg));` with:

```js
    // 2. Write env vars. Generated secrets (env_vars[].generate) are minted or
    // reused here — never taken from the request, never shown, never sent to
    // the gateway .env (they are not in envVars, which is what propagates).
    const generated = resolveGeneratedEnv(bundleId, manifest, { destDir, crowHome: CROW_HOME });
    const installEnv = { ...(stripGeneratedKeys(manifest, envVars) || {}), ...generated };
    writeInstallEnv(destDir, installEnv, manifest, (msg) => appendLog(job, msg));
    if (Object.keys(generated).length > 0) {
      appendLog(job, `Generated ${Object.keys(generated).length} internal secret(s) — stored at mode 600, never shown`);
    }
```

(e) Configure route `POST /bundles/api/env`: change the destructuring line to

```js
      const { bundle_id } = req.body;
      let { env_vars } = req.body;
```

and directly after the `if (!env_vars || typeof env_vars !== "object")` 400 block, add:

```js
      // Generated secrets are never operator input — a request cannot rotate
      // a DB password out from under its database.
      env_vars = stripGeneratedKeys(getInstalledFirstManifest(bundle_id), env_vars);
```

Then replace `writeFileSync(envPath, envContent);` in that route with `writePrivateFile(envPath, envContent);`.

(f) `registry/manifest.schema.json` → `env_vars.items.properties`: add

```json
          "generate": { "type": "string", "enum": ["secret"] },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/bundle-env-secrets.test.js tests/bundles-install-env.test.js tests/bundles-install-hardening.test.js tests/bundles-env-mcp-config.test.js`
Expected: PASS (the existing env tests still pass; their "never clobbered" assertions are unchanged).

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/bundle-env-secrets.js tests/bundle-env-secrets.test.js
git commit servers/gateway/bundle-env-secrets.js servers/gateway/routes/bundles.js registry/manifest.schema.json tests/bundle-env-secrets.test.js \
  -m "feat(bundles): installer-generated secrets (env_vars[].generate), kept across reinstall; bundle .env at mode 600"
git show --stat HEAD
```

---

### Task 2: Env-var scoping (`propagate: false`, `pattern`, hidden generated keys)

**Files:**
- Modify: `servers/gateway/bundle-env-secrets.js` (append two exports)
- Modify: `servers/gateway/routes/bundles.js`: `declaredEnvSubset` (~1428), `installBlockingEnvKeys` (~1607), `validateInstall` (after the `requireEnv` block, ~1697), Configure route (after `findInvalidEnv`)
- Modify: `servers/gateway/dashboard/panels/extensions/html.js:438` (the `env_vars` map)
- Modify: `registry/manifest.schema.json`
- Test: `tests/bundle-env-scoping.test.js`

**Interfaces:**
- Consumes: `generatedEnvKeys`, `parseEnvText` (Task 1).
- Produces:
  - `gatewayExcludedKeys(manifest): Set<string>` contains the generated keys plus every key with `propagate === false`
  - `envPatternViolation(manifest, envVars): { key: string, why: string } | null`
  - Manifest fields: `env_vars[].propagate: boolean`, `env_vars[].pattern: string` (anchored `^…$`), and `env_vars[].pattern_hint: string` (optional; human text for the error)
  - Error contract: a 400 with `code: "invalid_env"`, the same code `findInvalidEnv` already uses

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
  { name: "WS_ADMIN_PASSWORD", required: true, secret: true, propagate: false, pattern: SAFE, pattern_hint: "12-128 letters, digits or ! % * + , - . / : = ? @ ^ _ ~" },
  { name: "WS_DB_PASSWORD", required: true, generate: "secret" },
  { name: "WS_PLAIN_URL", required: false },
];
function fixture(id, { compose = null, manifest = {} } = {}) {
  const dir = join(FIXTURES, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.1.0", env_vars: ENV_VARS, ...manifest }));
  if (compose) writeFileSync(join(dir, "docker-compose.yml"), compose);
  return dir;
}

test("gatewayExcludedKeys = generated + propagate:false", () => {
  assert.deepEqual([...S.gatewayExcludedKeys({ env_vars: ENV_VARS })].sort(), ["WS_ADMIN_PASSWORD", "WS_ADMIN_USER", "WS_DB_PASSWORD"]);
});

test("REVIEW FOCUS 5a — generated and propagate:false keys never reach the gateway .env", () => {
  const subset = B.declaredEnvSubset({ env_vars: ENV_VARS }, {
    WS_ADMIN_USER: "admin", WS_ADMIN_PASSWORD: "Correct-Horse-1", WS_DB_PASSWORD: "x", WS_PLAIN_URL: "http://a",
  });
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
    assert.ok(!v.why.includes(bad), "the refusal must not echo the secret");
  }
});

test("installBlockingEnvKeys never lists a generated key, even when compose hard-fails on it", () => {
  fixture("ws-block", { compose: "services:\n  a:\n    image: busybox:1.36\n    environment:\n      P: ${WS_DB_PASSWORD:?gen}\n      Q: ${WS_ADMIN_PASSWORD:?type it}\n" });
  assert.deepEqual(B.installBlockingEnvKeys("ws-block"), ["WS_ADMIN_PASSWORD"]);
});

test("REVIEW FOCUS 2 — unsafe admin password refused before anything is written", async () => {
  fixture("ws-pattern");
  const v = await B.validateInstall("ws-pattern", { envVars: { WS_ADMIN_PASSWORD: "pa$$ w0rd#'; rm" }, requireEnv: true, forceInstall: true });
  assert.equal(v.ok, false);
  assert.equal(v.status, 400);
  assert.equal(v.code, "invalid_env");
  assert.match(v.error, /WS_ADMIN_PASSWORD/);
  assert.equal(existsSync(join(CROW_HOME, "bundles", "ws-pattern")), false, "nothing copied or written");
});

test("a safe admin password passes the pattern gate", async () => {
  fixture("ws-pattern-ok");
  const v = await B.validateInstall("ws-pattern-ok", { envVars: { WS_ADMIN_PASSWORD: "Correct-Horse-Battery-9" }, requireEnv: true, forceInstall: true });
  assert.equal(v.ok, true, JSON.stringify(v));
});

test("Configure refuses a pattern-violating value with 400 invalid_env and leaves the .env untouched", async () => {
  const dir = join(CROW_HOME, "bundles", "ws-cfg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id: "ws-cfg", name: "ws-cfg", type: "bundle", version: "0.1.0", env_vars: ENV_VARS }));
  writeFileSync(join(dir, ".env"), "WS_ADMIN_PASSWORD=Correct-Horse-1\n", { mode: 0o600 });
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
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "WS_ADMIN_PASSWORD=Correct-Horse-1\n");
  assert.ok(!readFileSync(GATEWAY_ENV, "utf8").includes("WS_ADMIN"), "nothing reached the gateway .env");
});

test("the store never sends a generated key to the browser (install + Configure forms)", () => {
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
/**
 * Keys that must never be written to the gateway's own .env: generated
 * secrets, and any var the manifest marks `propagate: false` (bundle-private
 * values such as an app's admin password).
 */
export function gatewayExcludedKeys(manifest) {
  const out = new Set(generatedEnvKeys(manifest));
  for (const v of manifest?.env_vars || []) {
    if (v && typeof v.name === "string" && v.propagate === false) out.add(v.name);
  }
  return out;
}

/**
 * First supplied value that breaks its manifest `pattern`, or null. Blank
 * values are not checked (required-ness is a separate gate). The refusal names
 * the KEY only — never the value (it is usually a secret).
 */
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

(b) `servers/gateway/routes/bundles.js`: extend the Task-1 import:

```js
import { resolveGeneratedEnv, stripGeneratedKeys, writePrivateFile, gatewayExcludedKeys, envPatternViolation } from "../bundle-env-secrets.js";
```

(c) Replace `declaredEnvSubset`:

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

(d) In `installBlockingEnvKeys`, change the filter line to

```js
    .filter((v) => v && v.required && !v.generate && typeof v.name === "string" && !nonBlankEnv(v.default) && hard.has(v.name))
```

(e) In `validateInstall`, directly after the closing `}` of the `if (requireEnv) { … }` block, insert:

```js
  // A supplied value that breaks its manifest pattern (e.g. an admin password
  // with `$` or a space, which compose would interpolate and bash would split)
  // is refused BEFORE anything is copied — never a half-install.
  const badPattern = envPatternViolation(manifest, envVars);
  if (badPattern) {
    return {
      ok: false, status: 400, code: "invalid_env",
      error: `Environment variable '${badPattern.key}' ${badPattern.why}`,
      extra: { code: "invalid_env", key: badPattern.key },
    };
  }
```

(f) Configure route: directly after the existing `findInvalidEnv` 400 block, insert:

```js
      const badPattern = envPatternViolation(getInstalledFirstManifest(bundle_id), env_vars);
      if (badPattern) {
        return res.status(400).json({ code: "invalid_env", key: badPattern.key, error: `Environment variable '${badPattern.key}' ${badPattern.why}` });
      }
```

(g) `servers/gateway/dashboard/panels/extensions/html.js` line 438: change `env_vars: (addon.env_vars || []).map((ev) => ({` to

```js
      env_vars: (addon.env_vars || []).filter((ev) => !ev.generate).map((ev) => ({
```

(h) `registry/manifest.schema.json` → `env_vars.items.properties`, add:

```json
          "propagate": { "type": "boolean" },
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
  -m "feat(bundles): env var scoping — propagate:false, anchored pattern gate, generated keys hidden from the form"
git show --stat HEAD
```

---

### Task 3: Lifecycle hooks (`docker.precreate`, first-party `postInstall`, long compose timeouts)

**Files:**
- Create: `servers/gateway/bundle-lifecycle.js`
- Modify: `servers/gateway/routes/bundles.js`:
  - imports and a new test seam;
  - `runInstallJob` docker branch (~1990–2030) and its tail (~2340);
  - `refreshVersionedBundle` (the declared-roots block, ~720).
- Modify: `scripts/lib/bundle-contract.mjs` (step 3 referential checks), `registry/manifest.schema.json`
- Test: `tests/bundle-lifecycle-hooks.test.js`

**Interfaces:**
- Consumes: `composeEnv(base)`, `run(cmd, args, opts)`, `runCompose`, `_setComposeRunnerForTest`, `CROW_HOME` (bundles.js).
- Produces:
  - `safeRelPath(p: string): string | null`
  - `precreateDirs(manifest, crowHome): string[]` returns the absolute dirs. It throws `Error` on any unsafe entry *before* creating anything.
  - `postInstallPlan(manifest): null | { refused: string } | { script: string, timeoutMs: number }`
  - `runPostInstall({ manifest, destDir, env, log, runner }): Promise<{ ok: true, skipped?: true } | { ok: false, reason: string, rerun?: string }>`
  - `POST_INSTALL_MAX_TIMEOUT_S = 1800`, `COMPOSE_LONG_TIMEOUT_MS = 1_800_000`
  - bundles.js test seam: `_setHookRunnerForTest(fn | null)`
  - Manifest fields: `docker.precreate: string[]`, `postInstall: { script: string, timeout_s?: integer }`
  - Hook runtime contract (Task 5 relies on it): `bash <destDir>/<script>`, `cwd` = destDir, env includes `CROW_HOME` and `CROW_BUNDLE_DIR`

- [ ] **Step 1: Write the failing test**

Create `tests/bundle-lifecycle-hooks.test.js`:

```js
/** Bundle lifecycle hooks (Crow Workspace W1, Task 3). Scratch CROW_HOME before import. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
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
after(() => {
  B._setComposeRunnerForTest(null);
  B._setHookRunnerForTest(null);
  rmSync(CROW_HOME, { recursive: true, force: true });
  rmSync(FIXTURES, { recursive: true, force: true });
});

const COMPOSE = "services:\n  app:\n    image: busybox:1.36\n    restart: unless-stopped\n";
function fixture(id, manifest, files = {}) {
  const dir = join(FIXTURES, id);
  mkdirSync(join(dir, "ops"), { recursive: true });
  const full = { id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.1.0", docker: { composefile: "docker-compose.yml" }, ...manifest };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(full));
  writeFileSync(join(dir, "docker-compose.yml"), COMPOSE);
  writeFileSync(join(dir, "ops", "bootstrap.sh"), "#!/usr/bin/env bash\necho ok\n");
  for (const [rel, c] of Object.entries(files)) writeFileSync(join(dir, rel), c);
  return full;
}
async function install(id, manifest) {
  const job = B._createJobForTest(id, "install");
  const out = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
  return { out, job };
}

test("safeRelPath accepts plain relative paths only", () => {
  assert.equal(L.safeRelPath("workspace/backups-staging"), "workspace/backups-staging");
  for (const bad of ["", "/etc", "../x", "a/../../x", null, 3]) assert.equal(L.safeRelPath(bad), null, String(bad));
});

test("precreateDirs makes 0700 dirs under CROW_HOME and validates every entry first", () => {
  const home = mkdtempSync(join(tmpdir(), "pc-"));
  const made = L.precreateDirs({ docker: { precreate: ["ws", "ws/staging"] } }, home);
  assert.deepEqual(made, [join(home, "ws"), join(home, "ws/staging")]);
  assert.equal(statSync(join(home, "ws")).mode & 0o777, 0o700);
  assert.throws(() => L.precreateDirs({ docker: { precreate: ["ok-first", "../escape"] } }, home), /relative path inside CROW_HOME/);
  assert.equal(existsSync(join(home, "ok-first")), false, "nothing created when any entry is unsafe");
});

test("postInstallPlan: none, community refusal, bad path, default and clamped timeout", () => {
  assert.equal(L.postInstallPlan({}), null);
  assert.match(L.postInstallPlan({ origin: "community", postInstall: { script: "ops/x.sh" } }).refused, /first-party/);
  assert.match(L.postInstallPlan({ postInstall: { script: "../x.sh" } }).refused, /relative \.sh path/);
  assert.match(L.postInstallPlan({ postInstall: { script: "ops/x.py" } }).refused, /relative \.sh path/);
  assert.deepEqual(L.postInstallPlan({ postInstall: { script: "ops/x.sh" } }), { script: "ops/x.sh", timeoutMs: 600_000 });
  assert.equal(L.postInstallPlan({ postInstall: { script: "ops/x.sh", timeout_s: 99999 } }).timeoutMs, 1_800_000);
});

test("runPostInstall: runner gets bash <abs script>, cwd, env, timeout; failure carries a stderr tail and a re-run command", async () => {
  const dest = mkdtempSync(join(tmpdir(), "rp-"));
  mkdirSync(join(dest, "ops"));
  writeFileSync(join(dest, "ops", "b.sh"), "echo hi\n");
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
  assert.equal(calls[0].opts.env.CROW_HOME, "/h");
  assert.ok(logs.some((l) => l.includes("step two")));

  const bad = await L.runPostInstall({
    manifest: { postInstall: { script: "ops/b.sh" } }, destDir: dest, env: {}, log: () => {},
    runner: async () => { throw Object.assign(new Error("exit 1"), { stdout: "", stderr: "Nextcloud not ready after 600s" }); },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /post-install setup failed: .*Nextcloud not ready/);
  assert.equal(bad.rerun, `bash ${join(dest, "ops", "b.sh")}`);
});

test("install: precreate before up, hook after up, long compose timeouts, env carries CROW_HOME + CROW_BUNDLE_DIR", async () => {
  const m = fixture("hk-ok", { docker: { composefile: "docker-compose.yml", precreate: ["hk-ok-data"] }, postInstall: { script: "ops/bootstrap.sh", timeout_s: 30 } });
  const order = [];
  B._setComposeRunnerForTest(async (args, opts) => { order.push({ step: args[0], timeout: opts.timeout }); return { stdout: "", stderr: "" }; });
  B._setHookRunnerForTest(async (cmd, args, opts) => { order.push({ step: "hook", env: opts.env, cwd: opts.cwd }); return { stdout: "done\n", stderr: "" }; });
  const { out } = await install("hk-ok", m);
  assert.equal(out.ok, true, out.reason);
  assert.ok(existsSync(join(CROW_HOME, "hk-ok-data")));
  assert.deepEqual(order.map((o) => o.step), ["pull", "up", "hook"]);
  assert.ok(order[0].timeout >= 1_800_000 && order[1].timeout >= 1_800_000, "pull/up must outlive a multi-GB image pull");
  assert.equal(order[2].env.CROW_HOME, CROW_HOME);
  assert.equal(order[2].env.CROW_BUNDLE_DIR, join(CROW_HOME, "bundles", "hk-ok"));
  assert.equal(order[2].cwd, join(CROW_HOME, "bundles", "hk-ok"));
});

test("install: a failing hook keeps the bundle installed, ends not-ok, and logs the re-run command", async () => {
  const m = fixture("hk-fail", { postInstall: { script: "ops/bootstrap.sh" } });
  B._setComposeRunnerForTest(async () => ({ stdout: "", stderr: "" }));
  B._setHookRunnerForTest(async () => { throw Object.assign(new Error("exit 1"), { stderr: "boom" }); });
  const { out, job } = await install("hk-fail", m);
  assert.equal(out.ok, false);
  assert.match(out.reason, /post-install setup failed: .*boom/);
  const installed = JSON.parse(readFileSync(join(CROW_HOME, "installed.json"), "utf8"));
  assert.ok(installed.some((i) => i.id === "hk-fail"));
  assert.ok(B._getJobForTest(job.id).log.some((l) => l.includes(`bash ${join(CROW_HOME, "bundles", "hk-fail", "ops", "bootstrap.sh")}`)));
});

test("install: compose up failure → hook never runs; community bundle → hook refused, never run", async () => {
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
  B._setComposeRunnerForTest(async () => ({ stdout: "", stderr: "" }));
  const { out } = await install("hk-esc", fixture("hk-esc", { docker: { composefile: "docker-compose.yml", precreate: ["../outside"] } }));
  assert.equal(out.ok, false);
  assert.equal(existsSync(join(CROW_HOME, "bundles", "hk-esc")), false);
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
  const installedPath = join(CROW_HOME, "installed.json");
  const prior = existsSync(installedPath) ? JSON.parse(readFileSync(installedPath, "utf8")) : [];
  writeFileSync(installedPath, JSON.stringify([...prior, { id, type: "bundle", version: "0.1.0" }]));
  await B.repairInstalledBundleAssets({ appBundles: repo, run: async () => ({ stdout: "", stderr: "" }) });
  assert.equal(readFileSync(join(dest, "ops", "bootstrap.sh"), "utf8"), "echo v2\n");
});

test("contract: missing postInstall script and unsafe precreate are manifest errors", () => {
  const root = mkdtempSync(join(tmpdir(), "hk-contract-"));
  const dir = join(root, "c1");
  mkdirSync(dir);
  writeFileSync(join(dir, "docker-compose.yml"), COMPOSE);
  const m = { id: "c1", name: "c", description: "d", type: "bundle", category: "x", docker: { composefile: "docker-compose.yml", precreate: ["/abs"] }, postInstall: { script: "ops/missing.sh" } };
  const r = validateManifest(m, dir);
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
 * Bundle lifecycle hooks — generic, manifest-declared, first-party only.
 *
 *   docker.precreate: ["ws", "ws/staging"]   dirs under CROW_HOME created 0700
 *     BEFORE `compose up`. Docker creates a missing bind source as ROOT, which
 *     would leave host-side scripts (backups) unable to write next to the data.
 *
 *   postInstall: { script: "ops/bootstrap.sh", timeout_s: 1500 }
 *     `bash <installed bundle>/<script>` after a SUCCESSFUL `compose up -d`
 *     (cwd = bundle dir; env = composeEnv + CROW_BUNDLE_DIR). Runs host shell
 *     code, so community bundles (manifest.origin === "community") are refused.
 *     The script must be idempotent: a failed install logs the re-run command.
 */
import { mkdirSync, existsSync } from "node:fs";
import { join, isAbsolute, normalize } from "node:path";

export const POST_INSTALL_MAX_TIMEOUT_S = 1800;
export const COMPOSE_LONG_TIMEOUT_MS = 30 * 60 * 1000;
const POST_INSTALL_DEFAULT_TIMEOUT_S = 600;

/** A plain relative path with no `..` segment, normalized — or null. */
export function safeRelPath(p) {
  if (typeof p !== "string" || p === "" || isAbsolute(p)) return null;
  const n = normalize(p);
  if (n.split(/[\\/]/).includes("..")) return null;
  return n;
}

/** Create every docker.precreate dir (0700). Validates ALL entries before creating ANY. */
export function precreateDirs(manifest, crowHome) {
  const entries = manifest?.docker?.precreate || [];
  const rels = entries.map((p) => {
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

export function postInstallPlan(manifest) {
  const h = manifest?.postInstall;
  if (!h) return null;
  if (manifest.origin === "community") {
    return { refused: "post-install hooks run host shell code and are honored for first-party bundles only" };
  }
  const script = safeRelPath(h.script);
  if (!script || !script.endsWith(".sh")) {
    return { refused: `postInstall.script "${h.script}" must be a relative .sh path inside the bundle` };
  }
  const t = Number.isInteger(h.timeout_s) ? h.timeout_s : POST_INSTALL_DEFAULT_TIMEOUT_S;
  return { script, timeoutMs: Math.min(Math.max(t, 1), POST_INSTALL_MAX_TIMEOUT_S) * 1000 };
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
```

- [ ] **Step 4: Wire into `servers/gateway/routes/bundles.js`**

(a) Imports, next to the Task 1 import:

```js
import { precreateDirs, runPostInstall, COMPOSE_LONG_TIMEOUT_MS } from "../bundle-lifecycle.js";
```

(b) After the `_setComposeRunnerForTest` export (~line 975), add the seam:

```js
// Test-only: replace the post-install hook runner `(cmd, args, opts) => Promise`.
let _hookRunnerForTest = null;
export function _setHookRunnerForTest(fn) { _hookRunnerForTest = fn || null; }
```

(c) In `runInstallJob`, next to `let composeFailure = null;`, add `let hookFailure = null;`.

(d) In the docker branch, right after `appendLog(job, "Security check passed");`, insert:

```js
        try {
          const made = precreateDirs(manifest, CROW_HOME);
          if (made.length) appendLog(job, `Prepared data folders: ${made.map((p) => relativePath(CROW_HOME, p)).join(", ")}`);
        } catch (err) {
          appendLog(job, `Install refused: ${err.message}`);
          rmSync(destDir, { recursive: true, force: true });
          return { ok: false, reason: err.message };
        }
```

(e) In the same branch, pass the long timeout to both compose calls:

```js
          await runCompose(["pull"], { cwd: destDir, timeout: COMPOSE_LONG_TIMEOUT_MS });
```

```js
          await runCompose(upArgs, { cwd: destDir, timeout: COMPOSE_LONG_TIMEOUT_MS });
```

(f) Directly after the `try { await runCompose(upArgs …) } catch (err) { … }` block closes (still inside `if (existsSync(composePath))`), insert:

```js
        if (!composeFailure && manifest?.postInstall) {
          const hook = await runPostInstall({
            manifest,
            destDir,
            env: composeEnv({ ...process.env, CROW_BUNDLE_DIR: destDir }),
            log: (m) => appendLog(job, m),
            runner: _hookRunnerForTest || run,
          });
          if (!hook.ok) {
            hookFailure = hook.reason;
            appendLog(job, `Post-install setup did not finish: ${hook.reason}`);
            if (hook.rerun) appendLog(job, `Fix the cause, then re-run it: ${hook.rerun}`);
          }
        }
```

(g) At the tail of `runInstallJob`, directly after the `if (composeFailure) { … return … }` block and before `return { ok: true, needsRestart };`:

```js
    if (hookFailure) {
      appendLog(job, `Installed and running, but setup is incomplete (${hookFailure.slice(0, 400)})`);
      return { ok: false, reason: hookFailure, needsRestart };
    }
```

(h) In `refreshVersionedBundle`, after `if (repoManifest.panelRoutes) declare(repoManifest.panelRoutes);`, add:

```js
  // The post-install hook's directory is code (the bootstrap must match the
  // manifest that declares it) — refreshed on a version bump like panel/.
  if (repoManifest.postInstall?.script) declare(repoManifest.postInstall.script);
```

(i) `scripts/lib/bundle-contract.mjs`: in step 3, after the skills loop, add:

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

(j) `registry/manifest.schema.json`: in `docker.properties`, add `"precreate": { "type": "array", "items": { "type": "string", "minLength": 1 } }`. Then add a top-level property:

```json
    "postInstall": {
      "type": "object",
      "required": ["script"],
      "additionalProperties": false,
      "properties": {
        "script": { "type": "string", "minLength": 1, "pattern": "\\.sh$" },
        "timeout_s": { "type": "integer", "minimum": 1, "maximum": 1800 }
      }
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/bundle-lifecycle-hooks.test.js tests/bundle-version-refresh.test.js tests/bundles-install-job.test.js tests/bundles-install-hardening.test.js tests/bundles-webui-lifecycle.test.js tests/bundle-contract.test.js`
Then run: `node scripts/build-registry.mjs --check`
Expected: all PASS. The registry is still in sync, because no manifest has changed yet.

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/bundle-lifecycle.js tests/bundle-lifecycle-hooks.test.js
git commit servers/gateway/bundle-lifecycle.js servers/gateway/routes/bundles.js scripts/lib/bundle-contract.mjs registry/manifest.schema.json tests/bundle-lifecycle-hooks.test.js \
  -m "feat(bundles): first-party postInstall hook, docker.precreate data dirs, 30-min compose pull/up"
git show --stat HEAD
```

---

### Task 4: The `workspace` bundle (manifest and compose), plus the `nextcloud` deprecation and port registry

**Files:**
- Create: `bundles/workspace/manifest.json`, `bundles/workspace/docker-compose.yml`
- Modify: `bundles/nextcloud/manifest.json`. Delete: `bundles/nextcloud/docker-compose.yml`
- Modify: `scripts/known-port-conflicts.json`, `docs/developers/port-allocation.md`, `registry/manifest.schema.json`
- Regenerate: `registry/add-ons.json`
- Test: `tests/workspace-bundle.test.js`

**Interfaces:**
- Consumes: the `generate`, `propagate`, `pattern` and `docker.precreate` manifest fields (Tasks 1–3).
- Produces (Tasks 5–7 rely on these exact names):
  - Env keys:
    - `WORKSPACE_ADMIN_USER` (default `admin`)
    - `WORKSPACE_ADMIN_PASSWORD`
    - `WORKSPACE_DB_ROOT_PASSWORD`, `WORKSPACE_DB_PASSWORD`, `WORKSPACE_REDIS_PASSWORD`, `WORKSPACE_ONLYOFFICE_JWT_SECRET` (all generated)
    - `WORKSPACE_PUBLIC_HOST` (blank means detect)
    - `WORKSPACE_NC_SERVE_PORT` (8456), `WORKSPACE_OO_SERVE_PORT` (8457)
    - `WORKSPACE_BOT_APP_PASSWORD` is written by the bootstrap and **not** declared in the manifest.
  - Compose: project `crow-workspace`, network `crow-workspace_default`, services `nextcloud`, `nextcloud-cron`, `nextcloud-db`, `nextcloud-redis`, `onlyoffice`.
  - Host binds `${CROW_HOME}/workspace/nextcloud` → `/var/www/html` and `${CROW_HOME}/workspace/db` → `/var/lib/mysql`.

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

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
function serviceBlocks() {
  const body = compose.split(/^services:\s*$/m)[1];
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

test("exactly the five services, each restart: unless-stopped", () => {
  const svcs = serviceBlocks();
  assert.deepEqual(svcs.map((s) => s.name).sort(), ["nextcloud", "nextcloud-cron", "nextcloud-db", "nextcloud-redis", "onlyoffice"]);
  for (const s of svcs) assert.match(s.text, /^    restart: unless-stopped$/m, s.name);
});

test("only 127.0.0.1:3070 (nextcloud) and 127.0.0.1:3071 (onlyoffice) are published", () => {
  const maps = [...compose.matchAll(/^\s*-\s*"([^"]*:\d+:\d+)"\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(maps.sort(), ["127.0.0.1:3070:80", "127.0.0.1:3071:80"]);
  for (const s of serviceBlocks()) {
    if (s.name === "nextcloud-db" || s.name === "nextcloud-redis" || s.name === "nextcloud-cron") assert.doesNotMatch(s.text, /ports:/, s.name);
  }
});

test("every image is pinned to an exact version and mirrored in manifest.images", () => {
  const images = [...new Set([...compose.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((m) => m[1]))].sort();
  for (const i of images) {
    assert.doesNotMatch(i, /:latest$|:stable|^[^:]+$/, i);
    assert.match(i, /:\d+\.\d+\.\d+/, `${i} must carry a full version`);
  }
  assert.deepEqual([...manifest.images].sort(), images);
});

test("compose project is fixed; data binds live under CROW_HOME/workspace", () => {
  assert.match(compose, /^name: crow-workspace$/m);
  assert.match(compose, /\$\{CROW_HOME:\?[^}]*\}\/workspace\/nextcloud:\/var\/www\/html/);
  assert.match(compose, /\$\{CROW_HOME:\?[^}]*\}\/workspace\/db:\/var\/lib\/mysql/);
  assert.deepEqual(manifest.docker.precreate, ["workspace", "workspace/backups-staging"]);
});

test("every secret the compose consumes is hard-fail (no fallback default) and generated or typed", () => {
  const used = [...compose.matchAll(/\$\{([A-Z_][A-Z0-9_]*)([^}]*)\}/g)];
  const names = new Set(used.map((m) => m[1]));
  for (const n of names) {
    if (n === "CROW_HOME") continue;
    assert.ok(envVar(n), `${n} is used by compose but not declared in manifest.env_vars`);
  }
  for (const n of ["WORKSPACE_DB_ROOT_PASSWORD", "WORKSPACE_DB_PASSWORD", "WORKSPACE_REDIS_PASSWORD", "WORKSPACE_ONLYOFFICE_JWT_SECRET"]) {
    assert.equal(envVar(n).generate, "secret", n);
    for (const m of used.filter((u) => u[1] === n)) assert.match(m[2], /^:\?/, `${n} must be \${${n}:?…}`);
  }
});

test("admin password: required, secret, never defaulted, never propagated, pattern-gated", () => {
  const v = envVar("WORKSPACE_ADMIN_PASSWORD");
  assert.equal(v.required, true);
  assert.equal(v.secret, true);
  assert.equal(v.propagate, false);
  assert.equal(v.default, undefined);
  assert.ok(new RegExp(v.pattern).test("Correct-Horse-Battery-9"));
  assert.ok(!new RegExp(v.pattern).test("has $ dollar 123"));
  for (const v2 of manifest.env_vars) assert.equal(v2.propagate === false || v2.generate === "secret", true, `${v2.name} must stay out of the gateway .env`);
});

test("ONLYOFFICE has JWT on; Nextcloud and cron share one env (Redis locking reaches cron.php)", () => {
  assert.match(compose, /JWT_ENABLED: "true"/);
  assert.match(compose, /JWT_SECRET: \$\{WORKSPACE_ONLYOFFICE_JWT_SECRET:\?/);
  const cron = serviceBlocks().find((s) => s.name === "nextcloud-cron").text;
  assert.match(cron, /entrypoint: \/cron\.sh/);
  assert.match(cron, /environment: \*nextcloud-env/);
});

test("manifest: no ports/webUI (no ufw rule, no same-port Serve), RAM/disk declared", () => {
  assert.equal(manifest.ports, undefined);
  assert.equal(manifest.webUI, undefined);
  assert.ok(manifest.requires.min_ram_mb >= 3072 && manifest.requires.min_ram_mb <= 5120);
  assert.ok(manifest.requires.min_disk_mb >= 10240);
});

test("the old nextcloud bundle is a deprecated connect-only entry with no compose", () => {
  const nc = JSON.parse(readFileSync(join(ROOT, "bundles", "nextcloud", "manifest.json"), "utf8"));
  assert.equal(existsSync(join(ROOT, "bundles", "nextcloud", "docker-compose.yml")), false);
  assert.equal(nc.docker, undefined);
  assert.equal(nc.ports, undefined);
  assert.equal(nc.webUI, undefined);
  assert.equal(nc.deprecated.superseded_by, "workspace");
  const known = JSON.parse(readFileSync(join(ROOT, "scripts", "known-port-conflicts.json"), "utf8"));
  assert.equal(known["8080"], undefined, "the localai/nextcloud collision is resolved");
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
    "precreate": ["workspace", "workspace/backups-staging"]
  },
  "images": [
    "mariadb:11.8.9",
    "nextcloud:34.0.4-apache",
    "onlyoffice/documentserver:9.4.0.1",
    "redis:8.2.10-alpine"
  ],
  "requires": {
    "min_ram_mb": 4096,
    "recommended_ram_mb": 5120,
    "min_disk_mb": 10240
  },
  "env_vars": [
    {
      "name": "WORKSPACE_ADMIN_USER",
      "description": "Login name for the Workspace administrator account (you).",
      "default": "admin",
      "required": false,
      "propagate": false,
      "pattern": "^[a-z][a-z0-9._-]{1,31}$",
      "pattern_hint": "2-32 lowercase letters, digits, dots, dashes or underscores, starting with a letter"
    },
    {
      "name": "WORKSPACE_ADMIN_PASSWORD",
      "description": "Password for that administrator account, used to create it at first install (change it later inside Workspace: Settings, Security). 12-128 characters: letters, digits and ! % * + , - . / : = ? @ ^ _ ~ (no spaces, quotes, $ or #).",
      "required": true,
      "secret": true,
      "propagate": false,
      "pattern": "^[A-Za-z0-9!%*+,./:=?@^_~-]{12,128}$",
      "pattern_hint": "12-128 letters, digits or ! % * + , - . / : = ? @ ^ _ ~"
    },
    { "name": "WORKSPACE_DB_ROOT_PASSWORD", "description": "MariaDB root password (generated).", "required": true, "secret": true, "generate": "secret" },
    { "name": "WORKSPACE_DB_PASSWORD", "description": "MariaDB password for Nextcloud (generated).", "required": true, "secret": true, "generate": "secret" },
    { "name": "WORKSPACE_REDIS_PASSWORD", "description": "Redis password (generated).", "required": true, "secret": true, "generate": "secret" },
    { "name": "WORKSPACE_ONLYOFFICE_JWT_SECRET", "description": "Secret shared by Nextcloud and ONLYOFFICE (generated).", "required": true, "secret": true, "generate": "secret" },
    {
      "name": "WORKSPACE_PUBLIC_HOST",
      "description": "This machine's tailnet name. Leave blank and setup detects it.",
      "default": "",
      "required": false,
      "propagate": false
    },
    { "name": "WORKSPACE_NC_SERVE_PORT", "description": "Tailscale Serve HTTPS port for Workspace.", "default": "8456", "required": false, "propagate": false },
    { "name": "WORKSPACE_OO_SERVE_PORT", "description": "Tailscale Serve HTTPS port for the document editor.", "default": "8457", "required": false, "propagate": false }
  ],
  "notes": "Uses about 3-5 GB RAM, no GPU. Every internal password is generated at install; you type only the admin password. Setup finishes on its own after the containers start (a few minutes on first install). Then open the Workspace page in Crow to publish it on your tailnet and set up phones. Data lives in ~/.crow/workspace (uninstalling never deletes it)."
}
```

- [ ] **Step 4: Create `bundles/workspace/docker-compose.yml`**

```yaml
## Crow Workspace (W1 Platform): Nextcloud + MariaDB + Redis + ONLYOFFICE Docs + cron.
##
## Installed by Crow. Every internal secret is generated at install
## (manifest env_vars[].generate) into this bundle's .env (mode 600); the
## post-install bootstrap (ops/bootstrap.sh) configures the rest through occ.
##
## Loopback only. The household reaches it through two Tailscale Serve HTTPS
## ports (see the Workspace page in Crow). NEVER Funnel.
## Images are pinned; upgrade Nextcloud one major version at a time, never
## automatically (see docs/guide/workspace.md).

name: crow-workspace

x-nextcloud-env: &nextcloud-env
  MYSQL_HOST: nextcloud-db
  MYSQL_DATABASE: nextcloud
  MYSQL_USER: nextcloud
  MYSQL_PASSWORD: ${WORKSPACE_DB_PASSWORD:?generated at install}
  NEXTCLOUD_ADMIN_USER: ${WORKSPACE_ADMIN_USER:-admin}
  NEXTCLOUD_ADMIN_PASSWORD: ${WORKSPACE_ADMIN_PASSWORD:?type an admin password in the install form}
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
    ports:
      - "127.0.0.1:3070:80"
    environment: *nextcloud-env
    volumes: *nextcloud-volumes
    depends_on:
      nextcloud-db:
        condition: service_healthy
      nextcloud-redis:
        condition: service_healthy

  nextcloud-cron:
    image: nextcloud:34.0.4-apache
    restart: unless-stopped
    entrypoint: /cron.sh
    environment: *nextcloud-env
    volumes: *nextcloud-volumes
    depends_on:
      - nextcloud

  nextcloud-db:
    image: mariadb:11.8.9
    restart: unless-stopped
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
    command: ["sh", "-c", "exec redis-server --requirepass \"$$REDIS_PASSWORD\""]
    environment:
      REDIS_PASSWORD: ${WORKSPACE_REDIS_PASSWORD:?generated at install}
    healthcheck:
      test: ["CMD-SHELL", "redis-cli -a \"$$REDIS_PASSWORD\" --no-auth-warning ping | grep -q PONG"]
      interval: 10s
      timeout: 5s
      retries: 10

  onlyoffice:
    image: onlyoffice/documentserver:9.4.0.1
    restart: unless-stopped
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

- [ ] **Step 6: Port registry and schema**

In `docs/developers/port-allocation.md`, replace the "Known conflicts" table row `| 8080 | LocalAI and Nextcloud both bind 127.0.0.1:8080 — they cannot run simultaneously |` with:

```markdown
| — | none. The 8080 LocalAI/Nextcloud collision was resolved 2026-10-02: the `nextcloud` bundle no longer deploys (Crow Workspace uses 3070/3071). |
```

Change the allocation row `| 8080 | 127.0.0.1 | localai (existing) — **also nextcloud, conflict** | existing |` to `| 8080 | 127.0.0.1 | localai (existing) | existing |`. Then add these rows, keeping the table's numeric order (3070/3071 after 3065; 8456/8457 after 8098):

```markdown
| 3070 | 127.0.0.1 | workspace (Crow Workspace: Nextcloud web; tailnet via Serve :8456) | W1 2026-10 |
| 3071 | 127.0.0.1 | workspace (Crow Workspace: ONLYOFFICE Docs; tailnet via Serve :8457) | W1 2026-10 |
| 8456 | tailnet (Serve) | Tailscale Serve HTTPS → 127.0.0.1:3070 (Workspace; never Funnel) | W1 2026-10 |
| 8457 | tailnet (Serve) | Tailscale Serve HTTPS → 127.0.0.1:3071 (Workspace editor; never Funnel) | W1 2026-10 |
```

In `registry/manifest.schema.json`, add these top-level properties:

```json
    "images": { "type": "array", "items": { "type": "string", "pattern": "^[^\\s]+:[^\\s]+$" } },
    "deprecated": {
      "type": "object",
      "additionalProperties": true,
      "properties": { "since": { "type": "string" }, "superseded_by": { "type": "string" } }
    },
```

- [ ] **Step 7: Regenerate the registry and run every gate**

```bash
node scripts/build-registry.mjs          # writes registry/add-ons.json; expect PUBLISHED workspace + nextcloud (skill)
node scripts/build-registry.mjs --check  # expect "OK: all manifests valid, registry in sync."
node scripts/check-port-allocation.js    # expect OK, no collisions, 3070/3071 documented
npm test -- tests/workspace-bundle.test.js tests/bundle-contract.test.js tests/bundle-inference-contract.test.js tests/extensions-page-render.test.js
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add bundles/workspace/manifest.json bundles/workspace/docker-compose.yml tests/workspace-bundle.test.js
git commit bundles/workspace bundles/nextcloud scripts/known-port-conflicts.json docs/developers/port-allocation.md registry/manifest.schema.json registry/add-ons.json tests/workspace-bundle.test.js \
  -m "feat(workspace): Crow Workspace bundle (pinned, loopback-only Nextcloud+ONLYOFFICE); retire nextcloud's compose"
git show --stat HEAD
```

---

### Task 5: Idempotent bootstrap (`ops/bootstrap.sh`) and household accounts (`ops/add-user.sh`)

**Files:**
- Create: `bundles/workspace/ops/bootstrap.sh`, `bundles/workspace/ops/add-user.sh`
- Modify: `bundles/workspace/manifest.json` (add `postInstall`), `registry/add-ons.json` (regenerate)
- Test: `tests/workspace-bootstrap.test.js`

**Interfaces:**
- Consumes:
  - the Task 3 hook contract: `bash <dir>/ops/bootstrap.sh` with `CROW_BUNDLE_DIR` and `CROW_HOME`, a timeout, output tail-logged;
  - the Task 4 env keys and compose names.
- Produces:
  - `.env` gains `WORKSPACE_PUBLIC_HOST` (if it was blank) and `WORKSPACE_BOT_APP_PASSWORD`, both written at 600.
  - Nextcloud state:
    - apps `calendar contacts forms onlyoffice` enabled; background jobs = cron;
    - `trusted_domains[1]=nextcloud`, `[2]=<host>`; `trusted_proxies[0]=<bridge gw>`; `overwritehost=<host>:<NC port>`, `overwriteprotocol=https`, `overwrite.cli.url`, `overwritecondaddr`;
    - ONLYOFFICE connector configured; calendar `Menu` owned by the admin; user `crow-bot` (not admin) holding one app password named `crow-workspace-tools`.
  - Test seams (env): `WORKSPACE_DC`, `WORKSPACE_TS`, `WORKSPACE_DOCKER`, `WORKSPACE_WAIT_S`, `WORKSPACE_SLEEP_S`.
  - `add-user.sh <login> "<Display Name>"` prints a one-time password exactly once.

- [ ] **Step 1: Write the failing test**

Create `tests/workspace-bootstrap.test.js`:

```js
/**
 * ops/bootstrap.sh + ops/add-user.sh against a FAKE `docker compose` (no containers):
 * the fake answers occ from marker files in FAKE_STATE and logs every argv line.
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
for last; do :; done
case "$*" in
  *"occ status --output=json"*) if [ -f "$S/installed" ]; then echo '{"installed":true,"version":"34.0.4"}'; else echo '{"installed":false}'; fi ;;
  *"occ config:app:get "*" enabled"*) app=$(printf '%s' "$*" | sed -E 's/.*config:app:get ([a-z_]+) enabled.*/\1/'); if [ -f "$S/app-$app" ]; then echo yes; fi ;;
  *"occ app:install "*|*"occ app:enable "*) touch "$S/app-$last" ;;
  *"occ dav:list-calendars "*) echo "+------+"; if [ -f "$S/cal-Menu" ]; then echo "| Menu | Menu | principals/users/admin | admin |  ✓  |"; fi ;;
  *"occ dav:create-calendar "*) touch "$S/cal-$last" ;;
  *"occ user:info "*) [ -f "$S/user-$last" ] || exit 1 ;;
  *"occ user:add "*) touch "$S/user-$last" ;;
  *"occ user:auth-tokens:add "*) n=$(( $(cat "$S/tokens" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$S/tokens"; printf 'app password:\nTOKEN-abc123-%s\n' "$n" ;;
  *"onlyoffice:documentserver --check"*) [ -f "$S/oo-down" ] && exit 1; echo "Document server is successfully connected" ;;
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
echo 172.31.0.1
`;

const SECRETS = {
  WORKSPACE_ADMIN_PASSWORD: "Admin-Secret-Value-123",
  WORKSPACE_DB_ROOT_PASSWORD: "dbroot-SECRET-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  WORKSPACE_DB_PASSWORD: "db-SECRET-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  WORKSPACE_REDIS_PASSWORD: "redis-SECRET-ccccccccccccccccccccccccccccccccccc",
  WORKSPACE_ONLYOFFICE_JWT_SECRET: "jwt-SECRET-ddddddddddddddddddddddddddddddddddddd",
};

function setup({ env = {}, state = ["installed"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ws-boot-"));
  const bundle = join(root, "bundle"); const st = join(root, "state"); const bin = join(root, "bin");
  for (const d of [bundle, st, bin]) mkdirSync(d);
  for (const [n, body] of [["dc", FAKE_DC], ["ts", FAKE_TS], ["docker", FAKE_DOCKER]]) {
    writeFileSync(join(bin, n), body); chmodSync(join(bin, n), 0o755);
  }
  for (const s of state) writeFileSync(join(st, s), "");
  const vars = { WORKSPACE_ADMIN_USER: "admin", ...SECRETS, WORKSPACE_PUBLIC_HOST: "", WORKSPACE_NC_SERVE_PORT: "8456", WORKSPACE_OO_SERVE_PORT: "8457", ...env };
  writeFileSync(join(bundle, ".env"), Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  return { root, bundle, st, bin };
}
function run(script, ctx, args = [], extraEnv = {}) {
  const r = spawnSync("bash", [join(OPS, script), ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH, HOME: ctx.root, CROW_HOME: join(ctx.root, "crowhome"), CROW_BUNDLE_DIR: ctx.bundle, FAKE_STATE: ctx.st,
      WORKSPACE_DC: join(ctx.bin, "dc"), WORKSPACE_TS: join(ctx.bin, "ts"), WORKSPACE_DOCKER: join(ctx.bin, "docker"),
      WORKSPACE_WAIT_S: "2", WORKSPACE_SLEEP_S: "1", ...extraEnv,
    },
  });
  return { ...r, out: `${r.stdout}\n${r.stderr}` };
}
const calls = (ctx) => (existsSync(join(ctx.st, "calls.log")) ? readFileSync(join(ctx.st, "calls.log"), "utf8") : "");
const envOf = (ctx) => Object.fromEntries(readFileSync(join(ctx.bundle, ".env"), "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

test("fresh run configures everything once and records the bot token + tailnet host at 600", () => {
  const ctx = setup();
  const r = run("bootstrap.sh", ctx);
  assert.equal(r.status, 0, r.out);
  const c = calls(ctx);
  for (const app of ["calendar", "contacts", "forms", "onlyoffice"]) assert.match(c, new RegExp(`occ app:install ${app}`));
  assert.match(c, /occ background:cron/);
  assert.match(c, /occ config:system:set trusted_domains 1 --value=nextcloud/);
  assert.match(c, /occ config:system:set trusted_domains 2 --value=box\.tailnet-example\.ts\.net/);
  assert.match(c, /occ config:system:set trusted_proxies 0 --value=172\.31\.0\.1/);
  assert.match(c, /occ config:system:set overwritehost --value=box\.tailnet-example\.ts\.net:8456/);
  assert.match(c, /occ config:system:set overwritecondaddr --value=\^172\\\.31\\\.0\\\.1\$/);
  assert.match(c, /occ config:app:set onlyoffice DocumentServerUrl --value=https:\/\/box\.tailnet-example\.ts\.net:8457\//);
  assert.match(c, /occ config:app:set onlyoffice DocumentServerInternalUrl --value=http:\/\/onlyoffice\//);
  assert.match(c, /occ config:app:set onlyoffice StorageUrl --value=http:\/\/nextcloud\//);
  assert.match(c, /occ dav:create-calendar admin Menu/);
  assert.match(c, /occ user:add --password-from-env --display-name=Crow bot crow-bot/);
  assert.doesNotMatch(c, /--group/);
  const env = envOf(ctx);
  assert.equal(env.WORKSPACE_BOT_APP_PASSWORD, "TOKEN-abc123-1");
  assert.equal(env.WORKSPACE_PUBLIC_HOST, "box.tailnet-example.ts.net");
  assert.equal(statSync(join(ctx.bundle, ".env")).mode & 0o777, 0o600);
});

test("REVIEW FOCUS 3 — second run changes nothing; lost token is re-minted once", () => {
  const ctx = setup();
  assert.equal(run("bootstrap.sh", ctx).status, 0);
  writeFileSync(join(ctx.st, "calls.log"), "");
  const r2 = run("bootstrap.sh", ctx);
  assert.equal(r2.status, 0, r2.out);
  const c2 = calls(ctx);
  assert.doesNotMatch(c2, /app:install|app:enable|dav:create-calendar|user:add|user:resetpassword|auth-tokens:add/);
  assert.equal(envOf(ctx).WORKSPACE_BOT_APP_PASSWORD, "TOKEN-abc123-1");

  // The token line is lost from .env (hand edit, partial restore): re-mint exactly one, never a second user.
  const kept = readFileSync(join(ctx.bundle, ".env"), "utf8").split("\n").filter((l) => !l.startsWith("WORKSPACE_BOT_APP_PASSWORD=")).join("\n");
  writeFileSync(join(ctx.bundle, ".env"), kept, { mode: 0o600 });
  writeFileSync(join(ctx.st, "calls.log"), "");
  assert.equal(run("bootstrap.sh", ctx).status, 0);
  const c3 = calls(ctx);
  assert.doesNotMatch(c3, /occ user:add /);
  assert.equal((c3.match(/user:resetpassword --password-from-env crow-bot/g) || []).length, 1);
  assert.equal((c3.match(/auth-tokens:add/g) || []).length, 1);
  assert.equal(envOf(ctx).WORKSPACE_BOT_APP_PASSWORD, "TOKEN-abc123-2");
});

test("REVIEW FOCUS 5b — bootstrap output never contains a secret; JWT not in argv", () => {
  const ctx = setup();
  const r = run("bootstrap.sh", ctx);
  assert.equal(r.status, 0, r.out);
  for (const v of [...Object.values(SECRETS), "TOKEN-abc123-1"]) assert.ok(!r.out.includes(v), `printed a secret: ${v.slice(0, 8)}…`);
  const c = calls(ctx);
  assert.ok(!c.includes(SECRETS.WORKSPACE_ONLYOFFICE_JWT_SECRET), "JWT must travel by env (-e OO_JWT), not argv");
  assert.match(c, /-e OO_JWT nextcloud sh -c php occ config:app:set onlyoffice jwt_secret --value="\$OO_JWT"/);
});

test("Nextcloud never finishing its install fails within the bounded wait", () => {
  const ctx = setup({ state: [] });
  const r = run("bootstrap.sh", ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /Nextcloud not ready after 2s/);
});

test("no tailnet name and none configured → clear refusal naming WORKSPACE_PUBLIC_HOST", () => {
  const ctx = setup({ state: ["installed", "no-tailnet"] });
  const r = run("bootstrap.sh", ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /WORKSPACE_PUBLIC_HOST/);
});

test("a configured WORKSPACE_PUBLIC_HOST is used as-is and tailscale is never asked", () => {
  const ctx = setup({ env: { WORKSPACE_PUBLIC_HOST: "office.example.lan" } });
  assert.equal(run("bootstrap.sh", ctx).status, 0);
  const c = calls(ctx);
  assert.doesNotMatch(c, /^ts /m);
  assert.match(c, /overwritehost --value=office\.example\.lan:8456/);
});

test("add-user.sh: creates once with a printed one-time password; second time is a no-op; bad login refused", () => {
  const ctx = setup();
  const r1 = run("add-user.sh", ctx, ["dayane", "Dayane"]);
  assert.equal(r1.status, 0, r1.out);
  assert.match(r1.stdout, /One-time password for dayane: [A-Za-z0-9]{20}\n/);
  assert.match(calls(ctx), /-e NC_PASS nextcloud php occ user:add --password-from-env --display-name=Dayane dayane/);
  const r2 = run("add-user.sh", ctx, ["dayane", "Dayane"]);
  assert.equal(r2.status, 0);
  assert.match(r2.stdout, /already exists/);
  assert.doesNotMatch(r2.stdout, /One-time password/);
  assert.notEqual(run("add-user.sh", ctx, ["Bad Login", "X"]).status, 0);
  assert.notEqual(run("add-user.sh", ctx, ["crow-bot", "X"]).status, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/workspace-bootstrap.test.js`
Expected: FAIL: bash `No such file or directory` for `ops/bootstrap.sh`.

- [ ] **Step 3: Implement `bundles/workspace/ops/bootstrap.sh`**

```bash
#!/usr/bin/env bash
# Crow Workspace post-install bootstrap. Idempotent: every step checks the
# current state first, so it is safe to re-run at any time:
#     bash ~/.crow/bundles/workspace/ops/bootstrap.sh
# Never prints a secret. Secrets reach occ through `docker compose exec -e`,
# never through argv.
set -euo pipefail
umask 077

BUNDLE_DIR="${CROW_BUNDLE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$BUNDLE_DIR/.env"
export CROW_HOME="${CROW_HOME:-$HOME/.crow}"
# Test seams: replace docker compose / tailscale / docker, and bound the waits.
DC="${WORKSPACE_DC:-docker compose}"
TS="${WORKSPACE_TS:-tailscale}"
DOCKER="${WORKSPACE_DOCKER:-docker}"
WAIT_S="${WORKSPACE_WAIT_S:-600}"
SLEEP_S="${WORKSPACE_SLEEP_S:-5}"
NET="crow-workspace_default"
BOT="crow-bot"

log() { printf '[workspace] %s\n' "$*"; }
die() { printf '[workspace] ERROR: %s\n' "$*" >&2; exit 1; }

# KEY=value reader that never sources the file (values are data, not shell).
env_get() { [ -f "$ENV_FILE" ] || return 0; sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
# Replace-or-append, atomically, keeping the file at mode 600.
env_set() {
  local tmp
  tmp="$(mktemp "$BUNDLE_DIR/.env.XXXXXX")"
  { grep -v "^$1=" "$ENV_FILE" || true; printf '%s=%s\n' "$1" "$2"; } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}
dc() { (cd "$BUNDLE_DIR" && $DC "$@"); }
occ() { dc exec -T -u www-data nextcloud php occ "$@"; }
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
random_pw() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

[ -f "$ENV_FILE" ] || die ".env missing at $ENV_FILE (reinstall Workspace from the Extensions page)"
ADMIN_USER="$(env_get WORKSPACE_ADMIN_USER)"; ADMIN_USER="${ADMIN_USER:-admin}"
NC_PORT="$(env_get WORKSPACE_NC_SERVE_PORT)"; NC_PORT="${NC_PORT:-8456}"
OO_PORT="$(env_get WORKSPACE_OO_SERVE_PORT)"; OO_PORT="${OO_PORT:-8457}"
OO_JWT="$(env_get WORKSPACE_ONLYOFFICE_JWT_SECRET)"
[ -n "$OO_JWT" ] || die "WORKSPACE_ONLYOFFICE_JWT_SECRET is missing from .env"
export OO_JWT

# 0. Where the household reaches it: this machine's tailnet name.
HOST="$(env_get WORKSPACE_PUBLIC_HOST)"
if [ -z "$HOST" ]; then
  HOST="$($TS status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
  [ -n "$HOST" ] || die "cannot work out this machine's tailnet name. Set WORKSPACE_PUBLIC_HOST (Extensions → Workspace → Configure) and re-run"
  env_set WORKSPACE_PUBLIC_HOST "$HOST"
fi
NC_URL="https://$HOST:$NC_PORT"
OO_URL="https://$HOST:$OO_PORT/"

# 1. Nextcloud finished its first-run install (the image does it on first start).
wait_for "Nextcloud" nc_installed

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

# 3. Reverse proxy: Tailscale Serve → 127.0.0.1:3070 → docker bridge gateway.
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

# 4. ONLYOFFICE connector: browser → public URL; server-to-server on the docker network.
occ config:app:set onlyoffice DocumentServerUrl --value="$OO_URL" >/dev/null
occ config:app:set onlyoffice DocumentServerInternalUrl --value="http://onlyoffice/" >/dev/null
occ config:app:set onlyoffice StorageUrl --value="http://nextcloud/" >/dev/null
dc exec -T -u www-data -e OO_JWT nextcloud sh -c 'php occ config:app:set onlyoffice jwt_secret --value="$OO_JWT"' >/dev/null
occ config:app:set onlyoffice jwt_header --value=Authorization >/dev/null
occ config:system:set onlyoffice allow_local_address --value=true --type=boolean >/dev/null
occ config:app:set onlyoffice defFormats --value='{"docx":true,"xlsx":true,"pptx":true,"odt":true,"ods":true,"odp":true}' >/dev/null
occ config:app:set onlyoffice editFormats --value='{"odt":true,"ods":true,"odp":true}' >/dev/null
wait_for "ONLYOFFICE" oo_connected

# 5. The shared "Menu" calendar, owned by the admin (shared with people in the Calendar app).
if occ dav:list-calendars "$ADMIN_USER" 2>/dev/null | grep -qE '^\| Menu +\|'; then
  log "calendar Menu: exists"
else
  occ dav:create-calendar "$ADMIN_USER" Menu >/dev/null
  log "calendar Menu: created"
fi

# 6. The Crow bot account (not admin) + exactly one app password, kept in .env (600).
if occ user:info "$BOT" >/dev/null 2>&1; then BOT_EXISTS=1; else BOT_EXISTS=0; fi
if [ "$BOT_EXISTS" = 1 ] && [ -n "$(env_get WORKSPACE_BOT_APP_PASSWORD)" ]; then
  log "$BOT: present"
else
  NC_PASS="$(random_pw 40)"; export NC_PASS
  if [ "$BOT_EXISTS" = 0 ]; then
    dc exec -T -u www-data -e NC_PASS nextcloud php occ user:add --password-from-env --display-name="Crow bot" "$BOT" >/dev/null
  else
    dc exec -T -u www-data -e NC_PASS nextcloud php occ user:resetpassword --password-from-env "$BOT" >/dev/null
  fi
  TOKEN="$(dc exec -T -u www-data -e NC_PASS nextcloud php occ user:auth-tokens:add --password-from-env --name crow-workspace-tools "$BOT" | tail -n 1 | tr -d '\r')"
  unset NC_PASS
  [ -n "$TOKEN" ] || die "could not mint the $BOT app password"
  env_set WORKSPACE_BOT_APP_PASSWORD "$TOKEN"
  log "$BOT: account ready; app password stored in .env (mode 600)"
fi

log "done. Workspace: $NC_URL  editor: $OO_URL"
log "next: publish both on your tailnet (the Workspace page in Crow shows the two commands)"
```

- [ ] **Step 4: Implement `bundles/workspace/ops/add-user.sh`**

```bash
#!/usr/bin/env bash
# Create a household Workspace account with a one-time password, printed ONCE,
# to this terminal only. Ask the person to change it at first login.
#   bash ~/.crow/bundles/workspace/ops/add-user.sh <login> "<Display Name>"
set -euo pipefail
umask 077
BUNDLE_DIR="${CROW_BUNDLE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export CROW_HOME="${CROW_HOME:-$HOME/.crow}"
DC="${WORKSPACE_DC:-docker compose}"
LOGIN="${1:-}"; NAME="${2:-}"
die() { printf '[workspace] ERROR: %s\n' "$*" >&2; exit 1; }
dc() { (cd "$BUNDLE_DIR" && $DC "$@"); }

[[ "$LOGIN" =~ ^[a-z][a-z0-9._-]{1,31}$ ]] || die "login must be 2-32 lowercase letters, digits, dots, dashes or underscores, starting with a letter"
[ "$LOGIN" != "crow-bot" ] || die "crow-bot is managed by the bootstrap"
[ -n "$NAME" ] || NAME="$LOGIN"

if dc exec -T -u www-data nextcloud php occ user:info "$LOGIN" >/dev/null 2>&1; then
  echo "Account $LOGIN already exists; nothing changed."
  exit 0
fi
NC_PASS="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"; export NC_PASS
dc exec -T -u www-data -e NC_PASS nextcloud php occ user:add --password-from-env --display-name="$NAME" "$LOGIN" >/dev/null
echo "One-time password for $LOGIN: $NC_PASS"
echo "Ask them to change it at first login: avatar → Settings → Security → Password."
```

```bash
chmod +x bundles/workspace/ops/bootstrap.sh bundles/workspace/ops/add-user.sh
```

- [ ] **Step 5: Declare the hook in the manifest**

In `bundles/workspace/manifest.json`, add after `"docker": {…},`:

```json
  "postInstall": { "script": "ops/bootstrap.sh", "timeout_s": 1500 },
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm test -- tests/workspace-bootstrap.test.js tests/workspace-bundle.test.js
node scripts/build-registry.mjs && node scripts/build-registry.mjs --check
```

Expected: PASS; the registry reports in sync.

- [ ] **Step 7: Commit**

```bash
git add bundles/workspace/ops/bootstrap.sh bundles/workspace/ops/add-user.sh tests/workspace-bootstrap.test.js
git commit bundles/workspace registry/add-ons.json tests/workspace-bootstrap.test.js \
  -m "feat(workspace): idempotent occ bootstrap (apps, proxy, ONLYOFFICE, Menu calendar, crow-bot) + add-user"
git show --stat HEAD
```

---

### Task 6: Encrypted nightly backup, restore, and the timer installer

**Files:**
- Create in `bundles/workspace/ops/`: `backup.sh`, `restore.sh`, `restore-scratch.sh`, `restore-scratch.override.yml`, `install-backup-timer.sh`
- Test: `tests/workspace-backup.test.js`

**Interfaces:**
- Consumes: the compose service names (`nextcloud`, `nextcloud-db`), the `.env` location, `~/.crow/workspace/` (Task 4).
- Produces:
  - archive name `crow-workspace-YYYYmmdd-HHMMSS.tar.gpg`, containing `db.sql`, `nextcloud-files.tar` (the whole `/var/www/html`) and `bundle.env`;
  - destination `/mnt/external/crow-workspace-backups/`;
  - passphrase `~/.crow/workspace/backup-passphrase` (600);
  - units `~/.config/systemd/user/crow-workspace-backup.{service,timer}` (04:20 daily).
- Test seams (env): `WORKSPACE_DC`, `WORKSPACE_GPG`, `WORKSPACE_BACKUP_DEST`, `WORKSPACE_DATA_ROOT`, `WORKSPACE_BACKUP_PASSFILE`, `WORKSPACE_BACKUP_KEEP_DAYS`, `WORKSPACE_BACKUP_HOLD_S`, `WORKSPACE_SYSTEMCTL`, `XDG_CONFIG_HOME`, `WORKSPACE_BACKUP_ONCALENDAR`.

- [ ] **Step 1: Write the failing test**

Create `tests/workspace-backup.test.js`:

```js
/** ops/backup.sh, restore.sh, install-backup-timer.sh against a FAKE docker compose; real gpg in a scratch GNUPGHOME. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OPS = join(import.meta.dirname, "..", "bundles", "workspace", "ops");
const HAS_GPG = spawnSync("gpg", ["--version"]).status === 0;
const SKIP = !HAS_GPG && "gpg not installed";

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

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ws-bak-"));
  const ctx = { root, bundle: join(root, "bundle"), ws: join(root, "ws"), dest: join(root, "external"), st: join(root, "state"), bin: join(root, "bin"), gnupg: join(root, "gnupg") };
  for (const d of [ctx.bundle, ctx.ws, ctx.dest, ctx.st, ctx.bin, ctx.gnupg]) mkdirSync(d, { recursive: true });
  chmodSync(ctx.gnupg, 0o700);
  writeFileSync(join(ctx.bin, "dc"), FAKE_DC); chmodSync(join(ctx.bin, "dc"), 0o755);
  writeFileSync(join(ctx.bundle, ".env"), "WORKSPACE_DB_PASSWORD=env-SECRET\n", { mode: 0o600 });
  writeFileSync(join(ctx.ws, "backup-passphrase"), "test-passphrase-123\n", { mode: 0o600 });
  return ctx;
}
function backup(ctx, extra = {}) {
  const r = spawnSync("bash", [join(OPS, "backup.sh")], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH, HOME: ctx.root, GNUPGHOME: ctx.gnupg, FAKE_STATE: ctx.st,
      CROW_BUNDLE_DIR: ctx.bundle, WORKSPACE_DATA_ROOT: ctx.ws, WORKSPACE_BACKUP_DEST: ctx.dest,
      WORKSPACE_DC: join(ctx.bin, "dc"), ...extra,
    },
  });
  return { ...r, out: `${r.stdout}\n${r.stderr}` };
}
const calls = (ctx) => (existsSync(join(ctx.st, "calls.log")) ? readFileSync(join(ctx.st, "calls.log"), "utf8") : "");
const archives = (dir) => readdirSync(dir).filter((n) => /^crow-workspace-\d{8}-\d{6}\.tar\.gpg$/.test(n));

test("happy path: encrypted archive in staging (600) and on the drive; maintenance on then off", { skip: SKIP }, () => {
  const ctx = setup();
  const r = backup(ctx);
  assert.equal(r.status, 0, r.out);
  const [name] = archives(ctx.dest);
  assert.ok(name, "archive on the external drive");
  assert.deepEqual(archives(join(ctx.ws, "backups-staging")), [name]);
  assert.equal(statSync(join(ctx.ws, "backups-staging", name)).mode & 0o777, 0o600);
  const bytes = readFileSync(join(ctx.dest, name));
  assert.ok(!bytes.includes("FAKE SQL DUMP") && !bytes.includes("env-SECRET") && !bytes.includes("ustar"), "archive must be ciphertext");
  const c = calls(ctx);
  assert.ok(c.indexOf("maintenance:mode --on") < c.indexOf("mariadb-dump"));
  assert.ok(c.indexOf(" tar -C /var/www/html ") < c.indexOf("maintenance:mode --off"));
  assert.match(c, /exec -T -u root nextcloud tar -C \/var\/www\/html -cf - \./);
});

test("restore.sh round-trips the archive into a private dir", { skip: SKIP }, () => {
  const ctx = setup();
  assert.equal(backup(ctx).status, 0);
  const [name] = archives(ctx.dest);
  const target = join(ctx.root, "restored");
  const r = spawnSync("bash", [join(OPS, "restore.sh"), join(ctx.dest, name), target, join(ctx.ws, "backup-passphrase")], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: ctx.root, GNUPGHOME: ctx.gnupg } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statSync(target).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(target, "db.sql"), "utf8"), "-- FAKE SQL DUMP household-db\n");
  assert.equal(readFileSync(join(target, "nextcloud-files.tar"), "utf8"), "FAKE-FILES-TAR household-doc");
  assert.equal(readFileSync(join(target, "bundle.env"), "utf8"), "WORKSPACE_DB_PASSWORD=env-SECRET\n");
});

test("REVIEW FOCUS 4 — failure and hang still turn maintenance off; no plaintext left", { skip: SKIP }, () => {
  const ctx = setup();
  writeFileSync(join(ctx.st, "fail-dump"), "");
  const r = backup(ctx);
  assert.notEqual(r.status, 0);
  const c = calls(ctx);
  assert.ok(c.indexOf("maintenance:mode --off") > c.indexOf("maintenance:mode --on"), "trap must turn maintenance off");
  assert.deepEqual(archives(ctx.dest), []);
  assert.deepEqual(readdirSync(join(ctx.ws, "backups-staging")), [], "no run-* work dir (plaintext dump) left behind");

  const ctx2 = setup();
  writeFileSync(join(ctx2.st, "slow-dump"), "");
  const r2 = backup(ctx2, { WORKSPACE_BACKUP_HOLD_S: "1" });
  assert.notEqual(r2.status, 0);
  assert.match(calls(ctx2), /maintenance:mode --off/);
  assert.deepEqual(readdirSync(join(ctx2.ws, "backups-staging")), []);
});

test("drive missing or not writable → refuses BEFORE maintenance mode", { skip: SKIP || (process.getuid && process.getuid() === 0 && "root ignores dir modes") }, () => {
  const ctx = setup();
  const locked = join(ctx.root, "locked");
  mkdirSync(locked); chmodSync(locked, 0o500);
  const r = backup(ctx, { WORKSPACE_BACKUP_DEST: join(locked, "crow-workspace-backups") });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /not writable/);
  assert.doesNotMatch(calls(ctx), /maintenance:mode/);
});

test("passphrase file must exist and be 600", { skip: SKIP }, () => {
  const ctx = setup();
  chmodSync(join(ctx.ws, "backup-passphrase"), 0o644);
  const r = backup(ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /must be mode 600/);
  assert.doesNotMatch(calls(ctx), /maintenance:mode/);
});

test("retention: drive keeps 14 days, staging keeps only the newest", { skip: SKIP }, () => {
  const ctx = setup();
  const old = join(ctx.dest, "crow-workspace-20260901-042000.tar.gpg");
  const recent = join(ctx.dest, "crow-workspace-20260929-042000.tar.gpg");
  const oldStaged = join(ctx.ws, "backups-staging", "crow-workspace-20260930-042000.tar.gpg");
  mkdirSync(join(ctx.ws, "backups-staging"), { recursive: true });
  for (const p of [old, recent, oldStaged]) writeFileSync(p, "x");
  const day = 86400;
  const now = Date.now() / 1000;
  utimesSync(old, now - 15 * day, now - 15 * day);
  utimesSync(recent, now - 3 * day, now - 3 * day);
  assert.equal(backup(ctx).status, 0);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(oldStaged), false);
  assert.equal(archives(join(ctx.ws, "backups-staging")).length, 1);
});

test("install-backup-timer.sh: user units with both caps; passphrase made once, shown once", () => {
  const ctx = setup();
  const pass = join(ctx.ws, "backup-passphrase");
  spawnSync("rm", ["-f", pass]);
  const fakeCtl = join(ctx.bin, "systemctl");
  writeFileSync(fakeCtl, '#!/usr/bin/env bash\nprintf "%s\\n" "systemctl $*" >> "$FAKE_STATE/calls.log"\n'); chmodSync(fakeCtl, 0o755);
  const env = { PATH: process.env.PATH, HOME: ctx.root, FAKE_STATE: ctx.st, CROW_HOME: join(ctx.root, "crowhome"), CROW_BUNDLE_DIR: ctx.bundle, WORKSPACE_DATA_ROOT: ctx.ws, XDG_CONFIG_HOME: join(ctx.root, "cfg"), WORKSPACE_SYSTEMCTL: fakeCtl };
  const r1 = spawnSync("bash", [join(OPS, "install-backup-timer.sh")], { encoding: "utf8", env });
  assert.equal(r1.status, 0, r1.stderr);
  const secret = readFileSync(pass, "utf8").trim();
  assert.match(secret, /^[A-Za-z0-9]{48}$/);
  assert.equal(statSync(pass).mode & 0o777, 0o600);
  assert.ok(r1.stdout.includes(secret), "shown on first run");
  const svc = readFileSync(join(ctx.root, "cfg", "systemd", "user", "crow-workspace-backup.service"), "utf8");
  const tmr = readFileSync(join(ctx.root, "cfg", "systemd", "user", "crow-workspace-backup.timer"), "utf8");
  assert.match(svc, new RegExp(`ExecStart=/bin/bash ${ctx.bundle}/ops/backup.sh`));
  assert.match(svc, /TimeoutStartSec=2h/);
  assert.match(tmr, /OnCalendar=\*-\*-\* 04:20:00/);
  assert.match(tmr, /Persistent=true/);
  assert.match(calls(ctx), /systemctl --user enable --now crow-workspace-backup\.timer/);
  const r2 = spawnSync("bash", [join(OPS, "install-backup-timer.sh")], { encoding: "utf8", env });
  assert.equal(r2.status, 0);
  assert.ok(!r2.stdout.includes(secret), "never shown again");
  assert.equal(readFileSync(pass, "utf8").trim(), secret, "never replaced");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/workspace-backup.test.js`
Expected: FAIL (the scripts do not exist).

- [ ] **Step 3: Implement `bundles/workspace/ops/backup.sh`**

```bash
#!/usr/bin/env bash
# Nightly Crow Workspace backup (crow-workspace-backup.timer, 04:20).
#  1 maintenance mode on → 2 mariadb-dump (single-transaction) → 3 tar of
#  /var/www/html taken INSIDE the container (uid 33 owns the data) → 4 maintenance
#  off → 5 one gpg-encrypted archive (AES256) to staging, then the external drive;
#  the drive keeps KEEP_DAYS days, staging only the newest.
# Maintenance mode is held for steps 2-3 only, bounded by HOLD_S, and a trap
# turns it off on ANY exit. systemd's TimeoutStartSec=2h is the outer cap.
set -euo pipefail
umask 077

export CROW_HOME="${CROW_HOME:-$HOME/.crow}"
BUNDLE_DIR="${CROW_BUNDLE_DIR:-$CROW_HOME/bundles/workspace}"
WS="${WORKSPACE_DATA_ROOT:-$CROW_HOME/workspace}"
STAGING="$WS/backups-staging"
DEST="${WORKSPACE_BACKUP_DEST:-/mnt/external/crow-workspace-backups}"
PASSFILE="${WORKSPACE_BACKUP_PASSFILE:-$WS/backup-passphrase}"
KEEP_DAYS="${WORKSPACE_BACKUP_KEEP_DAYS:-14}"
HOLD_S="${WORKSPACE_BACKUP_HOLD_S:-1800}"
DC="${WORKSPACE_DC:-docker compose}"
GPG="${WORKSPACE_GPG:-gpg}"
TS="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="crow-workspace-$TS.tar.gpg"

log() { printf '[workspace-backup] %s\n' "$*"; }
die() { printf '[workspace-backup] ERROR: %s\n' "$*" >&2; exit 1; }
dc() { (cd "$BUNDLE_DIR" && $DC "$@"); }
occ() { dc exec -T -u www-data nextcloud php occ "$@"; }

# Preflight — all before maintenance mode, so a refusal never locks anyone out.
[ -f "$PASSFILE" ] || die "no backup passphrase at $PASSFILE (run ops/install-backup-timer.sh first)"
[ "$(stat -c %a "$PASSFILE")" = "600" ] || die "$PASSFILE must be mode 600"
[ -f "$BUNDLE_DIR/.env" ] || die "no .env at $BUNDLE_DIR"
mkdir -p "$DEST" 2>/dev/null || true
{ [ -d "$DEST" ] && [ -w "$DEST" ]; } || die "$DEST not writable (is /mnt/external mounted?)"
mkdir -p "$STAGING"
WORK="$(mktemp -d "$STAGING/run-$TS.XXXXXX")"

MAINT=0
cleanup() {
  local rc=$?
  if [ "$MAINT" = 1 ]; then
    occ maintenance:mode --off >/dev/null 2>&1 || log "WARNING: maintenance mode may still be ON. Run: cd $BUNDLE_DIR && CROW_HOME=$CROW_HOME docker compose exec -u www-data nextcloud php occ maintenance:mode --off"
    MAINT=0
  fi
  rm -rf "$WORK" "$STAGING/$ARCHIVE.part"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 143' INT TERM

DEADLINE=$(( $(date +%s) + HOLD_S ))
check_left() { LEFT=$(( DEADLINE - $(date +%s) )); [ "$LEFT" -gt 0 ] || die "maintenance window exceeded ${HOLD_S}s"; }

occ maintenance:mode --on >/dev/null
MAINT=1
log "maintenance mode on"
check_left
(cd "$BUNDLE_DIR" && timeout --kill-after=10 "$LEFT" $DC exec -T nextcloud-db sh -c 'exec mariadb-dump --single-transaction --default-character-set=utf8mb4 -uroot -p"$MARIADB_ROOT_PASSWORD" nextcloud') > "$WORK/db.sql"
check_left
(cd "$BUNDLE_DIR" && timeout --kill-after=10 "$LEFT" $DC exec -T -u root nextcloud tar -C /var/www/html -cf - .) > "$WORK/nextcloud-files.tar"
occ maintenance:mode --off >/dev/null
MAINT=0
log "maintenance mode off (dump + snapshot taken)"

cp "$BUNDLE_DIR/.env" "$WORK/bundle.env"
tar -C "$WORK" -cf - db.sql nextcloud-files.tar bundle.env \
  | "$GPG" --batch --yes --pinentry-mode loopback --passphrase-file "$PASSFILE" \
      --symmetric --cipher-algo AES256 -o "$STAGING/$ARCHIVE.part"
mv "$STAGING/$ARCHIVE.part" "$STAGING/$ARCHIVE"
chmod 600 "$STAGING/$ARCHIVE"
cp "$STAGING/$ARCHIVE" "$DEST/$ARCHIVE.part"
mv "$DEST/$ARCHIVE.part" "$DEST/$ARCHIVE"

find "$STAGING" -maxdepth 1 -name 'crow-workspace-*.tar.gpg' ! -name "$ARCHIVE" -delete
find "$DEST" -maxdepth 1 -name 'crow-workspace-*.tar.gpg' -mtime +"$((KEEP_DAYS - 1))" -delete
log "backup ok: $DEST/$ARCHIVE ($(du -h "$DEST/$ARCHIVE" | cut -f1))"
```

- [ ] **Step 4: Implement `bundles/workspace/ops/restore.sh`**

```bash
#!/usr/bin/env bash
# Decrypt + unpack a Crow Workspace backup into a private directory (mode 700).
#   bash ops/restore.sh <archive.tar.gpg> <target-dir> [passphrase-file]
# Produces db.sql, nextcloud-files.tar (all of /var/www/html), bundle.env.
# Then follow "Restore" in docs/guide/workspace.md (or ops/restore-scratch.sh for a test boot).
set -euo pipefail
umask 077
ARCHIVE="${1:?usage: restore.sh <archive.tar.gpg> <target-dir> [passphrase-file]}"
TARGET="${2:?usage: restore.sh <archive.tar.gpg> <target-dir> [passphrase-file]}"
PASSFILE="${3:-${CROW_HOME:-$HOME/.crow}/workspace/backup-passphrase}"
GPG="${WORKSPACE_GPG:-gpg}"
die() { printf '[workspace-restore] ERROR: %s\n' "$*" >&2; exit 1; }
[ -f "$ARCHIVE" ] || die "no archive at $ARCHIVE"
[ -f "$PASSFILE" ] || die "no passphrase file at $PASSFILE"
mkdir -p "$TARGET"
chmod 700 "$TARGET"
"$GPG" --batch --pinentry-mode loopback --passphrase-file "$PASSFILE" --decrypt "$ARCHIVE" | tar -C "$TARGET" -xf -
for f in db.sql nextcloud-files.tar bundle.env; do [ -s "$TARGET/$f" ] || die "archive is missing $f"; done
chmod 600 "$TARGET"/db.sql "$TARGET"/nextcloud-files.tar "$TARGET"/bundle.env
echo "Unpacked to $TARGET: db.sql, nextcloud-files.tar, bundle.env"
```

- [ ] **Step 5: Implement the scratch restore (exercised live in Task 9; no CI test, because it needs docker)**

`bundles/workspace/ops/restore-scratch.override.yml`:

```yaml
## Used ONLY by ops/restore-scratch.sh: a restored copy publishes no host ports
## (it must never collide with the live crow-workspace project on 3070/3071).
services:
  nextcloud:
    ports: !reset []
  onlyoffice:
    ports: !reset []
```

`bundles/workspace/ops/restore-scratch.sh`:

```bash
#!/usr/bin/env bash
# Prove a backup restores: boot it in a throwaway compose project
# (crow-ws-restore, no published ports, its own data dir), show its users and
# the admin's files, leave it running for inspection. Never touches crow-workspace.
#   bash ops/restore-scratch.sh <archive.tar.gpg> [passphrase-file]
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

ARCHIVE="${1:?usage: restore-scratch.sh <archive.tar.gpg> [passphrase-file] | --clean}"
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
sdc exec -T nextcloud-db sh -c 'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" nextcloud' < "$SCRATCH/unpacked/db.sql"
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

- [ ] **Step 6: Implement `bundles/workspace/ops/install-backup-timer.sh`**

```bash
#!/usr/bin/env bash
# Turn on nightly Workspace backups: a USER systemd timer (no sudo), plus the
# backup passphrase. The passphrase is generated once and SHOWN ONCE: write it
# down and keep it offline, because without it the archives cannot be opened.
# Idempotent: re-running rewrites the units and never touches the passphrase.
set -euo pipefail
umask 077
export CROW_HOME="${CROW_HOME:-$HOME/.crow}"
BUNDLE_DIR="${CROW_BUNDLE_DIR:-$CROW_HOME/bundles/workspace}"
WS="${WORKSPACE_DATA_ROOT:-$CROW_HOME/workspace}"
PASSFILE="$WS/backup-passphrase"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ONCAL="${WORKSPACE_BACKUP_ONCALENDAR:-*-*-* 04:20:00}"
SYSTEMCTL="${WORKSPACE_SYSTEMCTL:-systemctl}"
mkdir -p "$WS" "$UNIT_DIR"

if [ ! -f "$PASSFILE" ]; then
  head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48 > "$PASSFILE"
  chmod 600 "$PASSFILE"
  echo "=== Workspace backup passphrase (shown ONCE: write it down, keep it offline) ==="
  cat "$PASSFILE"; echo
  echo "=== Without it, the backups on the external drive cannot be opened. ==="
else
  echo "Backup passphrase already exists at $PASSFILE (not shown again)."
fi

cat > "$UNIT_DIR/crow-workspace-backup.service" <<EOF
[Unit]
Description=Nightly Crow Workspace backup (Nextcloud DB + files, gpg-encrypted to the external drive)

[Service]
Type=oneshot
Environment=CROW_HOME=$CROW_HOME
ExecStart=/bin/bash $BUNDLE_DIR/ops/backup.sh
TimeoutStartSec=2h
Nice=10
IOSchedulingClass=idle
EOF

cat > "$UNIT_DIR/crow-workspace-backup.timer" <<EOF
[Unit]
Description=Nightly Crow Workspace backup

[Timer]
OnCalendar=$ONCAL
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

$SYSTEMCTL --user daemon-reload
$SYSTEMCTL --user enable --now crow-workspace-backup.timer
if command -v loginctl >/dev/null 2>&1 && [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo yes)" != "yes" ]; then
  echo "WARNING: lingering is off for $(id -un); the timer only runs while you are logged in. Fix: sudo loginctl enable-linger $(id -un)"
fi
echo "Nightly backup enabled ($ONCAL). Run one now: systemctl --user start crow-workspace-backup.service"
```

```bash
chmod +x bundles/workspace/ops/*.sh
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm test -- tests/workspace-backup.test.js tests/workspace-bundle.test.js
bash -n bundles/workspace/ops/restore-scratch.sh   # syntax only (live-exercised in Task 9)
```

Expected: PASS, and a clean syntax check. The `workspace-bundle` "no changeme" walk now also covers `ops/`.

- [ ] **Step 8: Commit**

```bash
git add bundles/workspace/ops/backup.sh bundles/workspace/ops/restore.sh bundles/workspace/ops/restore-scratch.sh bundles/workspace/ops/restore-scratch.override.yml bundles/workspace/ops/install-backup-timer.sh tests/workspace-backup.test.js
git commit bundles/workspace/ops tests/workspace-backup.test.js \
  -m "feat(workspace): encrypted nightly backup (maintenance trap + caps), restore, scratch-restore, user timer installer"
git show --stat HEAD
```

---

### Task 7: The Workspace setup page (en/es panel)

**Files:**
- Create: `bundles/workspace/panel/workspace.js`
- Modify: `bundles/workspace/manifest.json` (add `"panel": "panel/workspace.js"`), `registry/add-ons.json` (regenerate)
- Test: `tests/workspace-panel.test.js`

**Interfaces:**
- Consumes: the `.env` keys `WORKSPACE_PUBLIC_HOST`, `WORKSPACE_NC_SERVE_PORT`, `WORKSPACE_OO_SERVE_PORT`, `WORKSPACE_ADMIN_USER` (Tasks 4/5); host ports 3070/3071; the `ops/*.sh` names (Tasks 5/6).
- Produces:
  - `WORKSPACE_STRINGS` (`{ en, es }`)
  - `readPublicSettings(crowHome: string): null | Record<string,string>`, which reads ONLY the four public keys
  - `workspaceUrls(settings): { host, nc, dav, office, ncPort, ooPort }`
  - `renderWorkspacePage(settings, lang): string`
  - default export: the panel `{ id: "workspace", route: "/dashboard/workspace", handler }`

- [ ] **Step 1: Write the failing test**

Create `tests/workspace-panel.test.js`:

```js
/** Crow Workspace setup page (W1 Task 7). Pure render functions — no gateway import. */
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
  "WORKSPACE_ADMIN_USER=admin", "WORKSPACE_ADMIN_PASSWORD=Admin-Secret-Value-123",
  "WORKSPACE_DB_PASSWORD=db-SECRET-x", "WORKSPACE_ONLYOFFICE_JWT_SECRET=jwt-SECRET-y",
  "WORKSPACE_BOT_APP_PASSWORD=TOKEN-zzz", "WORKSPACE_PUBLIC_HOST=box.tailnet-example.ts.net",
  "WORKSPACE_NC_SERVE_PORT=8456", "WORKSPACE_OO_SERVE_PORT=8457",
].join("\n") + "\n";

function keysDeep(o, p = "") {
  return Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keysDeep(v, `${p}${k}.`) : [`${p}${k}`])).sort();
}

test("en and es carry the same keys, all non-empty", () => {
  assert.deepEqual(keysDeep(WORKSPACE_STRINGS.es), keysDeep(WORKSPACE_STRINGS.en));
  for (const lang of ["en", "es"]) for (const [k, v] of Object.entries(WORKSPACE_STRINGS[lang])) assert.ok(String(v).trim(), `${lang}.${k}`);
});

test("readPublicSettings returns only the four public keys", () => {
  assert.deepEqual(readPublicSettings(home(ENV)), {
    WORKSPACE_ADMIN_USER: "admin", WORKSPACE_PUBLIC_HOST: "box.tailnet-example.ts.net",
    WORKSPACE_NC_SERVE_PORT: "8456", WORKSPACE_OO_SERVE_PORT: "8457",
  });
  assert.equal(readPublicSettings(home(null)), null);
});

test("URLs: Workspace, DAV base, editor", () => {
  const u = workspaceUrls(readPublicSettings(home(ENV)));
  assert.equal(u.nc, "https://box.tailnet-example.ts.net:8456");
  assert.equal(u.dav, "https://box.tailnet-example.ts.net:8456/remote.php/dav");
  assert.equal(u.office, "https://box.tailnet-example.ts.net:8457/");
});

test("page: address, DAVx⁵ base URL, iPhone CalDAV, tailnet note, Serve commands, backup + add-user", () => {
  const html = renderWorkspacePage(readPublicSettings(home(ENV)), "en");
  assert.ok(html.includes("https://box.tailnet-example.ts.net:8456"));
  assert.ok(html.includes("https://box.tailnet-example.ts.net:8456/remote.php/dav"));
  assert.ok(html.includes("DAVx"));
  assert.ok(html.includes(WORKSPACE_STRINGS.en.tailnetNote));
  assert.ok(html.includes("sudo tailscale serve --bg --https=8456 http://127.0.0.1:3070"));
  assert.ok(html.includes("sudo tailscale serve --bg --https=8457 http://127.0.0.1:3071"));
  assert.ok(html.includes("ops/install-backup-timer.sh"));
  assert.ok(html.includes("ops/add-user.sh"));
  assert.doesNotMatch(html, /tailscale funnel --/);
});

test("REVIEW FOCUS 5c — the page renders no secret value", () => {
  const html = renderWorkspacePage(readPublicSettings(home(ENV)), "en");
  for (const s of ["Admin-Secret-Value-123", "db-SECRET-x", "jwt-SECRET-y", "TOKEN-zzz"]) assert.ok(!html.includes(s), s);
});

test("not set up yet (no .env or no host) → friendly notice, no broken links", () => {
  for (const s of [null, { WORKSPACE_ADMIN_USER: "admin" }]) {
    const html = renderWorkspacePage(s, "en");
    assert.ok(html.includes(WORKSPACE_STRINGS.en.notReady));
    assert.doesNotMatch(html, /https:\/\/:/);
  }
});

test("hostile host value is escaped", () => {
  const html = renderWorkspacePage({ WORKSPACE_PUBLIC_HOST: '"><script>alert(1)</script>' }, "en");
  assert.doesNotMatch(html, /<script>alert/);
});

test("Spanish render; panel metadata", () => {
  assert.ok(renderWorkspacePage(readPublicSettings(home(ENV)), "es").includes(WORKSPACE_STRINGS.es.addressH));
  assert.equal(panel.id, "workspace");
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
 * Crow's Nest Panel — Crow Workspace setup page (W1 §4.5).
 *
 * Server-rendered, no client script. Reads ONLY four non-secret keys from the
 * installed bundle's .env (host, two Serve ports, admin login) — never a
 * password, JWT or app password. Copied alone to $CROW_HOME/panels/workspace.js
 * at install, so it imports nothing from the bundle.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const T = {
  en: {
    title: "Workspace",
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
    userP: "Add a household account (prints a one-time password):",
  },
  es: {
    title: "Workspace",
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
    userP: "Agrega una cuenta del hogar (muestra una contraseña de un solo uso):",
  },
};
export { T as WORKSPACE_STRINGS };

const PUBLIC_KEYS = ["WORKSPACE_PUBLIC_HOST", "WORKSPACE_NC_SERVE_PORT", "WORKSPACE_OO_SERVE_PORT", "WORKSPACE_ADMIN_USER"];
const NC_HOST_PORT = 3070;
const OO_HOST_PORT = 3071;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The four non-secret settings, or null when Workspace has no .env yet. */
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
  const host = (s && s.WORKSPACE_PUBLIC_HOST) || "";
  const ncPort = (s && s.WORKSPACE_NC_SERVE_PORT) || "8456";
  const ooPort = (s && s.WORKSPACE_OO_SERVE_PORT) || "8457";
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
    ${card(t.adminH, `<p>${esc(t.serveP)}</p><pre>sudo tailscale serve --bg --https=${esc(u.ncPort)} http://127.0.0.1:${NC_HOST_PORT}
sudo tailscale serve --bg --https=${esc(u.ooPort)} http://127.0.0.1:${OO_HOST_PORT}</pre>
      <p>${esc(t.backupP)}</p><pre>bash ~/.crow/bundles/workspace/ops/install-backup-timer.sh</pre>
      <p>${esc(t.userP)}</p><pre>bash ~/.crow/bundles/workspace/ops/add-user.sh &lt;login&gt; "&lt;Name&gt;"</pre>`)}
  </div>`;
}

export default {
  id: "workspace",
  name: "Workspace",
  icon: "document",
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

Expected: PASS; the registry reports in sync.

- [ ] **Step 5: Commit**

```bash
git add bundles/workspace/panel/workspace.js tests/workspace-panel.test.js
git commit bundles/workspace registry/add-ons.json tests/workspace-panel.test.js \
  -m "feat(workspace): en/es setup page — address, app passwords, DAVx⁵/iOS, tailnet note, admin commands"
git show --stat HEAD
```

---

### Task 8: Operator guide, full gates, PR, merge, deploy

**Files:**
- Create: `docs/guide/workspace.md`
- Modify: `docs/.vitepress/config.ts` (the English guide sidebar, next to `{ text: 'Phone (assistant calls)', link: '/guide/phone' }`)

**Interfaces:**
- Consumes: everything above.
- Produces: the PR, merged to `main`, with crow's `~/crow` updated and the gateways restarted. Task 9 installs from it.

- [ ] **Step 1: Write `docs/guide/workspace.md`**

```markdown
# Crow Workspace

A private office on your own machine: Nextcloud for files, sharing, calendars, contacts and forms, with ONLYOFFICE for editing Word/Excel/PowerPoint files together. Reachable only from your tailnet.

## Install
1. Extensions → **Crow Workspace** → Install. Type an admin password (12–128 characters: letters, digits and `! % * + , - . / : = ? @ ^ _ ~`). That is the only thing you type; every internal password is generated and stored at mode 600.
2. Setup finishes by itself after the containers start (first install: a few minutes, mostly the ~1.5 GB editor image). If it reports "setup is incomplete", fix the cause and run the command it printed (`bash ~/.crow/bundles/workspace/ops/bootstrap.sh`). Re-running it is always safe.
3. Open **Workspace** in Crow's sidebar and run the two `sudo tailscale serve …` commands it shows (once per machine). Never use `tailscale funnel` for these ports.

## Phones and laptops
The Workspace page has the exact addresses: the Nextcloud app plus DAVx⁵ on Android, native CalDAV/CardDAV on iPhone/Mac, and the browser or desktop client on laptops. Use one app password per device. Everything works only while the device is on the tailnet.

## Accounts
- Add a person: `bash ~/.crow/bundles/workspace/ops/add-user.sh <login> "<Name>"`. It prints a one-time password once; they change it at first login (avatar → Settings → Security).
- `crow-bot` is Crow's own account (not an admin). It sees only what you share with it.

## Backups
- Turn on: `bash ~/.crow/bundles/workspace/ops/install-backup-timer.sh`. It shows the backup passphrase **once**; keep it offline.
- Nightly at 04:20: maintenance mode (for the dump and snapshot only), then one gpg AES256 archive to `/mnt/external/crow-workspace-backups/`, kept 14 days.
- Run one now: `systemctl --user start crow-workspace-backup.service`, then `journalctl --user -u crow-workspace-backup -n 30`.

## Restore
- **Test a backup without touching the live one:** `bash ~/.crow/bundles/workspace/ops/restore-scratch.sh <archive.tar.gpg>`. It boots a portless copy (`crow-ws-restore`) and lists its users and files. Remove it with `--clean`.
- **Restore for real** (replaces the live data; register a window first):
  1. `export CROW_HOME=~/.crow && cd ~/.crow/bundles/workspace && docker compose down` (every `docker compose` below runs in this shell: the compose file needs `CROW_HOME`)
  2. Move the old data aside as root (it is owned by container users): `sudo mv ~/.crow/workspace/nextcloud ~/.crow/workspace/nextcloud.old && sudo mv ~/.crow/workspace/db ~/.crow/workspace/db.old`
  3. `bash ops/restore.sh <archive> ~/ws-restore` and copy `~/ws-restore/bundle.env` over `.env` (keep mode 600).
  4. Unpack the files: `mkdir -p ~/.crow/workspace/nextcloud && docker run --rm -v ~/.crow/workspace/nextcloud:/dst -v ~/ws-restore:/src:ro nextcloud:34.0.4-apache sh -c 'tar -C /dst -xpf /src/nextcloud-files.tar && chown -R www-data:www-data /dst'`
  5. `docker compose up -d nextcloud-db nextcloud-redis`, wait until healthy, then `docker compose exec -T nextcloud-db sh -c 'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" nextcloud' < ~/ws-restore/db.sql`
  6. `docker compose up -d`, then `docker compose exec -u www-data nextcloud php occ maintenance:mode --off`, then `bash ops/bootstrap.sh`
  7. Delete `~/ws-restore` (it holds plaintext).

## Upgrades
Images are pinned. Upgrade Nextcloud **one major version at a time** (34 → 35 → 36), each in a registered window and after a fresh backup: bump the `nextcloud` tag in the repo bundle (with a manifest version bump) AND in the installed `~/.crow/bundles/workspace/docker-compose.yml` (a version refresh never re-copies compose files), then `export CROW_HOME=~/.crow && cd ~/.crow/bundles/workspace && docker compose pull && docker compose up -d`, then check `occ status`. Never auto-update.

## Limits
ONLYOFFICE Community Edition allows about 20 simultaneous connections and no mobile *editing* in the browser (viewing works). Fine for a household.
```

In `docs/.vitepress/config.ts`, add directly after `{ text: 'Phone (assistant calls)', link: '/guide/phone' },`:

```ts
          { text: 'Crow Workspace', link: '/guide/workspace' },
```

- [ ] **Step 2: Run every CI gate locally**

```bash
cd ~/crow-wt-workspace
npm test                                   # FULL suite; expect 0 failures
node scripts/check-port-allocation.js      # expect OK
node scripts/build-registry.mjs --check    # expect "OK: all manifests valid, registry in sync."
npm test -- tests/auth-network.test.js     # expect 21/21 (exposure invariant untouched)
grep -rnI "changeme" bundles/workspace bundles/nextcloud || echo "no changeme"
```

Expected: all green.

- [ ] **Step 3: Commit the docs and push**

```bash
git add docs/guide/workspace.md
git commit docs/guide/workspace.md docs/.vitepress/config.ts -m "docs(workspace): operator guide — install, Serve, phones, accounts, backups, restore, upgrades"
git show --stat HEAD
git pull --rebase origin main
git push -u origin feat/workspace-w1-platform
```

- [ ] **Step 4: Open the PR (GitHub MCP; `gh` is not installed)**

Use `mcp__github__create_pull_request` with owner `kh0pper`, repo `crow`, head `feat/workspace-w1-platform`, base `main`, and title `Crow Workspace W1: platform extension + generic secret generation and post-install hooks`. The body should summarize Tasks 1–7, list the Rulings by number, and state: "Live acceptance (spec §4.7) runs on crow after merge (Task 9)." No AI attribution anywhere.

- [ ] **Step 5: Gate the merge on check-runs**

```bash
SHA=$(git rev-parse HEAD)
curl -s "https://api.github.com/repos/kh0pper/crow/commits/$SHA/check-runs" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); runs=d["check_runs"]; print(len(runs)); [print(r["name"], r["status"], r["conclusion"]) for r in runs]'
```

Expected: a non-empty list, every run `completed success`, including `suite`, `static-checks` and `audit`. An empty list on a current sha means something is wrong; do not merge. Then merge with `mcp__github__merge_pull_request` (squash).

- [ ] **Step 6: Deploy to crow**

```bash
git -C ~/crow branch --show-current          # must print: main  (never checkout in ~/crow)
git -C ~/crow pull --ff-only origin main
sudo systemctl restart crow-gateway crow-r4-gateway
sleep 20; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/health   # expect 200
systemctl is-active crow-gateway crow-r4-gateway                                   # expect active active
```

The sudo password is in `~/.claude/CLAUDE.md`; never write it into the repo.

---

### Task 9: LIVE install and §4.7 acceptance on crow (registered window; contains [KEVIN] steps)

This task starts containers. It runs only after Task 8 has merged and deployed. It is **attended**: it stops nothing in prod, and the only prod-touching step is the already-done gateway restart, so no deadman is required. If the crow gateway is ever unhealthy for more than 5 minutes during this task, run `sudo systemctl restart crow-gateway` and stop.

**Files:** none in the repo. It edits `~/CROW-SCHEDULE.md` and writes evidence to the scratchpad.

- [ ] **Step 1: Register the window.** Read `~/CROW-SCHEDULE.md` first, then add a Reservations row like:

```markdown
| **2026-10-0X (day) HH:MM → est. +2 h (attended; no GPU, no model containers; Workspace first start ~3-5 GB RAM)** | **Crow Workspace W1 first start + acceptance** (spec §4.7): install from Extensions, Serve :8456/:8457, backup + scratch restore | Claude session (crow) + Kevin | manual | crow-workspace project healthy AND crow-gateway/crow-r4-gateway active AND 35b :8003 /health unchanged AND row moved to Done |
```

- [ ] **Step 2: Before snapshot (acceptance §4.7-7)**

```bash
EV=/tmp/claude-1000/ws-accept; mkdir -p $EV
wdc() { (cd ~/.crow/bundles/workspace && CROW_HOME=$HOME/.crow docker compose "$@"); }   # compose needs CROW_HOME; used by every later step
systemctl is-active crow-gateway crow-r4-gateway | tee $EV/pre-units.txt
curl -s -o /dev/null -w 'gw %{http_code}\n' http://127.0.0.1:3001/health | tee -a $EV/pre-units.txt
curl -s -o /dev/null -w '35b %{http_code}\n' -m 5 http://127.0.0.1:8003/health | tee -a $EV/pre-units.txt
docker ps --format '{{.Names}} {{.Status}}' | sort > $EV/pre-ps.txt
free -m > $EV/pre-free.txt
```

- [ ] **Step 3: Pre-pull the images** (spares the install job from a 1.5 GB pull)

```bash
for i in nextcloud:34.0.4-apache mariadb:11.8.9 redis:8.2.10-alpine onlyoffice/documentserver:9.4.0.1; do docker pull "$i"; done
```

- [ ] **Step 4: [KEVIN] Install.** Kevin opens Crow → Extensions → Crow Workspace → Install, types the admin password, and leaves every other field as is. Claude watches the job:

```bash
wdc ps
journalctl -u crow-gateway --since "-15 min" | grep -i workspace | tail -40
```

Expected: the job ends `complete_restart`, and the log contains "Generated 4 internal secret(s)", "Prepared data folders", "[workspace] done.". If the job reports "setup is incomplete", read the tail, fix the cause, and run `bash ~/.crow/bundles/workspace/ops/bootstrap.sh`.

- [ ] **Step 5: Verify the install surface (§4.7-1)**

```bash
stat -c '%a %n' ~/.crow/bundles/workspace/.env ~/.crow/secrets/bundle-env/workspace.env   # 600 600
grep -rIl -i 'change_\?me' ~/.crow/bundles/workspace ~/.crow/secrets/bundle-env/workspace.env || echo "no changeme"
grep -c '^WORKSPACE_' ~/crow/.env || true                                                 # 0: nothing propagated
cut -d= -f1 ~/.crow/bundles/workspace/.env | sort                                         # key NAMES only, never values
wdc ps --format '{{.Service}} {{.State}} {{.Health}}'        # 5 running; db/redis/onlyoffice healthy
ss -ltn | grep -E ':(3070|3071) '                                                         # 127.0.0.1 only
stat -c '%a %U %n' ~/.crow/workspace ~/.crow/workspace/backups-staging                   # 700 kh0pp
wdc exec -T -u www-data nextcloud php occ app:list | grep -E 'calendar|contacts|forms|onlyoffice'
wdc exec -T -u www-data nextcloud php occ onlyoffice:documentserver --check
wdc exec -T -u www-data nextcloud php occ dav:list-calendars admin
wdc exec -T -u www-data nextcloud php occ user:info crow-bot  # groups: none (not admin)
wdc exec -T -u www-data nextcloud php occ setupchecks | tee $EV/setupchecks.txt
```

Record any setupchecks warning. A reverse-proxy or overwrite warning means Ruling 12 is wrong; fix the bootstrap in a follow-up PR (fix the product, not the instance).

- [ ] **Step 6: Publish on the tailnet and probe (§4.7-2)**

```bash
sudo tailscale serve --bg --https=8456 http://127.0.0.1:3070
sudo tailscale serve --bg --https=8457 http://127.0.0.1:3071
tailscale serve status | tee $EV/serve.txt          # 8456/8457 "(tailnet only)"; Funnel block unchanged (no "/" path)
H=crow.dachshund-chromatic.ts.net
curl -s https://$H:8456/status.php                  # "installed":true
curl -s https://$H:8457/healthcheck                 # true
ssh raven "curl -s -o /dev/null -w '%{http_code}\n' https://$H:8456/status.php"   # 200 from another tailnet node
# Public internet: black-swan resolving through public DNS (DoH), so it bypasses its own MagicDNS.
ssh black-swan "curl -sS -m 15 --doh-url https://cloudflare-dns.com/dns-query https://$H:8456/status.php; echo rc=\$?"   # must FAIL (rc≠0)
ssh black-swan "curl -sS -m 15 --doh-url https://cloudflare-dns.com/dns-query https://$H:8457/healthcheck; echo rc=\$?"  # must FAIL
ssh black-swan "curl -s -m 15 --doh-url https://cloudflare-dns.com/dns-query -o /dev/null -w '%{http_code}\n' https://$H/"  # Funnel root: not Nextcloud (404/403)
cd ~/crow && npm test -- tests/auth-network.test.js  # 21/21
```

Then, in a tailnet browser, open `https://$H:8456`, open a .docx, and confirm the editor loads over https with no mixed-content errors in the console. This verifies the X-Forwarded-Proto assumption; if it fails, file it before continuing.

- [ ] **Step 7: Household accounts and sharing.** Claude runs:

```bash
bash ~/.crow/bundles/workspace/ops/add-user.sh dayane "Dayane"
```

Claude passes the one-time password to Kevin in this terminal only; it is never stored or committed.

- [ ] **[KEVIN]** Give Dayane her password. She signs in and changes it (Settings → Security). Then, as admin:
  - in Calendar, share **Menu** with `dayane` (can edit);
  - in Files, create the folder **Shared with Crow** and share it with `crow-bot` (can edit);
  - upload or create `acceptance-test.docx` in a folder shared with Dayane.

- [ ] **Step 8: [KEVIN] Co-editing (§4.7-3).** Kevin and Dayane open `acceptance-test.docx` from two devices at once. Each types a line, and each sees the other's edit live. Kevin reports pass/fail.

- [ ] **Step 9: [KEVIN] Phones (§4.7-4).**
  - Both phones: create an app password (Workspace page instructions), install DAVx⁵, and add the account with the base URL shown on the Workspace page.
  - Kevin creates an event in **Menu** on his phone; it appears in Dayane's phone calendar app. Kevin reports pass/fail.

- [ ] **Step 10: Bot isolation (§4.7-5)**

```bash
T=$(sed -n 's/^WORKSPACE_BOT_APP_PASSWORD=//p' ~/.crow/bundles/workspace/.env)
curl -s -o /dev/null -w 'admin root: %{http_code}\n' -u "crow-bot:$T" -X PROPFIND -H 'Depth: 1' https://$H:8456/remote.php/dav/files/admin/
curl -s -o /dev/null -w 'shared: %{http_code}\n' -u "crow-bot:$T" -X PROPFIND -H 'Depth: 1' "https://$H:8456/remote.php/dav/files/crow-bot/Shared%20with%20Crow/"
unset T
```

Expected: the admin root is `403` or `404`; shared is `207`.

- [ ] **Step 11: Backup and restore (§4.7-6)**
  - **[KEVIN]** runs `bash ~/.crow/bundles/workspace/ops/install-backup-timer.sh` and writes the printed passphrase down offline.
  - Claude then runs:

```bash
systemctl --user list-timers crow-workspace-backup.timer
systemctl --user start crow-workspace-backup.service
journalctl --user -u crow-workspace-backup -n 30 --no-pager | tee $EV/backup.txt   # "backup ok: …"
ls -la /mnt/external/crow-workspace-backups/
A=$(ls -t /mnt/external/crow-workspace-backups/crow-workspace-*.tar.gpg | head -1); file "$A"   # "GPG symmetrically encrypted data (AES256 cipher)"
wdc exec -T -u www-data nextcloud php occ maintenance:mode   # "Maintenance mode is currently disabled"
bash ~/.crow/bundles/workspace/ops/restore-scratch.sh "$A" | tee $EV/restore.txt   # users include admin, dayane, crow-bot; admin files list acceptance-test.docx (or the folder it is in)
bash ~/.crow/bundles/workspace/ops/restore-scratch.sh --clean
docker ps --format '{{.Names}}' | grep crow-ws-restore || echo "scratch gone"
```

- [ ] **Step 12: After snapshot (§4.7-7) and capacity note**

```bash
systemctl is-active crow-gateway crow-r4-gateway | tee $EV/post-units.txt
curl -s -o /dev/null -w 'gw %{http_code}\n' http://127.0.0.1:3001/health | tee -a $EV/post-units.txt
curl -s -o /dev/null -w '35b %{http_code}\n' -m 5 http://127.0.0.1:8003/health | tee -a $EV/post-units.txt
diff $EV/pre-units.txt $EV/post-units.txt && echo "prod unchanged"
docker ps --format '{{.Names}} {{.Status}}' | sort | grep -v crow-workspace > $EV/post-ps.txt; diff <(cut -d' ' -f1 $EV/pre-ps.txt) <(cut -d' ' -f1 $EV/post-ps.txt)
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | grep crow-workspace | tee $EV/ram.txt
```

- [ ] **Step 13: Close out the schedule.**
  - Add a permanent row to the "Other timers/crons" table in `~/CROW-SCHEDULE.md`: `| 04:20 | crow-workspace-backup.timer (user): Workspace maintenance mode ≤30 min + gpg archive to /mnt/external; steady-state RAM <measured from ram.txt> |`.
  - Move the reservation row to Done with the results (pass/fail per §4.7 item).
  - File any failed item as a follow-up PR or issue.

- [ ] **Step 14: Handoff.** Report to Kevin:
  - each §4.7 item with pass/fail and its evidence path;
  - the measured RAM;
  - the Serve ports;
  - the reminder that the backup passphrase lives only on paper plus `~/.crow/workspace/backup-passphrase`;
  - that W2 (Crow toolset) is unblocked, and that it will read `WORKSPACE_BOT_APP_PASSWORD` from the bundle `.env`.

---

## Self-Review

**1. Spec coverage**

| Spec § | Covered by |
|---|---|
| 4.1 packaging: supersede nextcloud | Task 4 |
| 4.1 five services, restart, loopback | Task 4 |
| 4.1 pinned images, recorded in manifest | Task 4, Ruling 2 |
| 4.1 three-registry ports | Ruling 1, Task 4 |
| 4.1 RAM/disk in manifest | Task 4 |
| 4.2 two Serve ports | Task 7 panel, Task 9 Step 6 |
| 4.2 trusted_domains, overwrite*, trusted_proxies | Task 5 |
| 4.2 JWT and internal URLs | Tasks 4 and 5 |
| 4.2 no Funnel, auth-network, public probe | Task 8 Step 2, Task 9 Step 6 |
| 4.2 no ufw | Ruling 11 |
| 4.3 generated secrets at 600 | Tasks 1–2 |
| 4.3 only the admin password typed | Tasks 2 and 4 |
| 4.3 bootstrap steps 1–5, idempotent | Task 5 (Dayane: Task 9 Step 7) |
| 4.4 data dir | Task 4, Ruling 9 |
| 4.4 timer, steps 1–5, trap, timeout, 14 days, gpg, passphrase | Task 6 |
| 4.4 restore documented and tested | Task 6, Task 8 guide, Task 9 Step 11 |
| 4.5 setup page | Task 7 |
| 4.6 box schedule | Task 9 Steps 1 and 13 |
| 4.7 items 1–7 | Task 9 Steps 2–12 |

§6 risks: the ONLYOFFICE limits and the upgrade cadence are in the Task 8 guide; RAM is recorded in Task 9 Step 12.

**2. Placeholder scan.** No TBD/TODO. Every code step has full code. The two live-only scripts (`restore-scratch.sh`, and the Serve commands) are given in full; they are exercised in Task 9 rather than in CI, by design (docker/sudo).

**3. Type and name consistency.** These names are used consistently across tasks:
- the helper functions `resolveGeneratedEnv`, `stripGeneratedKeys`, `writePrivateFile`, `gatewayExcludedKeys`, `envPatternViolation`, `precreateDirs`, `runPostInstall`, `postInstallPlan`, `safeRelPath`;
- the constants and seams `COMPOSE_LONG_TIMEOUT_MS`, `_setHookRunnerForTest`;
- the `WORKSPACE_*` env keys;
- the compose project and network `crow-workspace` / `crow-workspace_default`;
- the ports 3070/3071/8456/8457;
- the archive name pattern.

The fake-`docker compose` argv in the Task 5 and 6 tests matches the exact strings the scripts emit, e.g. `exec -T -u www-data -e OO_JWT nextcloud sh -c php occ …` and `exec -T -u root nextcloud tar -C /var/www/html -cf - .`.

**4. Review Focus.** All five lines have a test in the task that owns the code:
- 1 → Task 1;
- 2 → Task 2;
- 3 → Task 5;
- 4 → Task 6;
- 5 → Task 2 (5a), Task 5 (5b) and Task 7 (5c).

**Known unverified assumptions.** None of these could be checked without starting containers. Each is checked in Task 9, and none blocks the CI tasks.
- Tailscale Serve sends `X-Forwarded-Proto` to ONLYOFFICE. tailscaled 1.96.4 contains `SetXForwarded`, but the behavior is unconfirmed (Task 9 Step 6).
- `occ config:app:get <app> enabled` prints `yes` for an enabled store app.
- The Nextcloud entrypoint's rsync `--chown` also re-owns the bind-mount root.
- MariaDB 11.8's `healthcheck.sh` works without explicit credentials (the old nextcloud compose relied on the same).
- gpg loopback symmetric mode works on GitHub's ubuntu runner (the tests skip only if gpg is absent).
