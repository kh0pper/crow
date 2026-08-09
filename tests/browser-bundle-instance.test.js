import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateRoot, stateDir } from "../bundles/browser/server/instance.js";

const SERVER_JS = new URL("../bundles/browser/server/server.js", import.meta.url);

/** Run `fn` with CROW_HOME forced to `value` (or unset when value is null). */
function withCrowHome(value, fn) {
  const prev = process.env.CROW_HOME;
  if (value === null) delete process.env.CROW_HOME;
  else process.env.CROW_HOME = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.CROW_HOME;
    else process.env.CROW_HOME = prev;
  }
}

test("every state directory derives from CROW_HOME", () => {
  withCrowHome("/tmp/scratch-crow-r4", () => {
    assert.equal(stateRoot(), "/tmp/scratch-crow-r4");
    assert.equal(stateDir("browser-sessions"), "/tmp/scratch-crow-r4/browser-sessions");
    assert.equal(stateDir("browser-downloads"), "/tmp/scratch-crow-r4/browser-downloads");
    assert.equal(stateDir("browser-exports"), "/tmp/scratch-crow-r4/browser-exports");
  });
});

test("state directories fall back to ~/.crow when CROW_HOME is unset", () => {
  withCrowHome(null, () => {
    assert.equal(stateRoot(), join(homedir(), ".crow"));
    assert.equal(stateDir("browser-downloads"), join(homedir(), ".crow", "browser-downloads"));
  });
});

test("server.js never hardcodes the primary's home", () => {
  const src = readFileSync(SERVER_JS, "utf8");
  assert.ok(
    !/join\(\s*homedir\(\)\s*,\s*"\.crow"/.test(src),
    "server.js must resolve state through stateDir(), not join(homedir(), \".crow\", ...)",
  );
});

test("containerName honors CROW_BROWSER_CONTAINER_NAME and defaults to crow-browser", async () => {
  const { containerName } = await import("../bundles/browser/server/instance.js");
  const prev = process.env.CROW_BROWSER_CONTAINER_NAME;
  try {
    process.env.CROW_BROWSER_CONTAINER_NAME = "crow-browser-r4";
    assert.equal(containerName(), "crow-browser-r4");
    delete process.env.CROW_BROWSER_CONTAINER_NAME;
    assert.equal(containerName(), "crow-browser");
  } finally {
    if (prev === undefined) delete process.env.CROW_BROWSER_CONTAINER_NAME;
    else process.env.CROW_BROWSER_CONTAINER_NAME = prev;
  }
});

test("no docker call in server.js hardcodes a container name", () => {
  const src = readFileSync(SERVER_JS, "utf8");
  const dockerLines = src.split("\n").filter((l) => l.includes('execFileSync("docker"'));
  assert.ok(dockerLines.length >= 4, `expected the docker calls to still exist, found ${dockerLines.length}`);
  for (const line of dockerLines) {
    assert.ok(
      !line.includes('"crow-browser"'),
      `docker call targets the primary's container by name: ${line.trim()}`,
    );
  }
});

test("crow_browser_status reports what the server bound to", () => {
  const src = readFileSync(SERVER_JS, "utf8");

  // Scope to the crow_browser_status handler only — checking the whole file lets
  // unrelated matches (e.g. a Zod field named `container` on a different tool, or
  // a pre-existing `cdp_url` in the reconnect response) pass the assertion even
  // when this handler's own payload never mentions the field.
  const statusStart = src.indexOf('"crow_browser_status"');
  assert.ok(statusStart !== -1, "could not find the crow_browser_status tool registration");
  const nextToolStart = src.indexOf("server.tool(", statusStart);
  const handlerSlice = nextToolStart === -1 ? src.slice(statusStart) : src.slice(statusStart, nextToolStart);
  assert.ok(handlerSlice.length > 0, "crow_browser_status handler slice must be non-empty");

  // Narrow further to the JSON.stringify(...) payload object itself, so the tool's
  // own description text ("Check browser container...") can't satisfy the check.
  const payloadStart = handlerSlice.indexOf("JSON.stringify(");
  assert.ok(payloadStart !== -1, "could not find the JSON.stringify(...) status payload inside the handler");
  const payloadEnd = handlerSlice.indexOf("}, null, 2)", payloadStart);
  assert.ok(payloadEnd !== -1, "could not find the end of the status payload object");
  const payloadSlice = handlerSlice.slice(payloadStart, payloadEnd);
  assert.ok(payloadSlice.length > 0, "crow_browser_status payload slice must be non-empty");

  for (const field of ["container", "cdp_url", "state_root"]) {
    // Word-boundary match: "container" must not be satisfied by "container_running".
    const re = new RegExp(`\\b${field}\\b`);
    assert.ok(re.test(payloadSlice), `crow_browser_status payload must report ${field} so a deploy can be verified by running it`);
  }
});

test("the downloads mount requires CROW_HOME instead of defaulting to the primary", () => {
  const compose = readFileSync(new URL("../bundles/browser/docker-compose.yml", import.meta.url), "utf8");
  assert.ok(
    !compose.includes("${CROW_HOME:-"),
    "a CROW_HOME default lets a hand-run compose mount the primary's downloads into a second instance's container",
  );
  assert.match(compose, /\$\{CROW_HOME:\?/, "the mount must fail loudly when CROW_HOME is unset");
});
