/**
 * servers/shared/gateway-stopping.js — the process-wide marker that says this
 * gateway's own shutdown has begun.
 *
 * The source test below is the point of this file: the marker must be set
 * SYNCHRONOUSLY, as the first statement of gracefulShutdown, BEFORE the
 * `if (shuttingDown) return;` guard. A dynamic import there is a cold module
 * load on the exit path, and a child that exits on the SIGTERM in that window
 * would be reported as an unexpected crash instead of an interruption.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  markGatewayStopping,
  isGatewayStopping,
  _resetGatewayStoppingForTests,
} from "../servers/shared/gateway-stopping.js";

const INDEX_PATH = new URL("../servers/gateway/index.js", import.meta.url);

test("gateway-stopping: false by default, true after mark, false again after reset", () => {
  _resetGatewayStoppingForTests();
  assert.equal(isGatewayStopping(), false, "a fresh process has announced nothing");

  markGatewayStopping();
  assert.equal(isGatewayStopping(), true);

  markGatewayStopping();
  assert.equal(isGatewayStopping(), true, "marking twice stays true (idempotent)");

  _resetGatewayStoppingForTests();
  assert.equal(isGatewayStopping(), false);
});

/** The body of `async function gracefulShutdown(…)` — from its signature to
 *  the first signal registration that follows it. */
function gracefulShutdownSource() {
  const text = readFileSync(INDEX_PATH, "utf8");
  const start = text.indexOf("async function gracefulShutdown(");
  assert.ok(start >= 0, "gracefulShutdown is declared in servers/gateway/index.js");
  const end = text.indexOf('process.on("SIGINT", gracefulShutdown);', start);
  assert.ok(end > start, "gracefulShutdown's body ends at the SIGINT registration");
  return text.slice(start, end);
}

test("index.js: markGatewayStopping() runs synchronously and before the re-entry guard", () => {
  const body = gracefulShutdownSource();
  const markAt = body.indexOf("markGatewayStopping();");
  const guardAt = body.indexOf("if (shuttingDown) return;");
  assert.ok(markAt >= 0, "gracefulShutdown calls markGatewayStopping()");
  assert.ok(guardAt >= 0, "gracefulShutdown still has its re-entry guard");
  assert.ok(markAt < guardAt,
    "the marker is set before the guard: a repeated signal must not skip announcing it");
  assert.equal(body.slice(0, markAt).includes("await"), false,
    "nothing is awaited before the marker — no cold load can delay it");
});

test("index.js: no dynamic import of perch-interactive.js remains at the top of gracefulShutdown", () => {
  const body = gracefulShutdownSource();
  const guardAt = body.indexOf("if (shuttingDown) return;");
  assert.ok(guardAt >= 0, "gracefulShutdown still has its re-entry guard");
  const prelude = body.slice(0, guardAt);
  assert.equal(/await\s+import\(\s*["'][^"']*perch-interactive\.js["']\s*\)/.test(prelude), false,
    "the marker no longer lives in perch-interactive.js, so nothing is imported before the guard");
  assert.equal(/\bimport\s*\(/.test(prelude), false, "the prelude awaits no import at all");
  // Step 5b still stops the live engine, so its own dynamic import (nothing to
  // do with the marker) stays where it was.
  assert.match(body, /await\s+import\(\s*["']\.\/perch-interactive\.js["']\s*\)/,
    "the engine's stopAll import is still on the shutdown path");
});

test("index.js: the marker comes from a static import of the shared module", () => {
  const text = readFileSync(INDEX_PATH, "utf8");
  const header = text.slice(0, text.indexOf("async function gracefulShutdown("));
  assert.match(header, /import\s*\{\s*markGatewayStopping\s*\}\s*from\s*"\.\.\/shared\/gateway-stopping\.js";/,
    "a top-of-file static import supplies markGatewayStopping");
  assert.equal(/import\s*\{[^}]*markGatewayStopping[^}]*\}\s*from\s*["'][^"']*perch-interactive\.js["']/.test(text), false,
    "index.js does not import the marker from perch-interactive.js");
});