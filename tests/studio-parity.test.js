/**
 * Studio parity — the agent surface against the registry, and the engine
 * catalogue against the vendored SunVox build.
 *
 * The parity rule (spec §5.1) is that no edit exists for one caller only. This
 * file covers both halves of it: every command the GUI can send is a tool the
 * agent can call, people-only commands are tools for nobody, and the only tools
 * that are not commands are the song/history/render/reference set listed below;
 * and the GUI's own command list is exactly the registry, in both directions.
 *
 * The catalogue test loads the vendored WASM engine in Node and asks it, which
 * is the only way to know the catalogue the agent reads is the real one: it
 * asserts the Analog generator is there with at least one controller. It does
 * not guess controller names — those come from the engine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStudioServer } from "../bundles/studio/server/mcp.js";
import { listCommands } from "../bundles/studio/server/commands/registry.js";
import { GENERATOR_TYPES, moduleCatalogue } from "../bundles/studio/server/catalogue.js";
import { CLIENT_SCRIPT, COMMANDS } from "../bundles/studio/panel/client.js";

/**
 * The tools that are not registry commands: the song/history reads, the two
 * history steps, the render and the engine reference (plan Task 9).
 * @type {ReadonlySet<string>}
 */
const DOCUMENTED_TOOLS = new Set([
  "studio_list_songs",
  "studio_create_song",
  "studio_session_summary",
  "studio_get_clip",
  "studio_history",
  "studio_undo",
  "studio_redo",
  "studio_render",
  "studio_module_types",
]);

/** @returns {string} the MCP tool name a registry command id maps to. */
function toolNameOf(commandId) {
  return `studio_${commandId.replace(/\./g, "_")}`;
}

/** A hub client stub: the list never gets called beyond `listSongs`. */
function stubHub() {
  const refuseRead = async () => {
    throw new Error("this parity test does not read songs");
  };
  return {
    async listSongs() {
      return [];
    },
    createSong: refuseRead,
    snapshot: refuseRead,
    history: refuseRead,
    command: refuseRead,
    undo: refuseRead,
    redo: refuseRead,
  };
}

/** A renderer stub: this test lists tools, it never renders. */
const stubRenderer = {
  async render() {
    throw new Error("this parity test does not render");
  },
};

/** A catalogue stub: the real catalogue has its own test below. */
const stubCatalogue = async () => ({ modules: {} });

/** @returns {Promise<string[]>} every tool name the server exposes. */
async function toolNames() {
  const server = createStudioServer({
    hub: stubHub(),
    renderer: stubRenderer,
    catalogue: stubCatalogue,
    env: {},
  });
  const client = new Client({ name: "studio-parity-test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    return listed.tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

test("every non-humanOnly command has exactly one tool and humanOnly ones have none", async () => {
  const names = await toolNames();
  const commands = listCommands();
  assert.ok(commands.length > 0, "the registry should be populated (commands/core.js is imported)");

  for (const command of commands) {
    const expected = toolNameOf(command.id);
    const count = names.filter((name) => name === expected).length;
    if (command.humanOnly) {
      assert.equal(count, 0, `${expected} exists, but "${command.id}" is people-only`);
    } else {
      assert.equal(count, 1, `${expected} should exist exactly once for "${command.id}"`);
    }
  }
});

test("every MCP tool maps to a registry command or to the documented song/history/render set", async () => {
  const names = await toolNames();
  const commandTools = new Set(
    listCommands()
      .filter((command) => !command.humanOnly)
      .map((command) => toolNameOf(command.id)),
  );

  for (const name of names) {
    assert.ok(
      commandTools.has(name) || DOCUMENTED_TOOLS.has(name),
      `${name} is neither a registry command tool nor one of the documented tools`,
    );
  }
  for (const name of [...commandTools, ...DOCUMENTED_TOOLS]) {
    assert.equal(
      names.filter((listed) => listed === name).length,
      1,
      `${name} should be listed exactly once`,
    );
  }
});

test("moduleCatalogue lists Analog generator with a Volume-like controller", async () => {
  const catalogue = await moduleCatalogue();
  const analog = catalogue.modules["Analog generator"];
  assert.ok(analog, "the catalogue should list the Analog generator");
  assert.equal(analog.kind, "generator", "the Analog generator is a track device");
  assert.ok(Array.isArray(analog.controllers), "its controllers should be a list");
  assert.ok(analog.controllers.length >= 1, "it should have at least one controller");
  for (const controller of analog.controllers) {
    assert.equal(typeof controller.name, "string");
    assert.equal(typeof controller.min, "number");
    assert.equal(typeof controller.max, "number");
    assert.ok(controller.kind === "normal" || controller.kind === "selector");
    assert.equal(typeof controller.default, "number");
  }
  assert.ok(GENERATOR_TYPES.includes("Analog generator"), "it is one of the 1a track devices");
});

/**
 * Every command id the panel declares, read out of the script it actually
 * serves: the `var COMMANDS = [...]` line inside CLIENT_SCRIPT.
 * @returns {string[]}
 */
function panelCommandIds() {
  const match = /var COMMANDS = \[([^\]]*)\]/
    .exec(CLIENT_SCRIPT);
  assert.ok(match, "panel/client.js should declare `var COMMANDS = [...]` inside its script");
  return [...match[1].matchAll(/'([^']+)'/g)].map((found) => found[1]);
}

test("every registry command id appears in panel/client.js COMMANDS list and vice versa", () => {
  const listed = panelCommandIds();
  assert.equal(listed.length, new Set(listed).size, `the panel lists a command twice: ${listed.join(", ")}`);

  const registry = listCommands().map((command) => command.id).sort();
  assert.deepEqual([...listed].sort(), registry, "the GUI's command list and the registry are the same set");

  // The module export and the script's own declaration cannot drift apart.
  assert.deepEqual([...COMMANDS].sort(), registry, "the exported COMMANDS is the registry");
});