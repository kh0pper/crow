/**
 * A walled add-on's egress relay: per-add-on allow lists, a listener-owner
 * check on every loopback splice, exact CONNECT entries that may be private,
 * and (D1) absolute-form plain HTTP to those same entries. Real sockets on
 * loopback; the internet is a lookup seam and `_connectOverride`.
 *
 * The bot path is covered by tests/pi-egress.test.js and
 * tests/bot-path-golden.test.js, unmodified; the last test here pins that a
 * relay built WITHOUT `addon` still refuses every other loopback port and still
 * opens its door sockets from the bot mark.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startEgressRelay } from "../scripts/pi-bots/pi_egress.mjs";

/** An own-host view with no addresses (the seam every CONNECT test pins). */
const NO_LOCAL = { v4: [], v6: [], onLink4: [], onLink6: [], v4Failed: false, v6Failed: false, onLinkFailed: false };
/** A global-unicast fixture. */
const PUB = "93.184.216.34";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "crow-addon-egress-")));
const closers = [];
after(async () => { for (const c of closers) await c(); rmSync(scratch, { recursive: true, force: true }); });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** A raw echo upstream; `onConn` sees every accepted connection. */
function echoServer(tag = "", onConn = null) {
  return new Promise((resolve) => {
    const live = new Set();
    const srv = createServer((c) => {
      live.add(c);
      c.on("close", () => live.delete(c));
      if (onConn) onConn(c);
      c.on("data", (d) => c.write(tag + d.toString()));
    });
    srv.listen(0, "127.0.0.1", () => {
      closers.push(() => { for (const c of live) { try { c.destroy(); } catch {} } return new Promise((r) => srv.close(() => r())); });
      resolve(srv.address().port);
    });
  });
}

/** An HTTP upstream standing in for a gateway or an add-on's own web service. */
function httpServer(tag = "OK") {
  return new Promise((resolve) => {
    const reqs = [];
    const srv = createHttpServer((req, res) => {
      reqs.push({ url: req.url, method: req.method, headers: req.headers, remote: req.socket.remoteAddress });
      res.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(tag) });
      res.end(tag);
    });
    srv.listen(0, "127.0.0.1", () => {
      closers.push(() => { try { srv.closeAllConnections?.(); } catch {} return new Promise((r) => srv.close(() => r())); });
      resolve({ port: srv.address().port, reqs });
    });
  });
}

/** Send bytes and collect the answer until the peer is quiet or closes. */
function talk(sockPath, first, { timeout = 3000, settle = 80 } = {}) {
  return new Promise((resolve) => {
    const c = connect(sockPath);
    let buf = "";
    let done = false;
    let quiet = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (quiet) clearTimeout(quiet);
      try { c.destroy(); } catch {}
      resolve(buf);
    };
    c.on("connect", () => c.write(first));
    c.on("data", (d) => { buf += d.toString(); if (quiet) clearTimeout(quiet); quiet = setTimeout(finish, settle); });
    c.on("error", finish);
    c.on("close", finish);
    setTimeout(finish, timeout);
  });
}

/** The `o.addon` object, with everything a wall gives an add-on. */
const addonOf = (over = {}) => ({
  id: "media",
  isDoor: () => false,
  internet: false,
  loopback: [],
  hosts: [],
  plainHttpHosts: [],
  selfTargets: { names: [], addrs: [] },
  listenerOwner: async () => ({ kind: "own-uid", pid: 1 }),
  ...over,
});

/** A listed loopback entry the owner typed a URL into (anything else is a manifest default). */
const typed = (entry) => ({ source: "owner", ...entry });

let seq = 0;
async function relay(opts = {}) {
  const logs = [];
  const r = await startEgressRelay({
    dir: join(scratch, "r" + (++seq)), botId: "bot-x", log: (l) => logs.push(l), local: NO_LOCAL, ...opts,
  });
  closers.push(() => r.close());
  return { r, logs };
}

// ---- PORT n: the loopback splice -----------------------------------------

test("a listed port splices raw from the add-on mark, and a WebSocket upgrade passes through", async () => {
  const seen = [];
  const up = await echoServer("E:", (c) => seen.push(c.remoteAddress));
  const { r } = await relay({ addon: addonOf({ loopback: [typed({ port: up })] }) });

  const out = await talk(r.socketPath, `PORT ${up}\nping`);
  assert.match(out, /E:ping$/);
  assert.deepEqual(seen, ["127.0.78.1"], "the splice's upstream socket carries the add-on mark");

  // A browser-CDP-style upgrade is just bytes on a raw splice.
  const upgrade = "GET /json/version HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n";
  const out2 = await talk(r.socketPath, `PORT ${up}\n${upgrade}`);
  assert.ok(out2.includes("Upgrade: websocket"), out2);
  assert.ok(out2.includes("Sec-WebSocket-Version: 13"), out2);
});

test("an unlisted port is closed with an add-on deny line", async () => {
  const { r, logs } = await relay({ addon: addonOf({ loopback: [] }) });
  assert.equal(await talk(r.socketPath, "PORT 8001\nhello"), "");
  const line = logs.find((l) => l.startsWith("[addon-egress] addon=") && l.includes("127.0.0.1:8001"));
  assert.ok(line, logs.join("\n"));
  assert.match(line, /deny 127\.0\.0\.1:8001 \(not in the add-on's loopback list\)$/);
});

test("a listed port whose owner is a gateway is closed, and the listener accepts nothing", async () => {
  let accepted = 0;
  const listener = await echoServer("X:", () => { accepted++; });
  const { r, logs } = await relay({
    addon: addonOf({ loopback: [{ port: listener }], listenerOwner: async () => ({ kind: "denied", reason: "gateway" }) }),
  });
  assert.equal(await talk(r.socketPath, `PORT ${listener}\nhello`), "");
  assert.ok(logs.includes("[addon-egress] addon=media deny 127.0.0.1:" + listener
    + " (a gateway listens there; gateways are reached through doors only)"), logs.join("\n"));
  assert.equal(accepted, 0, "no connection reached the listener");
  // A satellite reads the same way.
  const sat = await relay({
    addon: addonOf({ loopback: [{ port: listener }], listenerOwner: async () => ({ kind: "denied", reason: "satellite" }) }),
  });
  assert.equal(await talk(sat.r.socketPath, `PORT ${listener}\nhello`), "");
  assert.ok(sat.logs.some((l) => l.includes("gateways are reached through doors only")));
});

test("the owner is asked again once the cache window has passed, and not before", async () => {
  const up = await echoServer("E:");
  let calls = 0;
  const owner = async () => {
    calls++;
    return calls === 1 ? { kind: "own-uid", pid: 11 } : { kind: "denied", reason: "nothing listens there" };
  };
  const { r, logs } = await relay({ addon: addonOf({ loopback: [typed({ port: up })], listenerOwner: owner, ownerCacheMs: 200 }) });
  assert.match(await talk(r.socketPath, `PORT ${up}\nfirst`), /E:first$/);
  assert.match(await talk(r.socketPath, `PORT ${up}\nsecond`), /E:second$/);
  assert.equal(calls, 1, "the second splice inside the window used the cached answer");
  await delay(300);
  assert.equal(await talk(r.socketPath, `PORT ${up}\nthird`), "");
  assert.equal(calls, 2, "after the window the owner is asked again");
  assert.ok(logs.some((l) => l.startsWith("[addon-egress] addon=") && l.includes("deny 127.0.0.1:" + up)));
});

test("an ownerProject entry takes only that compose project's published port", async () => {
  const up = await echoServer("E:");
  const one = (owner) => relay({
    addon: addonOf({
      loopback: [typed({ port: 8000, ownerProject: "paperless" })],
      listenerOwner: async () => owner,
    }),
    _connectOverride: () => ({ host: "127.0.0.1", port: up }),
  });

  const foreign = await one({ kind: "docker-publish", project: "other", projectOwner: "media" });
  assert.equal(await talk(foreign.r.socketPath, "PORT 8000\nping"), "");
  assert.ok(foreign.logs.some((l) => l.includes("(published by another compose project)")), foreign.logs.join("\n"));

  const own = await one({ kind: "docker-publish", project: "paperless", projectOwner: "media" });
  assert.match(await talk(own.r.socketPath, "PORT 8000\nping"), /E:ping$/);

  const sameUid = await one({ kind: "own-uid", pid: 12 });
  assert.equal(await talk(sameUid.r.socketPath, "PORT 8000\nping"), "", "own-uid is not a published port");
  assert.ok(sameUid.logs.some((l) => l.includes("(the listener is not published by paperless)")), sameUid.logs.join("\n"));

  // An owner value that is not one slug names no add-on at all.
  const odd = await one({ kind: "docker-publish", project: "paperless", projectOwner: "media:x" });
  assert.equal(await talk(odd.r.socketPath, "PORT 8000\nping"), "", "an owner of no recognisable shape");
  assert.ok(odd.logs.some((l) => l.includes("(foreign project)")), odd.logs.join("\n"));
});

test("a default URL never splices to a process of the same user", async () => {
  const up = await echoServer("E:");
  const one = (entry, owner) => relay({
    addon: addonOf({ loopback: [entry], listenerOwner: async () => owner }),
    _connectOverride: () => ({ host: "127.0.0.1", port: up }),
  });
  for (const entry of [{ port: 8000 }, { port: 8000, source: "default" }, { port: 8000, source: "OWNER" }]) {
    const def = await one(entry, { kind: "own-uid", pid: 21 });
    assert.equal(await talk(def.r.socketPath, "PORT 8000\nping"), "", JSON.stringify(entry));
    assert.ok(def.logs.some((l) => l.includes("(a default URL never reaches a process of this user)")), def.logs.join("\n"));
  }
  // The same port typed by the owner does splice.
  const own = await one(typed({ port: 8000 }), { kind: "own-uid", pid: 21 });
  assert.match(await talk(own.r.socketPath, "PORT 8000\nping"), /E:ping$/);
});

test("a docker-publish owner passes only for the compose project it names", async () => {
  const up = await echoServer("E:");
  const one = (entry, owner) => relay({
    addon: addonOf({ loopback: [entry], listenerOwner: async () => owner }),
    _connectOverride: () => ({ host: "127.0.0.1", port: up }),
  });

  // This add-on's own project: any listed entry for it, named or not.
  const ownProject = { kind: "docker-publish", project: "home-media", projectOwner: "media" };
  const bare = await one(typed({ port: 8000 }), ownProject);
  assert.match(await talk(bare.r.socketPath, "PORT 8000\nping"), /E:ping$/);
  const wrong = await one(typed({ port: 8000, ownerProject: "paperless" }), ownProject);
  assert.equal(await talk(wrong.r.socketPath, "PORT 8000\nping"), "");
  assert.ok(wrong.logs.some((l) => l.includes("(published by another compose project)")), wrong.logs.join("\n"));

  // Another add-on's project (the TTS exception): only the gateway-computed
  // entry for the port that project publishes, never an owner-typed URL.
  const tts = { kind: "docker-publish", project: "media-kokoro", projectOwner: "kokoro-tts" };
  const named = await one({ port: 8000, ownerProject: "media-kokoro", source: "gateway-tts" }, tts);
  assert.match(await talk(named.r.socketPath, "PORT 8000\nping"), /E:ping$/);
  const unnamed = await one(typed({ port: 8000 }), tts);
  assert.equal(await talk(unnamed.r.socketPath, "PORT 8000\nping"), "");
  assert.ok(unnamed.logs.some((l) => l.includes("(published by another add-on's compose project)")), unnamed.logs.join("\n"));
  const ownerTyped = await one(typed({ port: 8000, ownerProject: "media-kokoro" }), tts);
  assert.equal(await talk(ownerTyped.r.socketPath, "PORT 8000\nping"), "", "an owner-typed URL is not the gateway's word");
  const otherProject = await one({ port: 8000, ownerProject: "media-piper", source: "gateway-tts" }, tts);
  assert.equal(await talk(otherProject.r.socketPath, "PORT 8000\nping"), "");

  // An owner answer that names no project owner is a refusal, whatever the entry.
  const unnamedOwner = await one(typed({ port: 8000, ownerProject: "media-kokoro" }), { kind: "docker-publish", project: "media-kokoro" });
  assert.equal(await talk(unnamedOwner.r.socketPath, "PORT 8000\nping"), "");
  assert.ok(unnamedOwner.logs.some((l) => l.includes("(the owner check did not name a compose project)")), unnamedOwner.logs.join("\n"));
});

test("the cross-add-on TTS splice takes only a gateway-computed entry, and only media has one", async () => {
  const up = await echoServer("E:");
  const one = (entry, owner, id = "media") => relay({
    addon: addonOf({ id, loopback: [entry], listenerOwner: async () => owner }),
    _connectOverride: () => ({ host: "127.0.0.1", port: up }),
  });
  const ttsEntry = { port: 8000, ownerProject: "media-kokoro", source: "gateway-tts" };
  const kokoro = { kind: "docker-publish", project: "media-kokoro", projectOwner: "kokoro-tts" };

  // media, the entry the gateway computed, the project it names: spliced.
  const allowed = await one(ttsEntry, kokoro);
  assert.match(await talk(allowed.r.socketPath, "PORT 8000\nping"), /E:ping$/);

  // An add-on's own manifest and an owner-typed URL are never that entry.
  for (const entry of [{ port: 8000, ownerProject: "media-kokoro" }, typed({ port: 8000, ownerProject: "media-kokoro" })]) {
    const denied = await one(entry, kokoro);
    assert.equal(await talk(denied.r.socketPath, "PORT 8000\nping"), "", JSON.stringify(entry));
    assert.ok(denied.logs.some((l) => l.includes("(published by another add-on's compose project)")), denied.logs.join("\n"));
  }

  // Only media does: the exception is re-checked in this relay, not taken
  // from the entry.
  const paperless = await one(ttsEntry, kokoro, "paperless");
  assert.equal(await talk(paperless.r.socketPath, "PORT 8000\nping"), "");
  assert.ok(paperless.logs.some((l) => l.includes("(foreign project)")), paperless.logs.join("\n"));

  // The listener must be the compose project the entry names ...
  const otherProject = await one(ttsEntry, { kind: "docker-publish", project: "media-piper", projectOwner: "kokoro-tts" });
  assert.equal(await talk(otherProject.r.socketPath, "PORT 8000\nping"), "");
  assert.ok(otherProject.logs.some((l) => l.includes("(foreign project)")), otherProject.logs.join("\n"));

  // ... and its owner must be one the table lists for this add-on.
  const notInTable = await one(ttsEntry, { kind: "docker-publish", project: "media-kokoro", projectOwner: "paperless" });
  assert.equal(await talk(notInTable.r.socketPath, "PORT 8000\nping"), "");
  assert.ok(notInTable.logs.some((l) => l.includes("(foreign project)")), notInTable.logs.join("\n"));

  // A gateway-computed entry is only ever for the exception: not even this
  // add-on's own published project, and never a process of this user.
  const ownProject = await one(ttsEntry, { kind: "docker-publish", project: "media-kokoro", projectOwner: "media" });
  assert.equal(await talk(ownProject.r.socketPath, "PORT 8000\nping"), "");
  assert.ok(ownProject.logs.some((l) => l.includes("(foreign project)")), ownProject.logs.join("\n"));
  const ownUid = await one(ttsEntry, { kind: "own-uid", pid: 31 });
  assert.equal(await talk(ownUid.r.socketPath, "PORT 8000\nping"), "");
  assert.ok(ownUid.logs.some((l) => l.includes("(a default URL never reaches a process of this user)")), ownUid.logs.join("\n"));
});

test("an owner check that throws is a deny", async () => {
  const up = await echoServer("E:");
  const { r, logs } = await relay({
    addon: addonOf({ loopback: [typed({ port: up })], listenerOwner: async () => { throw new Error("proc gone"); } }),
  });
  assert.equal(await talk(r.socketPath, `PORT ${up}\nping`), "");
  assert.ok(logs.some((l) => l.includes("(owner check failed)")), logs.join("\n"));
});

// ---- PORT <gatewayPort>: doors, and only the add-on's doors --------------

test("the gateway port serves the add-on's door predicate only, from the add-on mark", async () => {
  const gw = await httpServer("OK");
  const isDoor = (url) => url.startsWith("/api/kiosk/internal/announce");
  const { r } = await relay({ gatewayPort: gw.port, addon: addonOf({ isDoor }) });

  assert.match(await talk(r.socketPath, `PORT ${gw.port}\nGET /api/kiosk/internal/announce HTTP/1.1\r\nHost: x\r\n\r\n`), /^HTTP\/1\.1 200/);
  assert.equal(gw.reqs.at(-1).remote, "127.0.78.1", "the door request carries the add-on mark");
  // A bot door is not an add-on door.
  assert.match(await talk(r.socketPath, `PORT ${gw.port}\nGET /llm/v1/models HTTP/1.1\r\nHost: x\r\n\r\n`), /^HTTP\/1\.1 403/);
  assert.match(await talk(r.socketPath, `PORT ${gw.port}\nGET /secrets/mcp HTTP/1.1\r\nHost: x\r\n\r\n`), /^HTTP\/1\.1 403/);
});

test("the gateway port stays door-filtered even when it is also on the loopback list", async () => {
  const gw = await httpServer("OK");
  let owners = 0;
  const { r } = await relay({
    gatewayPort: gw.port,
    addon: addonOf({
      isDoor: (url) => url.startsWith("/api/kiosk/internal/announce"),
      loopback: [{ port: gw.port }],
      listenerOwner: async () => { owners++; return { kind: "own-uid", pid: 13 }; },
    }),
  });
  assert.match(await talk(r.socketPath, `PORT ${gw.port}\nGET /api/kiosk/internal/announce HTTP/1.1\r\nHost: x\r\n\r\n`), /^HTTP\/1\.1 200/);
  assert.match(await talk(r.socketPath, `PORT ${gw.port}\nGET /llm/v1/models HTTP/1.1\r\nHost: x\r\n\r\n`), /^HTTP\/1\.1 403/);
  assert.equal(owners, 0, "the gateway port is never spliced, so no owner check runs");
});

test("path shapes a door predicate must never reason about are refused first", async () => {
  const gw = await httpServer("OK");
  const { r } = await relay({ gatewayPort: gw.port, addon: addonOf({ isDoor: () => true }) });
  for (const target of ["/a/../b", "/a%2fb", "/a//b", "/a\\b", "*", "http://127.0.0.1/api/kiosk/internal/announce"]) {
    const out = await talk(r.socketPath, `PORT ${gw.port}\nGET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`);
    assert.match(out, /^HTTP\/1\.1 403/, target);
  }
  assert.equal(gw.reqs.length, 0, "nothing reached the gateway");
});

// ---- CONNECT: exact listed entries, and the internet flag ----------------

test("a listed CONNECT entry may be a tailnet address; the same name on 443 is not listed", async () => {
  const up = await echoServer("U:");
  const lookup = async () => [{ address: "100.64.20.5", family: 4 }];
  const listed = await relay({
    lookup,
    addon: addonOf({ hosts: [{ host: "media.other.example.ts.net", port: 8446 }] }),
    _connectOverride: () => ({ host: "127.0.0.1", port: up }),
  });
  const out = await talk(listed.r.socketPath, "PROXY\nCONNECT media.other.example.ts.net:8446 HTTP/1.1\r\nHost: media.other.example.ts.net:8446\r\n\r\nping");
  assert.match(out, /^HTTP\/1\.1 200/);
  assert.match(out, /U:ping$/);
  assert.ok(listed.logs.some((l) => /^\[addon-egress\] addon=media allow media\.other\.example\.ts\.net:8446 \(resolved 100\.64\.20\.5\)$/.test(l)), listed.logs.join("\n"));

  const unlisted = await relay({ lookup, addon: addonOf({ internet: true }) });
  assert.match(await talk(unlisted.r.socketPath, "PROXY\nCONNECT media.other.example.ts.net:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.ok(unlisted.logs.some((l) => l.includes("(tailnet/CGNAT)")), unlisted.logs.join("\n"));
});

test("the internet flag: off denies an unlisted name, on allows it on 443 only", async () => {
  const up = await echoServer("U:");
  const lookup = async () => [{ address: PUB, family: 4 }];

  const off = await relay({ lookup, addon: addonOf({}) });
  assert.match(await talk(off.r.socketPath, "PROXY\nCONNECT example.com:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.ok(off.logs.some((l) => l.includes("(internet not allowed for this add-on)")), off.logs.join("\n"));

  const on = await relay({ lookup, addon: addonOf({ internet: true }), _connectOverride: () => ({ host: "127.0.0.1", port: up }) });
  const out = await talk(on.r.socketPath, "PROXY\nCONNECT example.com:443 HTTP/1.1\r\n\r\nping");
  assert.match(out, /^HTTP\/1\.1 200/);
  assert.match(out, /U:ping$/);

  // In add-on mode an unlisted target is 443 whatever egressPorts says.
  const wide = await relay({ lookup, egressPorts: [80, 443], addon: addonOf({ internet: true }), _connectOverride: () => ({ host: "127.0.0.1", port: up }) });
  assert.match(await talk(wide.r.socketPath, "PROXY\nCONNECT example.com:80 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.ok(wide.logs.some((l) => l.includes("example.com:80 (port not allowed)")), wide.logs.join("\n"));
});

test("own host: a listed name, a resolved own address, and a loopback answer are all refused", async () => {
  const byName = await relay({
    lookup: async () => [{ address: PUB, family: 4 }],
    addon: addonOf({ hosts: [{ host: "crow.example.ts.net", port: 8446 }], selfTargets: { names: ["crow.example.ts.net"], addrs: [] } }),
  });
  assert.match(await talk(byName.r.socketPath, "PROXY\nCONNECT crow.example.ts.net:8446 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.ok(byName.logs.some((l) => l.includes("(own host)")), byName.logs.join("\n"));

  const byAddr = await relay({
    lookup: async () => [{ address: "100.64.20.20", family: 4 }],
    addon: addonOf({ hosts: [{ host: "media.other.example.ts.net", port: 8446 }], selfTargets: { names: [], addrs: ["100.64.20.20"] } }),
  });
  assert.match(await talk(byAddr.r.socketPath, "PROXY\nCONNECT media.other.example.ts.net:8446 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.ok(byAddr.logs.some((l) => l.includes("(own host)")), byAddr.logs.join("\n"));

  const unlisted = await relay({
    lookup: async () => [{ address: "100.64.20.20", family: 4 }],
    addon: addonOf({ internet: true, selfTargets: { names: [], addrs: ["100.64.20.20"] } }),
  });
  assert.match(await talk(unlisted.r.socketPath, "PROXY\nCONNECT example.com:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);

  const loopback = await relay({
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    addon: addonOf({ hosts: [{ host: "media.other.example.ts.net", port: 8446 }] }),
  });
  assert.match(await talk(loopback.r.socketPath, "PROXY\nCONNECT media.other.example.ts.net:8446 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.ok(loopback.logs.some((l) => l.includes("(own host)")), loopback.logs.join("\n"));
});

test("a listed entry still never reaches cloud metadata, bare or v4-mapped", async () => {
  for (const address of ["169.254.169.254", "::ffff:169.254.169.254"]) {
    const { r, logs } = await relay({
      lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
      addon: addonOf({ hosts: [{ host: "media.other.example.ts.net", port: 8446 }] }),
    });
    assert.match(await talk(r.socketPath, "PROXY\nCONNECT media.other.example.ts.net:8446 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/, address);
    assert.ok(logs.some((l) => l.includes("(cloud metadata)")), logs.join("\n"));
  }
});

test("own host in a wrapped or non-canonical spelling is refused, listed or not", async () => {
  const up = await echoServer("U:");
  const unlisted = (address, selfAddrs) => relay({
    lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
    addon: addonOf({ internet: true, selfTargets: { names: [], addrs: selfAddrs } }),
    _connectOverride: () => ({ host: "127.0.0.1", port: up }),
  });
  const listed = (address, selfAddrs) => relay({
    lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
    addon: addonOf({ hosts: [{ host: "media.other.example.ts.net", port: 8446 }], selfTargets: { names: [], addrs: selfAddrs } }),
    _connectOverride: () => ({ host: "127.0.0.1", port: up }),
  });

  // A NAT64 spelling of this host's own IPv4 address.
  const nat64 = await unlisted("64:ff9b::5db8:d822", [PUB]);
  assert.match(await talk(nat64.r.socketPath, "PROXY\nCONNECT example.com:443 HTTP/1.1\r\n\r\nping"), /^HTTP\/1\.1 403/);
  assert.ok(nat64.logs.some((l) => l.includes("(this host)")), nat64.logs.join("\n"));

  // The same IPv6 address in another spelling.
  const spelling = await unlisted("2001:4860::1", ["2001:4860:0:0::1"]);
  assert.match(await talk(spelling.r.socketPath, "PROXY\nCONNECT example.com:443 HTTP/1.1\r\n\r\nping"), /^HTTP\/1\.1 403/);
  assert.ok(spelling.logs.some((l) => l.includes("(this host)")), spelling.logs.join("\n"));

  // A listed entry resolving to the v4-mapped form, dotted and hex.
  for (const address of ["::ffff:" + PUB, "::ffff:5db8:d822"]) {
    const mapped = await listed(address, [PUB]);
    assert.match(await talk(mapped.r.socketPath, "PROXY\nCONNECT media.other.example.ts.net:8446 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/, address);
    assert.ok(mapped.logs.some((l) => /deny media\.other\.example\.ts\.net:8446 \((own host|this host)\)/.test(l)), mapped.logs.join("\n"));
  }
});

test("a listed entry never reaches an IPv4 wrapped in a tunnelled or translated IPv6 address", async () => {
  // The on-link row is what makes the closed-network check soft here, so the
  // hard set (and the embedding rule) is what must refuse.
  const onLink = { ...NO_LOCAL, onLink4: ["169.254.0.0/16"] };
  const cases = [
    ["169.254.169.254", /not allowed for a listed host/],
    ["64:ff9b::a9fe:a9fe", /IPv4 inside IPv6 is not allowed for a listed host/],
    ["2002:a9fe:a9fe::1", /IPv4 inside IPv6 is not allowed for a listed host/],
  ];
  for (const [address, reason] of cases) {
    const { r, logs } = await relay({
      local: onLink,
      lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
      addon: addonOf({ hosts: [{ host: "media.other.example.ts.net", port: 8446 }] }),
    });
    assert.match(await talk(r.socketPath, "PROXY\nCONNECT media.other.example.ts.net:8446 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/, address);
    assert.ok(logs.some((l) => reason.test(l)), address + ": " + logs.join("\n"));
  }
});

// ---- D1: plain HTTP to an exact listed host:port ------------------------

test("plain HTTP: a listed host:port is forwarded, stripped of identity headers, and closed after one request", async () => {
  const upstream = await httpServer("EMB");
  const { r } = await relay({
    addon: addonOf({
      plainHttpHosts: [{ host: "100.64.20.7", port: 8004 }],
      _httpTarget: () => ({ host: "127.0.0.1", port: upstream.port }),
    }),
  });
  const out = await talk(r.socketPath,
    "PROXY\nGET http://100.64.20.7:8004/v1/embeddings HTTP/1.1\r\nHost: 100.64.20.7:8004\r\nX-Forwarded-For: 100.64.20.9\r\nForwarded: for=100.64.20.9\r\n\r\n");
  assert.match(out, /^HTTP\/1\.1 200/);
  assert.match(out, /EMB$/);
  assert.match(out, /connection: close/i);
  assert.equal(upstream.reqs.length, 1);
  assert.equal(upstream.reqs[0].url, "/v1/embeddings");
  assert.equal(upstream.reqs[0].headers.host, "100.64.20.7:8004", "the client's own Host is kept");
  assert.equal(upstream.reqs[0].headers["x-forwarded-for"], undefined, "no forwarded identity reaches the service");
  assert.equal(upstream.reqs[0].headers.forwarded, undefined);

  // Unlisted port: still the 405 every other absolute-form target gets.
  assert.match(await talk(r.socketPath, "PROXY\nGET http://100.64.20.7:8005/v1/embeddings HTTP/1.1\r\nHost: 100.64.20.7:8005\r\n\r\n"), /^HTTP\/1\.1 405/);
});

test("plain HTTP: own host is refused, and a second request on one connection never reaches upstream", async () => {
  const upstream = await httpServer("EMB");
  const self = await relay({
    addon: addonOf({
      plainHttpHosts: [{ host: "crow.example.ts.net", port: 8080 }],
      selfTargets: { names: ["crow.example.ts.net"], addrs: [] },
    }),
  });
  assert.match(await talk(self.r.socketPath, "PROXY\nGET http://crow.example.ts.net:8080/x HTTP/1.1\r\nHost: crow.example.ts.net:8080\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.ok(self.logs.some((l) => l.includes("(own host)")), self.logs.join("\n"));

  const { r } = await relay({
    addon: addonOf({
      plainHttpHosts: [{ host: "100.64.20.7", port: 8004 }],
      _httpTarget: () => ({ host: "127.0.0.1", port: upstream.port }),
    }),
  });
  const out = await talk(r.socketPath,
    "PROXY\nGET http://100.64.20.7:8004/a HTTP/1.1\r\nHost: 100.64.20.7:8004\r\n\r\n"
    + "GET http://100.64.20.7:8004/b HTTP/1.1\r\nHost: 100.64.20.7:8004\r\n\r\n");
  assert.match(out, /^HTTP\/1\.1 200/);
  await delay(150);
  assert.deepEqual(upstream.reqs.map((q) => q.url), ["/a"], "one request per connection");
});

// ---- the deny list the owner's card reads -------------------------------

test("denials() keeps at most twenty refused targets, newest last, as a copy", async () => {
  const { r } = await relay({ lookup: async () => [{ address: "10.1.2.3", family: 4 }], addon: addonOf({ internet: true }) });
  assert.deepEqual(r.denials(), []);
  for (let i = 0; i < 25; i++) await talk(r.socketPath, `PROXY\nCONNECT h${i}.example.com:443 HTTP/1.1\r\n\r\n`);
  const d = r.denials();
  assert.equal(d.length, 20);
  assert.equal(d[0], "h5.example.com:443");
  assert.equal(d[d.length - 1], "h24.example.com:443");
  d.push("planted");
  assert.equal(r.denials().length, 20, "the array is a copy");
});

// ---- bot parity ---------------------------------------------------------

test("without addon the relay is a bot's: PORT 8000 is refused and doors come from the bot mark", async () => {
  const gw = await httpServer("OK");
  const { r, logs } = await relay({ gatewayPort: gw.port, addon: undefined });
  assert.equal(await talk(r.socketPath, "PORT 8000\nhello"), "");
  assert.ok(logs.includes("[pi-egress] bot=bot-x deny 127.0.0.1:8000 (not the bot's gateway port)"), logs.join("\n"));
  assert.deepEqual(r.denials(), [], "a bot relay keeps no add-on deny list");
  assert.match(await talk(r.socketPath, `PORT ${gw.port}\nGET /llm/v1/models HTTP/1.1\r\nHost: x\r\n\r\n`), /^HTTP\/1\.1 200/);
  assert.equal(gw.reqs.at(-1).remote, "127.0.77.1");
});

test("add-on mode: a plain-HTTP request line without the PROXY line is dropped, as for a bot", async () => {
  const { r } = await relay({ addon: addonOf({ plainHttpHosts: [{ host: "100.64.20.7", port: 8004 }] }) });
  const out = await talk(r.socketPath, "GET http://100.64.20.7:8004/x HTTP/1.1\r\nHost: 100.64.20.7:8004\r\n\r\n");
  assert.equal(out, "");
});

// ---- a listed target that resolves to a container on this computer --------

/** An own-host view with no addresses, plus the container-owner seam. */
const containerAddon = (over = {}) => addonOf({
  hosts: [{ host: "svc.example.test", port: 8443 }],
  plainHttpHosts: [{ host: "svc.example.test", port: 8080 }],
  ...over,
});
const containerLookup = async () => [{ address: "172.30.0.5", family: 4 }];

/** Send bytes; resolve when the peer closes, with how long that took. */
function talkUntilClose(sockPath, first, timeout = 4000) {
  return new Promise((resolve) => {
    const c = connect(sockPath);
    let buf = "";
    const t0 = Date.now();
    let done = false;
    const finish = (how) => { if (done) return; done = true; try { c.destroy(); } catch {} resolve({ buf, how, ms: Date.now() - t0 }); };
    c.on("connect", () => c.write(first));
    c.on("data", (d) => { buf += d.toString(); });
    c.on("error", () => finish("error"));
    c.on("close", () => finish("close"));
    setTimeout(() => finish("timeout"), timeout);
  });
}

/** An HTTP upstream that accepts and then goes quiet: nothing at all, or a head and part of a body. */
function hangingServer(mode) {
  return new Promise((resolve) => {
    const srv = createHttpServer((req, res) => {
      if (mode === "body") {
        res.writeHead(200, { "content-type": "text/plain", "content-length": "100" });
        res.write("partial");
      }
    });
    srv.listen(0, "127.0.0.1", () => {
      closers.push(() => { try { srv.closeAllConnections?.(); } catch {} return new Promise((r) => srv.close(() => r())); });
      resolve(srv.address().port);
    });
  });
}

test("a listed CONNECT entry whose address belongs to a foreign container project is refused before any splice", async () => {
  let accepted = 0;
  const up = await echoServer("U:", () => { accepted++; });
  const one = (containerOwner) => relay({
    lookup: containerLookup,
    addon: containerAddon({ containerOwner }),
    _connectOverride: () => ({ host: "127.0.0.1", port: up }),
  });

  const foreign = await one(async () => ({ kind: "denied", reason: "foreign project" }));
  const refused = await talk(foreign.r.socketPath, "PROXY\nCONNECT svc.example.test:8443 HTTP/1.1\r\n\r\n");
  assert.match(refused, /^HTTP\/1\.1 403/);
  assert.ok(foreign.logs.includes("[addon-egress] addon=media deny svc.example.test:8443 (a container on this computer: foreign project)"), foreign.logs.join("\n"));
  assert.equal(accepted, 0, "nothing reached the listed port");

  const own = await one(async () => ({ kind: "docker-container", project: "home-media", projectOwner: "media" }));
  assert.match(await talk(own.r.socketPath, "PROXY\nCONNECT svc.example.test:8443 HTTP/1.1\r\n\r\nping"), /U:ping$/);

  // A LAN address that belongs to no container is an ordinary listed target.
  const notAContainer = await one(async () => ({ kind: "not-container" }));
  assert.match(await talk(notAContainer.r.socketPath, "PROXY\nCONNECT svc.example.test:8443 HTTP/1.1\r\n\r\nping"), /U:ping$/);
});

test("a listed plain-HTTP entry whose address belongs to a foreign container project is refused before any request", async () => {
  const upstream = await httpServer("EMB");
  const one = (containerOwner) => relay({
    lookup: containerLookup,
    addon: containerAddon({ containerOwner, _httpTarget: () => ({ host: "127.0.0.1", port: upstream.port }) }),
  });
  const request = "PROXY\nGET http://svc.example.test:8080/embeddings HTTP/1.1\r\nHost: svc.example.test:8080\r\n\r\n";

  const foreign = await one(async () => ({ kind: "denied", reason: "foreign project" }));
  assert.match(await talk(foreign.r.socketPath, request), /^HTTP\/1\.1 403/);
  assert.ok(foreign.logs.includes("[addon-egress] addon=media deny svc.example.test:8080 (a container on this computer: foreign project)"), foreign.logs.join("\n"));
  assert.equal(upstream.reqs.length, 0, "nothing reached the listed port");

  const own = await one(async () => ({ kind: "docker-container", project: "home-media", projectOwner: "media" }));
  assert.match(await talk(own.r.socketPath, request), /^HTTP\/1\.1 200/);
  assert.equal(upstream.reqs.length, 1);

  const notAContainer = await one(async () => ({ kind: "not-container" }));
  assert.match(await talk(notAContainer.r.socketPath, request), /^HTTP\/1\.1 200/);
  assert.equal(upstream.reqs.length, 2);
});

test("without a container view a bridge address is refused and a LAN address is not", async () => {
  let accepted = 0;
  const up = await echoServer("U:", () => { accepted++; });
  const ifaces = {
    lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4" }],
    docker0: [{ address: "172.30.0.1", netmask: "255.255.0.0", family: "IPv4" }],
  };
  const one = (address) => relay({
    lookup: async () => [{ address, family: 4 }],
    addon: containerAddon({ _interfaces: ifaces }),
    _connectOverride: () => ({ host: "127.0.0.1", port: up }),
  });

  const bridge = await one("172.30.0.5");
  assert.match(await talk(bridge.r.socketPath, "PROXY\nCONNECT svc.example.test:8443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.ok(bridge.logs.includes("[addon-egress] addon=media deny svc.example.test:8443 (a container on this computer: no container view)"), bridge.logs.join("\n"));
  assert.equal(accepted, 0);

  const lan = await one("10.20.30.7");
  assert.match(await talk(lan.r.socketPath, "PROXY\nCONNECT svc.example.test:8443 HTTP/1.1\r\n\r\nping"), /U:ping$/);
});

test("a container-owner answer that throws is a refusal, and the answer is kept for the cache window", async () => {
  let calls = 0;
  const up = await echoServer("U:");
  const { r, logs } = await relay({
    lookup: containerLookup,
    addon: containerAddon({ containerOwner: async () => { calls++; throw new Error("docker socket gone"); } }),
    _connectOverride: () => ({ host: "127.0.0.1", port: up }),
  });
  for (let i = 0; i < 2; i++) {
    assert.match(await talk(r.socketPath, "PROXY\nCONNECT svc.example.test:8443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  }
  assert.equal(calls, 1, "the second decision inside the window reused the answer");
  assert.ok(logs.includes("[addon-egress] addon=media deny svc.example.test:8443 (a container on this computer: owner check failed)"), logs.join("\n"));
  // An answer that is not an object is the same refusal.
  const odd = await relay({
    lookup: containerLookup,
    addon: containerAddon({ containerOwner: async () => null }),
  });
  assert.match(await talk(odd.r.socketPath, "PROXY\nCONNECT svc.example.test:8443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.ok(odd.logs.some((l) => l.includes("(a container on this computer: owner check failed)")), odd.logs.join("\n"));
  // An object of an unknown kind passes nothing either: only the two passing kinds pass.
  const unknown = await relay({
    lookup: containerLookup,
    addon: containerAddon({ containerOwner: async () => ({ kind: "maybe" }) }),
  });
  assert.match(await talk(unknown.r.socketPath, "PROXY\nCONNECT svc.example.test:8443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.ok(unknown.logs.some((l) => l.includes("(a container on this computer: owner check failed)")), unknown.logs.join("\n"));
});

// ---- the plain-HTTP stall timeout ----------------------------------------

test("a plain-HTTP upstream that accepts and never answers is cut, and its slot is freed", async () => {
  const silent = await hangingServer("head");
  const responsive = await httpServer("LATE");
  let target = { host: "127.0.0.1", port: silent };
  const { r, logs } = await relay({
    maxUpstream: 1,
    plainStallMs: 200,
    addon: addonOf({ plainHttpHosts: [{ host: "100.64.20.7", port: 8004 }], _httpTarget: () => target }),
  });
  const request = "PROXY\nGET http://100.64.20.7:8004/x HTTP/1.1\r\nHost: 100.64.20.7:8004\r\n\r\n";

  const t0 = Date.now();
  const out = await talk(r.socketPath, request, { timeout: 2000, settle: 40 });
  assert.ok(Date.now() - t0 < 2000, "the answer arrived well inside the bound");
  assert.match(out, /^HTTP\/1\.1 502/);
  assert.ok(logs.some((l) => l.includes("(upstream ETIMEDOUT)")), logs.join("\n"));

  target = { host: "127.0.0.1", port: responsive.port };
  assert.match(await talk(r.socketPath, request), /^HTTP\/1\.1 200/);
  assert.equal(responsive.reqs.length, 1, "the slot the stalled request held is free again");
});

test("a plain-HTTP upstream that sends headers and then stalls the body has its client connection closed", async () => {
  const stalled = await hangingServer("body");
  const responsive = await httpServer("LATE");
  let target = { host: "127.0.0.1", port: stalled };
  const { r, logs } = await relay({
    maxUpstream: 1,
    plainStallMs: 200,
    addon: addonOf({ plainHttpHosts: [{ host: "100.64.20.7", port: 8004 }], _httpTarget: () => target }),
  });
  const request = "PROXY\nGET http://100.64.20.7:8004/x HTTP/1.1\r\nHost: 100.64.20.7:8004\r\n\r\n";

  const first = await talkUntilClose(r.socketPath, request);
  assert.notEqual(first.how, "timeout", "the client connection did not outlive the bound");
  assert.ok(first.ms < 2000, "the connection closed inside the bound");
  assert.match(first.buf, /^HTTP\/1\.1 200/);
  assert.match(first.buf, /partial/);
  assert.ok(logs.some((l) => l.includes("(upstream ETIMEDOUT)")), logs.join("\n"));

  target = { host: "127.0.0.1", port: responsive.port };
  assert.match(await talk(r.socketPath, request), /^HTTP\/1\.1 200/);
  assert.equal(responsive.reqs.length, 1, "the slot the stalled body held is free again");
});
