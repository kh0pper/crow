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
import { createDockerView } from "../scripts/addon-sandbox/docker-view.mjs";
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
    // `argv: undefined` leaves the cmdline unreadable; `argv: []` is an empty one.
    if (Array.isArray(p.argv)) files.set("/proc/" + p.pid + "/cmdline", p.argv.join("\0") + "\0");
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

/** The same fake /proc, with one read failing as `code` (EACCES, ENOENT, ...). */
function failingRead(p, file, code) {
  return {
    ...p,
    readFile: (path) => {
      if (path === file) throw Object.assign(new Error(code + ": " + file), { code });
      return p.readFile(path);
    },
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

test("a process with no readable argv is refused before any other same-uid rule", async () => {
  const unreadable = await askOwnUid({}, { argv: undefined });
  assert.deepEqual([unreadable.kind, unreadable.reason], ["denied", "owner check failed"]);
  const empty = await askOwnUid({}, { argv: [] });
  assert.deepEqual([empty.kind, empty.reason], ["denied", "owner check failed"]);
});

test("a relative argv element with an unreadable cwd is refused before the gateway and satellite rules", async () => {
  const gw = await askOwnUid({}, { cwd: undefined, argv: ["node", "servers/gateway/index.js"] });
  assert.deepEqual([gw.kind, gw.reason], ["denied", "owner check failed"]);
  const sat = await askOwnUid({}, { cwd: undefined, argv: ["node", "servers/satellite/index.js"] });
  assert.deepEqual([sat.kind, sat.reason], ["denied", "owner check failed"]);
  // With a readable cwd the same argv IS the gateway.
  const resolved = await askOwnUid({}, { cwd: "/srv/crow", argv: ["node", "servers/gateway/index.js"] });
  assert.deepEqual([resolved.kind, resolved.reason], ["denied", "gateway"]);
});

test("the gateway is recognised in its directory form and under any file name", async () => {
  for (const argv of [
    ["node", "/srv/crow/servers/gateway"],
    ["node", "/srv/crow/servers/gateway/main.mjs"],
    ["node", "/opt/cohost/servers/gateway/worker/runner.js"],
    ["/usr/bin/node", "--enable-source-maps", "/srv/crow/servers/gateway"],
  ]) {
    const r = await askOwnUid({}, { argv });
    assert.deepEqual([r.kind, r.reason], ["denied", "gateway"], JSON.stringify(argv));
  }
});

test("a socket held by several processes is judged holder by holder", async () => {
  const holders = (procs) => fakeProc({
    tcp: table(v4row("127.0.0.1", PORT, { uid: GW_UID, inode: SOCK })),
    procs: procs.map((p, i) => ({ pid: 720 + i, inodes: [SOCK], ...p })),
  });
  const ask = (p) => identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, selfPids: [1], crowRoots: ROOTS, ...p });

  // An own service and a gateway share the socket: the gateway is the answer.
  const shared = await ask(holders([
    { cwd: "/srv/app", argv: ["node", "server.mjs"] },
    { cwd: "/srv/crow", argv: ["node", "/srv/crow/servers/gateway/index.js"] },
  ]));
  assert.deepEqual([shared.kind, shared.reason, shared.pid], ["denied", "gateway", 721]);

  // A second holder that cannot be read at all is a refusal too.
  const blind = await ask(holders([
    { cwd: "/srv/app", argv: ["node", "server.mjs"] },
    { cwd: "/srv/app", argv: undefined },
  ]));
  assert.deepEqual([blind.kind, blind.reason, blind.pid], ["denied", "owner check failed", 721]);

  // Two holders of this user's own service: the listener is the add-on's.
  const own = await ask(holders([
    { cwd: "/srv/app", argv: ["node", "server.mjs"] },
    { cwd: "/opt/app", argv: ["/usr/bin/node", "/opt/app/index.js"] },
  ]));
  assert.deepEqual([own.kind, own.pid], ["own-uid", 720]);
});

test("an unreadable /proc/net table is a refusal; a missing one is a family with no listener", async () => {
  const ask = (over) => identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, selfPids: [1], crowRoots: ROOTS, ...over });

  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    // Any failure other than ENOENT could hide the listener: refused.
    const denied = await ask(failingRead(ownUidProc(), file, "EACCES"));
    assert.deepEqual([denied.kind, denied.reason], ["denied", "owner check failed"], file);
  }
  // A missing tcp6 is a kernel without the family: the IPv4 table still decides.
  assert.equal((await ask(failingRead(ownUidProc(), "/proc/net/tcp6", "ENOENT"))).kind, "own-uid");
  // A missing tcp is the same, read as empty: the row was there and is gone.
  const noV4Table = await ask(failingRead(ownUidProc(), "/proc/net/tcp", "ENOENT"));
  assert.deepEqual([noV4Table.kind, noV4Table.reason], ["denied", "nothing listens there"]);
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

test("a satellite named by its directory is refused", async () => {
  const p = fakeProc({
    tcp: table(v4row("127.0.0.1", PORT, { uid: GW_UID, inode: SOCK })),
    procs: [{ pid: 610, inodes: [SOCK], cwd: "/", exe: "/usr/bin/node", argv: ["node", "/opt/sat/servers/satellite"] }],
  });
  const r = await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, crowRoots: ["/srv/crow-elsewhere"], ...p });
  assert.deepEqual([r.kind, r.reason], ["denied", "satellite"]);
});

test("a deleted cwd or executable is refused, not compared", async () => {
  for (const [cwd, exe] of [["/srv/crow (deleted)", "/usr/bin/node"], ["/srv/app", "/srv/crow/bin/node (deleted)"]]) {
    const p = fakeProc({
      tcp: table(v4row("127.0.0.1", PORT, { uid: GW_UID, inode: SOCK })),
      procs: [{ pid: 620, inodes: [SOCK], cwd, exe, argv: ["/usr/bin/node", "/srv/app/x.mjs"] }],
    });
    const r = await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, crowRoots: ["/srv/crow"], ...p });
    assert.equal(r.kind, "denied", cwd + " / " + exe);
  }
  // The same process with readable paths outside the roots passes (the rule above is what refuses).
  const ok = fakeProc({
    tcp: table(v4row("127.0.0.1", PORT, { uid: GW_UID, inode: SOCK })),
    procs: [{ pid: 621, inodes: [SOCK], cwd: "/srv/app", exe: "/usr/bin/node", argv: ["/usr/bin/node", "/srv/app/x.mjs"] }],
  });
  assert.equal((await identifyListener("127.0.0.1", PORT, { gatewayUid: GW_UID, crowRoots: ["/srv/crow"], ...ok })).kind, "own-uid");
});

// ---- this computer's bridge ranges ---------------------------------------

import { addrInCidr, bridgeSubnetsFromInterfaces, identifyContainerAddr, localOnlySubnets } from "../scripts/addon-sandbox/listener-owner.mjs";

const IFACES = {
  lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true, cidr: "127.0.0.1/8" }],
  eno1: [{ address: "10.20.30.5", netmask: "255.255.255.0", family: "IPv4" }],
  docker0: [{ address: "172.17.0.1", netmask: "255.255.0.0", family: "IPv4", cidr: "172.17.0.1/16" }],
  "br-0123abcd4567": [{ address: "172.19.5.1", netmask: "255.255.0.0", family: "IPv4" }],
};

test("only the docker and podman bridge interfaces name bridge ranges", async () => {
  assert.deepEqual(bridgeSubnetsFromInterfaces(IFACES), ["172.17.0.0/16", "172.19.0.0/16"]);
  // A netmask that is not a run of ones is not a network.
  assert.deepEqual(bridgeSubnetsFromInterfaces({ docker0: [{ address: "172.20.0.1", netmask: "255.0.255.0" }] }), []);
  // An IPv6 bridge range comes out in its own family.
  const v6 = bridgeSubnetsFromInterfaces({ podman1: [{ address: "fd00:1234::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6" }] });
  assert.deepEqual(v6, ["fd00:1234::/64"]);
  assert.deepEqual(bridgeSubnetsFromInterfaces({}), []);
  assert.deepEqual(bridgeSubnetsFromInterfaces(null), []);
});

test("addrInCidr reads both families, a v4-mapped spelling as its IPv4, and refuses what it cannot parse", async () => {
  assert.equal(addrInCidr("172.18.0.5", "172.18.0.0/16"), true);
  assert.equal(addrInCidr("172.19.0.5", "172.18.0.0/16"), false);
  assert.equal(addrInCidr("::ffff:172.18.0.5", "172.18.0.0/16"), true);
  assert.equal(addrInCidr("10.20.30.9", "0.0.0.0/0"), true);
  assert.equal(addrInCidr("fd00:1234::5", "fd00:1234::/64"), true);
  assert.equal(addrInCidr("fd00:1235::5", "fd00:1234::/64"), false);
  assert.equal(addrInCidr("fd00:1234::5", "172.18.0.0/16"), false);
  for (const [a, c] of [["nope", "172.18.0.0/16"], ["172.18.0.5", "nope"], ["172.18.0.5", "172.18.0.0"],
    ["172.18.0.5", "172.18.0.0/xx"], ["172.18.0.5", "172.18.0.0/330"], ["fd00::1", "fd00::/129"]]) {
    assert.equal(addrInCidr(a, c), false, a + " in " + c);
  }
});

// ---- a resolved address that belongs to a container ----------------------

/** A docker-view snapshot with the parts this decision reads. */
const fakeView = (over = {}) => ({
  subnets: ["172.18.0.0/16"],
  containers: [],
  addonProjects: new Map(),
  publishes: [],
  ...over,
});

const container = (project, ips) => ({ id: project + "-1", name: "/" + project, project, ips });

const askContainer = (addr, over = {}, opts = {}) =>
  identifyContainerAddr(addr, { addonId: "paperless", bridgeSubnets: [], view: fakeView(), ...opts, ...over });

test("a container of this add-on's own compose project may be reached", async () => {
  const r = await askContainer("172.18.0.5", {
    view: fakeView({ containers: [container("home-paperless", ["172.18.0.5"])], addonProjects: new Map([["home-paperless", "paperless"]]) }),
  });
  assert.deepEqual([r.kind, r.project, r.projectOwner], ["docker-container", "home-paperless", "paperless"]);
  // A container address outside every bridge range is judged the same way.
  const direct = await askContainer("10.20.30.9", {
    view: fakeView({ subnets: [], containers: [container("home-paperless", ["10.20.30.9"])], addonProjects: new Map([["home-paperless", "paperless"]]) }),
  });
  assert.equal(direct.kind, "docker-container");
});

test("another add-on's compose project is a foreign project", async () => {
  const r = await askContainer("172.18.0.5", {
    addonId: "media",
    view: fakeView({ containers: [container("home-paperless", ["172.18.0.5"])], addonProjects: new Map([["home-paperless", "paperless"]]) }),
  });
  assert.deepEqual([r.kind, r.reason], ["denied", "foreign project"]);
  assert.equal(r.project, "home-paperless");
});

test("another instance's add-on project is refused, even for the add-on of that id", async () => {
  const view = fakeView({ containers: [container("kiosk-proj", ["172.18.0.5"])], addonProjects: new Map([["kiosk-proj", "other-instance:kiosk"]]) });
  const r = await askContainer("172.18.0.5", { view }, { addonId: "kiosk" });
  assert.deepEqual([r.kind, r.reason], ["denied", "foreign project"]);
});

test("a containerized Crow gateway is a project of no installed add-on", async () => {
  const r = await askContainer("172.18.0.9", {
    view: fakeView({ containers: [container("crow-other", ["172.18.0.9"])], addonProjects: new Map([["home-paperless", "paperless"]]) }),
  });
  assert.deepEqual([r.kind, r.reason], ["denied", "project of no installed add-on"]);
});

test("media reaches a TTS add-on's container and no other add-on does", async () => {
  const view = fakeView({ containers: [container("media-kokoro", ["172.18.0.5"])], addonProjects: new Map([["media-kokoro", "kokoro-tts"]]) });
  const media = await askContainer("172.18.0.5", { view }, { addonId: "media" });
  assert.deepEqual([media.kind, media.project, media.projectOwner], ["docker-container", "media-kokoro", "kokoro-tts"]);
  const kiosk = await askContainer("172.18.0.5", { view }, { addonId: "kiosk" });
  assert.deepEqual([kiosk.kind, kiosk.reason], ["denied", "foreign project"]);
  // The exception is media's: a piper project for media passes, for another add-on it does not.
  const piper = fakeView({ containers: [container("media-piper", ["172.18.0.6"])], addonProjects: new Map([["media-piper", "piper"]]) });
  assert.equal((await askContainer("172.18.0.6", { view: piper }, { addonId: "media" })).kind, "docker-container");
  assert.equal((await askContainer("172.18.0.6", { view: piper }, { addonId: "paperless" })).kind, "denied");
});

test("a bridge address no container holds, an unlabelled project and two projects are refusals", async () => {
  const noHolder = await askContainer("172.18.0.7", { view: fakeView({ containers: [container("home-paperless", ["172.18.0.5"])] }) });
  assert.deepEqual([noHolder.kind, noHolder.reason], ["denied", "no container has that address"]);

  const unlabelled = await askContainer("172.18.0.5", {
    view: fakeView({ containers: [container("", ["172.18.0.5"])], addonProjects: new Map([["home-paperless", "paperless"]]) }),
  });
  assert.deepEqual([unlabelled.kind, unlabelled.reason], ["denied", "unlabelled project"]);

  const two = await askContainer("172.18.0.5", {
    view: fakeView({
      containers: [container("home-paperless", ["172.18.0.5"]), container("home-media", ["172.18.0.5"])],
      addonProjects: new Map([["home-paperless", "paperless"], ["home-media", "media"]]),
    }),
  });
  assert.deepEqual([two.kind, two.reason], ["denied", "more than one project at that address"]);
});

test("an unreadable docker view refuses a bridge address and leaves a LAN address alone", async () => {
  const bridge = await askContainer("172.18.0.5", { view: null }, { bridgeSubnets: ["172.18.0.0/16"] });
  assert.deepEqual([bridge.kind, bridge.reason], ["denied", "owner check failed"]);
  // A LAN address is not a container address, so no docker view is needed.
  const lan = await askContainer("10.20.30.9", { view: null }, { bridgeSubnets: ["172.18.0.0/16"] });
  assert.equal(lan.kind, "not-container");
  // A readable view with no docker networks at all: the bridge list still decides.
  const listed = await askContainer("172.18.0.5", { view: fakeView({ subnets: [] }) }, { bridgeSubnets: ["172.18.0.0/16"] });
  assert.deepEqual([listed.kind, listed.reason], ["denied", "no container has that address"]);
});

test("an unreadable address, a broken view and a missing map are refusals", async () => {
  assert.deepEqual([(await askContainer("not-an-address")).reason], ["owner check failed"]);
  assert.deepEqual([(await askContainer("172.18.0.5", { view: { get subnets() { throw new Error("boom"); } } })).reason], ["owner check failed"]);
  const noMap = await askContainer("172.18.0.5", { view: fakeView({ containers: [container("home-paperless", ["172.18.0.5"])], addonProjects: undefined }) });
  assert.deepEqual([noMap.kind, noMap.reason], ["denied", "project of no installed add-on"]);
  // A v4-mapped spelling of the same container address is the same container.
  const mapped = await askContainer("::ffff:172.18.0.5", {
    view: fakeView({ containers: [container("home-paperless", ["172.18.0.5"])], addonProjects: new Map([["home-paperless", "paperless"]]) }),
  });
  assert.equal(mapped.kind, "docker-container");
});

// ---- the owner value is an add-on id, never a placeholder ------------------

test("a project with two owners belongs to no add-on, whatever the add-on is called", async () => {
  const ownHome = "/home/alex/.crow";
  const appRoot = "/home/alex/crow";
  const otherHome = "/home/alex/.crow-other";
  const entry = (id, workingDir) => ({
    Id: id,
    Name: "/" + id,
    Config: { Labels: { "com.docker.compose.project": "two-owners", "com.docker.compose.project.working_dir": workingDir } },
    NetworkSettings: {
      Networks: { bridge: { IPAddress: "172.18.0.9" } },
      Ports: { "9000/tcp": [{ HostIp: "127.0.0.1", HostPort: String(PORT) }] },
    },
  });
  const inspected = [
    entry("a", ownHome + "/bundles/conflict"),
    entry("b", otherHome + "/bundles/conflict"),
  ];
  const run = async (args) => {
    if (args[0] === "ps") return "a\nb\n";
    if (args[0] === "inspect") return JSON.stringify(inspected);
    if (args[0] === "network" && args[1] === "ls") return "";
    throw new Error("unexpected " + args.join(" "));
  };
  const snap = await createDockerView({ run, ownHome, appRoot, otherHomes: [otherHome] }).snapshot();
  assert.equal(snap.addonProjects.has("two-owners"), false, "no placeholder stands in for the two owners");

  // The listener path: a root-owned socket the project publishes.
  const p = fakeProc({ tcp: table(v4row("127.0.0.1", PORT, { uid: 0, inode: 900 })) });
  const listener = await identifyListener("127.0.0.1", PORT, {
    gatewayUid: GW_UID, ...p, addonId: "conflict", addonProjects: snap.addonProjects,
    docker: async () => snap.publishes,
  });
  assert.deepEqual([listener.kind, listener.reason], ["denied", "project of no installed add-on"]);

  // The container path: the address those containers hold.
  const addr = identifyContainerAddr("172.18.0.9", { addonId: "conflict", view: snap, bridgeSubnets: [] });
  assert.deepEqual([addr.kind, addr.reason], ["denied", "project of no installed add-on"]);
});

test("an owner value that is not one slug is no owner on either path", async () => {
  for (const value of ["Conflict", "", "a:b", "other-instance:", " conflict", "other-instance:Kiosk"]) {
    const p = fakeProc({ tcp: table(v4row("127.0.0.1", PORT, { uid: 0, inode: 900 })) });
    const listener = await identifyListener("127.0.0.1", PORT, {
      gatewayUid: GW_UID, ...p, addonId: "conflict",
      docker: async () => [{ hostIp: "127.0.0.1", hostPort: PORT, project: "proj" }],
      addonProjects: new Map([["proj", value]]),
    });
    assert.deepEqual([listener.kind, listener.reason], ["denied", "foreign project"], JSON.stringify(value));

    const addr = identifyContainerAddr("172.18.0.5", {
      addonId: "conflict",
      bridgeSubnets: [],
      view: fakeView({ containers: [container("proj", ["172.18.0.5"])], addonProjects: new Map([["proj", value]]) }),
    });
    assert.deepEqual([addr.kind, addr.reason], ["denied", "foreign project"], JSON.stringify(value));
  }
});

// ---- every local interface but loopback and the default route ------------

/** `/proc/net/route` text: eno1 leaves this computer, mybr0 is a local bridge. */
const ROUTE_V4 = [
  "Iface\tDestination\tGateway\t\tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
  "eno1\t00000000\t0102A8C0\t\t0003\t0\t0\t100\t00000000\t0\t0\t0",
  "mybr0\t0030AC0A\t00000000\t\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0",
].join("\n");

/** `/proc/net/ipv6_route` text: a default route out of eno1, a local prefix on mybr0. */
const ROUTE_V6 = [
  "00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 00000400 00000000 00000000 00000003 eno1",
  "fd003000000000000000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 00000100 00000000 00000000 00000001 mybr0",
].join("\n");

const LOCAL_IFACES = {
  lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true }],
  eno1: [{ address: "10.20.30.5", netmask: "255.255.255.0", family: "IPv4" }],
  mybr0: [
    { address: "172.30.0.1", netmask: "255.255.0.0", family: "IPv4" },
    { address: "fd00:3000::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6" },
  ],
  docker0: [{ address: "172.17.0.1", netmask: "255.255.0.0", family: "IPv4" }],
};

test("every interface but loopback and the one a default route leaves through is a local-only range", async () => {
  const ranges = localOnlySubnets(LOCAL_IFACES, { v4: ROUTE_V4, v6: ROUTE_V6 }).sort();
  assert.deepEqual(ranges, ["172.17.0.0/16", "172.30.0.0/16", "fd00:3000::/64"].sort());
  assert.equal(ranges.some((c) => c.startsWith("127.")), false, "loopback is never a local-only range");
  assert.equal(ranges.some((c) => c.startsWith("10.")), false, "the default route's interface is not one");

  // No route table: no default-route interface is known, so the LAN range counts too.
  const blind = localOnlySubnets(LOCAL_IFACES, { v4: "", v6: "" }).sort();
  assert.deepEqual(blind, ["10.20.30.0/24", "172.17.0.0/16", "172.30.0.0/16", "fd00:3000::/64"].sort());
  assert.deepEqual(localOnlySubnets(null, ROUTE_V4), []);
});
