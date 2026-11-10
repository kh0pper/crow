/**
 * Studio hub — a hub loaded ON ITS OWN knows every command.
 *
 * The gateway builds its hub from `bundles/studio/server/hub.js` alone (the
 * panel routes import it), while the MCP server process imports `mcp.js`. The
 * command registry is filled by importing each command module for its side
 * effect, so a module that only `mcp.js` imports is missing from the gateway's
 * hub: every page and agent command of that family is refused there, and the
 * other Studio tests, which import `mcp.js` or the command files directly,
 * never notice. This test imports `hub.js` in a fresh process with nothing
 * else loaded and asks the registry for one command of every family.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "bundles", "studio", "server");

/** One command id per command module the hub must register by itself. */
const FAMILIES = [
  "track.add", // core
  "take.add", // takes
  "arrangement.move", // arrangement
  "pad.set", // sampler
  "midi.map", // midi
  "library.remove", // library
  "track.set_program", // instruments
  "insert.add", // mixer
  "send.set",
  "return.add",
  "master.set",
];

test("a hub loaded on its own registers every command family", () => {
  const script = [
    `await import(${JSON.stringify(pathToFileURL(join(SERVER, "hub.js")).href)});`,
    `const { listCommands } = await import(${JSON.stringify(pathToFileURL(join(SERVER, "commands", "registry.js")).href)});`,
    "process.stdout.write(JSON.stringify(listCommands().map((c) => c.id)));",
  ].join("\n");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 60000,
  });
  const ids = new Set(JSON.parse(out));
  const missing = FAMILIES.filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `hub.js alone is missing: ${missing.join(", ")}`);
});
