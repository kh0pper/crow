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
//   - noVNC's port listens on 127.0.0.1 only;
//   - a WebSocket without the token (any Host but the token) gets no RFB;
//   - with the token as its Host header it gets the RFB banner and the
//     "None" security type (no password prompt);
//   - the token is in no log line and not in Chromium's environment.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const IMAGE = process.env.CROW_TEST_BROWSER_IMAGE || "";
const skip = IMAGE ? false : "set CROW_TEST_BROWSER_IMAGE to a built crow-browser image to run";
const NAME = `crow-vnc-live-${process.pid}-${randomBytes(3).toString("hex")}`;
const TOKEN = randomBytes(32).toString("hex");
const dir = mkdtempSync(join(tmpdir(), "crow-vnc-live-"));
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
const allLogs = () => execFileSync("sh", ["-c", `docker logs ${NAME} 2>&1`], { encoding: "utf8", timeout: 30000 });
const inside = (script) => docker("exec", NAME, "python3", "-c", script).trim();

after(() => {
  if (IMAGE) { try { docker("rm", "-f", NAME); } catch {} }
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
  docker("run", "-d", "--name", NAME, "--network", "none", "--init", "--shm-size", "1g", "-m", "2g",
    "-e", `VNC_TOKEN=${TOKEN}`, "-e", "VNC_PASSWORD=legacy-value", "-v", `${ep}:/app/entrypoint.sh:ro`, IMAGE);
  let logs = "";
  for (let i = 0; i < 60; i++) {
    logs = allLogs();
    if (/Ready \(verified\)|FATAL/.test(logs)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.match(logs, /Ready \(verified\)/, logs.slice(-2000));
  assert.match(logs, /RFB on a unix socket only/);
  assert.match(logs, /websockify listens on loopback only \(port 6080\)/);

  // No TCP listener carries RFB; only noVNC (127.0.0.1:6080) and CDP (127.0.0.1:9222) listen.
  const listen = inside(`
rows=[]
for f in ("/proc/net/tcp","/proc/net/tcp6"):
    for line in open(f).read().splitlines()[1:]:
        p=line.split()
        if p[3]=="0A": rows.append(p[1])
print(" ".join(sorted(rows)))`);
  assert.equal(listen, "0100007F:17C0 0100007F:2406", "only 127.0.0.1:6080 and 127.0.0.1:9222");
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
  for (const host of ["127.0.0.1:6080", "localhost", "evil.example", randomBytes(32).toString("hex")]) {
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
});
