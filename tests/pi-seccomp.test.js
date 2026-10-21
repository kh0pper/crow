// Queue item 19, step 2b: the contain tier's seccomp filter. The BPF program
// is checked instruction by instruction (no kernel needed), then loaded for
// real in a bwrap sandbox where python3's ctypes makes the raw syscalls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import {
  buildSeccompProgram, SYSCALLS, DENY_EPERM, SECCOMP, CLONE_NEW_MASK, seccompSupported,
} from "../scripts/pi-bots/pi_seccomp.mjs";

const decode = (buf) => {
  const out = [];
  for (let i = 0; i < buf.length; i += 8) out.push({ code: buf.readUInt16LE(i), jt: buf[i + 2], jf: buf[i + 3], k: buf.readUInt32LE(i + 4) });
  return out;
};

/** A tiny classic-BPF interpreter for the opcodes the builder uses. */
function run(prog, { arch, nr, args = [0, 0, 0, 0, 0, 0] }) {
  const data = Buffer.alloc(64);
  data.writeInt32LE(nr, 0); data.writeUInt32LE(arch, 4);
  args.forEach((a, i) => data.writeBigUInt64LE(BigInt(a), 16 + 8 * i));
  let A = 0;
  for (let pc = 0; pc < prog.length;) {
    const { code, jt, jf, k } = prog[pc];
    if (code === 0x20) { A = data.readUInt32LE(k); pc++; continue; }
    if (code === 0x15) { pc += 1 + (A === k ? jt : jf); continue; }
    if (code === 0x35) { pc += 1 + (A >>> 0 >= k ? jt : jf); continue; }
    if (code === 0x45) { pc += 1 + ((A & k) !== 0 ? jt : jf); continue; }
    if (code === 0x06) return k;
    throw new Error("unknown opcode " + code);
  }
  throw new Error("fell off the program");
}

for (const arch of ["x64", "arm64"]) {
  test(`${arch}: wrong arch → ENOSYS; denied syscalls → EPERM; clone with a namespace flag → EPERM; plain clone allowed`, () => {
    const prog = decode(buildSeccompProgram(arch));
    assert.ok(prog.length < 4096);
    const A = SECCOMP.AUDIT_ARCH[arch];
    const nr = SYSCALLS[arch];
    assert.equal(run(prog, { arch: 0x40000003, nr: 1 }), SECCOMP.RET_ERRNO | 38, "foreign arch");
    for (const name of DENY_EPERM) {
      if (nr[name] === undefined) continue; // not on this arch (iopl/ioperm on arm64)
      assert.equal(run(prog, { arch: A, nr: nr[name] }), SECCOMP.RET_ERRNO | 1, name);
    }
    assert.equal(run(prog, { arch: A, nr: nr.clone3 }), SECCOMP.RET_ERRNO | 38, "clone3 → ENOSYS so libc falls back to clone");
    assert.equal(run(prog, { arch: A, nr: nr.clone, args: [0x10000000] }), SECCOMP.RET_ERRNO | 1, "CLONE_NEWUSER");
    assert.equal(run(prog, { arch: A, nr: nr.clone, args: [0x00020000] }), SECCOMP.RET_ERRNO | 1, "CLONE_NEWNS");
    assert.equal(run(prog, { arch: A, nr: nr.clone, args: [0x003d0f00] }), SECCOMP.RET_ALLOW, "a thread-style clone");
    assert.equal(run(prog, { arch: A, nr: nr.ioctl, args: [0, 0x5412] }), SECCOMP.RET_ERRNO | 1, "TIOCSTI");
    assert.equal(run(prog, { arch: A, nr: nr.ioctl, args: [0, 0x541c] }), SECCOMP.RET_ERRNO | 1, "TIOCLINUX");
    assert.equal(run(prog, { arch: A, nr: nr.ioctl, args: [0, 0x5401] }), SECCOMP.RET_ALLOW, "TCGETS");
    for (const ok of ["read", "write", "openat", "execve", "socket", "connect", "futex"]) {
      assert.equal(run(prog, { arch: A, nr: nr[ok] }), SECCOMP.RET_ALLOW, ok);
    }
    if (arch === "x64") assert.equal(run(prog, { arch: A, nr: 0x40000000 | 1 }), SECCOMP.RET_ERRNO | 38, "x32 ABI");
  });
}

test("CLONE_NEW_MASK covers every namespace flag", () => {
  for (const f of [0x00020000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000, 0x00000080]) {
    assert.ok((CLONE_NEW_MASK & f) === f, f.toString(16));
  }
});

test("the x86_64 table matches the kernel header where it exists", { skip: !existsSync("/usr/include/x86_64-linux-gnu/asm/unistd_64.h") && "no header" }, () => {
  const h = readFileSync("/usr/include/x86_64-linux-gnu/asm/unistd_64.h", "utf8");
  for (const [name, n] of Object.entries(SYSCALLS.x64)) {
    const m = h.match(new RegExp("#define __NR_" + name + "\\s+(\\d+)"));
    assert.ok(m, name + " in header");
    assert.equal(Number(m[1]), n, name);
  }
});

test("the aarch64 table matches asm-generic where it exists", { skip: !existsSync("/usr/include/asm-generic/unistd.h") && "no header" }, () => {
  const h = readFileSync("/usr/include/asm-generic/unistd.h", "utf8");
  for (const [name, n] of Object.entries(SYSCALLS.arm64)) {
    const m = h.match(new RegExp("#define __NR(3264)?_" + name + "\\s+(\\d+)"));
    assert.ok(m, name + " in header");
    assert.equal(Number(m[2]), n, name);
  }
});

const bwrap = ["/usr/bin/bwrap", "/bin/bwrap"].find((p) => existsSync(p));
const py = ["/usr/bin/python3", "/bin/python3"].find((p) => existsSync(p));
const live = bwrap && py && seccompSupported() ? false : "needs bwrap, python3 and x64/arm64";

test("integration: under the filter the denied syscalls fail with EPERM and ordinary programs still run", { skip: live, timeout: 60000 }, async () => {
  const { openSync, writeFileSync, mkdtempSync, unlinkSync, closeSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "crow-seccomp-"));
  const f = join(dir, "filter.bpf");
  writeFileSync(f, buildSeccompProgram(process.arch));
  const fd = openSync(f, "r");
  unlinkSync(f);
  const nr = SYSCALLS[process.arch];
  const script = [
    "import ctypes, os, json",
    "libc = ctypes.CDLL(None, use_errno=True)",
    "def call(n, *a):",
    "    r = libc.syscall(n, *[ctypes.c_long(x) for x in a])",
    "    return 'ok' if r >= 0 else os.strerror(ctypes.get_errno())",
    `print(json.dumps({'keyctl': call(${nr.keyctl}, 0, 0), 'ptrace': call(${nr.ptrace}, 0, 0, 0, 0),`,
    `  'unshare': call(${nr.unshare}, 0x10000000), 'io_uring': call(${nr.io_uring_setup}, 1, 0), 'bpf': call(${nr.bpf}, 0, 0, 0),`,
    "  'getpid': call(39 if os.uname().machine == 'x86_64' else 172)}))",
  ].join("\n");
  try {
    const base = ["--dev-bind", "/", "/", "--unshare-user", "--unshare-pid", "--proc", "/proc", "--seccomp", "3"];
    const r = spawnSync(bwrap, [...base, "--", py, "-c", script], { stdio: ["ignore", "pipe", "pipe", fd], encoding: "utf8", timeout: 30000 });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    for (const k of ["keyctl", "ptrace", "unshare", "io_uring", "bpf"]) assert.match(o[k], /Operation not permitted/, k);
    assert.equal(o.getpid, "ok");
    // ordinary programs, with a fresh fd per sandbox
    const fd2 = openSync((() => { const g = join(dir, "f2"); writeFileSync(g, buildSeccompProgram(process.arch)); return g; })(), "r");
    const prog = 'const {execFileSync}=require("child_process");const os=require("os");' +
      'const fs=require("fs");fs.writeFileSync(os.tmpdir()+"/x","1");' +
      'console.log(JSON.stringify({sh:execFileSync("sh",["-c","echo hi"]).toString().trim(),' +
      'threads:require("worker_threads")?1:0, read:fs.readFileSync(os.tmpdir()+"/x","utf8")}))';
    const r2 = spawnSync(bwrap, [...base.slice(0, -2), "--seccomp", "3", "--", process.execPath, "-e", prog],
      { stdio: ["ignore", "pipe", "pipe", fd2], encoding: "utf8", timeout: 30000 });
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(JSON.parse(r2.stdout), { sh: "hi", threads: 1, read: "1" });
    closeSync(fd2);
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
});
