import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("loadConfig layers env file under process.env and applies defaults", async () => {
  const home = mkdtempSync(join(tmpdir(), "reader-home-"));
  mkdirSync(join(home, "env"), { recursive: true });
  writeFileSync(join(home, "env", "reader.env"),
    'READER_EMBED_URL="http://example.test:1234"\nREADER_UV_BIN=/opt/uv\n');
  process.env.CROW_HOME = home;
  process.env.READER_UV_BIN = "/env/wins/uv";
  const { loadConfig } = await import("../server/config.js");
  const cfg = loadConfig();
  assert.equal(cfg.READER_EMBED_URL, "http://example.test:1234");
  assert.equal(cfg.READER_UV_BIN, "/env/wins/uv");           // process.env wins
  assert.equal(cfg.READER_EXTRACT_TIMEOUT_MS, "180000");      // default applied
  assert.equal(cfg.READER_MAX_UPLOAD_MB, "50");
  delete process.env.READER_UV_BIN;
});
