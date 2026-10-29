/**
 * The tool-name gate: one session a real pi wrote through the live pi driver against the stub
 * model (scripts/lib/record-stub-session.mjs), scrubbed of local paths. research-eval's
 * parseSession must read it, so a pi spelling change shows up here without a pi on the runner.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSession, TOOL_PREFIX } from "../scripts/research-eval/session-log.mjs";

const FIXTURE = join(import.meta.dirname, "fixtures", "live-pi-driver", "real-pi-stub-session.jsonl");

test("recorded real pi session parses", () => {
  const p = parseSession(readFileSync(FIXTURE, "utf8"));
  assert.equal(p.parse_ok, true);
  const calls = p.events.filter((e) => e.kind === "call");
  const results = p.events.filter((e) => e.kind === "result");
  assert.ok(calls.length >= 1, "at least one call");
  assert.ok(results.length >= 1, "at least one result");
  assert.equal(`mcp__${calls[0].server}__`, TOOL_PREFIX);
  assert.equal(calls[0].tool, "crow_list_projects");
  assert.equal(results[0].isError, false);
  assert.ok(p.prose.length > 0, "prose is non-empty");
});
