// LIVE, opt-in: the browser entrypoint in a real throwaway container.
//
//   CROW_TEST_BROWSER_IMAGE=<a built crow-browser image> npm test -- tests/browser-vnc-container-live.test.js
//
// Skipped unless CROW_TEST_BROWSER_IMAGE names an image (CI has no docker).
// The container runs with --network none (its own network namespace, so it
// can never collide with or reach a real instance) and the repo's entrypoint
// mounted over the image's, and is removed afterwards. Proves, against the
// real x11vnc / websockify / noVNC of the image:
//   - no TCP port carries RFB (a raw connect to 5900 fails; x11vnc owns no
//     listening socket), RFB is a 0600 unix socket in a 0700 directory;
//   - noVNC's port listens on 127.0.0.1 only, and so does the CDP relay;
//   - the CDP relay refuses /json/version without the token (401) and answers with it
//     (200), and Chromium itself owns no listener (it runs on --remote-debugging-pipe);
//   - a WebSocket without the token (any Host but the token) gets no RFB;
//   - with the token as its Host header it gets the RFB banner and the
//     "None" security type (no password prompt);
//   - the token is in no log line (a wrong one neither) and in no environment;
//   - the X display: no abstract (host-wide) socket, another uid cannot open
//     it, and `x11vnc -R rfbport:` remote control opens nothing;
//   - a graceful stop: a cookie written just before `docker stop` survives;
//   - the instance marker: the profile volume refuses another instance.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, chmodSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const IMAGE = process.env.CROW_TEST_BROWSER_IMAGE || "";
const skip = IMAGE ? false : "set CROW_TEST_BROWSER_IMAGE to a built crow-browser image to run";
const NAME = `crow-vnc-live-${process.pid}-${randomBytes(3).toString("hex")}`;
const VOL = NAME + "-profile";
const TOKEN = randomBytes(32).toString("hex");
const CDP_TOKEN = randomBytes(32).toString("hex");
const dir = mkdtempSync(join(tmpdir(), "crow-vnc-live-"));
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
const allLogs = () => execFileSync("sh", ["-c", `docker logs ${NAME} 2>&1`], { encoding: "utf8", timeout: 30000 });
const inside = (script) => docker("exec", NAME, "python3", "-c", script).trim();

after(() => {
  if (IMAGE) {
    for (const c of [NAME, NAME + "-other"]) { try { docker("rm", "-f", c); } catch {} }
    try { docker("volume", "rm", VOL); } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A raw WebSocket handshake to websockify with `host` as the Host header; returns what came back. */
const WS = (host) => `
import socket, base64, os
s = socket.create_connection(("127.0.0.1", 6080), timeout=5)
key = base64.b64encode(os.urandom(16)).decode()
s.sendall(("GET /websockify HTTP/1.1\\r\\nHost: ${host}\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n"
           "Sec-WebSocket-Key: " + key + "\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Protocol: binary\\r\\n\\r\\n").encode())
buf = b""
try:
    while b"\\r\\n\\r\\n" not in buf:
        d = s.recv(4096)
        if not d: break
        buf += d
    head, _, rest = buf.partition(b"\\r\\n\\r\\n")
    status = head.split(b"\\r\\n")[0].decode(errors="replace")
    payload = b""
    if " 101 " in status:
        while len(rest) < 2:
            d = s.recv(4096)
            if not d: break
            rest += d
        if len(rest) >= 2 and (rest[0] & 0x0f) == 2:
            n = rest[1] & 0x7f
            while len(rest) < 2 + n:
                d = s.recv(4096)
                if not d: break
                rest += d
            payload = rest[2:2 + n]
    print(status + "|" + payload.decode(errors="replace").strip())
except Exception as e:
    print("error|" + type(e).__name__)
`;

test("the entrypoint in a throwaway container: RFB on a unix socket only, noVNC needs the token, no password, no token in logs", { skip, timeout: 120000 }, async () => {
  const ep = join(dir, "entrypoint.sh");
  copyFileSync(new URL("../bundles/browser/entrypoint.sh", import.meta.url), ep);
  chmodSync(ep, 0o755);
  const tok = join(dir, "token");
  writeFileSync(tok, TOKEN + "\n", { mode: 0o644 });   // readable by the container's root; 0400 in compose
  const cdpTok = join(dir, "cdp-token");
  writeFileSync(cdpTok, CDP_TOKEN + "\n", { mode: 0o644 });
  const runArgs = (name, instance) => ["run", "-d", "--name", name, "--network", "none", "--init", "--shm-size", "1g", "-m", "2g",
    "--stop-timeout", "30", "-e", `CROW_INSTANCE=${instance}`, "-e", "VNC_PASSWORD=legacy-value", "-e", "VNC_TOKEN=env-token-must-be-ignored",
    "-v", `${tok}:/run/secrets/crow-vnc-token:ro`, "-v", `${cdpTok}:/run/secrets/crow-cdp-token:ro`,
    "-v", `${VOL}:/root/.config/chromium-crow`, "-v", `${ep}:/app/entrypoint.sh:ro`, IMAGE];
  docker(...runArgs(NAME, "/test/instance-a"));
  const waitReady = async () => {
    let l = "";
    for (let i = 0; i < 60; i++) {
      l = allLogs();
      if (/Ready \(verified\)|FATAL/.test(l.split("stopped.").at(-1))) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return l;
  };
  const logs = await waitReady();
  assert.match(logs, /Ready \(verified\)/, logs.slice(-2000));
  assert.match(logs, /RFB on a unix socket only/);
  assert.match(logs, /websockify listens on loopback only \(port 6080\)/);
  assert.match(logs, /cdp-relay listens on loopback only \(port 9222\)/, "the relay is the only listener on the CDP port, and it is loopback");

  // No TCP listener carries RFB; only noVNC (127.0.0.1:6080) and the CDP relay (127.0.0.1:9222) listen.
  const listen = inside(`
rows=[]
for f in ("/proc/net/tcp","/proc/net/tcp6"):
    for line in open(f).read().splitlines()[1:]:
        p=line.split()
        if p[3]=="0A": rows.append(p[1])
print(" ".join(sorted(rows)))`);
  assert.equal(listen, "0100007F:17C0 0100007F:2406", "only 127.0.0.1:6080 and 127.0.0.1:9222");
  // The 9222 listener is the relay, not Chromium: the relay refuses a request without the
  // token and answers with it (the token is read from the file inside the container, so it
  // never appears in an argv or an env of `docker exec`).
  const cdpStatus = (withToken) => inside(`
import urllib.request
req = urllib.request.Request("http://127.0.0.1:9222/json/version")
if ${withToken ? "True" : "False"}:
    req.add_header("Authorization", "Bearer " + open("/run/secrets/crow-cdp-token").read().strip())
try:
    print(urllib.request.urlopen(req, timeout=5).status)
except Exception as e:
    print(getattr(e, "code", "error"))`);
  assert.equal(cdpStatus(false), "401", "no token, no version: the relay gates the port");
  assert.equal(cdpStatus(true), "200", "the token in the header is the way in");
  // Chromium owns no listening socket at all (it runs on --remote-debugging-pipe).
  const chromeListeners = inside(`
import os
pids=[]
for pid in os.listdir("/proc"):
    if not pid.isdigit(): continue
    try: cmd=open("/proc/%s/cmdline" % pid,"rb").read()
    except Exception: continue
    if b"--user-data-dir=/root/.config/chromium-crow" in cmd: pids.append(pid)
print(" ".join(pids))`).split().filter(Boolean);
  assert.ok(chromeListeners.length >= 1, "Chromium is running in the container");
  assert.equal(inside(`
import socket
try:
    socket.create_connection(("127.0.0.1", 5900), timeout=2); print("open")
except OSError: print("refused")`), "refused", "a raw TCP connect to the old RFB port fails");
  assert.equal(inside(`
import os, stat
d=os.stat("/run/crow-vnc"); s=os.stat("/run/crow-vnc/rfb.sock"); t=os.stat("/run/crow-vnc/tokens")
print(oct(d.st_mode & 0o777), stat.S_ISSOCK(s.st_mode), oct(s.st_mode & 0o777), oct(t.st_mode & 0o777))`), "0o700 True 0o600 0o600");

  // No token → no RFB. Any Host but the token is refused, the token in the query too.
  const WRONG = randomBytes(32).toString("hex");
  for (const host of ["127.0.0.1:6080", "localhost", "evil.example", WRONG, "env-token-must-be-ignored"]) {
    const r = inside(WS(host));
    assert.doesNotMatch(r, /RFB 003/, `Host ${host.length > 20 ? "(another random token)" : host}: ${r}`);
  }
  // With the token as Host: the RFB banner, then security type 1 (None): no password prompt.
  const ok = inside(WS(TOKEN));
  assert.match(ok, /^HTTP\/1\.1 101 .*\|RFB 003\.008$/, ok);
  const sec = inside(`
import socket
s=socket.socket(socket.AF_UNIX); s.connect("/run/crow-vnc/rfb.sock")
s.recv(12); s.sendall(b"RFB 003.008\\n"); print(list(s.recv(2)))`);
  assert.equal(sec, "[1, 1]", "one security type, None");

  // The token is in no log line, and Chromium (and every child) runs without it.
  const all = allLogs();
  assert.ok(!all.includes(TOKEN.slice(0, 16)) && !all.includes(TOKEN.slice(-16)), "no part of the token is ever logged");
  assert.ok(!all.includes("legacy-value"), "the legacy password never logged");
  assert.ok(!all.includes(WRONG.slice(0, 16)), "a wrong token is refused without being logged (QuietTokenFile)");
  // (docker exec itself, and the entrypoint's own initial environ, carry the
  // container's config env: host-root-only. What matters is the children.)
  const holders = inside(`
import os
bad=set()
for pid in os.listdir("/proc"):
    if not pid.isdigit(): continue
    try:
        env=open("/proc/%s/environ" % pid,"rb").read()
        cmd=open("/proc/%s/cmdline" % pid,"rb").read()
    except Exception: continue
    if b"VNC_TOKEN=" in env: bad.add(cmd.split(b"\\0")[0].decode(errors="replace").split("/")[-1])
print(",".join(sorted(bad)))`).split(",");
  for (const p of holders) assert.doesNotMatch(p, /chrome|x11vnc|websockify|Xvfb/i, "a child holds the token: " + holders.join(","));

  // The CDP token is on nobody's command line either (the value is read from the
  // container's own file, so the test itself never puts it in an argv).
  const cdpArgv = inside(`
import os
tok = open("/run/secrets/crow-cdp-token","rb").read().strip()
bad = []
for pid in os.listdir("/proc"):
    if not pid.isdigit(): continue
    try: cmd = open("/proc/%s/cmdline" % pid, "rb").read()
    except Exception: continue
    if tok and tok in cmd: bad.append(pid)
print(",".join(bad))`);
  assert.equal(cdpArgv, "", "the CDP token is in no process's command line");

  // ---- C1: the X display is not reachable host-wide, by another uid, or by x11vnc -R ----
  const unix = docker("exec", NAME, "cat", "/proc/net/unix");
  assert.doesNotMatch(unix, /@\/tmp\/\.X11-unix\/X/, "no abstract X socket (that namespace is the host's under host networking)");
  assert.match(docker("exec", NAME, "xdpyinfo", "-display", ":99"), /name of display:\s+:99/, "root, with the cookie: the display works");
  let nobody = "";
  try { nobody = execFileSync("docker", ["exec", "-u", "65534", "-e", "XAUTHORITY=/tmp/none", NAME, "xdpyinfo", "-display", ":99"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { nobody = "refused:" + String(e.stderr || ""); }
  assert.match(nobody, /^refused:/, "another uid (no cookie) cannot open the display: " + nobody.slice(0, 200));
  try { docker("exec", NAME, "timeout", "8", "x11vnc", "-display", ":99", "-R", "rfbport:5999"); } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(inside(`
import socket
try:
    socket.create_connection(("127.0.0.1", 5999), timeout=2); print("open")
except OSError: print("refused")`), "refused", "x11vnc -R rfbport: is refused (-noremote)");

  // ---- I2: a cookie written just before docker stop survives the stop ----
  const setCookie = `
const { readFileSync } = await import("node:fs");
const token = readFileSync("/run/secrets/crow-cdp-token", "utf8").trim();
const { chromium } = await import("/app/node_modules/playwright/index.mjs");
const b = await chromium.connectOverCDP("http://127.0.0.1:9222", { headers: { Authorization: "Bearer " + token } });
const ctx = b.contexts()[0];
await ctx.addCookies([{ name: "flush_probe", value: "v", domain: ".example.com", path: "/", expires: Math.floor(Date.now() / 1000) + 86400 }]);
process.exit(0);`;
  docker("exec", NAME, "node", "--input-type=module", "-e", setCookie);
  const t0 = Date.now();
  docker("stop", "-t", "30", NAME);
  const took = Date.now() - t0;
  assert.match(allLogs(), /stopping: closing Chromium through the relay[\s\S]*stopped\./, "the entrypoint's TERM trap ran");
  docker("start", NAME);
  await waitReady();
  const names = inside(`
import sqlite3, os
p = "/root/.config/chromium-crow/Default/Cookies"
if not os.path.exists(p): p = "/root/.config/chromium-crow/Default/Network/Cookies"
print(",".join(r[0] for r in sqlite3.connect("file:%s?mode=ro" % p, uri=True).execute("select name from cookies")))`);
  assert.match(names, /flush_probe/, "the cookie set right before the stop is in the profile (stop took " + took + " ms)");

  // ---- M5: the profile's instance marker; another instance's container refuses it ----
  assert.equal(docker("exec", NAME, "cat", "/root/.config/chromium-crow/.crow-instance"), "/test/instance-a");
  docker("stop", "-t", "30", NAME);
  docker(...runArgs(NAME + "-other", "/test/instance-b"));
  let other = "";
  for (let i = 0; i < 20; i++) {
    other = execFileSync("sh", ["-c", `docker logs ${NAME}-other 2>&1`], { encoding: "utf8" });
    if (/FATAL|Ready/.test(other)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.match(other, /FATAL: this browser profile belongs to the Crow instance at '\/test\/instance-a', not '\/test\/instance-b'/);
  assert.doesNotMatch(other, /Ready \(verified\)/);
});
