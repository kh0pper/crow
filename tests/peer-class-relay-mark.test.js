/**
 * A walled add-on's relay mark is its own address (127.0.78.1), not the bot
 * mark: an add-on's socket must not be a local peer, and the Serve/Funnel shape
 * analysis is never read off it. The bot mark keeps its rules unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isLocalPeer, classifyPeer } from "../servers/shared/peer-class.js";
import {
  ADDON_RELAY_SOURCE_V4,
  RELAY_SOURCE_V4,
  isAddonRelayAddr,
  isRelayedSocket,
} from "../servers/shared/bot-doors.js";

const SERVE_SHAPED = { "x-forwarded-for": "100.64.20.5", "x-forwarded-host": "crow.example.ts.net" };
const SPY =
  ["127.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:127.0.78.1", "::FFFF:127.0.78.1", "[::ffff:127.0.78.1]"];

test("the add-on mark has its own address", () => {
  assert.equal(ADDON_RELAY_SOURCE_V4, "127.0.78.1");
  assert.notEqual(ADDON_RELAY_SOURCE_V4, RELAY_SOURCE_V4);
});

test("127.0.78.1 is never a local peer, in any spelling the kernel reports", () => {
  for (const a of ["127.0.78.1", "::ffff:127.0.78.1", "::FFFF:127.0.78.1", "[::ffff:127.0.78.1]"]) {
    assert.equal(isAddonRelayAddr(a), true, a);
    assert.equal(isLocalPeer(a, {}), false, a);
  }
  for (const a of ["127.0.0.1", "127.0.78.2", "::1", "100.64.20.5", ""]) assert.equal(isAddonRelayAddr(a), false, String(a));
});

test("classifyPeer leaves the add-on mark unverified, with and without a Serve shape", () => {
  for (const a of ["127.0.78.1", "::ffff:127.0.78.1"]) {
    const plain = classifyPeer({ socket: { remoteAddress: a }, headers: {} });
    assert.equal(plain.via, "unverified", a);
    assert.equal(plain.client, "127.0.78.1", a);
    const serve = classifyPeer({ socket: { remoteAddress: a }, headers: { ...SERVE_SHAPED } });
    assert.equal(serve.via, "unverified", a + " with Serve-shaped headers");
    const funnel = classifyPeer({ socket: { remoteAddress: a }, headers: { "x-forwarded-for": "93.184.216.34", "tailscale-funnel-request": "?1" } });
    assert.equal(funnel.via, "unverified", a + " with a Funnel shape");
  }
});

test("127.0.0.1 and the bot mark are still local; the add-on mark is not", () => {
  for (const a of ["127.0.0.1", "::1", RELAY_SOURCE_V4, "::ffff:" + RELAY_SOURCE_V4]) {
    assert.equal(isLocalPeer(a, {}), true, a);
    assert.equal(classifyPeer({ socket: { remoteAddress: a }, headers: {} }).via, "local", a);
  }
  assert.equal(classifyPeer({ socket: { remoteAddress: ADDON_RELAY_SOURCE_V4 }, headers: {} }).via, "unverified");
});

test("isRelayedSocket is true for both relay marks and false for a neighbouring address", () => {
  for (const a of ["127.0.77.1", "::ffff:127.0.77.1", "127.0.78.1", "::ffff:127.0.78.1", "[::FFFF:127.0.78.1]"]) {
    assert.equal(isRelayedSocket({ remoteAddress: a }), true, a);
  }
  for (const a of ["127.0.0.1", "::1", "127.0.77.2", "127.0.78.2", "10.20.30.40", "", undefined]) {
    assert.equal(isRelayedSocket({ remoteAddress: a }), false, String(a));
  }
  assert.equal(isRelayedSocket(null), false);
  assert.equal(isRelayedSocket({}), false);
  // Nothing in this test depends on an address being listed as a proxy.
  for (const a of SPY) assert.equal(typeof isLocalPeer(a, {}), "boolean", a);
});
/**
 * The add-on branch in classifyPeer is the ONLY thing that keeps the add-on
 * mark out of the Serve and proxy branches. isLocalPeer refusing the mark is
 * not enough on its own: with Serve's uid check switched off, or with loopback
 * listed as a trusted proxy, a Serve-shaped or proxied request from the mark
 * would otherwise come out as "serve" or "proxy". Each case below fails if that
 * one branch is removed.
 */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test("the add-on mark is never read as Serve, even when Serve's uid check is off", () => {
  withEnv({ CROW_SERVE_PEER_UIDS: "off" }, () => {
    // Control: the same request shape from plain loopback IS read as Serve here,
    // so the case below depends on the add-on branch alone.
    const control = classifyPeer({ socket: { remoteAddress: "127.0.0.1" }, headers: { ...SERVE_SHAPED } });
    assert.equal(control.via, "serve");
    for (const a of ["127.0.78.1", "::ffff:127.0.78.1"]) {
      const r = classifyPeer({ socket: { remoteAddress: a }, headers: { ...SERVE_SHAPED } });
      assert.equal(r.via, "unverified", a);
      assert.equal(r.client, "127.0.78.1", a);
      assert.equal(r.tailnetLogin, null, a);
    }
  });
});

test("the add-on mark is never a trusted proxy, even when loopback is listed as one", () => {
  withEnv({ CROW_TRUSTED_PROXIES: "loopback" }, () => {
    const control = classifyPeer({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "100.64.20.5" } });
    assert.equal(control.via, "proxy");
    for (const a of ["127.0.78.1", "::ffff:127.0.78.1"]) {
      const r = classifyPeer({ socket: { remoteAddress: a }, headers: { "x-forwarded-for": "100.64.20.5" } });
      assert.equal(r.via, "unverified", a);
      assert.equal(r.client, "127.0.78.1", a);
    }
  });
});
