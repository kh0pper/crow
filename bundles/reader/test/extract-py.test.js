import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const UV = process.env.READER_UV_BIN || "uv";

function haveUv() {
  try { execFileSync(UV, ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

test("extract.py produces reflowed paragraphs from a PDF", { skip: !haveUv() }, () => {
  const dir = mkdtempSync(join(tmpdir(), "reader-fix-"));
  const pdf = join(dir, "fixture.pdf");
  execFileSync(UV, ["run", "--quiet", join(here, "fixtures", "make_fixture.py"), pdf]);
  const out = execFileSync(UV, ["run", "--quiet", join(here, "..", "scripts", "extract.py"), pdf],
    { encoding: "utf8" });
  const result = JSON.parse(out);
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.pages, 2);
  const paras = result.sections.flatMap((s) => s.paragraphs);
  const joined = paras.join("\n");
  assert.ok(joined.includes("hyphenated line break"), "dehyphenation failed");
  assert.ok(paras.some((p) => p.includes("Second page paragraph")));
});

test("extract.py reports structured error for a missing file", { skip: !haveUv() }, () => {
  let failed = false;
  try {
    execFileSync(UV, ["run", "--quiet", join(here, "..", "scripts", "extract.py"),
      "/nonexistent/x.pdf"], { encoding: "utf8" });
  } catch (err) {
    failed = true;
    const parsed = JSON.parse(err.stdout);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.error.length > 0);
  }
  assert.ok(failed, "expected non-zero exit");
});
