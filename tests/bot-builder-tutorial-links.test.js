/**
 * Item 5 PR4 (spec §D7): the tutorial exists in both locales, is reachable
 * from the dashboard via the docsUrl() helper (one base constant, no
 * scattered absolute URLs), and mid-flow links open in a new tab so the
 * wizard stays alive behind them.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { docsUrl, DOCS_BASE } from "../servers/gateway/dashboard/shared/components.js";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";

const dir = mkdtempSync(join(tmpdir(), "btb-tutorial-"));
process.env.CROW_DATA_DIR = dir;
let db = null, renderWizard = null, renderBotList = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ renderWizard } = await import("../servers/gateway/dashboard/panels/bot-builder/wizard.js"));
  ({ renderBotList } = await import("../servers/gateway/dashboard/panels/bot-builder/html.js"));
});
after(() => { try { db && db.close && db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

test("docsUrl joins the one exported base with a path", () => {
  assert.equal(DOCS_BASE, "https://maestro.press/software/crow/");
  assert.equal(docsUrl("guide/bot-builder-tutorial"), "https://maestro.press/software/crow/guide/bot-builder-tutorial");
  assert.equal(docsUrl("/guide/x"), "https://maestro.press/software/crow/guide/x", "leading slash stripped");
});

test("both locale tutorial docs exist and cross-link the reference", () => {
  for (const [f, ref] of [
    ["docs/guide/bot-builder-tutorial.md", "/guide/bot-builder"],
    ["docs/es/guide/bot-builder-tutorial.md", "/es/guide/bot-builder"],
  ]) {
    const path = new URL(`../${f}`, import.meta.url);
    assert.ok(existsSync(path), `${f} missing`);
    assert.ok(readFileSync(path, "utf8").includes(`](${ref})`), `${f} must cross-link the reference guide`);
  }
});

test("sidebar has both locale entries", () => {
  const cfg = readFileSync(new URL("../docs/.vitepress/config.ts", import.meta.url), "utf8");
  assert.ok(cfg.includes("'/guide/bot-builder-tutorial'"), "en sidebar entry");
  assert.ok(cfg.includes("'/es/guide/bot-builder-tutorial'"), "es sidebar entry");
});

function mkRes() {
  const res = { html: null };
  res.redirectAfterPost = () => {};
  res.send = (html) => { res.html = html; return res; };
  return res;
}

test("wizard template step links the tutorial in a new tab, per locale", async () => {
  for (const lang of ["en", "es"]) {
    const res = mkRes();
    await renderWizard({ method: "GET", query: { new: "1" }, headers: {} }, res,
      { db, layout: ({ content }) => content, lang, PAGE_CSS: "", notice: "" });
    const expected = docsUrl((lang === "es" ? "es/" : "") + "guide/bot-builder-tutorial");
    assert.ok(res.html.includes(expected), `${lang}: tutorial href present`);
    const a = res.html.slice(res.html.indexOf(expected) - 60, res.html.indexOf(expected) + 200);
    assert.match(a, /target="_blank"/, `${lang}: opens in a new tab (wizard stays alive)`);
    assert.match(a, /rel="noopener"/, `${lang}: rel=noopener`);
  }
});

test("list page links the tutorial beside the CTA", async () => {
  const res = mkRes();
  await renderBotList(res, { db, layout: ({ content }) => content, notice: "", PAGE_CSS: "", req: { headers: {} } });
  assert.ok(res.html.includes(docsUrl("guide/bot-builder-tutorial")), "tutorial href on the list page");
});

test("tutorialLink key ships en+es", () => {
  const e = translations["botbuilder.tutorialLink"];
  assert.ok(e && e.en && e.es && e.en !== e.es);
});
