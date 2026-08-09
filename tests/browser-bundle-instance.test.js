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
