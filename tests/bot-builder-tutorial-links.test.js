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
import { translations, t } from "../servers/gateway/dashboard/shared/i18n.js";

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

// T13: the bot list is a card grid. The tutorial must not point at the old
// list's "Delete this bot…" link, and must name the card's actions with the
// exact UI strings (read from i18n, so a later rename fails here instead of
// leaving the docs silently stale).
test("tutorial describes the card grid with the current UI strings, per locale (no stale bot-list delete link)", () => {
  for (const [lang, f, heading, ref, anchor] of [
    ["en", "docs/guide/bot-builder-tutorial.md", "## Your bot list", "docs/guide/bot-builder.md", "](/guide/bot-builder-tutorial#your-bot-list)"],
    ["es", "docs/es/guide/bot-builder-tutorial.md", "## Tu lista de bots", "docs/es/guide/bot-builder.md", "](/es/guide/bot-builder-tutorial#tu-lista-de-bots)"],
  ]) {
    const doc = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(doc, /link on the bot list|enlace \*\*Eliminar este bot…\*\* en la lista/, `${lang}: stale bot-list delete link`);
    assert.ok(doc.includes("**⋯**"), `${lang}: names the card's ⋯ menu`);
    assert.ok(doc.includes(`\n${heading}\n`), `${lang}: has the "${heading}" section`);
    for (const key of ["botbuilder.rowDelete", "botbuilder.rowTurnOn", "botbuilder.rowGiveTask", "botboard.giveTo", "botboard.unassignedLane"]) {
      const label = t(key, lang);
      assert.ok(label && label !== key, `${key} has a ${lang} string`);
      assert.ok(doc.includes(`**${label}**`), `${lang}: tutorial names **${label}** (${key})`);
    }
    const refDoc = readFileSync(new URL(`../${ref}`, import.meta.url), "utf8");
    assert.ok(refDoc.includes(anchor), `${lang}: the reference page links the bot-list section`);
  }
});
