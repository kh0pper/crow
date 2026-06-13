/**
 * Wave 1 Bug 1 regression guard: native form.submit() does NOT fire the
 * `submit` event, so Turbo never attaches the X-Crow-Csrf header and the
 * POST 403s ("CSRF token mismatch."). Every auto-submit in dashboard code
 * must use form.requestSubmit(), optionally with the same-line fallback:
 *   form.requestSubmit ? form.requestSubmit() : form.submit()
 * The scan allows any `.submit()` that shares its line with `requestSubmit`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../servers/gateway/dashboard/", import.meta.url));

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

test("dashboard sources contain no bare native form.submit()", () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/\.submit\(\)/.test(line) && !line.includes("requestSubmit")) {
        offenders.push(`${file.slice(ROOT.length)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], "bare form.submit() found:\n" + offenders.join("\n"));
});
