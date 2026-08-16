/**
 * Track 3 Task 9 — GET /interactive/:sid/workspace/* confined file serving.
 *
 * Harness: a REAL temp `outputsDir` (no crow.db needed at all — the route
 * only ever consults `eng.get(sid)` for `outputsDir`/`uploadsDir`, so a
 * fake engine plus a bare Express app is the whole fixture) with a genuine
 * attack surface built on disk: a nested ok-file, a dotfile, and a symlink
 * that resolves OUTSIDE outputsDir into a sibling "secret" directory this
 * process also controls. Every attack test asserts the secret content is
 * NEVER returned, not just that the status code looks right — a route that
 * 404s for the wrong reason (e.g. a thrown exception it happens to catch)
 * would still pass a status-only assertion.
 *
 * Raw `http.request` (not `fetch`) for the traversal case: the WHATWG URL
 * parser collapses literal ".." path segments before the request is even
 * sent, so a `fetch()` call can never actually put ".." on the wire — the
 * same reason perch-interactive-routes.test.js's own CSRF block uses a raw
 * socket instead of fetch.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync,
  unlinkSync, lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import http from "node:http";

let server, base, port;
let engineImpl;
let setWorkspaceServeBarrier;

/** Same thenable-barrier idiom as tests/install-set-e2e.test.js's own
 * makeBarrier(): `reached` resolves the instant the route parks on it (no
 * sleeping/polling needed to know WHEN), `release()` unparks it. */
function makeBarrier() {
  let release;
  let notifyReached;
  const gate = new Promise((r) => { release = r; });
  const reached = new Promise((r) => { notifyReached = r; });
  const barrier = {
    awaited: 0,
    reached,
    release,
    then(onFulfilled, onRejected) {
      barrier.awaited++;
      notifyReached();
      return gate.then(onFulfilled, onRejected);
    },
  };
  return barrier;
}

const outputsDir = mkdtempSync(join(tmpdir(), "perch-workspace-outputs-"));
const secretDir = mkdtempSync(join(tmpdir(), "perch-workspace-secret-"));
// Fix round 1, finding 2: a DIRECTORY symlink one level up from the leaf —
// distinct from escape-link.txt's FILE symlink below. realpathSync resolves
// every symlinked path COMPONENT, not just a leaf, so a symlinked
// intermediate directory must be caught by the same jail check.
const outsideDir2 = mkdtempSync(join(tmpdir(), "perch-workspace-outside2-"));

function rawRequest(path, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  writeFileSync(join(outputsDir, "ok.txt"), "hello ok");
  writeFileSync(join(outputsDir, "photo.png"), "fake-png-bytes");
  writeFileSync(join(outputsDir, ".hidden"), "should never serve");
  mkdirSync(join(outputsDir, "sub"), { recursive: true });
  writeFileSync(join(outputsDir, "sub", "nested.txt"), "nested ok");
  writeFileSync(join(secretDir, "secret.txt"), "TOP SECRET — must never be served");
  // The money attack: a symlink INSIDE outputsDir whose real target resolves
  // OUTSIDE it.
  symlinkSync(join(secretDir, "secret.txt"), join(outputsDir, "escape-link.txt"));
  // Finding 2: an INTERMEDIATE directory symlink — outputsDir/sub2 itself is
  // a symlink to outsideDir2 — with the leaked file one level further down
  // (leak.txt), reached only by resolving THROUGH the symlinked directory.
  writeFileSync(join(outsideDir2, "leak.txt"), "LEAKED — must never be served");
  symlinkSync(outsideDir2, join(outputsDir, "sub2"));

  const { default: express } = await import("express");
  const { default: perchInteractiveApiRouter, _setWorkspaceServeBarrierForTest } =
    await import("../servers/gateway/routes/perch-interactive-api.js");
  setWorkspaceServeBarrier = _setWorkspaceServeBarrierForTest;
  const fakeAuth = (req, res, next) => next();

  engineImpl = {
    async get(sid) {
      if (sid === "ghost") return null;
      if (sid === "no-dir") return { sessionId: sid, outputsDir: null, uploadsDir: null };
      return { sessionId: sid, outputsDir, uploadsDir: join(outputsDir, "..", "uploads-unused") };
    },
  };

  const app = express();
  app.use(express.json());
  app.use(perchInteractiveApiRouter(fakeAuth, { engine: () => engineImpl }));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  port = server.address().port;
  base = "http://127.0.0.1:" + port + "/dashboard/perch-api";
});

after(() => {
  if (server) server.close();
  rmSync(outputsDir, { recursive: true, force: true });
  rmSync(secretDir, { recursive: true, force: true });
  rmSync(outsideDir2, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

test("serves an ok file with Content-Disposition: attachment for a non-image extension", async () => {
  const r = await rawRequest("/dashboard/perch-api/interactive/sess-1/workspace/ok.txt");
  assert.equal(r.status, 200);
  assert.equal(r.body.toString("utf8"), "hello ok");
  assert.match(r.headers["content-disposition"], /^attachment/);
});

test("serves a nested ok-file under a real subdirectory", async () => {
  const r = await rawRequest("/dashboard/perch-api/interactive/sess-1/workspace/sub/nested.txt");
  assert.equal(r.status, 200);
  assert.equal(r.body.toString("utf8"), "nested ok");
});

test("serves an image extension WITHOUT Content-Disposition: attachment — the drawer inlines it", async () => {
  const r = await rawRequest("/dashboard/perch-api/interactive/sess-1/workspace/photo.png");
  assert.equal(r.status, 200);
  assert.equal(r.body.toString("utf8"), "fake-png-bytes");
  assert.equal(r.headers["content-disposition"], undefined);
});

// ---------------------------------------------------------------------------
// no directory listing
// ---------------------------------------------------------------------------

test("a bare subdirectory 404s — no directory listing", async () => {
  const r = await rawRequest("/dashboard/perch-api/interactive/sess-1/workspace/sub");
  assert.equal(r.status, 404);
});

test("the bare outputsDir root (empty rel) 404s", async () => {
  // No trailing segment at all — Express's own routing means this actually
  // falls through to a DIFFERENT (non-matching) route rather than hitting
  // req.params[0]==="" here; workspace/ WITH the trailing slash is the one
  // that reaches the handler with an empty rel.
  const r = await rawRequest("/dashboard/perch-api/interactive/sess-1/workspace/");
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------------------
// ATTACK: traversal
// ---------------------------------------------------------------------------

test("ATTACK traversal: ../<secretDir basename>/secret.txt 404s — never serves the secret", async () => {
  const rel = "../" + basename(secretDir) + "/secret.txt";
  const r = await rawRequest("/dashboard/perch-api/interactive/sess-1/workspace/" + rel);
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.body.toString("utf8"), /TOP SECRET/);
});

test("ATTACK traversal: percent-encoded ../ also 404s — never serves the secret", async () => {
  const rel = "..%2f" + basename(secretDir) + "%2fsecret.txt";
  const r = await rawRequest("/dashboard/perch-api/interactive/sess-1/workspace/" + rel);
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.body.toString("utf8"), /TOP SECRET/);
});

// ---------------------------------------------------------------------------
// ATTACK: absolute path
// ---------------------------------------------------------------------------

test("ATTACK absolute path: an encoded leading slash (rel becomes /etc/passwd-shaped) 404s", async () => {
  const r = await rawRequest("/dashboard/perch-api/interactive/sess-1/workspace/%2Fetc%2Fpasswd");
  assert.equal(r.status, 404);
});

test("ATTACK absolute path: the secret file's own ABSOLUTE path as the rel segment 404s", async () => {
  // secretDir/secret.txt as an absolute string, percent-encoded so it
  // survives as ONE path segment's worth of literal slashes.
  const abs = join(secretDir, "secret.txt");
  const r = await rawRequest("/dashboard/perch-api/interactive/sess-1/workspace/" + encodeURIComponent(abs).replace(/%2F/gi, "%2F"));
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.body.toString("utf8"), /TOP SECRET/);
});

// ---------------------------------------------------------------------------
// ATTACK: symlink escape
// ---------------------------------------------------------------------------

test("ATTACK symlink escape: a symlink inside outputsDir resolving OUTSIDE it 404s — never serves the secret", async () => {
  const r = await rawRequest("/dashboard/perch-api/interactive/sess-1/workspace/escape-link.txt");
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.body.toString("utf8"), /TOP SECRET/);
});

// Fix round 1, finding 2: same class of attack, one level higher — the
// symlink is on an INTERMEDIATE directory (outputsDir/sub2), not the leaf
// file. realpathSync(join(outputsDir, "sub2/leak.txt")) still resolves
// through it to outsideDir2/leak.txt, so the existing startsWith(outputsReal
// + sep) check catches this shape too — pinned here so it stays true.
test("ATTACK symlink escape: an INTERMEDIATE directory symlink (sub2 -> outside) 404s — never serves the leaked file", async () => {
  const r = await rawRequest("/dashboard/perch-api/interactive/sess-1/workspace/sub2/leak.txt");
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.body.toString("utf8"), /LEAKED/);
});

// ---------------------------------------------------------------------------
// ATTACK: dotfile
// ---------------------------------------------------------------------------

test("ATTACK dotfile: a real dotfile in outputsDir 404s — rejected on the path segment BEFORE resolution", async () => {
  const r = await rawRequest("/dashboard/perch-api/interactive/sess-1/workspace/.hidden");
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.body.toString("utf8"), /should never serve/);
});

test("ATTACK dotfile: a nested dotfile segment 404s too", async () => {
  const r = await rawRequest("/dashboard/perch-api/interactive/sess-1/workspace/sub/.hidden-nested");
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------------------
// session/engine state
// ---------------------------------------------------------------------------

test("no_such_session 404s for an unknown session", async () => {
  const r = await rawRequest("/dashboard/perch-api/interactive/ghost/workspace/ok.txt");
  assert.equal(r.status, 404);
  assert.equal(JSON.parse(r.body.toString("utf8")).error, "no_such_session");
});

test("no_session_dir 409s when the session has never been through startChild in this process", async () => {
  const r = await rawRequest("/dashboard/perch-api/interactive/no-dir/workspace/ok.txt");
  assert.equal(r.status, 409);
  assert.equal(JSON.parse(r.body.toString("utf8")).error, "no_session_dir");
});

test("a nonexistent file (no attack, just missing) 404s cleanly", async () => {
  const r = await rawRequest("/dashboard/perch-api/interactive/sess-1/workspace/does-not-exist.txt");
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------------------
// ATTACK: TOCTOU race — the validated file swapped for a symlink between
// validation and streaming (final review, C2)
// ---------------------------------------------------------------------------
//
// outputsDir is in the pi child's extraWritePaths (perch-interactive.js), so
// a racing child can unlink+re-symlink a file it just wrote at any moment.
// The OLD code validated the path with realpathSync/statSync, then handed
// the SAME PATH STRING to res.sendFile(), which re-opens it — two separate
// by-path lookups with a real (if narrow) window between them. This test
// proves the fix (single open() by fd, everything downstream reads from
// THAT fd) is immune to a swap performed in the analogous window, using the
// _setWorkspaceServeBarrierForTest hook to park the route deterministically
// right after it finishes validating and right before it streams — no sleep,
// no timing luck.
test("ATTACK TOCTOU race: swapping the validated file for a symlink AFTER validation, before streaming, must NOT leak the swapped-in target", async () => {
  const raceTarget = join(outputsDir, "race-target.bin");
  const raceSecretDir = mkdtempSync(join(tmpdir(), "perch-workspace-race-secret-"));
  const raceSecret = join(raceSecretDir, "race-secret.bin");
  const originalContent = Buffer.alloc(256 * 1024, 0x41); // 256KB of 'A'
  const secretContent = "TOP-SECRET-RACE-CONTENT-" + Buffer.alloc(256 * 1024, 0x42).toString("binary").slice(0, 100);
  writeFileSync(raceTarget, originalContent);
  writeFileSync(raceSecret, secretContent);

  const barrier = makeBarrier();
  setWorkspaceServeBarrier(barrier);
  try {
    const reqPromise = rawRequest("/dashboard/perch-api/interactive/sess-1/workspace/race-target.bin");

    // Wait until the route has ACTUALLY parked on the barrier — i.e. it has
    // already opened race-target.bin by fd, fstat'd it, and jail-verified
    // it — before we touch the filesystem. Zero wall-clock waiting.
    await barrier.reached;

    // The race: swap the validated file for a symlink into the secret dir,
    // simulating a racing pi child doing exactly this between validation and
    // streaming.
    unlinkSync(raceTarget);
    symlinkSync(raceSecret, raceTarget);
    // Prove the swap actually took effect on disk (not a no-op) — otherwise
    // a passing test would be meaningless.
    assert.ok(lstatSync(raceTarget).isSymbolicLink(), "test setup sanity: the swap must have landed");

    barrier.release();
    const r = await reqPromise;

    assert.equal(r.status, 200, "the ALREADY-VALIDATED fd must still serve successfully");
    assert.ok(
      r.body.equals(originalContent),
      "the response body must be the ORIGINAL file's content, read via the fd opened before the swap — never the swapped-in target"
    );
    assert.doesNotMatch(r.body.toString("binary"), /TOP-SECRET-RACE-CONTENT/,
      "the secret content must never appear in the response, regardless of what the path resolves to after validation");
  } finally {
    setWorkspaceServeBarrier(null);
    rmSync(raceSecretDir, { recursive: true, force: true });
    try { unlinkSync(raceTarget); } catch { /* already gone */ }
  }
});

test("barrier is a no-op by default — _setWorkspaceServeBarrierForTest(null) never parks a normal request", async () => {
  setWorkspaceServeBarrier(null);
  const r = await rawRequest("/dashboard/perch-api/interactive/sess-1/workspace/ok.txt");
  assert.equal(r.status, 200);
  assert.equal(r.body.toString("utf8"), "hello ok");
});
