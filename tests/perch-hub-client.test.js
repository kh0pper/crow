// The client script is a string. These tests extract named functions from it
// with new Function(...) and exercise them against the real /roost payload
// shape, so the list logic is covered without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";

/** Pull one named function out of the emitted script and make it callable. */
async function extract(name, extra = "") {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const src = perchHubJs("en");
  const start = src.indexOf("function " + name);
  assert.ok(start > -1, name + " is not in the emitted script");
  let depth = 0, end = -1;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (!depth) { end = i; break; } }
  }
  return new Function(extra + src.slice(start, end + 1) + "; return " + name + ";")();
}

const ROOST = {
  birds: [
    { id: "r4-assistant", name: "R4 Assistant", perch_attached: true, state: "working",
      sessions: [{ sessionId: "perchlive-aa", state: "awake", cardId: 49, pendingUi: false, control: "run" }] },
    { id: "asker", name: "Asker", perch_attached: true, state: "waiting",
      sessions: [{ sessionId: "perchlive-bb", state: "awake", cardId: null, pendingUi: true, control: "run" }] },
    { id: "idle-bot", name: "Idle Bot", perch_attached: true, state: "idle", sessions: [] },
    { id: "quiet", name: "Quiet", perch_attached: false, state: "observing", sessions: [] },
  ],
  occupiedCardIds: [49],
};

test("every live session becomes a row, whichever bot it belongs to", async () => {
  const rowsFor = await extract("listRows");
  const rows = rowsFor(ROOST);
  const live = rows.filter((r) => r.sessionId);
  assert.equal(live.length, 2);
  assert.deepEqual(live.map((r) => r.sessionId).sort(), ["perchlive-aa", "perchlive-bb"]);
});

test("a bot with no session still gets a row, so you can start one", async () => {
  const rowsFor = await extract("listRows");
  const idle = rowsFor(ROOST).find((r) => r.botId === "idle-bot");
  assert.ok(idle, "an attached bot with no session must be startable from here");
  assert.equal(idle.sessionId, null);
});

test("a bot without perch attached is not offered — the spawn would 403", async () => {
  const rowsFor = await extract("listRows");
  assert.ok(!rowsFor(ROOST).some((r) => r.botId === "quiet"));
});

test("a session waiting on you sorts above a working one", async () => {
  const rowsFor = await extract("listRows");
  const rows = rowsFor(ROOST).filter((r) => r.sessionId);
  assert.equal(rows[0].sessionId, "perchlive-bb", "pendingUi first — it is blocked on you");
});

test("a stopped session is not a tappable row that dead-ends", async () => {
  const rowsFor = await extract("listRows");
  const rows = rowsFor({ birds: [{ id: "b", name: "B", perch_attached: true, state: "idle",
    sessions: [{ sessionId: "perchlive-dead0000", state: "stopped", cardId: null, pendingUi: false }] }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, null, "the bot stays startable; the dead session does not show");
});

test("an empty roost is an empty list, not a crash", async () => {
  const rowsFor = await extract("listRows");
  assert.deepEqual(rowsFor({ birds: [], occupiedCardIds: [] }), []);
  assert.deepEqual(rowsFor({}), []);
  assert.deepEqual(rowsFor(null), []);
});
