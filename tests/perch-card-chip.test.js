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
function mount({ offers = [], card = null, decide = () => json({ ok: true }) } = {}) {
  const transcript = makeEl("div");
  const state = { offers, card };
  const fetches = [];
  const sandbox = {
    console,
    document: { createElement: (tag) => makeEl(tag) },
    API: "/dashboard/perch-api",
    el: (id) => (id === "perch-transcript" ? transcript : null),
    csrf: () => "tok", live: () => true, current: { sid: SID },
    fetch(url, opts) {
      const method = (opts && opts.method) || "GET";
      const u = String(url);
      fetches.push({ method, url: u, body: opts && opts.body ? JSON.parse(opts.body) : undefined });
      if (method === "GET" && u.endsWith("/offers")) return Promise.resolve(json({ offers: state.offers }));
      if (method === "GET" && u.endsWith("/card")) return Promise.resolve(json({ card: state.card }));
      if (method === "POST" && /\/offers\/\d+\/decide$/.test(u)) return Promise.resolve(decide(u, fetches[fetches.length - 1].body));
      return Promise.resolve(json({}));
    },
    __export(api) { sandbox.api = api; },
  };
  sandbox.line = (cls, text) => { const d = makeEl("div"); if (cls) d.className = cls; d.textContent = text == null ? "" : String(text); return d; };
  vm.createContext(sandbox);
  vm.runInContext(`(function(){\n${perchCardChipJs("en")}\n;__export({ loadCardOffers: loadCardOffers, loadCardChip: loadCardChip, cardTurnState: cardTurnState, reset: resetCardChip });\n})();`, sandbox);
  return { sandbox, transcript, fetches, state, api: sandbox.api };
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
  assert.equal(det.href, "/dashboard/bot-board#open=9");
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
  for (const k of ["shell.offerTitle", "shell.offerMake", "shell.offerNotNow", "shell.cardMadeNote", "shell.cardDetails", "shell.offerFailed"]) {
    assert.ok(translations[k].en && translations[k].es, k);
  }
  assert.equal(translations["shell.cardMadeNote"].en, "Card #{n} made on {project}.");
});
