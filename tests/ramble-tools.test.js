import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { createRambleServer } from "../bundles/ramble/server/server.js";

let db, h;
before(async () => {
  db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  const handlers = {};
  const compressed = (s) => "02" + createHash("sha256").update(s).digest("hex");
  const fakeDerive = (seed, botId) => ({ secp256k1Pubkey: compressed(seed + botId), secp256k1Priv: Buffer.from(botId) });
  const identity = { crowId: "crow_T", secp256k1Pubkey: compressed("real"), secp256k1Priv: Buffer.from("real") };
  createRambleServer(db, { _exposeHandlers: handlers, identity, seed: "seed", _derive: fakeDerive, emit: async () => {} });
  h = handlers;
});

test("leave_mark then query_world returns it, attributed to the x-only world pseudonym", async () => {
  const r = await h.ramble_leave_mark({ lat: 30.2672, lon: -97.7431, text: "hello", visibility: "public", reveal: "open" });
  assert.ok(!r.isError);
  const q = await h.ramble_query_world({ lat: 30.2672, lon: -97.7431, visibility: "public" });
  const payload = JSON.parse(q.content[0].text);
  const m = payload.marks.find((m) => m.content_text === "hello");
  assert.ok(m);
  assert.match(m.author, /^[0-9a-f]{64}$/);
});

test("ramble_block hides that persona's marks; ramble_unblock restores them", async () => {
  const lat = 40.7128, lon = -74.006;
  const leave = await h.ramble_leave_mark({ lat, lon, text: "block-me", visibility: "public", reveal: "open" });
  assert.ok(!leave.isError);

  const beforeBlock = JSON.parse((await h.ramble_query_world({ lat, lon, visibility: "public" })).content[0].text);
  const mark = beforeBlock.marks.find((m) => m.content_text === "block-me");
  assert.ok(mark);
  const author = mark.author;

  const blockRes = await h.ramble_block({ persona: author, reason: "test" });
  assert.ok(!blockRes.isError);

  const afterBlock = JSON.parse((await h.ramble_query_world({ lat, lon, visibility: "public" })).content[0].text);
  assert.ok(
    !afterBlock.marks.find((m) => m.content_text === "block-me"),
    "blocked author's mark must not appear in query_world, even though it's a local row",
  );

  const unblockRes = await h.ramble_unblock({ persona: author });
  assert.ok(!unblockRes.isError);

  const afterUnblock = JSON.parse((await h.ramble_query_world({ lat, lon, visibility: "public" })).content[0].text);
  assert.ok(afterUnblock.marks.find((m) => m.content_text === "block-me"), "unblocking restores visibility");
});

test("concurrent FIRST-call ramble_caw invocations resolve a single shared session identity", async () => {
  // A fresh server instance, with identityPromise/emitPromise still
  // unmemoized, so the two concurrent calls below race on the very first
  // resolution (the scenario the promise-memoization fix guards).
  const freshHandlers = {};
  const compressed = (s) => "02" + createHash("sha256").update(s).digest("hex");
  const fakeDerive = (seed, botId) => ({ secp256k1Pubkey: compressed(seed + botId), secp256k1Priv: Buffer.from(botId) });
  const identity = { crowId: "crow_T2", secp256k1Pubkey: compressed("real2"), secp256k1Priv: Buffer.from("real2") };
  createRambleServer(db, { _exposeHandlers: freshHandlers, identity, seed: "seed2", _derive: fakeDerive, emit: async () => {} });

  const [a, b] = await Promise.all([
    freshHandlers.ramble_caw({ lat: 51.5074, lon: -0.1278, text: "caw-a" }),
    freshHandlers.ramble_caw({ lat: 51.5074, lon: -0.1278, text: "caw-b" }),
  ]);
  assert.ok(!a.isError && !b.isError);
  const pa = JSON.parse(a.content[0].text);
  const pb = JSON.parse(b.content[0].text);
  // Same author_level "rotating" + kind "caw" => a per-session key derived
  // from the process's single sessionId. Two different sessionIds (the
  // promise-memoization race) would produce two different authors here.
  assert.equal(pa.author, pb.author);
});
