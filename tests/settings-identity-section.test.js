/**
 * F1 (BH-3) — Settings > Identity was permanently "Identity not available"
 * because the section imported the non-existent `getOrCreateIdentity` (the
 * real export is `loadOrCreateIdentity`) and, once that import is fixed,
 * read the non-existent `ed25519Public` field (the real field is
 * `ed25519Pubkey`).
 *
 * sharing/identity.js resolves DATA_DIR/IDENTITY_PATH as module-level consts
 * at import time, so CROW_DATA_DIR must be set BEFORE the module is ever
 * imported in a process — this test renders the section in a fresh child
 * process (a throwaway script file) rather than mutating env after import.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");
const SECTION_PATH = join(REPO_ROOT, "servers/gateway/dashboard/settings/sections/identity.js");

function renderIdentitySection(dataDir) {
  const script = `
    import section from ${JSON.stringify(SECTION_PATH)};
    const html = await section.render({ lang: "en" });
    process.stdout.write(html);
  `;
  const scriptPath = join(dataDir, "_render.mjs");
  writeFileSync(scriptPath, script);
  return execFileSync(process.execPath, [scriptPath], {
    env: { ...process.env, CROW_DATA_DIR: dataDir },
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

test("identity section renders a real crow: id and non-empty ed25519 hex, not the placeholder", () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-identity-"));
  try {
    const html = renderIdentitySection(dir);

    assert.ok(
      !/Identity not available/.test(html),
      "must NOT show the identityNotAvailable placeholder (broken import throws, caught, placeholder rendered)",
    );

    const crowIdMatch = html.match(/crow:[0-9a-z]+/);
    assert.ok(crowIdMatch, "must render a real crow: id");

    const ed25519Match = html.match(/Ed25519:<\/span>\s*([0-9a-f]*)\.\.\./);
    assert.ok(ed25519Match, "must render the Ed25519 line with a hex value");
    assert.ok(ed25519Match[1].length > 0, "ed25519 value must be NON-EMPTY (not escapeHtml(undefined) -> '')");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
