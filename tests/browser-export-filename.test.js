/**
 * Browser bundle: a caller-chosen file name (crow_browser_export's filename,
 * crow_browser_save_session / load_session's name) stays inside its folder
 * (queue item 26f): no `../`, no absolute path, no separator, no hidden file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync, symlinkSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const { fileInDir } = await import("../bundles/browser/server/safe-file.js");

test("fileInDir: refuses names that leave the folder or are not plain file names", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-safe-file-"));
  try {
    for (const bad of ["../x", "../../etc/passwd", "/etc/passwd", "a/b", "a\\b", "..", ".", ".hidden", "x\u0000y", "x\ny", "", "a".repeat(129), "..\\x", "C:\\x", "€".repeat(100)]) {
      assert.throws(() => fileInDir(dir, bad, "csv"), /file name/, JSON.stringify(bad));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fileInDir: plain names land in the folder; a trailing .<ext> is not doubled", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-safe-file-"));
  try {
    assert.equal(fileInDir(dir, "report", "csv"), join(dir, "report.csv"));
    assert.equal(fileInDir(dir, "report.csv", "csv"), join(dir, "report.csv"));
    assert.equal(fileInDir(dir, "report.json", "csv"), join(dir, "report.json.csv"));
    assert.equal(fileInDir(dir, "top stories 2026-10-20", "json"), join(dir, "top stories 2026-10-20.json"));
    assert.equal(fileInDir(dir, "café..notes", "json"), join(dir, "café..notes.json"));
    for (const name of ["report", "a.b.c"]) assert.equal(dirname(fileInDir(dir, name, "csv")), dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fileInDir: refuses an existing symlink at the target (it could point anywhere)", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-safe-file-"));
  try {
    symlinkSync("/etc/hostname", join(dir, "link.csv"));
    assert.throws(() => fileInDir(dir, "link", "csv"), /symlink/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("writeFileNoFollow: refuses a symlink planted after the check; a session-style file gets 0600", async () => {
  const { writeFileNoFollow, readFileNoFollow } = await import("../bundles/browser/server/safe-file.js");
  const dir = mkdtempSync(join(tmpdir(), "crow-safe-file-"));
  try {
    const target = join(dir, "victim.txt");
    writeFileSync(target, "keep");
    symlinkSync(target, join(dir, "late.json"));
    assert.throws(() => writeFileNoFollow(join(dir, "late.json"), "x"), /ELOOP|symbolic/);
    assert.throws(() => readFileNoFollow(join(dir, "late.json")), /ELOOP|symbolic/);
    assert.equal(readFileSync(target, "utf8"), "keep");
    const s = join(dir, "s.json");
    writeFileSync(s, "old", { mode: 0o644 });
    writeFileNoFollow(s, '{"a":1}', 0o600);
    assert.equal(statSync(s).mode & 0o777, 0o600);
    assert.equal(readFileNoFollow(s), '{"a":1}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tools: export and session save/load with a traversal name write nothing outside their folders", async () => {
  const home = mkdtempSync(join(tmpdir(), "crow-browser-export-"));
  const prev = process.env.CROW_HOME;
  process.env.CROW_HOME = home;
  try {
    // playwright lives in the bundle's own node_modules, which CI and a fresh worktree
    // don't install; these tools never reach it before the name check, so stub it.
    const { registerHooks } = await import("node:module");
    registerHooks({
      resolve(specifier, context, next) {
        try { return next(specifier, context); } catch (err) {
          if (specifier !== "playwright" || err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
          return { url: "crow-test-stub:playwright", shortCircuit: true };
        }
      },
      load(url, context, next) {
        if (url !== "crow-test-stub:playwright") return next(url, context);
        return { format: "module", source: "export const chromium = { connectOverCDP: async () => { throw new Error('no browser in tests'); } };", shortCircuit: true };
      },
    });
    const { createBrowserServer } = await import("../bundles/browser/server/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const sessionDir = join(home, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    const server = createBrowserServer({ sessionDir });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      return { text: r.content.map((c) => c.text).join(""), isError: !!r.isError };
    };
    try {
      for (const filename of ["../escape", "../../escape", "/tmp/escape", "sub/escape"]) {
        const r = await call("crow_browser_export", { data: [{ a: 1 }], format: "json", filename });
        assert.equal(r.isError, true, filename);
        assert.match(r.text, /file name/, filename);
      }
      // Nothing was written anywhere under CROW_HOME except (maybe) the empty exports
      // folder and the browser lease (each tool call takes it: lease-guard.js).
      const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
      assert.deepEqual(walk(home).filter((f) => !f.startsWith(join(home, "browser-lease") + "/")), []);
      assert.equal(existsSync(join(tmpdir(), "escape.json")), false);

      const ok = await call("crow_browser_export", { data: [{ a: 1 }], format: "json", filename: "rows.json" });
      assert.equal(ok.isError, false, ok.text);
      const path = JSON.parse(ok.text).path;
      assert.match(path, /browser-exports[\\/]rows\.json$/);

      for (const tool of ["crow_browser_save_session", "crow_browser_load_session"]) {
        const r = await call(tool, { name: "../../escape" });
        assert.equal(r.isError, true, tool);
        assert.match(r.text, /file name/, tool);
      }
    } finally { await client.close(); }
  } finally {
    if (prev === undefined) delete process.env.CROW_HOME; else process.env.CROW_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
