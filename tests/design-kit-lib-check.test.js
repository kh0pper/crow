// Design kit (spec §3.2, §7): the library manifest integrity rules CI enforces —
// every hash, every licence file, exact pins, and no runtime fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkLib, checkNoRemoteRefs, cssFetches, sha256Hex } from "../bundles/design-kit/server/lib-check.js";

const ROOT = new URL("..", import.meta.url).pathname;

function fixture(mutate = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "dk-lib-"));
  const lib = join(dir, "lib");
  mkdirSync(join(lib, "css", "demo"), { recursive: true });
  mkdirSync(join(lib, "licenses"), { recursive: true });
  const css = Buffer.from(":root{--x:1}.a{background:url(data:image/png;base64,AA)}");
  writeFileSync(join(lib, "css", "demo", "demo.css"), css);
  writeFileSync(join(lib, "licenses", "demo.txt"), "MIT License\n");
  const man = {
    schema: 1, kit_version: "1.0.0", meta_files: [],
    entries: [{
      name: "css:demo", kind: "css", version: "1.2.3", license: "MIT", license_file: "licenses/demo.txt", license_sha256: sha256Hex(Buffer.from("MIT License\n")),
      source: "npm:demo-css@1.2.3", allowed: ["page", "document", "diagram"],
      files: [{ path: "css/demo/demo.css", sha256: sha256Hex(css), type: "text/css" }], main: "css/demo/demo.css", requires: [],
    }],
  };
  mutate(man, lib);
  writeFileSync(join(lib, "manifest.json"), JSON.stringify(man));
  return { dir, lib, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const errsOf = (mutate) => { const f = fixture(mutate); try { return checkLib(f.lib).errors.join("\n"); } finally { f.done(); } };

test("a clean fixture passes", () => {
  assert.equal(errsOf(() => {}), "");
});

test("each rule fails with a named reason", () => {
  assert.match(errsOf((m) => { m.entries[0].files[0].sha256 = "0".repeat(64); }), /sha256 mismatch/);
  assert.match(errsOf((m, lib) => writeFileSync(join(lib, "css", "stray.css"), "x")), /unlisted file in lib\/: css\/stray\.css/);
  assert.match(errsOf((m) => { m.entries[0].license_file = "licenses/none.txt"; }), /licence file missing/);
  assert.match(errsOf((m) => { m.entries[0].license_sha256 = "0".repeat(64); }), /licence sha256 mismatch/);
  assert.match(errsOf((m, lib) => { m.entries[0].notices = [{ path: "licenses/demo-third-party.txt", sha256: "0".repeat(64) }]; writeFileSync(join(lib, "licenses", "demo-third-party.txt"), "x"); }), /sha256 mismatch for licenses\/demo-third-party\.txt/);
  assert.match(errsOf((m) => { m.entries[0].notices = [{ path: "css/demo/demo.css", sha256: "0".repeat(64) }]; }), /notices must live under licenses\//);
  assert.match(errsOf((m) => { m.entries[0].license = "CC-BY-NC-4.0"; }), /not on the allowlist/);
  assert.match(errsOf((m) => { m.entries[0].version = "^1.2.3"; }), /exact x\.y\.z/);
  assert.match(errsOf((m) => { m.entries[0].source = "npm:demo-css@latest"; }), /exact pin/);
  assert.match(errsOf((m) => { m.entries[0].allowed = ["slides"]; }), /subset of page, document, diagram/);
  assert.match(errsOf((m) => { m.entries[0].requires = ["css:ghost"]; }), /requires unknown css:ghost/);
  assert.match(errsOf((m) => { m.entries[0].name = "demo"; }), /does not match kind css/);
  assert.match(errsOf((m) => { m.entries[0].main = "css/demo/other.css"; }), /main must be one of its files/);
  assert.match(errsOf((m) => { m.entries.push({ ...m.entries[0] }); }), /duplicate name/);
  assert.match(errsOf((m) => { m.entries[0].files[0].type = "text/html"; }), /type text\/html not allowed/);
});

test("font entries need a plain family and a generic fallback", () => {
  const font = (extra) => (m, lib) => {
    const woff = Buffer.from("wOF2fake");
    mkdirSync(join(lib, "font", "demo"), { recursive: true });
    writeFileSync(join(lib, "font", "demo", "demo-latin-400-normal.woff2"), woff);
    m.entries.push({ name: "font:demo", kind: "font", version: "5.0.0", license: "OFL-1.1", license_file: "licenses/demo.txt", license_sha256: sha256Hex(Buffer.from("MIT License\n")), source: "npm:@fontsource/demo@5.0.0",
      allowed: ["page"], files: [{ path: "font/demo/demo-latin-400-normal.woff2", sha256: sha256Hex(woff), type: "font/woff2" }], main: "font/demo/demo-latin-400-normal.woff2", requires: [], ...extra });
  };
  assert.equal(errsOf(font({ family: "Demo Sans", fallback: "sans-serif" })), "");
  assert.match(errsOf(font({ family: "Demo\";}body{", fallback: "sans-serif" })), /family/);
  assert.match(errsOf(font({ family: "Demo", fallback: "url(x)" })), /fallback/);
});

test("CSS that would fetch is refused; data: and relative urls are fine", () => {
  assert.equal(cssFetches("a{background:url(data:image/png;base64,AA)} b{src:url(./x.woff2)}"), false);
  assert.equal(cssFetches("@import 'x.css';"), true);
  assert.equal(cssFetches("a{background:url( 'https://evil.example/x.png')}"), true);
  assert.equal(cssFetches("a{background:url(//evil.example/x.png)}"), true);
  assert.match(errsOf((m, lib) => {
    const css = Buffer.from("a{background:url(https://evil.example/x.png)}");
    writeFileSync(join(lib, "css", "demo", "demo.css"), css);
    m.entries[0].files[0].sha256 = sha256Hex(css);
  }), /would fetch at runtime/);
});

test("kit code and skills may not name remote hosts (loopback is fine)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dk-refs-"));
  try {
    mkdirSync(join(dir, "server")); mkdirSync(join(dir, "skills")); mkdirSync(join(dir, "renderer", "engines"), { recursive: true });
    writeFileSync(join(dir, "server", "kit.js"), "const u = 'http://127.0.0.1:8018';");
    writeFileSync(join(dir, "skills", "a.md"), "Use the kit.");
    writeFileSync(join(dir, "renderer", "engines", "x.mjs"), "// nothing remote");
    assert.deepEqual(checkNoRemoteRefs(dir), []);
    writeFileSync(join(dir, "skills", "a.md"), "Load https://cdn.example/lib.js");
    assert.match(checkNoRemoteRefs(dir).join("\n"), /skills\/a\.md names a remote URL/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the CLI exits 1 on a broken fixture and 0 on a clean one", () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), "dk-root-"));
  try {
    mkdirSync(join(root, "bundles", "design-kit"), { recursive: true });
    cpSync(f.lib, join(root, "bundles", "design-kit", "lib"), { recursive: true });
    const ok = spawnSync(process.execPath, [join(ROOT, "scripts", "check-design-kit-lib.mjs"), "--root", root], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    writeFileSync(join(root, "bundles", "design-kit", "lib", "css", "demo", "demo.css"), "changed");
    const bad = spawnSync(process.execPath, [join(ROOT, "scripts", "check-design-kit-lib.mjs"), "--root", root], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /sha256 mismatch/);
  } finally { f.done(); rmSync(root, { recursive: true, force: true }); }
});

test("the repo's own lib/ passes", () => {
  const r = checkLib(join(ROOT, "bundles", "design-kit", "lib"));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(checkNoRemoteRefs(join(ROOT, "bundles", "design-kit")), []);
});
