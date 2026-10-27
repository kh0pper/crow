/**
 * The preview render's escape cases, live in the fixture's headless Chrome over its
 * pipe (R4-C6): the same CDP framing the preview container uses, with no DevTools port.
 * The cases (tests/fixtures/preview-escape-cases.mjs) run twice: once with
 * --host-resolver-rules mapping every name but the artifact host to NOTFOUND (the
 * container's rule), and once with the resolver rules unset (C3's "resolver unset"
 * case), where the outside listeners on 127.0.0.1 are reachable by the browser. There,
 * for pages from the real origin, two layers stand between a page and the outside: the
 * origin's CSP (carried through the fulfill) and the render's own interception; the
 * no-CSP stub-origin cases take the CSP away, so interception alone is tested. The
 * outcomes must be the same in both runs.
 *
 * Follows tests/fixtures/headless-chrome.mjs: no Chrome skips, unless
 * CROW_REQUIRE_TEST_CHROME=1, which makes a missing Chrome a failure.
 */
import { describe, test, before, after } from "node:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { startEscapeHarness, ESCAPE_CASES, ARTIFACT_HOST } from "./fixtures/preview-escape-cases.mjs";

const MODES = [
  { label: "resolver set", extraArgs: [`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${ARTIFACT_HOST}`] },
  { label: "resolver unset", extraArgs: [] },
];

/** Every file under these dirs whose name contains `fragment`. */
async function findFiles(dirs, fragment) {
  const out = [];
  for (const d of dirs) {
    let entries = [];
    try { entries = readdirSync(d, { recursive: true, withFileTypes: true }); } catch {}
    for (const e of entries) if (e.isFile() && e.name.includes(fragment)) out.push(join(e.parentPath ?? e.path, e.name));
  }
  return out;
}

for (const mode of MODES) describe(mode.label, () => {
  let chrome = null;
  let h = null;
  before(async () => {
    chrome = await startHeadlessChrome({ pipe: true, extraArgs: mode.extraArgs });
    if (chrome) h = await startEscapeHarness({ withCdp: (fn) => fn(chrome.cdp), findFiles: (frag) => findFiles([chrome.profile, join(homedir(), "Downloads")], frag) });
  });
  after(async () => {
    await h?.close();
    await chrome?.close();
  });
  for (const c of ESCAPE_CASES) {
    test(`${c.name} (${mode.label})`, { timeout: 60_000 }, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      await c.run(h, (line) => console.log(`[escape ${mode.label}] ${line}`), (fn) => fn(chrome.cdp));
    });
  }
});
