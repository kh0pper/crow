/**
 * Shell and module syntax for the files the CDP gate changes: `bash -n` on both scripts and
 * `node --check` on the relay. The entrypoint cannot be run without Docker, so this is the
 * only thing CI does with it other than reading it — and a syntax error there is a container
 * that dies at 3 a.m. rather than a failing test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const SHELLS = ["bundles/browser/entrypoint.sh", "scripts/ops/browser-cdp-gate.sh", "scripts/ops/browser-profile-to-volume.sh"];
const MODULES = ["bundles/browser/cdp-relay.mjs"];

for (const f of SHELLS) {
  test(`bash -n ${f}`, () => {
    execFileSync("bash", ["-n", `${ROOT}${f}`], { stdio: "pipe" });
    assert.ok(true);
  });
}

for (const f of MODULES) {
  test(`node --check ${f}`, () => {
    execFileSync(process.execPath, ["--check", `${ROOT}${f}`], { stdio: "pipe" });
    assert.ok(true);
  });
}