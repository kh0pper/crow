// I4 (loopback mount helper): the ONE owner-turn predicate both tool families
// use, over a scope resolveSignedScope already resolved. A job is the owner's
// only when bot_jobs.principal is exactly 'owner'; a session only when it is a
// Perch session and the injected Perch engine says its services are live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isOwnerTurnScope, NEVER_OWNER_GATEWAYS } from "../servers/shared/turn-principal.js";

const job = (principal) => ({ scope: "job", id: "job-1", botId: "hank", gatewayType: "job", principal });
const sess = (gatewayType, id = 7) => ({ scope: "session", id, botId: "hank", gatewayType });
const engine = (live) => ({ sessionServicesLive: (id) => live.has(id) });

test("a job is the owner's turn only for principal === 'owner'", () => {
  assert.equal(isOwnerTurnScope(job("owner")), true);
  for (const p of [null, undefined, "", "other", "OWNER", " owner", "device:1"]) assert.equal(isOwnerTurnScope(job(p)), false, String(p));
});

test("a session: never without an engine; only a perch session the engine calls live", () => {
  assert.equal(isOwnerTurnScope(sess("perch")), false, "no engine: every s: fails");
  assert.equal(isOwnerTurnScope(sess("perch"), { engine: null }), false);
  assert.equal(isOwnerTurnScope(sess("perch"), { engine: {} }), false, "an engine without sessionServicesLive");
  assert.equal(isOwnerTurnScope(sess("perch", 7), { engine: engine(new Set([7])) }), true);
  assert.equal(isOwnerTurnScope(sess("perch", 8), { engine: engine(new Set([7])) }), false, "another session");
  assert.equal(isOwnerTurnScope(sess("perch", 7), { engine: { sessionServicesLive: () => "yes" } }), false, "only exactly true");
  assert.equal(isOwnerTurnScope(sess("perch", 7), { engine: { sessionServicesLive: () => { throw new Error("x"); } } }), false, "a throw is no");
});

test("gmail, discord, telegram and slack sessions are never the owner's turn, whatever the engine says", () => {
  assert.deepEqual([...NEVER_OWNER_GATEWAYS].sort(), ["discord", "gmail", "slack", "telegram"]);
  const yes = { sessionServicesLive: () => true };
  for (const g of [...NEVER_OWNER_GATEWAYS, "board", "job", "kiosk", "", null]) assert.equal(isOwnerTurnScope(sess(g), { engine: yes }), false, String(g));
});

test("anything else is not the owner's turn", () => {
  for (const a of [null, undefined, {}, { scope: "other" }, "j:job-1", 5]) assert.equal(isOwnerTurnScope(a), false, JSON.stringify(a));
});
