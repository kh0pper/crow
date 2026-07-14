/**
 * Item 5 PR3 (spec §D6): the botbuilder-wide EN/ES parity guard.
 *
 * t() falls back `entry[lang] || entry.en || key`, so an en-present /
 * es-missing key silently renders ENGLISH in Spanish mode — invisible to any
 * "no bare key leakage" check. This test asserts every botbuilder.* key has
 * a non-empty es that DIFFERS from en, with a named-exceptions list for
 * strings that are legitimately identical (proper nouns, shared vocabulary).
 *
 * Also the de-jargon scan: user-facing copy in the panel's template literals
 * must not carry internal plan references or raw table names — those live in
 * code comments only (spec §D6). The scan strips comments first so comments
 * stay free to reference plans.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { translations } from "../servers/gateway/dashboard/shared/i18n.js";

// Strings where es === en is intentional. Every addition needs a reason.
const SAME_OK = new Set([
  "botbuilder.wizGw_gmail",     // proper noun
  "botbuilder.wizGw_discord",   // proper noun
  "botbuilder.wizGw_telegram",  // proper noun
  "botbuilder.wizGw_slack",     // proper noun
  "botbuilder.labelBash",       // literal policy field name ("bash")
  "botbuilder.labelExternalSend", // literal policy field name ("external_send")
  "botbuilder.thId",            // "ID" is identical in Spanish
  "botbuilder.skillsGroupGeneral", // "General" is identical in Spanish
  "botbuilder.monThId",         // "id" — identical technical abbreviation
  "botbuilder.monThBot",        // "bot" is identical in Spanish
  "botbuilder.monThEsc",        // "esc" — identical abbreviation
  "botbuilder.monThControl",    // "control" is identical in Spanish
]);

test("every botbuilder.* key has non-empty en and es", () => {
  const keys = Object.keys(translations).filter((k) => k.startsWith("botbuilder."));
  assert.ok(keys.length >= 190, `expected the full botbuilder key set, got ${keys.length}`);
  for (const k of keys) {
    const e = translations[k];
    assert.ok(typeof e.en === "string" && e.en.length, `${k} missing en`);
    assert.ok(typeof e.es === "string" && e.es.length, `${k} missing es`);
  }
});

test("es differs from en for every key not on the named-exceptions list", () => {
  const keys = Object.keys(translations).filter((k) => k.startsWith("botbuilder."));
  const unexpectedSame = keys.filter((k) => !SAME_OK.has(k) && translations[k].en === translations[k].es);
  assert.deepEqual(unexpectedSame, [], "es===en means the translation is missing (t() would silently render English)");
  // The exceptions list must not rot: every entry must still exist and still be identical.
  for (const k of SAME_OK) {
    assert.ok(translations[k], `${k} on SAME_OK no longer exists`);
    assert.equal(translations[k].en, translations[k].es, `${k} on SAME_OK is no longer identical — remove it`);
  }
});

test("placeholders match between en and es", () => {
  const keys = Object.keys(translations).filter((k) => k.startsWith("botbuilder."));
  for (const k of keys) {
    const ph = (s) => (s.match(/\{[a-z]+\}/g) || []).sort().join(",");
    assert.equal(ph(translations[k].en), ph(translations[k].es), `${k} placeholder mismatch between en and es`);
  }
});

// ---- de-jargon source scan ----

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/([^:"'])\/\/(?![^"'`\n]*["'`]\s*[,;)\]}]).*$/gm, "$1");
}

const PANEL = "servers/gateway/dashboard/panels/bot-builder";
const FILES = ["editor.js", "html.js", "wizard.js", "checklist.js", "delete-bot.js", "gateway-fields.js"];

// Internal references that must never reach user copy (spec §D6). Raw table
// names are allowed ONLY inside the review tab's Advanced disclosure, which
// deliberately shows pi_bot_defs.definition — that exact string is excluded.
const FORBIDDEN = [
  "Slice A", "Slice B", "F4a", "R13 ", "(plan", "plan &sect;", "Phase 3.1", "Phase 2.3",
  "bridge --inject", "(pi_bot_defs)", "bot_sessions —",
];

test("no internal plan references or raw table names in user-facing template literals", () => {
  for (const f of FILES) {
    const src = stripComments(readFileSync(new URL(`../${PANEL}/${f}`, import.meta.url), "utf8"));
    for (const bad of FORBIDDEN) {
      assert.ok(!src.includes(bad), `${f} still carries "${bad}" outside comments`);
    }
  }
});

test("the i18n'd hint strings themselves carry no plan references", () => {
  const keys = Object.keys(translations).filter((k) => k.startsWith("botbuilder."));
  for (const k of keys) {
    for (const bad of ["Slice A", "Slice B", "F4a", "Phase 3.1", "S4", "R13", "pi_bot_defs", "plan §"]) {
      assert.ok(!translations[k].en.includes(bad), `${k} en carries "${bad}"`);
      assert.ok(!translations[k].es.includes(bad), `${k} es carries "${bad}"`);
    }
  }
});
