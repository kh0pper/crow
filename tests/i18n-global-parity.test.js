/**
 * Global EN/ES parity gate over EVERY key in the dashboard i18n table
 * (Item D minors batch; extends the per-panel guards in
 * bot-builder-i18n-parity.test.js / settings-i18n-section-labels.test.js
 * to the whole ~1,400-key surface).
 *
 * What it enforces, for ALL keys:
 *   1. en and es are both present, non-empty strings.
 *   2. es !== en — because t() falls back to en, an identical es is an
 *      INVISIBLE missing translation — except for the named exceptions
 *      below (strings that are legitimately the same word in Spanish:
 *      "Error", "RAM", "URL", product names, hex/enum labels…).
 *   3. Anti-rot: every exception key must still exist AND still be
 *      identical. If someone later translates one, the stale exception
 *      fails the suite so the list can't accumulate dead entries.
 *   4. {placeholder} sets match between en and es.
 *   5. No language variants beyond SUPPORTED_LANGS sneak into an entry.
 *
 * Also covers fill(), the $-safe interpolation helper added alongside this
 * gate: String.replace("{x}", value) treats $&, $', $`, $$ specially in the
 * replacement string, so user-controlled values (bot ids, device names)
 * could render mangled. fill() must insert them verbatim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { translations, SUPPORTED_LANGS, fill } from "../servers/gateway/dashboard/shared/i18n.js";

// Keys whose en and es are legitimately identical (reviewed 2026-07-18 —
// language-neutral terms, product/protocol names, numerals, enum labels).
const IDENTICAL_OK = new Set([
  "nav.blog",
  "login.2faPlaceholder", // "000000"
  "common.error", // "Error" is Spanish too
  "notif.ram",
  "notif.cpus",
  "health.cpu",
  "health.ram",
  "health.docker",
  "messages.info",
  "messages.error",
  "messages.tokens",
  "messages.botTag", // "bot"
  "blog.pageTitle",
  "blog.total",
  "blog.rss",
  "blog.atom",
  "blog.tableSlug", // "Slug" — technical term
  "files.general",
  "files.blogBadge",
  "files.docCategory", // "Doc"
  "extensions.categorySocial",
  "botbuilder.labelBash",
  "botbuilder.labelExternalSend", // raw tool id, deliberately untranslated
  "botbuilder.thId", // "ID"
  "botbuilder.skillsGroupGeneral",
  "botbuilder.wizGw_gmail", // channel product names
  "botbuilder.wizGw_discord",
  "botbuilder.wizGw_telegram",
  "botbuilder.wizGw_slack",
  "botbuilder.monThId",
  "botbuilder.monThBot",
  "botbuilder.monThEsc", // column abbreviation
  "botbuilder.monThControl", // "control" is Spanish too
  "botboard.jsLeasePrefix", // prefixes a raw English enum value — translating only the prefix buys nothing
  "botboard.labelBotSwitcher", // "Bot"
  "botboard.colBot",
  "settings.ed25519", // key-algorithm name
  "settings.serif",
  "settings.local",
  "settings.tailnetLan", // "Tailnet / LAN"
  "settings.url",
  "settings.group.general",
  "syncConflicts.colOp", // "Op" — abbreviation of operación
  "contacts.typeManual", // "Manual" is Spanish too
  "contacts.fieldCrowId", // "Crow ID" — product term
  "contacts.manual",
  "contacts.groupColor", // "Color" is Spanish too
  "connect.localStdioHeading", // "Local (stdio)"
  // Model Catalog panel (Item G Task 13, reviewed 2026-07-18)
  "models.runtimeBinary", // "Runtime: {name} {release}" — "runtime" is used untranslated in Spanish tech contexts
  "models.runtimeGpu", // "GPU: {gpu} ({vram})" — GPU is an acronym, unchanged in Spanish
  "models.runtimeColPid", // "PID" — abbreviation, unchanged in Spanish
  "models.hfTokenPlaceholder", // "hf_..." — literal input placeholder prefix, language-neutral
]);

const keys = Object.keys(translations);

test("every key has non-empty en and es", () => {
  for (const k of keys) {
    const v = translations[k];
    for (const lang of SUPPORTED_LANGS) {
      assert.equal(typeof v[lang], "string", `${k} missing ${lang}`);
      assert.ok(v[lang].length > 0, `${k} has empty ${lang}`);
    }
  }
});

test("es differs from en except for the named exceptions", () => {
  const offenders = keys.filter(
    (k) => translations[k].es === translations[k].en && !IDENTICAL_OK.has(k),
  );
  assert.deepEqual(
    offenders,
    [],
    `untranslated keys (es === en): ${offenders.join(", ")} — translate them ` +
      "or, if the string is legitimately identical in Spanish, add the key " +
      "to IDENTICAL_OK with a reason",
  );
});

test("anti-rot: every exception key still exists and is still identical", () => {
  for (const k of IDENTICAL_OK) {
    assert.ok(translations[k], `IDENTICAL_OK entry ${k} no longer exists — remove it`);
    assert.equal(
      translations[k].es,
      translations[k].en,
      `IDENTICAL_OK entry ${k} is no longer identical (it was translated) — remove the stale exception`,
    );
  }
});

test("{placeholder} sets match between en and es for every key", () => {
  const ph = (s) => (s.match(/\{[a-zA-Z0-9_]+\}/g) || []).sort().join(",");
  for (const k of keys) {
    assert.equal(
      ph(translations[k].en),
      ph(translations[k].es),
      `${k}: placeholder mismatch between en ("${translations[k].en}") and es ("${translations[k].es}")`,
    );
  }
});

test("entries carry only supported language codes", () => {
  const allowed = new Set(SUPPORTED_LANGS);
  for (const k of keys) {
    for (const lang of Object.keys(translations[k])) {
      assert.ok(allowed.has(lang), `${k} carries unsupported language "${lang}"`);
    }
  }
});

// ---- fill() — $-safe interpolation ----

test("fill inserts $-laden user values verbatim", () => {
  assert.equal(fill("Bot {id} exists", { id: "a$&b" }), "Bot a$&b exists");
  assert.equal(fill("Device {name}", { name: "x$'y$`z" }), "Device x$'y$`z");
  assert.equal(fill("Cost {n}", { n: "$$5" }), "Cost $$5");
  assert.equal(fill("{a} and {b}", { a: "$1", b: "$<x>" }), "$1 and $<x>");
});

test("fill replaces every occurrence and handles numbers and missing params", () => {
  assert.equal(fill("{n} of {n}", { n: 3 }), "3 of 3");
  assert.equal(fill("no params here", {}), "no params here");
  assert.equal(fill("keep {unknown}", { other: "x" }), "keep {unknown}");
  assert.equal(fill("keep {unknown}", undefined), "keep {unknown}");
});
