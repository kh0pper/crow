// tests/fixtures/peer-pair.mjs: a gateway that cannot bind its port is never mistaken for one that did. A port taken by
// another gateway while the peer was down once answered the pairing CLI with enrollment_disabled (a CI flake).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Instance, pairInto } from "./fixtures/peer-pair.mjs";

test("pairing survives a port taken while the peer was down", { timeout: 300_000 }, async () => {
  const A = await new Instance("a", "100.64.20.11").init();
  const B = await new Instance("b", "100.64.20.12").init();
  const C = await new Instance("c", "100.64.20.13").init();
  try {
    C.port = A.port;            // another gateway grabs A's port in the meantime
    await C.boot();
    await B.boot();
    const r = await pairInto(B, A);
    assert.equal(r.code, 0, `pairing failed: ${r.out}`);
    assert.ok(B.tokens()[A.id], "B holds A's credentials");
  } finally { for (const x of [A, B, C]) await x.cleanup(); }
});
