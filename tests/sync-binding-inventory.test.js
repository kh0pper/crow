/**
 * PT-2a static inventory (private engineering notes: sync pair binding,
 * Task 7), split by transport:
 *
 * - tailnet (`tailnet-sync.js`): every handshake side effect in
 *   handleAcceptedConnection and PeerDialer.connect (markPeerCr, markPending,
 *   backfillPeerAddress, initInstance, UPDATE crow_instances, .replicate)
 *   comes after the pair-binding decision in the same function; elsewhere they
 *   occur only in named helpers reached from there (rememberPeerSyncPort inside
 *   backfillPeerAddress) or in non-handshake jobs (the boot row repair, the
 *   refresh loop's persisted-key heal). The decision chain itself is checked:
 *   decideTailnetBinding → decideAndRecordPairBinding → decidePairBinding.
 * - Hyperswarm (`peer-manager.js`, extends PT-3's H-C11): onInstanceConnected,
 *   onInstanceKeyReceived and getFeedKeyForInstance are called only from
 *   _admit, _completeAdmit, _sendDeferredReply or _dispatchAdmitted;
 *   onInstanceKeyReceived only ever with state.remoteInstanceId (never a
 *   frame's msg.instance_id, even one checked equal to it); the
 *   `pair-binding` and `instance-key` frames are sent only inside _admit after
 *   the one-id resolution; and _admit calls its guard before its first side
 *   effect.
 *
 * Allowlists name functions, never files. Patterns are multiline (a call split
 * across lines still matches). Each scan has a positive control: a planted
 * unguarded call in a temp copy fails it, and a plant inside a comment does not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TAILNET = new URL("../servers/sharing/tailnet-sync.js", import.meta.url).pathname;
const PEER_MANAGER = new URL("../servers/sharing/peer-manager.js", import.meta.url).pathname;
const PAIR_BINDING = new URL("../servers/shared/sync-pair-binding.js", import.meta.url).pathname;
const T = { timeout: 60_000 };

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));
}

/**
 * Function spans by indentation (the repo's style): top-level functions and
 * classes close at a `}` in column 0; class methods and functions nested one
 * level deep close at `  }`. Class methods are named `Class.method`. The
 * innermost span containing an offset names it.
 */
function functionSpans(src) {
  const spans = [];
  const close = (from, indent) => {
    // A closing brace alone on its line (`}) {` closing a multiline parameter list is not one).
    const re = new RegExp(`^${" ".repeat(indent)}\\}[;,]?[ \\t]*$`, "gm");
    re.lastIndex = from;
    const e = re.exec(src);
    return e ? e.index : src.length;
  };
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm)) {
    spans.push({ name: m[1], start: m.index, end: close(m.index + m[0].length, 0) });
  }
  for (const m of src.matchAll(/^ {2}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
    const outer = spans.filter((s) => m.index > s.start && m.index < s.end).at(-1);
    spans.push({ name: `${outer ? `${outer.name}.` : ""}${m[1]}`, start: m.index, end: close(m.index + m[0].length, 2) });
  }
  for (const c of src.matchAll(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm)) {
    const cEnd = close(c.index + c[0].length, 0);
    const re = /^ {2}(?:async\s+)?(?:static\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
    re.lastIndex = c.index;
    let m;
    while ((m = re.exec(src)) && m.index < cEnd) {
      if (["if", "for", "while", "switch", "catch", "function"].includes(m[1])) continue;
      spans.push({ name: `${c[1]}.${m[1]}`, start: m.index, end: close(m.index + m[0].length, 2) });
    }
  }
  const where = (i) => spans.filter((s) => i >= s.start && i < s.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]?.name ?? "<top level>";
  const body = (name) => { const s = spans.find((x) => x.name === name); return s ? { ...s, text: src.slice(s.start, s.end) } : null; };
  return { spans, where, body };
}

/** `function name(` is a definition, not a call. */
const isDefinition = (src, i) => /\bfunction\s*\*?\s*$/.test(src.slice(Math.max(0, i - 20), i));

// ------------------------------------------------------------------ tailnet
const TAILNET_GUARDED = {
  // function → the decision call that must precede every side effect in it
  handleAcceptedConnection: /\bdecideTailnetBinding\s*\(/g,
  "PeerDialer.connect": /\bbindOrRefuse\s*\(\s*\{/g,
};
const TAILNET_EFFECTS = [
  { what: "markPeerCr(", re: /\bmarkPeerCr\s*\(/g, elsewhere: [] },
  { what: "markPending(", re: /\bmarkPending\s*\(/g, elsewhere: [] },
  { what: "backfillPeerAddress(", re: /\bbackfillPeerAddress\s*\(/g, elsewhere: [] },
  { what: "rememberPeerSyncPort(", re: /\brememberPeerSyncPort\s*\(/g, elsewhere: ["backfillPeerAddress"] },
  // The refresh loop's heal re-opens a persisted key from the row (no handshake).
  { what: "initInstance(", re: /\.\s*initInstance\s*\(/g, elsewhere: ["startTailnetSyncClients.refresh"] },
  // Address columns of a live row (backfill), and the boot :443-row repair.
  { what: "UPDATE crow_instances", re: /\bUPDATE\s+crow_instances\b/gi, elsewhere: ["backfillPeerAddress", "repairUndialablePeerRows"] },
  { what: ".replicate(", re: /\.\s*replicate\s*\(/g, elsewhere: [] },
];

function scanTailnet(file, pairBindingFile = PAIR_BINDING) {
  const src = stripComments(readFileSync(file, "utf8"));
  const { where, body } = functionSpans(src);
  const v = [];
  // The anchor is the FIRST decision call in source order (textual, not control
  // flow): an effect placed after it in the text passes even on a branch that
  // skips it. The runtime legs (tailnet-sync-pair-binding, the two-gateway gate)
  // cover the actual paths.
  const firstDecision = {};
  for (const [fn, re] of Object.entries(TAILNET_GUARDED)) {
    const b = body(fn);
    if (!b) { v.push(`no ${fn}`); continue; }
    re.lastIndex = 0;
    const m = re.exec(b.text);
    firstDecision[fn] = m ? b.start + m.index : Infinity;
    if (!m) v.push(`${fn} makes no pair-binding decision`);
  }
  for (const rule of TAILNET_EFFECTS) {
    for (const m of src.matchAll(rule.re)) {
      if (isDefinition(src, m.index)) continue;
      const w = where(m.index);
      if (w in TAILNET_GUARDED) {
        if (m.index < firstDecision[w]) v.push(`${rule.what} before the pair-binding decision in ${w}`);
      } else if (!rule.elsewhere.includes(w)) {
        v.push(`${rule.what} in ${w}`);
      }
    }
  }
  // The decision chain: the dialer's closure decides through decideTailnetBinding,
  // which runs decideAndRecordPairBinding, which runs decidePairBinding.
  const connect = body("PeerDialer.connect")?.text || "";
  if (!/const\s+bindOrRefuse\s*=\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\bdecideTailnetBinding\s*\(/.test(connect)) v.push("bindOrRefuse does not call decideTailnetBinding");
  if (!/\bdecideAndRecordPairBinding\s*\(/.test(body("decideTailnetBinding")?.text || "")) v.push("decideTailnetBinding does not call decideAndRecordPairBinding");
  const pb = stripComments(readFileSync(pairBindingFile, "utf8"));
  const pbFns = functionSpans(pb);
  if (!/\bdecidePairBinding\s*\(/.test(pbFns.body("decideAndRecordPairBinding")?.text || "")) v.push("decideAndRecordPairBinding does not call decidePairBinding");
  return v;
}

test("tailnet inventory: every handshake side effect follows the pair-binding decision in the same function", T, () => {
  assert.deepEqual(scanTailnet(TAILNET), []);
});

test("tailnet inventory positive control: each planted unguarded call in a temp copy fails the scan", T, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pt2a-scan-tn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = readFileSync(TAILNET, "utf8");
  const at = (anchor, line) => {
    const i = src.indexOf(anchor);
    assert.ok(i > 0, `anchor ${anchor}`);
    const j = src.indexOf("\n", i) + 1;
    return src.slice(0, j) + line + src.slice(j);
  };
  const plants = [
    ["markPeerCr( before the pair-binding decision in handleAcceptedConnection", at("    peerRow = rows[0];", "    await markPeerCr(ctx, remoteInstanceId);\n")],
    ["backfillPeerAddress( before the pair-binding decision in handleAcceptedConnection", at("    peerRow = rows[0];", "    await backfillPeerAddress(ctx, remoteInstanceId, null);\n")],
    ["markPending( before the pair-binding decision in handleAcceptedConnection", at("    peerRow = rows[0];", "    markPending();\n")],
    // Multiline: the call split across lines still matches.
    [".replicate( before the pair-binding decision in PeerDialer.connect", at("        // Pair binding: decided before the proof is sent", "        await instanceSyncManager\n          .replicate(remoteInstanceId, ws);\n")],
    ["initInstance( before the pair-binding decision in PeerDialer.connect", at("        // Pair binding: decided before the proof is sent", "        await instanceSyncManager.initInstance(remoteInstanceId, null);\n")],
    ["UPDATE crow_instances in armHeartbeat", at("function armHeartbeat(ws, ctx, peerId) {", "  ctx.db.execute(`UPDATE\n    crow_instances SET status = 'active'`);\n")],
    // Allowed only inside backfillPeerAddress; a direct call before the decision is caught.
    ["rememberPeerSyncPort( before the pair-binding decision in handleAcceptedConnection", at("    peerRow = rows[0];", "    await rememberPeerSyncPort(db, ctx.instanceSyncManager.localInstanceId, remoteInstanceId, 1);\n")],
    ["bindOrRefuse does not call decideTailnetBinding", src.replace("const d = await decideTailnetBinding(this.ctx, remoteInstanceId", "const d = await Promise.resolve({ ok: true }, this.ctx, remoteInstanceId")],
  ];
  const f = join(dir, "tailnet-sync.js");
  for (const [want, text] of plants) {
    assert.notEqual(text, src, `plant for ${want} changed the file`);
    writeFileSync(f, text);
    const v = scanTailnet(f);
    assert.ok(v.includes(want), `planted "${want}" is caught: ${JSON.stringify(v)}`);
  }
  writeFileSync(f, at("    peerRow = rows[0];", "    // await markPeerCr(ctx, remoteInstanceId); .replicate(x)\n"));
  assert.deepEqual(scanTailnet(f), [], "a plant inside a comment is not code");
});

// ---------------------------------------------------------------- Hyperswarm
const ADMISSION = ["PeerManager._admit", "PeerManager._completeAdmit", "PeerManager._sendDeferredReply", "PeerManager._dispatchAdmitted"];
const HS_CALLS = [
  { what: "onInstanceConnected(", re: /\.\s*onInstanceConnected\s*\(/g },
  { what: "onInstanceKeyReceived(", re: /\.\s*onInstanceKeyReceived\s*\(/g },
  { what: "getFeedKeyForInstance(", re: /\.\s*getFeedKeyForInstance\s*\(/g },
];
const ADMIT_SIDE_EFFECTS = [
  /\bmarkCbPinned\s*\(/g, /\bmarkInstanceCbPinned\s*\(/g, /\bstate\s*\.\s*authenticated\s*=\s*true/g, /type\s*:\s*"authenticated"/g,
  /\._sendDeferredReply\s*\(/g, /type\s*:\s*"instance-key"/g, /\._completeAdmit\s*\(/g, /\.\s*getFeedKeyForInstance\s*\(/g,
  /\.\s*onInstanceConnected\s*\(/g, /\.\s*onInstanceKeyReceived\s*\(/g, /\.\s*connections\s*\.\s*set\s*\(/g,
];

function scanHyperswarm(file) {
  const src = stripComments(readFileSync(file, "utf8"));
  const { where, body } = functionSpans(src);
  const v = [];
  const admit = body("PeerManager._admit");
  if (!admit) return ["no PeerManager._admit"];
  const idAt = admit.text.search(/state\s*\.\s*remoteInstanceId\s*=\s*remoteInstanceId\b/);
  const guardAt = admit.text.search(/await\s+guard\s*\(/);
  if (idAt < 0) v.push("_admit does not resolve the one instance id");
  if (guardAt < 0) v.push("_admit never calls its guard");
  if (idAt >= 0 && guardAt >= 0 && guardAt < idAt) v.push("_admit calls its guard before resolving the instance id");

  for (const rule of HS_CALLS) {
    for (const m of src.matchAll(rule.re)) {
      const w = where(m.index);
      if (!ADMISSION.includes(w)) v.push(`${rule.what} in ${w}`);
    }
  }
  // onInstanceKeyReceived: only the one resolved id.
  for (const m of src.matchAll(/\.\s*onInstanceKeyReceived\s*\(\s*([^,)]+?)\s*,/g)) {
    const arg = m[1].replace(/\s+/g, "");
    const w = where(m.index);
    if (arg === "state.remoteInstanceId") continue;
    v.push(`onInstanceKeyReceived(${arg}) in ${w}`);
  }
  // The two sibling frames: sent only inside _admit, after the id resolution.
  for (const [what, re, afterGuard] of [["pair-binding", /type\s*:\s*"pair-binding"/g, false], ["instance-key", /type\s*:\s*"instance-key"/g, true]]) {
    for (const m of src.matchAll(re)) {
      const w = where(m.index);
      if (w !== "PeerManager._admit") { v.push(`"${what}" send in ${w}`); continue; }
      const rel = m.index - admit.start;
      if (idAt < 0 || rel < idAt) v.push(`"${what}" send before the id resolution in _admit`);
      if (afterGuard && (guardAt < 0 || rel < guardAt)) v.push(`"${what}" send before the guard in _admit`);
    }
  }
  // _admit: the guard runs before its first side effect.
  for (const re of ADMIT_SIDE_EFFECTS) {
    for (const m of admit.text.matchAll(re)) {
      if (guardAt >= 0 && m.index < guardAt) v.push(`side effect ${m[0].replace(/\s+/g, " ")} before the guard in _admit`);
    }
  }
  return v;
}

test("Hyperswarm inventory: sibling admission effects only in the admission chain, one id, guard first", T, () => {
  assert.deepEqual(scanHyperswarm(PEER_MANAGER), []);
});

test("Hyperswarm inventory positive control: each planted call in a temp copy fails the scan", T, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pt2a-scan-hs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = readFileSync(PEER_MANAGER, "utf8");
  const at = (anchor, line) => {
    const i = src.indexOf(anchor);
    assert.ok(i > 0, `anchor ${anchor}`);
    const j = src.indexOf("\n", i) + 1;
    return src.slice(0, j) + line + src.slice(j);
  };
  const plants = [
    ["onInstanceConnected( in PeerManager._handleConnection", at("  _handleConnection(conn, info) {", "    this\n      .onInstanceConnected(\"x\", conn, null);\n")],
    ["getFeedKeyForInstance( in PeerManager._onChallenge", at("  async _onChallenge(conn, msg, state) {", "    await this.getFeedKeyForInstance(msg.instance_id);\n")],
    ["onInstanceKeyReceived(msg.instance_id) in PeerManager._completeAdmit", at("    const crowId = state.remoteCrowId;", "    this.onInstanceKeyReceived(msg.instance_id, msg.feed_key_hex);\n")],
    ["onInstanceKeyReceived(msg.instance_id) in PeerManager._dispatchAdmitted", at("  async _dispatchAdmitted(conn, msg, state) {", "    if (msg.instance_id === state.remoteInstanceId) this.onInstanceKeyReceived(msg.instance_id, msg.feed_key_hex);\n")],
    ["\"instance-key\" send before the id resolution in _admit", at("  async _admit(conn, state, msg, kind) {", "    conn.write(JSON.stringify({ type: \"instance-key\", instance_id: this.localInstanceId }) + \"\\n\");\n")],
    ["\"pair-binding\" send in PeerManager._onChallenge", at("  async _onChallenge(conn, msg, state) {", "    conn.write(JSON.stringify({ type: \"pair-binding\", pb_mac: null }) + \"\\n\");\n")],
    ["side effect state.authenticated = true before the guard in _admit", at("    const guard = this.admitGuards?.[kind];", "    state.authenticated = true;\n")],
  ];
  const f = join(dir, "peer-manager.js");
  for (const [want, text] of plants) {
    writeFileSync(f, text);
    const v = scanHyperswarm(f);
    assert.ok(v.includes(want), `planted ${want} is caught: ${JSON.stringify(v)}`);
  }
  writeFileSync(f, at("  _handleConnection(conn, info) {", "    // this.onInstanceConnected(x); conn.write({ type: \"instance-key\" })\n"));
  assert.deepEqual(scanHyperswarm(f), [], "a plant inside a comment is not code");
});
