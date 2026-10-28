/**
 * PT-1 gates with two REAL gateway processes paired through the REAL pairing
 * tool (private engineering notes: peer-trust fix §3, T1-T11). Scratch homes
 * only, 127.0.0.1 ephemeral ports; see tests/fixtures/peer-pair.mjs.
 *
 * Every negative assertion is preceded, on the same link, by a positive
 * control that proves the path carries traffic.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { bootPair, signedCall, rawSigned, bearerMcp, settingsRevoke, stdioRevoke, pairInto, until, Instance, sha } from "./fixtures/peer-pair.mjs";

const T = { timeout: 300_000 };
const UNIFORM = { error: "peer_auth_failed" };

async function baseline(from, to) {
  const ov = await signedCall(from, to, "GET", "/dashboard/overview");
  assert.equal(ov.status, 200, `positive control: signed overview ${JSON.stringify(ov)}`);
  const mcp = await bearerMcp(from, to);
  assert.equal(mcp.status, 200, "positive control: bearer MCP initialize");
  assert.equal(mcp.listStatus, 200, "positive control: bearer MCP tools/list");
  const st = await signedCall(from, to, "POST", "/dashboard/bundles/api/start", { bundle_id: "pt1-stub" });
  assert.notEqual(st.status, 401, `positive control: a signed bundle start reaches a handler ${JSON.stringify(st)}`);
  assert.notEqual(st.status, 0, `positive control: a request was made ${JSON.stringify(st)}`);
}

async function assertRefused(from, to, reasonRe) {
  // Raw signature with the caller's own (possibly still held) creds, so the
  // refusal is the TARGET's, not the caller's own outbound gate.
  const creds = from.tokens()[to.id];
  if (creds) {
    for (const [method, path, body] of [["GET", "/dashboard/overview", undefined], ["POST", "/dashboard/bundles/api/start", { bundle_id: "pt1-stub" }]]) {
      const r = await rawSigned(from, to, { method, path, body, authToken: creds.auth_token, signingKey: creds.signing_key });
      assert.equal(r.status, 401, path);
      assert.deepEqual(r.body, UNIFORM, path);
    }
    assert.match(String(to.audit(from.id)?.error), reasonRe);
    const mcp = await bearerMcp(from, to, creds.auth_token);
    assert.equal(mcp.status === 200 && mcp.listStatus === 200, false, "bearer MCP refused");
  }
}

for (const sameIdentity of [true, false]) {
  const shape = sameIdentity ? "same identity" : "separate identities";

  describe(`two gateways (${shape})`, () => {
    test(`T1 A revokes B (Settings door), B keeps trying [${shape}]`, T, async () => {
      const { A, B, cleanup } = await bootPair({ sameIdentity });
      try {
        await baseline(B, A);
        await baseline(A, B);
        const rv = await settingsRevoke(A, B.id);
        assert.equal(rv.status, 303, JSON.stringify(rv));
        assert.match(String(rv.location), /revoked=1/);
        assert.equal(A.row(B.id).status, "revoked");
        assert.equal(A.tokens()[B.id], undefined, "A's store no longer holds B's key");
        assert.ok(B.tokens()[A.id], "B's store still holds A's (unilateral revoke)");
        await assertRefused(B, A, /^peer_not_trusted:revoked$/);
        // Mutual leg: B never revoked A, but A no longer trusts B, so A's own
        // outbound gate refuses before any request to B.
        const out = await signedCall(A, B, "GET", "/dashboard/overview");
        assert.equal(out.ok, false);
        assert.equal(out.status, 0, "no request was made");
        assert.match(String(out.error), /^target_not_trusted/);
      } finally { await cleanup(); }
    });

    test(`T4 re-pair after revoke [${shape}]`, T, async () => {
      const { A, B, cleanup } = await bootPair({ sameIdentity });
      try {
        await baseline(B, A);
        const oldOnB = { ...B.tokens()[A.id] };
        await settingsRevoke(A, B.id);
        // Un-revoke by update is refused (stdio door, the MCP tool path).
        const upd = await A.runAs(`
          const { updateInstance } = await import(${JSON.stringify(new URL("../servers/gateway/instance-registry.js", import.meta.url).href)});
          const { createDbClient } = await import(${JSON.stringify(new URL("../servers/db.js", import.meta.url).href)});
          try { await updateInstance(createDbClient(), ${JSON.stringify(B.id)}, { status: "active" }); console.log("UPDATED"); }
          catch (e) { console.log("REFUSED " + e.code); }
          process.exit(0);`);
        assert.match(upd.out, /REFUSED instance_revoked/);
        assert.equal(A.row(B.id).status, "revoked");

        // Without an allowance on A, B's re-pair is refused.
        const refused = await pairInto(B, A, ["--peer-id", A.id]);
        assert.notEqual(refused.code, 0);
        assert.match(refused.out, /already_paired|already known/);
        assert.equal(A.row(B.id).status, "revoked");

        // With --allow-re-pair on A it succeeds.
        const allow = await A.pairCli(["--allow-re-pair", B.id]);
        assert.equal(allow.code, 0, allow.out);
        const ok = await pairInto(B, A, ["--peer-id", A.id]);
        assert.equal(ok.code, 0, ok.out);
        const fence = JSON.parse(A.sql("SELECT last_applied_seq_per_peer AS b FROM sync_state WHERE instance_id = ?", [A.id])[0]?.b || "{}");
        assert.equal(fence[B.id]?.ff, 1, "the enroll route fenced the revoked → active move");
        assert.equal(A.row(B.id).status, "active");
        assert.equal(Number(A.row(B.id).trusted), 1);
        assert.equal(B.row(A.id).status, "active");
        const newOnB = B.tokens()[A.id];
        assert.notEqual(newOnB.signing_key, oldOnB.signing_key, "a new signing key");
        assert.notEqual(newOnB.auth_token, oldOnB.auth_token, "a new bearer");
        await baseline(B, A);
        const old = await rawSigned(B, A, { path: "/dashboard/overview", authToken: oldOnB.auth_token, signingKey: oldOnB.signing_key });
        assert.equal(old.status, 401, "the pre-revoke key no longer verifies");
        const oldBearer = await bearerMcp(B, A, oldOnB.auth_token);
        assert.notEqual(oldBearer.listStatus, 200, "the pre-revoke bearer no longer authenticates");

        // Reverse: A revoked B earlier and lost B's creds, so A cannot prove
        // anything to B; re-pairing A into B needs B's allowance.
        await settingsRevoke(A, B.id);
        const rev = await pairInto(A, B, ["--peer-id", B.id]);
        assert.notEqual(rev.code, 0, "no proof without creds: refused");
        const allowB = await B.pairCli(["--allow-re-pair", A.id]);
        assert.equal(allowB.code, 0, allowB.out);
        const rev2 = await pairInto(A, B, ["--peer-id", B.id]);
        assert.equal(rev2.code, 0, rev2.out);
        await baseline(A, B);
      } finally { await cleanup(); }
    });
  });
}

test("T5 untrusted but paired (legacy trusted=0): every gate refuses; probe and listing still work; a re-pair restores", T, async () => {
  const { A, B, cleanup } = await bootPair({ sameIdentity: true });
  try {
    await baseline(B, A);
    A.sql("UPDATE crow_instances SET trusted = 0 WHERE id = ?", [B.id]);
    await assertRefused(B, A, /^peer_not_trusted:untrusted$/);
    const out = await signedCall(A, B, "GET", "/dashboard/overview");
    assert.equal(out.error, "target_not_trusted");
    const health = await fetch(`${await B.urlFor(A)}/health`);
    assert.equal(health.status, 200, "the unauthenticated /health probe still works");
    const allow = await A.pairCli(["--allow-re-pair", B.id]);
    assert.equal(allow.code, 0, allow.out);
    const ok = await pairInto(B, A, ["--peer-id", A.id]);
    assert.equal(ok.code, 0, ok.out);
    const blob = JSON.parse(A.sql("SELECT last_applied_seq_per_peer AS b FROM sync_state WHERE instance_id = ?", [A.id])[0]?.b || "{}");
    assert.equal(blob[B.id]?.ff, 1, "the enroll route fenced the trusted=0 → trusted move");
    await baseline(B, A);
  } finally { await cleanup(); }
});

test("T6 pause is reversible; revoke is not", T, async () => {
  const { A, B, cleanup } = await bootPair({ sameIdentity: false });
  try {
    await baseline(B, A);
    A.sql("UPDATE crow_instances SET status = 'paused' WHERE id = ?", [B.id]);
    await assertRefused(B, A, /^peer_not_trusted:paused$/);
    A.sql("UPDATE crow_instances SET status = 'active' WHERE id = ?", [B.id]);
    await baseline(B, A);
  } finally { await cleanup(); }
});

test("T3 (stdio door) a revoke from another process: request gates refuse at once, the open MCP stream closes within the sweeper bound", T, async () => {
  const { A, B, cleanup } = await bootPair({ sameIdentity: true });
  try {
    await baseline(B, A);
    // Open a peer-owned SSE stream (the legacy SSE transport: its endpoint
    // event arrives at once, so "open" is observable).
    const http = await import("node:http");
    const sseUrl = new URL(`${await A.urlFor(B)}/memory/sse`);
    let firstChunk = null;
    let endedResolve;
    const ended = new Promise((r) => { endedResolve = r; });
    const req = http.get({ host: sseUrl.hostname, port: sseUrl.port, path: sseUrl.pathname, headers: { Accept: "text/event-stream", Authorization: `Bearer ${B.tokens()[A.id].auth_token}` } }, (res) => {
      res.on("data", (c) => { if (!firstChunk) firstChunk = String(c); });
      res.on("end", () => endedResolve(true));
      res.on("close", () => endedResolve(true));
      res.on("error", () => endedResolve(true));
    });
    req.on("error", () => endedResolve(true));
    assert.equal(await until(() => Boolean(firstChunk), 10_000, 50), true, "positive control: the peer's SSE stream is open");
    assert.match(firstChunk, /endpoint/);
    const ac = { abort() { req.destroy(); } };
    const r = await stdioRevoke(A, B.id);
    assert.equal(r.ok, true);
    assert.equal(r.creds_deleted, true);
    await assertRefused(B, A, /^peer_not_trusted:revoked$/);
    const closed = await Promise.race([ended, new Promise((res) => setTimeout(() => res(false), 15_000))]);
    ac.abort();
    assert.equal(closed, true, "the open MCP stream was closed by A's sweeper");
  } finally { await cleanup(); }
});

test("T9 co-hosted gateways: a revoke on one never touches the other's store; a mismatched stdio revoke reports store_mismatch and the owner's sweeper finishes it", T, async () => {
  const { A, B, cleanup } = await bootPair({ sameIdentity: false });
  const C = await new Instance("c", "100.64.20.13").init();
  try {
    await C.boot();
    const pc = await pairInto(C, A);
    assert.equal(pc.code, 0, pc.out);
    await baseline(B, A);
    await baseline(C, A);
    const cStoreBefore = JSON.stringify(C.tokens());
    // A stdio process with A's DB but C's store: the guard refuses the delete.
    const mis = await stdioRevoke(A, B.id, { CROW_PEER_TOKENS_PATH: C.tokensPath, CROW_HOME: C.dir });
    assert.equal(mis.ok, true);
    assert.equal(mis.creds_deleted, false);
    assert.equal(mis.reason, "store_mismatch");
    assert.equal(JSON.stringify(C.tokens()), cStoreBefore, "the other instance's store is untouched");
    // A's own sweeper deletes the key (minted before the revoke) within its bound.
    A.sql("UPDATE crow_instances SET updated_at = datetime('now', '+2 seconds') WHERE id = ?", [B.id]);
    assert.equal(await until(() => A.tokens()[B.id] === undefined, 20_000), true, "A's sweeper deleted B's key");
    await assertRefused(B, A, /^peer_not_trusted:revoked$/);
    await baseline(C, A); // revoking B affects only B
  } finally { await C.cleanup(); await cleanup(); }
});

test("T10 boot reconcile: a revoked row's pre-revoke key is gone once the gateway is up, and fails HMAC", T, async () => {
  const { A, B, cleanup } = await bootPair({ sameIdentity: false });
  try {
    await baseline(B, A);
    const key = A.tokens()[B.id];
    await A.stop();
    // The crow-today shape: row revoked (bearer nulled) by an old build that left the key.
    A.sql("UPDATE crow_instances SET status = 'revoked', auth_token_hash = NULL, updated_at = datetime('now', '+2 seconds') WHERE id = ?", [B.id]);
    assert.ok(A.tokens()[B.id], "the leftover key is on disk before boot");
    await A.boot();
    assert.equal(await until(() => A.tokens()[B.id] === undefined, 15_000), true, "deleted by the boot reconcile");
    const { existsSync, readdirSync } = await import("node:fs");
    const snaps = readdirSync(A.dir).filter((f) => f.startsWith("peer-tokens.json.pre-pt1."));
    assert.ok(snaps.some((f) => !f.endsWith(".done")), "the one-time pre-PT-1 snapshot exists");
    assert.ok(existsSync(join(A.dir, "peer-tokens.json.pre-pt1.done")));
    const r = await rawSigned(B, A, { path: "/dashboard/overview", authToken: B.tokens()[A.id].auth_token, signingKey: key.signing_key });
    assert.equal(r.status, 401);
  } finally { await cleanup(); }
});

test("T11 re-pair vs reconcile race: a key minted after the revoke survives cross-process reconciles while the enroll is paused", T, async () => {
  const { A, B, cleanup } = await bootPair({ sameIdentity: false });
  try {
    await baseline(B, A);
    const preRevokeOnA = A.tokens()[B.id].auth_token;
    await settingsRevoke(A, B.id);
    assert.equal((await A.pairCli(["--allow-re-pair", B.id])).code, 0);
    const otc = (await import("../servers/shared/enroll-guard.js")).generateEnrollOtc();
    await A.boot({ otc });
    // Hold a SQLite write lock on A's DB from a sidecar: the enroll route
    // writes the new creds, then blocks in db.batch (busy timeout) until release.
    const Database = (await import("better-sqlite3")).default;
    const holder = new Database(join(A.dataDir, "crow.db"));
    holder.pragma("busy_timeout = 5000");
    holder.exec("BEGIN IMMEDIATE");
    const pairing = B.pairCli(["--peer-url", await A.urlFor(B), "--otc", otc, "--peer-id", A.id]);
    let released = false;
    try {
      const reached = await until(() => { const e = A.tokens()[B.id]; return Boolean(e && e.auth_token !== preRevokeOnA); }, 20_000, 50);
      // Non-vacuity: the race window is open (new entry written, row still revoked).
      const rowNow = new Database(join(A.dataDir, "crow.db"), { readonly: true });
      const status = rowNow.prepare("SELECT status FROM crow_instances WHERE id = ?").get(B.id).status;
      rowNow.close();
      if (!reached || status !== "revoked") throw new Error(`race window not reached (entry=${reached}, row=${status})`);
      // The boot-reconcile variant from a sidecar with A's env, during the hold (twice).
      for (let i = 0; i < 2; i++) {
        const rc = await A.runAs(`const { reconcileFromEnv } = await import(${JSON.stringify(new URL("../servers/gateway/peer-trust-sweeper.js", import.meta.url).href)}); const r = await reconcileFromEnv(); console.log("RESULT " + JSON.stringify(r.deleted)); process.exit(0);`);
        assert.match(rc.out, /RESULT \[\]/, rc.err);
      }
      // A's in-gateway sweeper cannot interleave here: the enroll's db.batch
      // is a synchronous better-sqlite3 call waiting on the busy handler, so
      // A's event loop is held from the creds write to the commit. The
      // cross-process runs above are the race that exists.
      assert.ok(A.tokens()[B.id], "the new entry survived");
    } finally {
      holder.exec("COMMIT");
      holder.close();
      released = true;
    }
    const res = await pairing;
    assert.equal(released, true);
    assert.equal(res.code, 0, res.out);
    await A.boot();
    await baseline(B, A);
  } finally { await cleanup(); }
});

test("T7 SSO: a revoke ends the peer's SSO session and refuses a new ticket", T, async () => {
  const { A, B, cleanup } = await bootPair({ sameIdentity: true });
  try {
    A.sql("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('sso_enabled', 'true', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = 'true'");
    const ticketFor = async () => {
      const r = await B.runAs(`
        const { signTicket } = await import(${JSON.stringify(new URL("../servers/shared/sso-ticket.js", import.meta.url).href)});
        const { getPeerCreds } = await import(${JSON.stringify(new URL("../servers/shared/peer-credentials.js", import.meta.url).href)});
        const t = signTicket({ src: ${JSON.stringify(B.id)}, dst: ${JSON.stringify(A.id)}, dest: "/dashboard", signingKey: getPeerCreds(${JSON.stringify(A.id)}).signing_key });
        console.log("RESULT " + JSON.stringify(t)); process.exit(0);`);
      const line = r.out.split("\n").find((l) => l.startsWith("RESULT "));
      if (!line) throw new Error(r.err);
      return JSON.parse(line.slice(7));
    };
    const accept = async (t) => fetch(`${await A.urlFor(B)}/dashboard/sso/accept?src=${encodeURIComponent(B.id)}&t=${encodeURIComponent(t.payloadB64)}&sig=${encodeURIComponent(t.sig)}`, { redirect: "manual" });
    const ok = await accept(await ticketFor());
    assert.equal(ok.status, 303, "positive control: SSO accepted");
    const cookie = (ok.headers.get("set-cookie") || "").match(/crow_session=([^;]+)/)?.[1];
    assert.ok(cookie);
    assert.equal(A.sql("SELECT COUNT(*) AS n FROM oauth_tokens WHERE scopes = ?", [`dashboard sso src:${B.id}`])[0].n, 1, "the session is tagged with its source");
    const home = await fetch(`${await A.urlFor(B)}/dashboard/settings`, { headers: { Cookie: `crow_session=${cookie}` }, redirect: "manual" });
    assert.equal(home.status, 200, "positive control: the SSO session works");
    const t2 = await ticketFor(); // minted before the revoke, presented after
    await settingsRevoke(A, B.id);
    const after = await fetch(`${await A.urlFor(B)}/dashboard/settings`, { headers: { Cookie: `crow_session=${cookie}` }, redirect: "manual" });
    assert.notEqual(after.status, 200, "the SSO session ended with the revoke");
    const again = await accept(t2);
    assert.notEqual(again.status, 303, "a new ticket is refused");
  } finally { await cleanup(); }
});

test("T2 mutual revoke race mid-traffic: both stores lose the other and nothing authenticates either way", { timeout: 600_000 }, async () => {
  const ROUNDS = Number(process.env.PT1_T2_ROUNDS || 5);
  for (let round = 0; round < ROUNDS; round++) {
    const { A, B, cleanup } = await bootPair({ sameIdentity: round % 2 === 0 });
    try {
      await baseline(B, A);
      await baseline(A, B);
      const credsBonA = { ...B.tokens()[A.id] };
      const credsAonB = { ...A.tokens()[B.id] };
      let stop = false;
      const traffic = (async () => {
        while (!stop) {
          await Promise.all([
            rawSigned(B, A, { path: "/dashboard/overview", authToken: credsBonA.auth_token, signingKey: credsBonA.signing_key }),
            rawSigned(A, B, { path: "/dashboard/overview", authToken: credsAonB.auth_token, signingKey: credsAonB.signing_key }),
            bearerMcp(B, A, credsBonA.auth_token),
          ]).catch(() => {});
        }
      })();
      const [ra, rb] = await Promise.all([settingsRevoke(A, B.id), settingsRevoke(B, A.id)]);
      stop = true;
      await traffic;
      assert.match(String(ra.location), /revoked=1/, `round ${round}`);
      assert.match(String(rb.location), /revoked=1/, `round ${round}`);
      assert.equal(A.tokens()[B.id], undefined, `round ${round}: A lost B`);
      assert.equal(B.tokens()[A.id], undefined, `round ${round}: B lost A`);
      for (const [from, to, c] of [[B, A, credsBonA], [A, B, credsAonB]]) {
        const r = await rawSigned(from, to, { path: "/dashboard/overview", authToken: c.auth_token, signingKey: c.signing_key });
        assert.equal(r.status, 401, `round ${round}`);
        assert.deepEqual(r.body, UNIFORM);
        const m = await bearerMcp(from, to, c.auth_token);
        assert.notEqual(m.listStatus, 200, `round ${round}: bearer refused`);
      }
    } finally { await cleanup(); }
  }
});
