import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runExtraction } from "../server/extract.js";

const UV = process.env.READER_UV_BIN || "uv";
function haveUv() {
  try { execFileSync(UV, ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}
const skip = !haveUv();

function fakeScript(dir, body) {
  const p = join(dir, "fake.py");
  writeFileSync(p, body);
  return p;
}

const cfgWith = (over = {}) => ({
  READER_UV_BIN: UV,
  READER_EXTRACT_TIMEOUT_MS: "5000",
  ...over,
});

test("returns parsed JSON from a successful run", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "reader-ext-"));
  const script = fakeScript(dir,
    'import json; print(json.dumps({"ok": True, "sections": [{"title": None, "paragraphs": ["hello"]}], "diagnostics": {"pages": 1, "empty_pages": 0, "used_ocr": False}}))');
  const res = await runExtraction("/any/input.pdf", cfgWith(), { scriptPath: script });
  assert.equal(res.ok, true);
  assert.equal(res.sections[0].paragraphs[0], "hello");
});

test("maps a crash to ok:false with the error text", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "reader-ext-"));
  const script = fakeScript(dir, 'import sys; sys.stderr.write("boom"); sys.exit(2)');
  const res = await runExtraction("/any/input.pdf", cfgWith(), { scriptPath: script });
  assert.equal(res.ok, false);
  assert.match(res.error, /boom|exit/i);
});

test("kills the subprocess on timeout", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "reader-ext-"));
  const script = fakeScript(dir, "import time; time.sleep(60)");
  const res = await runExtraction("/any/input.pdf",
    cfgWith({ READER_EXTRACT_TIMEOUT_MS: "500" }), { scriptPath: script });
  assert.equal(res.ok, false);
  assert.match(res.error, /timeout/i);
});

test("resolves ok:false instead of rejecting when spawn args are invalid", async () => {
  const res = await runExtraction("/any/input.pdf", cfgWith({ READER_UV_BIN: 123 }));
  assert.equal(res.ok, false);
  assert.match(res.error, /spawn failed/i);
});
