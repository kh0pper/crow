import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePersona } from "../bundles/ramble/server/persona.js";

import { createHash } from "node:crypto";

// Inject a deterministic deriver so the test needs no real identity. Keys are
// shaped like identity.js output: 66-hex COMPRESSED secp256k1 pubkeys.
const compressed = (s) => "02" + createHash("sha256").update(s).digest("hex");
const fakeDerive = (seed, botId) => ({ secp256k1Pubkey: compressed(seed + botId), secp256k1Priv: Buffer.from(botId) });
const realId = { crowId: "crow_ABC", secp256k1Pubkey: compressed("real"), secp256k1Priv: Buffer.from("real") };

test("rotating caw rotates per session; rotating mark is the stable pseudonym; real carries crowId", () => {
  const cawA = resolvePersona(realId, "seed", { level: "rotating", kind: "caw", sessionId: "s1", _derive: fakeDerive });
  const cawB = resolvePersona(realId, "seed", { level: "rotating", kind: "caw", sessionId: "s2", _derive: fakeDerive });
  assert.notEqual(cawA.author, cawB.author); // presence rotates
  const markA = resolvePersona(realId, "seed", { level: "rotating", kind: "mark", sessionId: "s1", _derive: fakeDerive });
  const markB = resolvePersona(realId, "seed", { level: "rotating", kind: "mark", sessionId: "s2", _derive: fakeDerive });
  assert.equal(markA.author, markB.author); // placed marks stay attributable across sessions
  assert.equal(markA.author, compressed("seed" + "ramble-world").slice(2));
  assert.equal(markA.crowId, null);
  const p1 = resolvePersona(realId, "seed", { level: "pseudonym", kind: "caw", _derive: fakeDerive });
  const p2 = resolvePersona(realId, "seed", { level: "pseudonym", kind: "mark", _derive: fakeDerive });
  assert.equal(p1.author, p2.author);
  const r = resolvePersona(realId, "seed", { level: "real", kind: "mark", _derive: fakeDerive });
  assert.equal(r.author, compressed("real").slice(2)); // x-only, NOT the crow_id
  assert.equal(r.crowId, "crow_ABC");
  assert.equal(r.author_level, "real");
});

test("author is always x-only 64-hex (matches event.pubkey)", () => {
  for (const level of ["rotating", "pseudonym", "real"]) {
    const p = resolvePersona(realId, "seed", { level, kind: "mark", sessionId: "s", _derive: fakeDerive });
    assert.match(p.author, /^[0-9a-f]{64}$/, level);
  }
});
