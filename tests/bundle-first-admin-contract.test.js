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

const errs = (manifest, dir) => validateManifest(manifest, dir).errors || [];
const ok = (manifest, dir) => validateManifest(manifest, dir).ok;

test("each of the four modes is accepted", () => {
  const { dir } = tmpBundle("demo", { "ops/admin.sh": "#!/bin/sh\n" });
  for (const mode of FIRST_ADMIN_MODES) {
    const extra = mode === "crow" ? { env_vars: [KEYCHAIN_SECRET] } : {};
    const m = { ...WEB, firstAdmin: { mode, ...(mode === "default-login" ? { user: "admin" } : {}) }, ...extra };
    assert.equal(ok(m, dir), true, `${mode}: ${errs(m, dir).join("; ")}`);
  }
});

test("a webUI bundle without firstAdmin is refused", () => {
  const { dir } = tmpBundle("demo");
  const e = errs(WEB, dir).join("\n");
  assert.match(e, /firstAdmin/, "the error must name the field");
  assert.match(e, /webUI/, "and say it is because there is a web UI");
});

test("a bundle with no web UI (webUI null or absent) needs no firstAdmin", () => {
  const { dir } = tmpBundle("demo");
  assert.equal(ok({ ...WEB, webUI: null }, dir), true);
  const { webUI, ...noUI } = WEB;
  assert.equal(ok(noUI, dir), true);
});

test("mode crow without a keychain-generated secret or a postInstall is refused", () => {
  const { dir } = tmpBundle("demo", { "ops/admin.sh": "#!/bin/sh\n" });
  const bare = { ...WEB, firstAdmin: { mode: "crow" } };
  assert.match(errs(bare, dir).join("\n"), /generate: "secret" and keychain: true, or a postInstall/);

  // generate: "secret" WITHOUT keychain: the password would be lost, not created.
  const noKeychain = { ...WEB, firstAdmin: { mode: "crow" }, env_vars: [{ ...KEYCHAIN_SECRET, keychain: false }] };
  assert.equal(ok(noKeychain, dir), false, "generate without keychain is not 'Crow created the admin'");

  // keychain: true without generate: a typed field, not one Crow mints.
  const typed = { ...WEB, firstAdmin: { mode: "crow" }, env_vars: [{ name: "DEMO_ADMIN_PASSWORD", secret: true, keychain: true }] };
  assert.equal(ok(typed, dir), false, "a keychain entry with no generate is a human password");

  // Either real mechanism passes.
  assert.equal(ok({ ...WEB, firstAdmin: { mode: "crow" }, env_vars: [KEYCHAIN_SECRET] }, dir), true);
  assert.equal(ok({ ...WEB, firstAdmin: { mode: "crow" }, postInstall: { script: "ops/admin.sh" } }, dir), true);
});

test("default-login requires user, and user is only allowed there", () => {
  const { dir } = tmpBundle("demo");
  assert.match(
    errs({ ...WEB, firstAdmin: { mode: "default-login" } }, dir).join("\n"),
    /default-login\" needs user/,
  );
  for (const mode of ["crow", "finish-setup", "none"]) {
    const extra = mode === "crow" ? { env_vars: [KEYCHAIN_SECRET] } : {};
    const e = errs({ ...WEB, firstAdmin: { mode, user: "admin" }, ...extra }, dir).join("\n");
    assert.match(e, /firstAdmin\.user is only allowed with mode "default-login"/, mode);
  }
  assert.equal(ok({ ...WEB, firstAdmin: { mode: "default-login", user: "shiori" } }, dir), true);
});

test("path must start with /, note must be a string, the shape is closed", () => {
  const { dir } = tmpBundle("demo");
  // The schema's pattern catches this first (a "shape" error); the contract rule
  // is the second net for a hand-built manifest object.
  assert.match(errs({ ...WEB, firstAdmin: { mode: "none", path: "admin" } }, dir).join("\n"), /firstAdmin\/path|app path starting with/);
  assert.equal(ok({ ...WEB, firstAdmin: { mode: "none", path: "/admin", note: "One sentence." } }, dir), true);
  assert.equal(ok({ ...WEB, firstAdmin: { mode: "none", note: 42 } }, dir), false, "note is a sentence, not a number");
  assert.equal(ok({ ...WEB, firstAdmin: { mode: "whatever" } }, dir), false, "an unknown mode is not a declaration");
  assert.equal(ok({ ...WEB, firstAdmin: { mode: "none", extra: 1 } }, dir), false, "firstAdmin has no other fields");
});

test("buildRegistry refuses (invalid) a published webUI bundle with no firstAdmin", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-fa-reg-"));
  const write = (id, manifest) => {
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, "manifest.json"), JSON.stringify(manifest));
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

test("every real `crow` declaration names a mechanism the installer runs", () => {
  const bad = [];
  for (const [id, manifest] of Object.entries(realManifests())) {
    if (manifest?.firstAdmin?.mode !== "crow") continue;
    const keychain = (manifest.env_vars || []).some((v) => v && v.generate === "secret" && v.keychain === true);
    if (!keychain && !manifest.postInstall) bad.push(`${id}: crow with no keychain secret and no postInstall`);
  }
  assert.deepEqual(bad, [], "a `crow` claim must be something the installer really does");
});

test("the real manifests use the modes the audit mapped (no silent downgrade to `none`)", () => {
  const manifests = realManifests();
  // The four apps this repo really does create an admin for, from the survey.
  const crow = ["actual-budget", "maker-lab-advanced", "miniflux", "minio", "unsloth"];
  for (const id of crow) {
    assert.equal(manifests[id]?.firstAdmin?.mode, "crow", `${id} creates its own admin at install`);
  }
  // The one documented default login (motioneye's user list; shiori ships shiori/gopher).
  assert.deepEqual(
    { mode: manifests.shiori?.firstAdmin?.mode, user: manifests.shiori?.firstAdmin?.user },
    { mode: "default-login", user: "shiori" },
  );
  assert.deepEqual(
    { mode: manifests.motioneye?.firstAdmin?.mode, user: manifests.motioneye?.firstAdmin?.user },
    { mode: "default-login", user: "admin" },
  );
  // The audit's headline example: uptime-kuma's own setup page.
  assert.equal(manifests["uptime-kuma"]?.firstAdmin?.mode, "finish-setup");
  // An app that creates its own login programmatically but not through a
  // keychain secret or a postInstall CANNOT claim `crow` (the contract rule), so
  // it is a finish-setup with a note that says what Crow does for it.
  assert.equal(manifests.ntfy?.firstAdmin?.mode, "finish-setup");
  assert.ok(manifests.ntfy?.firstAdmin?.note, "ntfy's note explains Crow's own login");
});