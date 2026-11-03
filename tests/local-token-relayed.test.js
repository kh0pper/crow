/**
 * Containment PR 6: a relayed socket never authenticates as the operator.
 *
 * A contained bot has crow.db bound read-write (Phase 1), so it can write
 * mcp_local_token_hash and then present its own value as the operator's full
 * local token on /board/mcp — a door. localTokenAuthMiddleware therefore skips
 * validateLocalToken entirely for a socket carrying the relay mark
 * (127.0.77.1); only the path-scoped board, phone and artifacts tokens may
 * authenticate a relayed request.
 *
 * The middleware is driven directly with fake req objects; the DB is a stub
 * whose settings make one full token and one board token valid.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { localTokenAuthMiddleware } from "../servers/gateway/local-token.js";
import { RELAY_SOURCE_V4 } from "../servers/shared/bot-doors.js";

const FULL = "test-full-local-token";
const BOARD = "test-board-token";
const sha256 = (t) => createHash("sha256").update(t).digest("hex");

/** The settings registry reads `{rows:[{value}]}`; a known key answers with its hash. */
const HASHES = { mcp_local_token_hash: sha256(FULL), mcp_board_token_hash: sha256(BOARD) };
const db = {
  execute: async ({ sql, args }) => {
    const key = args && args[0];
    const known = Object.prototype.hasOwnProperty.call(HASHES, key);
    if (!known) return { rows: [] };
    // The per-instance override lookup comes first; the same value is fine.
    return { rows: [{ value: HASHES[key] }] };
  },
};

const RELAY = RELAY_SOURCE_V4;
const LOOPBACK = "127.0.0.1";

function fakeReq({ remoteAddress, path, token }) {
  return {
    socket: { remoteAddress },
    path,
    headers: token ? { authorization: "Bearer " + token } : {},
  };
}

async function run(req) {
  let nexted = 0;
  await localTokenAuthMiddleware(db)(req, {}, () => { nexted++; });
  assert.equal(nexted, 1, "the middleware always yields, never hard-rejects");
  return req;
}

test("the full local token on a relayed socket does not authenticate (crow.db is bot-writable)", async () => {
  const req = await run(fakeReq({ remoteAddress: RELAY, path: "/board/mcp", token: FULL }));
  assert.equal(req.localTokenAuth, undefined, "no local-token auth from a relayed socket");
  assert.equal(req.auth, undefined, "and no synthesized operator auth");
});

test("the path-scoped board token still authenticates a relayed socket", async () => {
  const req = await run(fakeReq({ remoteAddress: RELAY, path: "/board/mcp", token: BOARD }));
  assert.deepEqual(req.localTokenAuth, { token: "local-mcp", scope: "board" });
});

test("the full local token from a plain loopback socket keeps its full access", async () => {
  const req = await run(fakeReq({ remoteAddress: LOOPBACK, path: "/board/mcp", token: FULL }));
  assert.deepEqual(req.localTokenAuth, { token: "local-mcp" }, "the operator's own token, no scope");
  const v4mapped = await run(fakeReq({ remoteAddress: "::ffff:" + RELAY, path: "/board/mcp", token: FULL }));
  assert.equal(v4mapped.localTokenAuth, undefined, "the mark is recognised in its v4-mapped spelling too");
});

test("a board token is still useless off the board paths", async () => {
  const req = await run(fakeReq({ remoteAddress: RELAY, path: "/memory/mcp", token: BOARD }));
  assert.equal(req.localTokenAuth, undefined, "the board token stays path-scoped");
});