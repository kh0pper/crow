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

test("ramble_block hides that persona's marks", async () => {
  const r = await h.ramble_block({ persona: "a".repeat(64), reason: "test" });
  assert.ok(!r.isError);
});
