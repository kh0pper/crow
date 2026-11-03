/**
 * Widgets phase 2, Task 4: one more swipe — [Widgets, For You, Chat|project home].
 *
 * The shell's reveal block (dashboard/shell/client.js) alone, run in a vm over a linkedom page, with
 * the rig helpers from tests/for-you-page.test.js: time, animation frames and timers are driven by
 * hand, so a test says exactly how fast the finger moved.
 *
 * What it pins:
 *   - the same left-to-right drag that brings For You in over the Chat list brings Widgets in over
 *     For You (through the page's own data-widgets-entry link, which is also how it is suppressed:
 *     no link, nowhere further in);
 *   - the reverse drag on Widgets walks back one step, to For You — Back when that really was the
 *     page before, a plain visit otherwise, and never out of Crow;
 *   - For You → Chat is exactly what it was: the marker, then the referrer rule, then the Chat list;
 *   - a gesture that starts inside a grid being edited never starts a reveal, either way.
 *
 * Assertions never compare a linkedom node itself (assert.ok(!node), not equal(node, null)): a failure
 * would inspect the whole document graph and hang the run instead of failing it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { parseHTML, DOMParser } from "linkedom";

// The rig reads as tests/for-you-page.test.js does; one name for the strict asserts, and `ok` for the
// "is there / is not there" checks (never assert.equal on a node: see the header).
const assertStrict = assert;
const ok = assert.ok;

const ORIGIN = "https://crow.example.ts.net";
const FY = "/dashboard/for-you";
const WIDGETS = "/dashboard/widgets";
const MARK = "crow.forYou.dragFrom";

/** The widgets page as the reveal fetches it: one main-content, one grid, its tab bar. */
const WIDGETS_HTML = `<!doctype html><html><body class="shell">
  <div class="dashboard"><main class="main-content">
    <header class="content-header"><h2>Widgets</h2></header>
    <div class="content-body">
      <div class="fy fy-widgets" data-fy>
        <div class="wg-grid" data-wg-page="widgets">
          <section class="wg-cell" data-widget="needs-me"><a href="/dashboard/bot-board">Waiting</a></section>
        </div>
      </div>
    </div>
  </main>
  <nav class="shell-tabs"><a href="/dashboard/perch">Chat</a></nav></div>
</body></html>`;

/**
 * One page of the chain, with the links that tell the reveal where it may go:
 *   chat      the Chat list (or a project home): the drawer's For You link
 *   foryou    For You: its header's widgets link (widgetsLink: false hides it)
 *   widgets   the generic widget page: nothing but the grid
 * `editing` puts the grid in Edit mode, so a gesture inside it must never become a swipe.
 */
async function revealRig({
  path = "/dashboard/perch", kind = "chat", search = "", hash = "", view = "list",
  widgetsLink = true, forYouLink = true, editing = false, width = 390, reduce = false,
  fetchHtml = WIDGETS_HTML, fetchOk = true, referrer = "", prevPath = null,
} = {}) {
  const { shellClientJs } = await import("../servers/gateway/dashboard/shell/client.js");
  const js = shellClientJs();
  const a = js.indexOf("// ─── For You: the drag reveal");
  assert.ok(a >= 0, "the reveal block is there");
  const block = js.slice(a, js.indexOf("// ─── The apps launcher", a));
  const editingAttr = editing ? ' data-editing=""' : "";

  const fyPage = `<!doctype html><html><body class="shell" data-view="${view}">
    <div class="dashboard">
      <main class="main-content">
        <header class="content-header shell-header--tab"><h2>For You</h2></header>
        <div class="content-body">
          <div class="fy" data-fy>
            <header class="fy-head"><div class="fy-head-actions">${widgetsLink ? `<a class="fy-icon-btn" href="${WIDGETS}" aria-label="Widgets" data-widgets-entry><svg width="22" height="22" aria-hidden="true"></svg></a>` : ""}</div></header>
            <div class="wg-grid"${editingAttr} data-wg-page="for-you">
              <section class="wg-cell" data-widget="needs-me"><span class="cell">Waiting</span></section>
            </div>
          </div>
        </div>
      </main>
      <nav class="shell-tabs"><a href="/dashboard/perch">Chat</a></nav>
    </div>
    <dialog id="shell-drawer">${forYouLink ? `<a href="${FY}" class="shell-more-item" data-for-you-entry>For You</a>` : ""}</dialog>
  </body></html>`;
  const chatPage = `<!doctype html><html><body class="shell" data-view="${view}">
    <div class="dashboard">
      <main class="main-content">
        <header class="content-header shell-header--tab"><h2>Chat</h2></header>
        <div class="content-body"><div class="row"><span class="cell">A chat</span></div></div>
      </main>
      <nav class="shell-tabs"><a href="/dashboard/perch" aria-current="page">Chat</a></nav>
    </div>
    <dialog id="shell-drawer">${forYouLink ? `<a href="${FY}" class="shell-more-item" data-for-you-entry>For You</a>` : ""}</dialog>
  </body></html>`;
  const widgetsPage = `<!doctype html><html><body class="shell">
    <div class="dashboard">
      <main class="main-content">
        <header class="content-header"><h2>Widgets</h2></header>
        <div class="content-body">
          <div class="fy fy-widgets" data-fy>
            <div class="wg-grid"${editingAttr} data-wg-page="widgets">
              <section class="wg-cell" data-widget="needs-me"><span class="cell">Waiting</span></section>
            </div>
          </div>
        </div>
      </main>
      <nav class="shell-tabs"><a href="/dashboard/perch">Chat</a></nav>
    </div>
  </body></html>`;

  const pageHtml = kind === "widgets" ? widgetsPage : kind === "foryou" ? fyPage : chatPage;
  const { document } = parseHTML(pageHtml);
  Object.defineProperty(document, "referrer", { value: referrer });
  const main = document.querySelector(".main-content");
  const tabs = document.querySelector(".shell-tabs");
  const listeners = {};
  let moveOpts = null;
  document.addEventListener = (type, fn) => { listeners[type] = fn; };
  main.addEventListener = (type, fn, opts) => { listeners["main:" + type] = fn; moveOpts = opts; };

  const clock = { t: 1000 };
  let frames = [], rafCalls = 0, timers = [];
  const visits = [], backs = [], fetched = [];
  const store = new Map();
  const location = { origin: ORIGIN, pathname: path, hash, search };
  const window = {
    innerWidth: width,
    localStorage: { getItem: () => null },
    matchMedia: (q) => ({ matches: (/max-width: 1023px/.test(q) && width <= 1023) || (/prefers-reduced-motion/.test(q) && reduce) }),
    getSelection: () => ({ isCollapsed: true, toString: () => "" }),
    Turbo: { visit: (href) => visits.push(href) },
    history: { length: 3, back: () => backs.push(location.pathname) },
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    addEventListener: (type, fn) => { listeners["window:" + type] = fn; },
  };
  const fetchStub = (url, opts) => {
    fetched.push({ url, opts });
    return Promise.resolve({ ok: fetchOk, status: fetchOk ? 200 : 500, text: () => Promise.resolve(fetchHtml) });
  };
  const ctx = vm.createContext({
    window, document, location, Date: { now: () => clock.t }, String, Math, Array, Promise, DOMParser, URL, AbortController,
    fetch: fetchStub,
    getComputedStyle: () => ({ overflowX: "visible", display: "block", visibility: "visible" }),
    requestAnimationFrame: (fn) => { rafCalls++; frames.push(fn); return frames.length; },
    cancelAnimationFrame: () => { frames = []; },
    setTimeout: (fn, ms) => { const h = { fn, at: clock.t + ms }; timers.push(h); return h; },
    clearTimeout: (h) => { timers = timers.filter((x) => x !== h); },
  });
  // "A Crow page before this one": run the block there first, then on the page under test.
  if (prevPath) {
    const real = { pathname: location.pathname, search: location.search, hash: location.hash };
    Object.assign(location, { pathname: prevPath, search: "", hash: "" });
    vm.runInContext(block, ctx);
    Object.assign(location, real);
  }
  vm.runInContext(block, ctx);

  const at = (sel) => document.querySelector(sel);
  const r = {
    document, main, tabs, visits, backs, fetched, listeners, clock, store,
    visitTo(pathname, search = "") {
      Object.assign(location, { pathname, search, hash: "" });
      vm.runInContext(block, ctx);
    },
    get moveOpts() { return moveOpts; },
    panel: () => document.querySelector("[data-fy-reveal]"),
    frame() { const f = frames; frames = []; f.forEach((fn) => fn()); },
    wait(ms) {
      const until = clock.t + ms;
      for (;;) {
        const due = timers.filter((h) => h.at <= until).sort((x, y) => x.at - y.at)[0];
        if (!due) break;
        timers = timers.filter((h) => h !== due);
        clock.t = Math.max(clock.t, due.at);
        due.fn();
      }
      clock.t = until;
    },
    down(x, y = 300, target = at(".cell")) { listeners.touchstart({ touches: [{ clientX: x, clientY: y }], target }); },
    move(x, y = 300, dt = 16) {
      clock.t += dt;
      const ev = { touches: [{ clientX: x, clientY: y }], cancelable: true, prevented: false, preventDefault() { this.prevented = true; } };
      listeners["main:touchmove"]?.(ev);
      return ev.prevented;
    },
    up(x, y = 300, dt = 0) { clock.t += dt; listeners.touchend({ changedTouches: [{ clientX: x, clientY: y }] }); },
    drag(x0, x1, { dy = 0, steps = 8, dt = 40, pause = 0, target } = {}) {
      r.down(x0, 300, target);
      for (let i = 1; i <= steps; i++) {
        r.move(Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(300 + (dy * i) / steps), dt);
        r.frame();
      }
      r.up(x1, 300 + dy, pause);
      r.wait(1000);
      return visits.length;
    },
  };
  return r;
}

const forYou = (opts = {}) => revealRig({ path: FY, kind: "foryou", ...opts });
const widgets = (opts = {}) => revealRig({ path: WIDGETS, kind: "widgets", ...opts });

test("the same left-to-right drag that brings For You in brings Widgets in over For You", async () => {
  const r = await forYou();
  assertStrict.equal(r.drag(60, 300, { pause: 200 }), 1, "the drag lands on the widgets page");
  assertStrict.deepEqual(r.visits, [WIDGETS], "one step further in, never two");
  assertStrict.deepEqual(r.backs, [], "a forward drag never calls history.back()");
  assertStrict.equal(r.main.style.transform, "translate3d(390px,0,0)", "For You finishes leaving to the right");
  assertStrict.equal(r.panel().style.transform, "translate3d(0px,0,0)", "and Widgets fills the screen");
  // The marker the reverse drag will follow.
  const mark = JSON.parse(r.store.get(MARK));
  assertStrict.deepEqual([mark.from, mark.to, mark.landed], [FY, WIDGETS, false]);
});

test("the panel is the widget page's own copy, and the skeleton names it when the fetch has not landed", async () => {
  const r = await forYou();
  r.down(60);
  assertStrict.equal(r.fetched.length, 1, "fetched on the first eligible touch");
  assertStrict.equal(r.fetched[0].url, WIDGETS, "the widgets page, not For You again");
  await new Promise((res) => setImmediate(res));
  r.move(90); r.move(150); r.frame();
  const p = r.panel();
  ok(p, "the panel is in");
  assertStrict.ok(p.querySelector('.wg-grid[data-wg-page="widgets"]'), "the copy is the widget page's grid");
  assertStrict.ok(p.querySelector(".shell-tabs"), "with its tab bar");
  ok(!p.querySelector("script"), "and nothing that runs");

  // No fetch back yet: the skeleton takes its title from the link (an icon button: its aria-label).
  const none = await forYou();
  none.down(60); none.move(90); none.move(150); none.frame();
  const sk = none.panel();
  assertStrict.equal(sk.querySelector(".fy-reveal-title").textContent, "Widgets", "the link's own name");
  assertStrict.equal(sk.querySelector(".content-header h2").textContent, "Widgets");
  assertStrict.equal(sk.querySelectorAll(".fy-reveal-card").length, 3);
});

test("without the widgets link For You has nowhere further in: the old gesture is untouched", async () => {
  const r = await forYou({ widgetsLink: false });
  assertStrict.equal(r.drag(60, 300, { pause: 200 }), 0, "no link, no forward step");
  ok(!r.panel());
  assertStrict.equal(r.fetched.length, 0, "and nothing is fetched");
  // The reverse drag still pushes For You out to the Chat list, as it always did.
  const back = await forYou({ widgetsLink: false, prevPath: "/dashboard/perch" });
  back.drag(330, 100, { pause: 200 });
  assertStrict.deepEqual(back.visits, ["/dashboard/perch"]);
  assertStrict.deepEqual(back.backs, []);
});

test("the reverse drag on Widgets walks back one step, to For You", async () => {
  // The marker a forward drag left, landed by Widgets' own render: Back, one page.
  const marked = await widgets();
  marked.store.set(MARK, JSON.stringify({ from: FY, to: WIDGETS, at: marked.clock.t, landed: true }));
  const step = marked.drag(330, 100, { pause: 200 });
  assertStrict.equal(step, 0, "Back is not a Turbo visit");
  assertStrict.deepEqual(marked.backs, [WIDGETS], "history.back() to For You");
  assertStrict.deepEqual(marked.visits, [], "no visit");
  assertStrict.equal(marked.store.has(MARK), false, "and the marker is consumed");
  assertStrict.equal(marked.panel().style.transform, "translate3d(0px,0,0)", "a plain panel comes in from the right");
  assertStrict.equal(marked.main.style.transform, "translate3d(-390px,0,0)", "the page leaves to the left");
  assertStrict.equal(marked.panel().children.length, 0, "and that panel carries no copy: For You is restored from cache");

  // Opened from For You in this window, no marker needed: the referrer says For You.
  const referred = await widgets({ prevPath: FY, referrer: ORIGIN + FY });
  referred.drag(330, 100, { pause: 200 });
  assertStrict.deepEqual(referred.backs, [WIDGETS]);
  assertStrict.deepEqual(referred.visits, []);

  // A deep link into Widgets (no page before it, no referrer): a visit to For You, never Back out of Crow.
  const direct = await widgets({ referrer: "https://elsewhere.example/page" });
  direct.drag(330, 100, { pause: 200 });
  assertStrict.deepEqual(direct.backs, [], "never Back to somewhere that is not Crow");
  assertStrict.deepEqual(direct.visits, [FY], "one step out is For You");

  // A marker that points somewhere else is not followed.
  const forged = await widgets();
  forged.store.set(MARK, JSON.stringify({ from: "https://elsewhere.example/", to: WIDGETS, at: forged.clock.t, landed: true }));
  forged.drag(330, 100, { pause: 200 });
  assertStrict.deepEqual(forged.backs, [], "a forged marker never lands");
  assertStrict.deepEqual(forged.visits, [FY]);

  // Short of the threshold: nothing at all.
  const short = await widgets();
  short.drag(330, 250, { pause: 200 });
  assertStrict.deepEqual([short.backs, short.visits], [[], []]);
  assertStrict.equal(short.main.style.transform, "");
  // Left to right on Widgets: it is the leftmost page, so there is nowhere further in.
  const wrongWay = await widgets();
  assertStrict.equal(wrongWay.drag(60, 300, { pause: 200 }), 0);
});

test("For You → Chat is exactly what it was: the marker, then the referrer rule, then the Chat list", async () => {
  // Forward from a project home, landed on For You, then the reverse drag: Back.
  const r = await revealRig({ path: "/dashboard/project/garden" });
  assertStrict.equal(r.drag(60, 300, { pause: 200 }), 1);
  assertStrict.deepEqual(r.visits, [FY], "the forward drag still lands on For You");
  r.listeners["turbo:before-render"]({ detail: { newBody: r.document.body.cloneNode(true) } });
  r.visitTo(FY);
  assertStrict.equal(JSON.parse(r.store.get(MARK)).landed, true, "For You's render marks it landed");
  r.drag(330, 100, { pause: 200 });
  assertStrict.deepEqual(r.backs, [FY]);
  assertStrict.equal(r.visits.length, 1, "no Chat list visit");

  // No marker, same-origin referrer, a Crow page before: Back.
  const ref = await forYou({ prevPath: "/dashboard/perch", referrer: ORIGIN + "/dashboard/perch" });
  const refStep = ref.drag(330, 100, { pause: 200 });
  assertStrict.equal(refStep, 0, "Back is not a Turbo visit");
  assertStrict.deepEqual([ref.backs, ref.visits], [[FY], []]);

  // Neither: the Chat list.
  const none = await forYou({ prevPath: "/dashboard/perch" });
  none.drag(330, 100, { pause: 200 });
  assertStrict.deepEqual([none.backs, none.visits], [[], ["/dashboard/perch"]]);

  // Inside 48 px of the right edge: the system Back gesture's, not ours.
  const edge = await forYou({ prevPath: "/dashboard/perch", referrer: ORIGIN + "/dashboard/perch" });
  edge.drag(360, 60, { pause: 200 });
  assertStrict.deepEqual([edge.backs, edge.visits], [[], []]);
});

test("a gesture that starts inside the grid being edited never starts a reveal, either way", async () => {
  // For You, Edit mode on: a left-to-right drag on a cell stays a widget drag.
  const forward = await forYou({ editing: true });
  const cell = forward.document.querySelector(".wg-grid .wg-cell");
  ok(cell, "the cell is there");
  assertStrict.equal(forward.drag(60, 300, { pause: 200, target: cell }), 0, "no reveal into Widgets");
  ok(!forward.panel(), "no panel either");
  assertStrict.equal(forward.fetched.length, 0, "and nothing is fetched");
  // While editing, the page never swipes, wherever the gesture starts (the header included).
  assertStrict.equal(forward.drag(60, 300, { pause: 200, target: forward.document.querySelector(".fy-head") }), 0,
    "starting above the grid while editing does not swipe either");

  // Widgets, Edit mode on: a right-to-left drag on a cell does not walk back.
  const back = await widgets({ editing: true });
  const wcell = back.document.querySelector(".wg-grid .wg-cell");
  const widgetCell = wcell || back.document.querySelector(".wg-cell");
  back.down(330, 300, widgetCell);
  for (const x of [300, 250, 150, 100]) { back.move(x); back.frame(); }
  back.up(100);
  back.wait(1000);
  assertStrict.deepEqual([back.backs, back.visits], [[], []], "no step out of the page");
  ok(!back.panel(), "and no panel");

  // Not editing: the same gesture on the same cell does walk back.
  const open = await widgets({ editing: false });
  assertStrict.equal(open.drag(330, 100, { pause: 200 }), 1, "one step back to For You");
  assertStrict.deepEqual(open.visits, [FY]);
});