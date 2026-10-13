// The Artifacts chat card (spec v1.6 D25/D27; chat-first plan PR-1 Task 1.4).
// Static-shape + extracted pure-function tests follow perch-phone-card.test.js;
// the behaviour tests run the card snippet in a small vm sandbox with the hub's
// shared-scope helpers (el/line/clearEl/csrf/live/current) stubbed, so the
// refetch→render path, the dedupe and the actions are exercised without a
// browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { perchHubJs } from "../servers/gateway/dashboard/perch-hub/client.js";
import { perchArtifactCardJs } from "../servers/gateway/dashboard/perch-hub/artifact-card.js";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";

// ---------------------------------------------------------------------------
// static shape
// ---------------------------------------------------------------------------

test("the card snippet is spliced into the hub script and wired to the stream and history", () => {
  for (const lang of ["en", "es"]) {
    const js = perchHubJs(lang);
    assert.ok(js.includes(perchArtifactCardJs(lang)), "snippet spliced verbatim");
    assert.match(js, /on\('artifact',function\(d\)\{/);
    assert.match(js, /if\(!histSettled\)\{ artBuf\.push\(d\); return; \}/, "frames before the settle are buffered, never dropped");
    assert.match(js, /loadPhoneCards\(current\.sid\);[^\n]*\n\s*loadArtifactCards\(current\.sid\);/,
      "the cards load after the phone cards, once the transcript and unsent notes landed");
    assert.equal((js.match(/resetArtifactCards\(\);/g) || []).length, 3, "every transcript reset also resets the artifact cards");
    assert.doesNotThrow(() => new Function(js), lang + " parses");
  }
});

test("I6: createElement/textContent only — no HTML sinks, no backticks, no dollar-brace", () => {
  for (const lang of ["en", "es"]) {
    const js = perchArtifactCardJs(lang);
    assert.ok(!/\.innerHTML\s*\+?=|\.outerHTML\s*\+?=|insertAdjacentHTML\s*\(|document\.write\s*\(|setSanitizedHtml\(/.test(js), "no HTML sink");
    assert.equal(js.includes("`"), false, "no backtick");
    assert.equal(js.includes("${"), false, "no dollar-brace");
  }
});

test("I2: the card is the store row refetched by id; the frame is only a pointer", () => {
  const js = perchArtifactCardJs("en");
  assert.match(js, /artApi\('GET','\/'\+encodeURIComponent\(id\)\)/, "refetch by artifact id");
  assert.match(js, /typeof d\.artifactId!=='string'\|\|!d\.artifactId/, "a frame without a string id is ignored");
  assert.match(js, /fetch\('\/api\/artifacts'\+path/, "the owner routes only (dashboard auth + CSRF)");
  assert.match(js, /'X-Crow-Csrf':csrf\(\)/, "writes carry the CSRF header");
});

test("actions ride the EXISTING owner routes: Open beside chat / new window go to the viewer page, Run scripts is the D20 approve", () => {
  const js = perchArtifactCardJs("en");
  // Q2 (PR-2): both open the SAME-ORIGIN viewer page; nothing navigates the
  // hub itself, and the hub never frames the artifact origin.
  assert.doesNotMatch(js, /location\.href=/, "the hub page is never navigated away");
  assert.match(js, /'\/dashboard\/artifacts\/view\/'\+encodeURIComponent\(String\(id\)\)/);
  assert.match(js, /win\.target='_blank'; win\.rel='noopener'/, "new window: target=_blank rel=noopener");
  assert.doesNotMatch(js, /\/v\/|artifact-origin|artifactOrigin/, "no artifact-origin URL is ever built here");
  assert.match(js, /artApi\('POST','\/'\+encodeURIComponent\(a\.id\)\+'\/versions\/'\+encodeURIComponent\(String\(st\.curN\)\)\+'\/approve',\{\}\)/);
});

test("T1 static pin: every async continuation carries the artGen guard (review M8/M8b/M8c survived the count-of-current.sid pin)", () => {
  const js = perchArtifactCardJs("en");
  // refetch, by-thread list continuation, buffered-frame continuation, and
  // the Run-scripts action (L4). If this count moves, a guard moved with it.
  assert.equal((js.match(/gen!==artGen/g) || []).length, 4, "four artGen guards");
  assert.equal((js.match(/gen=artGen/g) || []).length, 3, "captured at call/render time in the three functions that await");
});

test("every card string is a translated key with en AND es", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../servers/gateway/dashboard/perch-hub/artifact-card.js", import.meta.url), "utf8");
  const keys = [...src.matchAll(/tJs\("([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 14, "the card declares its strings");
  for (const k of [...new Set(keys)]) {
    assert.ok(translations[k], k + " exists");
    assert.ok(translations[k].en && translations[k].es, k + " has both locales");
  }
  // The emitted snippet interpolates them (no raw tJs call survives) and both
  // locales really differ on a translatable chip.
  assert.ok(!perchArtifactCardJs("en").includes("tJs("));
  assert.ok(perchArtifactCardJs("en").includes("ready"));
  assert.ok(perchArtifactCardJs("es").includes("listo"));
});

// ---------------------------------------------------------------------------
// the vm harness: the snippet inside its shared-scope stubs
// ---------------------------------------------------------------------------

function makeEl(tag) {
  const node = {
    tagName: String(tag || "div").toUpperCase(), children: [], parentNode: null,
    className: "", textContent: "", hidden: false, disabled: false, type: "", scrollTop: 0,
    style: {}, onclick: null,
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    setAttribute(k, v) { this["attr:" + k] = v; },
    focus() { this.focused = true; },
    get firstChild() { return this.children[0] || null; },
  };
  // An innerHTML write anywhere in the card is an instant test failure.
  Object.defineProperty(node, "innerHTML", {
    set() { throw new Error("innerHTML sink reached"); },
    get() { return ""; },
  });
  return node;
}

function walk(node, fn) { fn(node); for (const c of node.children) walk(c, fn); }
function texts(node) { const out = []; walk(node, (n) => { if (n.children.length === 0 && n.textContent) out.push(n.textContent); }); return out; }
function byClass(node, cls) { const out = []; walk(node, (n) => { if (String(n.className || "").split(/\s+/).includes(cls)) out.push(n); }); return out; }

const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

function classList(set) {
  return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) };
}

function mountCard({ fetchImpl, sid = "perchlive-aaaaaaaa" } = {}) {
  const transcript = makeEl("div");
  const hubRoot = makeEl("div");
  const bodyClasses = new Set();
  const fetches = [];
  const sandbox = {
    console,
    document: {
      createElement: (tag) => makeEl(tag),
      addEventListener(type, fn) { (sandbox.__docListeners[type] ||= []).push(fn); },
      getElementById: (id) => (id === "perch-hub-root" ? hubRoot : null),
      body: { classList: classList(bodyClasses), appendChild: (c) => hubRoot.appendChild(c) },
    },
    window: { innerWidth: 1280 },
    __docListeners: {},
    el: (id) => (id === "perch-transcript" ? transcript : null),
    csrf: () => "tok",
    live: () => true,
    current: { sid },
    fetch(url, opts) {
      const method = (opts && opts.method) || "GET";
      fetches.push({ method, url: String(url), opts });
      return Promise.resolve(fetchImpl ? fetchImpl(method, String(url), opts) : { ok: true, status: 200, json: () => Promise.resolve({}) });
    },
    location: { href: "" },
    __export(api) { sandbox.__exportedApi = api; },
  };
  sandbox.line = (cls, text) => { const d = sandbox.document.createElement("div"); if (cls) d.className = cls; d.textContent = text == null ? "" : String(text); return d; };
  sandbox.clearEl = (n) => { while (n && n.firstChild) n.removeChild(n.firstChild); };
  vm.createContext(sandbox);
  const src = `(function(){\n${perchArtifactCardJs("en")}\n;__export({
    artifactCardState: artifactCardState,
    upsertArtifactCard: upsertArtifactCard,
    artifactRefetch: artifactRefetch,
    artifactFrame: artifactFrame,
    loadArtifactCards: loadArtifactCards,
    artViewerUrl: artViewerUrl,
    artPaneMode: artPaneMode,
    openArtifactPane: openArtifactPane,
    closeArtifactPane: closeArtifactPane,
    pane: function(){ return artPane; },
    resetArtifactCards: resetArtifactCards,
    cards: function(){ return artCards; },
    noBundle: function(){ return artNoBundle; },
    pushBufForTest: function(d){ artBuf.push(d); },
  });\n})();`;
  vm.runInContext(src, sandbox);
  return { sandbox, transcript, fetches, hubRoot, bodyClasses };
}

// row builder: the exact GET /api/artifacts/:id payload shape the route serves.
function row({ id = "art_x", title = "Coffee guide", type = "page", current = 1, versions = null, threads = [], activeRound = null, scripted = true, scriptsOff = false } = {}) {
  return {
    artifact: { id, title, type, current_version: current },
    versions: versions || [
      { n: current, state: "current", flagged_reason: null },
    ],
    threads, activeRound, scripted, scriptsOff,
  };
}
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

// ---------------------------------------------------------------------------
// artifactCardState — the pure derivation
// ---------------------------------------------------------------------------

test("artifactCardState: chip precedence flagged > revising > proposed > scripts-off > ready", async () => {
  const hub = mountCard();
  const api = hub.sandbox.__exportedApi;
  assert.ok(api, "api exported");
  const s1 = api.artifactCardState(row());
  assert.equal(s1.pill, "ok");
  assert.equal(s1.curN, 1);
  const s2 = api.artifactCardState(row({ scriptsOff: true }));
  assert.equal(s2.pill, "warn");
  assert.equal(s2.showRun, true);
  const s3 = api.artifactCardState(row({ versions: [{ n: 2, state: "proposed" }, { n: 1, state: "current", flagged_reason: null }], current: 1 }));
  assert.equal(s3.pill, "warn");
  assert.equal(s3.proposedN, 2);
  const s4 = api.artifactCardState(row({ activeRound: { id: 7, kind: "round", status: "working" } }));
  assert.equal(s4.pill, "wait");
  assert.equal(s4.roundId, 7);
  assert.match(s4.chip, /7/);
  const s5 = api.artifactCardState(row({ versions: [{ n: 1, state: "current", flagged_reason: "second-load" }], scriptsOff: true, activeRound: { id: 3, kind: "round", status: "working" } }));
  assert.equal(s5.pill, "err", "flagged wins over everything");
  assert.equal(s5.showRun, false, "a flagged version offers no Run scripts");
});

test("artifactCardState: comment counts, the contact name head, and key sensitivity", async () => {
  const api = mountCard().sandbox.__exportedApi;
  const threads = [
    { id: 1, status: "open", author_kind: "owner", author_id: null },
    { id: 2, status: "resolved", author_kind: "owner", author_id: null },
    { id: 3, status: "open", author_kind: "contact", author_id: "alex@example" },
    { id: 4, status: "open", author_kind: "contact", author_id: "bob Other" },
  ];
  const st = api.artifactCardState(row({ threads }));
  assert.equal(st.openComments, 3, "resolved threads do not count");
  assert.equal(st.contactOpen, 2);
  assert.equal(st.contactWho, "alex", "the first contact's name head only");
  const st2 = api.artifactCardState(row({ threads }));
  assert.equal(st2.key, st.key, "the same row derives the same key");
  const st3 = api.artifactCardState(row({ threads, title: "Other" }));
  assert.notEqual(st3.key, st.key, "a new title is a new key");
  const st4 = api.artifactCardState(row({ threads, current: 2, versions: [{ n: 2, state: "current" }, { n: 1, state: "past" }] }));
  assert.notEqual(st4.key, st.key, "a new version is a new key");
});

// ---------------------------------------------------------------------------
// behaviour: refetch → render, dedupe, actions, replay
// ---------------------------------------------------------------------------

test("a bot title with markup lands as TEXT; the card renders the row's facts", async () => {
  const evil = '<img src=x onerror="alert(1)">';
  const hub = mountCard({ fetchImpl: (m, url) => json(row({ title: evil, scriptsOff: true })) });
  hub.sandbox.__exportedApi.upsertArtifactCard(row({ title: evil, scriptsOff: true }), hub.sandbox.current.sid);
  const card = byClass(hub.transcript, "artcard");
  assert.equal(card.length, 1);
  const t = byClass(card[0], "art-title");
  assert.equal(t.length, 1);
  assert.equal(t[0].textContent, evil, "the raw string, as text");
  assert.equal(t[0].children.length, 0, "no element was built from it");
  assert.equal(byClass(card[0], "art-run").length, 1, "scripts-off offers the D20 approve");
  assert.equal(byClass(card[0], "art-open").length, 1);
  assert.ok(texts(card[0]).includes("v1"));
});

test("upsert dedupes on the derived key and re-renders when the row changes", async () => {
  const hub = mountCard();
  const api = hub.sandbox.__exportedApi;
  const sid = hub.sandbox.current.sid;
  api.upsertArtifactCard(row(), sid);
  const first = byClass(hub.transcript, "artcard")[0].children[0];
  api.upsertArtifactCard(row(), sid);
  assert.equal(byClass(hub.transcript, "artcard").length, 1, "one node per artifact");
  assert.equal(byClass(hub.transcript, "artcard")[0].children[0], first, "an unchanged row does not churn the DOM");
  api.upsertArtifactCard(row({ current: 2, versions: [{ n: 2, state: "current" }, { n: 1, state: "past" }] }), sid);
  assert.notEqual(byClass(hub.transcript, "artcard")[0].children[0], first, "a changed row re-renders");
  assert.ok(texts(byClass(hub.transcript, "artcard")[0]).includes("v2"));
});

test("artifactFrame → refetch → card; a 404 on a drawn card says gone; frames for other sessions are dropped", async () => {
  let status = 200;
  const hub = mountCard({ fetchImpl: (m, url) => (url.includes("/by-thread") ? json({ items: [] }) : (status === 404 ? json({ error: "not_found" }, 404) : json(row({ id: "art_live" })))) });
  const api = hub.sandbox.__exportedApi;
  const sid = hub.sandbox.current.sid;
  api.artifactFrame({ type: "artifact", artifactId: "art_live", n: 1, event: "create" }, sid);
  await tick();
  assert.equal(byClass(hub.transcript, "artcard").length, 1);
  assert.ok(hub.fetches.some((f) => f.url === "/api/artifacts/art_live"), "the frame triggered exactly the refetch");
  // A pointer with a non-string id never fetches.
  const before = hub.fetches.length;
  api.artifactFrame({ type: "artifact", artifactId: 42 }, sid);
  api.artifactFrame(null, sid);
  assert.equal(hub.fetches.length, before);
  // Deleted meanwhile: the drawn card turns into an honest gone note.
  status = 404;
  await api.artifactRefetch("art_live", sid);
  assert.ok(texts(byClass(hub.transcript, "artcard")[0]).some((t) => /no longer available/i.test(t)));
});

test("loadArtifactCards replays the by-thread batch: distinct artifacts, oldest first, one node each", async () => {
  const items = [
    { artifactId: "art_a", event: "create", n: 1, ts: "2026-10-11 10:00:00" },
    { artifactId: "art_a", event: "update", n: 2, ts: "2026-10-11 10:05:00" },
    { artifactId: "art_b", event: "create", n: 1, ts: "2026-10-11 10:09:00" },
  ];
  const hub = mountCard({
    fetchImpl: (m, url) => {
      if (url.includes("/by-thread/")) return json({ items });
      const id = url.split("/").pop();
      return json(row({ id, title: "T-" + id }));
    },
  });
  const api = hub.sandbox.__exportedApi;
  const sid = hub.sandbox.current.sid;
  api.loadArtifactCards(sid);
  await tick();
  const cards = byClass(hub.transcript, "artcard");
  assert.equal(cards.length, 2, "one card per DISTINCT artifact");
  assert.deepEqual(texts(cards[0]).filter((t) => t.startsWith("T-")), ["T-art_a"]);
  assert.deepEqual(texts(cards[1]).filter((t) => t.startsWith("T-")), ["T-art_b"]);
  const gets = hub.fetches.filter((f) => f.method === "GET" && !f.url.includes("/by-thread/")).map((f) => f.url);
  assert.deepEqual(gets, ["/api/artifacts/art_a", "/api/artifacts/art_b"],
    "one refetch per distinct artifact, in batch order (the pre-settle buffering arm itself is pinned statically + in the hub harness)");
});

test("no artifacts bundle on this gateway: one 404 probe, then the document stops asking", async () => {
  const hub = mountCard({ fetchImpl: (m, url) => (url.includes("/by-thread/") ? json({ error: "not_found" }, 404) : json(row())) });
  const api = hub.sandbox.__exportedApi;
  const sid = hub.sandbox.current.sid;
  api.loadArtifactCards(sid);
  await tick();
  api.loadArtifactCards(sid);
  await tick();
  assert.equal(hub.fetches.filter((f) => f.url.includes("/by-thread/")).length, 1, "probed once");
  assert.equal(api.noBundle(), true);
  assert.equal(byClass(hub.transcript, "artcard").length, 0);
});

test("Run scripts POSTs the existing approve route with CSRF and refetches; Open beside chat opens the pane", async () => {
  const hub = mountCard({
    fetchImpl: (m, url) => {
      if (m === "POST") return json({ approved: true });
      return json(row({ id: "art_run", scriptsOff: true }));
    },
  });
  const api = hub.sandbox.__exportedApi;
  const sid = hub.sandbox.current.sid;
  api.upsertArtifactCard(row({ id: "art_run", scriptsOff: true }), sid);
  const card = byClass(hub.transcript, "artcard")[0];
  const run = byClass(card, "art-run")[0];
  run.onclick();
  await tick();
  const post = hub.fetches.find((f) => f.method === "POST");
  assert.equal(post.url, "/api/artifacts/art_run/versions/1/approve");
  assert.equal(post.opts.headers["X-Crow-Csrf"], "tok");
  assert.ok(hub.fetches.filter((f) => f.method === "GET" && f.url === "/api/artifacts/art_run").length >= 1, "the card refetched after the approve");
  const open = byClass(card, "art-open")[0];
  open.onclick();
  assert.equal(hub.sandbox.location.href, "", "the hub is not navigated");
  const pane = api.pane();
  assert.ok(pane, "the pane opened");
  const frame = byClass(pane, "art-pane-frame")[0];
  assert.equal(frame.src, "/dashboard/artifacts/view/art_run?thread=" + sid);
  const win = byClass(card, "art-window")[0];
  assert.equal(win.href, "/dashboard/artifacts/view/art_run?thread=" + sid);
  assert.equal(win.target, "_blank");
  assert.equal(win.rel, "noopener");
});

test("Q2 pane: the viewer URL, the 1024px breakpoint, split vs sheet, Escape and a transcript reset close it", async () => {
  const hub = mountCard({ fetchImpl: () => json(row({ id: "art_p" })) });
  const api = hub.sandbox.__exportedApi;
  assert.equal(api.artViewerUrl("art_p", "perchlive-0123abcd"), "/dashboard/artifacts/view/art_p?thread=perchlive-0123abcd");
  assert.equal(api.artViewerUrl("art_p", "not a thread"), "/dashboard/artifacts/view/art_p", "only a Perch thread id rides along");
  assert.equal(api.artViewerUrl("a/b?c", null), "/dashboard/artifacts/view/a%2Fb%3Fc");
  assert.equal(api.artPaneMode(1024), "split");
  assert.equal(api.artPaneMode(1023), "sheet");
  assert.equal(api.artPaneMode(412), "sheet");
  hub.sandbox.window.innerWidth = 1280;
  api.openArtifactPane("art_p", hub.sandbox.current.sid);
  assert.equal(api.pane().className, "art-pane art-pane-split");
  assert.ok(hub.bodyClasses.has("perch-art-split"));
  assert.equal(hub.hubRoot.children.length, 1, "mounted inside the hub root (scoped styles)");
  hub.sandbox.window.innerWidth = 412;
  api.openArtifactPane("art_p", hub.sandbox.current.sid);
  assert.equal(api.pane().className, "art-pane art-pane-sheet", "re-opening replaces the pane");
  assert.equal(hub.hubRoot.children.length, 1, "never two panes");
  assert.ok(hub.bodyClasses.has("perch-art-sheet") && !hub.bodyClasses.has("perch-art-split"));
  hub.sandbox.__docListeners.keydown.forEach((f) => f({ key: "Escape" }));
  assert.equal(api.pane(), null);
  assert.equal(hub.hubRoot.children.length, 0);
  assert.equal(hub.bodyClasses.size, 0);
  api.openArtifactPane("art_p", hub.sandbox.current.sid);
  api.resetArtifactCards();
  assert.equal(api.pane(), null, "a transcript reset (another chat) closes the pane");
});

test("a failed approve says so on the card and re-arms the button", async () => {
  const hub = mountCard({ fetchImpl: (m) => (m === "POST" ? json({ error: "flagged" }, 409) : json(row({ id: "art_f", scriptsOff: true }))) });
  const api = hub.sandbox.__exportedApi;
  const sid = hub.sandbox.current.sid;
  api.upsertArtifactCard(row({ id: "art_f", scriptsOff: true }), sid);
  const card = byClass(hub.transcript, "artcard")[0];
  const run = byClass(card, "art-run")[0];
  run.onclick();
  await tick();
  assert.equal(run.disabled, false, "re-armed after the refusal");
  assert.equal(byClass(card, "art-err").length, 1, "the refusal is visible");
});

test("resetArtifactCards drops the index so a new transcript cannot update detached nodes", () => {
  const hub = mountCard();
  const api = hub.sandbox.__exportedApi;
  const sid = hub.sandbox.current.sid;
  api.upsertArtifactCard(row({ id: "art_r" }), sid);
  assert.equal(Object.keys(api.cards()).length, 1);
  api.resetArtifactCards();
  assert.equal(Object.keys(api.cards()).length, 0);
});

// ---------------------------------------------------------------------------
// T1 (review): the artGen guards, BEHAVIOURALLY pinned — M8/M8b/M8c survived
// every static test. A continuation that started before a same-sid transcript
// reset must draw NOTHING into the fresh transcript.
// ---------------------------------------------------------------------------

function deferred() { let release; const p = new Promise((r) => { release = r; }); return { p, release }; }
function gatedRow(id, gate) {
  return { ok: true, status: 200, json: () => gate.then(() => row({ id, title: "T-" + id })) };
}

test("T1: a refetch in flight across a transcript reset draws nothing (M8)", async () => {
  const g = deferred();
  const hub = mountCard({ fetchImpl: (m, url) => gatedRow(url.split("/").pop(), g.p) });
  const api = hub.sandbox.__exportedApi;
  const sid = hub.sandbox.current.sid;
  const p = api.artifactRefetch("art_stale", sid);
  api.resetArtifactCards();               // the reload lands while the fetch is in flight
  g.release();
  await p; await tick();
  assert.equal(byClass(hub.transcript, "artcard").length, 0, "the pre-reset fetch drew nothing into the fresh transcript");
});

test("T1: a by-thread batch resolving after a reset draws nothing (M8b)", async () => {
  const g = deferred();
  const hub = mountCard({
    fetchImpl: (m, url) => url.includes("/by-thread/")
      ? { ok: true, status: 200, json: () => g.p.then(() => ({ items: [{ artifactId: "art_b1", event: "create", n: 1, ts: "x" }] })) }
      : json(row({ id: "art_b1" })),
  });
  const api = hub.sandbox.__exportedApi;
  api.loadArtifactCards(sid0(hub));
  api.resetArtifactCards();
  g.release();
  await tick(); await tick();
  assert.equal(byClass(hub.transcript, "artcard").length, 0, "the stale batch drew nothing");
});

test("T1: buffered live frames are dropped when the reset lands between the batch and the replay (M8c)", async () => {
  const g = deferred();
  const hub = mountCard({
    fetchImpl: (m, url) => url.includes("/by-thread/")
      ? json({ items: [{ artifactId: "art_b1", event: "create", n: 1, ts: "x" }] })   // resolves on a microtask
      : gatedRow(url.split("/").pop(), g.p),                                          // refetches held open
  });
  const api = hub.sandbox.__exportedApi;
  const sid = sid0(hub);
  api.pushBufForTest({ type: "artifact", artifactId: "art_b2", n: 1, event: "create" });
  api.loadArtifactCards(sid);
  await new Promise((r) => setTimeout(r, 0));   // the list continuation runs; the refetches are in flight
  api.resetArtifactCards();                     // reset lands before the chain (and its buf replay) settles
  g.release();
  await tick(); await tick();
  assert.equal(byClass(hub.transcript, "artcard").length, 0,
    "neither the batch's refetches nor the buffered frame drew into the fresh transcript");
});

const sid0 = (hub) => hub.sandbox.current.sid;
