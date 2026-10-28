// Redesign P5 Task 5.3: the offer, the "card made" note and the card chip in the Perch chat.
// The snippet runs in a vm sandbox with the hub's shared-scope helpers stubbed
// (tests/perch-artifact-card.test.js pattern). GET .../card is Task 5.4's route: stubbed here.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { perchHubJs } from "../servers/gateway/dashboard/perch-hub/client.js";
import { perchCardChipJs } from "../servers/gateway/dashboard/perch-hub/card-chip.js";
import { t, translations } from "../servers/gateway/dashboard/shared/i18n.js";

function makeEl(tag) {
  const node = {
    tagName: String(tag || "div").toUpperCase(), children: [], parentNode: null,
    className: "", textContent: "", disabled: false, href: "", type: "", onclick: null, style: {},
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c, ref) { const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) return this.appendChild(c); this.children.splice(i, 0, c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    setAttribute(k, v) { this["attr:" + k] = v; },
    get firstChild() { return this.children[0] || null; },
  };
  Object.defineProperty(node, "innerHTML", { set() { throw new Error("innerHTML sink reached"); }, get() { return ""; } });
  return node;
}
function walk(n, fn) { fn(n); for (const c of n.children) walk(c, fn); }
function byClass(n, cls) { const o = []; walk(n, (x) => { if (String(x.className || "").split(/\s+/).includes(cls)) o.push(x); }); return o; }
function allText(n) { const o = []; walk(n, (x) => { if (x.textContent) o.push(x.textContent); }); return o; }
function hasAncestorClass(n, cls) { for (let p = n.parentNode; p; p = p.parentNode) if (String(p.className || "").split(/\s+/).includes(cls)) return true; return false; }
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

const SID = "perchlive-aaaaaaaa";
function memStore() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
function mount({ offers = [], card = null, result = null, decisions = [], decide = () => json({ ok: true }), review = () => json({ ok: true }), storage = memStore() } = {}) {
  const transcript = makeEl("div");
  const input = makeEl("textarea"); input.value = "";
  const state = { offers, card, result, decisions, sent: [] };
  const fetches = [];
  const sandbox = {
    console,
    document: { createElement: (tag) => makeEl(tag) },
    API: "/dashboard/perch-api",
    el: (id) => (id === "perch-transcript" ? transcript : id === "perch-input" ? input : null),
    send() { state.sent.push(input.value); input.value = ""; },
    csrf: () => "tok", live: () => true, current: { sid: SID },
    window: { sessionStorage: storage },
    fetch(url, opts) {
      const method = (opts && opts.method) || "GET";
      const u = String(url);
      fetches.push({ method, url: u, body: opts && opts.body ? JSON.parse(opts.body) : undefined });
      if (method === "GET" && u.endsWith("/offers")) return Promise.resolve(json({ offers: state.offers }));
      if (method === "GET" && u.endsWith("/card")) return Promise.resolve(json({ card: state.card, result: state.result, decisions: state.decisions }));
      if (method === "POST" && /\/offers\/\d+\/decide$/.test(u)) return Promise.resolve(decide(u, fetches[fetches.length - 1].body));
      if (method === "POST") return Promise.resolve(review(u, fetches[fetches.length - 1].body));
      return Promise.resolve(json({}));
    },
    __export(api) { sandbox.api = api; },
  };
  sandbox.line = (cls, text) => { const d = makeEl("div"); if (cls) d.className = cls; d.textContent = text == null ? "" : String(text); return d; };
  vm.createContext(sandbox);
  vm.runInContext(`(function(){\n${perchCardChipJs("en")}\n;__export({ loadCardOffers: loadCardOffers, loadCardChip: loadCardChip, cardTurnState: cardTurnState, reset: resetCardChip });\n})();`, sandbox);
  return { sandbox, transcript, input, fetches, state, storage, api: sandbox.api };
}
const offer = (o) => ({ id: 5, title: "Draft the reply", projectId: 2, projectName: "Garden", status: "pending", cardId: null, ...o });

test("the snippet is spliced into the hub script", () => {
  for (const lang of ["en", "es"]) {
    const js = perchHubJs(lang);
    assert.ok(js.includes(perchCardChipJs(lang)), "spliced verbatim");
    assert.doesNotThrow(() => new Function(js), lang + " parses");
    assert.equal(perchCardChipJs(lang).includes("`"), false, "no backtick");
    assert.equal(perchCardChipJs(lang).includes("${"), false, "no dollar-brace");
    assert.ok(!/\.innerHTML\s*\+?=|insertAdjacentHTML|document\.write/.test(perchCardChipJs(lang)), "no HTML sink");
  }
  assert.ok(perchCardChipJs("es").includes("¿Creo esta tarjeta?"));
  const src = readFileSync(new URL("../servers/gateway/dashboard/perch-hub/card-chip.js", import.meta.url), "utf8");
  for (const k of new Set([...src.matchAll(/tJs\("([^"]+)"/g)].map((m) => m[1]))) {
    if (/^shell\.lane/.test(k)) continue;   // the P3 lane labels arrive with P3
    assert.ok(translations[k] && translations[k].en && translations[k].es, k + " has en and es");
  }
});

test("a pending offer draws one card with two buttons; a declined offer draws nothing", async () => {
  const h = mount({ offers: [offer(), offer({ id: 6, status: "declined" })] });
  h.api.loadCardOffers(SID); await tick();
  const cards = byClass(h.transcript, "perch-offer");
  assert.equal(cards.length, 1);
  assert.equal(h.transcript.children.length, 1);
  assert.equal(byClass(cards[0], "offer-make")[0].textContent, "Make card");
  assert.equal(byClass(cards[0], "offer-no")[0].textContent, "Not now");
  const txt = allText(cards[0]);
  assert.ok(txt.includes("Make this card?") && txt.includes("Draft the reply") && txt.includes("Garden"));
  h.api.loadCardOffers(SID); await tick();
  assert.equal(byClass(h.transcript, "perch-offer").length, 1, "a reload does not duplicate");
});

test("Make card posts once and sends nothing to the bot", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = mount({ offers: [offer()], decide: () => gate.then(() => json({ ok: true, status: "accepted" })) });
  h.api.loadCardOffers(SID); await tick();
  const card = byClass(h.transcript, "perch-offer")[0];
  const make = byClass(card, "offer-make")[0], no = byClass(card, "offer-no")[0];
  make.onclick(); make.onclick();
  assert.equal(make.disabled, true); assert.equal(no.disabled, true);
  h.state.offers = [offer({ status: "accepted", cardId: 9 })];
  release(); await tick();
  const posts = h.fetches.filter((f) => f.method === "POST");
  assert.deepEqual(posts.map((p) => [p.url, p.body]), [["/dashboard/perch-api/offers/5/decide", { accept: true }]]);
  assert.ok(!h.fetches.some((f) => /\/message/.test(f.url)), "no message to the bot");
});

test("Not now posts accept:false and the card leaves", async () => {
  const h = mount({ offers: [offer()] });
  h.api.loadCardOffers(SID); await tick();
  h.state.offers = [offer({ status: "declined" })];
  byClass(h.transcript, "offer-no")[0].onclick(); await tick();
  assert.deepEqual(h.fetches.filter((f) => f.method === "POST").map((p) => p.body), [{ accept: false }]);
  assert.equal(byClass(h.transcript, "perch-offer").length, 0);
});

test("an accepted offer is a system note, not a message", async () => {
  const h = mount({ offers: [offer({ id: 4, status: "accepted", cardId: 9 })] });
  h.api.loadCardOffers(SID); await tick();
  const notes = byClass(h.transcript, "perch-sysnote");
  assert.equal(notes.length, 1);
  assert.equal(byClass(h.transcript, "perch-offer").length, 0);
  assert.ok(!hasAncestorClass(notes[0], "msg") && !hasAncestorClass(notes[0], "bubble"));
  assert.ok(!/(^|\s)(msg|bubble)(\s|$)/.test(notes[0].className));
  assert.equal(allText(notes[0])[0], "Card #9 made on Garden.");
  assert.equal(allText(notes[0])[1], "Draft the reply", "the title is its own text node");
  assert.equal(byClass(notes[0], "avatar").length, 0);
});

test("the note uses the offer row's project name, not the bot's board at offer time", async () => {
  const h = mount({ offers: [offer({ status: "accepted", cardId: 3, projectId: 7, projectName: "Moved board" })] });
  h.api.loadCardOffers(SID); await tick();
  assert.equal(allText(byClass(h.transcript, "perch-sysnote")[0])[0], "Card #3 made on Moved board.");
});

test("a hostile title stays text in the offer, the note and the chip", async () => {
  const evil = "<img src=x onerror=alert(1)>";
  const h = mount({ offers: [offer({ title: evil }), offer({ id: 6, title: evil, status: "accepted", cardId: 9 })], card: { id: 9, title: evil, lane: "working", projectId: 2 } });
  h.api.loadCardOffers(SID); h.api.loadCardChip(SID); await tick();
  let imgs = 0, hits = 0;
  walk(h.transcript, (n) => { if (n.tagName === "IMG") imgs++; if (n.textContent === evil) hits++; });
  assert.equal(imgs, 0);
  assert.equal(h.transcript.children.length, 3);
  assert.equal(hits, 3, "literal text in all three");
});

test("a 409 refreshes instead of retrying", async () => {
  const h = mount({ offers: [offer()], decide: () => json({ error: "already_decided" }, 409) });
  h.api.loadCardOffers(SID); await tick();
  h.state.offers = [offer({ status: "accepted", cardId: 9 })];
  byClass(h.transcript, "offer-make")[0].onclick(); await tick();
  assert.equal(h.fetches.filter((f) => f.method === "POST").length, 1, "one POST, no retry");
  assert.equal(byClass(h.transcript, "perch-offer").length, 0);
  assert.equal(byClass(h.transcript, "perch-sysnote").length, 1, "redrawn from the server");
});

test("a failed decide re-enables the buttons and says so", async () => {
  const h = mount({ offers: [offer()], decide: () => json({}, 500) });
  h.api.loadCardOffers(SID); await tick();
  const card = byClass(h.transcript, "perch-offer")[0];
  byClass(card, "offer-make")[0].onclick(); await tick();
  assert.equal(byClass(card, "offer-make")[0].disabled, false);
  assert.ok(allText(card).includes("That did not work. Try again."));
});

test("the chip shows the server's lane", async () => {
  const h = mount({ card: { id: 9, title: "T", lane: "working", projectId: 2 } });
  h.api.loadCardChip(SID); await tick();
  const chip = byClass(h.transcript, "perch-cardchip");
  assert.equal(chip.length, 1);
  const txt = allText(chip[0]).join(" ");
  assert.ok(txt.includes("#9") && txt.includes(t("shell.laneWorking")));
  const main = byClass(chip[0], "cardchip-link")[0];
  assert.equal(main.href, "/dashboard/board?project=2#card-9");
  const det = byClass(chip[0], "cardchip-details")[0];
  assert.equal(det.href, "/dashboard/bot-board?card=9", "no bot: the standalone card view");
  h.state.card = { id: 9, title: "T", lane: "done", projectId: 2 };
  h.api.loadCardChip(SID); await tick();
  assert.equal(byClass(h.transcript, "perch-cardchip").length, 1, "one chip, redrawn in place");
  assert.ok(allText(byClass(h.transcript, "perch-cardchip")[0]).join(" ").includes(t("shell.laneDone")));
  h.state.card = null;
  h.api.loadCardChip(SID); await tick();
  assert.equal(byClass(h.transcript, "perch-cardchip").length, 0, "no card, no chip");
});

test("a turn ending reloads both; working to working does not", async () => {
  const h = mount({ offers: [offer()], card: { id: 9, title: "T", lane: "working", projectId: 2 } });
  h.api.cardTurnState("working"); h.api.cardTurnState("working"); await tick();
  assert.equal(h.fetches.length, 0);
  h.api.cardTurnState("idle"); await tick();
  assert.deepEqual(h.fetches.map((f) => f.url.split("/").pop()).sort(), ["card", "offers"]);
});

test("offers, notes and the chip come back on reload: flushHistBuf calls both loaders; tool and state frames too", () => {
  const js = perchHubJs("en");
  assert.match(js, /loadArtifactCards\(current\.sid\);[^\n]*\n\s*loadCardOffers\(current\.sid\);[^\n]*\n\s*loadCardChip\(current\.sid\);/);
  assert.match(js, /cardTurnState\(d\.state\)/);
  assert.match(js, /indexOf\('board_offer_card'\)>=0&&current\.sid\) loadCardOffers/);
  assert.equal((js.match(/resetCardChip\(\);/g) || []).length, 3, "every transcript reset also resets the chip");
});

test("i18n: the P5 keys exist in en and es", () => {
  for (const k of ["shell.offerTitle", "shell.offerMake", "shell.offerNotNow", "shell.cardMadeNote", "shell.cardDetails", "shell.offerFailed",
    "shell.accept", "shell.askChange", "shell.changePlaceholder", "shell.other", "shell.sendAgain"]) {
    assert.ok(translations[k].en && translations[k].es, k);
  }
  assert.equal(translations["shell.cardMadeNote"].en, "Card #{n} made on {project}.");
});

// ---- Task 5.4: Accept, Ask for a change, Not now, and decision chips ----

const CARD = { id: 9, title: "T", lane: "needs_you", projectId: 2 };
const RESULT = { id: 31, outcome: "success", summaryMd: "Did the thing." };
const DECISION = {
  cardId: 41, question: "Left or right?",
  options: [
    { index: 0, label: "Left", consequence: "We go left.", recommended: true },
    { index: 1, label: "Right", consequence: "We go right.", recommended: false },
  ],
};
const posts = (h) => h.fetches.filter((f) => f.method === "POST").map((p) => [p.url, p.body]);
const review = (h) => byClass(h.transcript, "perch-review");

test("i18n: the 5.4 strings, and the reused P3 confirm", () => {
  assert.deepEqual(translations["shell.accept"], { en: "Accept", es: "Aceptar" });
  assert.deepEqual(translations["shell.askChange"], { en: "Ask for a change", es: "Pedir un cambio" });
  assert.deepEqual(translations["shell.changePlaceholder"], { en: "What should change?", es: "¿Qué debería cambiar?" });
  assert.deepEqual(translations["shell.other"], { en: "Other…", es: "Otra…" });
  assert.deepEqual(translations["shell.sendAgain"], { en: "Send again", es: "Enviar de nuevo" });
  const chip = readFileSync(new URL("../servers/gateway/dashboard/perch-hub/card-chip.js", import.meta.url), "utf8");
  for (const k of ["shell.confirmNotFullSuccess", "shell.confirmAcceptYes", "shell.confirmAcceptNo", "shell.refuseDecision"]) {
    assert.ok(chip.includes('tJs("' + k + '", lang)'), "P3's " + k + " is reused");
  }
  const src = readFileSync(new URL("../servers/gateway/dashboard/shared/i18n.js", import.meta.url), "utf8");
  for (const k of ["shell.cardDetails", "shell.accept", "shell.confirmNotFullSuccess", "shell.offerNotNow"]) {
    assert.equal(src.split('"' + k + '":').length - 1, 1, k + " is defined once");
  }
});

test("chips show only while something is open", async () => {
  const h = mount({ card: CARD, result: RESULT, decisions: [DECISION] });
  h.api.loadCardChip(SID); await tick();
  assert.equal(review(h).length, 1);
  const box = review(h)[0];
  assert.equal(h.transcript.children[h.transcript.children.length - 1], box, "under the newest reply: last in the transcript");
  assert.equal(byClass(box, "review-accept")[0].textContent, "Accept");
  assert.equal(byClass(box, "review-change")[0].textContent, "Ask for a change");
  assert.equal(byClass(box, "review-notnow")[0].textContent, "Not now");
  assert.ok(allText(box).includes("Did the thing."));
  assert.ok(allText(box).includes("Left or right?"));
  assert.deepEqual(byClass(box, "review-opt").map((b) => b.textContent), ["Left", "Right"]);
  assert.ok(allText(box).includes("We go left."));
  assert.equal(byClass(box, "review-other")[0].textContent, "Other…");

  h.state.result = null; h.state.decisions = [];
  h.api.loadCardChip(SID); await tick();
  assert.equal(review(h).length, 0, "the server says nothing is open: the chips go");
  assert.equal(byClass(h.transcript, "perch-cardchip").length, 1, "the card chip stays");

  const none = mount({ card: CARD });
  none.api.loadCardChip(SID); await tick();
  assert.equal(review(none).length, 0);
  const noCard = mount({ card: null, result: RESULT });
  noCard.api.loadCardChip(SID); await tick();
  assert.equal(review(noCard).length, 0, "a result without this chat's card draws nothing");
});

test("a hostile summary, question and option stay text", async () => {
  const evil = "<img src=x onerror=alert(1)>";
  const h = mount({ card: CARD, result: { ...RESULT, summaryMd: evil },
    decisions: [{ cardId: 41, question: evil, options: [{ index: 0, label: evil, consequence: evil, recommended: true }] }] });
  h.api.loadCardChip(SID); await tick();
  let imgs = 0, hits = 0;
  walk(h.transcript, (n) => { if (n.tagName === "IMG") imgs++; if (n.textContent === evil) hits++; });
  assert.equal(imgs, 0);
  assert.equal(hits, 4, "summary, question, label, consequence");
});

test("Accept posts the shown result id once, then redraws from the server", async () => {
  const h = mount({ card: CARD, result: RESULT });
  h.api.loadCardChip(SID); await tick();
  const acc = byClass(h.transcript, "review-accept")[0];
  h.state.result = null; h.state.card = { ...CARD, lane: "done" };
  acc.onclick(); acc.onclick(); await tick();
  assert.deepEqual(posts(h), [["/dashboard/perch-api/cards/9/accept", { result_id: 31 }]]);
  assert.equal(review(h).length, 0);
  assert.equal(h.state.sent.length, 0, "Accept says nothing to the bot");
});

test("R-P5-4: Accept on a failure or partial result asks first", async () => {
  for (const outcome of ["failure", "partial"]) {
    const h = mount({ card: CARD, result: { ...RESULT, outcome } });
    h.api.loadCardChip(SID); await tick();
    const box = review(h)[0];
    byClass(box, "review-accept")[0].onclick(); await tick();
    assert.equal(posts(h).length, 0, "nothing sent before the confirm");
    const confirm = byClass(box, "review-confirm")[0];
    assert.equal(confirm.hidden, false);
    assert.equal(allText(confirm)[0], "This result isn't a full success. Accept it and close the card?");
    byClass(confirm, "review-confirm-no")[0].onclick(); await tick();
    assert.equal(confirm.hidden, true);
    assert.equal(posts(h).length, 0, "No writes nothing");
    assert.equal(byClass(box, "review-accept")[0].disabled, false);
    byClass(box, "review-accept")[0].onclick(); await tick();
    byClass(confirm, "review-confirm-yes")[0].onclick(); await tick();
    assert.deepEqual(posts(h), [["/dashboard/perch-api/cards/9/accept", { result_id: 31, accept_failure: true }]]);
  }
});

test("a server confirm_failure also opens the confirm", async () => {
  const h = mount({ card: CARD, result: RESULT, review: () => json({ error: "confirm_failure", reason: "confirm_failure" }, 409) });
  h.api.loadCardChip(SID); await tick();
  const box = review(h)[0];
  byClass(box, "review-accept")[0].onclick(); await tick();
  assert.equal(byClass(box, "review-confirm")[0].hidden, false);
  assert.equal(posts(h).length, 1);
});

test("a stale Accept redraws; a failed one says so and can be tried again", async () => {
  const stale = mount({ card: CARD, result: RESULT, review: () => json({ error: "stale" }, 409) });
  stale.api.loadCardChip(SID); await tick();
  stale.state.result = { ...RESULT, id: 32, summaryMd: "Newer." };
  byClass(stale.transcript, "review-accept")[0].onclick(); await tick();
  assert.equal(posts(stale).length, 1, "no retry");
  assert.ok(allText(review(stale)[0]).includes("Newer."), "redrawn with what is there now");
  assert.equal(byClass(review(stale)[0], "review-accept")[0].disabled, false);

  const bad = mount({ card: CARD, result: RESULT, review: () => json({}, 500) });
  bad.api.loadCardChip(SID); await tick();
  byClass(bad.transcript, "review-accept")[0].onclick(); await tick();
  assert.equal(byClass(bad.transcript, "review-accept")[0].disabled, false);
  assert.ok(allText(review(bad)[0]).includes("That did not work. Try again."));
});

const MSG = "/dashboard/perch-api/interactive/" + SID + "/message";
const CHANGE = "/dashboard/perch-api/cards/9/request-change";
async function askChange(h, words) {
  const box = review(h)[0];
  byClass(box, "review-change")[0].onclick();
  byClass(box, "review-input")[0].value = words;
  byClass(box, "review-send")[0].onclick(); await tick();
}

test("Ask for a change rejects the shown result, then sends the words straight to this chat", async () => {
  const h = mount({ card: CARD, result: RESULT });
  h.sandbox.pendingImages = ["img"]; h.sandbox.pendingFilePaths = ["/tmp/x"];
  h.api.loadCardChip(SID); await tick();
  const box = review(h)[0];
  const field = byClass(box, "review-field")[0];
  assert.equal(field.hidden, true);
  byClass(box, "review-change")[0].onclick();
  assert.equal(field.hidden, false);
  const ta = byClass(field, "review-input")[0];
  assert.equal(ta["attr:placeholder"], "What should change?");
  assert.equal(ta.maxLength, 4000);
  byClass(field, "review-send")[0].onclick(); await tick();
  assert.equal(posts(h).length, 0, "an empty change sends nothing");
  ta.value = "  Use the blue one. ";
  h.input.value = "my draft";
  h.state.result = null;
  byClass(field, "review-send")[0].onclick(); await tick();
  assert.deepEqual(posts(h), [
    [CHANGE, { result_id: 31, text: "Use the blue one." }],
    [MSG, { message: "Use the blue one." }],
  ], "the rejection, then one ordinary message with no attachments");
  assert.deepEqual(h.state.sent, [], "the composer's send() is never used");
  assert.equal(h.input.value, "my draft", "the composer's draft is untouched");
  assert.deepEqual(h.sandbox.pendingImages, ["img"], "pending attachments are not consumed");
  assert.deepEqual(h.sandbox.pendingFilePaths, ["/tmp/x"]);
  assert.equal(review(h).length, 0, "refreshed only after the send succeeded");
});

for (const draft of ["", "my own draft"]) {
  test("R-P5-8: a failed send keeps the words and offers Send again (composer draft " + (draft ? "present" : "empty") + ")", async () => {
    let msgOk = false;
    const h = mount({ card: CARD, result: RESULT, review: (u) => (u === MSG ? (msgOk ? json({ ok: true }) : json({ error: "pi_gone" }, 409)) : json({ ok: true })) });
    h.input.value = draft;
    h.api.loadCardChip(SID); await tick();
    h.state.result = null;   // the rejection landed: the server no longer offers the result
    await askChange(h, "Use the blue one.");
    assert.deepEqual(posts(h).map((p) => p[0]), [CHANGE, MSG]);
    let box = review(h);
    assert.equal(box.length, 1, "the review stays on screen");
    assert.equal(byClass(box[0], "review-input")[0].value, "Use the blue one.", "the words are still in the field");
    assert.ok(allText(box[0]).includes("That did not work. Try again."));
    const again = byClass(box[0], "review-resend")[0];
    assert.equal(again.textContent, "Send again");
    assert.equal(h.input.value, draft, "the composer draft is untouched");

    h.api.loadCardChip(SID); await tick();
    assert.equal(review(h).length, 1, "a reload does not drop unsent words");
    h.transcript.children.splice(0); h.api.reset();   // a transcript redraw clears the DOM and the state
    h.api.loadCardChip(SID); await tick();
    box = review(h);
    assert.equal(box.length, 1, "nor does a transcript redraw");
    assert.equal(byClass(box[0], "review-input")[0].value, "Use the blue one.");

    msgOk = true;
    byClass(box[0], "review-resend")[0].onclick(); await tick();
    assert.deepEqual(posts(h).map((p) => p[0]), [CHANGE, MSG, MSG], "Send again resends only the message");
    assert.deepEqual(posts(h)[2][1], { message: "Use the blue one." });
    assert.equal(review(h).length, 0, "delivered: the chips go");
    assert.equal(h.input.value, draft);
    assert.deepEqual(h.state.sent, []);
  });
}

test("R-P5-8: an unsent change survives a real reload (sessionStorage) and a resend clears it", async () => {
  const KEY = "perch-unsent-change:" + SID;
  const storage = memStore();
  const failing = (u) => (u === MSG ? json({ error: "pi_gone" }, 409) : json({ ok: true }));
  const h = mount({ card: CARD, result: RESULT, review: failing, storage });
  h.api.loadCardChip(SID); await tick();
  h.state.result = null;
  await askChange(h, "Use the blue one.");
  assert.deepEqual(JSON.parse(storage.getItem(KEY)), { text: "Use the blue one.", cardId: 9, resultId: 31 });

  // A reload: a fresh script run on the same sessionStorage; the server no longer offers the result.
  let ok = false;
  const r = mount({ card: CARD, result: null, storage, review: (u) => (u === MSG ? (ok ? json({ ok: true }) : json({}, 500)) : json({ ok: true })) });
  r.api.loadCardChip(SID); await tick();
  const box = review(r);
  assert.equal(box.length, 1, "the Send again card is drawn though the review is closed server-side");
  assert.equal(byClass(box[0], "review-input")[0].value, "Use the blue one.");
  assert.equal(byClass(box[0], "review-resend")[0].textContent, "Send again");
  byClass(box[0], "review-resend")[0].onclick(); await tick();
  assert.ok(storage.getItem(KEY), "a failed resend keeps the key");
  ok = true;
  byClass(review(r)[0], "review-resend")[0].onclick(); await tick();
  assert.deepEqual(posts(r).map((p) => p[0]), [MSG, MSG], "only the message, never the rejection");
  assert.equal(storage.getItem(KEY), null, "a 2xx clears the key");
  assert.equal(review(r).length, 0);

  const again = mount({ card: CARD, result: null, storage });
  again.api.loadCardChip(SID); await tick();
  assert.equal(review(again).length, 0, "nothing comes back after delivery");
});

test("a throwing or missing sessionStorage never breaks the change flow", async () => {
  const bad = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  const h = mount({ card: CARD, result: RESULT, storage: bad, review: (u) => (u === MSG ? json({}, 500) : json({ ok: true })) });
  h.api.loadCardChip(SID); await tick();
  h.state.result = null;
  await askChange(h, "x");
  assert.equal(byClass(review(h)[0], "review-input")[0].value, "x", "kept in memory");
  const none = mount({ card: CARD, result: null, storage: undefined });
  none.sandbox.window = {};
  none.api.loadCardChip(SID); await tick();
  assert.equal(review(none).length, 0);
});

test("a lost connection on the send also keeps the words", async () => {
  const h = mount({ card: CARD, result: RESULT, review: (u) => (u === MSG ? Promise.reject(new Error("socket")) : json({ ok: true })) });
  h.api.loadCardChip(SID); await tick();
  h.state.result = null;
  await askChange(h, "x");
  assert.equal(byClass(review(h)[0], "review-input")[0].value, "x");
  assert.equal(byClass(review(h)[0], "review-resend").length, 1);
});

test("a refused change sends nothing to the bot", async () => {
  const h = mount({ card: CARD, result: RESULT, review: () => json({ error: "stale" }, 409) });
  h.api.loadCardChip(SID); await tick();
  await askChange(h, "x");
  assert.deepEqual(posts(h).map((p) => p[0]), [CHANGE]);
  assert.deepEqual(h.state.sent, []);
});

test("R-P5-7: Accept on a card with an open question says to answer it first", async () => {
  const h = mount({ card: CARD, result: RESULT, review: () => json({ error: "answer_first", reason: "answer_first" }, 409) });
  h.api.loadCardChip(SID); await tick();
  const box = review(h)[0];
  byClass(box, "review-accept")[0].onclick(); await tick();
  assert.equal(posts(h).length, 1);
  assert.ok(allText(review(h)[0]).includes("Answer its question first."));
  assert.equal(review(h)[0], box, "not silently redrawn");
  assert.equal(byClass(box, "review-accept")[0].disabled, false);
});

test("answering a decision goes through #535's route", async () => {
  const h = mount({ card: CARD, decisions: [DECISION] });
  h.api.loadCardChip(SID); await tick();
  h.state.decisions = [];
  const opt = byClass(h.transcript, "review-opt")[0];
  opt.onclick(); opt.onclick(); await tick();
  assert.deepEqual(posts(h), [["/dashboard/bot-board-api/card/41/decision", { index: 0 }]]);
  assert.equal(h.fetches.find((f) => f.method === "POST").url.startsWith("/dashboard/bot-board-api/"), true);
  assert.equal(review(h).length, 0, "answered: the server says so and the chip goes");
});

test("Other… opens a field for other_text", async () => {
  const h = mount({ card: CARD, decisions: [DECISION] });
  h.api.loadCardChip(SID); await tick();
  const box = review(h)[0];
  const fields = byClass(box, "review-field");
  assert.equal(fields.length, 1);
  assert.equal(byClass(fields[0], "review-input")[0].maxLength, 2000, "decideOption's cap");
  byClass(box, "review-other")[0].onclick();
  assert.equal(fields[0].hidden, false);
  byClass(fields[0], "review-input")[0].value = "Neither, go up.";
  byClass(fields[0], "review-send")[0].onclick(); await tick();
  assert.deepEqual(posts(h), [["/dashboard/bot-board-api/card/41/decision", { index: -1, other_text: "Neither, go up." }]]);
  assert.deepEqual(h.state.sent, [], "an answer is not a chat message");
});

test("Not now writes nothing", async () => {
  const h = mount({ card: CARD, result: RESULT, decisions: [DECISION] });
  h.api.loadCardChip(SID); await tick();
  const before_ = h.fetches.length;
  byClass(h.transcript, "review-notnow")[0].onclick(); await tick();
  assert.equal(h.fetches.length, before_, "no request at all");
  assert.equal(review(h).length, 0);
  h.api.loadCardChip(SID); await tick();
  assert.equal(review(h).length, 0, "collapsed for this page view");
  h.api.reset(); h.api.loadCardChip(SID); await tick();
  assert.equal(review(h).length, 0, "a transcript redraw keeps it collapsed");
  h.state.result = { ...RESULT, id: 32 };
  h.api.loadCardChip(SID); await tick();
  assert.equal(review(h).length, 1, "something new is open: the chips come back");
});

test("a reload keeps what was typed and keeps the chips last", async () => {
  const h = mount({ card: CARD, result: RESULT });
  h.api.loadCardChip(SID); await tick();
  const box = review(h)[0];
  byClass(box, "review-change")[0].onclick();
  byClass(box, "review-input")[0].value = "half typed";
  h.transcript.appendChild(makeEl("div"));   // a newer bot reply
  h.api.loadCardChip(SID); await tick();
  assert.equal(review(h)[0], box, "same node");
  assert.equal(h.transcript.children[h.transcript.children.length - 1], box);
  assert.equal(byClass(box, "review-input")[0].value, "half typed");
});

test("P5 final: the words are in storage before request-change answers, and a refused one gives them back", async () => {
  const KEY = "perch-unsent-change:" + SID;
  const storage = memStore();
  let release, seen;
  const gate = new Promise((r) => { release = r; });
  const h = mount({ card: CARD, result: RESULT, storage, review: (u) => { if (u === CHANGE) { seen = storage.getItem(KEY); return gate.then(() => json({ error: "stale" }, 409)); } return json({ ok: true }); } });
  h.api.loadCardChip(SID); await tick();
  const box = review(h)[0];
  byClass(box, "review-change")[0].onclick();
  byClass(box, "review-input")[0].value = "Use the blue one.";
  byClass(box, "review-send")[0].onclick(); await tick();
  assert.deepEqual(JSON.parse(storage.getItem(KEY)), { text: "Use the blue one.", cardId: 9, resultId: 31 }, "saved while in flight");
  release(); await tick();
  assert.ok(seen, "already stored when the request went out");
  assert.equal(storage.getItem(KEY), null, "a refused request owes the bot nothing");
  const again = review(h);
  assert.equal(again.length, 1);
  assert.equal(byClass(again[0], "review-input")[0].value, "Use the blue one.", "the typed text is back in the field");
  assert.equal(byClass(again[0], "review-field")[0].hidden, false);
  assert.ok(allText(again[0]).includes("That did not work. Try again."));
  assert.deepEqual(posts(h).map((p) => p[0]), [CHANGE]);
});

test("P5 final: Not now sits inside the last card's actions row at 44 px", async () => {
  for (const [opts, row] of [[{ card: CARD, result: RESULT }, "art-actions"], [{ card: CARD, decisions: [DECISION] }, "review-options"], [{ card: CARD, result: RESULT, decisions: [DECISION] }, "review-options"]]) {
    const h = mount(opts);
    h.api.loadCardChip(SID); await tick();
    const nn = byClass(h.transcript, "review-notnow")[0];
    assert.ok(nn.parentNode && String(nn.parentNode.className).split(/\s+/).includes(row), "inside " + row);
    assert.ok(hasAncestorClass(nn, "artcard"), "inside a card");
  }
  const css = readFileSync(new URL("../servers/gateway/dashboard/perch-hub/css.js", import.meta.url), "utf8");
  assert.ok(/\.perch-review button\{min-height:44px/.test(css));
  assert.ok(css.includes('.cardchip-lane:before{content:"\\\\00b7\\\\0020"}'), "the separator keeps its space");
});

test("P5 final: a chip whose card has no project leaves the query out", async () => {
  const h = mount({ card: { id: 9, title: "T", lane: "working", projectId: null } });
  h.api.loadCardChip(SID); await tick();
  assert.equal(byClass(h.transcript, "cardchip-link")[0].href, "/dashboard/board#card-9");
});

test("P5 final: Details opens the drawer on the card's bot (detailsHref's rule)", async () => {
  const h = mount({ card: { id: 9, title: "T", lane: "working", projectId: 2, botId: "my bot" } });
  h.api.loadCardChip(SID); await tick();
  assert.equal(byClass(h.transcript, "cardchip-details")[0].href, "/dashboard/bot-board?bot=my%20bot#open=9");
});

test("P5 final: a refresh mid-flight draws no Send again card, and the bot gets exactly one message", async () => {
  const KEY = "perch-unsent-change:" + SID;
  const storage = memStore();
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = mount({ card: CARD, result: RESULT, storage, review: (u) => (u === CHANGE ? gate.then(() => json({ ok: true })) : json({ ok: true })) });
  h.api.loadCardChip(SID); await tick();
  const box = review(h)[0];
  byClass(box, "review-change")[0].onclick();
  byClass(box, "review-input")[0].value = "Use the blue one.";
  byClass(box, "review-send")[0].onclick(); await tick();
  assert.ok(storage.getItem(KEY), "pending while in flight");
  h.api.cardTurnState("working"); h.api.cardTurnState("idle"); await tick();
  h.api.loadCardChip(SID); await tick();
  assert.equal(byClass(h.transcript, "review-resend").length, 0, "no Send again card mid-flight");
  h.state.result = null;
  release(); await tick();
  assert.deepEqual(posts(h).map((p) => p[0]), [CHANGE, MSG], "exactly one message");
  assert.equal(storage.getItem(KEY), null);
});

test("P5 final: a 409 gives the text back with no Send again card and clears storage", async () => {
  const KEY = "perch-unsent-change:" + SID;
  const storage = memStore();
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = mount({ card: CARD, result: RESULT, storage, review: (u) => (u === CHANGE ? gate.then(() => json({ error: "stale" }, 409)) : json({ ok: true })) });
  h.api.loadCardChip(SID); await tick();
  const box = review(h)[0];
  byClass(box, "review-change")[0].onclick();
  byClass(box, "review-input")[0].value = "Use the blue one.";
  byClass(box, "review-send")[0].onclick(); await tick();
  h.api.loadCardChip(SID); await tick();
  release(); await tick();
  assert.equal(storage.getItem(KEY), null);
  assert.equal(byClass(h.transcript, "review-resend").length, 0);
  const again = review(h);
  assert.equal(again.length, 1);
  assert.equal(byClass(again[0], "review-input")[0].value, "Use the blue one.");
  assert.ok(allText(again[0]).includes("That did not work. Try again."));
  assert.deepEqual(posts(h).map((p) => p[0]), [CHANGE]);
});

test("P5 final: a reload after request-change succeeded and /message failed still shows Send again", async () => {
  const storage = memStore();
  const h = mount({ card: CARD, result: RESULT, storage, review: (u) => (u === MSG ? json({}, 500) : json({ ok: true })) });
  h.api.loadCardChip(SID); await tick();
  h.state.result = null;
  await askChange(h, "Use the blue one.");
  const r = mount({ card: CARD, result: null, storage });
  r.api.loadCardChip(SID); await tick();
  assert.equal(byClass(r.transcript, "review-resend").length, 1);
  assert.equal(byClass(r.transcript, "review-input")[0].value, "Use the blue one.");
});
