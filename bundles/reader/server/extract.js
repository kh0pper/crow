/**
 * Reader — extraction subprocess wrapper.
 *
 * Spawns the vendored PEP-723 extractor via uv in its OWN PROCESS GROUP
 * so a timeout kills uv AND the python it spawned (execFile's killSignal
 * only reaches uv, orphaning a runaway OCR job). Structured result,
 * never throws: {ok, sections, diagnostics} or {ok:false, error}.
 */
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "extract.py");
const MAX_OUTPUT = 64 * 1024 * 1024;

export function runExtraction(filePath, config, { ocr = false, scriptPath = DEFAULT_SCRIPT } = {}) {
  const timeoutMs = Number(config.READER_EXTRACT_TIMEOUT_MS || 180000);
  const args = ["run", "--quiet", scriptPath, filePath];
  if (ocr) args.push("--ocr");
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(config.READER_UV_BIN || "uv", args, { detached: true });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already gone */ }
    }, timeoutMs);
    // setEncoding routes chunks through StringDecoder so a multi-byte UTF-8
    // sequence split across a pipe-chunk boundary decodes correctly; naive
    // per-chunk toString() silently yields U+FFFD inside paragraph text.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < 4096) stderr += d; });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, error: `extractor spawn failed: ${err.message}` });
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (timedOut) {
        return resolvePromise({ ok: false, error: `extraction timeout after ${timeoutMs}ms` });
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed && typeof parsed.ok === "boolean") return resolvePromise(parsed);
      } catch { /* fall through to error mapping */ }
      const detail = stderr.trim().slice(0, 500) || "no parseable output";
      resolvePromise({ ok: false, error: `extractor failed: ${detail}` });
    });
  });
}
