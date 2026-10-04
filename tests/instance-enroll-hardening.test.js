/**
 * /instance/enroll-request hardening (backlog ENROLL-OTC-OPTIONAL, 2026-10-04).
 *
 * Executable, two-instance, mutual-case gates (the Item 2a lesson): the REAL
 * route on a real HTTP server with a real init-db DB (instance P), and the
 * REAL `crow instance pair` CLI run as a subprocess against its own DB and
 * peer-tokens.json (instance S). After every successful pairing both sides'
 * stores are cross-checked (S's bearer verifies on P via validateInstanceToken
 * and vice versa, shared signing key equal) so a dead harness cannot pass
 * vacuously; every refusal is paired with a positive control on the same
 * state and asserts that NOTHING was written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import express from "express";
import { makeRealDb } from "./fixtures/sync-fleet.mjs";
import { instanceEnrollRouter, enrollSourceAllowed, acceptableAdvertisedUrl, ENROLL_FAIL_PER_SOURCE, ENROLL_FAIL_GLOBAL } from "../servers/gateway/routes/instance-enroll.js";
import { isAllowedNetwork, isAllowedEnrollNetwork } from "../servers/gateway/dashboard/auth.js";
import proxyaddr from "proxy-addr";
import { rejectFunneledMiddleware } from "../servers/gateway/funnel.js";
import { validateInstanceToken } from "../servers/gateway/instance-registry.js";
import { repairProof, repairProofKey, writeRepairAllowance, generateEnrollOtc } from "../servers/shared/enroll-guard.js";

const REPO = new URL("..", import.meta.url).pathname;
const sha = (s) => createHash("sha256").update(s).digest("hex");

function snapshotEnv() {
  const saved = { ...process.env };
  return () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  };
}

async function makeSide(id, ip) {
  const dir = mkdtempSync(join(tmpdir(), `enroll-${id}-`));
  writeFileSync(join(dir, "instance-id"), `${id}\n`);
  const db = await makeRealDb(dir);
  await db.execute({
    sql: "INSERT INTO crow_instances (id, name, crow_id, gateway_url, tailscale_ip, status) VALUES (?, ?, ?, ?, ?, 'active')",
    args: [id, id, id, `http://${ip}:3001`, ip],
  });
  return {
    id, ip, dir, db,
    tokensPath: join(dir, "peer-tokens.json"),
    env: {
      CROW_HOME: dir,
      CROW_DATA_DIR: dir,
      CROW_DB_PATH: join(dir, "crow.db"),
      CROW_PEER_TOKENS_PATH: join(dir, "peer-tokens.json"),
      CROW_INSTANCES_JSON_PATH: join(dir, "instances.json"),
      CROW_PEER_GATEWAY_URL: `http://${ip}:3001`,
      PORT: "3001",
    },
    tokens() { return existsSync(this.tokensPath) ? JSON.parse(readFileSync(this.tokensPath, "utf8")) : {}; },
    async row(peer) {
      return (await db.execute({ sql: "SELECT * FROM crow_instances WHERE id = ?", args: [peer] })).rows[0] || null;
    },
    async override(key) {
      return (await db.execute({ sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?", args: [key, id] })).rows[0]?.value ?? null;
    },
    cleanup() { try { db.close?.(); } catch {} rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Run P's REAL route as its own "process" env (P is the in-process side). */
async function startPeer(P, { otc, now, db = P.db } = {}) {
  Object.assign(process.env, P.env, { CROW_ENROLL_ENABLED: "1" });
  if (otc === undefined) delete process.env.CROW_ENROLL_OTC; else process.env.CROW_ENROLL_OTC = otc;
  delete process.env.CROW_DASHBOARD_PUBLIC;
  const app = express();
  app.use(rejectFunneledMiddleware());
  app.use(instanceEnrollRouter(db, { execFileSyncImpl: () => { throw new Error("no tailscale in tests"); }, ...(now ? { now } : {}) }));
  app.set("trust proxy", 1); // as servers/gateway/index.js
  const srv = createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  // A Tailscale-Serve-like front: proxies over loopback and REPLACES
  // X-Forwarded-For with the client's (here: a fixed tailnet) address. The
  // real CLI dials this, as it dials a peer's Serve URL in production.
  const serve = createServer((inReq, inRes) => {
    const headers = { ...inReq.headers, "x-forwarded-for": serveClientIp };
    const out = request({ host: "127.0.0.1", port: srv.address().port, path: inReq.url, method: inReq.method, headers }, (r) => {
      inRes.writeHead(r.statusCode, r.headers);
      r.pipe(inRes);
    });
    out.on("error", () => { inRes.statusCode = 502; inRes.end(); });
    inReq.pipe(out);
  });
  await new Promise((r) => serve.listen(0, "127.0.0.1", r));
  const closeOne = (x) => new Promise((r) => { x.close(r); x.closeAllConnections(); });
  return {
    srv, port: srv.address().port, url: `http://127.0.0.1:${serve.address().port}`,
    close: async () => { await closeOne(serve); await closeOne(srv); },
  };
}
const serveClientIp = "100.64.0.2";

function post(port, body, { localAddress = "127.0.0.1", xff = "100.64.200.1", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, path: "/instance/enroll-request", method: "POST", localAddress,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...(xff ? { "X-Forwarded-For": xff } : {}), ...headers },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => { let j = null; try { j = JSON.parse(buf); } catch { j = buf; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on("error", reject);
    req.end(data);
  });
}

/** The REAL CLI, as instance S (its own DB + peer-tokens.json). */
function cli(S, args) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...S.env };
    delete env.CROW_ENROLL_OTC;
    execFile(process.execPath, ["scripts/cli/instance-pair.js", ...args], { cwd: REPO, env, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

/** Mutual-case check: both directions authenticate, one shared signing key. */
async function assertMutuallyPaired(P, S) {
  const sTok = S.tokens()[P.id];
  const pTok = P.tokens()[S.id];
  assert.ok(sTok?.auth_token && pTok?.auth_token, "both sides hold creds for the other");
  assert.equal(sTok.signing_key, pTok.signing_key, "one shared signing key");
  const onP = await validateInstanceToken(P.db, sTok.auth_token);
  const onS = await validateInstanceToken(S.db, pTok.auth_token);
  assert.equal(onP?.id, S.id, "S's outbound bearer authenticates S on P");
  assert.equal(onS?.id, P.id, "P's outbound bearer authenticates P on S");
  assert.equal(Number(onP.trusted), 1);
  assert.equal(Number(onS.trusted), 1);
  assert.equal(await validateInstanceToken(P.db, pTok.auth_token), null, "directions are not interchangeable");
}

const baseBody = (id, extra = {}) => ({
  source_instance_id: id, source_name: id,
  source_gateway_url: "http://100.64.9.9:3001", source_tailscale_ip: "100.64.9.9", source_sync_port: 3001,
  source_outbound_bearer: "b".repeat(64), shared_signing_key: "k".repeat(64), ...extra,
});

test("two-instance pairing through the real CLI: OTC mandatory, single-use, re-pair by proof, lost creds need the peer operator's allowance — mutual creds verified after every step", async () => {
  const restore = snapshotEnv();
  const P = await makeSide("instP", "100.64.0.1");
  const S = await makeSide("instS", "100.64.0.2");
  try {
    const otc1 = generateEnrollOtc();
    const peer = await startPeer(P, { otc: otc1 });
    try {
      // The CLI refuses locally without a code (no request is made).
      const noCode = await cli(S, ["--peer-url", peer.url]);
      assert.notEqual(noCode.code, 0);
      assert.match(noCode.out, /one-time code is required/);
      assert.equal(await P.row(S.id), null);

      // Happy path.
      const ok = await cli(S, ["--peer-url", peer.url, "--otc", otc1]);
      assert.equal(ok.code, 0, ok.out);
      await assertMutuallyPaired(P, S);
      const firstHash = (await P.row(S.id)).auth_token_hash;

      // Single use: the same code again is refused and changes nothing.
      const again = await cli(S, ["--peer-url", peer.url, "--otc", otc1]);
      assert.notEqual(again.code, 0);
      assert.match(again.out, /otc_used/);
      assert.equal((await P.row(S.id)).auth_token_hash, firstHash);
      await assertMutuallyPaired(P, S);

      // Re-pair with a fresh code: S still holds its creds → the CLI's proof is accepted.
      const otc2 = generateEnrollOtc();
      process.env.CROW_ENROLL_OTC = otc2;
      // Typed URL (the local Serve stand-in) differs from the stored address,
      // so the peer is named explicitly; the proof is made only for it.
      const repair = await cli(S, ["--peer-url", peer.url, "--otc", otc2, "--peer-id", P.id]);
      assert.equal(repair.code, 0, repair.out);
      assert.notEqual((await P.row(S.id)).auth_token_hash, firstHash, "credentials rotated");
      await assertMutuallyPaired(P, S);

      // S loses its credentials → its re-pair is refused (409) and nothing on P changes.
      const beforeLoss = { hash: (await P.row(S.id)).auth_token_hash, key: P.tokens()[S.id].signing_key };
      unlinkSync(S.tokensPath);
      const otc3 = generateEnrollOtc();
      process.env.CROW_ENROLL_OTC = otc3;
      const refused = await cli(S, ["--peer-url", peer.url, "--otc", otc3, "--peer-id", P.id]);
      assert.notEqual(refused.code, 0);
      assert.match(refused.out, /409/);
      assert.match(refused.out, /already_paired/);
      assert.equal((await P.row(S.id)).auth_token_hash, beforeLoss.hash);
      assert.equal(P.tokens()[S.id].signing_key, beforeLoss.key);

      // P's operator allows it (the REAL CLI, as P) → the same code now works, once.
      const allow = await cli(P, ["--allow-re-pair", S.id, "--minutes", "5"]);
      assert.equal(allow.code, 0, allow.out);
      assert.ok(await P.override(`enroll_repair_allow:${S.id}`));
      const allowed = await cli(S, ["--peer-url", peer.url, "--otc", otc3, "--peer-id", P.id]);
      assert.equal(allowed.code, 0, allowed.out);
      await assertMutuallyPaired(P, S);
      assert.equal(await P.override(`enroll_repair_allow:${S.id}`), null, "allowance is single-use");
    } finally {
      await peer.close();
    }
  } finally {
    restore();
    P.cleanup();
    S.cleanup();
  }
});

test("no / short OTC configured on the peer: every enroll is refused and nothing is written", async () => {
  const restore = snapshotEnv();
  const P = await makeSide("instP", "100.64.0.1");
  try {
    for (const otc of [undefined, "", "short-code-15ch"]) {
      const peer = await startPeer(P, { otc });
      try {
        const r = await post(peer.port, baseBody("peerX", { otc: otc || "whatever-whatever" }));
        assert.equal(r.status, 403, `otc=${JSON.stringify(otc)}`);
        assert.equal(r.body.error, "otc_required");
        assert.match(r.body.hint, /--generate-otc/);
      } finally { await peer.close(); }
    }
    assert.equal(await P.row("peerX"), null);
    // Control: a valid code on the same DB works.
    const code = generateEnrollOtc();
    const peer = await startPeer(P, { otc: code });
    try {
      const missing = await post(peer.port, baseBody("peerX"));
      assert.equal(missing.status, 401, "a request without a code is refused");
      assert.equal((await post(peer.port, baseBody("peerX", { otc: code }))).status, 200);
    } finally { await peer.close(); }
    assert.ok(await P.row("peerX"));
  } finally { restore(); P.cleanup(); }
});

test("wrong OTCs are rate-limited per source and globally; a missing code costs nothing", async () => {
  const restore = snapshotEnv();
  const P = await makeSide("instP", "100.64.0.1");
  try {
    const code = generateEnrollOtc();
    const peer = await startPeer(P, { otc: code });
    try {
      // Missing codes do not burn the budget.
      for (let i = 0; i < ENROLL_FAIL_PER_SOURCE + 2; i++) assert.equal((await post(peer.port, baseBody("x1"), { xff: "100.64.1.2" })).status, 401);
      for (let i = 0; i < ENROLL_FAIL_PER_SOURCE; i++) {
        const r = await post(peer.port, baseBody("x1", { otc: `wrong-${i}-xxxxxxxxxxxxxxxxx` }), { xff: "100.64.1.2" });
        assert.equal(r.status, 401);
        assert.equal(r.body.error, "otc_mismatch");
      }
      // Locked: even the right code from that source is refused.
      const locked = await post(peer.port, baseBody("x1", { otc: code }), { xff: "100.64.1.2" });
      assert.equal(locked.status, 429);
      assert.equal(await P.row("x1"), null);
      // Another source is unaffected (positive control) …
      assert.equal((await post(peer.port, baseBody("x2", { otc: code }), { xff: "100.64.1.3" })).status, 200);
      // … until the global budget is spent.
      const perSource = ENROLL_FAIL_PER_SOURCE;
      let spent = perSource;
      for (let s = 4; spent < ENROLL_FAIL_GLOBAL; s++) {
        for (let i = 0; i < perSource && spent < ENROLL_FAIL_GLOBAL; i++, spent++) {
          await post(peer.port, baseBody("x3", { otc: `wrong-${s}-${i}-xxxxxxxxxxxxxx` }), { xff: `100.64.1.${s}` });
        }
      }
      const global = await post(peer.port, baseBody("x4", { otc: code }), { xff: "100.64.1.99" });
      assert.equal(global.status, 429);
      assert.equal(await P.row("x4"), null);
    } finally { await peer.close(); }
  } finally { restore(); P.cleanup(); }
});

test("OTC single-use survives a gateway restart; a replayed captured body is refused; concurrent enrolls: exactly one wins", async () => {
  const restore = snapshotEnv();
  const P = await makeSide("instP", "100.64.0.1");
  try {
    const code = generateEnrollOtc();
    const captured = baseBody("peerA", { otc: code });
    let peer = await startPeer(P, { otc: code });
    let hash;
    try {
      assert.equal((await post(peer.port, captured)).status, 200);
      hash = (await P.row("peerA")).auth_token_hash;
      assert.equal((await post(peer.port, captured)).body.error, "otc_used");
    } finally { await peer.close(); }
    peer = await startPeer(P, { otc: code }); // "restart" with the same env
    try {
      const r = await post(peer.port, baseBody("peerB", { otc: code }));
      assert.equal(r.status, 403);
      assert.equal(r.body.error, "otc_used");
      assert.equal(await P.row("peerB"), null);
    } finally { await peer.close(); }

    // A new code does not make the captured body useful: peerA is now trusted.
    // (Every DB call yields to the event loop here, so the two racing
    // requests below genuinely interleave.)
    const code2 = generateEnrollOtc();
    const slow = () => new Promise((r) => setTimeout(r, 5));
    const slowDb = {
      execute: async (q) => { await slow(); return P.db.execute(q); },
      batch: async (qs) => { await slow(); return P.db.batch(qs); },
    };
    peer = await startPeer(P, { otc: code2, db: slowDb });
    try {
      const replay = await post(peer.port, { ...captured, source_outbound_bearer: "e".repeat(64), otc: code2 });
      assert.equal(replay.status, 409);
      assert.equal((await P.row("peerA")).auth_token_hash, hash);

      // Race: two different new ids at once with the same valid code.
      const [r1, r2] = await Promise.all([
        post(peer.port, baseBody("raceOne", { otc: code2 })),
        post(peer.port, baseBody("raceTwo", { otc: code2 })),
      ]);
      const statuses = [r1.status, r2.status].sort();
      assert.equal(statuses.filter((s) => s === 200).length, 1, `exactly one wins: ${JSON.stringify([r1.body, r2.body])}`);
      const rows = [await P.row("raceOne"), await P.row("raceTwo")].filter(Boolean);
      assert.equal(rows.length, 1);
    } finally { await peer.close(); }

    // Two gateway PROCESSES sharing one DB (each its own mutex and its own DB
    // connection): the plain-INSERT claim lets exactly one through.
    const code3 = generateEnrollOtc();
    const { createDbClient } = await import("../servers/db.js");
    const db2 = createDbClient(join(P.dir, "crow.db"));
    const slowDb2 = {
      execute: async (q) => { await slow(); return db2.execute(q); },
      batch: async (qs) => { await slow(); return db2.batch(qs); },
    };
    const g1 = await startPeer(P, { otc: code3, db: slowDb });
    const g2 = await startPeer(P, { otc: code3, db: slowDb2 });
    try {
      const [x1, x2] = await Promise.all([
        post(g1.port, baseBody("procOne", { otc: code3 })),
        post(g2.port, baseBody("procTwo", { otc: code3 })),
      ]);
      assert.equal([x1.status, x2.status].filter((st) => st === 200).length, 1, `one code, two processes: ${JSON.stringify([x1.body, x2.body])}`);
      assert.equal([await P.row("procOne"), await P.row("procTwo")].filter(Boolean).length, 1);
    } finally { await g1.close(); await g2.close(); db2.close?.(); }
  } finally { restore(); P.cleanup(); }
});

test("existing TRUSTED row: no proof → 409 and nothing (creds, dial address, port, CR pin) changes; tampered/wrong proofs refused; a valid proof re-pairs", async () => {
  const restore = snapshotEnv();
  const P = await makeSide("instP", "100.64.0.1");
  try {
    const B0 = "c".repeat(64);
    await P.db.execute({
      sql: "INSERT INTO crow_instances (id, name, crow_id, gateway_url, tailscale_ip, auth_token_hash, status, trusted) VALUES ('peerX', 'X', 'peerX', 'http://100.64.5.5:3001', '100.64.5.5', ?, 'active', 1)",
      args: [sha(B0)],
    });
    for (const [k, v] of [["tailnet_sync_port:peerX", "3001"], ["tailnet_sync_cr:peerX", "1"]]) {
      await P.db.execute({ sql: "INSERT INTO dashboard_settings_overrides (key, instance_id, value) VALUES (?, 'instP', ?)", args: [k, v] });
    }
    Object.assign(process.env, P.env);
    const { setPeerCreds } = await import("../servers/shared/peer-credentials.js");
    setPeerCreds("peerX", { auth_token: "t".repeat(64), signing_key: "s".repeat(64) });
    const snapshot = async () => ({
      row: { ...(await P.row("peerX")) }, tokens: P.tokens().peerX,
      port: await P.override("tailnet_sync_port:peerX"), cr: await P.override("tailnet_sync_cr:peerX"),
    });
    const before = await snapshot();

    const code = generateEnrollOtc();
    const peer = await startPeer(P, { otc: code });
    let legit, proof;
    try {
      const hijack = baseBody("peerX", { otc: code, source_gateway_url: "http://100.64.66.66:3001", source_tailscale_ip: "100.64.66.66", source_sync_port: 4444 });
      const r = await post(peer.port, hijack);
      assert.equal(r.status, 409);
      assert.equal(r.body.error, "already_paired");
      assert.match(r.body.hint, /--allow-re-pair peerX/);
      assert.deepEqual(await snapshot(), before, "a refused enroll writes nothing");

      // Proof made with the wrong bearer, or lifted onto a different body.
      const K = repairProofKey(sha(B0), "s".repeat(64));
      const D = sha(code);
      const bind = { targetId: "instP", otcDigest: D };
      assert.equal((await post(peer.port, { ...hijack, repair_proofs: [repairProof(repairProofKey(sha("z".repeat(64)), "s".repeat(64)), hijack, bind)] })).status, 409, "wrong bearer");
      assert.equal((await post(peer.port, { ...hijack, repair_proofs: [repairProof(repairProofKey(sha(B0), "w".repeat(64)), hijack, bind)] })).status, 409, "the stored hash alone (no signing key) cannot forge a proof");
      legit = baseBody("peerX", { otc: code, source_gateway_url: "http://100.64.5.6:3001", source_tailscale_ip: "100.64.5.6", source_sync_port: 3002 });
      proof = repairProof(K, legit, bind);
      assert.equal((await post(peer.port, { ...legit, source_gateway_url: "http://100.64.66.66:3001", repair_proofs: [proof] })).status, 409, "proof is bound to the dial address");
      assert.equal((await post(peer.port, { ...legit, shared_signing_key: "q".repeat(64), repair_proofs: [proof] })).status, 409, "proof is bound to the new key");
      assert.equal((await post(peer.port, { ...legit, repair_proofs: [repairProof(K, legit, { targetId: "instC", otcDigest: D })] })).status, 409, "a proof made for ANOTHER peer is refused here");
      assert.equal((await post(peer.port, { ...legit, repair_proofs: [repairProof(K, legit, { targetId: "instP", otcDigest: sha("another-code-xxxxxxxxxxxx") })] })).status, 409, "a proof bound to a different one-time code is refused");
      assert.deepEqual(await snapshot(), before);

      // Positive control: the valid proof (OTC was not consumed by the refusals).
      // A leftover allowance for the id is spent by this enroll too.
      await writeRepairAllowance(P.db, "instP", "peerX", { minutes: 5 });
      const ok = await post(peer.port, { ...legit, repair_proofs: ["0".repeat(64), proof] });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(await P.override("enroll_repair_allow:peerX"), null, "allowance cleared by any successful enroll of the id");
      const after = await snapshot();
      assert.equal(after.row.auth_token_hash, sha(legit.source_outbound_bearer));
      assert.equal(after.row.gateway_url, "http://100.64.5.6:3001");
      assert.equal(after.row.tailscale_ip, "100.64.5.6");
      assert.equal(after.port, "3002");
      assert.equal(after.tokens.signing_key, legit.shared_signing_key);
      assert.equal(after.cr, "1", "the challenge-response pin is never touched by an enroll");
      // Replay of the accepted body + proof: the code is spent …
      const replay = await post(peer.port, { ...legit, repair_proofs: [proof] });
      assert.equal(replay.status, 403);
      assert.equal(replay.body.error, "otc_used");
    } finally { await peer.close(); }
    // … and under a NEW code the old proof is dead (bound to the old code; the
    // stored hash it was keyed by has rotated).
    const code2 = generateEnrollOtc();
    const peer2 = await startPeer(P, { otc: code2 });
    try {
      const rotated = { ...(await P.row("peerX")) };
      const r = await post(peer2.port, { ...legit, otc: code2, repair_proofs: [proof] });
      assert.equal(r.status, 409);
      assert.deepEqual({ ...(await P.row("peerX")) }, rotated);
    } finally { await peer2.close(); }
  } finally { restore(); P.cleanup(); }
});

test("revoked row and credential-only ids need the operator allowance; expired allowances do not count", async () => {
  const restore = snapshotEnv();
  const P = await makeSide("instP", "100.64.0.1");
  try {
    await P.db.execute("INSERT INTO crow_instances (id, name, crow_id, gateway_url, status, trusted, auth_token_hash) VALUES ('gone', 'gone', 'gone', 'http://100.64.7.7:3001', 'revoked', 0, NULL)");
    let code = generateEnrollOtc();
    let peer = await startPeer(P, { otc: code });
    try {
      assert.equal((await post(peer.port, baseBody("gone", { otc: code }))).status, 409);
      await writeRepairAllowance(P.db, "instP", "gone", { minutes: 5, now: Date.now() - 10 * 60_000 }); // expired
      assert.equal((await post(peer.port, baseBody("gone", { otc: code }))).status, 409);
      assert.equal((await P.row("gone")).status, "revoked");
      await writeRepairAllowance(P.db, "instP", "gone", { minutes: 5 });
      assert.equal((await post(peer.port, baseBody("gone", { otc: code }))).status, 200);
      const row = await P.row("gone");
      assert.equal(row.status, "active");
      assert.equal(Number(row.trusted), 1);
    } finally { await peer.close(); }

    // An id with creds in peer-tokens.json but no row.
    const { setPeerCreds } = await import("../servers/shared/peer-credentials.js");
    setPeerCreds("ghost", { auth_token: "t".repeat(64), signing_key: "s".repeat(64) });
    code = generateEnrollOtc();
    peer = await startPeer(P, { otc: code });
    try {
      assert.equal((await post(peer.port, baseBody("ghost", { otc: code }))).status, 409);
      assert.equal(P.tokens().ghost.signing_key, "s".repeat(64));
    } finally { await peer.close(); }
  } finally { restore(); P.cleanup(); }
});

test("a known-but-uncredentialed row (operator-registered) enrolls without an allowance but keeps its operator-given address; own id refused; public dial addresses dropped", async () => {
  const restore = snapshotEnv();
  const P = await makeSide("instP", "100.64.0.1");
  try {
    await P.db.execute("INSERT INTO crow_instances (id, name, crow_id, gateway_url, status, trusted) VALUES ('bare', 'bare', 'bare', 'http://100.64.8.8:3001', 'active', 0)");
    const code = generateEnrollOtc();
    const peer = await startPeer(P, { otc: code });
    try {
      assert.equal((await post(peer.port, baseBody("instP", { otc: code }))).status, 400, "own id");
      const r = await post(peer.port, baseBody("bare", { otc: code, source_gateway_url: "http://100.64.66.66:3001" }));
      assert.equal(r.status, 200);
      const row = await P.row("bare");
      assert.equal(row.gateway_url, "http://100.64.8.8:3001");
      assert.equal(Number(row.trusted), 1);
    } finally { await peer.close(); }
    const code2 = generateEnrollOtc();
    const peer2 = await startPeer(P, { otc: code2 });
    try {
      const pub = await post(peer2.port, baseBody("pub", { otc: code2, source_gateway_url: "https://evil.example.com:8444", source_tailscale_ip: "8.8.8.8" }));
      assert.equal(pub.status, 400, "public URL and no tailnet IP: refused, nothing stored");
      assert.equal(pub.body.error, "gateway_url_unacceptable");
      assert.equal(await P.row("pub"), null);
      const pub2 = await post(peer2.port, baseBody("pub", { otc: code2, source_gateway_url: "https://evil.example.com:8444", source_tailscale_ip: "100.64.4.4", source_sync_port: 3001 }));
      assert.equal(pub2.status, 200, "control: same code still valid (the refusal spent nothing)");
      assert.equal((await P.row("pub")).gateway_url, "http://100.64.4.4:3001", "public URL never stored; the verified tailnet address is");
    } finally { await peer2.close(); }
    assert.equal(acceptableAdvertisedUrl("https://crow.example.ts.net:8444", { ownTailnet: "example.ts.net" }), "https://crow.example.ts.net:8444");
    assert.equal(acceptableAdvertisedUrl("https://x.tail12345.ts.net:8444", { ownTailnet: "example.ts.net" }), null, "another tailnet's (possibly Funnel) host refused");
    assert.equal(acceptableAdvertisedUrl("https://crow.example.ts.net:8444"), null, "MagicDNS names need our own tailnet known");
    assert.equal(acceptableAdvertisedUrl("https://evil.ts.net.attacker.com:8444", { ownTailnet: "example.ts.net" }), null);
    assert.equal(acceptableAdvertisedUrl("http://user:pw@100.64.1.1:3001"), null, "userinfo refused");
    assert.equal(acceptableAdvertisedUrl("http://172.17.0.2:3001"), null, "docker bridge range refused");
    assert.equal(acceptableAdvertisedUrl("http://10.0.0.5:3001"), "http://10.0.0.5:3001");
    assert.equal(acceptableAdvertisedUrl("http://127.0.0.1:3001"), null);
    assert.equal(acceptableAdvertisedUrl("http://203.0.113.4:3001"), null);
  } finally { restore(); P.cleanup(); }
});

test("time box: an OTC expires CROW_ENROLL_WINDOW_MINUTES after the gateway first saw it", async () => {
  const restore = snapshotEnv();
  const P = await makeSide("instP", "100.64.0.1");
  try {
    let clock = Date.now();
    const code = generateEnrollOtc();
    const peer = await startPeer(P, { otc: code, now: () => clock });
    try {
      await new Promise((r) => setTimeout(r, 50)); // boot-time first-seen write
      clock += 31 * 60_000;
      const r = await post(peer.port, baseBody("late", { otc: code }));
      assert.equal(r.status, 403);
      assert.equal(r.body.error, "enroll_window_expired");
      assert.equal(await P.row("late"), null);
      process.env.CROW_ENROLL_WINDOW_MINUTES = "60";
      assert.equal((await post(peer.port, baseBody("late", { otc: code }))).status, 200, "control: inside a longer window");
    } finally { await peer.close(); }
  } finally { restore(); P.cleanup(); }
});

test("source restriction: never over Funnel (even with CROW_DASHBOARD_PUBLIC), never by header presence alone; a loopback proxy must name a private/tailnet client; X-Forwarded-For only from a loopback proxy", async () => {
  const restore = snapshotEnv();
  const P = await makeSide("instP", "100.64.0.1");
  try {
    const code = generateEnrollOtc();
    const peer = await startPeer(P, { otc: code });
    try {
      const viaFunnel = await post(peer.port, baseBody("f1", { otc: code }), { headers: { "Tailscale-Funnel-Request": "?1" } });
      assert.equal(viaFunnel.status, 403, "the funnel middleware refuses it");
      process.env.CROW_DASHBOARD_PUBLIC = "true";
      const viaFunnelPublic = await post(peer.port, baseBody("f1", { otc: code }), { headers: { "Tailscale-Funnel-Request": "?1", "Tailscale-User-Login": "x@example.com" } });
      assert.equal(viaFunnelPublic.status, 403);
      assert.equal(viaFunnelPublic.body.error, "enroll_source_refused", "the route refuses it itself, whatever else it carries");
      const publicHop = await post(peer.port, baseBody("f1", { otc: code }), { xff: "203.0.113.9" });
      assert.equal(publicHop.body.error, "enroll_source_refused", "loopback + public client (a public reverse proxy) refused");
      const spoofed = await post(peer.port, baseBody("f1", { otc: code }), { xff: "100.64.3.3, 203.0.113.9" });
      assert.equal(spoofed.body.error, "enroll_source_refused", "spoofed tailnet leftmost hop, public rightmost: refused");
      const loginOnly = await post(peer.port, baseBody("f1", { otc: code }), { xff: null, headers: { "Tailscale-User-Login": "x@example.com" } });
      assert.equal(loginOnly.body.error, "enroll_source_refused", "Tailscale-User-Login presence alone is never trusted");
      const bare = await post(peer.port, baseBody("f1", { otc: code }), { xff: null });
      assert.equal(bare.body.error, "enroll_source_refused", "bare loopback (no client named) refused");
      assert.equal(await P.row("f1"), null);
      const frontDoor = await post(peer.port, baseBody("f1", { otc: code }), { xff: "100.64.20.4", headers: { "X-Forwarded-Host": "app.example.com" } });
      assert.equal(frontDoor.body.error, "enroll_source_refused", "public front door chained into Serve (XFF replaced with its tailnet IP) refused by the public host it carries");
      const frontDoorHost = await post(peer.port, baseBody("f1", { otc: code }), { xff: "100.64.20.4", headers: { Host: "app.example.com" } });
      assert.equal(frontDoorHost.body.error, "enroll_source_refused", "…or by its Host");
      const junkHost = await post(peer.port, baseBody("f1", { otc: code }), { xff: "100.64.3.3", headers: { "X-Forwarded-Host": "evil.com#.ts.net" } });
      assert.equal(junkHost.body.error, "enroll_source_refused", "non-hostname characters refused");
      assert.equal(await P.row("f1"), null);
      const ok = await post(peer.port, baseBody("f1", { otc: code }), { xff: "100.64.3.3", headers: { "X-Forwarded-Host": "crow.example.ts.net:8444" } });
      assert.equal(ok.status, 200, "control: loopback proxy naming a tailnet client and a ts.net host, even with CROW_DASHBOARD_PUBLIC");
    } finally { await peer.close(); }
  } finally { restore(); P.cleanup(); }
});

test("no differential: the enroll gate never allows what the dashboard gate refuses, and agrees with it on the plain cases", () => {
  const restore = snapshotEnv();
  delete process.env.CROW_DASHBOARD_PUBLIC;
  delete process.env.CROW_ALLOWED_IPS;
  try {
    // [socket, headers, enroll expected, dashboard expected]
    const cases = [
      ["127.0.0.1", {}, false, false],
      ["::ffff:127.0.0.1", {}, false, false],
      ["127.0.0.1", { "x-forwarded-for": "100.64.0.9" }, true, true],
      ["127.0.0.1", { "x-forwarded-for": "10.0.0.9" }, true, true],
      ["127.0.0.1", { "x-forwarded-for": "203.0.113.9" }, false, false],
      ["127.0.0.1", { "x-forwarded-for": "100.64.0.9, 203.0.113.9" }, false, false],
      ["127.0.0.1", { "x-forwarded-for": "127.0.0.1" }, false, false],
      ["127.0.0.1", { "tailscale-funnel-request": "?1", "x-forwarded-for": "100.64.0.9" }, false, false],
      ["127.0.0.1", { "tailscale-user-login": "a@b" }, false, true],
      ["127.0.0.1", { "x-forwarded-for": "203.0.113.9, 100.64.0.9" }, false, true],
      ["100.64.0.9", {}, true, true],
      ["10.0.0.9", {}, true, true],
      ["192.168.1.9", {}, true, true],
      ["203.0.113.9", {}, false, false],
      ["203.0.113.9", { "x-forwarded-for": "100.64.0.9" }, false, true],
      ["100.64.0.9", { "x-forwarded-for": "203.0.113.9" }, false, false],
      ["100.64.0.9", { "tailscale-funnel-request": "?1" }, false, false],
      ["fd7a:115c:a1e0::9", {}, false, false],
      ["127.0.0.1", { "x-forwarded-for": "100.64.0.9", host: null }, false, true],
      ["127.0.0.1", { "x-forwarded-for": "100.64.0.9", host: "app.example.com" }, false, true],
    ];
    for (const [sock, headers, wantEnroll, wantDash] of cases) {
      // Every real HTTP/1.1 request carries Host; default it to a tailnet name.
      const h = { host: "crow.example.ts.net:8444", ...headers };
      if (h.host === null) delete h.host;
      const req = { socket: { remoteAddress: sock }, connection: { remoteAddress: sock }, headers: h };
      req.ip = proxyaddr(req, (_addr, i) => i < 1); // express `trust proxy` = 1
      const e = isAllowedEnrollNetwork(req);
      const d = isAllowedNetwork(req);
      const label = `${sock} ${JSON.stringify(headers)}`;
      assert.equal(e, wantEnroll, `enroll ${label}`);
      assert.equal(d, wantDash, `dashboard ${label}`);
      assert.ok(!e || d, `enroll must never allow what the dashboard refuses: ${label}`);
      assert.equal(enrollSourceAllowed(req), e, "the route uses the same gate");
    }
  } finally { restore(); }
});

test("dial address when our own tailnet suffix is not in our advertised URL: learned from tailscaled; else the verified tailnet IP:port; else refused — never an address-less new peer", async () => {
  const restore = snapshotEnv();
  const P = await makeSide("instP", "100.64.0.1"); // advertises http://100.64.0.1:3001 (no ts.net)
  try {
    const statusOnly = (st) => (cmd, args) => {
      if (args?.[0] === "status") return JSON.stringify(st);
      throw new Error("no tailscale in tests");
    };
    const route = async (exec, body) => {
      Object.assign(process.env, P.env, { CROW_ENROLL_ENABLED: "1", CROW_ENROLL_OTC: generateEnrollOtc() });
      const app = express();
      app.use(instanceEnrollRouter(P.db, { execFileSyncImpl: exec }));
      const srv = createServer(app);
      await new Promise((r) => srv.listen(0, "127.0.0.1", r));
      try { return await post(srv.address().port, { ...body, otc: process.env.CROW_ENROLL_OTC }); }
      finally { await new Promise((r) => { srv.close(r); srv.closeAllConnections(); }); }
    };
    const ts = "https://peer1.example.ts.net:8444";
    const r1 = await route(statusOnly({ MagicDNSSuffix: "example.ts.net", Self: { DNSName: "instp.example.ts.net." } }), baseBody("m1", { source_gateway_url: ts }));
    assert.equal(r1.status, 200);
    assert.equal((await P.row("m1")).gateway_url, ts, "suffix learned from tailscaled");
    const r2 = await route(statusOnly({ Self: { DNSName: "instp.tail12345.ts.net." } }), baseBody("m2", { source_gateway_url: ts, source_tailscale_ip: "100.64.9.7", source_sync_port: 3005 }));
    assert.equal(r2.status, 200);
    assert.equal((await P.row("m2")).gateway_url, "http://100.64.9.7:3005", "foreign-tailnet name dropped; verified tailnet IP:port stored instead");
    const r3 = await route(statusOnly({}), baseBody("m3", { source_gateway_url: ts, source_tailscale_ip: null, source_sync_port: null }));
    assert.equal(r3.status, 400);
    assert.equal(r3.body.error, "gateway_url_unacceptable");
    assert.equal(await P.row("m3"), null);
    const r4 = await route(statusOnly({}), baseBody("m4", { source_gateway_url: undefined, source_tailscale_ip: null, source_sync_port: null }));
    assert.equal(r4.status, 400, "no address at all: refused");
    assert.equal(await P.row("m4"), null);
  } finally { restore(); P.cleanup(); }
});

test("CLI side: the answering peer cannot choose which local peer gets re-keyed — another known peer's id, a --peer-id mismatch, our own id or a bad id abort with nothing written; legit re-pairs (address match, --peer-id) still work; unacceptable gateway_url never stored", async () => {
  const restore = snapshotEnv();
  const S = await makeSide("instS", "100.64.0.2");
  let answer = null;
  const fake = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(answer)); });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  const answerAs = (id, extra = {}) => ({
    peer_instance_id: id, peer_crow_id: id, peer_name: "M", peer_outbound_bearer: "p".repeat(64),
    peer_gateway_url: "http://100.64.30.30:3001", peer_tailscale_ip: "100.64.30.30", peer_sync_port: 3001, ...extra,
  });
  try {
    // A trusted victim peer V, paired at a different address.
    await S.db.execute({
      sql: "INSERT INTO crow_instances (id, name, crow_id, gateway_url, tailscale_ip, auth_token_hash, status, trusted) VALUES ('instV', 'V', 'instV', 'http://100.64.7.1:3001', '100.64.7.1', ?, 'active', 1)",
      args: [sha("v".repeat(64))],
    });
    for (const [k, v] of [["tailnet_sync_port:instV", "3001"], ["tailnet_sync_cr:instV", "1"]]) {
      await S.db.execute({ sql: "INSERT INTO dashboard_settings_overrides (key, instance_id, value) VALUES (?, 'instS', ?)", args: [k, v] });
    }
    writeFileSync(S.tokensPath, JSON.stringify({ instV: { auth_token: "t".repeat(64), signing_key: "s".repeat(64), created_at: "x", rotated_at: null } }, null, 2), { mode: 0o600 });
    const snap = async () => ({
      row: { ...(await S.row("instV")) }, tokens: readFileSync(S.tokensPath, "utf8"),
      port: await S.override("tailnet_sync_port:instV"), cr: await S.override("tailnet_sync_cr:instV"),
      rows: (await S.db.execute("SELECT id FROM crow_instances ORDER BY id")).rows.map((r) => r.id).join(","),
    });
    const before = await snap();
    const otc = generateEnrollOtc();
    const run = (args) => cli(S, ["--peer-url", fakeUrl, "--otc", otc, ...args]);

    for (const [label, ans, args, re] of [
      ["another known peer's id", answerAs("instV"), [], /already knows[\s\S]*--peer-id instV/],
      ["--peer-id mismatch", answerAs("instV"), ["--peer-id", "instM"], /not the --peer-id instM/],
      ["our own id", answerAs("instS"), [], /own id/],
      ["invalid id", answerAs("bad id!"), [], /invalid instance id/],
      ["short bearer", answerAs("instN", { peer_outbound_bearer: "short" }), [], /peer_outbound_bearer/],
    ]) {
      answer = ans;
      const r = await run(args);
      assert.notEqual(r.code, 0, label);
      assert.match(r.out, re, label);
      assert.match(r.out, /already recorded this pairing attempt[\s\S]*--allow-re-pair instS/, `${label}: the operator is told the peer's side is spent`);
      assert.deepEqual(await snap(), before, `${label}: nothing written`);
    }

    // Revoked V: only with --peer-id.
    await S.db.execute("UPDATE crow_instances SET status = 'revoked' WHERE id = 'instV'");
    const revokedBefore = await snap();
    answer = answerAs("instV", { peer_gateway_url: `http://127.0.0.1:${fake.address().port}` });
    await S.db.execute({ sql: "UPDATE crow_instances SET gateway_url = ? WHERE id = 'instV'", args: [fakeUrl] });
    const revokedSnap = await snap();
    const rv = await run([]);
    assert.notEqual(rv.code, 0);
    assert.match(rv.out, /REVOKED/);
    assert.deepEqual(await snap(), revokedSnap, "revoked row not revived by an address match");
    assert.ok(revokedBefore);
    await S.db.execute({ sql: "UPDATE crow_instances SET status = 'active', gateway_url = 'http://100.64.7.1:3001' WHERE id = 'instV'" });

    // Legit re-pair via --peer-id.
    answer = answerAs("instV");
    const viaId = await run(["--peer-id", "instV"]);
    assert.equal(viaId.code, 0, viaId.out);
    assert.equal((await S.row("instV")).auth_token_hash, sha("p".repeat(64)));
    assert.equal((await S.row("instV")).gateway_url, "http://100.64.30.30:3001");

    // Legit re-pair via address match (stored address host == --peer-url host).
    await S.db.execute({ sql: "UPDATE crow_instances SET gateway_url = ? WHERE id = 'instV'", args: [fakeUrl] });
    answer = answerAs("instV", { peer_outbound_bearer: "q".repeat(64) });
    const viaAddr = await run([]);
    assert.equal(viaAddr.code, 0, viaAddr.out);
    assert.equal((await S.row("instV")).auth_token_hash, sha("q".repeat(64)));

    // New peer with an unacceptable gateway_url: the typed origin is stored instead.
    answer = answerAs("instN", { peer_gateway_url: "https://user:pw@evil.example.com:8444", peer_tailscale_ip: "8.8.8.8" });
    const n = await run([]);
    assert.equal(n.code, 0, n.out);
    const nrow = await S.row("instN");
    assert.equal(nrow.gateway_url, fakeUrl, "public / userinfo URL never stored; the --peer-url origin is");
    assert.equal(nrow.tailscale_ip, null);
  } finally {
    await new Promise((r) => { fake.close(r); fake.closeAllConnections(); });
    restore();
    S.cleanup();
  }
});
