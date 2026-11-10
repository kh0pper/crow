/**
 * N3-4 phase 1 — the `firstAdmin` declaration, its contract rules, and the repo
 * invariant that every bundle with a web UI declares one.
 *
 * Fails on the code before this change: the schema has no `firstAdmin` property
 * (so `strict: false` ajv accepts anything, including `"mode": "whatever"`), the
 * contract has no rules about it, `buildRegistry` publishes a webUI manifest that
 * says nothing about its first admin, and not one real bundle carries the field —
 * which is the whole finding: a freshly installed app's own first-run admin page
 * is claimable by anything else on the machine, and the manifest never said so.
 *
 * Fix round 1 (S2) tightened `crow`: it must name the mechanism (`via`) and that
 * mechanism must be wired to THIS app — a keychain secret the compose file
 * actually uses, or a postInstall script that names one. A Vaultwarden-shaped
 * "we generate a token somewhere" no longer passes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest, FIRST_ADMIN_MODES } from "../scripts/lib/bundle-contract.mjs";
import { buildRegistry } from "../scripts/build-registry.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLES = join(REPO, "bundles");

/** A throwaway bundle dir <root>/<id> with optional files. */
function tmpBundle(id, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "crow-fa-"));
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return { root, dir };
}

/** The 5 universal-required fields, plus a declared web UI. */
const WEB = {
  id: "demo", name: "Demo", description: "d", type: "bundle", category: "misc",
  webUI: { port: 8080, path: "/", label: "Demo" },
};
const KEYCHAIN_SECRET = { name: "DEMO_ADMIN_PASSWORD", generate: "secret", keychain: true, secret: true };
const USER_VAR = { name: "DEMO_ADMIN_USER", default: "admin" };
/** The app takes its first admin from the environment (the shape Miniflux has). */
const COMPOSE = [
  "services:",
  "  app:",
  "    image: demo/app:1",
  "    environment:",
  "      - ADMIN_PASSWORD=${DEMO_ADMIN_PASSWORD:?Set DEMO_ADMIN_PASSWORD}",
  "      - ADMIN_USER=${DEMO_ADMIN_USER:-admin}",
  "",
].join("\n");
const ENV_CROW = { mode: "crow", via: "env", secretEnv: "DEMO_ADMIN_PASSWORD" };

/** The `via: "env"` bundle: the compose file really reads the generated secret. */
function envCrow(overrides = {}) {
  return {
    ...WEB,
    docker: { composefile: "docker-compose.yml" },
    env_vars: [KEYCHAIN_SECRET, USER_VAR],
    firstAdmin: ENV_CROW,
    ...overrides,
  };
}
const COMPOSE_FILES = { "docker-compose.yml": COMPOSE };
/** A post-install hook that sets the admin from the generated secret. */
const HOOK = '#!/bin/sh\nset -e\n"$DEMO_ADMIN_PASSWORD" >/dev/null\ncurl -fsS -d "password=$DEMO_ADMIN_PASSWORD" http://127.0.0.1:8080/api/admin\n';
const HOOK_CROW = { mode: "crow", via: "postInstall" };

const errs = (manifest, dir) => validateManifest(manifest, dir).errors || [];
const ok = (manifest, dir) => validateManifest(manifest, dir).ok;
const errText = (manifest, dir) => errs(manifest, dir).join("\n");

test("each of the five modes is accepted", () => {
  const { dir } = tmpBundle("demo", { ...COMPOSE_FILES, "ops/admin.sh": HOOK });
  for (const mode of FIRST_ADMIN_MODES) {
    let m;
    if (mode === "crow") m = { ...envCrow(), firstAdmin: ENV_CROW };
    else m = { ...WEB, firstAdmin: { mode, ...(mode === "default-login" ? { user: "admin" } : {}) } };
    assert.equal(ok(m, dir), true, `${mode}: ${errText(m, dir)}`);
  }
  // The other `crow` shape, on its own fixture.
  const hook = { ...WEB, env_vars: [KEYCHAIN_SECRET], postInstall: { script: "ops/admin.sh" }, firstAdmin: HOOK_CROW };
  assert.equal(ok(hook, dir), true, `crow via postInstall: ${errText(hook, dir)}`);
});

test("a webUI bundle without firstAdmin is refused", () => {
  const { dir } = tmpBundle("demo");
  const e = errText(WEB, dir);
  assert.match(e, /firstAdmin/, "the error must name the field");
  assert.match(e, /webUI/, "and say it is because there is a web UI");
});

test("a bundle with no web UI (webUI null or absent) needs no firstAdmin", () => {
  const { dir } = tmpBundle("demo");
  assert.equal(ok({ ...WEB, webUI: null }, dir), true);
  const { webUI, ...noUI } = WEB;
  assert.equal(ok(noUI, dir), true);
});

test("mode crow must say via — a keychain secret alone is not a mechanism any more", () => {
  const { dir } = tmpBundle("demo", { ...COMPOSE_FILES, "ops/admin.sh": HOOK });
  // The old, too-weak shape: a generated keychain secret that nothing is proven to use.
  assert.match(
    errText({ ...WEB, env_vars: [KEYCHAIN_SECRET], firstAdmin: { mode: "crow" } }, dir),
    /needs via "env".*or "postInstall"/,
  );
  assert.match(errText({ ...WEB, firstAdmin: { mode: "crow" } }, dir), /needs via/);
  // via names only the two mechanisms.
  assert.match(errText({ ...envCrow({ firstAdmin: { mode: "crow", via: "magic" } }) }, dir), /firstAdmin\/via|needs via/);
});

test("via env: secretEnv must be a keychain-generated secret the compose file really uses", () => {
  const { dir } = tmpBundle("demo", COMPOSE_FILES);
  // No secretEnv at all.
  assert.match(errText(envCrow({ firstAdmin: { mode: "crow", via: "env" } }), dir), /needs secretEnv/);
  // A name that is not declared.
  assert.match(
    errText(envCrow({ firstAdmin: { mode: "crow", via: "env", secretEnv: "NOT_DECLARED" } }), dir),
    /must name an env_vars entry with generate: "secret" and keychain: true/,
  );
  // generate: "secret" WITHOUT keychain: the password would be lost, not created.
  const noKeychain = envCrow({ env_vars: [{ ...KEYCHAIN_SECRET, keychain: false }] });
  assert.equal(ok(noKeychain, dir), false, "generate without keychain is not 'Crow created the admin'");
  // keychain: true without generate: a typed field, not one Crow mints.
  const typed = envCrow({ env_vars: [{ name: "DEMO_ADMIN_PASSWORD", secret: true, keychain: true }] });
  assert.equal(ok(typed, dir), false, "a keychain entry with no generate is a human password");

  // The Vaultwarden shape (review S2): a keychain-generated token the app never
  // reads as its admin password. Generating it is not the same as creating the admin.
  const vaultwarden = {
    ...envCrow({
      env_vars: [KEYCHAIN_SECRET, { name: "DEMO_ADMIN_TOKEN", generate: "secret", keychain: true, secret: true }],
      firstAdmin: { mode: "crow", via: "env", secretEnv: "DEMO_ADMIN_TOKEN" },
    }),
  };
  assert.match(errText(vaultwarden, dir), /is never used by the compose file/, "the compose file never says ${DEMO_ADMIN_TOKEN}");

  // A compose file that uses it passes; a missing compose file cannot be confirmed.
  assert.equal(ok(envCrow({ firstAdmin: ENV_CROW }), dir), true);
  const { root, dir: empty } = tmpBundle("demo");
  assert.match(
    errText(envCrow({ firstAdmin: ENV_CROW }), empty),
    /cannot be confirmed/,
    "no compose file on disk: not a silent pass",
  );
  assert.ok(root);

  // userEnv, when given, must be a declared env var.
  assert.equal(ok(envCrow({ firstAdmin: { ...ENV_CROW, userEnv: "DEMO_ADMIN_USER" } }), dir), true);
  assert.match(
    errText(envCrow({ firstAdmin: { ...ENV_CROW, userEnv: "NO_SUCH_USER" } }), dir),
    /userEnv must name a declared env_vars entry/,
  );
});

test("via postInstall: the hook must exist and name a keychain-generated secret", () => {
  const silent = '#!/bin/sh\necho "nothing to do"\n';
  const { dir } = tmpBundle("demo", { "ops/silent.sh": silent, "ops/admin.sh": HOOK });
  const base = { ...WEB, env_vars: [KEYCHAIN_SECRET], firstAdmin: HOOK_CROW };

  // No postInstall at all.
  assert.match(errText(base, dir), /needs a postInstall script/);
  // A script that never mentions the generated secret: nothing sets the admin.
  assert.match(
    errText({ ...base, postInstall: { script: "ops/silent.sh" } }, dir),
    /never names a generate: "secret" \+ keychain: true env var/,
  );
  // A declared secret but no keychain flag: not something Crow creates and keeps.
  assert.match(
    errText({ ...base, env_vars: [{ ...KEYCHAIN_SECRET, keychain: false }], postInstall: { script: "ops/admin.sh" } }, dir),
    /needs an env_vars entry with generate: "secret" and keychain: true/,
  );
  // The hook that does the work passes.
  assert.equal(ok({ ...base, postInstall: { script: "ops/admin.sh" } }, dir), true);
});

test("default-login requires user, and user is only allowed there", () => {
  const { dir } = tmpBundle("demo", { ...COMPOSE_FILES, "ops/admin.sh": HOOK });
  assert.match(
    errText({ ...WEB, firstAdmin: { mode: "default-login" } }, dir),
    /default-login" needs user/,
  );
  for (const mode of FIRST_ADMIN_MODES) {
    if (mode === "default-login") continue;
    const base = mode === "crow" ? envCrow() : { ...WEB };
    const e = errText({ ...base, firstAdmin: { mode, user: "admin" } }, dir);
    assert.match(e, /firstAdmin\.user is only allowed with mode "default-login"/, mode);
  }
  assert.equal(ok({ ...WEB, firstAdmin: { mode: "default-login", user: "shiori" } }, dir), true);
});

test("path must start with /, note must be a string, the shape is closed", () => {
  const { dir } = tmpBundle("demo", COMPOSE_FILES);
  // The schema's pattern catches this first (a "shape" error); the contract rule
  // is the second net for a hand-built manifest object.
  assert.match(errText({ ...WEB, firstAdmin: { mode: "none", path: "admin" } }, dir), /firstAdmin\/path|app path starting with/);
  assert.equal(ok({ ...WEB, firstAdmin: { mode: "none", path: "/admin", note: "One sentence." } }, dir), true);
  assert.equal(ok({ ...WEB, firstAdmin: { mode: "none", note: 42 } }, dir), false, "note is a sentence, not a number");
  assert.equal(ok({ ...WEB, firstAdmin: { mode: "whatever" } }, dir), false, "an unknown mode is not a declaration");
  assert.equal(ok({ ...WEB, firstAdmin: { mode: "none", extra: 1 } }, dir), false, "firstAdmin has no other fields");
  // The crow mechanism fields cannot ride along on another mode.
  assert.match(
    errText({ ...WEB, firstAdmin: { mode: "finish-setup", via: "env", secretEnv: "DEMO_ADMIN_PASSWORD" } }, dir),
    /firstAdmin\.via is only allowed with mode "crow"|only allowed with mode/,
  );
});

test("buildRegistry refuses (invalid) a published webUI bundle with no firstAdmin", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-fa-reg-"));
  const write = (id, manifest, files = {}) => {
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, "manifest.json"), JSON.stringify(manifest));
    for (const [rel, content] of Object.entries(files)) writeFileSync(join(root, id, rel), content);
  };
  write("no-declaration", WEB);
  write("declared", { ...WEB, id: "declared", firstAdmin: { mode: "none" } });
  const { registry, audit } = buildRegistry({ bundlesRoot: root, tracked: null });
  assert.deepEqual(registry["add-ons"].map((e) => e.id), ["declared"], "only the declared one publishes");
  assert.equal(audit.find((a) => a.id === "no-declaration").status, "invalid");
  // The published entry carries the declaration through, so the store and the
  // Extensions page can read it from the registry too.
  assert.deepEqual(registry["add-ons"][0].firstAdmin, { mode: "none" });
});

// ── Repo invariant: every real web-UI bundle declares it, and every `crow` is real ──

/** id → parsed manifest for every bundles/<id>/manifest.json. */
function realManifests() {
  const out = {};
  for (const e of readdirSync(BUNDLES, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(BUNDLES, e.name, "manifest.json");
    if (!existsSync(p)) continue;
    out[e.name] = JSON.parse(readFileSync(p, "utf8"));
  }
  return out;
}

test("every real bundle with a webUI declares firstAdmin, and it validates", () => {
  const offenders = [];
  for (const [id, manifest] of Object.entries(realManifests())) {
    const declared = !!(manifest.webUI && typeof manifest.webUI === "object");
    if (declared && !manifest.firstAdmin) offenders.push(`${id}: webUI but no firstAdmin`);
    const { errors } = validateManifest(manifest, join(BUNDLES, id), { bundleExists: () => true });
    const fa = (errors || []).filter((e) => e.startsWith("firstAdmin"));
    if (fa.length) offenders.push(`${id}: ${fa.join("; ")}`);
  }
  assert.deepEqual(offenders, [], "web UI bundles with no (valid) firstAdmin declaration");
});

test("every real `crow` declaration names a mechanism the installer really runs", () => {
  const bad = [];
  for (const [id, manifest] of Object.entries(realManifests())) {
    const fa = manifest?.firstAdmin;
    if (!fa || fa.mode !== "crow") continue;
    const secrets = (manifest.env_vars || []).filter((v) => v && v.generate === "secret" && v.keychain === true);
    if (fa.via === "env") {
      if (!secrets.some((v) => v.name === fa.secretEnv)) bad.push(`${id}: secretEnv ${fa.secretEnv} is not a keychain secret`);
      else {
        const compose = join(BUNDLES, id, manifest.docker?.composefile || "");
        const text = existsSync(compose) ? readFileSync(compose, "utf8") : "";
        if (!text.includes(`\${${fa.secretEnv}`)) bad.push(`${id}: compose never uses \${${fa.secretEnv}`);
      }
    } else if (fa.via === "postInstall") {
      const script = join(BUNDLES, id, manifest.postInstall?.script || "");
      const text = existsSync(script) ? readFileSync(script, "utf8") : "";
      if (!manifest.postInstall) bad.push(`${id}: crow via postInstall with no postInstall`);
      else if (!secrets.some((v) => v.name && text.includes(v.name))) bad.push(`${id}: the hook never names a keychain secret`);
    } else if (fa.via === "setup") {
      // Crow runs the script itself with the password on stdin, so the script has to
      // ship in the bundle and the manifest has to name the account it creates.
      const script = join(BUNDLES, id, manifest.firstAdmin.setup?.script || "");
      if (!existsSync(script)) bad.push(`${id}: crow via setup with no setup script on disk`);
      if (typeof fa.user !== "string" || fa.user.trim() === "") bad.push(`${id}: crow via setup with no user`);
      if (typeof fa.secretEnv !== "string" || fa.secretEnv === "") bad.push(`${id}: crow via setup with no secretEnv`);
    } else {
      bad.push(`${id}: crow without via "env", "postInstall" or "setup"`);
    }
  }
  assert.deepEqual(bad, [], "a `crow` claim must be something the installer really does");
});

test("the real manifests use the modes the audit mapped (no silent downgrade to `none`)", () => {
  const manifests = realManifests();
  // The five apps this repo really does create an admin for, with the mechanism.
  assert.deepEqual(
    {
      "actual-budget": manifests["actual-budget"]?.firstAdmin,
      miniflux: manifests.miniflux?.firstAdmin,
      minio: manifests.minio?.firstAdmin,
      unsloth: manifests.unsloth?.firstAdmin,
      "maker-lab-advanced": manifests["maker-lab-advanced"]?.firstAdmin,
    },
    {
      "actual-budget": { mode: "crow", via: "postInstall" },
      miniflux: { mode: "crow", via: "env", secretEnv: "MINIFLUX_ADMIN_PASSWORD", userEnv: "MINIFLUX_ADMIN_USER" },
      minio: { mode: "crow", via: "env", secretEnv: "MINIO_ROOT_PASSWORD", userEnv: "MINIO_ROOT_USER" },
      unsloth: { mode: "crow", via: "env", secretEnv: "UNSLOTH_STUDIO_PASSWORD" },
      "maker-lab-advanced": { mode: "crow", via: "env", secretEnv: "MLA_ADMIN_PASSWORD", userEnv: "MLA_ADMIN_USER" },
    },
  );
  // The apps whose admin Crow creates from a SCRIPT it runs (via "setup"): the password
  // reaches the app on stdin, so the discovery window is closed instead of documented.
  for (const id of [
    "frigate",
    "motioneye",
    "wallabag",
    "uptime-kuma",
    "gitea",
    "forgejo",
    "shiori",
    "bookstack",
    "calibre-web",
    "stirling-pdf",
    "adguard-home",
    "trilium",
    "changedetection",
    "kolibri",
  ]) {
    assert.deepEqual(
      { mode: manifests[id]?.firstAdmin?.mode, via: manifests[id]?.firstAdmin?.via, script: manifests[id]?.firstAdmin?.setup?.script },
      { mode: "crow", via: "setup", script: "scripts/first-admin.sh" },
      id,
    );
    assert.equal(manifests[id]?.firstAdmin?.note, undefined, `${id}: a crow/setup app has no note to read`);
  }
  // The four apps that shipped a documented default login (Shiori's shiori/gopher,
  // BookStack's admin@admin.com/password, Calibre-Web's admin/admin123, Stirling's
  // admin/stirling): Crow replaces that password now, so the declaration names the account
  // its script gives the generated one to. The email one is BookStack's.
  assert.deepEqual(
    {
      shiori: manifests.shiori?.firstAdmin?.user,
      bookstack: manifests.bookstack?.firstAdmin?.user,
      "calibre-web": manifests["calibre-web"]?.firstAdmin?.user,
      "stirling-pdf": manifests["stirling-pdf"]?.firstAdmin?.user,
    },
    { shiori: "shiori", bookstack: "admin@localhost.localdomain", "calibre-web": "admin", "stirling-pdf": "admin" },
  );
  // The audit's headline example: uptime-kuma's own setup page. Crow claims the account
  // itself now (via a setup script), so nothing is left for a passer-by to claim.
  assert.deepEqual(
    { mode: manifests["uptime-kuma"]?.firstAdmin?.mode, user: manifests["uptime-kuma"]?.firstAdmin?.user },
    { mode: "crow", user: "crow-admin" },
  );
  // Plex runs its OWN server in this bundle, unclaimed until someone signs in:
  // the first Plex account that reaches it can claim it (review B2).
  assert.equal(manifests.plex?.firstAdmin?.mode, "finish-setup");
  assert.match(manifests.plex?.firstAdmin?.note || "", /first Plex account that reaches this server can claim it/);
  // ntfy denies everything by default and signup is off: there is nothing to claim
  // (review S1) — Crow's own login is the only one.
  assert.deepEqual(manifests.ntfy?.firstAdmin, { mode: "none", note: "Crow creates its login for phone alerts; nobody can sign up." });
  // Change Detection has no password at all until one is set (nit 8). Crow sets it at
  // install now, through the app's own settings form, so nothing is left to claim — and the
  // old note telling the operator to set one by hand is gone.
  assert.equal(manifests.changedetection?.firstAdmin?.mode, "crow");
  assert.equal(manifests.changedetection?.firstAdmin?.note, undefined);
  // AdGuard Home's and Kolibri's own setup wizards were the claimable pages; TriliumNext's
  // first password was. All three are set by Crow's script at install now, and the account
  // it creates is named in the declaration.
  assert.deepEqual(
    {
      "adguard-home": manifests["adguard-home"]?.firstAdmin?.user,
      trilium: manifests.trilium?.firstAdmin?.user,
      kolibri: manifests.kolibri?.firstAdmin?.user,
    },
    { "adguard-home": "admin", trilium: "trilium", kolibri: "admin" },
  );
  // Vikunja keeps its own registration page, and the card says how to close it.
  assert.equal(manifests.vikunja?.firstAdmin?.mode, "finish-setup");
  assert.match(manifests.vikunja?.firstAdmin?.note || "", /VIKUNJA_SERVICE_ENABLEREGISTRATION=false/);
  // These two connect to an app the operator already runs (nit 7).
  assert.equal(manifests.immich?.firstAdmin?.mode, "external");
  assert.equal(manifests.kodi?.firstAdmin?.mode, "external");
});
