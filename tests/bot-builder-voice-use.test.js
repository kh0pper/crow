/**
 * What Crow can do by voice (voice-use.js): the "By voice on displays: …"
 * line on Crow's card and in its editor, filled from ONE read of the Kiosk
 * listing (GET /api/kiosk/admin/displays → voice.abilities) per render, never
 * polled, never written.
 *
 * PR 1 retired the per-bot "Answers voice on: …" line and the "Use for
 * voice…" dialog (every voice surface answers as Crow): their exports, their
 * strings and every write they made are gone, and this file pins that.
 *
 * Runs the real emitted markup + script in linkedom (vm). Bot names are neutral.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";
import * as voiceUse from "../servers/gateway/dashboard/panels/bot-builder/voice-use.js";

const { voiceAbilityScript, abilityLineHtml } = voiceUse;
const T = (k) => translations[k].en;
const CROW = "crow.voice";
const listing = (voice = {}) => ({
  devices: [], bots: [], pending: [], stt_profiles: [], tts_profiles: [],
  voice: { bot_id: CROW, name: "Crow", fit: "full", fit_memory: "full", abilities: null, abilities_memory: null, ...voice },
});

function scriptsOf(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

/** A page with Crow's line (and an unrelated one), and the script. `replies`: { status, body, type, redirected } (default: the listing). */
function page({ replies = [], lang = "en", ids = [CROW, "alpha"] } = {}) {
  const html = voiceAbilityScript(lang);
  const { document } = parseHTML(`<html><body>${ids.map((id) => abilityLineHtml(id)).join("")}${html}</body></html>`);
  const calls = [];
  const queue = [...replies];
  const fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET" });
    const r = queue.length ? queue.shift() : {};
    const status = r.status || 200;
    const payload = r.body !== undefined ? r.body : listing();
    return {
      ok: status >= 200 && status < 300, status, redirected: !!r.redirected,
      headers: { get: (h) => (h.toLowerCase() === "content-type" ? (r.type || "application/json; charset=utf-8") : null) },
      json: async () => payload,
    };
  };
  const ctx = vm.createContext({ document, window: {}, fetch, JSON, String, Array, Object, Promise, encodeURIComponent });
  for (const src of scriptsOf(html)) vm.runInContext(src, ctx);
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
  const abil = (id) => document.querySelector(`.btb-abil[data-abil-bot="${id}"]`);
  return { document, calls, flush, abil };
}
const fillS = (k, o) => T(k).replace(/\{(\w+)\}/g, (m, x) => o[x]);

test("the emitted script is a template literal's worth: no backticks, no dollar-brace; the strings JSON cannot close its script", () => {
  const html = voiceAbilityScript("en");
  for (const src of scriptsOf(html)) { assert.ok(!src.includes("`")); assert.ok(!src.includes("${")); }
  const json = html.match(/<script type="application\/json" id="btb-abil-s">([\s\S]*?)<\/script>/)[1];
  assert.ok(!json.includes("<"));
  assert.equal(JSON.parse(json).abilBy, T("botbuilder.abilBy"));
});

test("Use for voice… and Answers voice on are gone: no exports, no strings, and the script never writes", () => {
  for (const name of ["voiceUseScript", "voiceUseDialogHtml", "voiceLineHtml", "voiceUseItemHtml"]) assert.equal(voiceUse[name], undefined, name);
  for (const k of ["botbuilder.rowUseForVoice", "botbuilder.voiceOn", "botbuilder.voicePhoneDash", "botbuilder.voiceAutomatic", "botbuilder.voiceUseTitle", "botbuilder.voiceUseSave"]) {
    assert.equal(translations[k], undefined, k);
  }
  const src = scriptsOf(voiceAbilityScript("en")).join("");
  for (const bit of ["POST", "dashboard-voice", "bound_bot_id", "btb-voice-use", "btb-vu"]) assert.ok(!src.includes(bit), bit);
});

test("ability line: Crow's abilities in order, a slower one marked, from one listing read; another bot's line stays hidden", async () => {
  const p = page({ replies: [{ body: listing({ abilities: { items: [{ id: "calendar", quick: false }, { id: "crow_messages", quick: true }], none: false } }) }] });
  await p.flush();
  assert.deepEqual(p.calls, [{ url: "/api/kiosk/admin/displays", method: "GET" }], "one read, no interval, no write");
  const want = fillS("botbuilder.abilBy", { list: `${T("botbuilder.abilCrowMessages")} · ${fillS("botbuilder.abilSlowGroup", { list: T("botbuilder.abilCalendar") })}` });
  assert.equal(want, "By voice on displays: Crow messages · slower (bigger model): calendar");
  assert.equal(p.abil(CROW).hidden, false);
  assert.equal(p.abil(CROW).textContent, want);
  assert.equal(p.abil("alpha").hidden, true, "only the voice bot named by the listing gets a line");
});

test("ability line: nothing it can do → 'answers questions only'", async () => {
  const p = page({ replies: [{ body: listing({ abilities: { items: [], none: true } }) }] });
  await p.flush();
  assert.equal(p.abil(CROW).hidden, false);
  assert.equal(p.abil(CROW).textContent, T("botbuilder.abilNone"));
});

test("ability line: more than four → the first four and '+N more', the whole list in the title", async () => {
  const items = ["calendar", "reminders", "messages", "lists", "projects", "files"].map((id) => ({ id, quick: true }));
  const p = page({ replies: [{ body: listing({ abilities: { items, none: false } }) }] });
  await p.flush();
  const words = [T("botbuilder.abilCalendar"), T("botbuilder.abilReminders"), T("botbuilder.abilMessages"), T("botbuilder.abilLists")];
  assert.equal(p.abil(CROW).textContent, fillS("botbuilder.abilBy", { list: `${words.join(", ")}, ${fillS("botbuilder.abilMore", { n: 2 })}` }));
  assert.equal(p.abil(CROW).getAttribute("title"), fillS("botbuilder.abilBy", { list: [...words, T("botbuilder.abilProjects"), T("botbuilder.abilFiles")].join(", ") }));
});

test("ability line: an add-on's name is data — text, never markup; an id the page does not know is left out", async () => {
  const p = page({ replies: [{ body: listing({ abilities: { items: [{ id: "addon:notes", quick: true, label: "<b>Notes</b>" }, { id: "weather", quick: true }, { id: "By", quick: true }, { id: "memory", quick: true }], none: false } }) }] });
  await p.flush();
  const n = p.abil(CROW);
  assert.equal(n.textContent, fillS("botbuilder.abilBy", { list: `<b>Notes</b>, ${T("botbuilder.abilMemory")}` }));
  assert.equal(n.querySelector("b"), null);
});

test("ability line: no field (an older Kiosk), null (a failed check), no voice object, a 404, a login page, a redirect or a network error → stays hidden", async () => {
  for (const reply of [{ body: listing({ abilities: null }) }, { body: { devices: [], bots: [] } }, { body: listing({ bot_id: "someone-else", abilities: { items: [], none: true } }) },
    { status: 404, body: { error: "not_found" } }, { type: "text/html", body: {} }, { redirected: true }, { status: 500, body: {} }]) {
    const p = page({ replies: [reply] });
    await p.flush();
    assert.equal(p.abil(CROW).hidden, true, JSON.stringify(reply));
  }
  const { document } = parseHTML(`<html><body>${abilityLineHtml(CROW)}</body></html>`);
  const ctx = vm.createContext({ document, window: {}, fetch: () => { throw new Error("offline"); }, JSON, String, Array, Object, Promise, encodeURIComponent });
  for (const src of scriptsOf(voiceAbilityScript("en"))) assert.doesNotThrow(() => vm.runInContext(src, ctx));
});

test("ability line: Spanish labels on a Spanish page", async () => {
  const p = page({ lang: "es", replies: [{ body: listing({ abilities: { items: [{ id: "lists", quick: false }], none: false } }) }] });
  await p.flush();
  assert.equal(p.abil(CROW).textContent, "Por voz en pantallas, más lento (modelo grande): listas");
});

test("ability line: slower ones grouped at the tail, the cap counting both groups, the whole line in the title (en and es)", async () => {
  const Q = (id) => ({ id, quick: true }), W = (id) => ({ id, quick: false });
  const items = [W("calendar"), W("reminders"), Q("crow_messages"), W("lists"), Q("projects")];
  const p = page({ replies: [{ body: listing({ abilities: { items, none: false } }) }] });
  await p.flush();
  assert.equal(p.abil(CROW).textContent, "By voice on displays: Crow messages, projects & notes · slower (bigger model): calendar, reminders, +1 more");
  assert.equal(p.abil(CROW).getAttribute("title"), "By voice on displays: Crow messages, projects & notes · slower (bigger model): calendar, reminders, lists");
  const e = page({ lang: "es", replies: [{ body: listing({ abilities: { items: items.slice(0, 4), none: false } }) }] });
  await e.flush();
  assert.equal(e.abil(CROW).textContent, "Por voz en pantallas: mensajes de Crow · más lento (modelo grande): calendario, recordatorios, listas");
  const only = page({ replies: [{ body: listing({ abilities: { items: [W("calendar"), W("reminders")], none: false } }) }] });
  await only.flush();
  assert.equal(only.abil(CROW).textContent, "By voice on displays, slower (bigger model): calendar, reminders");
});
