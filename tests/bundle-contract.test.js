import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest, detectSurfaces } from "../scripts/lib/bundle-contract.mjs";
import { buildRegistry, formatRegistry } from "../scripts/build-registry.mjs";

/** Make a throwaway bundle dir <root>/<id> with optional files {relpath: content}. */
function tmpBundle(id, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "crowbundle-"));
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return { root, dir };
}

// Minimal valid manifest: only the 5 universal-required fields (no version/author).
const VALID = { id: "demo", name: "Demo", description: "d", type: "bundle", category: "misc" };

test("minimal manifest (no version/author) passes", () => {
  const { dir } = tmpBundle("demo");
  const r = validateManifest(VALID, dir);
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("missing each universal field fails", () => {
  const { dir } = tmpBundle("demo");
  for (const f of ["id", "name", "description", "type", "category"]) {
    const m = { ...VALID }; delete m[f];
    assert.equal(validateManifest(m, dir).ok, false, `expected fail without ${f}`);
  }
});

test("version/author are optional but shape-checked when present", () => {
  const { dir } = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, version: "1.2.3", author: "Crow" }, dir).ok, true);
  assert.equal(validateManifest({ ...VALID, version: "v1" }, dir).ok, false, "bad semver must fail");
  assert.equal(validateManifest({ ...VALID, author: "" }, dir).ok, false, "empty author must fail");
});

test("bad type enum fails", () => {
  const { dir } = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, type: "weird" }, dir).ok, false);
});

test("unknown top-level field is allowed (lenient)", () => {
  const { dir } = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, sttProfileSeed: { x: 1 } }, dir).ok, true);
});

test("id must equal dirname", () => {
  const { dir } = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, id: "other" }, dir).ok, false);
});

test("declared skill file must exist", () => {
  const withFile = tmpBundle("demo", { "skills/x.md": "# x" });
  assert.equal(validateManifest({ ...VALID, skills: ["skills/x.md"] }, withFile.dir).ok, true);
  const without = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, skills: ["skills/missing.md"] }, without.dir).ok, false);
});

test("docker composefile must exist", () => {
  const b = tmpBundle("demo", { "docker-compose.yml": "x" });
  assert.equal(validateManifest({ ...VALID, docker: { composefile: "docker-compose.yml" } }, b.dir).ok, true);
  const b2 = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, docker: { composefile: "docker-compose.yml" } }, b2.dir).ok, false);
});

test("node server entry-file must exist", () => {
  const b = tmpBundle("demo", { "server/index.js": "//" });
  assert.equal(validateManifest({ ...VALID, server: { command: "node", args: ["server/index.js"] } }, b.dir).ok, true);
  const b2 = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, server: { command: "node", args: ["server/index.js"] } }, b2.dir).ok, false);
});

test("external-command server is NOT file-checked (npx -y pkg)", () => {
  const { dir } = tmpBundle("demo"); // no local entry file on purpose
  const m = { ...VALID, type: "mcp-server", server: { command: "npx", args: ["-y", "hass-mcp"] } };
  assert.equal(validateManifest(m, dir).ok, true, "external command must not require a local file");
});

test("launcher: only the values that make the spawn run code are contract paths; data arguments are left alone", () => {
  const b = tmpBundle("demo", { "server/index.js": "//" });
  const server = (args, command = "node") => ({ ...VALID, server: { command, args } });
  // The script (the first non-flag argument) must stay inside the bundle — relative or absolute.
  const climb = validateManifest(server(["../x.js"]), b.dir);
  assert.equal(climb.ok, false);
  assert.match(climb.errors.join("\n"), /server\.args "\.\.\/x\.js" must be a relative path inside the bundle/);
  assert.equal(validateManifest(server(["/etc/x.js"]), b.dir).ok, false, "an absolute script is refused");
  // A code-loading flag's value is code either way it is written.
  assert.equal(validateManifest(server(["--import", "../h.mjs", "server/index.js"]), b.dir).ok, false);
  assert.equal(validateManifest(server(["--import=../h.mjs", "server/index.js"]), b.dir).ok, false);
  // A local runner spec is code; a registry name is fetched, never read from the bundle.
  assert.equal(validateManifest(server(["-y", "../data"], "npx"), b.dir).ok, false);
  assert.equal(validateManifest(server(["-y", "@scope/name"], "npx"), b.dir).ok, true);
  // Data arguments are not the contract's business, absolute or climbing.
  for (const args of [["server/index.js", "--config=/etc/x"], ["server/index.js", "--db", "../data/x.db"],
    ["server/index.js", "--data-dir=data"]]) {
    assert.equal(validateManifest(server(args), b.dir).ok, true, args.join(" "));
  }
  assert.equal(validateManifest(server(["-m", "mypkg"], "python"), b.dir).ok, true);
});

test("server: null is tolerated", () => {
  const { dir } = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, server: null }, dir).ok, true);
});

test("webUI may be null (no web UI) or an object; a non-object fails", () => {
  const { dir } = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, webUI: null }, dir).ok, true);
  // A web UI now also has to say how its first admin is created (N3-4), so the
  // object form carries a firstAdmin declaration; a missing one is its own test
  // (tests/bundle-first-admin-contract.test.js).
  assert.equal(validateManifest({ ...VALID, webUI: { port: 8096 }, firstAdmin: { mode: "none" } }, dir).ok, true);
  assert.equal(validateManifest({ ...VALID, webUI: "nope" }, dir).ok, false);
});

test("panel string is file-checked; panel object is shape-only", () => {
  const withFile = tmpBundle("demo", { "panel/demo.js": "//" });
  assert.equal(validateManifest({ ...VALID, panel: "panel/demo.js" }, withFile.dir).ok, true);
  const missing = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, panel: "panel/demo.js" }, missing.dir).ok, false);
  // object form: no file check (resolved at runtime by resolvePanelPath)
  assert.equal(validateManifest({ ...VALID, panel: { id: "demo", extends: "homepage" } }, missing.dir).ok, true);
});

// Every path a manifest names is read by the gateway relative to the bundle dir, so an
// absolute one, one carrying a `\` (an ordinary filename character on Linux) or one that
// walks out with `..` is refused here — even when the file it points at exists.
test("declared paths must be plain relative paths inside the bundle", () => {
  const b = tmpBundle("demo", {
    "docker-compose.yml": "x",
    "panel/demo.js": "//",
    "panel/routes.js": "//",
    "skills/x.md": "# x",
    "scripts/hook.sh": "#!/bin/sh",
  });
  // The ordinary shape still passes.
  assert.equal(validateManifest({
    ...VALID,
    docker: { composefile: "docker-compose.yml" },
    panel: "panel/demo.js",
    panelRoutes: "panel/routes.js",
    skills: ["skills/x.md"],
    postInstall: { script: "scripts/hook.sh" },
  }, b.dir).ok, true);
  // An object panel's id is a file name (panel/<id>.js): a plain name only. The gateway stringifies
  // whatever the id is into that path, so a non-string id (an array climbing with `..`) is refused too.
  assert.equal(validateManifest({ ...VALID, panel: { id: "gis", extends: "data-dashboard" } }, b.dir).ok, true);
  for (const id of ["../data/evil", "a/b", "Data", "demo.js", ["../data/evil"]]) {
    const r = validateManifest({ ...VALID, panel: { id } }, b.dir);
    assert.equal(r.ok, false, `panel.id ${JSON.stringify(id)}`);
    assert.ok(r.errors.some((e) => e.startsWith("panel.id ")), r.errors.join("; "));
  }
  // Absolute (`/etc/...` really exists on the host), `..`, and `\`.
  for (const v of ["/etc/docker-compose.yml", "../outside.yml", "deploy/../../x.yml", "deploy\\compose.yml"]) {
    const r = validateManifest({ ...VALID, docker: { composefile: v } }, b.dir);
    assert.equal(r.ok, false, `docker.composefile ${v}`);
    assert.ok(r.errors.some((e) => e.startsWith(`docker.composefile "`) && e.includes("relative path")), r.errors.join("; "));
  }
  for (const v of ["/etc/hostname", "../outside.js", "panel/../panel/demo.js", "panel\\demo.js"]) {
    const r = validateManifest({ ...VALID, panel: v }, b.dir);
    assert.equal(r.ok, false, `panel ${v}`);
    assert.ok(r.errors.some((e) => e.startsWith(`panel "`) && e.includes("relative path")), r.errors.join("; "));
  }
  for (const v of ["/etc/hostname", "panel/../../x.js", "panel\\routes.js"]) {
    const r = validateManifest({ ...VALID, panelRoutes: v }, b.dir);
    assert.equal(r.ok, false, `panelRoutes ${v}`);
    assert.ok(r.errors.some((e) => e.startsWith(`panelRoutes "`) && e.includes("relative path")), r.errors.join("; "));
  }
  for (const v of ["/etc/hostname", "../outside.md", "skills\\x.md"]) {
    const r = validateManifest({ ...VALID, skills: [v] }, b.dir);
    assert.equal(r.ok, false, `skill ${v}`);
    assert.ok(r.errors.some((e) => e.startsWith(`skill "`) && e.includes("relative path")), r.errors.join("; "));
  }
  for (const v of ["/etc/hook.sh", "../outside.sh", "scripts\\hook.sh"]) {
    const r = validateManifest({ ...VALID, postInstall: { script: v } }, b.dir);
    assert.equal(r.ok, false, `postInstall ${v}`);
    assert.ok(r.errors.some((e) => e.startsWith(`postInstall.script "`) && e.includes("relative path")), r.errors.join("; "));
  }
});

// The MCP spawn runs with the bundle folder as its cwd, so the launcher values that make it
// LOAD OR RUN CODE are read there: an interpreter's script (with or without a `/`), the value of
// a code-loading flag and a LOCAL package spec are bundle paths — and an absolute one or one
// that climbs out is refused. A relative `command` with a `/` is code too; an absolute command
// is a host program and a data argument is the program's own input, so neither is checked.
test("launcher paths that load or run code must be plain relative paths inside the bundle", () => {
  const b = tmpBundle("demo", { "server/index.js": "//", "main.js": "//", "data/h.mjs": "//" });
  const run = (server) => validateManifest({ ...VALID, server }, b.dir);
  // The ordinary shapes still pass — including a script with no separator, and `.` (node runs
  // index.js or package.json main: both are files the bundle ships).
  assert.equal(run({ command: "node", args: ["main.js"] }).ok, true);
  assert.equal(run({ command: "node", args: ["."] }).ok, true);
  assert.equal(run({ command: "node", args: ["server/index.js"] }).ok, true);
  assert.equal(run({ command: "node", args: ["--import=./data/h.mjs", "main.js"] }).ok, true);
  // npx/uvx/bunx fetch their FIRST non-flag argument from a registry: it is a package, not a path.
  assert.equal(run({ command: "npx", args: ["-y", "@scope/pkg"] }).ok, true);
  assert.equal(run({ command: "uvx", args: ["arxiv-mcp-server"] }).ok, true);
  // Absolute, climbing and `\`-carrying code values are refused, wherever they sit.
  for (const args of [
    ["../other-bundle/server/index.js"],
    ["/etc/evil.js"],
    ["data/../../x.js"],
    ["server\\index.js"],
    ["--import=../outside/h.mjs", "main.js"],
  ]) {
    const r = run({ command: "node", args });
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.ok(r.errors.some((e) => e.startsWith("server.args \"") && e.includes("relative path")), r.errors.join("; "));
  }
  // A relative command with a separator is code (resolve-command.js runs it inside the folder).
  const climbCommand = run({ command: "../other-bundle/run.sh", args: [] });
  assert.equal(climbCommand.ok, false);
  assert.ok(climbCommand.errors.some((e) => e.startsWith("server.command \"") && e.includes("relative path")), climbCommand.errors.join("; "));
  // An absolute command is a host program, not a bundle file.
  assert.equal(run({ command: "/usr/local/bin/node", args: [] }).ok, true);
  // A LOCAL runner spec is code, so it is refused when it climbs; a registry name is fetched.
  const localSpec = run({ command: "npx", args: ["-y", "../evil"] });
  assert.equal(localSpec.ok, false, "a local package spec is a bundle path");
  assert.ok(localSpec.errors.some((e) => e.startsWith("server.args \"") && e.includes("relative path")), localSpec.errors.join("; "));
  // A data argument is never the contract's business.
  assert.equal(run({ command: "node", args: ["main.js", "--config=/etc/x"] }).ok, true);
});

test("requires.bundles existence checked via resolver", () => {
  const { dir } = tmpBundle("demo");
  const m = { ...VALID, requires: { bundles: ["companion"] } };
  assert.equal(validateManifest(m, dir, { bundleExists: (id) => id === "companion" }).ok, true);
  assert.equal(validateManifest(m, dir, { bundleExists: () => false }).ok, false);
});

test("env_vars items must have a name", () => {
  const { dir } = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, env_vars: [{ name: "X" }] }, dir).ok, true);
  assert.equal(validateManifest({ ...VALID, env_vars: [{ description: "no name" }] }, dir).ok, false);
});

test("detectSurfaces reports declared surfaces", () => {
  const s = detectSurfaces({ ...VALID, server: { command: "node", args: ["x"] }, skills: ["a.md"] });
  assert.deepEqual(s.sort(), ["server", "skills"]);
});

test("malformed manifest (null) returns ok:false, does not throw", () => {
  const { dir } = tmpBundle("demo");
  const r = validateManifest(null, dir);
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
});

test("surface field of wrong type (docker as string) fails on shape, not a confusing integrity error", () => {
  const { dir } = tmpBundle("demo");
  const r = validateManifest({ ...VALID, docker: "x" }, dir);
  assert.equal(r.ok, false);
  // after the shape short-circuit, the error is a shape error, not 'docker.composefile "undefined" not found'
  assert.ok(r.errors.some((e) => e.startsWith("shape")), "expected a shape error, got: " + r.errors.join("; "));
  assert.ok(!r.errors.some((e) => e.includes("undefined")), "should not emit a spurious integrity error: " + r.errors.join("; "));
});

/** Build a fake bundles root from {id: manifestObject}; creates referenced skill files so they validate. */
function fakeBundlesRoot(manifests) {
  const root = mkdtempSync(join(tmpdir(), "crowreg-"));
  for (const [id, manifest] of Object.entries(manifests)) {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    if (Array.isArray(manifest.skills)) {
      for (const s of manifest.skills) {
        mkdirSync(join(dir, s, ".."), { recursive: true });
        writeFileSync(join(dir, s), "x");
      }
    }
  }
  return root;
}

const mk = (id, extra = {}) => ({
  id, name: id.toUpperCase(), description: "d", type: "bundle", category: "misc", ...extra,
});

test("buildRegistry: valid non-draft tracked entries, official injected, sorted by id", () => {
  const root = fakeBundlesRoot({ zebra: mk("zebra"), alpha: mk("alpha"), draftone: mk("draftone", { draft: true }) });
  const { registry } = buildRegistry({ bundlesRoot: root, tracked: null });
  assert.deepEqual(registry["add-ons"].map((e) => e.id), ["alpha", "zebra"]);
  assert.equal(registry["add-ons"][0].official, true);
  assert.equal(registry.version, 2);
});

test("buildRegistry: untracked dir excluded", () => {
  const root = fakeBundlesRoot({ keep: mk("keep"), wip: mk("wip") });
  const { registry } = buildRegistry({ bundlesRoot: root, tracked: new Set(["keep"]) });
  assert.deepEqual(registry["add-ons"].map((e) => e.id), ["keep"]);
});

test("buildRegistry: invalid manifest excluded and flagged", () => {
  const root = fakeBundlesRoot({ bad: mk("bad", { type: "weird" }) });
  const { registry, audit } = buildRegistry({ bundlesRoot: root, tracked: null });
  assert.equal(registry["add-ons"].length, 0);
  assert.equal(audit.find((a) => a.id === "bad").status, "invalid");
});

test("buildRegistry: manifest origin community → official:false, origin passed through (third-party provenance)", () => {
  const root = fakeBundlesRoot({
    thirdparty: mk("thirdparty", { origin: "community", author: "Some Vendor" }),
    firstparty: mk("firstparty"),
  });
  const { registry } = buildRegistry({ bundlesRoot: root, tracked: null });
  const third = registry["add-ons"].find((e) => e.id === "thirdparty");
  const first = registry["add-ons"].find((e) => e.id === "firstparty");
  assert.equal(third.official, false, "community-origin entry must not be stamped official");
  assert.equal(third.origin, "community", "origin must pass through to the registry entry");
  assert.equal(first.official, true, "origin-less entry keeps official:true (back-compat)");
  assert.equal("origin" in first, false, "origin-less entry gains no origin key (registry byte-compat)");
});

test("buildRegistry: origin official is accepted and equals the default; bogus origin → invalid", () => {
  const root = fakeBundlesRoot({ explicit: mk("explicit", { origin: "official" }) });
  const { registry } = buildRegistry({ bundlesRoot: root, tracked: null });
  assert.equal(registry["add-ons"][0].official, true);

  const root2 = fakeBundlesRoot({ sneaky: mk("sneaky", { origin: "totally-legit" }) });
  const { registry: r2, audit } = buildRegistry({ bundlesRoot: root2, tracked: null });
  assert.equal(r2["add-ons"].length, 0, "an unknown origin value must not publish");
  assert.equal(audit.find((a) => a.id === "sneaky").status, "invalid");
});

test("buildRegistry: a community manifest cannot smuggle official:true (field is derived, never trusted)", () => {
  const root = fakeBundlesRoot({ liar: mk("liar", { origin: "community", official: true }) });
  const { registry } = buildRegistry({ bundlesRoot: root, tracked: null });
  assert.equal(registry["add-ons"][0].official, false, "manifest official must be ignored; origin decides");
});

test("formatRegistry: 2-space indent + trailing newline", () => {
  const out = formatRegistry({ version: 2, "add-ons": [] });
  assert.ok(out.endsWith("}\n"));
  assert.ok(out.includes('  "version": 2'));
});

test("buildRegistry: requires.bundles satisfied by a manifest-backed sibling; missing dep → invalid", () => {
  const root = fakeBundlesRoot({
    needsdep: mk("needsdep", { requires: { bundles: ["sibling"] } }),
    sibling: mk("sibling"),
  });
  const { registry } = buildRegistry({ bundlesRoot: root, tracked: null });
  assert.ok(registry["add-ons"].map((e) => e.id).includes("needsdep"), "dep satisfied by manifest-backed sibling");

  const root2 = fakeBundlesRoot({ orphandep: mk("orphandep", { requires: { bundles: ["ghost"] } }) });
  const { audit } = buildRegistry({ bundlesRoot: root2, tracked: null });
  assert.equal(audit.find((a) => a.id === "orphandep").status, "invalid");
});

// --- Integration: the real bundles + committed registry (no fixtures) ---

test("all tracked real bundle manifests are valid", () => {
  const { audit } = buildRegistry(); // real BUNDLES_ROOT + git tracked-set
  const invalid = audit.filter((a) => a.status === "invalid");
  assert.equal(invalid.length, 0, "invalid manifests: " + invalid.map((a) => `${a.id} [${a.errors.join(", ")}]`).join(" | "));
});

test("committed registry/add-ons.json matches generated (no drift)", () => {
  const { registry } = buildRegistry();
  const generated = formatRegistry(registry);
  const current = readFileSync(new URL("../registry/add-ons.json", import.meta.url), "utf8");
  assert.equal(current, generated, "registry drift — run `npm run build-registry`");
});
