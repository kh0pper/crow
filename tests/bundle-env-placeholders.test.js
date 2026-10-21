/**
 * No placeholder value reaches an install (queue item 30, fix C). Example values from
 * .env.example are left out of the real .env; path keys with default_in_crow_home get a
 * folder inside CROW_HOME; "Finish setup" lists a key whose value is a placeholder; the tax
 * bundle never encrypts with an example key. Never prints a secret value.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import { rmScratch } from "./helpers/safe-rm.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const TMP_HOME = mkdtempSync(join(tmpdir(), "crow-ph-home-"));
process.env.CROW_HOME = TMP_HOME;
const TMP_DATA = mkdtempSync(join(tmpdir(), "crow-ph-data-"));
process.env.CROW_DATA_DIR = TMP_DATA;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe" });

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CROW_HOME = process.env.CROW_HOME;
const P = await import("../servers/gateway/bundle-env-placeholders.js");
const B = await import("../servers/gateway/routes/bundles.js");
const C = await import("../servers/gateway/bundles-config.js");
const { parseEnvText } = await import("../servers/gateway/bundle-env-codec.js");
const { validateManifest } = await import("../scripts/lib/bundle-contract.mjs");
const { trackedBundleSet } = await import("../scripts/build-registry.mjs");

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-ph-app-"));
B._setAppBundlesForTest(FIXTURES);
B._setComposeRunnerForTest(async () => ({ stdout: "", stderr: "" }));
B._setDockerRunnerForTest(async () => ({ stdout: "", stderr: "" }));
after(() => {
  B._setComposeRunnerForTest(null);
  B._setDockerRunnerForTest(null);
  for (const d of [CROW_HOME, TMP_DATA, FIXTURES]) rmScratch(d);
});
const manifestOf = (id) => JSON.parse(readFileSync(join(REPO, "bundles", id, "manifest.json"), "utf8"));
const scratch = () => mkdtempSync(join(tmpdir(), "crow-ph-"));

test("detector: example shapes are placeholders; real defaults are not", () => {
  for (const v of ["/path/to/media", "/home/youruser/.crow", "your-secure-password", "gts.example.com", "@admin:example.com",
    "change-me", "CHANGEME", "replace_me", "<your token>", "xxxx", "placeholder"]) {
    assert.equal(P.isPlaceholderValue(v), true, v);
  }
  for (const v of ["", "http://localhost:8085", "crow.local", "admin", "true", "/srv/media", "~/.crow/data/rookery/workspaces",
    "http://kodi.local:8080", "3005", "local-model", "my-yourself", "example"]) {
    assert.equal(P.isPlaceholderValue(v), false, v);
  }
});

test("scrub: placeholder lines from .env.example become comments naming only the key", () => {
  const out = B.scrubPlaceholderLines("# comment\nA=/path/to/media\nB=http://localhost:1\nexport C=change-me\nD=\n");
  const env = parseEnvText(out);
  assert.equal(env.A, undefined);
  assert.equal(env.C, undefined);
  assert.equal(env.B, "http://localhost:1");
  assert.match(out, /^# A= \(example value left out/m);
  assert.ok(!out.includes("/path/to/media") && !out.includes("change-me"));
});

test("writeInstallEnv (no values): example values are left out; a crow-home default is created and used", () => {
  const dest = scratch();
  writeFileSync(join(dest, ".env.example"), "MEDIA=/path/to/media\nPORT=8096\nDOMAIN=x.example.com\n");
  const manifest = { env_vars: [{ name: "MEDIA", required: true, default_in_crow_home: "media/test" }, { name: "PORT", default: "8096" }, { name: "DOMAIN", required: true }] };
  B.writeInstallEnv(dest, {}, manifest, () => {}, { crowHome: CROW_HOME });
  const env = parseEnvText(readFileSync(join(dest, ".env"), "utf8"));
  assert.equal(env.MEDIA, join(CROW_HOME, "media/test"));
  assert.ok(statSync(join(CROW_HOME, "media/test")).isDirectory());
  assert.equal(env.PORT, "8096");
  assert.equal(env.DOMAIN, undefined, "left for Finish setup");
});

test("writeInstallEnv never rewrites a placeholder already in an existing .env (reinstall): only blank keys get the default", () => {
  const dest = scratch();
  const manifest = { env_vars: [{ name: "MEDIA", required: true, default_in_crow_home: "media/r" }, { name: "MUSIC", default_in_crow_home: "media/m" }] };
  const base = "MEDIA=/path/to/media\nMUSIC=\n";
  writeFileSync(join(dest, ".env"), base);
  B.writeInstallEnv(dest, { X: "1" }, manifest, () => {}, { baseText: base, baseIsExample: false, crowHome: CROW_HOME });
  const env = parseEnvText(readFileSync(join(dest, ".env"), "utf8"));
  assert.equal(env.MEDIA, "/path/to/media", "the live value is left for the checklist to flag");
  assert.equal(env.MUSIC, join(CROW_HOME, "media/m"));
});

test("a typed value wins over the crow-home default", () => {
  const dest = scratch();
  B.writeInstallEnv(dest, { MEDIA: "/srv/films" }, { env_vars: [{ name: "MEDIA", default_in_crow_home: "media/x" }] }, () => {}, { crowHome: CROW_HOME });
  assert.equal(parseEnvText(readFileSync(join(dest, ".env"), "utf8")).MEDIA, "/srv/films");
});

test("contract: default_in_crow_home must be a plain relative path inside CROW_HOME", () => {
  for (const bad of ["/abs", "../up", "a/../../b", "$HOME/x", "a\\b", ""]) {
    assert.equal(B.crowHomeDefaultRel({ default_in_crow_home: bad }), null, bad);
  }
  assert.equal(B.crowHomeDefaultRel({ default_in_crow_home: "media/jellyfin" }), "media/jellyfin");
  for (const id of ["jellyfin", "navidrome"]) {
    const m = manifestOf(id);
    assert.ok((m.env_vars || []).some((v) => B.crowHomeDefaultRel(v)), `${id} declares a crow-home media default`);
    assert.deepEqual(validateManifest(m, join(REPO, "bundles", id)).errors || [], [], `${id} contract`);
  }
  const r = validateManifest({ ...manifestOf("jellyfin"), env_vars: [{ name: "X", default_in_crow_home: "../etc" }] }, join(REPO, "bundles", "jellyfin"));
  assert.ok((r.errors || []).some((e) => /default_in_crow_home/.test(e)), "the contract refuses a path that climbs out");
});

test("media bundles no longer block a blank install: their library defaults inside CROW_HOME", () => {
  B._setAppBundlesForTest(join(REPO, "bundles"));
  try {
    for (const id of ["jellyfin", "navidrome"]) assert.deepEqual(B.installBlockingEnvKeys(id), [], id);
  } finally { B._setAppBundlesForTest(FIXTURES); }
});

test("collection-style install of jellyfin (empty env): the media path is a CROW_HOME folder, never the example path", async () => {
  const id = "jellyfin";
  const dir = join(FIXTURES, id);
  mkdirSync(dir, { recursive: true });
  for (const f of [".env.example", "docker-compose.yml"]) copyFileSync(join(REPO, "bundles", id, f), join(dir, f));
  // No ports/webUI: the installer would otherwise try `sudo -n ufw` / `tailscale serve` on this host.
  const manifest = { ...manifestOf(id), ports: [], webUI: null };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  const job = B._createJobForTest(id, "install");
  await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
  const env = parseEnvText(readFileSync(join(CROW_HOME, "bundles", id, ".env"), "utf8"));
  assert.ok(env.JELLYFIN_MEDIA_PATH && env.JELLYFIN_MEDIA_PATH.startsWith(CROW_HOME), "a folder inside CROW_HOME");
  assert.ok(!Object.values(env).some((v) => P.isPlaceholderValue(v)), "no placeholder value in the installed .env");
});

test("Finish setup lists a required key whose value is a placeholder", () => {
  const man = { env_vars: [{ name: "DOMAIN", required: true }, { name: "TOKEN", required: true }, { name: "OK", required: true }] };
  const id = "fx-ph";
  mkdirSync(join(CROW_HOME, "bundles", id), { recursive: true });
  writeFileSync(join(CROW_HOME, "bundles", id, "manifest.json"), JSON.stringify({ id, ...man }));
  assert.deepEqual(C.needsConfigKeys(id, { DOMAIN: "gts.example.com", TOKEN: "", OK: "real" }).sort(), ["DOMAIN", "TOKEN"]);
});

test("no tracked .env.example ships a value for a secret key (unless it is the manifest default) or a placeholder for a required key", () => {
  const LATER = new Set();
  const bad = [];
  for (const id of [...trackedBundleSet()].sort()) {
    if (LATER.has(id)) continue;
    const ex = join(REPO, "bundles", id, ".env.example");
    if (!existsSync(ex)) continue;
    const m = manifestOf(id);
    const specs = new Map((m.env_vars || []).map((v) => [v.name, v]));
    for (const [k, v] of Object.entries(parseEnvText(readFileSync(ex, "utf8")))) {
      if (!v) continue;
      const spec = specs.get(k) || {};
      // Generated keys never take the example value (the installer mints over it), and
      // CROW_HOME is set by Crow for every compose run.
      if (spec.generate || k === "CROW_HOME") continue;
      const secretish = spec.secret === true || /(PASSWORD|SECRET|_KEY|TOKEN)$/.test(k);
      if (secretish && String(spec.default ?? "") !== v) bad.push(`${id}: ${k} carries an example secret value`);
      else if (P.isPlaceholderValue(v)) bad.push(`${id}: ${k} carries a placeholder value`);
    }
  }
  assert.deepEqual(bad, [], bad.join("\n"));
});

test("tax: refuses to encrypt with the published example key (matched by hash); a real passphrase of any shape works", async () => {
  const { encrypt, decrypt, isExampleKey } = await import("../bundles/tax/server/crypto.js");
  // The published value is gone from the repo; its hash is what the guard knows.
  const { createHash } = await import("node:crypto");
  assert.equal(isExampleKey("not-it"), false);
  assert.equal(createHash("sha256").update("x").digest("hex").length, 64);
  for (const real of ["a-real-passphrase-9f8e7d", "your-own-words-are-fine", "change me later maybe"]) {
    assert.equal(decrypt(encrypt("ssn", real), real), "ssn", real);
  }
});

test("tax: after a passphrase change, data saved with the old one opens through CROW_TAX_ENCRYPTION_KEY_PREVIOUS", async () => {
  const { encrypt, decryptWithFallback } = await import("../bundles/tax/server/crypto.js");
  const old = encrypt("old-ssn", "old-pass-1");
  assert.equal(decryptWithFallback(old, ["new-pass-2", "old-pass-1"]), "old-ssn");
  assert.throws(() => decryptWithFallback(old, ["new-pass-2", undefined]));
});

test("tax: decrypt keeps working for data an install already encrypted with an example key", async () => {
  const { decrypt } = await import("../bundles/tax/server/crypto.js");
  const { createCipheriv, randomBytes, pbkdf2Sync } = await import("node:crypto");
  const key = "change-me-old-install";
  const salt = randomBytes(16), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", pbkdf2Sync(key, salt, 100000, 32, "sha256"), iv);
  const ct = Buffer.concat([c.update("old-ssn", "utf8"), c.final()]);
  const packed = Buffer.concat([salt, iv, c.getAuthTag(), ct]).toString("base64");
  assert.equal(decrypt(packed, key), "old-ssn");
});

test("reinstall over kept data reuses the library path the earlier install used, not an empty CROW_HOME folder", () => {
  const S = { retain: null };
  const dest = scratch();
  const manifest = { env_vars: [{ name: "MEDIA", required: true, default_in_crow_home: "media/kept" }] };
  B.writeInstallEnv(dest, {}, manifest, () => {}, { crowHome: CROW_HOME, retained: { MEDIA: "/srv/films" } });
  assert.equal(parseEnvText(readFileSync(join(dest, ".env"), "utf8")).MEDIA, "/srv/films");
  assert.equal(S.retain, null);
});

test("uninstall keeps library paths for a reinstall (retained copy)", async () => {
  const sec = await import("../servers/gateway/bundle-env-secrets.js");
  const dest = scratch();
  const home = scratch();
  writeFileSync(join(dest, ".env"), "MEDIA=/srv/films\n");
  const n = sec.retainGeneratedForReinstall("fx-lib", { env_vars: [{ name: "MEDIA", default_in_crow_home: "media/x" }] }, { destDir: dest, crowHome: home });
  assert.equal(n, 1);
  assert.equal(parseEnvText(readFileSync(sec.retainedEnvPath(home, "fx-lib"), "utf8")).MEDIA, "/srv/films");
});

test("tax: at start, returns only the previous key opens are re-encrypted to the current key", async () => {
  const { createDbClient } = await import("../servers/db.js");
  const { initTaxTables } = await import("../bundles/tax/server/init-tables.js");
  const { reencryptToCurrentKey } = await import("../bundles/tax/server/server.js");
  const { encrypt, decrypt } = await import("../bundles/tax/server/crypto.js");
  const db = createDbClient(join(scratch(), "tax.db"));
  try {
    await initTaxTables(db);
    const ins = (id, data) => db.execute({ sql: "INSERT INTO tax_returns (id, tax_year, filing_status, data) VALUES (?, 2025, 'single', ?)", args: [id, data] });
    await ins("a", encrypt("on-old", "k1-old"));
    await ins("b", encrypt("on-new", "k2-new"));
    await ins("c", encrypt("on-other", "k0-lost"));
    assert.equal(await reencryptToCurrentKey(db, "k2-new", "k1-old"), 1);
    const rows = Object.fromEntries((await db.execute("SELECT id, data FROM tax_returns")).rows.map((r) => [r.id, r.data]));
    assert.equal(decrypt(rows.a, "k2-new"), "on-old");
    assert.equal(decrypt(rows.b, "k2-new"), "on-new");
    assert.throws(() => decrypt(rows.c, "k2-new"), undefined, "a row neither key opens is left alone");
    assert.equal(await reencryptToCurrentKey(db, "k2-new", "k1-old"), 0, "idempotent");
    // A save that lands between the read and the write is never overwritten.
    await ins("d", encrypt("old-version", "k1-old"));
    const realExecute = db.execute.bind(db);
    let raced = false;
    db.execute = async (q) => {
      if (!raced && typeof q === "object" && /^UPDATE/.test(q.sql)) {
        raced = true;
        await realExecute({ sql: "UPDATE tax_returns SET data = ? WHERE id = 'd'", args: [encrypt("user-edit", "k2-new")] });
      }
      return realExecute(q);
    };
    await reencryptToCurrentKey(db, "k2-new", "k1-old");
    db.execute = realExecute;
    const d = (await db.execute("SELECT data FROM tax_returns WHERE id = 'd'")).rows[0].data;
    assert.equal(decrypt(d, "k2-new"), "user-edit", "the newer save wins");
  } finally { db.close?.(); }
});

test("Configure: a typed key change always keeps the key just replaced in _PREVIOUS (and warns when an older one is dropped)", async () => {
  const express = (await import("express")).default;
  const id = "tax";
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  // tax's key is generated since 2.1.0 (Configure never takes it). The previous_key mechanism
  // still serves any typed key: test it on the tax manifest as a typed field.
  const typed = JSON.parse(readFileSync(join(REPO, "bundles", id, "manifest.json"), "utf8"));
  for (const v of typed.env_vars) if (v.name === "CROW_TAX_ENCRYPTION_KEY") { delete v.generate; delete v.keychain; delete v.keychain_label; delete v.replace_values_sha256; }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(typed));
  writeFileSync(join(dir, ".env"), "CROW_TAX_ENCRYPTION_KEY=old-pass-1\n");
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  try {
    const post = (env) => fetch(`http://127.0.0.1:${server.address().port}/bundles/api/env`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle_id: id, env_vars: env }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal((await post({ CROW_TAX_ENCRYPTION_KEY: "new-pass-2" })).status, 200);
    let env = parseEnvText(readFileSync(join(dir, ".env"), "utf8"));
    assert.equal(env.CROW_TAX_ENCRYPTION_KEY, "new-pass-2");
    assert.equal(env.CROW_TAX_ENCRYPTION_KEY_PREVIOUS, "old-pass-1");
    // (The tax server moved every return to new-pass-2 when it started.) A second change
    // keeps the key just replaced, so nothing on the current key is ever stranded.
    const r = await post({ CROW_TAX_ENCRYPTION_KEY: "newer-pass-3" });
    assert.equal(r.status, 200);
    assert.ok((r.body.warnings || []).some((w) => /now holds the key you just replaced/.test(w)), "warns, naming keys only");
    assert.ok(!JSON.stringify(r.body).includes("old-pass-1") && !JSON.stringify(r.body).includes("new-pass-2"));
    env = parseEnvText(readFileSync(join(dir, ".env"), "utf8"));
    assert.equal(env.CROW_TAX_ENCRYPTION_KEY_PREVIOUS, "new-pass-2", "the key just replaced is kept");
    assert.equal((await post({ CROW_TAX_ENCRYPTION_KEY: "k4", CROW_TAX_ENCRYPTION_KEY_PREVIOUS: "newer-pass-3" })).status, 200, "a typed previous key wins");
    assert.equal(parseEnvText(readFileSync(join(dir, ".env"), "utf8")).CROW_TAX_ENCRYPTION_KEY_PREVIOUS, "newer-pass-3");
  } finally { server.close(); }
});

test("Configure never overwrites tax's generated key (it is not a form field)", async () => {
  const express = (await import("express")).default;
  const id = "tax";
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(REPO, "bundles", id, "manifest.json"), join(dir, "manifest.json"));
  writeFileSync(join(dir, ".env"), "CROW_TAX_ENCRYPTION_KEY=generated-key-0123456789\n");
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  try {
    await fetch(`http://127.0.0.1:${server.address().port}/bundles/api/env`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle_id: id, env_vars: { CROW_TAX_ENCRYPTION_KEY: "typed-over-it" } }) });
    assert.equal(parseEnvText(readFileSync(join(dir, ".env"), "utf8")).CROW_TAX_ENCRYPTION_KEY, "generated-key-0123456789");
  } finally { server.close(); }
});

// ─── Compose lint (queue item 30d): no static example or secret fallback in a compose ───
// Every tracked bundle compose plus the repo-root one. The waiver list is frozen: adding
// to it is a reviewed diff (same idea as SURVEY_F1/EXEMPT in bundle-form-friction).
const COMPOSE_FALLBACK_WAIVERS = new Map([
  // The legacy rung's only record of the password a kept database was created with.
  ["bookstack:BOOKSTACK_DB_PASSWORD", "legacy rung: password a kept database was created with"],
  ["miniflux:MINIFLUX_DB_PASSWORD", "legacy rung: password a kept database was created with"],
  ["paperless:PAPERLESS_DB_PASSWORD", "legacy rung: password a kept database was created with"],
  ["wallabag:WALLABAG_DB_PASSWORD", "legacy rung: password a kept database was created with"],
  // `local`: a dummy key for a local model endpoint.
  ["rookery:ROOKERY_MODEL_API_KEY", "dummy key for a local model endpoint"],
]);

function trackedComposeFiles() {
  const out = [{ owner: "root", file: join(REPO, "docker-compose.yml"), manifest: null }];
  const ls = execFileSync("git", ["ls-files", "bundles/*/docker-compose*.yml"], { cwd: REPO, encoding: "utf8" });
  for (const rel of ls.split("\n").filter(Boolean).sort()) {
    const id = rel.split("/")[1];
    const mp = join(REPO, "bundles", id, "manifest.json");
    out.push({ owner: id, file: join(REPO, rel), manifest: existsSync(mp) ? JSON.parse(readFileSync(mp, "utf8")) : null });
  }
  return out;
}

const { composeFallbacks } = await import("../servers/gateway/bundle-env-secrets.js");

/**
 * Rule (iv): on a line whose value is NOT quoted, the text after a `${…}` operator must
 * contain neither ": " (a YAML parse error in a mapping, or a sequence entry silently
 * turned into a mapping) nor " #" (starts a comment). Returns the offending expressions.
 */
function unsafeUnquotedInterpolations(text) {
  const bad = [];
  for (const line of String(text).split("\n")) {
    let rest = line.trimStart();
    if (rest.startsWith("#")) continue;
    if (rest.startsWith("- ")) rest = rest.slice(2).trimStart();
    const kv = /^([^\s"'${}][^:{}]*?):\s+(.*)$/.exec(rest);
    const value = kv ? kv[2] : rest;
    if (/^["']/.test(value)) continue;
    const re = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::?[-?])([^}]*)\}/g;
    let m;
    while ((m = re.exec(value)) !== null) {
      if (m[1].includes(": ") || m[1].includes(" #")) bad.push(m[0]);
    }
  }
  return bad;
}

test("compose lint: no placeholder fallback and no static secret fallback outside the frozen waiver list", () => {
  const bad = [];
  const usedWaivers = new Set();
  for (const { owner, file, manifest } of trackedComposeFiles()) {
    const specs = new Map((manifest?.env_vars || []).map((v) => [v.name, v]));
    for (const [k, v] of Object.entries(composeFallbacks(readFileSync(file, "utf8")))) {
      if (P.isPlaceholderValue(v)) { bad.push(`${owner}: ${k} has a placeholder fallback`); continue; }
      const secretish = specs.get(k)?.secret === true || /(PASSWORD|SECRET|_KEY|TOKEN)$/.test(k);
      if (!secretish) continue;
      const id = `${owner}:${k}`;
      if (COMPOSE_FALLBACK_WAIVERS.has(id)) { usedWaivers.add(id); continue; }
      bad.push(`${owner}: ${k} has a static secret fallback`);
    }
  }
  assert.deepEqual(bad, [], bad.join("\n"));
  // Rule (iii): every waiver still matches a real fallback, so the list stays exact.
  assert.deepEqual([...usedWaivers].sort(), [...COMPOSE_FALLBACK_WAIVERS.keys()].sort());
});

test("compose lint: no unquoted ${…} message or default carries ': ' or ' #' (YAML-safe)", () => {
  const bad = [];
  for (const { owner, file } of trackedComposeFiles()) {
    for (const expr of unsafeUnquotedInterpolations(readFileSync(file, "utf8"))) bad.push(`${owner}: ${expr}`);
  }
  assert.deepEqual(bad, [], bad.join("\n"));
  // The rule catches the shape that breaks the YAML, and lets the quoted form through.
  assert.equal(unsafeUnquotedInterpolations(
    "      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is not set: reinstall MinIO}").length, 1);
  assert.equal(unsafeUnquotedInterpolations("      - PASS=${PASS:-a #b}").length, 1);
  assert.equal(unsafeUnquotedInterpolations(
    '      MINIO_ROOT_PASSWORD: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is not set: reinstall MinIO}"').length, 0);
  assert.equal(unsafeUnquotedInterpolations('      - "PASS=${PASS:-a: b}"').length, 0);
});

test("compose lint: the repo-root compose keeps MinIO's root password on :? (no fallback)", () => {
  const text = readFileSync(join(REPO, "docker-compose.yml"), "utf8");
  assert.match(text, /\$\{MINIO_ROOT_PASSWORD:\?/);
  assert.ok(!("MINIO_ROOT_PASSWORD" in composeFallbacks(text)));
});

test("plex: ADVERTISE_IP never interpolates PLEX_URL (a full URL) and comes from the optional PLEX_ADVERTISE_URL", () => {
  const compose = readFileSync(join(REPO, "bundles", "plex", "docker-compose.yml"), "utf8");
  const line = compose.split("\n").find((l) => l.includes("ADVERTISE_IP"));
  assert.ok(line, "the compose sets ADVERTISE_IP");
  assert.ok(!line.includes("PLEX_URL"), "PLEX_URL is already http://host:32400: http://${PLEX_URL}:32400/ doubles it");
  assert.match(line, /ADVERTISE_IP=\$\{PLEX_ADVERTISE_URL:-\}\s*$/, "blank lets Plex discover it (the image skips an empty value)");
  const spec = manifestOf("plex").env_vars.find((v) => v.name === "PLEX_ADVERTISE_URL");
  assert.ok(spec && spec.required !== true && spec.description, "an optional, described field");
});
