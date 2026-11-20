// The "nothing sends without a person's tap" invariant (plan 3, Task 7, GATE G4): a static reading of
// the code, so a later task cannot quietly wire a bot door, a tool or an MCP server to the send and
// schedule services.
//
//   (a) Every MCP door this Crow mounts — the servers `scripts/server-registry.js` declares, the
//       gateway's router, the board server and the mail draft server — is walked through its own
//       relative imports, and neither a reachable module's imports nor a tool name it registers may
//       name a mail send or schedule path.
//   (b) The only importers of `requestSend` and `scheduleDraft` are `routes/mail-drafts-api.js` and
//       the tests: the owner taps are the only way into a tap state. The per-turn draft MCP server
//       (`servers/gateway/mail-draft-mcp.js`, its own task) imports no send service, no schedule
//       service and no seal, and nothing reachable from it by import is the bot runtime
//       (`scripts/pi-bots/bridge.mjs`) — a door that could reach a spawn could reach a tool surface
//       wider than its three names.
//   (c) No bot definition, preset or `toolAllowlist` output can carry a name matching
//       /mail.*(send|schedule)/i: a drafting bot's three tools are read-only or propose-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  COMBINED_SERVER,
  CONDITIONAL_SERVERS,
  CORE_SERVERS,
} from "../scripts/server-registry.js";
import { toolAllowlist } from "../scripts/pi-bots/bridge.mjs";

const REPO = resolve(new URL("..", import.meta.url).pathname);
const SEND_SERVICE = resolve(REPO, "servers/gateway/mail/send/send-service.js");
const SCHEDULE_SERVICE = resolve(REPO, "servers/gateway/mail/send/schedule-service.js");
const SEAL = resolve(REPO, "servers/gateway/mail/drafts/seal.js");
const DRAFT_ROUTES = resolve(REPO, "servers/gateway/routes/mail-drafts-api.js");
const DRAFT_MCP = resolve(REPO, "servers/gateway/mail-draft-mcp.js");
const DRAFT_STORE = resolve(REPO, "servers/gateway/mail/drafts/store.js");
const BRIDGE = resolve(REPO, "scripts/pi-bots/bridge.mjs");
// The reports-only send path (case d): the door that takes a `report_sends` row id, and the delivery
// seam that will be its only caller (PR 5). Neither may be reachable from a bot door.
const REPORTS_DOOR = resolve(REPO, "servers/gateway/mail/reports-door.js");
const REPORTS_DELIVERY = resolve(REPO, "servers/gateway/reports/delivery.js");
const REPORTS_RUN = resolve(REPO, "servers/gateway/reports/run.js");
const REPORTS_DIR = resolve(REPO, "servers/gateway/reports");
const REPORTS_MCP_DOORS = ["servers/gateway/reports/mcp.js", "servers/gateway/reports/pickup-mcp.js"];

/** A tool name that could send or schedule mail, in any spelling a def might use. */
const TAP_TOOL_NAME = /mail.*(send|schedule)/i;

/** Every specifier a module names: static imports, dynamic imports and requires. */
const SPECIFIER_RE = /(?:\bfrom\s*|import\s*\(\s*|\brequire\(\s*)["']([^"']+)["']/g;

/** The local files a source names, resolved; a bare package specifier resolves to null. */
function localImports(file) {
  const source = readFileSync(file, "utf8");
  const out = [];
  for (const match of source.matchAll(SPECIFIER_RE)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    const base = resolve(dirname(file), specifier);
    for (const candidate of [base, `${base}.js`, `${base}.mjs`, join(base, "index.js"), join(base, "index.mjs")]) {
      try {
        if (statSync(candidate).isFile()) {
          out.push({ specifier, file: candidate });
          break;
        }
      } catch {
        // the next candidate
      }
    }
  }
  return out;
}

/** Every module reachable from `roots` through relative imports, with the edges that reached them. */
function importClosure(roots) {
  const files = new Set();
  const edges = [];
  const queue = roots.map((root) => resolve(root));
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    for (const edge of localImports(file)) {
      edges.push({ from: file, ...edge });
      if (!files.has(edge.file)) queue.push(edge.file);
    }
  }
  return { files, edges };
}

/** Every `.js`/`.mjs` file under a directory, without node_modules and dot directories. */
function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(?:js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The names a source registers as MCP tools: `.tool("name"` and `registerTool("name"`. */
function toolNamesOf(file) {
  const source = readFileSync(file, "utf8");
  const names = [];
  for (const match of source.matchAll(/\.(?:tool|registerTool)\(\s*["'`]([^"'`]+)["'`]/g)) {
    names.push(match[1]);
  }
  return names;
}

/** The identifiers a source imports by name from any module. */
function importedNames(file) {
  const source = readFileSync(file, "utf8");
  const names = [];
  for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s*["'][^"']+["']/g)) {
    const braces = /\{([\s\S]*?)\}/.exec(match[1]);
    if (!braces) continue;
    for (const part of braces[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** Does this path name a real file? A door that a later PR has not created yet is not walked. */
function existsFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

const rel = (file) => relative(REPO, file).split("\\").join("/");

/* ------------------------------------------------------------------------ (a) */

test("(a) no MCP door the gateway mounts can reach a mail send or schedule path", () => {
  const registry = [CORE_SERVERS, COMBINED_SERVER, CONDITIONAL_SERVERS].flat();
  const entryFiles = [];
  for (const server of registry) {
    const entry = Array.isArray(server.args) ? server.args[0] : null;
    if (typeof entry !== "string") continue;
    entryFiles.push(resolve(REPO, entry));
  }
  const doors = [
    ...entryFiles,
    resolve(REPO, "servers/gateway/router.js"),
    resolve(REPO, "servers/gateway/board-mcp.js"),
    // The drafting turn's door (plan 3, Task 8a): three read/propose tools, and no way to a tap.
    DRAFT_MCP,
    // The reports MCP doors, the moment PR 7 and PR 9a create them: a door that does not exist yet is
    // simply not in the walk, and no other line of (a) changes.
    ...[resolve(REPO, "servers/gateway/reports/mcp.js"), resolve(REPO, "servers/gateway/reports/pickup-mcp.js")]
      .filter(existsFile),
  ];
  for (const door of doors) {
    assert.ok(statSync(door).isFile(), `${rel(door)} is a real module`);
  }

  const { files, edges } = importClosure(doors);
  assert.ok(files.size > 5, `the doors were really walked (${files.size} modules)`);

  for (const edge of edges) {
    assert.notEqual(edge.file, SEND_SERVICE, `${rel(edge.from)} imports the send service`);
    assert.notEqual(edge.file, SCHEDULE_SERVICE, `${rel(edge.from)} imports the schedule service`);
    assert.notEqual(edge.file, DRAFT_ROUTES, `${rel(edge.from)} imports the owner draft routes`);
  }
  for (const file of files) {
    for (const name of toolNamesOf(file)) {
      assert.ok(!TAP_TOOL_NAME.test(name), `${rel(file)} is reachable from a bot door and registers ${name}`);
    }
  }
  for (const server of registry) {
    assert.ok(!TAP_TOOL_NAME.test(String(server.name)), `the registry names ${server.name}`);
  }
});

/* ------------------------------------------------------------------------ (b) */

test("(b) only the owner draft routes import requestSend and scheduleDraft", () => {
  const files = [...walk(resolve(REPO, "servers")), ...walk(resolve(REPO, "scripts"))];
  assert.ok(files.length > 100, `the server and script trees were really walked (${files.length} files)`);

  const sendImporters = new Set();
  const scheduleImporters = new Set();
  const tapImporters = [];
  for (const file of files) {
    for (const edge of localImports(file)) {
      if (edge.file === SEND_SERVICE) sendImporters.add(rel(file));
      if (edge.file === SCHEDULE_SERVICE) scheduleImporters.add(rel(file));
    }
    const names = importedNames(file);
    if (names.includes("requestSend") || names.includes("scheduleDraft")) tapImporters.push(rel(file));
  }

  // The engine's own modules are the only other code that may hold either service: the sweep, the
  // boot that hands the send service its supervisor, and the two services themselves.
  assert.deepEqual([...sendImporters].sort(), [
    "servers/gateway/boot/mail-boot.js",
    "servers/gateway/mail/send/schedule-service.js",
    "servers/gateway/routes/mail-drafts-api.js",
  ].sort(), "the send service's importers");
  assert.deepEqual([...scheduleImporters].sort(), [
    "servers/gateway/mail/send/hook.js",
    "servers/gateway/routes/mail-drafts-api.js",
  ].sort(), "the schedule service's importers");

  // The two taps by name: the owner route file, and nowhere else outside the services themselves.
  assert.deepEqual(tapImporters.sort(), ["servers/gateway/routes/mail-drafts-api.js"]);

  // The per-turn draft MCP server is a read/propose door: no send, no schedule, no seal writer, and
  // no path through its imports to the bot runtime behind a drafting turn.
  let draftMcp = null;
  try {
    draftMcp = DRAFT_MCP;
    if (!statSync(draftMcp).isFile()) draftMcp = null;
  } catch {
    draftMcp = null;
  }
  if (draftMcp != null) {
    const targets = localImports(draftMcp).map((edge) => edge.file);
    assert.ok(!targets.includes(SEND_SERVICE), "the draft MCP server imports no send service");
    assert.ok(!targets.includes(SCHEDULE_SERVICE), "the draft MCP server imports no schedule service");
    assert.ok(!targets.includes(SEAL), "the draft MCP server imports no seal");
    const names = importedNames(draftMcp);
    assert.ok(!names.includes("requestSend"), "the draft MCP server names no send tap");
    assert.ok(!names.includes("scheduleDraft"), "the draft MCP server names no schedule tap");
    // The bot runtime is behind a drafting turn, never behind the door that turn calls: a door that
    // could reach it could reach a spawn, and with it a tool surface wider than the three names.
    const closure = importClosure([draftMcp]);
    assert.ok(closure.files.size > 3, `the draft MCP server's imports were really walked (${closure.files.size} modules)`);
    assert.equal(closure.files.has(BRIDGE), false,
      "the draft MCP server's import closure does not reach scripts/pi-bots/bridge.mjs");
  }
});

/* ------------------------------------------------------------------------ (c) */

test("(c) no bot def, preset or tool allowlist can grant a mail send or schedule tool", async () => {
  const registry = [CORE_SERVERS, COMBINED_SERVER, CONDITIONAL_SERVERS].flat();
  const declaredTools = [...new Set(walk(resolve(REPO, "servers")).flatMap(toolNamesOf))];
  assert.ok(declaredTools.length > 20, `the tool names were really collected (${declaredTools.length})`);

  // A def carrying everything this Crow could grant a bot today: every builtin a Bot Builder def can
  // hold, every registered server, and every `server/tool` spelling of a declared tool.
  const everything = {
    tools: {
      pi_builtin: [
        "read", "edit", "write", "bash", "subagent", "ask_user", "send_user_file",
        "web", "web_search", "web_fetch", "crow_request_secret", "image",
      ],
      crow_mcp: [
        ...registry.map((server) => server.name),
        ...declaredTools,
        ...declaredTools.map((name) => `crow-tasks/${name}`),
      ],
    },
  };
  const grantable = toolAllowlist(everything);
  for (const name of grantable.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    assert.ok(!TAP_TOOL_NAME.test(name), `toolAllowlist grants ${name}`);
  }

  for (const server of registry) {
    const csv = toolAllowlist({ tools: { pi_builtin: [], crow_mcp: [server.name] } });
    for (const name of csv.split(",").map((entry) => entry.trim()).filter(Boolean)) {
      assert.ok(!TAP_TOOL_NAME.test(name), `a def granting ${server.name} is offered ${name}`);
    }
    assert.ok(!TAP_TOOL_NAME.test(server.name), `the registry names ${server.name}`);
  }

  // The Bot Builder's own template def, the one every new bot starts from.
  const { defaultDefinition } = await import("../servers/gateway/dashboard/panels/bot-builder/data-queries.js");
  const template = defaultDefinition("bot-1", null, "test/model");
  const templateCsv = toolAllowlist(template);
  for (const name of templateCsv.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    assert.ok(!TAP_TOOL_NAME.test(name), `the template def grants ${name}`);
  }
});

/* ------------------------------------------------------------------------ (d) */

// The reports-only send path has one door and one caller. The door takes a `report_sends` row id and
// never an address, so the only thing an invariant can watch is who may import it: the delivery seam
// (PR 5), and nothing else in the tree — the installed bundles under `bundles/` included, because a
// bundle's server code runs on the same box. `delivery.js` lands in PR 5, so each allowed set below may
// be empty today; what may never happen is a name outside it. The door's module name is watched as a
// literal string too, not only as an import: a dynamic import or a copied path is still a string.
const DOOR_IMPORTERS = Object.freeze(["servers/gateway/reports/delivery.js"]);
const DELIVERY_IMPORTERS = Object.freeze([
  "servers/gateway/reports/schedule-hook.js",
  "servers/gateway/routes/reports-api.js",
  "servers/gateway/boot/post-listen.js",
]);

/** Every file in the tree that names `target` as a relative import, by its repo-relative path. */
function importersOf(target, files) {
  const out = new Set();
  for (const file of files) {
    if (file === target) continue;
    for (const edge of localImports(file)) {
      if (edge.file === target) {
        out.add(rel(file));
        break;
      }
    }
  }
  return out;
}

test("(d) reports-door is imported only by servers/gateway/reports/delivery.js", () => {
  const files = [...walk(resolve(REPO, "servers")), ...walk(resolve(REPO, "scripts")), ...walk(resolve(REPO, "bundles"))];
  assert.ok(files.length > 100, `the server, script and bundle trees were really walked (${files.length} files)`);
  assert.ok(walk(resolve(REPO, "bundles")).length > 0, "the bundles tree was really walked");
  assert.ok(statSync(REPORTS_DOOR).isFile(), "the reports send door is a real module");

  const importers = importersOf(REPORTS_DOOR, files);
  for (const file of importers) {
    assert.ok(DOOR_IMPORTERS.includes(file), `${file} imports the reports-only send door`);
  }
  // And the door is nobody else's to reach: a bot door, a route, a script or an installed bundle naming
  // it fails above.
  assert.ok(!importers.has("servers/gateway/routes/reports-api.js"),
    "no route imports the send door");
  assert.ok(!importers.has("servers/gateway/reports/run.js"), "the run engine imports no send door");
  assert.equal([...importers].some((file) => file.startsWith("bundles/")), false,
    "no bundle imports the reports-only send door");
});

test("(d) no file outside the door, delivery.js and the tests names reports-door at all", () => {
  // An import is not the only way to reach a module: a dynamic import, a re-export or a copied path is
  // a string in a file. The walk therefore covers the installed bundles too, and the literal name may
  // appear only in the door itself, in the delivery seam that calls it, and in the tests that drive it.
  const files = [
    ...walk(resolve(REPO, "servers")),
    ...walk(resolve(REPO, "scripts")),
    ...walk(resolve(REPO, "bundles")),
  ];
  const bundleFiles = walk(resolve(REPO, "bundles"));
  assert.ok(files.length > 100, `the server, script and bundle trees were really walked (${files.length} files)`);
  assert.ok(bundleFiles.length > 0, `the bundles tree was really walked (${bundleFiles.length} files)`);

  const allowed = new Set([rel(REPORTS_DOOR), rel(REPORTS_DELIVERY)]);
  const naming = files.filter((file) => readFileSync(file, "utf8").includes("reports-door")).map(rel);
  for (const file of naming) {
    assert.ok(allowed.has(file), `${file} names the reports-only send door`);
  }
  assert.equal(naming.some((file) => file.startsWith("bundles/")), false,
    "no bundle names the reports-only send door");
});

test("(d) delivery.js is imported only by schedule-hook.js, reports-api.js and post-listen.js", () => {
  const files = [...walk(resolve(REPO, "servers")), ...walk(resolve(REPO, "scripts"))];
  assert.ok(files.length > 100, `the server and script trees were really walked (${files.length} files)`);

  const importers = importersOf(REPORTS_DELIVERY, files);
  for (const file of importers) {
    assert.ok(DELIVERY_IMPORTERS.includes(file), `${file} imports reports/delivery.js`);
  }
});

test("(d) run.js imports neither delivery.js nor reports-door.js", () => {
  assert.ok(statSync(REPORTS_RUN).isFile(), "the run engine is a real module");
  const targets = localImports(REPORTS_RUN).map((edge) => edge.file);
  assert.ok(targets.length > 0, "the run engine's imports were really read");
  assert.equal(targets.includes(REPORTS_DELIVERY), false, "run.js imports no delivery seam");
  assert.equal(targets.includes(REPORTS_DOOR), false, "run.js imports no send door");
});

test("(d) the door imports no send service, no schedule service, no draft seal, no draft store", () => {
  assert.ok(statSync(REPORTS_DOOR).isFile(), "the reports send door is a real module");
  const targets = localImports(REPORTS_DOOR).map((edge) => edge.file);
  for (const forbidden of [SEND_SERVICE, SCHEDULE_SERVICE, SEAL, DRAFT_STORE]) {
    assert.equal(targets.includes(forbidden), false,
      `the reports send door imports ${rel(forbidden)}`);
  }
  const names = importedNames(REPORTS_DOOR);
  assert.ok(!names.includes("requestSend"), "the reports send door names no send tap");
  assert.ok(!names.includes("scheduleDraft"), "the reports send door names no schedule tap");

  // The bot runtime is behind a bot's turn, never behind the door a report send goes through.
  const closure = importClosure([REPORTS_DOOR]);
  assert.ok(closure.files.size > 3,
    `the reports send door's imports were really walked (${closure.files.size} modules)`);
  assert.equal(closure.files.has(BRIDGE), false,
    "the reports send door's import closure does not reach scripts/pi-bots/bridge.mjs");
  assert.equal(closure.files.has(SEND_SERVICE), false, "and not the mail send service");
});

test("(d) nothing under servers/gateway/reports registers a tool whose name matches mail send or schedule", () => {
  const files = walk(REPORTS_DIR);
  assert.ok(files.length > 5, `the reports tree was really walked (${files.length} files)`);
  for (const file of files) {
    for (const name of toolNamesOf(file)) {
      assert.ok(!TAP_TOOL_NAME.test(name), `${rel(file)} registers ${name}`);
    }
  }
});

test("(d) only reports/mcp.js and reports/pickup-mcp.js may register MCP tools under servers/gateway/reports", () => {
  const files = walk(REPORTS_DIR);
  assert.ok(files.length > 5, `the reports tree was really walked (${files.length} files)`);
  assert.ok(REPORTS_MCP_DOORS.length >= 1, "the allowed doors are named");
  const registering = files.filter((file) => toolNamesOf(file).length > 0).map(rel);
  for (const file of registering) {
    assert.ok(REPORTS_MCP_DOORS.includes(file), `${file} registers MCP tools under servers/gateway/reports`);
  }
});