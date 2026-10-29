/**
 * Tests: make a request look like it comes from another machine (the owner's laptop), so the
 * origin rule in servers/shared/self-origin.js lets an owner session through. A request from
 * this machine is never the owner's turn, and a test's in-process HTTP call is from loopback.
 *
 * 203.0.113.0/24 is TEST-NET-3 (RFC 5737): no real interface carries it, so the live
 * interface table can never make it "this machine". It is NOT a private address, so the real
 * isAllowedNetwork/dashboardAuth refuses it as a direct peer: use these only behind a stubbed auth
 * middleware. A test through the real dashboardAuth should send Serve's headers for another
 * tailnet node instead (tests/fixtures/serve-peer.mjs, as tests/self-origin.test.js does).
 */
export const LAPTOP_ADDR = "203.0.113.7";

/** A plain request object, from the laptop (a direct TCP peer). */
export function fromLaptop(req = {}, addr = LAPTOP_ADDR) {
  req.socket = { remoteAddress: addr };
  return req;
}

/** A real (loopback) Express request, classified as a direct peer from the laptop. Only a test
 * can do this: it plants the peer-class memo that classifyPeer() reads first. */
export function markFromLaptop(req, addr = LAPTOP_ADDR) {
  Object.defineProperty(req, Symbol.for("crow.peer-class"), {
    value: { via: "direct", client: addr, hops: [], socket: addr, tailnetLogin: null, peerUid: null },
    enumerable: false, configurable: true,
  });
  return req;
}
