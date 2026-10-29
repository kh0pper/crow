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
import { assertScrubbed } from "../scripts/lib/record-stub-session.mjs";

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

test("the recorder refuses scrubbed text that still names the box", () => {
  const box = { tmp: "/var/tmpx", user: "alice", host: "nest" };
  const clean = '{"cwd":"<scratch>/pi-bots/b","name":"mcp__nest-projects__x","text":"the Nest dashboard"}';
  assert.equal(assertScrubbed(clean, box), clean);
  for (const [bad, what] of [
    ['{"cwd":"/home/someone/x"}', /\/home\//],
    ['{"cwd":"/var/tmpx/crow-rr-1"}', /tmpdir/],
    ['{"text":"hi alice"}', /user name/],
    ['{"url":"http://nest.example.test:3001"}', /host name/],
    ['{"text":"on nest"}', /host name/],
  ]) assert.throws(() => assertScrubbed(bad, box), what, bad);
});

test("the committed fixture has no /home/ or tmp-dir path", () => {
  assertScrubbed(readFileSync(FIXTURE, "utf8"), { tmp: "/tmp", user: "\u0000", host: "\u0000" });
});
