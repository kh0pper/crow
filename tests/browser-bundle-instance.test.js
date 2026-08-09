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
  for (const field of ["container:", "cdp_url:", "state_root:"]) {
    assert.ok(src.includes(field), `crow_browser_status must report ${field} so a deploy can be verified by running it`);
  }
});
