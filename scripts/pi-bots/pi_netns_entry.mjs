#!/usr/bin/env node
/**
 * First process inside a contained pi's network namespace (queue item 19,
 * step 2c). The namespace has only `lo`; this process makes the allowed
 * loopback ports and an HTTP CONNECT proxy port exist inside it, relaying
 * every connection over the bind-mounted unix socket to the spawner's egress
 * relay (pi_egress.mjs), which enforces the policy. Then it runs pi with the
 * same stdio and inherited fds, forwards termination signals, and exits with
 * pi's status.
 *
 * Untrusted convenience: a bot that kills or replaces it only loses its own
 * network; nothing here decides what is allowed.
 *
 *   node pi_netns_entry.mjs --sock <path> --ports 3001,8003 --proxy-port 39080 -- <cmd> [args...]
 */
import { createServer, connect } from "node:net";
import { spawn } from "node:child_process";
import { fstatSync } from "node:fs";

export const ENTRY_MARK = "pi_netns_entry.mjs";

function parse(argv) {
  const o = { sock: null, ports: [], proxyPort: null, cmd: null, args: [] };
  const sep = argv.indexOf("--");
  const head = sep < 0 ? argv : argv.slice(0, sep);
  for (let i = 0; i < head.length; i++) {
    if (head[i] === "--sock") o.sock = head[++i];
    else if (head[i] === "--ports") o.ports = String(head[++i] || "").split(",").map(Number).filter((p) => p > 0 && p < 65536);
    else if (head[i] === "--proxy-port") o.proxyPort = Number(head[++i]);
  }
  if (sep >= 0) { o.cmd = argv[sep + 1]; o.args = argv.slice(sep + 2); }
  return o;
}

function relayServer(sock, firstLine) {
  return createServer({ allowHalfOpen: true }, (c) => {
    const u = connect({ path: sock, allowHalfOpen: true });
    u.on("connect", () => { u.write(firstLine); c.pipe(u); u.pipe(c); });
    const kill = () => { try { c.destroy(); } catch {} try { u.destroy(); } catch {} };
    u.on("error", kill); c.on("error", kill);
    // graceful: pipe() propagates each end; destroy once both sides closed
    c.once("close", () => { if (!u.destroyed) u.end(); });
    u.once("close", () => { if (!c.destroyed) c.end(); });
  });
}

function listenBoth(make, port) {
  const tries = ["127.0.0.1", "::1"].map((host) => new Promise((resolve) => {
    const s = make();
    s.once("error", () => resolve(false));
    s.listen({ host, port, ipv6Only: host === "::1" }, () => { s.unref(); resolve(true); });
  }));
  return Promise.all(tries).then((r) => r.some(Boolean));
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (!o.sock || !o.cmd) { console.error("[pi-netns-entry] usage: --sock <path> [--ports a,b] [--proxy-port p] -- <cmd> [args]"); process.exit(2); }
  // Snapshot the inherited fds BEFORE listening, so the listeners and libuv's
  // own fds are never handed to pi.
  const stdio = [];
  for (let fd = 0; fd < 10; fd++) {
    let open = false;
    try { fstatSync(fd); open = true; } catch {}
    stdio.push(open ? fd : "ignore");
  }
  while (stdio.length > 3 && stdio[stdio.length - 1] === "ignore") stdio.pop();
  for (const p of o.ports) {
    if (!(await listenBoth(() => relayServer(o.sock, `PORT ${p}\n`), p))) console.error(`[pi-netns-entry] could not listen on loopback port ${p}`);
  }
  if (o.proxyPort) {
    if (!(await listenBoth(() => relayServer(o.sock, "PROXY\n"), o.proxyPort))) console.error(`[pi-netns-entry] could not listen on the proxy port ${o.proxyPort}`);
  }
  const child = spawn(o.cmd, o.args, { stdio });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { try { child.kill(sig); } catch {} });
  child.on("error", (e) => { console.error("[pi-netns-entry] " + e.message); process.exit(127); });
  child.on("exit", (code, sig) => process.exit(code ?? (128 + ({ SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1 }[sig] || 1))));
}

if (process.argv[1] && process.argv[1].endsWith(ENTRY_MARK)) main();
