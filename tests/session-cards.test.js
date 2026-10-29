// The shared session cards and start control (shared/session-cards.js):
// the card model (title fallback, live dot, Waiting chip, link), the browser
// builder producing the server's markup, and both pages using the one
// component (the project home and the Chat tab in new mode).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const mod = await import("../servers/gateway/dashboard/shared/session-cards.js");
const { sessionCardModel, sessionCardHtml, sessionCardsJs, startControlHtml, startControlJs, sessionUiCss } = mod;

const SID = "perchlive-4281879e";

test("title: the label, else the first message, else none (Untitled)", () => {
  assert.equal(sessionCardModel({ sessionId: SID, label: "Plan beds", firstMessage: "hello" }).title, "Plan beds");
  assert.equal(sessionCardModel({ sessionId: SID, label: "   ", firstMessage: "What should I plant?" }).title, "What should I plant?");
  assert.equal(sessionCardModel({ sessionId: SID, label: null, firstMessage: "line one\nline two" }).title, "line one line two", "one line");
  const long = sessionCardModel({ sessionId: SID, firstMessage: "x".repeat(200) }).title;
  assert.equal(long.length, 80, "capped at 80 characters");
  assert.ok(long.endsWith("…"));
  assert.equal(sessionCardModel({ sessionId: SID, label: "", firstMessage: "  " }).title, null);
  assert.equal(sessionCardModel({ sessionId: SID }).title, null);
  assert.match(sessionCardHtml(sessionCardModel({ sessionId: SID }), "en"), /<span class="ph-row-title">Untitled session</);
  assert.match(sessionCardHtml(sessionCardModel({ sessionId: SID }), "es"), /<span class="ph-row-title">Sesión sin título</);
});

test("the live dot: a running session only; waiting shows the chip instead", () => {
  for (const state of ["awake", "waking"]) assert.equal(sessionCardModel({ sessionId: SID, state }).live, true, state);
  for (const state of ["hibernating", "stopped", "idle", undefined]) assert.equal(sessionCardModel({ sessionId: SID, state }).live, false, String(state));
  const w = sessionCardModel({ sessionId: SID, state: "awake", pendingUi: true });
  assert.equal(w.waiting, true);
  assert.equal(w.live, false, "waiting on you: the chip, not the dot");
  const html = sessionCardHtml(w, "en");
  assert.match(html, /<span class="ph-kind ph-kind--waiting">Waiting<\/span>/);
  assert.doesNotMatch(html, /ph-live/);
  const live = sessionCardHtml(sessionCardModel({ sessionId: SID, state: "awake", label: "L" }), "es");
  assert.match(live, /<span class="ph-live"><span class="ph-vh">En curso<\/span><\/span><span class="ph-row-title">L</);
});

test("the link: through the project when the card names one, else in place", () => {
  assert.equal(sessionCardModel({ sessionId: SID }, { projectSlug: "garden" }).href, "/dashboard/perch?project=garden#" + SID);
  assert.equal(sessionCardModel({ sessionId: SID }).href, "#" + SID);
  assert.match(sessionCardHtml(sessionCardModel({ sessionId: SID }, { projectSlug: "garden" }), "en"), /data-turbo-prefetch="false"/);
});

test("the meta line: bot · project · day; never an id or a state", () => {
  const m = sessionCardModel({ sessionId: SID, botName: "Hank", state: "hibernating", lastAt: new Date().toISOString() }, { projectName: "Sunvox" });
  const html = sessionCardHtml(m, "en");
  assert.match(html, /<span class="ph-meta">Hank · Sunvox · Today<\/span>/);
  const text = html.replace(/href="[^"]*"/g, "").replace(/<[^>]+>/g, " ");
  assert.ok(!text.includes("4281879e") && !/hibernating/.test(text), text);
});

test("the model's source runs in the browser: ES5, no backslash, backtick or dollar-brace", () => {
  const src = sessionCardModel.toString();
  assert.ok(!src.includes("\\"), "no backslash (the client is a template literal)");
  assert.ok(!src.includes("`") && !src.includes("${"), "no backtick or dollar-brace");
  assert.doesNotMatch(src, /=>|\b(let|const)\b/, "ES5");
  assert.ok(sessionCardsJs("en").includes(src), "the client carries this very function");
});

/** A tiny DOM, enough for scCardEl, serialised the way the server writes. */
function miniDom() {
  const make = (tag) => ({
    tagName: tag, className: "", attrs: {}, children: [], _text: "",
    set textContent(v) { this._text = String(v); this.children = []; },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); },
    set href(v) { this.attrs.href = v; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { this.children.push(c); return c; },
    get firstChild() { return this.children[0]; },
  });
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = (n) => {
    const order = ["class", "href", ...Object.keys(n.attrs).filter((k) => k !== "href")];
    const attrs = order.map((k) => k === "class" ? (n.className ? ` class="${esc(n.className)}"` : "") : n.attrs[k] === undefined ? "" : ` ${k}="${esc(n.attrs[k])}"`).join("");
    return `<${n.tagName}${attrs}>${esc(n._text)}${n.children.map(html).join("")}</${n.tagName}>`;
  };
  return { document: { createElement: make }, html };
}

test("the browser's card is the server's card", () => {
  const { document, html } = miniDom();
  const ctx = vm.createContext({ document });
  vm.runInContext(sessionCardsJs("en") + "\nthis.scCardEl=scCardEl; this.model=sessionCardModel;", ctx);
  const cases = [
    [{ sessionId: SID, label: "Plan <beds>", botName: "Grackle", state: "awake" }, { projectSlug: "garden", projectName: "Garden" }],
    [{ sessionId: SID, botName: "Hank", pendingUi: true }, {}],
    [{ sessionId: SID, label: "Quiet", botName: "Hank", state: "hibernating" }, { projectName: "Sunvox" }],
  ];
  const now = new Date("2026-10-29T12:00:00Z");
  for (const [row, opts] of cases) {
    const m = sessionCardModel({ ...row, lastAt: "2026-10-29 10:00:00" }, opts);
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.model({ ...row, lastAt: "2026-10-29 10:00:00" }, opts))), m, "one model on both sides");
    const server = sessionCardHtml(m, "en", { now }).replace(/^<li>/, "").replace(/<\/li>$/, "");
    const li = ctx.scCardEl(m, "Today");
    assert.equal(li.className, "ph-card");
    // The browser link also carries data-sid (focus restore after a poll).
    const a = li.firstChild;
    delete a.attrs["data-sid"];
    assert.equal(html(a), server.replace(/&#39;/g, "'"), JSON.stringify(row));
  }
});

test("the start control: lead, the pick only with more than one bot, the project it files under", () => {
  const ivy = { id: "ivy", name: "Ivy" }, hank = { id: "hank", name: "Hank" };
  const one = startControlHtml({ lead: ivy, bots: [ivy] }, "en", { projectId: "unassigned", inPlace: true });
  assert.match(one, /data-ph-start-root data-project-id="unassigned" data-ph-in-place>/);
  assert.match(one, /with <strong data-ph-lead-name>Ivy<\/strong><\/p>/);
  assert.doesNotMatch(one, /<select|data-ph-change/);
  const two = startControlHtml({ lead: hank, bots: [hank, ivy] }, "es", { projectId: 4, projectSlug: "x" });
  assert.match(two, /data-ph-start-root data-project-id="4" data-project-slug="x">/);
  assert.match(two, />Empezar una sesión</);
  assert.deepEqual([...two.matchAll(/<option value="(\w+)"( selected)?>/g)].map((m) => m[1] + (m[2] ? "*" : "")), ["hank*", "ivy"]);
  const all = startControlHtml({ lead: ivy, bots: [ivy] }, "en", {});
  assert.match(all, /data-ph-start-root>/, "Everything: no project");
  assert.match(startControlHtml({ lead: null, bots: [] }, "en", { emptyKey: "shell.noBots" }), /No bot is attached to Perch yet\./);
  const js = startControlJs("en");
  assert.match(js, /querySelector\('\[data-ph-start-root\]'\)/);
  assert.match(js, /hub\.startSession\(/, "in place: the Perch client starts it");
  assert.doesNotMatch(js, /location\.hash/, "and opens it: the control never sets the hash itself");
  assert.ok(!js.slice(js.indexOf("(function")).includes("`"), "no backtick in the script");
});

test("both pages use the one component", async () => {
  const { projectHomeHtml } = await import("../servers/gateway/dashboard/panels/project-home/html.js");
  const { projectHomeCss } = await import("../servers/gateway/dashboard/panels/project-home/css.js");
  const { projectHomeClientJs } = await import("../servers/gateway/dashboard/panels/project-home/client.js");
  const { perchHubContent } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const now = new Date("2026-10-29T12:00:00Z");
  const lead = { id: "ivy", name: "Ivy" };
  const session = { threadId: SID, label: "Plan", botName: "Ivy", lastAt: "2026-10-29 10:00:00" };
  const home = projectHomeHtml({ lead, bots: [lead], needsYou: [], needsYouCount: 0, sessions: [session], briefing: null },
    { id: 3, slug: "garden" }, "en", { now });
  // The project home: the shared card, start control, styles and script.
  assert.ok(home.includes(sessionCardHtml(sessionCardModel({ sessionId: SID, label: "Plan", botName: "Ivy", lastAt: session.lastAt }, { projectSlug: "garden" }), "en", { now })));
  assert.ok(home.includes(startControlHtml({ lead, bots: [lead] }, "en", { projectId: 3, projectSlug: "garden" })));
  assert.ok(projectHomeCss().includes(sessionUiCss("body.shell")));
  assert.equal(projectHomeClientJs("en"), startControlJs("en"));
  // The Chat tab in new mode: the same start control (in place, Everything),
  // the same styles under #perch-list, the same script, the same card builder.
  const chat = perchHubContent("en", { state: "ready" }, { scope: { all: true }, projects: [], start: { lead, bots: [lead] } });
  assert.ok(chat.includes(startControlHtml({ lead, bots: [lead] }, "en", { inPlace: true, emptyKey: "shell.noBots" })));
  assert.ok(chat.includes(sessionUiCss("body.shell #perch-list")));
  assert.ok(chat.includes(startControlJs("en")));
  assert.ok(perchHubJs("en").includes(sessionCardsJs("en")));
  assert.doesNotMatch(chat, /id="perch-new"|id="perch-launch-more"|id="perch-new-model"/, "no classic launcher in new mode");
  // Classic Perch is untouched: its launcher, none of the shared pieces.
  const classic = perchHubContent("en", { state: "ready" });
  assert.match(classic, /id="perch-new"/);
  assert.ok(!classic.includes("data-ph-start-root") && !classic.includes(sessionUiCss("body.shell #perch-list")));
});

test("the Chat panel: every attachable bot outside a project, the project's inside, ?bot= picks", async () => {
  const { default: panel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const PERCH = JSON.stringify({ gateways: [{ type: "perch" }] });
  const defs = [
    { bot_id: "zed", display_name: "Zed", definition: PERCH, project_id: 5 },
    { bot_id: "amy", display_name: "Amy", definition: PERCH, project_id: null },
    { bot_id: "obs", display_name: "Obs", definition: "{}", project_id: null },
  ];
  const seen = [];
  const db = { execute: async (q) => {
    const sql = typeof q === "string" ? q : q.sql;
    if (!/pi_bot_defs/.test(sql)) return { rows: [] };
    seen.push(q.args);
    return { rows: /project_id = \?/.test(sql) ? defs.filter((d) => d.project_id === Number(q.args[0])) : defs };
  } };
  const render = (scope, query = {}) => panel.handler({ crowMode: { mode: "new" }, crowScope: scope, query }, {}, { db, lang: "en", layout: (o) => o.content });
  const all = await render({ all: true });
  const startOf = (h) => h.slice(h.indexOf("data-ph-start-root"), h.indexOf("</section>", h.indexOf("data-ph-start-root")));
  const opts = (h) => [...startOf(h).matchAll(/<option value="(\w+)"( selected)?>/g)].map((m) => m[1] + (m[2] ? "*" : ""));
  assert.deepEqual(opts(all), ["amy*", "zed"], "attachable bots by name, the lead first; never an observing bot");
  assert.ok(seen.length && seen.every((a) => a.includes("crow.voice")), "the voice bot is excluded in every query");
  assert.deepEqual(opts(await render({ all: true }, { bot: "zed" })), ["zed*", "amy"], "?bot= picks its bot");
  const proj = await render({ projectId: 5, slug: "p" });
  assert.match(proj, /data-ph-start-root data-ph-in-place>/, "on Perch the Perch client files the start");
  assert.match(proj, /<strong data-ph-lead-name>Zed<\/strong>/);
  assert.match(await render({ unassigned: true }), /data-ph-start-root data-ph-in-place>/);
  const classic = await panel.handler({}, {}, { db, lang: "en", layout: (o) => o.content });
  assert.doesNotMatch(classic, /data-ph-start-root/);
});
