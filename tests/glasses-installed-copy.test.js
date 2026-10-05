/**
 * The meta-glasses bundle must load from an INSTALLED COPY: the Extensions page copies
 * bundles/meta-glasses to <crow-home>/bundles/meta-glasses and its panel files to
 * <crow-home>/panels/, where a repo-relative import resolves to nothing.
 * Each import runs in a child process with its own CROW_HOME so nothing is cached or shared.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "bundles", "meta-glasses");

/** Lay the bundle out the way routes/bundles.js does at install. → the fake crow home */
// Copies live under the suite's scratch home when there is one, and are removed at the end.
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });
function installCopy() {
  const home = mkdtempSync(join(process.env.CROW_HOME || tmpdir(), "glasses-copy-"));
  made.push(home);
  const dest = join(home, "bundles", "meta-glasses");
  mkdirSync(join(home, "panels"), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  cpSync(SRC, dest, { recursive: true, filter: (p) => !p.includes("node_modules") });
  cpSync(join(dest, "panel", "meta-glasses.js"), join(home, "panels", "meta-glasses.js"));
  cpSync(join(dest, "panel", "routes.js"), join(home, "panels", "meta-glasses-routes.js"));
  symlinkSync(join(ROOT, "node_modules"), join(home, "panels", "node_modules"));
  symlinkSync(join(ROOT, "node_modules"), join(dest, "node_modules"));
  return home;
}

/** Import `file` in a child with the copy's environment; → what the child printed. */
function importInChild(home, file, expr) {
  const code = `import(${JSON.stringify(pathToFileURL(file).href)}).then((m) => { console.log(JSON.stringify(${expr})); process.exit(0); }, (e) => { console.log(JSON.stringify({ error: e.code || e.message })); process.exit(0); });`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, CROW_HOME: home, CROW_DATA_DIR: join(home, "data"), CROW_APP_ROOT: ROOT, HOME: home },
    timeout: 60_000, encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").pop());
}

test("the copied panel routes file loads and exports the router factory and the WebSocket hook", () => {
  const home = installCopy();
  const got = importInChild(home, join(home, "panels", "meta-glasses-routes.js"), "{ router: typeof m.default, ws: typeof m.setupWebSocket }");
  assert.deepEqual(got, { router: "function", ws: "function" });
});

test("the copied panel file loads", () => {
  const home = installCopy();
  const got = importInChild(home, join(home, "panels", "meta-glasses.js"), "{ id: m.default && m.default.id, handler: typeof (m.default && m.default.handler) }");
  assert.deepEqual(got, { id: "meta-glasses", handler: "function" });
});

test("the copied MCP server module loads with no repo beside it", () => {
  const home = installCopy();
  const got = importInChild(home, join(home, "bundles", "meta-glasses", "server", "server.js"), "{ make: typeof m.createMetaGlassesServer }");
  assert.deepEqual(got, { make: "function" });
});

test("no file in the bundle reaches the app by a relative path", () => {
  const bad = [];
  for (const dir of ["panel", "server"]) {
    for (const f of readdirSync(join(SRC, dir))) {
      if (!f.endsWith(".js")) continue;
      const text = readFileSync(join(SRC, dir, f), "utf8");
      if (text.includes("../../../servers") || text.includes('"./routes.js"')) bad.push(`${dir}/${f}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("no fallback to a conventional ~/crow tree: the app root is CROW_APP_ROOT or the repo the file sits in", () => {
  for (const f of ["server/app-root.js", "panel/routes.js", "panel/meta-glasses.js", "server/server.js"]) {
    const text = readFileSync(join(SRC, f), "utf8");
    assert.ok(!/homedir\(\),\s*"crow"/.test(text), `${f} guesses ~/crow`);
  }
});

test("the MCP server registers exactly the tools the manifest lists: no stubs, no continuous recording", () => {
  const home = installCopy();
  const got = importInChild(home, join(home, "bundles", "meta-glasses", "server", "server.js"), "Object.keys(m.createMetaGlassesServer()._registeredTools).sort()");
  const manifest = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8"));
  assert.deepEqual(got, manifest.capabilities.tools.map((t) => t.name).sort());
  for (const gone of ["crow_glasses_status", "crow_glasses_speak", "crow_glasses_capture_photo", "crow_glasses_capture_and_attach_photo", "crow_glasses_confirm_continuous_recording"]) {
    assert.ok(!got.includes(gone), gone);
  }
});

test("the copied panel renders the Devices tab, and its page script parses", () => {
  const home = installCopy();
  const expr = "await (async () => { let html = ''; await m.default.handler({ query: {} }, { send: (h) => { html = h; } }, { db: null, layout: ({ content }) => content }); return html; })()";
  const code = `import(${JSON.stringify(pathToFileURL(join(home, "panels", "meta-glasses.js")).href)}).then(async (m) => { const html = ${expr}; console.log(JSON.stringify({ html })); process.exit(0); }, (e) => { console.log(JSON.stringify({ error: e.code || e.message })); process.exit(0); });`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, CROW_HOME: home, CROW_DATA_DIR: join(home, "data"), CROW_APP_ROOT: ROOT, HOME: home }, timeout: 60_000, encoding: "utf8",
  });
  const { html, error } = JSON.parse(out.trim().split("\n").pop());
  assert.equal(error, undefined);
  const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("<\/script>"));
  assert.ok(script.includes("function fitLine") && script.includes("function turnsBlock") && script.includes("function voicePickers"));
  assert.doesNotThrow(() => new vm.Script(script), "the page script is valid JavaScript");
});
