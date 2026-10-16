// D2 engine: the pinned binary under prlimit (CPU seconds + address space), in an
// empty temp dir (nothing to import), with a bare environment. The container has
// no network, and the guard already refused imports and URL icons/links.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 4 GiB address space: Go reserves large virtual ranges at start-up and fails
// under a 1 GiB RLIMIT_AS (review L5); the container's mem_limit is the real bound.
export function d2Engine({ bin = "d2", cpuSeconds = 10, memBytes = 4 * 1024 * 1024 * 1024 } = {}) {
  let current = null;
  return {
    render(source, { timeoutMs }) {
      // D2 0.9.0 reads a local-path icon and inlines it as a data: URI even with
      // --bundle=false (found live). The kit guard refuses "icon"; this plain,
      // case-insensitive substring check (stricter than the binary) is the
      // container's own layer, before the binary runs.
      if (/icon/i.test(source)) return Promise.reject(new Error("invalid spec: icons are not allowed"));
      const dir = mkdtempSync(join(tmpdir(), "d2-"));
      writeFileSync(join(dir, "in.d2"), source);
      return new Promise((resolve, reject) => {
        // --bundle=false: never read and embed local files (review L4).
        const child = spawn("prlimit", [`--cpu=${cpuSeconds}`, `--as=${memBytes}`, "--", bin, "--layout=dagre", "--bundle=false", "in.d2", "out.svg"],
          { cwd: dir, env: { PATH: process.env.PATH, HOME: dir }, stdio: ["ignore", "ignore", "pipe"] });
        current = child;
        let err = "";
        child.stderr.on("data", (c) => { if (err.length < 4000) err += c; });
        const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.on("error", () => {});   // spawn failure surfaces as close(-2)
        child.on("close", (code, signal) => {
          clearTimeout(t);
          if (current === child) current = null;
          try {
            if (signal) return reject(Object.assign(new Error("timeout"), { crowTimeout: true }));
            if (code !== 0) return reject(new Error(err || "render error"));
            resolve(readFileSync(join(dir, "out.svg"), "utf8"));
          } catch (e) { reject(e); } finally { rmSync(dir, { recursive: true, force: true }); }
        });
      });
    },
    async reset() { const c = current; current = null; if (c) { try { c.kill("SIGKILL"); } catch {} } },
  };
}
