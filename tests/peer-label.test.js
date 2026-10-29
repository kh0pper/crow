// A peer instance's writes are labelled with this instance's own name for it, disambiguated by a short
// id suffix when that name is not unique, and never with anything the caller claims.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPeerName, idSuffix, peerDisplayName, peerLabels, labelSkeleton, resolvePeerLabel, peerActorMeta, remoteBotActorAllowed, REMOTE_BOT_ACTOR_MIN } from "../servers/shared/peer-label.js";

const A = { id: "inst-a-1a2b3c4d", name: "wren" };
const sfx = (id) => idSuffix(id);

test("cleanPeerName: NFKC, default-ignorables removed, allowlist letters/digits/space/._-, spaces collapsed, 40 max", () => {
  assert.equal(cleanPeerName("wr\u202een\u200b"), "wren");
  assert.equal(cleanPeerName("wr\u200den"), "wren", "a zero-width joiner is removed");
  assert.equal(cleanPeerName("wr\ufe0fen\u3164"), "wren", "variation selector and Hangul filler are removed");
  assert.equal(cleanPeerName("x (bot from home)"), "x bot from home");
  assert.equal(cleanPeerName("ａｂｃ"), "abc", "NFKC folds full-width forms");
  assert.equal(cleanPeerName("my-host_2.lan"), "my-host_2.lan");
  assert.equal(Array.from(cleanPeerName("y".repeat(60))).length, 40);
  assert.equal(cleanPeerName(null), "");
  assert.equal(cleanPeerName("\u0000 \u00b7"), "");
});

test("idSuffix is the first 8 hex of sha256(id) (64 with full), so ids with the same letters and digits differ", () => {
  assert.match(idSuffix("inst-a-1a2b3c4d"), /^[0-9a-f]{8}$/);
  assert.match(idSuffix("x", true), /^[0-9a-f]{64}$/);
  assert.notEqual(idSuffix("ab-cd"), idSuffix("abc-d"));
  const labels = peerLabels([{ id: "ab-cd", name: "wren" }, { id: "abc-d", name: "wren" }]);
  assert.notEqual(labels.get("ab-cd"), labels.get("abc-d"));
});

test("a unique name is shown as is; this instance's own row counts only as its own name", () => {
  assert.equal(peerDisplayName(A, { others: [{ id: "self", name: "home" }, { id: "inst-c", name: "lark" }], ownName: "home", ownId: "self" }), "wren");
});

test("two rows with the same name (case-folded) are both suffixed", () => {
  const C = { id: "inst-c-99990000", name: "Wren" };
  assert.equal(peerDisplayName(A, { others: [C], ownName: "home" }), `wren [${sfx(A.id)}]`);
  assert.equal(peerDisplayName(C, { others: [A], ownName: "home" }), `Wren [${sfx(C.id)}]`);
});

test("a peer named like this instance itself is suffixed; an empty name is always 'peer [hex]'", () => {
  assert.equal(peerDisplayName({ id: "inst-x-abcd", name: "HOME" }, { ownName: "home" }), `HOME [${sfx("inst-x-abcd")}]`);
  assert.equal(peerDisplayName({ id: "inst-x-abcd", name: "\u202e\u200b" }), `peer [${sfx("inst-x-abcd")}]`);
  const l = peerLabels([{ id: "p1", name: "" }, { id: "p2", name: "\u00b7" }]);
  assert.equal(l.get("p1"), `peer [${sfx("p1")}]`);
  assert.equal(l.get("p2"), `peer [${sfx("p2")}]`);
});

test("ASCII-only names: Cyrillic, Greek and fullwidth look-alikes and bracket look-alikes never match the real raven's label", () => {
  const real = { id: "inst-real", name: "raven" };
  const twin = { id: "inst-twin", name: "raven" };
  const realLabel = peerLabels([real, twin]).get(real.id);
  assert.equal(realLabel, `raven [${sfx(real.id)}]`);
  const fakes = {
    "r\u0430ven": "r ven",                       // Cyrillic a
    "\u0433\u0430v\u0435n": "v n",                // Cyrillic g, a, e
    "r\u03b1ven": "r ven",                       // Greek alpha
    "\uff52\uff41\uff56\uff45\uff4e": "raven",  // fullwidth: NFKC makes it plain ASCII "raven"
    [`raven [${sfx("inst-real")}]`]: `raven ${sfx("inst-real")}`,
    [`raven \uff3b${sfx("inst-real")}\uff3d`]: `raven ${sfx("inst-real")}`, // fullwidth brackets fold to [ ], then drop
    [`raven \u27e6${sfx("inst-real")}\u27e7`]: `raven ${sfx("inst-real")}`,
  };
  for (const [name, cleaned] of Object.entries(fakes)) {
    assert.equal(cleanPeerName(name), cleaned, JSON.stringify(name));
    assert.match(cleanPeerName(name), /^[A-Za-z0-9 ._-]*$/);
    const l = peerLabels([real, twin, { id: "inst-imp", name }]);
    assert.notEqual(l.get("inst-imp"), l.get(real.id), JSON.stringify(name));
    assert.equal(new Set([...l.values()].map(labelSkeleton)).size, 3, JSON.stringify(name));
  }
});

test("an all-non-Latin name, or one with fewer than 2 letters or digits, is 'peer [hex]'", () => {
  assert.equal(cleanPeerName("\u0412\u043e\u0440\u043e\u043d"), "");
  assert.equal(peerLabels([{ id: "nl", name: "\u0412\u043e\u0440\u043e\u043d" }]).get("nl"), `peer [${sfx("nl")}]`);
  assert.equal(peerLabels([{ id: "jp", name: "\u30ab\u30e9\u30b9" }]).get("jp"), `peer [${sfx("jp")}]`);
  assert.equal(cleanPeerName("x"), "");
  assert.equal(cleanPeerName("a ."), "");
  assert.equal(cleanPeerName("ab"), "ab");
});

test("separator look-alikes in a name are dropped, so a name cannot imitate another peer's suffixed label", () => {
  const real = { id: "inst-a-1a2b3c4d", name: "wren" };
  const twin = { id: "inst-c-0000ffff", name: "wren" };
  const realLabel = peerDisplayName(real, { others: [twin] });
  assert.equal(realLabel, `wren [${sfx(real.id)}]`);
  for (const sep of ["\u00b7", "\u30fb", "\u2022", "\u2219", "\u2027", "\uff65", "\u0387", "\u22c5", " \u00b7 "]) {
    const fake = `wren${sep}${sfx(real.id)}`;
    assert.doesNotMatch(cleanPeerName(fake), /[\u00b7\u30fb\u2022\u2219\u2027\uff65\u0387\u22c5]/u, JSON.stringify(fake));
    const imp = { id: "inst-x-9999eeee", name: fake };
    const labels = peerLabels([real, twin, imp]);
    assert.notEqual(labels.get(imp.id), labels.get(real.id), JSON.stringify(fake));
    assert.equal(new Set(labels.values()).size, 3);
  }
});

test("the fixpoint: a suffixed label that collides with another row's bare name escalates both, to unique labels", () => {
  // "wren <sfx>" as a bare name, after the twins "wren" are suffixed, must not equal either suffixed label;
  // and a row named exactly like a suffixed label minus the separator still ends unique.
  const x = { id: "inst-a-1", name: "wren" };
  const y = { id: "inst-b-2", name: "wren" };
  const z = { id: "inst-c-3", name: `wren ${sfx("inst-a-1")}` };
  const l = peerLabels([x, y, z], { ownName: `wren ${sfx("inst-b-2")}` });
  const vals = [...l.values()].map(labelSkeleton);
  assert.equal(new Set(vals).size, 3, JSON.stringify([...l]));
  assert.ok(!vals.includes(labelSkeleton(`wren ${sfx("inst-b-2")}`)), "never equal to the own name");
  // Forced escalation to the full hash: a row whose own name is taken at every level but the last.
  const own = `wren [${sfx("inst-q")}]`; // the own name is cleaned: "wren" + 8 hex (the separator is dropped)
  const m = peerLabels([{ id: "inst-q", name: "wren" }], { ownName: own });
  assert.equal(m.get("inst-q"), "wren");
  const m2 = peerLabels([{ id: "inst-q", name: "wren" }], { ownName: "wren" });
  assert.equal(m2.get("inst-q"), `wren [${sfx("inst-q")}]`);
});

test("the fixpoint escalates to a 24-hex suffix (base shortened) when two ids share their first 8 hex, and still fits 40", () => {
  const seen = new Map();
  let pair = null;
  for (let n = 0; !pair && n < 2_000_000; n++) {
    const id = `inst-${n}`;
    const k = idSuffix(id);
    if (seen.has(k)) pair = [seen.get(k), id]; else seen.set(k, id);
  }
  assert.ok(pair, "found a prefix collision");
  const [p, q] = pair;
  const name = "abcdefghij".repeat(4);
  const l = peerLabels([{ id: p, name }, { id: q, name }, { id: "other", name: "lark" }]);
  for (const id of [p, q]) {
    assert.equal(l.get(id), `${name.slice(0, 13)} [${idSuffix(id, true).slice(0, 24)}]`);
    assert.ok(l.get(id).length <= 40, l.get(id));
  }
  assert.notEqual(l.get(p), l.get(q));
  assert.equal(l.get("other"), "lark");
});

test("a suffixed label always fits 40: the base is cut to 24 before ' [8-hex]'", () => {
  const name = "abcdefghij".repeat(4);
  const l = peerLabels([{ id: "x1", name }, { id: "x2", name }]);
  for (const id of ["x1", "x2"]) {
    assert.equal(l.get(id), `${name.slice(0, 24)} [${sfx(id)}]`);
    assert.ok(l.get(id).length <= 40);
  }
  assert.notEqual(l.get("x1"), l.get("x2"));
  // A base whose 24-character cut ends in a space is trimmed before the suffix.
  const n2 = "abcdefghijklmnopqrstuvw abc";
  assert.equal(peerLabels([{ id: "y1", name: n2 }, { id: "y2", name: n2 }]).get("y1"), `abcdefghijklmnopqrstuvw [${sfx("y1")}]`);
  // An unsuffixed name keeps up to 40 characters.
  assert.equal(peerLabels([{ id: "z1", name }]).get("z1"), name);
});

test("a name cannot imitate a suffix: 'raven . <hex>' and 'raven [<hex>]' never match the real raven's label", () => {
  const real = { id: "inst-real", name: "raven" };
  const twin = { id: "inst-twin", name: "raven" };
  const realLabel = peerLabels([real, twin]).get(real.id);
  assert.equal(realLabel, `raven [${sfx(real.id)}]`);
  assert.equal(cleanPeerName(`raven [${sfx(real.id)}]`), `raven ${sfx(real.id)}`, "brackets never survive cleaning");
  for (const name of [`raven . ${sfx(real.id)}`, `raven [${sfx(real.id)}]`, `raven.${sfx(real.id)}`, `raven - ${sfx(real.id)}`]) {
    const l = peerLabels([real, twin, { id: "inst-imp", name }]);
    assert.notEqual(labelSkeleton(l.get("inst-imp")), labelSkeleton(l.get(real.id)), name);
    assert.doesNotMatch(l.get("inst-imp"), new RegExp(`\\[${sfx(real.id)}\\]`), name);
    assert.equal(new Set([...l.values()].map(labelSkeleton)).size, 3, name);
  }
});

test("trailing separators and spaces fold in the skeleton: 'raven.' and 'raven' collide and are both suffixed", () => {
  assert.equal(labelSkeleton("raven. "), labelSkeleton("raven"));
  assert.equal(labelSkeleton("raven-_"), labelSkeleton("raven"));
  const l = peerLabels([{ id: "x1", name: "raven." }, { id: "x2", name: "raven" }]);
  assert.equal(l.get("x1"), `raven. [${sfx("x1")}]`);
  assert.equal(l.get("x2"), `raven [${sfx("x2")}]`);
  assert.equal(peerDisplayName({ id: "x3", name: "home." }, { ownName: "home" }), `home. [${sfx("x3")}]`);
});

test("ASCII confusables collide: 'Iark' and '1ark' with 'lark', 'h0me' with the own name 'home'; all are suffixed", () => {
  const l = peerLabels([{ id: "k1", name: "lark" }, { id: "k2", name: "Iark" }, { id: "k3", name: "1ark" }]);
  assert.equal(l.get("k1"), `lark [${sfx("k1")}]`);
  assert.equal(l.get("k2"), `Iark [${sfx("k2")}]`, "the displayed name stays as cleaned");
  assert.equal(l.get("k3"), `1ark [${sfx("k3")}]`);
  assert.equal(peerDisplayName({ id: "h1", name: "h0me" }, { ownName: "home" }), `h0me [${sfx("h1")}]`);
  for (const [x, y] of [["rnoon", "moon"], ["vvren", "wren"], ["clove", "dove"], ["5ky", "sky"]]) assert.equal(labelSkeleton(x), labelSkeleton(y), x);
  assert.equal(peerLabels([{ id: "u1", name: "lark" }, { id: "u2", name: "wren" }]).get("u1"), "lark", "unrelated names stay bare");
});

test("resolvePeerLabel reads every other row and this instance's own name; a DB error fails toward the suffix", async () => {
  const db = (rows) => ({ execute: async ({ args }) => ({ rows: rows.filter((r) => r.id !== args[0]) }) });
  assert.equal(await resolvePeerLabel(db([A, { id: "self", name: "home" }]), A, "self"), "wren");
  assert.equal(await resolvePeerLabel(db([A, { id: "self", name: "wren" }]), A, "self"), `wren [${sfx(A.id)}]`);
  assert.equal(await resolvePeerLabel({ execute: async () => { throw new Error("disk I/O"); } }, A, "self"), `wren [${sfx(A.id)}]`);
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


// Item 46 PR-B: a peer gateway's verified bot (req.auth.extra.remoteActor, set by mountMcpServer) is forwarded
// as {kind:"bot", id:"<bot>@<instance>", name, instance, from} only to a server that opted in (allowRemoteBot).
const RA = { kind: "bot", id: "hank", name: "Hank", instanceId: "inst-a-1a2b3c4d" };
const peerWith = (remoteActor, extra = {}) => ({ token: "peer-instance", clientId: "instance:inst-a-1a2b3c4d", extra: { peerName: "wren", remoteActor, ...extra } });
const PEER_FORM = { _meta: { "crow/actor": { kind: "peer", instance: "inst-a-1a2b3c4d", from: "wren" } } };

test("peerActorMeta bot branch: only with allowRemoteBot", () => {
  assert.deepEqual(peerActorMeta({ authInfo: peerWith(RA) }, { allowRemoteBot: true }),
    { _meta: { "crow/actor": { kind: "bot", id: "hank@inst-a-1a2b3c4d", name: "Hank", instance: "inst-a-1a2b3c4d", from: "wren" } } });
  assert.deepEqual(peerActorMeta({ authInfo: peerWith(RA) }), PEER_FORM, "no option: the peer form");
  assert.deepEqual(peerActorMeta({ authInfo: peerWith(RA) }, { allowRemoteBot: false }), PEER_FORM);
  const noName = { token: "peer-instance", clientId: "instance:inst-a-1a2b3c4d", extra: { remoteActor: RA } };
  assert.deepEqual(peerActorMeta({ authInfo: noName }, { allowRemoteBot: true })._meta["crow/actor"],
    { kind: "bot", id: "hank@inst-a-1a2b3c4d", name: "Hank", instance: "inst-a-1a2b3c4d" }, "no peerName: from omitted");
});

test("peerActorMeta bot branch: a remoteActor not for the bearer's instance, or malformed, is the peer form", () => {
  const on = { allowRemoteBot: true };
  assert.deepEqual(peerActorMeta({ authInfo: peerWith({ ...RA, instanceId: "inst-c-99990000" }) }, on), PEER_FORM);
  assert.deepEqual(peerActorMeta({ authInfo: peerWith({ ...RA, kind: "peer" }) }, on), PEER_FORM);
  assert.deepEqual(peerActorMeta({ authInfo: peerWith({ ...RA, id: "" }) }, on), PEER_FORM);
  assert.deepEqual(peerActorMeta({ authInfo: peerWith({ ...RA, name: 5 }) }, on), PEER_FORM);
  assert.deepEqual(peerActorMeta({ authInfo: peerWith({ ...RA, name: "" }) }, on), PEER_FORM, "an empty name is the peer form");
  assert.deepEqual(peerActorMeta({ authInfo: peerWith("hank") }, on), PEER_FORM);
  const noCid = { token: "peer-instance", extra: { peerName: "wren", remoteActor: RA } };
  assert.equal(peerActorMeta({ authInfo: noCid }, on)._meta["crow/actor"].kind, "peer", "no bearer instance: never a bot");
});

test("peerActorMeta: local and OAuth callers get {} even with a remoteActor present", () => {
  const on = { allowRemoteBot: true };
  assert.deepEqual(peerActorMeta({ authInfo: { token: "local-mcp", clientId: "instance:inst-a-1a2b3c4d", extra: { remoteActor: RA } } }, on), {});
  assert.deepEqual(peerActorMeta({ authInfo: { token: "oauth-xyz", extra: { remoteActor: RA } } }, on), {});
  assert.deepEqual(peerActorMeta(undefined, on), {});
});

test("remoteBotActorAllowed: workspace at or above 0.4.3 only", () => {
  assert.deepEqual(REMOTE_BOT_ACTOR_MIN, { workspace: "0.4.3" });
  assert.equal(remoteBotActorAllowed({ id: "workspace", version: "0.4.2" }), false);
  assert.equal(remoteBotActorAllowed({ id: "workspace", version: "0.4.3" }), true);
  assert.equal(remoteBotActorAllowed({ id: "workspace", version: "0.10.0" }), true);
  assert.equal(remoteBotActorAllowed({ id: "workspace", version: "1.0.0" }), true);
  assert.equal(remoteBotActorAllowed({ id: "workspace", version: "0.3.9" }), false);
  for (const v of [undefined, null, "", "garbage", "0.4", "0.4.3.1", "v0.4.3", 43, "0.4.3-beta"]) {
    assert.equal(remoteBotActorAllowed({ id: "workspace", version: v }), false, String(v));
  }
  assert.equal(remoteBotActorAllowed({ id: "research", version: "9.9.9" }), false);
  assert.equal(remoteBotActorAllowed({ id: "constructor", version: "9.9.9" }), false);
  assert.equal(remoteBotActorAllowed(null), false);
  assert.equal(remoteBotActorAllowed("workspace"), false);
});
