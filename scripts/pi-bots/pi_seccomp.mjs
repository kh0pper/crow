/**
 * seccomp filter for the contain tier (queue item 19, migration step 2b).
 *
 * A classic-BPF program built here (no native dependency) and handed to
 * bubblewrap with `--seccomp <fd>`; bwrap installs it last, right before it
 * execs pi, so it applies to pi and everything pi starts.
 *
 * It removes kernel surface a bot has no use for and that local privilege
 * escalations keep coming through:
 *   EPERM   ptrace, process_vm_*, keyrings, bpf, perf_event_open,
 *           userfaultfd, io_uring, kexec/modules, every mount API, unshare,
 *           setns, swap, reboot, syslog, acct, quotactl, file handles,
 *           iopl/ioperm (x86_64), lookup_dcookie;
 *           clone() asking for any new namespace;
 *           ioctl TIOCSTI / TIOCLINUX (terminal input injection)
 *   ENOSYS  clone3 (its flags live in memory the filter cannot read; libc and
 *           libuv fall back to clone(), where they are checked), any syscall
 *           of a foreign ABI (x86 int 0x80 on x86_64, x32)
 *   ALLOW   everything else.
 *
 * Only x86_64 ("x64") and aarch64 ("arm64") are built; elsewhere
 * seccompSupported() is false and contain runs without the filter, and says
 * so (tier "contain-noseccomp").
 *
 * Syscall numbers are hard-coded per arch; tests cross-check them against the
 * kernel headers when the build host has them.
 */
export const SECCOMP = Object.freeze({
  RET_ALLOW: 0x7fff0000,
  RET_ERRNO: 0x00050000,
  AUDIT_ARCH: Object.freeze({ x64: 0xc000003e, arm64: 0xc00000b7 }),
  X32_SYSCALL_BIT: 0x40000000,
});
const EPERM = 1, ENOSYS = 38;

/** CLONE_NEWNS|NEWCGROUP|NEWUTS|NEWIPC|NEWUSER|NEWPID|NEWNET|NEWTIME */
export const CLONE_NEW_MASK = 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000 | 0x00000080;
const TIOCSTI = 0x5412, TIOCLINUX = 0x541c;

export const DENY_EPERM = Object.freeze([
  "ptrace", "process_vm_readv", "process_vm_writev", "keyctl", "add_key", "request_key", "bpf", "perf_event_open",
  "userfaultfd", "io_uring_setup", "io_uring_enter", "io_uring_register", "kexec_load", "kexec_file_load",
  "init_module", "finit_module", "delete_module", "mount", "umount2", "pivot_root", "move_mount", "open_tree",
  "fsopen", "fsconfig", "fsmount", "fspick", "mount_setattr", "unshare", "setns", "swapon", "swapoff", "reboot",
  "syslog", "acct", "quotactl", "open_by_handle_at", "name_to_handle_at", "iopl", "ioperm", "lookup_dcookie",
]);

export const SYSCALLS = Object.freeze({
  x64: Object.freeze({
    read: 0, write: 1, ioctl: 16, socket: 41, connect: 42, clone: 56, execve: 59, ptrace: 101, syslog: 103,
    pivot_root: 155, acct: 163, mount: 165, umount2: 166, swapon: 167, swapoff: 168, reboot: 169, iopl: 172,
    ioperm: 173, init_module: 175, delete_module: 176, quotactl: 179, futex: 202, lookup_dcookie: 212,
    kexec_load: 246, add_key: 248, request_key: 249, keyctl: 250, openat: 257, unshare: 272, perf_event_open: 298,
    name_to_handle_at: 303, open_by_handle_at: 304, setns: 308, process_vm_readv: 310, process_vm_writev: 311,
    finit_module: 313, kexec_file_load: 320, bpf: 321, userfaultfd: 323, io_uring_setup: 425, io_uring_enter: 426,
    io_uring_register: 427, open_tree: 428, move_mount: 429, fsopen: 430, fsconfig: 431, fsmount: 432, fspick: 433,
    clone3: 435, mount_setattr: 442,
  }),
  arm64: Object.freeze({
    lookup_dcookie: 18, ioctl: 29, umount2: 39, mount: 40, pivot_root: 41, openat: 56, quotactl: 60, read: 63,
    write: 64, acct: 89, unshare: 97, futex: 98, kexec_load: 104, init_module: 105, delete_module: 106,
    syslog: 116, ptrace: 117, reboot: 142, socket: 198, connect: 203, add_key: 217, request_key: 218, keyctl: 219,
    clone: 220, execve: 221, swapon: 224, swapoff: 225, perf_event_open: 241, name_to_handle_at: 264,
    open_by_handle_at: 265, setns: 268, process_vm_readv: 270, process_vm_writev: 271, finit_module: 273,
    bpf: 280, userfaultfd: 282, kexec_file_load: 294, io_uring_setup: 425, io_uring_enter: 426,
    io_uring_register: 427, open_tree: 428, move_mount: 429, fsopen: 430, fsconfig: 431, fsmount: 432,
    fspick: 433, clone3: 435, mount_setattr: 442,
  }),
});

export function seccompSupported(arch = process.arch) {
  return Object.prototype.hasOwnProperty.call(SYSCALLS, arch);
}

// classic BPF opcodes used
const LD_W_ABS = 0x20, JEQ_K = 0x15, JGE_K = 0x35, JSET_K = 0x45, RET_K = 0x06;
const OFF_NR = 0, OFF_ARCH = 4, OFF_ARG = (i) => 16 + 8 * i; // low 32 bits (little-endian on both arches)

/**
 * The filter for `arch`, as the raw sock_filter array bwrap reads from its
 * --seccomp fd (8 bytes per instruction, host byte order: little-endian).
 */
export function buildSeccompProgram(arch = process.arch) {
  if (!seccompSupported(arch)) throw new Error("no seccomp table for arch " + arch);
  const nr = SYSCALLS[arch];
  // Instructions with symbolic jump targets: { code, k, jt, jf } where jt/jf
  // are label names or "next"; labels are resolved after layout.
  const ins = [];
  const labels = {};
  const label = (name) => { labels[name] = ins.length; };
  const emit = (code, k, jt = "next", jf = "next") => ins.push({ code, k, jt, jf });

  emit(LD_W_ABS, OFF_ARCH);
  emit(JEQ_K, SECCOMP.AUDIT_ARCH[arch], "next", "enosys");
  emit(LD_W_ABS, OFF_NR);
  if (arch === "x64") emit(JGE_K, SECCOMP.X32_SYSCALL_BIT, "enosys", "next");
  for (const name of DENY_EPERM) {
    if (nr[name] === undefined) continue;
    emit(JEQ_K, nr[name], "eperm", "next");
  }
  emit(JEQ_K, nr.clone3, "enosys", "next");
  emit(JEQ_K, nr.clone, "clone", "next");
  emit(JEQ_K, nr.ioctl, "ioctl", "next");
  emit(RET_K, SECCOMP.RET_ALLOW);

  label("clone");
  emit(LD_W_ABS, OFF_ARG(0));
  emit(JSET_K, CLONE_NEW_MASK, "eperm", "next");
  emit(RET_K, SECCOMP.RET_ALLOW);

  label("ioctl");
  emit(LD_W_ABS, OFF_ARG(1));
  emit(JEQ_K, TIOCSTI, "eperm", "next");
  emit(JEQ_K, TIOCLINUX, "eperm", "next");
  emit(RET_K, SECCOMP.RET_ALLOW);

  label("eperm");
  emit(RET_K, SECCOMP.RET_ERRNO | EPERM);
  label("enosys");
  emit(RET_K, SECCOMP.RET_ERRNO | ENOSYS);

  const buf = Buffer.alloc(ins.length * 8);
  ins.forEach((x, i) => {
    const rel = (t) => {
      if (t === "next") return 0;
      const d = labels[t] - i - 1;
      if (!(d >= 0 && d <= 255)) throw new Error("seccomp jump out of range: " + t);
      return d;
    };
    const isJump = x.code === JEQ_K || x.code === JGE_K || x.code === JSET_K;
    buf.writeUInt16LE(x.code, i * 8);
    buf[i * 8 + 2] = isJump ? rel(x.jt) : 0;
    buf[i * 8 + 3] = isJump ? rel(x.jf) : 0;
    buf.writeUInt32LE(x.k >>> 0, i * 8 + 4);
  });
  return buf;
}
