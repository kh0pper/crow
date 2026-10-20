/**
 * Decision cards in the Bot Board card drawer.
 *
 * Static part: the drawer markup carries the empty #bb-d-decision mount above
 * the plan section, the stylesheet carries the block's classes, the emitted
 * client script parses with no raw backtick, calls renderDecision off the
 * card GET, labels the decision history verbs, and every new string reaches
 * the browser through tJs (en text in the en emission, es text in the es
 * emission, no English leaking into es).
 *
 * Behaviour part: decision-client.js's emitted block is run against a small
 * DOM stub (innerHTML is a trap: setting it throws) and driven — open card,
 * option click, Other…, a 409 from a second tab, expired and decided cards.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clientJs } from "../servers/gateway/dashboard/panels/bot-board/client.js";
import { decisionJs } from "../servers/gateway/dashboard/panels/bot-board/decision-client.js";
import { botBoardStyles } from "../servers/gateway/dashboard/panels/bot-board/css.js";
import { translations, tJs } from "../servers/gateway/dashboard/shared/i18n.js";

// html.js computes a tasks.db path at import time; point it at a scratch dir
// before the dynamic import (same convention as board-i18n-literals.test.js).
const dir = mkdtempSync(join(tmpdir(), "board-decision-ui-"));
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.CROW_DB_PATH = join(dir, "crow.db");
let drawerMarkup;
before(async () => {
  ({ drawerMarkup } = await import("../servers/gateway/dashboard/panels/bot-board/html.js"));
});

const KEYS = [
  "botboard.decision.heading", "botboard.decision.recommended", "botboard.decision.other",
  "botboard.decision.send", "botboard.decision.chosen", "botboard.decision.followUp",
  "botboard.decision.expired",
  "board.mutationVerb.decision_ask", "board.mutationVerb.decision", "board.mutationVerb.decision_expire",
];

function scriptBody(lang) {
  const m = clientJs("bot-1", "kanban", 9, null, null, lang, false).match(/^<script>([\s\S]*)<\/script>$/);
  assert.ok(m, "clientJs emits one inline <script>");
  return m[1];
}

test("every new key exists in en and es, and the two differ", () => {
  for (const k of KEYS) {
    const v = translations[k];
    assert.ok(v && v.en && v.es, k + " needs en and es");
    assert.notEqual(v.en, v.es, k + " es must be a real translation");
  }
});

test("the drawer has an empty #bb-d-decision mount above the plan section", () => {
  for (const lang of ["en", "es"]) {
    const html = drawerMarkup(lang);
    const at = html.indexOf('<div id="bb-d-decision"></div>');
    assert.ok(at > 0, "empty decision mount present");
    assert.ok(at < html.indexOf('id="bb-d-plan-toggle"'), "above the plan heading");
    assert.ok(at > html.indexOf('id="bb-d-save"'), "below the card fields");
  }
});

test("the stylesheet carries the decision block classes", () => {
  const css = botBoardStyles();
  for (const c of [".bb-decision{", ".bb-decision-opt", ".bb-decision-rec"]) assert.ok(css.includes(c), c);
});

test("the emitted client script parses, has no raw backtick, and hydrates the decision off the card GET", () => {
  for (const lang of ["en", "es"]) {
    const src = scriptBody(lang);
    assert.ok(!src.includes("`"), "no raw backtick in the emitted client (" + lang + ")");
    assert.doesNotThrow(() => new Function(src), "client parses (" + lang + ")");
    assert.ok(src.includes("function renderDecision("), "renderDecision is spliced in");
    assert.match(src, /renderResults\([^;]*\);\s*renderDecision\(r\.j\.decision\);/, "called right after renderResults");
    assert.ok(src.includes("'/card/'+cardId+'/decision'"), "posts to the decision route");
    assert.ok(!src.includes("innerHTML"), "the decision block never uses innerHTML");
  }
});

test("history labels the decision verbs, and every new string reaches the client through tJs", () => {
  const en = scriptBody("en"), es = scriptBody("es");
  assert.ok(en.includes("decision_ask:'" + tJs("board.mutationVerb.decision_ask", "en") + "'"));
  assert.ok(en.includes("decision:'" + tJs("board.mutationVerb.decision", "en") + "'"));
  assert.ok(en.includes("decision_expire:'" + tJs("board.mutationVerb.decision_expire", "en") + "'"));
  for (const k of KEYS) {
    const ve = "'" + tJs(k, "en") + "'", vs = "'" + tJs(k, "es") + "'";
    assert.ok(en.includes(ve), k + " en in en");
    assert.ok(es.includes(vs), k + " es in es");
    assert.ok(!es.includes(ve), k + " leaks English into es");
  }
});

// ---- a tiny DOM -----------------------------------------------------------
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.className = ""; this.style = {}; this.attrs = {}; this.disabled = false; this.hidden = false;
    this.value = ""; this.type = ""; this.href = ""; this.onclick = null; this._text = "";
  }
  set innerHTML(_) { throw new Error("innerHTML is not allowed in the decision block"); }
  get innerHTML() { return ""; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  byClass(c) { return this.all().filter((e) => e.className.split(" ").includes(c)); }
  byTag(t) { return this.all().filter((e) => e.tagName === t.toUpperCase()); }
  click() { if (this.onclick && !this.disabled) this.onclick({ preventDefault() {} }); }
}

const flush = () => new Promise((r) => setImmediate(r));

function harness(lang = "en", { responses = [] } = {}) {
  const mount = new El("div");
  const calls = [];
  const queue = responses.slice();
  const document = { createElement: (t) => new El(t) };
  const location = { pathname: "/dashboard/bot-board", search: "", hash: "", reloaded: 0, reload() { this.reloaded++; } };
  const ctx = {
    $: (id) => (id === "bb-d-decision" ? mount : null),
    clearEl: (e) => { while (e && e.firstChild) e.removeChild(e.firstChild); },
    api: (method, path, body) => { calls.push({ method, path, body }); return Promise.resolve(queue.shift() || { ok: false, status: 500, j: {} }); },
    msg: (el, txt, cls) => { if (el) { el.className = "bb-msg " + (cls || ""); el.textContent = txt || ""; } },
    errText: (r, fb) => (r && r.j && r.j.reason) || fb,
    cur: { id: 42 },
  };
  const make = new Function("document", "location", "$", "clearEl", "api", "msg", "errText", "cur",
    decisionJs(lang) + "\nreturn renderDecision;");
  const renderDecision = make(document, location, ctx.$, ctx.clearEl, ctx.api, ctx.msg, ctx.errText, ctx.cur);
  return { mount, calls, renderDecision, location, ctx };
}

const OPEN = () => ({
  question: "Free space on the data disk?",
  context_md: "Disk is 91% full.\n<img src=x onerror=alert(1)>",
  fingerprint: "disk-1", batch: "b1", expires: "2999-01-01",
  options: [
    { label: "Prune old images", consequence: "Frees about 40 GB.", recommended: true, value: "prune" },
    { label: "Not now", consequence: "Asked again in 7 days.", recommended: false, snooze_days: 7 },
  ],
});

test("an open decision renders question, plain-text context, options in order with the recommended badge first, consequences, and Other…", () => {
  const { mount, renderDecision } = harness();
  renderDecision(OPEN());
  const box = mount.byClass("bb-decision")[0];
  assert.ok(box, "a .bb-decision box");
  assert.ok(box.textContent.includes(translations["botboard.decision.heading"].en));
  assert.ok(box.textContent.includes("Free space on the data disk?"));
  assert.ok(box.textContent.includes("<img src=x onerror=alert(1)>"), "context is literal text");
  const opts = mount.byClass("bb-decision-opt");
  assert.equal(opts.length, 2);
  assert.ok(opts[0].textContent.startsWith("Prune old images"));
  assert.ok(opts[1].textContent.startsWith("Not now"));
  const rec = mount.byClass("bb-decision-rec");
  assert.equal(rec.length, 1, "one badge");
  assert.equal(rec[0].parentNode, opts[0], "on the first option");
  assert.equal(rec[0].textContent, translations["botboard.decision.recommended"].en);
  const cons = mount.byClass("bb-decision-cons").map((e) => e.textContent);
  assert.deepEqual(cons, ["Frees about 40 GB.", "Asked again in 7 days."]);
  const other = mount.byClass("bb-decision-other")[0];
  assert.equal(other.textContent, translations["botboard.decision.other"].en);
  const ta = mount.byTag("textarea")[0];
  assert.ok(ta && ta.parentNode.hidden, "Other textarea starts hidden");
});

test("picking an option posts its index, then shows the chosen label, a follow-up link, and no live buttons", async () => {
  const { mount, calls, renderDecision, location } = harness("en", {
    responses: [{ ok: true, status: 200, j: { ok: true, chosen: { index: 0, label: "Prune old images", value: "prune", other_text: null, decided_at: "2026-01-01T00:00:00Z" }, created_card_id: 77 } }],
  });
  renderDecision(OPEN());
  mount.byClass("bb-decision-opt")[0].click();
  assert.ok(mount.byTag("button").every((b) => b.disabled), "buttons disabled while sending");
  await flush(); await flush();
  assert.deepEqual(calls, [{ method: "POST", path: "/card/42/decision", body: { index: 0 } }]);
  const box = mount.byClass("bb-decision")[0];
  assert.ok(box.textContent.includes(translations["botboard.decision.chosen"].en));
  assert.ok(box.textContent.includes("Prune old images"));
  assert.ok(mount.byTag("button").every((b) => b.disabled), "no live option buttons after the choice");
  const link = mount.byTag("a")[0];
  assert.ok(link, "follow-up link");
  assert.equal(link.href, "/dashboard/bot-board#card=77");
  assert.ok(link.textContent.includes(translations["botboard.decision.followUp"].en));
  link.click();
  assert.equal(location.hash, "card=77");
  assert.equal(location.reloaded, 1, "reloads so the new card is on the board");
});

test("Other… reveals the textarea; Send posts index -1 with the text; empty text sends nothing", async () => {
  const { mount, calls, renderDecision } = harness("es", {
    responses: [{ ok: true, status: 200, j: { ok: true, chosen: { index: -1, label: "Other", value: null, other_text: "Wait for the new disk", decided_at: "x" }, created_card_id: null } }],
  });
  renderDecision(OPEN());
  mount.byClass("bb-decision-other")[0].click();
  const ta = mount.byTag("textarea")[0];
  assert.equal(ta.parentNode.hidden, false, "revealed");
  const send = mount.byClass("bb-decision-send")[0];
  assert.equal(send.textContent, translations["botboard.decision.send"].es);
  ta.value = "   ";
  send.click();
  assert.equal(calls.length, 0, "blank Other is not sent");
  ta.value = "Wait for the new disk";
  send.click();
  await flush(); await flush();
  assert.deepEqual(calls[0], { method: "POST", path: "/card/42/decision", body: { index: -1, other_text: "Wait for the new disk" } });
  const box = mount.byClass("bb-decision")[0];
  assert.ok(box.textContent.includes(translations["botboard.decision.other"].es), "Other shown in the viewer's language");
  assert.ok(box.textContent.includes("Wait for the new disk"));
  assert.equal(mount.byTag("a").length, 0, "no follow-up link without a created card");
});

test("a 409 (answered in another tab) re-reads the card and shows the server's choice read-only", async () => {
  const decided = { ...OPEN(), chosen: { index: 1, label: "Not now", value: null, other_text: null, decided_at: "x" } };
  const { mount, calls, renderDecision } = harness("en", {
    responses: [
      { ok: false, status: 409, j: { code: "already_decided", reason: "decision already made" } },
      { ok: true, status: 200, j: { card: { id: 42 }, decision: decided } },
    ],
  });
  renderDecision(OPEN());
  mount.byClass("bb-decision-opt")[0].click();
  for (let i = 0; i < 5; i++) await flush();
  assert.deepEqual(calls.map((c) => c.method + " " + c.path), ["POST /card/42/decision", "GET /card/42"]);
  const box = mount.byClass("bb-decision")[0];
  assert.ok(box.textContent.includes("Not now"));
  assert.ok(box.textContent.includes("decision already made"), "the reason is shown");
  assert.equal(mount.byClass("bb-decision-opt").filter((b) => !b.disabled).length, 0);
});

test("a stale response for a card the drawer no longer shows is dropped", async () => {
  const { mount, renderDecision, ctx } = harness("en", {
    responses: [{ ok: true, status: 200, j: { ok: true, chosen: { index: 0, label: "Prune old images" }, created_card_id: 9 } }],
  });
  renderDecision(OPEN());
  mount.byClass("bb-decision-opt")[0].click();
  ctx.cur.id = 43; // the operator opened another card meanwhile
  await flush(); await flush();
  assert.equal(mount.byTag("a").length, 0, "nothing written into the other card's drawer");
});

test("expired decisions (stamped, or past their date) are read-only", () => {
  for (const d of [{ ...OPEN(), expired_at: "2026-01-02T00:00:00Z" }, { ...OPEN(), expires: "2000-01-01" }]) {
    const { mount, renderDecision } = harness();
    renderDecision(d);
    const box = mount.byClass("bb-decision")[0];
    assert.ok(box.textContent.includes(translations["botboard.decision.expired"].en));
    assert.equal(mount.byTag("button").length, 0, "no buttons");
    assert.equal(mount.byTag("textarea").length, 0);
  }
});

test("no decision (or a malformed one) leaves the mount empty, clearing the previous card's block", () => {
  const { mount, renderDecision } = harness();
  renderDecision(OPEN());
  assert.ok(mount.children.length > 0);
  renderDecision(null);
  assert.equal(mount.children.length, 0);
  renderDecision({ question: "q", options: "nope" });
  assert.equal(mount.children.length, 0);
});
