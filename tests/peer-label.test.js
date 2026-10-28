// A peer instance's writes are labelled with this instance's own name for it, disambiguated by a short
// id suffix when that name is not unique, and never with anything the caller claims.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPeerName, idSuffix, peerDisplayName, resolvePeerLabel, peerActorMeta } from "../servers/shared/peer-label.js";

const A = { id: "inst-a-1a2b3c4d", name: "wren" };

test("cleanPeerName strips control, format and parenthesis characters and caps at 40", () => {
  assert.equal(cleanPeerName("wr\u202een\u200b"), "wren");
  assert.equal(cleanPeerName("x (bot from home)"), "x bot from home");
  assert.equal(Array.from(cleanPeerName("y".repeat(60))).length, 40);
  assert.equal(cleanPeerName(null), "");
  assert.equal(cleanPeerName("\u0000 "), "");
});

test("idSuffix is the last 4 letters or digits", () => {
  assert.equal(idSuffix("inst-a-1a2b3c4d"), "3c4d");
  assert.equal(idSuffix("0867ac28-xx"), "28xx");
  assert.equal(idSuffix(""), "0000");
});

test("a unique name is shown as is", () => {
  assert.equal(peerDisplayName(A, { others: [{ id: "self", name: "home" }, { id: "inst-c", name: "lark" }], ownName: "home" }), "wren");
});

test("a name another row also has gets the id suffix (case-folded), and so does the other one", () => {
  const C = { id: "inst-c-99990000", name: "Wren" };
  assert.equal(peerDisplayName(A, { others: [C], ownName: "home" }), "wren·3c4d");
  assert.equal(peerDisplayName(C, { others: [A], ownName: "home" }), "Wren·0000");
});

test("a peer named like this instance itself is suffixed", () => {
  assert.equal(peerDisplayName({ id: "inst-x-abcd", name: "HOME" }, { others: [], ownName: "home" }), "HOME·abcd");
});

test("a name that cleans to nothing becomes peer·<suffix>; a name that only differs by format characters still clashes", () => {
  assert.equal(peerDisplayName({ id: "inst-x-abcd", name: "\u202e\u200b" }), "peer\u00b7abcd");
  assert.equal(peerDisplayName({ id: "inst-x-abcd", name: "wr\u200ben" }, { others: [A] }), "wren\u00b7abcd");
});

test("resolvePeerLabel reads every other row and this instance's own name; a DB error fails toward the suffix", async () => {
  const db = (rows) => ({ execute: async ({ args }) => ({ rows: rows.filter((r) => r.id !== args[0]) }) });
  assert.equal(await resolvePeerLabel(db([A, { id: "self", name: "home" }]), A, "self"), "wren");
  assert.equal(await resolvePeerLabel(db([A, { id: "self", name: "wren" }]), A, "self"), "wren·3c4d");
  assert.equal(await resolvePeerLabel({ execute: async () => { throw new Error("disk I/O"); } }, A, "self"), "wren·3c4d");
});

test("peerActorMeta: peers only, built from the server-side auth record", () => {
  const peer = { token: "peer-instance", clientId: "instance:inst-a-1a2b3c4d", extra: { peerName: "wren" } };
  assert.deepEqual(peerActorMeta({ authInfo: peer }), { _meta: { "crow/actor": { kind: "peer", instance: "inst-a-1a2b3c4d", from: "wren" } } });
  assert.deepEqual(peerActorMeta({ authInfo: { token: "peer-instance" } }), { _meta: { "crow/actor": { kind: "peer" } } });
  // A local operator, an OAuth client or no auth: nothing, even if the call claims an actor.
  assert.deepEqual(peerActorMeta({ authInfo: { token: "local-mcp", clientId: "local-mcp", extra: { peerName: "wren" } }, _meta: { "crow/actor": { kind: "bot", name: "x" } } }), {});
  assert.deepEqual(peerActorMeta({ authInfo: { token: "oauth-xyz" } }), {});
  assert.deepEqual(peerActorMeta(undefined), {});
  // The caller's own _meta never leaks into the forwarded one.
  const m = peerActorMeta({ authInfo: peer, _meta: { "crow/actor": { kind: "bot", id: "owner", name: "Alex" } } });
  assert.equal(m._meta["crow/actor"].kind, "peer");
  assert.equal(m._meta["crow/actor"].name, undefined);
});

test("artifacts stay closed to peers (regression): the peer auth record, with its label, is still unattributed", async () => {
  const { resolveArtifactsActor } = await import("../bundles/artifacts/server/mcp.js");
  const extra = { authInfo: { token: "peer-instance", clientId: "instance:inst-a-1a2b3c4d", extra: { peerName: "wren" } },
    requestInfo: { headers: { "x-crow-actor-kind": "bot", "x-crow-actor-id": "hank" } } };
  assert.equal(resolveArtifactsActor(extra, () => true).kind, "unattributed");
});

test("the research router forwards a peer in the same shape (and still never as a bot)", async () => {
  const { forwardActorMeta, resolveCallActor, OWNER } = await import("../servers/research/actor.js");
  const extra = { authInfo: { token: "peer-instance", clientId: "instance:inst-a-1a2b3c4d", extra: { peerName: "wren" } }, _meta: { "crow/actor": { kind: "bot", id: "x" } } };
  assert.deepEqual(forwardActorMeta(extra), { _meta: { "crow/actor": { kind: "peer", instance: "inst-a-1a2b3c4d", from: "wren" } } });
  assert.equal(resolveCallActor(OWNER, forwardActorMeta(extra)).kind, "unknown");
});

test("a peer cannot imitate another peer's suffixed label with a separator in its own name", () => {
  const real = { id: "inst-a-1a2b3c4d", name: "wren" };
  const twin = { id: "inst-c-0000ffff", name: "wren" };
  const realLabel = peerDisplayName(real, { others: [twin] });
  assert.equal(realLabel, "wren\u00b73c4d");
  for (const fake of ["wren \u00b7 3c4d", "wren\u00b73c4d", "wren\u30fb3c4d", "wren\u20223c4d", "wren\u22193c4d", "wren\u20273c4d", "wren\uff653c4d", "wren\u03873c4d"]) {
    const imp = { id: "inst-x-9999eeee", name: fake };
    const label = peerDisplayName(imp, { others: [real, twin] });
    assert.notEqual(label, realLabel, fake);
    assert.equal(label, "peer\u00b7eeee", fake);
    assert.equal(cleanPeerName(fake), "", "look-alike separators reject the name: " + JSON.stringify(fake));
  }
});

test("a final label that still collides (same name, same id tail) gets a longer suffix", () => {
  const x = { id: "inst-a-11113c4d", name: "wren" };
  const y = { id: "inst-b-22223c4d", name: "wren" };
  assert.equal(peerDisplayName(x, { others: [y] }), "wren\u00b711113c4d");
  // A nameless peer whose label would equal this instance's own name? Own names are cleaned the same way,
  // so an own name holding a separator is rejected too and reserves nothing.
  assert.equal(peerDisplayName({ id: "inst-q-abcd", name: "" }, { ownName: "peer\u00b7abcd" }), "peer\u00b7abcd");
});
