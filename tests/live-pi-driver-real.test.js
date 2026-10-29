/**
 * The live pi driver with a REAL pi against the loopback stub model: one crow-projects MCP call
 * on day 1, a new pi session on day 2. Needs PI_CLI (pi's dist/cli.js) and PI_LAB_DIR (the
 * pi-lab package, which carries the MCP client and the permission gate); skipped without them,
 * with "pi not installed" when resolvePiCli() finds no pi either, as on the CI runners. Run it
 * under the node pi is installed for: the bridge spawns pi with process.execPath.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolvePiCli } from "../scripts/pi-bots/pi_resolver.mjs";
import { settledSurvivorsByMarker, bootSecNow } from "../scripts/lib/live-pi-driver.mjs";
import { realPiPrereqs, runRealStubConversation } from "../scripts/lib/record-stub-session.mjs";
import { parseSession, TOOL_PREFIX } from "../scripts/research-eval/session-log.mjs";

const pre = realPiPrereqs();
// No PI_CLI and nothing resolvePiCli() can find is the CI shape; otherwise both env paths must exist.
const skip = !process.env.PI_CLI && !resolvePiCli() ? "pi not installed" : (pre.piCli ? false : pre.reason);

test("real pi: tool call round-trip over two threads", { skip, timeout: 900_000 }, async (t) => {
  const sinceBootSec = bootSecNow();
  const run = await runRealStubConversation({ piCli: pre.piCli, piLab: pre.piLab });
  t.after(() => run.cleanup());
  const { result: r, stub, events } = run;
  assert.equal(r.ok, true, `${r.contaminated}\n${r.reason}`);
  const runId = events.find((e) => e.runId)?.runId;
  assert.deepEqual(await settledSurvivorsByMarker(runId, { sinceBootSec }), []);

  const [day1, day2] = r.threads;
  const p = parseSession(readFileSync(day1.sessionPaths[0], "utf8"));
  assert.equal(p.parse_ok, true);
  const calls = p.events.filter((e) => e.kind === "call");
  assert.equal(calls.length, 1, JSON.stringify(calls));
  assert.equal(`mcp__${calls[0].server}__`, TOOL_PREFIX);
  assert.equal(calls[0].tool, "crow_list_projects");
  // The call reached the scratch DB's crow-projects server and came back.
  const results = p.events.filter((e) => e.kind === "result");
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, false, results[0].text);
  assert.equal(p.prose, "noted");

  assert.ok(stub.requests.length >= 3, `stub saw ${stub.requests.length} requests`);
  const names = (stub.requests[0].tools ?? []).map((x) => x?.function?.name);
  assert.ok(names.includes(`${TOOL_PREFIX}crow_list_projects`), names.join(", "));

  const sid = (th) => [...new Set(th.turns.map((e) => e.piSessionId))];
  assert.equal(sid(day1).length, 1);
  assert.equal(sid(day2).length, 1);
  assert.notEqual(sid(day1)[0], sid(day2)[0]);
});
