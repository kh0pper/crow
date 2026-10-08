/**
 * R2/R1 (PR #455 re-check): add-on launcher pins are written by the flows
 * that own the entry, and shipped bundles keep working on a fresh install.
 *
 *   - Extensions install writes command_sha256 for a launcher that needs one
 *     (a relative ./run.sh in the bundle); node/npm/npx entries are unchanged;
 *   - the update (refresh) path re-pins an install-owned entry;
 *   - repinAddon (the owner's one-click re-pin and the operator script) pins
 *     an entry; a bare name it cannot pin is reported, not guessed;
 *   - pin-addon-command.mjs --check is read-only and reports per add-on;
 *   - every bundle manifest in this repo resolves on a fresh-install layout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpAddonEntryFor } from "../servers/gateway/routes/bundles.js";
import { resolveAddonCommand, checkLauncherArgs, addonLauncherStatus } from "../servers/shared/resolve-command.js";
import { repinAddon } from "../scripts/ops/pin-addon-command.mjs";

const REPO = new URL("..", import.meta.url).pathname;
const sha = (s) => createHash("sha256").update(s).digest("hex");

function bundleHome(files) {
  const home = mkdtempSync(join(tmpdir(), "alp-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(home, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body); chmodSync(p, 0o755);
  }
  return home;
}

test("install: a relative bundle launcher is pinned; node/npx entries stay byte-identical", () => {
  const home = bundleHome({ "bundles/rk/run.sh": "#!/bin/bash\necho rk\n" });
  const e = mcpAddonEntryFor({ server: { command: "./run.sh", args: [] } }, null, { bundleDir: join(home, "bundles", "rk") });
  assert.equal(e.command_sha256, sha("#!/bin/bash\necho rk\n"));
  assert.deepEqual(mcpAddonEntryFor({ server: { command: "node", args: ["server/index.js"] } }, null, { bundleDir: join(home, "bundles", "rk") }),
    { command: "node", args: ["server/index.js"] });
  assert.deepEqual(mcpAddonEntryFor({ server: { command: "npx", args: ["-y", "x"] } }, null), { command: "npx", args: ["-y", "x"] });
  assert.equal(resolveAddonCommand(e.command, { sha256: e.command_sha256, cwd: join(home, "bundles", "rk") }).missing, false);
});

test("repinAddon: pins an install-owned or absolute launcher; a bare name is reported, not guessed; the update path re-pins", () => {
  const home = bundleHome({ "bundles/rk/run.sh": "#!/bin/bash\nv1\n", "bin/uv": "#!/bin/sh\n" });
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify({
    rk: { command: "./run.sh", args: [] },
    kb: { command: join(home, "bin", "uv"), args: ["run", "kb"] },
    gw: { command: "uvx", args: ["--from", "git+https://github.com/x/y", "y"] },
  }));
  assert.equal(repinAddon({ crowHome: home, id: "rk" }).sha256, sha("#!/bin/bash\nv1\n"));
  writeFileSync(join(home, "bundles", "rk", "run.sh"), "#!/bin/bash\nv2\n");   // an update replaced it
  const st = addonLauncherStatus(JSON.parse(readFileSync(join(home, "mcp-addons.json"), "utf8")).rk, join(home, "bundles", "rk"));
  assert.equal(st.ok, false);
  assert.equal(st.needsRepin, true);
  assert.equal(repinAddon({ crowHome: home, id: "rk" }).sha256, sha("#!/bin/bash\nv2\n"));
  assert.equal(repinAddon({ crowHome: home, id: "kb" }).sha256, sha("#!/bin/sh\n"));
  assert.throws(() => repinAddon({ crowHome: home, id: "gw" }), /absolute/);
  const mode = statSync(join(home, "mcp-addons.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("pin-addon-command --check: read-only, one line per add-on, honours CROW_HOME", () => {
  const home = bundleHome({ "bundles/rk/run.sh": "#!/bin/bash\n", "bin/uv": "#!/bin/sh\n" });
  const addons = {
    rk: { command: "./run.sh", args: [] },
    nd: { command: "node", args: ["server/index.js"] },
    kb: { command: join(home, "bin", "uv"), args: ["run", "kb"] },
    gw: { command: "uvx", args: ["--from", "git+https://github.com/x/y", "y"] },
    web: { url: "http://127.0.0.1:9/mcp" },
  };
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify(addons));
  const before = readFileSync(join(home, "mcp-addons.json"), "utf8");
  let out = "", code = 0;
  try {
    out = execFileSync(process.execPath, [join(REPO, "scripts/ops/pin-addon-command.mjs"), "--check"], { env: { ...process.env, CROW_HOME: home }, encoding: "utf8" });
  } catch (e) { out = e.stdout; code = e.status; }
  assert.equal(readFileSync(join(home, "mcp-addons.json"), "utf8"), before, "nothing written");
  assert.match(out, /^nd: ok$/m);
  assert.match(out, /^web: ok \(url\)$/m);
  assert.match(out, /^rk: would refuse — .*re-pin: node scripts\/ops\/pin-addon-command\.mjs rk$/m);
  assert.match(out, /^kb: would refuse — .*re-pin: node scripts\/ops\/pin-addon-command\.mjs kb$/m);
  assert.match(out, /^gw: would refuse — .*--command \/abs\/path/m);
  assert.equal(code, 1, "non-zero when anything would be refused");
  assert.match(out, new RegExp(home.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
});

test("every bundle manifest in this repo resolves on a fresh-install layout", () => {
  const checked = [];
  for (const id of readdirSync(join(REPO, "bundles"))) {
    const mf = join(REPO, "bundles", id, "manifest.json");
    if (!existsSync(mf)) continue;
    let m; try { m = JSON.parse(readFileSync(mf, "utf8")); } catch { continue; }
    if (!m.server || m.server.url || typeof m.server.command !== "string") continue;
    const home = mkdtempSync(join(tmpdir(), "fresh-"));
    const bdir = join(home, "bundles", id);
    cpSync(join(REPO, "bundles", id), bdir, { recursive: true, filter: (src) => !src.includes("node_modules") });
    const entry = mcpAddonEntryFor(m, null, { bundleDir: bdir });
    const rc = resolveAddonCommand(entry.command, { sha256: entry.command_sha256, cwd: bdir });
    assert.equal(rc.missing, false, `${id}: ${rc.reason}`);
    assert.equal(checkLauncherArgs(rc.command, entry.args), null, id);
    checked.push(id);
  }
  assert.ok(checked.includes("rookery") && checked.includes("home-assistant") && checked.length > 40, checked.join(","));
});

test("one-click re-pin route handler: owner session only (a signed peer request is refused); pins and reports", async () => {
  const { handleRepinRequest } = await import("../servers/gateway/routes/bundles.js");
  const home = bundleHome({ "bundles/rk/run.sh": "#!/bin/bash\n" });
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify({ rk: { command: "./run.sh", args: [] } }));
  const res = () => { const r = { code: 200, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  const peer = res();
  await handleRepinRequest({ body: { bundle_id: "rk" }, crossHostAuth: { sourceInstanceId: "b".repeat(32) } }, peer, { crowHome: home });
  assert.equal(peer.code, 403);
  assert.equal(JSON.parse(readFileSync(join(home, "mcp-addons.json"), "utf8")).rk.command_sha256, undefined);
  const bad = res();
  await handleRepinRequest({ body: { bundle_id: "../x" } }, bad, { crowHome: home });
  assert.equal(bad.code, 400);
  const ok = res();
  await handleRepinRequest({ body: { bundle_id: "rk" } }, ok, { crowHome: home });
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.equal(JSON.parse(readFileSync(join(home, "mcp-addons.json"), "utf8")).rk.command_sha256, sha("#!/bin/bash\n"));
});

test("Extensions installed list shows 'Needs re-pin' with a one-click button for an add-on whose launcher needs it", async () => {
  const { buildExtensionsHTML } = await import("../servers/gateway/dashboard/panels/extensions/html.js");
  const { viewsHtml } = buildExtensionsHTML({ installed: { rk: { version: "1.0.0" } }, available: [], registrySource: "test",
    communityStores: [], bundleStatus: {}, needsRepin: { rk: "./run.sh: SHA-256 does not match" }, lang: "en" });
  assert.match(viewsHtml, /data-testid="needs-repin"/);
  assert.match(viewsHtml, /class="btn btn-sm btn-primary bundle-action" data-action="repin" data-id="rk"/);
  const es = buildExtensionsHTML({ installed: { rk: { version: "1.0.0" } }, available: [], registrySource: "test",
    communityStores: [], bundleStatus: {}, needsRepin: { rk: "x" }, lang: "es" }).viewsHtml;
  assert.match(es, /Volver a fijar/);
});
