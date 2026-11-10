/**
 * The listener-owner check an add-on's relay asks before it splices a loopback
 * port (review item 7): who is behind `127.0.0.1:<port>`?
 *
 * Pure cases inject the /proc text, the fd links, the argv/cwd/exe and the
 * docker view, so no rule depends on the machine running the suite: the roots a
 * same-uid listener must stay outside of and the wall's own pids are fixtures
 * too. One real case starts a stub at `<scratch>/servers/gateway/index.js`,
 * which the kernel's own tables identify as a gateway, and shows the relay
 * refusing its port.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { identifyListener } from "../scripts/addon-sandbox/listener-owner.mjs";
import { startEgressRelay } from "../scripts/pi-bots/pi_egress.mjs";
import { parseIPv6 } from "../servers/shared/ip-classify.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "crow-addon-owner-")));
const NO_LOCAL = { v4: [], v6: [], onLink4: [], onLink6: [], v4Failed: false, v6Failed: false, onLinkFailed: false };
after(() => rmSync(scratch, { recursive: true, force: true }));

// ---- /proc fixtures ------------------------------------------------------

const HEAD = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

/** A little-endian hex IPv4 field, as /proc/net/tcp prints it (127.0.0.1 -> 0100007F). */
const field4 = (addr) => addr.split(".").reverse().map((o) => Number(o).toString(16).padStart(2, "0")).join("").toUpperCase();

/** A 32-char IPv6 field: four little-endian 32-bit words. */
function field6(addr) {
  const groups = parseIPv6(addr);
  const bytes = [];
  for (const g of groups) bytes.push(g >> 8, g & 255);
  let out = "";
  for (let w = 0; w < 4; w++) {
    const [b0, b1, b2, b3] = bytes.slice(w * 4, w * 4 + 4);
    out += [b3, b2, b1, b0].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return out.toUpperCase();
}

const portHex = (port) => port.toString(16).padStart(4, "0").toUpperCase();

/** One /proc/net/tcp{,6} row (columns: sl, local, rem, st, …, uid at 7, inode at 9). */
function row(local, { st = "0A", uid = 1000, inode = 1, sl = 0 } = {}) {
  return `  ${sl}: ${local} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000 ${uid}        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
}
const v4row = (addr, port, opts) => row(field4(addr) + ":" + portHex(port), opts);
const v6row = (addr, port, opts) => row(field6(addr) + ":" + portHex(port), opts);
const table = (...rows) => [HEAD, ...rows].join("\n");

/** A fake /proc tree: the two net tables, plus one entry per process (fds, cmdline, cwd, exe). */
function fakeProc({ tcp = table(), tcp6 = table(), procs = [] } = {}) {
  const files = new Map([["/proc/net/tcp", tcp], ["/proc/net/tcp6", tcp6]]);
  const links = new Map();
  const dirs = new Map([["/proc", procs.map((p) => String(p.pid))]]);
  for (const p of procs) {
    const fdDir = "/proc/" + p.pid + "/fd";
    const inodes = Array.isArray(p.inodes) ? p.inodes : [];
    dirs.set(fdDir, inodes.map((_, i) => String(i + 3)));
    inodes.forEach((inode, i) => links.set(fdDir + "/" + (i + 3), "socket:[" + inode + "]"));
    files.set("/proc/" + p.pid + "/cmdline", (p.argv || []).join("\0") + "\0");
    if (p.cwd) links.set("/proc/" + p.pid + "/cwd", p.cwd);
    // `<pid>/exe` is a link too; `exe: null` leaves it unreadable.
    const exe = p.exe === undefined ? "/usr/bin/node" : p.exe;
    if (exe) links.set("/proc/" + p.pid + "/exe", exe);
  }
  const miss = () => { throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }); };
  return {
    readFile: (path) => (files.has(path) ? files.get(path) : miss()),
    readdir: (path) => (dirs.has(path) ? dirs.get(path) : miss()),
    readlink: (path) => (links.has(path) ? links.get(path) : miss()),
  };
}

const GW_UID = 1000;
const PORT = 8300;
const SOCK = 4242;

/** This Crow's two roots, as the caller passes them (lexical and real spellings). */
const CROW_APP_ROOT = "/home/alex/crow";
const CROW_HOME = "/home/alex/.crow";
const ROOTS = [CROW_APP_ROOT, CROW_HOME];

/** Compose project -> add-on id, as the gateway passes it (installed add-ons only). */
const INSTALLED = new Map([
  ["home-paperless", "paperless"],
  ["home-media", "media"],
  ["media-kokoro", "kokoro-tts"],
  ["media-piper", "piper"],
  ["home-funkwhale", "funkwhale"],
]);

// ---- a gateway uid socket -------------------------------------------------

test("a gateway process is refused, in this checkout and in a co-hosted one", async () => {
  const p = fakeProc({
    tcp: table(v4row("127.0.0.1", PORT, { uid: GW_UID, inode: SOCK })),
    procs: [{ pid: 500, inodes: [SOCK], cwd: "/home/alex/crow", argv: ["/usr/bin/node", "servers/gateway/index.js"] }],
  });
  const r = await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, ...p });
  assert.equal(r.kind, "denied");
  assert.equal(r.reason, "gateway");
  assert.equal(r.uid, GW_UID);
  assert.equal(r.inode, String(SOCK));

  // An absolute argv element from another checkout is the same process class.
  const other = fakeProc({
    tcp: table(v4row("127.0.0.1", PORT, { uid: GW_UID, inode: SOCK })),
    procs: [{ pid: 501, inodes: [SOCK], cwd: "/", argv: ["node", "/srv/crow-b/servers/gateway/index.js"] }],
  });
  assert.equal((await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, ...other })).reason, "gateway");

  // A checkout that IS one of the Crow roots still reads as a gateway: those
  // two reasons are named before any same-uid rule.
  const own = await identifyListener("127.0.0.1", PORT, {
    gatewayUid: GW_UID, crowRoots: ROOTS,
    ...fakeProc({
      tcp: table(v4row("127.0.0.1", PORT, { uid: GW_UID, inode: SOCK })),
      procs: [{ pid: 502, inodes: [SOCK], cwd: CROW_APP_ROOT, argv: ["node", "servers/gateway/index.js"] }],
    }),
  });
  assert.deepEqual([own.kind, own.reason], ["denied", "gateway"]);
});

test("a satellite process is refused", async () => {
  const p = fakeProc({
    tcp: table(v4row("127.0.0.1", PORT, { uid: GW_UID, inode: SOCK })),
    procs: [{ pid: 600, inodes: [SOCK], cwd: "/opt/crow", argv: ["node", "servers/satellite/index.js"] }],
  });
  const r = await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, ...p });
  assert.deepEqual([r.kind, r.reason], ["denied", "satellite"]);
});

test("any other process of the same uid, outside this Crow, is the add-on's own service", async () => {
  const p = fakeProc({
    tcp: table(v4row("127.0.0.1", PORT, { uid: GW_UID, inode: SOCK })),
    procs: [{ pid: 700, inodes: [SOCK], cwd: "/srv/app", argv: ["node", "server.mjs"] }],
  });
  const r = await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, ...p, crowRoots: ROOTS });
  assert.equal(r.kind, "own-uid");
  assert.equal(r.pid, 700);
  assert.equal(r.inode, String(SOCK));
});

test("an inode that maps to no process is refused", async () => {
  const p = fakeProc({
    tcp: table(v4row("127.0.0.1", PORT, { uid: GW_UID, inode: SOCK })),
    procs: [{ pid: 800, inodes: [999999], cwd: "/srv/app", argv: ["node", "server.mjs"] }],
  });
  const r = await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, ...p });
  assert.deepEqual([r.kind, r.reason], ["denied", "unmapped"]);
  // A process table that cannot be read at all is the same refusal.
  const blind = { ...p, readdir: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } };
  assert.deepEqual([(await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, ...blind })).kind], ["denied"]);
});

// ---- a root socket: docker decides ---------------------------------------

test("a root-owned socket no container publishes is refused (the tailscaled case)", async () => {
  const p = fakeProc({ tcp: table(v4row("127.0.0.1", PORT, { uid: 0, inode: 900 })) });
  assert.deepEqual([(await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, ...p, docker: async () => [] })).reason],
    ["no container publishes it"]);
  // A publish on another port says nothing about this one.
  const elsewhere = async () => [{ hostIp: "127.0.0.1", hostPort: PORT + 1, project: "paperless" }];
  assert.equal((await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, ...p, docker: elsewhere })).reason, "no container publishes it");
  // No docker view at all is a refusal, never a pass.
  assert.equal((await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, ...p })).reason, "no docker view");
});

test("a root socket a container publishes is a published port, with its project and its owner", async () => {
  const p = fakeProc({ tcp: table(v4row("127.0.0.1", PORT, { uid: 0, inode: 900 })) });
  for (const hostIp of ["127.0.0.1", "0.0.0.0", "::", ""]) {
    const docker = async () => [{ hostIp, hostPort: PORT, project: "home-paperless" }];
    const r = await identifyListener("127.0.0.1", PORT, {
      gatewayUid: GW_UID, ...p, docker, addonId: "paperless", addonProjects: INSTALLED,
    });
    assert.equal(r.kind, "docker-publish", hostIp || "(empty)");
    assert.equal(r.project, "home-paperless");
    assert.equal(r.projectOwner, "paperless");
  }
});

test("a port published by another installed add-on's project is refused", async () => {
  const p = fakeProc({ tcp: table(v4row("127.0.0.1", PORT, { uid: 0, inode: 900 })) });
  const docker = async () => [{ hostIp: "127.0.0.1", hostPort: PORT, project: "otherproj" }];
  const r = await identifyListener("127.0.0.1", PORT, {
    gatewayUid: GW_UID, ...p, docker, addonId: "media", addonProjects: new Map([["otherproj", "funkwhale"]]),
  });
  assert.deepEqual([r.kind, r.reason], ["denied", "foreign project"]);
  // The same project mapped to this add-on is fine (a re-entered value).
  const own = await identifyListener("127.0.0.1", PORT, {
    gatewayUid: GW_UID, ...p, docker, addonId: "media", addonProjects: new Map([["otherproj", "media"]]),
  });
  assert.equal(own.kind, "docker-publish");
  assert.equal(own.projectOwner, "media");
});

test("a published port with no compose project label is refused", async () => {
  const p = fakeProc({ tcp: table(v4row("127.0.0.1", PORT, { uid: 0, inode: 900 })) });
  for (const project of ["", "   ", null, undefined]) {
    const docker = async () => [{ hostIp: "127.0.0.1", hostPort: PORT, project }];
    const r = await identifyListener("127.0.0.1", PORT, {
      gatewayUid: GW_UID, ...p, docker, addonId: "paperless", addonProjects: INSTALLED,
    });
    assert.deepEqual([r.kind, r.reason], ["denied", "unlabelled project"], String(project));
  }
});

test("a project no installed add-on owns is refused", async () => {
  const p = fakeProc({ tcp: table(v4row("127.0.0.1", PORT, { uid: 0, inode: 900 })) });
  const docker = async () => [{ hostIp: "127.0.0.1", hostPort: PORT, project: "mystery-1" }];
  const r = await identifyListener("127.0.0.1", PORT, {
    gatewayUid: GW_UID, ...p, docker, addonId: "paperless", addonProjects: INSTALLED,
  });
  assert.deepEqual([r.kind, r.reason], ["denied", "project of no installed add-on"]);
  // With no installed-add-on map at all, every project is unknown.
  const blind = await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, ...p, docker, addonId: "paperless" });
  assert.deepEqual([blind.kind, blind.reason], ["denied", "project of no installed add-on"]);
});

test("only the add-on's own compose project passes, and it names its owner", async () => {
  const p = fakeProc({ tcp: table(v4row("127.0.0.1", PORT, { uid: 0, inode: 900 })) });
  const docker = async () => [{ hostIp: "127.0.0.1", hostPort: PORT, project: "home-paperless" }];
  const own = await identifyListener("127.0.0.1", PORT, {
    gatewayUid: GW_UID, ...p, docker, addonId: "paperless", addonProjects: INSTALLED,
  });
  assert.deepEqual([own.kind, own.project, own.projectOwner], ["docker-publish", "home-paperless", "paperless"]);
  // Another add-on reaching the same port: a foreign project.
  const media = await identifyListener("127.0.0.1", PORT, {
    gatewayUid: GW_UID, ...p, docker, addonId: "media", addonProjects: INSTALLED,
  });
  assert.deepEqual([media.kind, media.reason], ["denied", "foreign project"]);
});

test("media reaches the TTS add-ons' published ports and nothing else through the one named exception", async () => {
  const p = fakeProc({ tcp: table(v4row("127.0.0.1", PORT, { uid: 0, inode: 900 })) });
  for (const [project, tts] of [["media-kokoro", "kokoro-tts"], ["media-piper", "piper"]]) {
    const docker = async () => [{ hostIp: "127.0.0.1", hostPort: PORT, project }];
    const viaMedia = await identifyListener("127.0.0.1", PORT, {
      gatewayUid: GW_UID, ...p, docker, addonId: "media", addonProjects: INSTALLED,
    });
    assert.deepEqual([viaMedia.kind, viaMedia.project, viaMedia.projectOwner], ["docker-publish", project, tts], tts);
    // The exception is media's alone.
    const viaPaperless = await identifyListener("127.0.0.1", PORT, {
      gatewayUid: GW_UID, ...p, docker, addonId: "paperless", addonProjects: INSTALLED,
    });
    assert.deepEqual([viaPaperless.kind, viaPaperless.reason], ["denied", "foreign project"], tts);
  }
  // A TTS add-on's project is no general licence: another add-on's project is
  // still only its own add-on's to reach.
  const docker = async () => [{ hostIp: "127.0.0.1", hostPort: PORT, project: "home-funkwhale" }];
  const funkwhale = await identifyListener("127.0.0.1", PORT, {
    gatewayUid: GW_UID, ...p, docker, addonId: "media", addonProjects: INSTALLED,
  });
  assert.deepEqual([funkwhale.kind, funkwhale.reason], ["denied", "foreign project"]);
});

test("two projects publishing one port, and a failing docker view, are both refusals", async () => {
  const p = fakeProc({ tcp: table(v4row("127.0.0.1", PORT, { uid: 0, inode: 900 })) });
  const two = async () => [
    { hostIp: "127.0.0.1", hostPort: PORT, project: "a" },
    { hostIp: "::", hostPort: PORT, project: "b" },
  ];
  assert.equal((await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, ...p, docker: two })).reason, "published by more than one project");
  const boom = async () => { throw new Error("docker socket gone"); };
  assert.equal((await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, ...p, docker: boom })).reason, "owner check failed");
});

// ---- any other uid -------------------------------------------------------

test("a socket owned by a third uid is refused (the Caddy case)", async () => {
  const p = fakeProc({ tcp: table(v4row("127.0.0.1", PORT, { uid: 997, inode: 901 })) });
  const r = await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, ...p, docker: async () => [{ hostIp: "127.0.0.1", hostPort: PORT, project: "x" }] });
  assert.deepEqual([r.kind, r.reason, r.uid], ["denied", "other uid", 997]);
});

// ---- finding the listener ------------------------------------------------

test("no listener is a refusal; another port, a connected socket and another address are not this port", async () => {
  const p = fakeProc({
    tcp: table(
      v4row("127.0.0.1", PORT + 1, { uid: GW_UID, inode: SOCK }),
      v4row("127.0.0.1", PORT, { uid: GW_UID, inode: 4243, st: "01" }),
      v4row("10.20.30.40", PORT, { uid: GW_UID, inode: 4244 }),
    ),
    procs: [{ pid: 500, inodes: [SOCK, 4243, 4244], cwd: "/srv/app", argv: ["node", "server.mjs"] }],
  });
  assert.deepEqual([(await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, ...p })).reason], ["nothing listens there"]);
  // The one on PORT+1 is that port's listener, not this one's.
  assert.equal((await identifyListener("127.0.0.1", PORT + 1, { gatewayUid: GW_UID, crowRoots: ROOTS, ...p })).kind, "own-uid");
});

test("a wildcard listener answers loopback, in both families; every matching listener must pass", async () => {
  const wild = fakeProc({
    tcp: table(v4row("0.0.0.0", PORT, { uid: GW_UID, inode: SOCK })),
    tcp6: table(v6row("::", PORT, { uid: GW_UID, inode: SOCK })),
    procs: [{ pid: 700, inodes: [SOCK], cwd: "/srv/app", argv: ["node", "server.mjs"] }],
  });
  assert.equal((await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, crowRoots: ROOTS, ...wild })).kind, "own-uid");
  // 0.0.0.0 plus a gateway on ::ffff:127.0.0.1: the gateway wins.
  const mixed = fakeProc({
    tcp: table(v4row("0.0.0.0", PORT, { uid: GW_UID, inode: SOCK })),
    tcp6: table(v6row("::ffff:127.0.0.1", PORT, { uid: GW_UID, inode: 4245 })),
    procs: [
      { pid: 700, inodes: [SOCK], cwd: "/srv/app", argv: ["node", "server.mjs"] },
      { pid: 701, inodes: [4245], cwd: "/srv/app", argv: ["node", "servers/gateway/index.js"] },
    ],
  });
  assert.equal((await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, crowRoots: ROOTS, ...mixed })).reason, "gateway");
  // An IPv6 loopback listener is found by its own spelling.
  const v6 = fakeProc({
    tcp6: table(v6row("::1", PORT, { uid: GW_UID, inode: SOCK })),
    procs: [{ pid: 700, inodes: [SOCK], cwd: "/srv/app", argv: ["node", "server.mjs"] }],
  });
  const r = await identifyListener("::1", PORT, { gatewayUid: GW_UID, crowRoots: ROOTS, ...v6 });
  assert.equal(r.kind, "own-uid");
  assert.equal(r.reason, undefined);
});

test("a port outside 1..65535 is refused rather than looked up", async () => {
  for (const port of [0, -1, 70000, 1.5, "x"]) {
    const r = await identifyListener("127.0.0.1", port, { gatewayUid: GW_UID, ...fakeProc() });
    assert.equal(r.kind, "denied", String(port));
  }
});

// ---- a same-uid listener: this Crow's own code, or the wall's ----------------

/** One same-uid listener process; each case varies where its paths point. */
const ownUidProc = (p = {}) => fakeProc({
  tcp: table(v4row("127.0.0.1", PORT, { uid: GW_UID, inode: SOCK })),
  procs: [{ pid: 700, inodes: [SOCK], cwd: "/srv/app", argv: ["/usr/bin/node", "server.mjs"], ...p }],
});

/** Ask about that one listener. */
const askOwnUid = (opts, p = {}) => identifyListener("127.0.0.1", PORT, {
  gatewayUid: GW_UID, selfPids: [1], crowRoots: ROOTS, ...ownUidProc(p), ...opts,
});

test("a process whose argv, cwd or executable lies under this Crow is Crow's own code", async () => {
  const cases = [
    { what: "a bundle's MCP server", cwd: "/srv/app", argv: ["/usr/bin/node", CROW_HOME + "/bundles/x/server/index.js"] },
    { what: "a phone runner under the checkout's scripts", cwd: CROW_APP_ROOT + "/scripts/phone", argv: ["/usr/bin/node", "runner.mjs"] },
    { what: "a cwd in the Crow home", cwd: CROW_HOME, argv: ["/usr/bin/node", "/opt/app/server.mjs"] },
    { what: "an executable in the Crow home", cwd: "/srv/app", argv: ["/usr/bin/node", "/opt/app/server.mjs"], exe: CROW_HOME + "/bundles/x/bin/node" },
    { what: "the root itself", cwd: CROW_APP_ROOT, argv: ["/usr/bin/node", "/opt/app/server.mjs"] },
  ];
  for (const c of cases) {
    const r = await askOwnUid({}, c);
    assert.deepEqual([r.kind, r.reason], ["denied", "Crow's own code"], c.what);
  }
  // A sibling directory whose name merely starts with the root's is not under it.
  const sibling = await askOwnUid({ crowRoots: ["/srv/crow"] }, {
    cwd: "/srv/crow-other", argv: ["/usr/bin/node", "/srv/crow-other/app.js"],
  });
  assert.equal(sibling.kind, "own-uid");
  assert.equal(sibling.pid, 700);
  // Real and lexical spellings both count when the caller passes both.
  const real = await askOwnUid({ crowRoots: ["/srv/crow-link", "/srv/crow-real"] }, {
    cwd: "/srv/app", argv: ["/usr/bin/node", "/srv/crow-real/servers/memory/index.js"],
  });
  assert.deepEqual([real.kind, real.reason], ["denied", "Crow's own code"]);
});

test("the relay's own process and the wall's helpers are refused", async () => {
  // selfPids defaults to this process.
  const selfDefault = await askOwnUid({ selfPids: undefined }, { pid: process.pid });
  assert.deepEqual([selfDefault.kind, selfDefault.reason], ["denied", "the wall's own process"]);
  const named = await askOwnUid({ selfPids: [700, 1] });
  assert.deepEqual([named.kind, named.reason], ["denied", "the wall's own process"]);
  // The netns entry point, wherever in argv it appears.
  const entry = await askOwnUid({}, { cwd: "/srv/wall", argv: ["/usr/bin/node", "/srv/wall/pi_netns_entry.mjs"] });
  assert.deepEqual([entry.kind, entry.reason], ["denied", "the wall's own process"]);
  // bwrap as argv[0].
  const bwrap = await askOwnUid({}, { cwd: "/srv/wall", argv: ["/usr/bin/bwrap", "--unshare-net", "/usr/bin/node", "x.mjs"] });
  assert.deepEqual([bwrap.kind, bwrap.reason], ["denied", "the wall's own process"]);
});

test("with no Crow root to compare against, every same-uid listener is refused", async () => {
  const saved = [process.env.CROW_APP_ROOT, process.env.CROW_HOME];
  const restore = () => ["CROW_APP_ROOT", "CROW_HOME"].forEach((k, i) => {
    if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i];
  });
  try {
    delete process.env.CROW_APP_ROOT;
    delete process.env.CROW_HOME;
    const noEnv = await askOwnUid({ crowRoots: undefined });
    assert.deepEqual([noEnv.kind, noEnv.reason], ["denied", "no Crow roots to check against"]);
    const empty = await askOwnUid({ crowRoots: [] });
    assert.deepEqual([empty.kind, empty.reason], ["denied", "no Crow roots to check against"]);
    // With no list passed, the env names the roots.
    process.env.CROW_APP_ROOT = "/srv/crow-env";
    const fromEnv = await askOwnUid({ crowRoots: undefined }, {
      cwd: "/srv/crow-env/scripts/phone", argv: ["/usr/bin/node", "runner.mjs"],
    });
    assert.deepEqual([fromEnv.kind, fromEnv.reason], ["denied", "Crow's own code"]);
  } finally { restore(); }
});

test("a same-uid listener whose cwd or executable cannot be read is refused", async () => {
  const noExe = await askOwnUid({}, { exe: null });
  assert.deepEqual([noExe.kind, noExe.reason], ["denied", "owner check failed"]);
  const noCwd = await askOwnUid({}, { cwd: undefined });
  assert.deepEqual([noCwd.kind, noCwd.reason], ["denied", "owner check failed"]);
});

// ---- one real case, through the kernel's own tables ----------------------

/** Send one line and collect whatever comes back until the relay closes. */
function talk(sockPath, first, timeout = 3000) {
  return new Promise((resolve) => {
    const c = connect(sockPath);
    let buf = "";
    let done = false;
    const finish = () => { if (done) return; done = true; try { c.destroy(); } catch {} resolve(buf); };
    c.on("connect", () => c.write(first));
    c.on("data", (d) => { buf += d.toString(); setTimeout(finish, 50); });
    c.on("error", finish);
    c.on("close", finish);
    setTimeout(finish, timeout);
  });
}

test("a real gateway stub is identified through /proc, and the relay refuses its port", async (t) => {
  try { readFileSync("/proc/net/tcp", "utf8"); } catch { t.skip("/proc/net/tcp is not readable here"); return; }
  const dir = join(scratch, "real");
  mkdirSync(join(dir, "servers", "gateway"), { recursive: true });
  const stub = join(dir, "servers", "gateway", "index.js");
  writeFileSync(stub, [
    'import { createServer } from "node:net";',
    "const srv = createServer((c) => c.end());",
    'srv.listen(0, "127.0.0.1", () => { process.stdout.write(String(srv.address().port) + "\\n"); });',
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  const child = spawn(process.execPath, [stub], { stdio: ["ignore", "pipe", "ignore"] });
  let port = 0;
  try {
    port = await new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error("the gateway stub never printed its port")), 5000);
      child.stdout.on("data", (d) => {
        out += d.toString();
        const nl = out.indexOf("\n");
        if (nl < 0) return;
        clearTimeout(timer);
        resolve(Number(out.slice(0, nl)));
      });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    assert.ok(Number.isInteger(port) && port > 0, "the stub is listening on an ephemeral port");

    // The roots here must not cover the scratch dir, so it is the gateway rule
    // (not "Crow's own code") that refuses this listener.
    const owner = await identifyListener("127.0.0.1", port, { crowRoots: ["/srv/crow-elsewhere"] });
    if (owner.kind === "denied" && (owner.reason === "unmapped" || owner.reason === "nothing listens there")) {
      t.skip("this environment hides the process table: " + owner.reason);
      return;
    }
    assert.equal(owner.kind, "denied", JSON.stringify(owner));
    assert.equal(owner.reason, "gateway");

    // The relay refuses the port even though it is on the add-on's loopback list.
    const logs = [];
    const relay = await startEgressRelay({
      dir: join(scratch, "real-relay"), local: NO_LOCAL, log: (l) => logs.push(l),
      addon: { id: "paperless", loopback: [{ port, source: "owner" }],
        listenerOwner: (a, p) => identifyListener(a, p, { crowRoots: ["/srv/crow-elsewhere"] }) },
    });
    try {
      assert.equal(await talk(relay.socketPath, `PORT ${port}\nhello`), "", "the connection is closed");
      assert.ok(logs.some((l) => l === `[addon-egress] addon=paperless deny 127.0.0.1:${port} (a gateway listens there; gateways are reached through doors only)`), logs.join("\n"));
    } finally { await relay.close(); }
  } finally {
    try { child.kill("SIGKILL"); } catch {}
  }
});
test("an own process and a container on the same port: neither answer is trusted", async () => {
  const p = fakeProc({
    tcp: table(v4row("127.0.0.1", PORT, { uid: GW_UID, inode: SOCK }), v4row("0.0.0.0", PORT, { uid: 0, inode: 901, sl: 1 })),
    procs: [{ pid: 700, inodes: [SOCK], cwd: "/srv/app", argv: ["node", "server.mjs"] }],
  });
  const r = await identifyListener("127.0.0.1", PORT, {
    gatewayUid: GW_UID, ...p, crowRoots: ROOTS, addonId: "media", addonProjects: INSTALLED,
    docker: async () => [{ hostIp: "0.0.0.0", hostPort: PORT, project: "home-media" }],
  });
  assert.deepEqual([r.kind, r.reason], ["denied", "more than one listener owner"]);
});
