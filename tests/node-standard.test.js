// One declared Node major for the whole repo (Node 24 standard, 2026-09-23).
// CI, engines, the installer and the Dockerfile drifted apart once (CI said
// 22 while prod ran 24); this pins them to each other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const pkg = JSON.parse(read("package.json"));
const floor = /^>=(\d+)(\.\d+){0,2}$/.exec(pkg.engines?.node || "");

test("package.json engines.node is a >= floor", () => {
  assert.ok(floor, `engines.node should be ">=<major>", got ${pkg.engines?.node}`);
});

const MAJOR = floor?.[1];

test("every CI setup-node pins the engines major", () => {
  for (const wf of [".github/workflows/test.yml", ".github/workflows/deploy-docs.yml"]) {
    const versions = [...read(wf).matchAll(/node-version:\s*"?(\d+)"?/g)].map((m) => m[1]);
    assert.ok(versions.length > 0, `${wf} has no node-version`);
    for (const v of versions) assert.equal(v, MAJOR, `${wf} node-version ${v} != engines major ${MAJOR}`);
  }
});

test("installer NODE_MAJOR and its minimum match the engines major", () => {
  const s = read("scripts/crow-install.sh");
  assert.equal(/^NODE_MAJOR=(\d+)$/m.exec(s)?.[1], MAJOR);
  assert.ok(/"\$CURRENT_NODE" -ge "?\$\{?NODE_MAJOR\}?"?/.test(s), "installer must upgrade any node below NODE_MAJOR");
});

test("start.sh minimum and root Dockerfile base match the engines major", () => {
  assert.equal(/"\$NODE_VERSION" -lt (\d+)/.exec(read("start.sh"))?.[1], MAJOR);
  assert.equal(/^FROM node:(\d+)/m.exec(read("Dockerfile"))?.[1], MAJOR);
});

test("live code never spawns a hardcoded nvm node", () => {
  for (const f of ["servers/gateway/routes/bot-board-api.js", "scripts/bots/router_dispatch.mjs"]) {
    assert.ok(!/\.nvm\/versions\/node\/v\d/.test(read(f)), `${f} hardcodes an nvm node path; use process.execPath`);
  }
});
