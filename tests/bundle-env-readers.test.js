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
