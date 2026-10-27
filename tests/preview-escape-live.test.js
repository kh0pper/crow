/**
 * The preview render's escape cases, live in the fixture's headless Chrome over its
 * pipe (R4-C6): the same CDP framing the preview container uses, with no DevTools port.
 * The cases (tests/fixtures/preview-escape-cases.mjs) run twice: once with
 * --host-resolver-rules mapping every name but the artifact host to NOTFOUND (the
 * container's rule), and once with the resolver rules unset (C3's "resolver unset"
 * case), where only the render's own interception stands between a page and the
 * outside listeners on 127.0.0.1. The outcomes must be the same.
 *
 * Follows tests/fixtures/headless-chrome.mjs: no Chrome skips, unless
 * CROW_REQUIRE_TEST_CHROME=1, which makes a missing Chrome a failure.
 */
import { describe, test, before, after } from "node:test";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { startEscapeHarness, ESCAPE_CASES, ARTIFACT_HOST } from "./fixtures/preview-escape-cases.mjs";

const MODES = [
  { label: "resolver set", extraArgs: [`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${ARTIFACT_HOST}`] },
  { label: "resolver unset", extraArgs: [] },
];

for (const mode of MODES) describe(mode.label, () => {
  let chrome = null;
  let h = null;
  before(async () => {
    chrome = await startHeadlessChrome({ pipe: true, extraArgs: mode.extraArgs });
    if (chrome) h = await startEscapeHarness({ withCdp: (fn) => fn(chrome.cdp) });
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
