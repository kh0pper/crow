// WHOSE tab is it: the bot's, the operator's, or one nobody can prove?
//
// The exit cleanup (`blankPagesOnExit`) used to blank and close EVERY page in the
// browser context, the operator's own VNC tabs included. The rule now is that it
// cleans up only the pages this MCP opened or drove, and that the operator's tabs
// are never navigated, closed, or even given a CDP session. `page-ownership.js` is
// where a page's owner is decided:
//
//   markOpened(page)   this MCP created the page (context.newPage), permanently bot
//   markTouched(page)  the bot drove the page (a tool call selected it), permanently bot
//   classify(page)     "bot" | "operator" | "uncertain", in memory, no CDP call
//   newPage(context)   context.newPage() then markOpened
//   attachContext(c)   classify every page that appears LATER, through its opener()
//   settle()           resolves when the in-flight classifications are done
//
// These are the unit cases (fakes only, Playwright is not installed for the test
// suite). The live ones — real Chromium, real history, a second CDP client driving
// its own tab — are the "page ownership" cases at the end of
// tests/browser-close-leak-live.test.js.
//
// Every "the cleanup left it alone" here comes with a count of the calls the page
// saw (goto, close, isClosed, newCDPSession), so a zero cannot be vacuous.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

import { createPageOwnership } from "../bundles/browser/server/page-ownership.js";
// The namespace import is the T22 (section 16) seam: a helper the product code does not
// export yet has to make ITS OWN test red, not break the import of the whole file.
import * as ownershipModule from "../bundles/browser/server/page-ownership.js";
import { blankPagesOnExit } from "../bundles/browser/server/private-address.js";

const SERVER_JS = new URL("../bundles/browser/server/server.js", import.meta.url);
const OWNERSHIP_JS = new URL("../bundles/browser/server/page-ownership.js", import.meta.url);

// ---------------------------------------------------------------------------
// fakes: a page that counts every call, and a context that can emit pages
// ---------------------------------------------------------------------------

/**
 * A fake page. Every call a caller can make on it is counted (`calls`), so "the
 * cleanup did not touch this tab" is a number and not an impression.
 *
 * `opener` is the Playwright `page.opener()` contract: a promise of the opener
 * page, null when it has none, or a rejection. `openerDelayMs` makes the lookup a
 * real round trip, which is what a race between a mark and a page event needs.
 */
function fakePage(world, name, opts = {}) {
  const page = {
    name,
    // The CDP target id: stable across a reconnect (a new Page object for the
    // same tab carries the same one), which is what the ownership keys a
    // re-attached context on.
    targetId: opts.targetId || `target-${++world.targetSeq}`,
    // Lane A's tab: a foreign CDP client drives this one (nothing in the
    // ownership reads it — this is what the fake stands for, see the lane-A
    // case at the bottom).
    foreign: opts.foreign === true,
    closed: false,
    failGoto: opts.failGoto === true,
    openerPage: opts.opener || null,
    openerThrows: opts.openerThrows === true,
    openerDelayMs: Number(opts.openerDelayMs) || 0,
    calls: { goto: [], close: 0, isClosed: 0, newCDPSession: 0, opener: 0 },
  };
  page.urlValue = opts.url || `http://127.0.0.1:9/${name}`;
  page.url = () => page.urlValue;
  page.isClosed = () => {
    page.calls.isClosed += 1;
    return page.closed;
  };
  page.goto = async (target) => {
    page.calls.goto.push(target);
    world.order.push(`goto:${name}`);
    if (opts.onGoto) opts.onGoto(page);
    // A real goto is a round trip: without awaiting it, ordering would be luck.
    await new Promise((r) => setTimeout(r, 0));
    if (page.failGoto) throw new Error(`page ${name} crashed`);
    page.urlValue = target;
  };
  page.close = async () => {
    page.calls.close += 1;
    page.closed = true;
    world.order.push(`close:${name}`);
  };
  page.opener = async () => {
    page.calls.opener += 1;
    if (page.openerDelayMs) await new Promise((r) => setTimeout(r, page.openerDelayMs));
    if (page.openerThrows) throw new Error(`no opener for ${name}`);
    return page.openerPage;
  };
  // `attachDenyAllSession` goes through `page.context().newCDPSession(page)`; the
  // ownership's own target-id lookup goes through the CONTEXT it was attached
  // with. Both are counted on the page they name.
  page.context = () => ({
    async newCDPSession(target) {
      const counted = target && target.calls ? target : page;
      counted.calls.newCDPSession += 1;
      world.order.push(`attach:${counted.name}`);
      return {
        on() {},
        async send() {},
        async detach() {
          world.order.push(`detach:${counted.name}`);
        },
      };
    },
  });
  return page;
}

/**
 * A fake BrowserContext (an EventEmitter, like Playwright's) plus its pages.
 *
 * `newPage()` does NOT emit "page" unless `emitOnNewPage` is set: a real context
 * does, but a fake that emits for pages no test asked about would blur the one
 * case that is about a page appearing mid-session. A test that wants the event
 * emits it (`emitPage`).
 */
function makeWorld(opts = {}) {
  const world = {
    targetSeq: 0,
    pages: [],
    // One ordered log of everything done to every page and context, for "the
    // survivor was created BEFORE the first close" and its kin.
    order: [],
    cdpSessions: 0,
    crashSends: [],
    newPageCalls: 0,
    pageDefaults: opts.pageDefaults || {},
  };
  const context = new EventEmitter();
  world.context = context;
  world.addPage = (name, pageOpts = {}) => {
    const page = fakePage(world, name, { ...world.pageDefaults, ...pageOpts });
    world.pages.push(page);
    return page;
  };
  context.pages = () => world.pages.slice();
  context.newPage = async () => {
    world.newPageCalls += 1;
    world.order.push("newPage");
    if (opts.failNewPage) throw new Error("no new page: the browser is going");
    const page = world.addPage(`survivor-${world.newPageCalls}`, { url: "about:blank" });
    if (opts.emitOnNewPage) context.emit("page", page);
    return page;
  };
  context.newCDPSession = async (page) => {
    world.cdpSessions += 1;
    world.order.push(`cdp:${page && page.name}`);
    if (page && page.calls) page.calls.newCDPSession += 1;
    return {
      async send(method) {
        if (method === "Target.getTargetInfo") return { targetInfo: { targetId: page ? page.targetId : null } };
        return {};
      },
      async detach() {
        world.order.push(`cdpDetach:${page && page.name}`);
      },
    };
  };
  context.browser = () => ({
    async newBrowserCDPSession() {
      world.order.push("browser:newSession");
      return {
        async send(method) {
          world.crashSends.push(method);
          world.order.push(`browser:send:${method}`);
        },
      };
    },
  });
  world.emitPage = (page) => context.emit("page", page);
  return world;
}

/** The exit cleanup, driven through its seam: a fake proc whose stdin closes. */
async function runExitCleanup(world, options = {}) {
  const proc = new EventEmitter();
  proc.stdin = new EventEmitter();
  const settings = { proc, budgetMs: Number.isFinite(options.budgetMs) ? options.budgetMs : 2000 };
  if (options.ownership) settings.ownership = options.ownership;
  const run = blankPagesOnExit(() => world.context, settings);
  proc.stdin.emit("close");
  await run();
}

/** Collect every console.error line written while `work` runs. */
async function withConsoleError(work) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
  };
  try {
    await work();
  } finally {
    console.error = original;
  }
  return lines;
}

/** Every count a page saw, for a readable "nothing touched it" assertion. */
const callCounts = (page) => ({ goto: page.calls.goto, close: page.calls.close, isClosed: page.calls.isClosed, newCDPSession: page.calls.newCDPSession });

const ZERO_CALLS = { goto: [], close: 0, isClosed: 0, newCDPSession: 0 };

// ---------------------------------------------------------------------------
// 1. the two marks, and the page that was already there
// ---------------------------------------------------------------------------

test("markOpened and markTouched make a page the bot's; a page that was already there is the operator's", async () => {
  const world = makeWorld();
  const first = world.addPage("first");
  const second = world.addPage("second");
  const third = world.addPage("third");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  assert.equal(ownership.classify(third), "operator", "a page that existed when the context was attached is the operator's");

  ownership.markOpened(first);
  assert.equal(ownership.classify(first), "bot", "markOpened makes the page the bot's, synchronously");

  ownership.markTouched(second);
  assert.equal(ownership.classify(second), "bot", "markTouched makes the page the bot's, synchronously");
  assert.equal(ownership.classify(third), "operator", "the untouched page is still the operator's");

  // Control: a later event classification never downgrades a bot page. The page
  // event that arrives for it names an OPERATOR page as its opener, which would
  // make a fresh page the operator's.
  first.openerPage = third;
  world.emitPage(first);
  await ownership.settle();
  assert.equal(ownership.classify(first), "bot", "a bot page stays the bot's, whatever a later event classification says");
  assert.equal(ownership.classify(second), "bot", "and so does the other one");
});

// ---------------------------------------------------------------------------
// 2. popups: whose page is a window.open?
// ---------------------------------------------------------------------------

test("a popup of a bot page is the bot's, even when its opener closes right after the event", async () => {
  const world = makeWorld();
  const botPage = world.addPage("bot");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  ownership.markOpened(botPage);
  await ownership.settle();

  const popup = world.addPage("popup", { opener: botPage });
  world.emitPage(popup);
  await ownership.settle();
  assert.equal(ownership.classify(popup), "bot", "window.open from a bot page is the bot's tab");

  // Control: the opener is closed right after the event. Whose page the opener
  // OBJECT is (in this process's memory) is what decides, not whether the browser
  // still has it: a popup whose opener went away between the event and the
  // classification is still the bot's.
  const other = world.addPage("bot-2");
  ownership.markTouched(other);
  await ownership.settle();
  const orphanedPopup = world.addPage("popup-of-closed-opener", { opener: other, openerDelayMs: 20 });
  world.emitPage(orphanedPopup);
  other.closed = true;
  await ownership.settle();
  assert.equal(ownership.classify(orphanedPopup), "bot", "the opener closing mid-classification does not make its popup nobody's");
});

// REWRITTEN for T20 (round 9, FIX2): ownership of RELATIVES follows `markTouched`. A
// page the bot drives makes the windows it opened the bot's too, so the popup of a
// touched opener is no longer left at the operator default — it is a window the bot's
// own tab opened, and nothing may be left running unguarded after the exit. What stays
// sticky is the popup of a page the bot never drove: driving an UNRELATED tab says
// nothing about it.
test("touching the opener makes its popup the bot's; a popup of a page the bot never drove stays the operator's", async () => {
  const world = makeWorld();
  const operatorPage = world.addPage("operator");
  const unrelated = world.addPage("unrelated");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  const popup = world.addPage("operator-popup", { opener: operatorPage });
  world.emitPage(popup);
  await ownership.settle();
  assert.equal(ownership.classify(popup), "operator", "the operator opened this one, through their own tab");
  assert.equal(ownership.classify(operatorPage), "operator", "CONTROL: its opener is the operator's before anything is touched");

  // STICKY, for a page the bot never drove: the bot drives an UNRELATED tab, and the
  // operator's popup keeps its hands.
  ownership.markTouched(unrelated);
  await ownership.settle();
  assert.equal(ownership.classify(unrelated), "bot", "the tab the bot drove is the bot's");
  assert.equal(
    ownership.classify(popup),
    "operator",
    "CONTROL: a popup whose opener the bot never drove stays the operator's, whoever else the bot drives",
  );
  assert.equal(ownership.classify(operatorPage), "operator", "CONTROL: …and so does the opener the bot never drove");

  // THE CASE (RED at HEAD: the popup was left the operator's). The bot drives the page
  // that OPENED the popup, so the window it opened follows the touch.
  ownership.markTouched(operatorPage);
  await ownership.settle();
  assert.equal(ownership.classify(operatorPage), "bot", "the opener itself is the bot's now (the bot drove it)");
  assert.equal(
    ownership.classify(popup),
    "bot",
    "the popup of the page the bot drove is the bot's too: a window the bot's own tab opened is never left unguarded",
  );

  // Control: a popup of that opener, opened AFTER the touch, is the bot's as well.
  const openedLater = world.addPage("later-popup", { opener: operatorPage });
  world.emitPage(openedLater);
  await ownership.settle();
  assert.equal(ownership.classify(openedLater), "bot", "a popup of a bot page is the bot's, whenever it appears");
});

test("a page whose opener cannot be proven is uncertain, and an ownership.newPage is the bot's whatever the race", async () => {
  const world = makeWorld();
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  // opener null, and not created through ownership.newPage: nothing says whose it is.
  const orphan = world.addPage("orphan");
  world.emitPage(orphan);
  await ownership.settle();
  assert.equal(ownership.classify(orphan), "uncertain", "no opener and no mark: the page's origin cannot be proven");

  // Control: opener() itself throws (the target is gone): same answer, not a crash.
  const throwing = world.addPage("throwing", { openerThrows: true });
  world.emitPage(throwing);
  await ownership.settle();
  assert.equal(ownership.classify(throwing), "uncertain", "an opener lookup that throws is 'uncertain', never an exception");

  // Control: the SAME null-opener page, created through ownership.newPage — the
  // mark wins the race with the page event, in both orders. A real context emits
  // "page" DURING newPage (event first); the other order is a context that emits
  // after the mark.
  for (const emitOnNewPage of [true, false]) {
    const race = makeWorld({ emitOnNewPage, pageDefaults: { openerDelayMs: 15 } });
    const raceOwnership = createPageOwnership();
    await raceOwnership.attachContext(race.context);
    const created = await raceOwnership.newPage(race.context);
    if (!emitOnNewPage) race.emitPage(created); // mark first, event after
    await raceOwnership.settle();
    assert.equal(
      raceOwnership.classify(created),
      "bot",
      `a page created through ownership.newPage is the bot's (${emitOnNewPage ? "event-then-mark" : "mark-then-event"} order)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. a reconnect: new Page objects, same CDP targets
// ---------------------------------------------------------------------------

test("a re-attached context re-marks the bot's pages by target id, and claims nothing else", async () => {
  const first = makeWorld();
  const firstBot = first.addPage("bot", { targetId: "target-bot" });
  first.addPage("operator", { targetId: "target-operator" });
  const ownership = createPageOwnership();
  await ownership.attachContext(first.context);
  ownership.markOpened(firstBot);
  await ownership.settle();
  assert.equal(ownership.classify(firstBot), "bot");

  // The reconnect: a new context, new Page objects for the SAME tabs.
  const second = makeWorld();
  const newBot = second.addPage("bot", { targetId: "target-bot" });
  const newOperator = second.addPage("operator", { targetId: "target-operator" });
  const stranger = second.addPage("stranger", { targetId: "target-stranger" });
  await ownership.attachContext(second.context);
  await ownership.settle();

  assert.equal(ownership.classify(newBot), "bot", "the tab the bot drove is the bot's after the reconnect too (same target id)");
  assert.equal(ownership.classify(newOperator), "operator", "the operator's tab is not claimed by a reconnect");
  assert.equal(ownership.classify(stranger), "operator", "and neither is a tab the ownership never saw");
});

test("with nothing ever bot-owned, attachContext opens no CDP session at all", async () => {
  const world = makeWorld();
  world.addPage("a");
  world.addPage("b");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  await ownership.settle();

  assert.equal(world.cdpSessions, 0, "the ownership asks the browser nothing when it owns nothing");
  assert.deepEqual(world.order, [], `nothing at all is done to the pages (order: ${world.order.join(", ")})`);
});

// ---------------------------------------------------------------------------
// 4. the exit cleanup, with an ownership: only the bot's pages are touched
// ---------------------------------------------------------------------------

test("blankPagesOnExit with an ownership cleans the bot's page and leaves the operator's with zero calls", async () => {
  const world = makeWorld();
  const operatorPage = world.addPage("operator");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  const botPage = world.addPage("bot");
  ownership.markTouched(botPage);
  await ownership.settle();

  await runExitCleanup(world, { ownership });

  assert.deepEqual(botPage.calls.goto, ["about:blank"], "the bot's page is blanked before it is closed");
  assert.equal(botPage.calls.close, 1, "…and then closed (a blank keeps the history, only the close removes it)");
  assert.deepEqual(
    callCounts(operatorPage),
    ZERO_CALLS,
    "the operator's page is never navigated, closed, probed with isClosed() or given a CDP session",
  );
  assert.equal(world.newPageCalls, 0, "an operator page remains, so no survivor tab is created");
  assert.deepEqual(world.crashSends, [], "nothing failed, so the browser is not crashed");
});

test("blankPagesOnExit without an ownership (legacy) processes both pages", async () => {
  const world = makeWorld();
  const operatorPage = world.addPage("operator");
  const botPage = world.addPage("bot");

  await runExitCleanup(world);

  assert.deepEqual(botPage.calls.goto, ["about:blank"], "legacy blanked the bot's page");
  assert.deepEqual(
    operatorPage.calls.goto,
    ["about:blank"],
    "legacy blanked EVERY page, the operator's included — this is the behaviour the ownership option replaces",
  );
  assert.equal(botPage.calls.close, 1, "legacy closed the bot's page");
  assert.equal(operatorPage.calls.close, 1, "legacy closed the operator's page too");
  assert.equal(world.newPageCalls, 1, "legacy always made its fresh survivor");
});

test("a page the bot touched is blanked then closed, and its untouched sibling is not", async () => {
  const world = makeWorld();
  const touched = world.addPage("touched", { url: "http://127.0.0.1:9/operator-tab" });
  const sibling = world.addPage("sibling", { url: "http://127.0.0.1:9/operator-other" });
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  ownership.markTouched(touched);
  await ownership.settle();
  assert.equal(ownership.classify(touched), "bot", "a page the bot drove is the bot's, even though the operator opened it");

  await runExitCleanup(world, { ownership });

  assert.deepEqual(touched.calls.goto, ["about:blank"], "the touched tab is blanked first (observed commit) …");
  assert.equal(touched.calls.close, 1, "… then closed, never reused: a blank keeps the history entries");
  assert.deepEqual(callCounts(sibling), ZERO_CALLS, "the untouched operator tab next to it is not touched at all");
  assert.equal(world.newPageCalls, 0, "the untouched tab keeps the browser alive, so no survivor is needed");
});

test("60 operator pages and one bot page: the cleanup is fast, touches nothing but the bot's page", async () => {
  const world = makeWorld();
  const operators = [];
  for (let i = 0; i < 60; i++) operators.push(world.addPage(`operator-${i}`));
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  const botPage = world.addPage("bot");
  ownership.markOpened(botPage);
  await ownership.settle();

  const started = Date.now();
  await runExitCleanup(world, { ownership, budgetMs: 2000 });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 800, `the cleanup has to walk only the bot's pages, not 61 tabs (took ${elapsed} ms)`);
  for (const page of operators) {
    assert.deepEqual(callCounts(page), ZERO_CALLS, `${page.name} is the operator's: no goto, no close, no isClosed(), no CDP session`);
  }
  assert.deepEqual(botPage.calls.goto, ["about:blank"], "the bot's page is still cleaned up");
  assert.equal(botPage.calls.close, 1, "the bot's page is closed");
  assert.deepEqual(world.crashSends, [], "no budget was spent and nothing failed, so there is nothing to crash");
});

// ---------------------------------------------------------------------------
// 5. the survivor rule
// ---------------------------------------------------------------------------

test("survivor rule (a): an operator page is left behind, so no survivor tab is made", async () => {
  const world = makeWorld();
  const operatorPage = world.addPage("operator");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  const botPage = world.addPage("bot");
  ownership.markTouched(botPage);
  await ownership.settle();

  await runExitCleanup(world, { ownership });

  assert.equal(world.newPageCalls, 0, "the operator's tab keeps the browser alive, so a fresh survivor would just pile up one blank tab per turn");
  assert.deepEqual(callCounts(operatorPage), ZERO_CALLS, "and that tab is left exactly as it was");
  assert.equal(botPage.calls.close, 1, "the bot's page is still cleaned up");
});

test("survivor rule (b): with only bot pages, the fresh survivor is created BEFORE the first close", async () => {
  const world = makeWorld();
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  const one = world.addPage("bot-1");
  const two = world.addPage("bot-2");
  ownership.markOpened(one);
  ownership.markTouched(two);
  await ownership.settle();

  await runExitCleanup(world, { ownership });

  const newPageAt = world.order.indexOf("newPage");
  const firstCloseAt = world.order.findIndex((entry) => entry.startsWith("close:"));
  assert.notEqual(newPageAt, -1, `a survivor has to be created: nothing would be left alive (order: ${world.order.join(", ")})`);
  assert.notEqual(firstCloseAt, -1, `the bot's pages are closed (order: ${world.order.join(", ")})`);
  assert.ok(
    newPageAt < firstCloseAt,
    `the survivor comes FIRST: in headful Chromium closing the last page exits the browser (order: ${world.order.join(", ")})`,
  );
  assert.equal(one.calls.close, 1, "the first bot page is closed");
  assert.equal(two.calls.close, 1, "the second bot page is closed");
  assert.deepEqual(world.crashSends, [], "nothing failed, so nothing is crashed");
});

test("survivor rule (c): with no bot page at all, the cleanup does nothing whatsoever", async () => {
  const world = makeWorld();
  const one = world.addPage("operator-1");
  const two = world.addPage("operator-2");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  await runExitCleanup(world, { ownership });

  assert.equal(world.newPageCalls, 0, "no bot page means no survivor is needed");
  assert.deepEqual(callCounts(one), ZERO_CALLS, "nothing is navigated, closed, probed or given a session");
  assert.deepEqual(callCounts(two), ZERO_CALLS, "nor on the other one");
  assert.deepEqual(world.crashSends, [], "there is nothing to fail closed about");
  // The browser-level CDP session the cleanup opens for its crash path is not a
  // page being touched; nothing that acts ON a page may appear here.
  const pageWork = world.order.filter((entry) => !entry.startsWith("browser:"));
  assert.deepEqual(pageWork, [], `nothing is created, navigated, closed or attached (order: ${world.order.join(", ")})`);
});

test("survivor rule (d): a survivor that cannot be created fails closed — crash, no close", async () => {
  const world = makeWorld({ failNewPage: true });
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  const botPage = world.addPage("bot");
  ownership.markOpened(botPage);
  await ownership.settle();

  await runExitCleanup(world, { ownership });

  assert.deepEqual(world.crashSends, ["Browser.crash"], "without a fresh survivor every close is the browser's last page: it is crashed, never closed");
  assert.deepEqual(botPage.calls.goto, [], "nothing is navigated either: there is no survivor in front of it");
  assert.equal(botPage.calls.close, 0, "and nothing is closed");
});

// ---------------------------------------------------------------------------
// 6. the uncertain page
// ---------------------------------------------------------------------------

test("an uncertain page is left alone and reported once; the bot's page is still cleaned up", async () => {
  const world = makeWorld();
  // A SHORT bot-action window, stepped over below: this case is the independent-tab
  // rule (a tab with no opener and no openerId is nobody's), not FIX3's window, so the
  // arrival has to be outside the window — exactly as it is in a real session long
  // after the last bot action.
  const ownership = createPageOwnership({ botActionWindowMs: 100 });
  await ownership.attachContext(world.context);
  const botPage = world.addPage("bot");
  ownership.markOpened(botPage);
  await ownership.settle();
  await later(250); // past the bot-action window

  // A tab that appeared mid-session whose origin cannot be proven: no opener, and
  // not created through ownership.newPage.
  const uncertainPage = world.addPage("mid-session", { url: "http://127.0.0.1:9/mid-session" });
  world.emitPage(uncertainPage);
  await ownership.settle();
  assert.equal(ownership.classify(uncertainPage), "uncertain");

  // The ARRIVAL is allowed one short-lived CDP session (the F1(b) rule: an arrival
  // with no opener, while the ownership holds a bot page, is asked for its CDP
  // openerId once). What must not change is the CLEANUP's share: snapshot the
  // counts after the arrival has settled, and require them to be identical after
  // the cleanup. (The goto list is copied: `callCounts` hands back the live array.)
  const afterArrival = { ...callCounts(uncertainPage), goto: [...uncertainPage.calls.goto] };

  const lines = await withConsoleError(() => runExitCleanup(world, { ownership }));
  const mentioning = lines.filter((line) => /uncertain/i.test(line));

  assert.deepEqual(
    callCounts(uncertainPage),
    afterArrival,
    "the cleanup leaves an uncertain page exactly as the arrival left it: no goto, no close, no isClosed(), no new CDP session",
  );
  assert.deepEqual(uncertainPage.calls.goto, [], "it was never navigated");
  assert.equal(uncertainPage.calls.close, 0, "…never closed");
  assert.equal(uncertainPage.calls.isClosed, 0, "…never probed with isClosed()");
  assert.equal(mentioning.length, 1, `exactly one console.error line names the uncertain count (lines: ${JSON.stringify(lines)})`);
  assert.deepEqual(botPage.calls.goto, ["about:blank"], "the bot's page is cleaned up all the same");
  assert.equal(botPage.calls.close, 1, "… blanked and closed");
  assert.equal(world.newPageCalls, 0, "the uncertain page keeps the browser alive, so no survivor is made");
  assert.deepEqual(world.crashSends, [], "an uncertain page is not a failure: nothing is crashed");
});

test("with only operator pages there is no uncertain line at all (control)", async () => {
  const world = makeWorld();
  world.addPage("operator-1");
  world.addPage("operator-2");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  const lines = await withConsoleError(() => runExitCleanup(world, { ownership }));

  assert.deepEqual(lines.filter((line) => /uncertain/i.test(line)), [], `an operator page is not uncertain, so nothing is reported (lines: ${JSON.stringify(lines)})`);
});

// ---------------------------------------------------------------------------
// 7. fail closed for the bot's pages, with the ownership in place
// ---------------------------------------------------------------------------

test("a bot page whose blank fails is not closed and crashes the browser; the operator's page is untouched", async () => {
  const world = makeWorld();
  const operatorPage = world.addPage("operator");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  const botPage = world.addPage("bot", { failGoto: true });
  ownership.markOpened(botPage);
  await ownership.settle();

  await runExitCleanup(world, { ownership });

  assert.deepEqual(botPage.calls.goto, ["about:blank"], "the blank was attempted");
  assert.equal(botPage.calls.close, 0, "a page whose blank did not commit is NEVER closed: its beacons are still armed");
  assert.deepEqual(world.crashSends, ["Browser.crash"], "the only safe end for that page is the death of the browser it lives in");
  assert.deepEqual(callCounts(operatorPage), ZERO_CALLS, "and the operator's page is not caught up in the crash path's cleanup");
});

// ---------------------------------------------------------------------------
// 8. a page that appears DURING the cleanup
// ---------------------------------------------------------------------------

test("a popup a bot page opens during the cleanup is classified and cleaned too", async () => {
  const world = makeWorld();
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  const spawned = {};
  const botPage = world.addPage("bot", {
    onGoto: (page) => {
      if (spawned.page) return;
      // The old document opens a popup while it is being blanked: a live,
      // unguarded page the initial page list would never see.
      spawned.page = world.addPage("late-popup", { opener: page, url: "http://127.0.0.1:9/late-popup" });
      world.emitPage(spawned.page);
    },
  });
  ownership.markOpened(botPage);
  await ownership.settle();

  await runExitCleanup(world, { ownership });

  assert.ok(spawned.page, "the popup appeared during the cleanup (the fake page's goto emitted it)");
  assert.equal(ownership.classify(spawned.page), "bot", "it is a popup of a bot page");
  assert.deepEqual(spawned.page.calls.goto, ["about:blank"], "so the cleanup re-read the pages and blanked it too");
  assert.equal(spawned.page.calls.close, 1, "… and closed it");
  assert.equal(botPage.calls.close, 1, "the page that spawned it is closed as well");
  assert.deepEqual(world.crashSends, [], "no failure, no crash");
});

// ---------------------------------------------------------------------------
// 9. lane A: a tab another CDP client drives
// ---------------------------------------------------------------------------

test("a lane-A tab (another CDP client's) is the operator's, and the bot touching it makes it the bot's", async () => {
  const world = makeWorld();
  // Lane A's own CDP client made and drives this tab: Playwright hands us a Page
  // for it (a foreign session is attached), which is not the bot's doing.
  const laneA = world.addPage("lane-a", { url: "https://example.com/an-operator-article", foreign: true });
  assert.equal(laneA.foreign, true, "the fake stands for a tab driven by a foreign CDP session");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  assert.equal(ownership.classify(laneA), "operator", "a tab that existed before the ownership attached is the operator's, whoever drives it");
  await runExitCleanup(world, { ownership });
  assert.deepEqual(callCounts(laneA), ZERO_CALLS, "the exit cleanup leaves lane A's tab exactly as it is");
  assert.equal(world.newPageCalls, 0, "and a survivor would only pile up next to it");

  // Control: the same tab, after the bot drove it, IS cleaned up.
  const controlWorld = makeWorld();
  const touchedLaneA = controlWorld.addPage("lane-a", { url: "https://example.com/an-operator-article", foreign: true });
  const controlOwnership = createPageOwnership();
  await controlOwnership.attachContext(controlWorld.context);
  controlOwnership.markTouched(touchedLaneA);
  await controlOwnership.settle();
  await runExitCleanup(controlWorld, { ownership: controlOwnership });
  assert.deepEqual(touchedLaneA.calls.goto, ["about:blank"], "once the bot drove that tab it is the bot's, and it is blanked");
  assert.equal(touchedLaneA.calls.close, 1, "… and closed");
  assert.equal(controlWorld.newPageCalls, 1, "no operator page is left, so the fresh survivor is created");
});

// ---------------------------------------------------------------------------
// 10. the MCP server's own wiring (static: the product code is where it is used)
// ---------------------------------------------------------------------------

/** The text between the bracket at `from` and its match, skipping strings and comments. */
function balanced(source, from) {
  const open = source[from];
  assert.ok(open === "{" || open === "(", `balanced() has to start on a bracket, not ${JSON.stringify(open)}`);
  const close = open === "{" ? "}" : ")";
  let depth = 0;
  let quote = null;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return source.slice(from + 1, i);
    }
  }
  assert.fail(`unbalanced ${open} at ${from} in ${SERVER_JS.pathname}`);
}

/** The body of the function whose declaration starts with `header`. */
function functionBody(source, header) {
  const at = source.indexOf(header);
  assert.notEqual(at, -1, `${header} is not in ${SERVER_JS.pathname}`);
  const brace = source.indexOf("{", at);
  assert.notEqual(brace, -1, `${header} has no body in ${SERVER_JS.pathname}`);
  return balanced(source, brace);
}

/**
 * The arguments of the first CALL of `name` in `source`.
 *
 * The marker keeps the parenthesis so an import (`blankPagesOnExit,`) is not
 * mistaken for the call: the import is the first place the name appears.
 */
function callArguments(source, name) {
  const paren = source.indexOf(`${name}(`);
  assert.notEqual(paren, -1, `${name}( is never called in ${SERVER_JS.pathname}`);
  return balanced(source, paren + name.length);
}

test("the MCP server hands the ownership in: touched pages, ownership.newPage, attachContext, and the cleanup option", () => {
  const source = readFileSync(SERVER_JS, "utf8");
  const ensure = functionBody(source, "async function ensureConnected");
  const getPage = functionBody(source, "async function getPage");

  assert.ok(
    !/context\.newPage\s*\(/.test(ensure),
    "ensureConnected's initial page has to come from the ownership (which marks it opened), not a bare context.newPage(): " +
      "a page the bot created and nobody marked is a page the exit cleanup leaves behind, unguarded",
  );
  assert.match(ensure, /\.newPage\s*\(\s*context\s*\)/, "ensureConnected makes its initial page with ownership.newPage(context)");

  const attachAt = ensure.search(/attachContext\s*\(\s*context\s*\)/);
  assert.notEqual(attachAt, -1, "ensureConnected calls ownership.attachContext(context) so the pages that appear later are classified");
  assert.ok(
    attachAt > ensure.indexOf("contexts[0]"),
    "attachContext runs on the CONNECTED context (after browser.contexts()[0]), not on a stale one",
  );

  const touchedAt = getPage.search(/markTouched\s*\(/);
  assert.notEqual(touchedAt, -1, "getPage marks the page a tool is about to drive as touched: the bot drove it");
  assert.ok(
    touchedAt > getPage.indexOf("ensureConnected("),
    "the mark comes after ensureConnected(), because the page object only exists once connected",
  );

  const cleanupArgs = callArguments(source, "blankPagesOnExit");
  assert.match(
    cleanupArgs,
    /ownership/,
    "blankPagesOnExit is handed the ownership in its options, so the exit cleanup cleans only the bot's pages and never the operator's",
  );
});

// ---------------------------------------------------------------------------
// 11. the three fail-open holes (F1–F3)
//
// An automated review found three ways the ownership leaves a BOT page proving
// nothing and therefore running unguarded after the exit:
//
//   F1  a popup whose opener closes first: the popup's `opener()` answers null (or
//       throws) because the opener TAB is gone, so the page lands in `uncertain`
//       and is left alone. The fix: (a) a synchronous `page.on("popup", …)` listener
//       on every bot page marks its popups bot the moment they are emitted, and
//       (b) an arrival whose `opener()` says nothing is asked of the browser
//       itself (`Target.getTargetInfo` → `openerId`) and fails closed when the
//       ownership owns a bot page.
//   F2  a reconnect while a bot mark's target id is still unresolved: nothing can be
//       matched by id, so the bot's own tabs come back as the operator's. The fix:
//       the ownership counts bot marks whose id it could not resolve, and a later
//       `attachContext` fails closed on every page no remembered id claims.
//   F3  the budget: an exit that runs out while a classification is still in flight
//       (or with a bot page already known) still has bot pages that were never
//       blanked, so it must crash the browser instead of leaving them armed.
//
// The rule that reconciles all three with "operator tabs are never destroyed": the
// fail-closed default applies only to a page that COULD be the bot's. A page proven
// to be the operator's, or an independent tab provably nobody's popup (no opener at
// all: another CDP client's `Target.createTarget`, the operator's own Ctrl+T), is
// still left alone.
//
// These cases are RED as written: they pin the contract above, and today's
// page-ownership.js / private-address.js do not implement it yet. Every "is the
// bot's" comes with the control that is NOT the bot's, so a fail-closed rule cannot
// pass by making everything the bot's.
// ---------------------------------------------------------------------------

/**
 * A fake page that can carry Playwright's synchronous `popup` listener.
 *
 * `popupListeners` records who registered, so "every bot page gets exactly one
 * listener, synchronously, no await" is a number and not an impression;
 * `emitPopup(page)` is what a real context does the moment `window.open` runs.
 */
function popupCapable(page) {
  const bus = new EventEmitter();
  page.popupListeners = [];
  page.on = (event, handler) => {
    if (event === "popup") page.popupListeners.push(handler);
    bus.on(event, handler);
    return page;
  };
  page.emitPopup = (popup) => bus.emit("popup", popup);
  return page;
}

/**
 * A world whose CDP `Target.getTargetInfo` can answer `openerId` and can FAIL —
 * the evidence F1(b) makes the ownership ask for when `page.opener()` says
 * nothing. `delayMs` makes the lookup a real round trip (F2), `throwFor` makes it
 * unresolvable for one page.
 */
function worldWithTargetInfo(options = {}) {
  const world = makeWorld();
  const base = world.context.newCDPSession.bind(world.context);
  world.context.newCDPSession = async (page) => {
    if (typeof options.throwFor === "function" && options.throwFor(page)) {
      throw new Error(`no CDP session for ${page && page.name}`);
    }
    if (Number.isFinite(options.delayMs) && options.delayMs > 0) {
      await new Promise((r) => setTimeout(r, options.delayMs));
    }
    const session = await base(page);
    const send = session.send.bind(session);
    session.send = async (method, params) => {
      const answer = await send(method, params);
      if (method !== "Target.getTargetInfo") return answer;
      const openerId = typeof options.openerIdFor === "function" ? options.openerIdFor(page) : undefined;
      const info = { ...((answer && answer.targetInfo) || {}) };
      if (openerId) info.openerId = openerId;
      return { targetInfo: info };
    };
    return session;
  };
  return world;
}

// F1(a): the synchronous `popup` listener on every bot page.
test("F1a: a popup emitted on a bot page is the bot's immediately, even when its opener() answers null", async () => {
  const world = makeWorld();
  const botPage = popupCapable(world.addPage("bot"));
  // FIX3's window is short here and stepped over before the independent arrival below:
  // this case is about the popup listener, not about the bot-action window.
  const ownership = createPageOwnership({ botActionWindowMs: 100 });
  await ownership.attachContext(world.context);

  ownership.markOpened(botPage);
  ownership.markTouched(botPage); // a second mark must not add a second listener
  await ownership.settle();
  assert.equal(botPage.popupListeners.length, 1, "a page marked bot carries exactly one `popup` listener, installed synchronously");

  // The popup whose opener TAB is already gone by the time anything looks: its
  // `opener()` answers null. This is the case the context's own "page" event cannot
  // rescue (there is nothing to follow), and the listener has to.
  const popup = world.addPage("popup-of-bot");
  assert.equal(popup.openerPage, null, "the fake popup has no opener to report — the opener tab closed first");
  botPage.emitPopup(popup);
  // ASSERTED BEFORE ANY AWAIT: the mark has to land in the emit itself.
  assert.equal(
    ownership.classify(popup),
    "bot",
    "a popup emitted on a bot page is the bot's the moment it is emitted, with no await in between — the opener tab may be closed before any lookup answers",
  );

  // The context's own "page" event arrives afterwards (the usual order for a real
  // Playwright context) and its classification must not take the page back.
  world.emitPage(popup);
  await ownership.settle();
  assert.equal(ownership.classify(popup), "bot", "the later arrival classification finds no opener and leaves the bot's popup the bot's");

  // CONTROL: an independent tab that nobody emitted a popup for, in the SAME
  // ownership (which owns a bot page): no opener, no openerId — nobody's popup. It
  // arrives LATE (past the short bot-action window), so FIX3's window does not claim it.
  await later(250);
  const independent = world.addPage("independent-tab");
  world.emitPage(independent);
  await ownership.settle();
  assert.equal(
    ownership.classify(independent),
    "uncertain",
    "CONTROL: an arrival with no popup event and no openerId is an independent tab and stays 'uncertain' — left alone, never closed on suspicion",
  );
});

// F1(b): the CDP `openerId` evidence, for an arrival whose `opener()` says nothing.
test("F1b: an arrival with no opener() is asked for its CDP openerId, and fails closed when a bot page is owned", async () => {
  // The CONTROLS run first, so a control that is wrong is reported instead of being
  // hidden behind the red assertion below.
  //
  // (b) the same arrival, same ownership, and the browser says there is NO
  //     openerId: an independent tab (another CDP client's createTarget, the
  //     operator's Ctrl+T), which is never made the bot's by this path. The arrival is
  //     LATE (past the short bot-action window), which is what keeps FIX3's window out
  //     of this case: it is the no-openerId discriminator, nothing else.
  {
    const world = worldWithTargetInfo();
    const botPage = world.addPage("bot");
    const ownership = createPageOwnership({ botActionWindowMs: 100 });
    await ownership.attachContext(world.context);
    ownership.markOpened(botPage);
    await ownership.settle();
    await later(250);

    const arrival = world.addPage("arrival");
    world.emitPage(arrival);
    await ownership.settle();
    assert.equal(
      ownership.classify(arrival),
      "uncertain",
      "CONTROL: an arrival with no openerId is an independent tab and stays 'uncertain', even though the ownership owns a bot page",
    );
  }

  // (c) CONTROL: openerId is set, but the ownership owns nothing at all — no bot
  //     mark exists, so nothing can be attributed to the bot and the page is not
  //     made the bot's.
  {
    const world = worldWithTargetInfo({ openerIdFor: () => "target-opener-Y" });
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);

    const arrival = world.addPage("arrival");
    world.emitPage(arrival);
    await ownership.settle();
    const decided = ownership.classify(arrival);
    assert.notEqual(decided, "bot", "CONTROL: with no bot mark at all, a popup-shaped arrival is never made the bot's");
    assert.ok(
      decided === "uncertain" || decided === "operator",
      `CONTROL: and it is left alone ('operator' or 'uncertain'), not failed closed (classified ${decided})`,
    );
  }

  // (a) openerId is set and the ownership owns a bot page: BOT. Nothing can prove
  //     this page is the operator's, so it is not left running unguarded after the
  //     exit — this is the finding.
  {
    const world = worldWithTargetInfo({ openerIdFor: (page) => (page && page.name === "arrival" ? "target-opener-X" : undefined) });
    // The bot page carries the very target id the arrival's openerId names, so the
    // openerId points at a REMEMBERED bot tab: that is BOT on its own (an openerId
    // that resolves to no live operator page is BOT too — see A4's rewritten case).
    const botPage = world.addPage("bot", { targetId: "target-opener-X" });
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    ownership.markOpened(botPage);
    await ownership.settle();

    const arrival = world.addPage("arrival");
    world.emitPage(arrival);
    await ownership.settle();
    assert.equal(
      ownership.classify(arrival),
      "bot",
      "an arrival whose opener() is null but whose CDP target names an openerId, while a bot page is owned, is BOT (fail closed)",
    );
  }

  // (d) the CDP lookup itself throws, and a bot page is owned: BOT, because a page
  //     that cannot be proven the operator's must not keep running unguarded.
  {
    const world = worldWithTargetInfo({ throwFor: (page) => page && page.name === "arrival" });
    const botPage = world.addPage("bot");
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    ownership.markOpened(botPage);
    await ownership.settle();

    const arrival = world.addPage("arrival");
    world.emitPage(arrival);
    await ownership.settle();
    assert.equal(
      ownership.classify(arrival),
      "bot",
      "an arrival whose opener lookup THROWS while a bot page is owned is BOT (fail closed), not an exception and not 'uncertain'",
    );
  }
});

// F1(b), the CONTROL half of the throwing lookup, on its own so it is measured even
// while the case above is red: nothing owned means a throwing lookup proves nothing.
test("F1b control: the same throwing lookup with nothing of the bot's owned leaves the page uncertain", async () => {
  // (e) the lookup throws and the ownership owns nothing: 'uncertain', and the
  //     throw never escapes.
  {
    const world = worldWithTargetInfo({ throwFor: (page) => page && page.name === "arrival" });
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);

    const arrival = world.addPage("arrival");
    world.emitPage(arrival);
    await ownership.settle();
    assert.equal(
      ownership.classify(arrival),
      "uncertain",
      "CONTROL: the same throwing lookup with nothing of the bot's owned leaves the page 'uncertain' — a classification failure is not evidence",
    );
  }
});

// F2(a): the mark's lookup is returned, and `ownership.newPage` awaits its own.
test("F2: markTouched returns its target-id lookup, and ownership.newPage awaits it, so an immediate reconnect matches", async () => {
  const world = worldWithTargetInfo({ delayMs: 40 });
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  const marked = world.addPage("marked", { targetId: "target-marked" });
  const returned = ownership.markTouched(marked);
  assert.equal(ownership.classify(marked), "bot", "the mark itself is still synchronous");
  assert.ok(
    returned && typeof returned.then === "function",
    "markTouched returns the promise of its target-id lookup, so a caller CAN wait for it (ignoring it stays allowed)",
  );

  // The page the bot creates next: its id is resolved by a lookup that takes a real
  // round trip (40 ms). `newPage` has to await it before it returns.
  const created = await ownership.newPage(world.context);
  await returned; // the other lookup, already in flight: not what this case is about

  // A reconnect IMMEDIATELY: no settle() in between, exactly what a crashed-and-
  // reconnected MCP process does. The ids are already stored, so it matches.
  const second = worldWithTargetInfo({ delayMs: 40 });
  const rebornCreated = second.addPage("reborn-created", { targetId: created.targetId });
  const stranger = second.addPage("stranger", { targetId: "target-stranger" });
  await ownership.attachContext(second.context);

  assert.equal(
    ownership.classify(rebornCreated),
    "bot",
    "ownership.newPage resolved only after its target id was stored, so an immediate reconnect claims the page it created (same target id)",
  );
  assert.equal(ownership.classify(stranger), "operator", "CONTROL: a page no remembered id claims is still not claimed");
  await ownership.settle();
});

// F2(b): a reconnect while a bot mark's id could not be resolved fails closed.
test("F2: a reconnect with an unresolvable bot id makes the unmatched pages the bot's, and the cleanup blanks and closes them", async () => {
  // The bot page's own target id cannot be had: the CDP lookup throws for it.
  const first = worldWithTargetInfo({ throwFor: (page) => Boolean(page) && page.name === "bot-unresolvable" });
  const botPage = first.addPage("bot-unresolvable");
  const ownership = createPageOwnership();
  await ownership.attachContext(first.context);
  ownership.markOpened(botPage);
  await ownership.settle();
  assert.equal(ownership.classify(botPage), "bot", "the mark itself never depends on the lookup");

  // The reconnect: a new context, new Page objects for the same tabs — and nothing
  // in it can be matched, because the bot's id was never resolved. Whose pages
  // these are is therefore unprovable, which means they could be the bot's.
  const second = worldWithTargetInfo();
  const unmatchedA = second.addPage("unmatched-a", { targetId: "target-a" });
  const unmatchedB = second.addPage("unmatched-b", { targetId: "target-b" });
  await ownership.attachContext(second.context);
  assert.equal(
    ownership.classify(unmatchedA),
    "bot",
    "with an unresolved bot id, a page no remembered id matches is BOT: the ownership cannot prove it is NOT the bot's (fail closed)",
  );
  assert.equal(ownership.classify(unmatchedB), "bot", "…every unmatched page, not just the first");

  await runExitCleanup(second, { ownership });
  assert.deepEqual(unmatchedA.calls.goto, ["about:blank"], "the cleanup blanks the fail-closed page before it closes it");
  assert.equal(unmatchedA.calls.close, 1, "…and closes it");
  assert.deepEqual(unmatchedB.calls.goto, ["about:blank"], "the other unmatched page is blanked too");
  assert.equal(unmatchedB.calls.close, 1, "…and closed");
  assert.deepEqual(second.crashSends, [], "nothing failed, so nothing is crashed");
});

// F2(b) CONTROL, in its own case so it is measured while the case above is red:
// every id resolved means an unmatched page is the operator's, as today.
const touchCounts = (page) => ({
  goto: page.calls.goto.length,
  close: page.calls.close,
  isClosed: page.calls.isClosed,
  newCDPSession: page.calls.newCDPSession,
});

test("F2 control: with every bot id resolved, the same unmatched pages are the operator's and are never touched", async () => {
  const firstOk = worldWithTargetInfo();
  const botOk = firstOk.addPage("bot-resolvable", { targetId: "target-bot-ok" });
  const control = createPageOwnership();
  await control.attachContext(firstOk.context);
  control.markOpened(botOk);
  await control.settle();

  const secondOk = worldWithTargetInfo();
  const stranger = secondOk.addPage("stranger", { targetId: "target-stranger-ok" });
  await control.attachContext(secondOk.context);
  assert.equal(
    control.classify(stranger),
    "operator",
    "CONTROL: when every bot id resolved, a page no id claims is the operator's (today's behaviour, unchanged)",
  );
  const controlBaseline = touchCounts(stranger);

  await runExitCleanup(secondOk, { ownership: control });
  // The page's own counters are snapshotted AFTER the reconnect: `attachContext`
  // itself asks the browser for target ids (that is how it proves ownership), and
  // those sessions are not the cleanup touching the tab.
  assert.deepEqual(
    touchCounts(stranger),
    controlBaseline,
    "CONTROL: the cleanup never navigates, closes, probes or attaches a session to it",
  );
  assert.equal(secondOk.newPageCalls, 0, "CONTROL: an operator page remains, so no survivor is made");
});

// F3: `pending()`, and the budget that expires while a classification is in flight.
test("F3: the ownership reports pending() while a classification is still in flight", async () => {
  const world = makeWorld();
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  assert.equal(typeof ownership.pending, "function", "the ownership exposes pending(): whether any classification/lookup is in flight");
  assert.equal(ownership.pending(), false, "nothing is in flight yet, so pending() is false");

  // An arrival whose opener() never answers: a classification in flight forever,
  // i.e. exactly what a lookup against a closing browser looks like.
  const stuck = world.addPage("stuck-arrival");
  stuck.opener = () => new Promise(() => {});
  world.emitPage(stuck);
  await new Promise((r) => setTimeout(r, 20)); // the arrival registers itself

  assert.equal(ownership.pending(), true, "the never-answering opener() keeps a classification in flight, so pending() is true");
});

test("F3: a budget that expires with a classification still in flight crashes the browser instead of leaving it armed", async () => {
  const world = makeWorld();
  const real = createPageOwnership();
  await real.attachContext(world.context);

  // A classification that never finishes: the settle below never answers, and the
  // ownership reports the work as pending (F3's own case pins `pending()` itself).
  const ownership = { ...real, settle: () => new Promise(() => {}), pending: () => true };

  const lines = await withConsoleError(() => runExitCleanup(world, { ownership, budgetMs: 60 }));
  assert.deepEqual(
    world.crashSends,
    ["Browser.crash"],
    "a budget that expires with work pending fails closed: a page whose owner was never decided may be the bot's and armed, so the browser is crashed once",
  );
  assert.ok(
    lines.some((line) => /budget/i.test(line)),
    `one console.error line says the cleanup ran out of its budget (lines: ${JSON.stringify(lines)})`,
  );
});

test("F3 control: a budget that expires with nothing pending and no bot page crashes nothing", async () => {
  // (a) The real ownership, nothing in flight: the cleanup finishes inside the
  //     budget, and nothing is crashed.
  const world = makeWorld();
  world.addPage("operator-1");
  world.addPage("operator-2");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  assert.equal(typeof ownership.pending === "function" ? ownership.pending() : false, false, "nothing in flight, so pending() is false");

  const lines = await withConsoleError(() => runExitCleanup(world, { ownership, budgetMs: 60 }));
  assert.deepEqual(world.crashSends, [], "CONTROL: nothing of the bot's is known and nothing is pending — there is nothing to fail closed about");
  assert.deepEqual(lines.filter((line) => /budget/i.test(line)), [], `CONTROL: no budget line either (lines: ${JSON.stringify(lines)})`);

  // (b) The budget path itself, with nothing pending and no bot page: the settle
  //     never answers, so the budget really does expire, and it must still crash
  //     nothing — the operator's tabs are not destroyed for nothing.
  const quietWorld = makeWorld();
  quietWorld.addPage("operator");
  const quietOwnership = {
    classify: () => "operator",
    settle: () => new Promise(() => {}),
    pending: () => false,
  };
  const quietLines = await withConsoleError(() => runExitCleanup(quietWorld, { ownership: quietOwnership, budgetMs: 60 }));
  assert.deepEqual(
    quietWorld.crashSends,
    [],
    "CONTROL: the budget expired with nothing pending and no bot page, so the browser is NOT crashed",
  );
  assert.deepEqual(
    quietLines.filter((line) => /budget/i.test(line)),
    [],
    `CONTROL: and no budget line is written either (lines: ${JSON.stringify(quietLines)})`,
  );
});

// ---------------------------------------------------------------------------
// 12. contract round 6: the adoption, the stuck session opening, two servers in
// one process, a failed id lookup, and the reconnect gap
//
// Five more holes an automated review found, each pinned here next to the control
// that keeps it honest. As written they are RED against the product code at HEAD:
// the failure is the bug report, and the control says which half is missing.
//
//   T15-1  ensureConnected adopts `pages[0]` unconditionally, so the operator's own
//          open tab is the tab the bot drives by default.
//   T15-2  the budget's fail-closed branch was gated on a flag only ever set AFTER
//          the browser session opened, so a session that never opens (a hung CDP
//          call) swallows the budget entirely: no line, no crash, pages armed.
//   T15-3  exitRegistrations keeps ONE ownership per proc, so a second server in the
//          same process REPLACES the first one's — the first server's bot page is
//          never cleaned up.
//   T15-4  a bot mark whose target-id lookup failed is remembered as "resolved to
//          null", so it is never retried and a later reconnect fails closed on
//          every tab instead of matching the bot's by id.
//   T15-5  the "page" listener is installed AFTER attachContext's id lookups, so a
//          page that appears during them is classified by nobody at all — and an
//          unclassified page is treated as the operator's.
// ---------------------------------------------------------------------------

/**
 * The source with its COMMENTS removed (strings kept, they are the evidence).
 *
 * A comment must never be able to satisfy a source assertion: the header comment of
 * the very function being checked talks about "about:blank" and "the adopted page 0".
 */
function stripComments(source) {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      if (nl === -1) break;
      out += "\n";
      i = nl;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      for (i += 1; i < source.length; i++) {
        out += source[i];
        if (source[i] === "\\") {
          i += 1;
          if (i < source.length) out += source[i];
          continue;
        }
        if (source[i] === quote) break;
      }
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * What is wrong with one ensureConnected adoption region, as a list of reasons.
 *
 * `[]` is the contract: the first page is adopted only when its url is EXACTLY
 * "about:blank", every other first page is left alone, and the page the bot then
 * drives is made through `ownership.newPage(context)` (which marks it opened).
 */
function adoptionProblems(region) {
  const code = stripComments(region);
  const problems = [];
  if (!code.includes("about:blank")) {
    problems.push('the adoption never compares the first page\'s url with exactly "about:blank"');
  }
  if (!/ownership\.newPage\s*\(\s*context\s*\)/.test(code)) {
    problems.push("the adoption never falls back to ownership.newPage(context)");
  }
  if (/(^|[^.\w])page\s*=\s*pages\s*\[\s*0\s*\]/.test(code)) {
    problems.push("page is assigned pages[0] outright, whoever owns that tab");
  }
  return problems;
}

// T15-1: the operator's open tab is never the tab the bot drives by default.
test("T15-1: ensureConnected adopts the first page only when it is exactly about:blank", () => {
  const source = readFileSync(SERVER_JS, "utf8");
  const ensure = functionBody(source, "async function ensureConnected");
  const pagesAt = ensure.indexOf("context.pages()");
  assert.notEqual(pagesAt, -1, "ensureConnected reads context.pages()");
  const sessionAt = ensure.indexOf("newCDPSession", pagesAt);
  assert.notEqual(sessionAt, -1, "…and opens its CDP session on the page it chose, after choosing it");

  const region = ensure.slice(pagesAt, sessionAt);
  assert.notEqual(
    region.indexOf("ownership.newPage"),
    -1,
    "the adoption lives between `context.pages()` and the CDP session, and it has to go through the ownership " +
      `(region: ${JSON.stringify(region.slice(0, 600))})`,
  );
  assert.deepEqual(
    adoptionProblems(region),
    [],
    "ensureConnected must adopt pages[0] only when its url is exactly about:blank, and otherwise make the bot's " +
      `own page through ownership.newPage(context) — the operator's open tab is never driven by default ` +
      `(region: ${JSON.stringify(region.slice(0, 600))})`,
  );

  // CONTROL: the check is not vacuous. The shape at HEAD fails it — pages[0] is
  // adopted outright, with no url test and no ownership fallback — and the shape the
  // contract asks for passes it.
  const head = "page = pages[0] || await ownership.newPage(context);";
  assert.ok(
    adoptionProblems(head).length > 0,
    `CONTROL: the adoption shape at HEAD must fail the check (${JSON.stringify(adoptionProblems(head))})`,
  );
  const wanted = [
    "const first = pages[0];",
    'page = first && first.url() === "about:blank" ? first : await ownership.newPage(context);',
  ].join("\n");
  assert.deepEqual(
    adoptionProblems(wanted),
    [],
    `CONTROL: the adoption the contract asks for must pass the check (${JSON.stringify(adoptionProblems(wanted))})`,
  );
});

// T15-2: the budget can expire while `newBrowserCDPSession()` is still pending.
test("T15-2: a budget that expires while the browser session is still opening still fails closed", async () => {
  // THE CASE: a bot page is known and the session opening never answers, so the
  // cleanup never reaches the page reading that used to set the "bot work" flag.
  // The budget that expires then has bot pages armed behind it: one console.error
  // line has to say so, and with no session ever arriving the give-up line follows.
  const world = makeWorld();
  const operatorPage = world.addPage("operator");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  const botPage = world.addPage("bot");
  ownership.markTouched(botPage);
  await ownership.settle();
  assert.equal(ownership.classify(botPage), "bot", "the bot's page is known before the cleanup runs");

  // The browser-level session the crash needs NEVER opens: it is the cleanup's own
  // first await, so the budget expires while it is pending.
  world.context.browser = () => ({ newBrowserCDPSession: () => new Promise(() => {}) });

  const lines = await withConsoleError(() => runExitCleanup(world, { ownership, budgetMs: 50 }));

  assert.ok(
    lines.some((line) => /budget/i.test(line)),
    "a budget that expires with a bot page known must still write its one console.error line, even when the " +
      `browser session never opened (lines: ${JSON.stringify(lines)})`,
  );
  assert.ok(
    lines.some((line) => /could not crash/i.test(line)),
    "and with no session ever arriving, the give-up line follows the budget line: the browser could not be " +
      `crashed (lines: ${JSON.stringify(lines)})`,
  );
  assert.deepEqual(
    world.crashSends,
    [],
    "no Browser.crash can be sent: the session that would carry it never arrived (the give-up line is the record of it)",
  );

  // CONTROL: the same hanging session, the same budget, and nothing of the bot's —
  // no bot page, nothing pending. Nothing is navigated or armed, so the budget path
  // must write no line and crash nothing: the operator's tabs are not destroyed for
  // nothing.
  const quiet = makeWorld();
  const quietOne = quiet.addPage("operator-1");
  const quietTwo = quiet.addPage("operator-2");
  const quietOwnership = createPageOwnership();
  await quietOwnership.attachContext(quiet.context);
  quiet.context.browser = () => ({ newBrowserCDPSession: () => new Promise(() => {}) });

  const quietLines = await withConsoleError(() => runExitCleanup(quiet, { ownership: quietOwnership, budgetMs: 50 }));
  assert.deepEqual(
    quietLines.filter((line) => /budget/i.test(line)),
    [],
    `CONTROL: nothing of the bot's is known, so the budget writes no budget line (lines: ${JSON.stringify(quietLines)})`,
  );
  assert.deepEqual(
    quietLines.filter((line) => /could not crash/i.test(line)),
    [],
    `CONTROL: and no give-up line either (lines: ${JSON.stringify(quietLines)})`,
  );
  assert.deepEqual(quiet.crashSends, [], "CONTROL: and nothing is crashed");
  assert.deepEqual(callCounts(quietOne), ZERO_CALLS, "CONTROL: the operator's pages are not navigated, closed or attached");
  assert.deepEqual(callCounts(quietTwo), ZERO_CALLS, "CONTROL: nor the other one");
});

// T15-3: two MCP servers in one process share the proc, not each other's ownership.
test("T15-3: two ownerships on one proc are both cleaned up, and the proc's listeners do not double", async () => {
  /** One server's world: an operator tab that existed first, then a bot page. */
  const serverRun = async (label) => {
    const world = makeWorld();
    const operatorPage = world.addPage(`operator-${label}`);
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    const botPage = world.addPage(`bot-${label}`);
    ownership.markTouched(botPage);
    await ownership.settle();
    assert.equal(ownership.classify(botPage), "bot", `${label}: the bot's page is known before the cleanup`);
    return { world, ownership, operatorPage, botPage };
  };

  const first = await serverRun("a");
  const second = await serverRun("b");

  const proc = new EventEmitter();
  proc.stdin = new EventEmitter();
  const procEvents = ["SIGTERM", "SIGINT", "beforeExit"];
  const stdinEvents = ["close", "end"];
  const listenerCounts = () => ({
    proc: procEvents.map((event) => proc.listenerCount(event)),
    stdin: stdinEvents.map((event) => proc.stdin.listenerCount(event)),
  });

  const runFirst = blankPagesOnExit(() => first.world.context, { proc, ownership: first.ownership, budgetMs: 2000 });
  const afterFirst = listenerCounts();
  const runSecond = blankPagesOnExit(() => second.world.context, { proc, ownership: second.ownership, budgetMs: 2000 });
  const afterSecond = listenerCounts();

  assert.deepEqual(
    afterFirst,
    { proc: [1, 1, 1], stdin: [1, 1] },
    `one registration per proc: one listener per exit event (saw ${JSON.stringify(afterFirst)})`,
  );
  assert.deepEqual(
    afterSecond,
    afterFirst,
    `a second server in the same process must not double the proc's exit listeners (before ${JSON.stringify(afterFirst)}, ` +
      `after ${JSON.stringify(afterSecond)})`,
  );
  assert.equal(runSecond, runFirst, "both calls are handed the same one cleanup back");

  proc.stdin.emit("close");
  await runFirst();

  assert.deepEqual(
    first.botPage.calls.goto,
    ["about:blank"],
    "running the cleanup once blanks the FIRST server's bot page too: a second ownership must not replace the " +
      "first one's (the page would be left running unguarded after the exit)",
  );
  assert.equal(first.botPage.calls.close, 1, "…and closes it");
  assert.deepEqual(second.botPage.calls.goto, ["about:blank"], "…as well as the SECOND server's bot page");
  assert.equal(second.botPage.calls.close, 1, "…and closes it");
  assert.deepEqual(callCounts(first.operatorPage), ZERO_CALLS, "the first operator's tab is not touched at all");
  assert.deepEqual(callCounts(second.operatorPage), ZERO_CALLS, "nor the second operator's tab");
  assert.deepEqual(first.world.crashSends, [], "nothing failed in the first server's browser, so nothing is crashed");
  assert.deepEqual(second.world.crashSends, [], "nor in the second");

  // CONTROL: the same harness with ONE ownership — the case above is not just "the
  // cleanup is broken in general". One call, one ownership: its bot page is cleaned
  // up, its operator's tab is not, and the proc carries one listener per event.
  const control = await serverRun("control");
  const controlProc = new EventEmitter();
  controlProc.stdin = new EventEmitter();
  const controlRun = blankPagesOnExit(() => control.world.context, {
    proc: controlProc,
    ownership: control.ownership,
    budgetMs: 2000,
  });
  assert.deepEqual(
    {
      proc: procEvents.map((event) => controlProc.listenerCount(event)),
      stdin: stdinEvents.map((event) => controlProc.stdin.listenerCount(event)),
    },
    { proc: [1, 1, 1], stdin: [1, 1] },
    "CONTROL: one ownership registers exactly one listener per exit event",
  );
  controlProc.stdin.emit("close");
  await controlRun();
  assert.deepEqual(control.botPage.calls.goto, ["about:blank"], "CONTROL: the one ownership's bot page is blanked");
  assert.equal(control.botPage.calls.close, 1, "CONTROL: …and closed");
  assert.deepEqual(callCounts(control.operatorPage), ZERO_CALLS, "CONTROL: its operator's tab is left alone");
});

// T15-4: a target-id lookup that failed is retried by the next mark.
test("T15-4: a failed target-id lookup is retried by the next mark, and a successful one is never repeated", async () => {
  // CONTROL FIRST: a lookup that answered the first time is not repeated. One mark,
  // one CDP session through the page's context; a second mark adds none.
  {
    const world = worldWithTargetInfo();
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    const control = world.addPage("bot-control", { targetId: "target-control" });
    await ownership.markTouched(control);
    const afterFirstMark = world.cdpSessions;
    await ownership.markTouched(control);
    assert.equal(
      afterFirstMark,
      1,
      `CONTROL: the first mark resolves the id with exactly one lookup (saw ${afterFirstMark})`,
    );
    assert.equal(
      world.cdpSessions,
      afterFirstMark,
      "CONTROL: a mark whose id was already resolved opens no second CDP session",
    );
  }

  // THE CASE: the first lookup fails (the fake CDP session refuses this page once),
  // so the mark's id could not be resolved. The next mark has to try again.
  let attempts = 0;
  const world = worldWithTargetInfo({
    throwFor: (page) => {
      if (!page || page.name !== "bot-retry") return false;
      attempts += 1;
      return attempts === 1;
    },
  });
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  const retried = world.addPage("bot-retry", { targetId: "target-retry" });
  await ownership.markTouched(retried);
  assert.equal(attempts, 1, "the first lookup really failed (the fake session refused it once)");
  assert.equal(ownership.classify(retried), "bot", "the mark itself never depends on the lookup");

  await ownership.markTouched(retried);
  assert.ok(
    attempts >= 2,
    "a mark whose target-id lookup failed is remembered as unresolved today, so the page is never retried — " +
      `the next mark has to look again (lookups attempted: ${attempts})`,
  );
  await ownership.settle();

  // Observed through a RECONNECT: the id the retry resolved is what claims the tab.
  // The stranger is the control — with the id resolved, an unmatched tab is still
  // the operator's, so "matched by id" is distinguishable from "failed closed".
  const second = worldWithTargetInfo();
  const reborn = second.addPage("reborn", { targetId: "target-retry" });
  const stranger = second.addPage("stranger", { targetId: "target-stranger" });
  await ownership.attachContext(second.context);
  assert.equal(
    ownership.classify(reborn),
    "bot",
    "the target id the retry resolved is remembered, so a reconnect claims the bot's tab by id",
  );
  assert.equal(
    ownership.classify(stranger),
    "operator",
    "CONTROL: and the reconnect is not failing closed — a tab no remembered id claims is still the operator's",
  );
  await ownership.settle();
});

// T15-5: the reconnect gap — a page emitted while attachContext is still resolving ids.
test("T15-5: a page emitted while attachContext is still resolving ids is classified through the arrival path", async () => {
  /** A reconnect: a new context whose Page objects carry the bot's own target id. */
  const reconnectWorld = () => worldWithTargetInfo({ delayMs: 40 });

  // CONTROL FIRST: the same event, emitted AFTER attachContext returned.
  {
    const first = makeWorld();
    const firstBot = first.addPage("bot", { targetId: "target-bot" });
    const ownership = createPageOwnership();
    await ownership.attachContext(first.context);
    ownership.markOpened(firstBot);
    await ownership.settle();

    const second = reconnectWorld();
    const reconnectedBot = second.addPage("bot", { targetId: "target-bot" });
    await ownership.attachContext(second.context);
    assert.equal(ownership.classify(reconnectedBot), "bot", "the reconnect claimed the bot's tab by its target id");

    const popup = second.addPage("popup", { opener: reconnectedBot });
    second.emitPage(popup);
    await ownership.settle();
    assert.equal(
      ownership.classify(popup),
      "bot",
      "CONTROL: a popup of the matched bot page, emitted after attachContext returned, is the bot's",
    );
  }

  // THE CASE: the same event, emitted while attachContext is still waiting for the
  // id lookups it started (the fake's `newCDPSession` takes a real round trip).
  const first = makeWorld();
  const firstBot = first.addPage("bot", { targetId: "target-bot" });
  const ownership = createPageOwnership();
  await ownership.attachContext(first.context);
  ownership.markOpened(firstBot);
  await ownership.settle();

  const second = reconnectWorld();
  const reconnectedBot = second.addPage("bot", { targetId: "target-bot" });
  const attaching = ownership.attachContext(second.context);
  // Still mid-lookup: attachContext has suspended on its claiming promises.
  const popup = second.addPage("popup-during-attach", { opener: reconnectedBot });
  second.emitPage(popup);
  await attaching;
  await ownership.settle();

  assert.equal(
    ownership.classify(popup),
    "bot",
    "a page emitted WHILE attachContext is still resolving its ids is classified through the arrival path — a " +
      "popup of the matched bot page is the bot's, not left at the operator default (which is what an " +
      `unclassified page is treated as; it classified ${ownership.classify(popup)})`,
  );
});

// ---------------------------------------------------------------------------
// 13. contract round 7 (T17)
//
// Six more holes and one registration bug an automated review found. Each case is
// pinned next to the control that keeps it honest, so a fail-closed rule cannot
// pass by making everything the bot's.
//
//   A1  a bot mark whose target id could not be resolved is remembered as
//       unresolved and nothing ever takes it back out: a page that CLOSES (with
//       the browser still connected) leaves its unresolved count behind, so every
//       later reconnect fails closed on every tab of the operator's forever.
//   A2  a reconnect CLAIM whose target-info lookup FAILS (`ok: false`, not "no
//       id") is read as "no id matched" and the page is called the operator's,
//       although nothing was proven about it.
//   A3  `opener()` and the CDP target-info requests are unbounded: a session that
//       stops answering hangs `attachContext()` and `settle()` for good.
//   A4  rule 2 fails closed on any `openerId`, so an OPERATOR popup whose operator
//       opener tab closed first is taken away from the operator — the one thing
//       this whole change exists to prevent. It is narrowed: an `openerId` that
//       names no remembered bot target, with nothing unresolved and nothing still
//       being looked up, is the operator's.
//   A5  only `markBot` installs the synchronous `popup` listener; a page classed
//       BOT by the arrival or the reconnect path carries none, so its own popups
//       are classified from `opener()`/`openerId` alone.
//   A6  the exit cleanup's budget treats PENDING classification work as bot work
//       (`ownership.pending()`), so a budget that expires while an OPERATOR
//       arrival's `opener()` is in flight crashes the whole browser, destroying
//       the operator's tabs to fail closed about nothing of the bot's.
//   M3  `blankPagesOnExit` matches a re-registration by ownership OR by getter, so
//       two servers that share one getter (or two legacy registrations, both with
//       no ownership at all) are merged into ONE pair: the first server's bot page
//       is never cleaned up.
//
// SUPERSEDED for A1 and A4 (contract round 8 / T19, section 14): the release of an
// unresolved mark on close (A1) and rule 2's `nothingLeftToDecide()` narrowing (A4)
// are REMOVED by the simplified fail-closed rule. The two cases below are REWRITTEN
// to pin the new rule where the old one used to be asserted; the rest of round 7
// (A2, A3, A5, A6, M3) is unchanged.
// ---------------------------------------------------------------------------

/** Resolve after `ms`: a real round trip, and a ceiling nothing else depends on. */
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `work()` raced against a ceiling.
 *
 * Returns `{ outcome, elapsed }` where outcome is "done", "threw" or "ceiling",
 * so a lookup that never answers is an assertion instead of a suite that hangs.
 */
async function timed(work, ceilingMs = 3500) {
  const started = Date.now();
  let timer = null;
  const ceiling = new Promise((resolve) => {
    timer = setTimeout(() => resolve("ceiling"), ceilingMs);
  });
  let outcome;
  try {
    outcome = await Promise.race([
      Promise.resolve().then(work).then(() => "done", () => "threw"),
      ceiling,
    ]);
  } finally {
    clearTimeout(timer);
  }
  return { outcome, elapsed: Date.now() - started };
}

/**
 * A fake page that can carry Playwright's page events and COUNT its listeners.
 *
 * A5 is about "exactly one `popup` listener per bot page", so the count is a
 * number here and not an impression: `listenerCount("popup")` is what the test
 * asserts, and `emitEvent` is what a real Playwright page does on close.
 */
function pageWithEvents(page) {
  const bus = new EventEmitter();
  page.on = (event, handler) => {
    bus.on(event, handler);
    return page;
  };
  page.listenerCount = (event) => bus.listenerCount(event);
  page.emitEvent = (event, arg) => bus.emit(event, arg);
  return page;
}

/**
 * Replace a fake page's `page.context()` with a controllable one.
 *
 * A real Playwright Page offers both things these cases need from it: a browser
 * (`page.context().browser().isConnected()` — was the browser still connected when
 * the page closed?) and a CDP session on the page (`newCDPSession`, which is how
 * `Target.getTargetInfo` is asked). `lookup` says what that session does:
 *
 *   "normal"  the fake's own session (no answer: the ownership falls through to the
 *             attached context, which is where the fake's target info comes from)
 *   "throw"   reject — this page's target info cannot be had at all
 *   "hang"    never resolve — a CDP session that stops answering (A3)
 *   "answer"  answer `Target.getTargetInfo` with the page's own id after `delayMs`,
 *             i.e. a bot mark whose id is a real round trip away (A4's pending case)
 *
 * `connected` is mutable through the returned state: a test flips it before it
 * emits "close", which is exactly what a browser teardown looks like.
 */
function controlledContext(page, options = {}) {
  const original = page.context;
  const lookup = options.lookup || "normal";
  const delayMs = Number(options.delayMs) || 0;
  const state = { connected: options.connected !== false, sessions: 0 };
  page.context = () => ({
    browser: () => ({ isConnected: () => state.connected }),
    async newCDPSession() {
      state.sessions += 1;
      if (lookup === "throw") throw new Error(`no CDP session for ${page.name}`);
      if (lookup === "hang") return new Promise(() => {});
      if (lookup === "answer") {
        if (delayMs) await later(delayMs);
        return {
          on() {},
          async send(method) {
            if (method === "Target.getTargetInfo") return { targetInfo: { targetId: page.targetId } };
            return {};
          },
          async detach() {},
        };
      }
      return original().newCDPSession(page);
    },
  });
  return state;
}

/** The ownership's unresolved-mark count, through the seam A1/A6 ask for. */
const unresolvedSeam = (ownership) =>
  typeof ownership.unresolvedMarks === "function" ? ownership.unresolvedMarks() : "no unresolvedMarks() seam";

// A1 REWRITTEN for T19: the "release the unresolved mark on close" mechanism is
// REMOVED. An unresolved bot mark stays unresolved for the life of the process (fail
// closed, and documented), so a reconnect with one classes every unmatched page BOT.
test("A1 (T19): a close does NOT release an unresolved bot mark, and a reconnect with one classes the unmatched pages BOT", async () => {
  /**
   * The scene: the bot owns a page whose target id cannot be had at all (its own
   * context throws, and so does the attached one), so the mark is UNRESOLVED.
   * `connected` is what the browser answers when the page closes.
   */
  const scene = async (options = {}) => {
    const world = worldWithTargetInfo({ throwFor: (page) => Boolean(page) && page.name === "B1" });
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    const botPage = pageWithEvents(world.addPage("B1", { targetId: "target-b1" }));
    controlledContext(botPage, { lookup: "throw", connected: options.connected !== false });
    await ownership.markOpened(botPage);
    await ownership.settle();
    assert.equal(ownership.classify(botPage), "bot", "the mark itself never depends on the lookup");
    assert.equal(
      unresolvedSeam(ownership),
      1,
      "the bot mark's target id could not be resolved, so it is counted unresolved (the case's condition)",
    );
    return { world, ownership, botPage };
  };

  /** One reconnect: one Page object for a tab the ownership never saw before. */
  const reconnect = async (ownership) => {
    const second = makeWorld();
    const operatorTab = second.addPage("O", { targetId: "target-operator" });
    await ownership.attachContext(second.context);
    await ownership.settle();
    return { second, operatorTab };
  };

  // CONTROL 1: the same scene and no close at all — the same fail-closed answer, so
  // the case is not about the close making things worse.
  {
    const { ownership } = await scene();
    const { operatorTab } = await reconnect(ownership);
    assert.equal(
      ownership.classify(operatorTab),
      "bot",
      "CONTROL: without a close the unresolved mark stands and the unclaimed tab is BOT (fail closed)",
    );
  }

  // CONTROL 2: the close came from a DISCONNECT (`isConnected()` false). Nothing is
  // released in either case now, and the verdict is unchanged.
  {
    const { ownership, botPage } = await scene({ connected: false });
    botPage.emitEvent("close");
    await later(5);
    await ownership.settle();
    assert.equal(unresolvedSeam(ownership), 1, "CONTROL: a close the browser calls a disconnect releases nothing");
    const { operatorTab } = await reconnect(ownership);
    assert.equal(ownership.classify(operatorTab), "bot", "CONTROL: …so the reconnect still fails closed");
  }

  // CONTROL 3: every id resolved, and the SAME reconnect leaves the operator's tab
  // alone — so "BOT" below is the unresolved mark, not a blanket answer.
  {
    const world = worldWithTargetInfo();
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    const botPage = world.addPage("B2", { targetId: "target-b2" });
    await ownership.markOpened(botPage);
    await ownership.settle();
    assert.equal(unresolvedSeam(ownership), 0, "CONTROL: every bot id resolved");
    const { operatorTab } = await reconnect(ownership);
    assert.equal(
      ownership.classify(operatorTab),
      "operator",
      "CONTROL: with every id resolved the unmatched tab is the operator's (proof (i))",
    );
  }

  // THE CASE (RED at HEAD: the close releases the mark and the tab is handed to the
  // operator). The unresolved page closes while the browser is still connected — the
  // very close the removed rule used to take the mark back out on.
  {
    const { ownership, botPage } = await scene({ connected: true });
    botPage.emitEvent("close");
    await later(5);
    await ownership.settle();
    assert.equal(
      unresolvedSeam(ownership),
      1,
      "a close does NOT release an unresolved bot mark: it stays unresolved for the process (A1's release mechanism is gone)",
    );

    const { second, operatorTab } = await reconnect(ownership);
    assert.equal(
      ownership.classify(operatorTab),
      "bot",
      "with an unresolved bot mark a reconnect can prove no tab is NOT the bot's, so the operator's unmatched tab is BOT (fail closed)",
    );
    await runExitCleanup(second, { ownership });
    assert.deepEqual(operatorTab.calls.goto, ["about:blank"], "…and the cleanup blanks the page it had to fail closed on");
    assert.equal(operatorTab.calls.close, 1, "…then closes it");
    assert.deepEqual(second.crashSends, [], "nothing failed, so nothing is crashed");
  }
});

// A2: a reconnect CLAIM whose lookup fails is not "no id matched".
test("A2: on reconnect, a claim whose target-info lookup FAILS is BOT; one that answers an unremembered id stays the operator's", async () => {
  const first = worldWithTargetInfo();
  const botPage = first.addPage("B1", { targetId: "target-b1" });
  const ownership = createPageOwnership();
  await ownership.attachContext(first.context);
  await ownership.markOpened(botPage);
  await ownership.settle();
  assert.equal(ownership.classify(botPage), "bot", "the bot owns one page with a resolved id, so the reconnect has something to look for");

  // The reconnect. One tab's target info can be had from NEITHER source the
  // ownership asks (its own context throws, and so does the attached one); the
  // other answers an id no bot mark remembers.
  const second = worldWithTargetInfo({ throwFor: (page) => Boolean(page) && page.name === "X" });
  const failing = second.addPage("X", { targetId: "target-x" });
  controlledContext(failing, { lookup: "throw" });
  const stranger = second.addPage("S", { targetId: "target-stranger" });
  await ownership.attachContext(second.context);
  await ownership.settle();

  assert.equal(
    ownership.classify(stranger),
    "operator",
    "CONTROL: a claim that ANSWERS an id no bot mark remembers is proof the tab is not the bot's: the operator's",
  );
  assert.equal(
    ownership.classify(failing),
    "bot",
    "a claim whose target-info lookup FAILS (`ok: false`, not 'answered no id') proves nothing either way, so the page is BOT while the ownership owns bot pages (fail closed) — reading it as 'no id matched' hands the bot's tab back to the operator",
  );
});

// A3: every lookup a classification waits on is bounded.
test("A3a: a never-answering opener() cannot hold settle()", async () => {
  // An arrival whose opener() never answers. settle() awaits it, so an unbounded wait
  // holds the exit cleanup (and everything behind it) forever.
  {
    const world = makeWorld();
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);

    const stuck = world.addPage("stuck-opener");
    stuck.opener = () => new Promise(() => {});
    world.emitPage(stuck);
    await later(10);
    assert.equal(ownership.pending(), true, "the never-answering opener() really is in flight (the case is not vacuous)");

    const { outcome, elapsed } = await timed(() => ownership.settle());
    assert.equal(outcome, "done", `settle() has to come back when an opener() never answers (outcome ${outcome} after ${elapsed} ms)`);
    assert.ok(elapsed < 3000, `the bound on the opener() round trip has to be well under the 3.5 s ceiling (took ${elapsed} ms)`);
    assert.equal(ownership.pending(), false, "…and once it came back, nothing is left in flight");
  }
});

// A3b: the rule-2 openerId lookup is bounded too, and a timed-out one is no evidence.
test("A3b: a never-answering openerId session is 'ok: false' — BOT with a bot page owned, 'uncertain' with nothing owned", async () => {
  // (2) the rule-2 openerId lookup whose CDP session never answers: a timed-out
  //     lookup is no evidence at all, so it is `ok: false` — BOT while a bot page is
  //     owned. (The page's own context hangs; the attached one refuses, so a bound
  //     per source ends in the same place as a bound on the whole lookup.)
  {
    const world = worldWithTargetInfo({ throwFor: (page) => Boolean(page) && page.name === "arrival" });
    const botPage = world.addPage("B1");
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    ownership.markOpened(botPage);
    await ownership.settle();

    const arrival = world.addPage("arrival");
    controlledContext(arrival, { lookup: "hang" });
    world.emitPage(arrival);
    await later(10);
    assert.equal(ownership.pending(), true, "the hanging openerId lookup really is in flight");

    const { outcome, elapsed } = await timed(() => ownership.settle());
    assert.equal(outcome, "done", `settle() has to come back when the openerId session never answers (outcome ${outcome} after ${elapsed} ms)`);
    assert.ok(elapsed < 3000, `…within the bound (took ${elapsed} ms)`);
    assert.equal(
      ownership.classify(arrival),
      "bot",
      "a TIMED-OUT openerId lookup is treated as `ok: false` (no evidence), so the page is BOT while the ownership owns a bot page (fail closed)",
    );
  }

  // (2) CONTROL: the same hanging session with nothing of the bot's owned — no
  //     lookup is asked at all, so the page is left alone as `uncertain`.
  {
    const world = makeWorld();
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);

    const arrival = world.addPage("arrival");
    controlledContext(arrival, { lookup: "hang" });
    world.emitPage(arrival);
    const { outcome, elapsed } = await timed(() => ownership.settle());
    assert.equal(outcome, "done", `CONTROL: with nothing owned there is nothing to wait for (outcome ${outcome} after ${elapsed} ms)`);
    assert.ok(elapsed < 1000, `CONTROL: and it is fast, because no CDP session is opened at all (took ${elapsed} ms)`);
    assert.equal(
      ownership.classify(arrival),
      "uncertain",
      "CONTROL: with no bot page owned the openerId is never asked, so this page is an independent tab and stays 'uncertain'",
    );
  }
});

// A3c: a reconnect claim is bounded too.
test("A3c: a never-answering reconnect claim cannot hold attachContext(), and proves nothing (BOT)", async () => {
  // A claim whose CDP session never answers: attachContext() awaits it, so an
  // unbounded claim hangs the reconnect — and a timed-out claim proves nothing,
  // which is BOT while bot targets are remembered.
  {
    const first = worldWithTargetInfo();
    const botPage = first.addPage("B1", { targetId: "target-b1" });
    const ownership = createPageOwnership();
    await ownership.attachContext(first.context);
    await ownership.markOpened(botPage);
    await ownership.settle();

    const second = worldWithTargetInfo({ throwFor: (page) => Boolean(page) && page.name === "stuck-claim" });
    const stuckClaim = second.addPage("stuck-claim", { targetId: "target-stuck" });
    controlledContext(stuckClaim, { lookup: "hang" });
    const stranger = second.addPage("stranger", { targetId: "target-stranger" });

    const { outcome, elapsed } = await timed(() => ownership.attachContext(second.context));
    assert.equal(outcome, "done", `attachContext() has to come back when a claim's CDP session never answers (outcome ${outcome} after ${elapsed} ms)`);
    assert.ok(elapsed < 3000, `…within the bound (took ${elapsed} ms)`);
    assert.equal(
      ownership.classify(stuckClaim),
      "bot",
      "a claim whose lookup timed out proves nothing, so the page is BOT while the ownership owns bot pages (fail closed)",
    );
    assert.equal(ownership.classify(stranger), "operator", "CONTROL: the claim that answered a stranger's id is still the operator's");
    await ownership.settle();
  }
});

// A4 REWRITTEN for T19: rule 2's `nothingLeftToDecide()` narrowing is REMOVED. An
// `openerId` is the operator's ONLY when it names the target id of a LIVE page
// classed operator (resolved on demand at that moment, bounded by the 1000 ms
// timeout). Every other `openerId` is BOT.
test("A4 (T19): an openerId is the operator's only when it names a live operator page; every other openerId is BOT", async () => {
  /**
   * The scene for one branch: an operator page that EXISTED at attach (proof (i))
   * with a known target id, a bot page whose id is resolved, and an arrival whose
   * CDP `openerId` is `openerId`.
   */
  const scene = async (openerId) => {
    const world = worldWithTargetInfo({
      openerIdFor: (page) => (page && page.name === "arrival" ? openerId : undefined),
    });
    const operatorPage = world.addPage("O", { targetId: "target-operator" });
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    const botPage = world.addPage("B1", { targetId: "target-bot" });
    await ownership.markOpened(botPage);
    await ownership.settle();
    return { world, ownership, operatorPage };
  };

  /** One arrival, classified: its class is the answer. */
  const decide = async (openerId) => {
    const { world, ownership } = await scene(openerId);
    const arrival = world.addPage("arrival");
    world.emitPage(arrival);
    await ownership.settle();
    return ownership.classify(arrival);
  };

  // (a) openerId IS a remembered bot target id: BOT (a popup of the bot's).
  assert.equal(
    await decide("target-bot"),
    "bot",
    "an arrival whose openerId names a tab the bot owns is a popup of the bot's: BOT",
  );

  // (b) THE PROOF CASE: openerId is a LIVE operator page's target id — the operator's
  //     popup, proved rather than guessed, because the opener page is still there and
  //     its id is resolved ON DEMAND at this moment (never at attach).
  assert.equal(
    await decide("target-operator"),
    "operator",
    "an openerId that resolves to a live page classed operator is positive proof (proof (ii)): the popup is the operator's",
  );

  // (c) openerId names nobody at all: BOT. This is exactly the case the removed
  //     narrowing handed to the operator, with nothing unresolved and nothing in
  //     flight — so the answer cannot be read as that narrowing coming back.
  {
    const { world, ownership } = await scene("target-nobody");
    assert.equal(unresolvedSeam(ownership), 0, "…the condition the removed rule read: nothing is unresolved");
    assert.equal(ownership.pending(), false, "…and nothing is being looked up");

    const arrival = world.addPage("arrival");
    world.emitPage(arrival);
    await ownership.settle();
    assert.equal(
      ownership.classify(arrival),
      "bot",
      "an openerId nobody can prove is BOT: the narrowing that used to hand it to the operator is gone (fail closed)",
    );
  }
});

// A5: every page classed BOT by any path carries exactly one `popup` listener.
test("A5: a page classed BOT by the arrival path, the opener path or a reconnect claim carries exactly one popup listener", async () => {
  // (a) the arrival path, through the CDP openerId evidence.
  {
    const world = worldWithTargetInfo({ openerIdFor: (page) => (page && page.name === "arrival" ? "target-opener-x" : undefined) });
    // The bot page carries the target id the arrival's openerId names, so the arrival
    // path classes the page BOT by a REMEMBERED bot target (an openerId that names no
    // live operator page is BOT as well — see A4's rewritten case).
    const botPage = pageWithEvents(world.addPage("B1", { targetId: "target-opener-x" }));
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    ownership.markOpened(botPage);
    await ownership.settle();
    assert.equal(botPage.listenerCount("popup"), 1, "a MARKED bot page carries exactly one popup listener");

    const arrival = pageWithEvents(world.addPage("arrival"));
    world.emitPage(arrival);
    await ownership.settle();
    assert.equal(ownership.classify(arrival), "bot", "the arrival path classed it BOT (its openerId names an opener)");
    assert.equal(
      arrival.listenerCount("popup"),
      1,
      "a page classed BOT by the arrival path carries exactly one popup listener too — without it its own popups have only opener()/openerId to go on",
    );
  }

  // (b) the arrival-through-opener path, and a RE-MARK afterwards (never two
  //     listeners on one page).
  {
    const world = makeWorld();
    const botPage = pageWithEvents(world.addPage("B1"));
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    ownership.markOpened(botPage);
    await ownership.settle();

    const popup = pageWithEvents(world.addPage("popup-of-bot", { opener: botPage }));
    world.emitPage(popup);
    await ownership.settle();
    assert.equal(ownership.classify(popup), "bot", "a popup of a bot page is the bot's");
    assert.equal(popup.listenerCount("popup"), 1, "…and carries exactly one popup listener, installed by the classification that made it the bot's");

    ownership.markTouched(popup); // a later mark on the same page
    await ownership.settle();
    assert.equal(popup.listenerCount("popup"), 1, "a re-mark does not add a second listener (each popup would be marked twice)");
  }

  // (c) the reconnect claim: matched by id, and the fail-closed branch.
  {
    const first = worldWithTargetInfo();
    const botPage = first.addPage("B1", { targetId: "target-b1" });
    const ownership = createPageOwnership();
    await ownership.attachContext(first.context);
    await ownership.markOpened(botPage);
    await ownership.settle();

    const second = makeWorld();
    const reborn = pageWithEvents(second.addPage("B1", { targetId: "target-b1" }));
    const operatorTab = pageWithEvents(second.addPage("O", { targetId: "target-operator" }));
    await ownership.attachContext(second.context);
    await ownership.settle();
    assert.equal(ownership.classify(reborn), "bot", "the reconnect claimed the bot's tab by id");
    assert.equal(reborn.listenerCount("popup"), 1, "a page the reconnect claims by id carries exactly one popup listener");
    assert.equal(operatorTab.listenerCount("popup"), 0, "CONTROL: an operator page carries none (nothing is installed on a page that is not the bot's)");

    // The fail-closed claim: an unresolved bot mark makes the unclaimed page BOT.
    const third = worldWithTargetInfo({ throwFor: (page) => Boolean(page) && page.name === "unresolved" });
    const unresolvedOwnership = createPageOwnership();
    await unresolvedOwnership.attachContext(third.context);
    const unresolvedPage = third.addPage("unresolved");
    controlledContext(unresolvedPage, { lookup: "throw" });
    await unresolvedOwnership.markOpened(unresolvedPage);
    await unresolvedOwnership.settle();

    const fourth = makeWorld();
    const failClosedPage = pageWithEvents(fourth.addPage("unclaimed", { targetId: "target-unclaimed" }));
    await unresolvedOwnership.attachContext(fourth.context);
    await unresolvedOwnership.settle();
    assert.equal(unresolvedOwnership.classify(failClosedPage), "bot", "the unresolved mark makes the unclaimed page BOT (fail closed)");
    assert.equal(
      failClosedPage.listenerCount("popup"),
      1,
      "a page classed BOT by the fail-closed claim carries exactly one popup listener",
    );
  }
});

// A6: pending work alone is not bot work for the budget.
test("A6a: a budget that expires on pending work ALONE crashes nothing", async () => {
  // THE CASE: an operator arrival's opener() round trip is in flight, the bot owns
  // nothing and nothing is unresolved. The cleanup's settle() hangs on it, so the
  // budget really does expire — and it must not crash the browser.
  {
    const world = makeWorld();
    const operatorPage = world.addPage("operator");
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);

    const operatorArrival = world.addPage("operator-popup");
    operatorArrival.opener = () => new Promise(() => {});
    world.emitPage(operatorArrival);
    await later(10);
    assert.equal(ownership.pending(), true, "an operator arrival's opener() round trip really is in flight (the budget's only work)");

    const lines = await withConsoleError(() => runExitCleanup(world, { ownership, budgetMs: 80 }));

    assert.deepEqual(
      world.crashSends,
      [],
      "pending classification work that is nobody's is not bot work: nothing of the bot's is known or armed, so the operator's tabs are not destroyed for nothing",
    );
    assert.deepEqual(
      lines.filter((line) => /budget/i.test(line)),
      [],
      `…and no budget line is written (lines: ${JSON.stringify(lines)})`,
    );
    assert.deepEqual(callCounts(operatorPage), ZERO_CALLS, "…and the operator's page is not navigated, closed, probed or attached");

    assert.equal(typeof ownership.botPageCount, "function", "the ownership reports how many bot pages it has marked (botPageCount())");
    assert.equal(typeof ownership.unresolvedMarks, "function", "…and how many bot marks have no target id (unresolvedMarks())");
    assert.equal(ownership.botPageCount(), 0, "CONTROL: the bot owns nothing here");
    assert.equal(ownership.unresolvedMarks(), 0, "CONTROL: and nothing is unresolved");
  }
});

// A6b: with a bot page known, or an unresolved mark, the budget still fails closed.
test("A6b: a budget that expires with a bot page known, or with an unresolved mark, still crashes the browser", async () => {
  // (b) a bot page KNOWN: the same expired budget is a fail-closed case, as before.
  {
    const world = makeWorld();
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    const botPage = world.addPage("bot");
    await ownership.markOpened(botPage);
    await ownership.settle();
    const botPagesBefore = typeof ownership.botPageCount === "function" ? ownership.botPageCount() : "no botPageCount() seam";

    // The cleanup cannot finish inside the budget: a second arrival's opener() never
    // answers, so its settle() hangs.
    const stuck = world.addPage("stuck");
    stuck.opener = () => new Promise(() => {});
    world.emitPage(stuck);
    await later(10);

    const lines = await withConsoleError(() => runExitCleanup(world, { ownership, budgetMs: 80 }));
    assert.deepEqual(
      world.crashSends,
      ["Browser.crash"],
      "with a bot page known, a budget that expires leaves the bot's page armed: the browser is crashed once",
    );
    assert.ok(lines.some((line) => /budget/i.test(line)), `…and one line says the budget ran out (lines: ${JSON.stringify(lines)})`);
    assert.equal(botPagesBefore, 1, "the ownership reports the bot page it marked (botPageCount())");
  }

  // (c) an UNRESOLVED bot mark: same fail-closed answer (a mark whose id could not be
  //     had may be exactly the tab nobody could prove).
  {
    const world = worldWithTargetInfo({ throwFor: (page) => Boolean(page) && page.name === "unresolved" });
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    const unresolvedPage = world.addPage("unresolved");
    controlledContext(unresolvedPage, { lookup: "throw" });
    await ownership.markOpened(unresolvedPage);
    await ownership.settle();
    const unresolvedBefore =
      typeof ownership.unresolvedMarks === "function" ? ownership.unresolvedMarks() : "no unresolvedMarks() seam";

    const stuck = world.addPage("stuck");
    stuck.opener = () => new Promise(() => {});
    world.emitPage(stuck);
    await later(10);

    const lines = await withConsoleError(() => runExitCleanup(world, { ownership, budgetMs: 80 }));
    assert.deepEqual(
      world.crashSends,
      ["Browser.crash"],
      "an unresolved bot mark can be ANY tab, so a budget that expires with one is a fail-closed case: the browser is crashed",
    );
    assert.ok(lines.some((line) => /budget/i.test(line)), `…and one line says so (lines: ${JSON.stringify(lines)})`);
    assert.equal(unresolvedBefore, 1, "the ownership reports the mark whose target id could not be resolved (unresolvedMarks())");
  }
});

// M3: one proc, one pair PER SERVER — matched by ownership, not by getter.
test("M3a: a second ownership with the SAME getter function is a second pair, and both are cleaned", async () => {
  // A second call with a DIFFERENT ownership but the SAME getter function has to stay a
  // separate pair: matching by getter merges them and drops the first server's bot
  // page from the cleanup entirely.
  {
    const world = makeWorld();
    const ownershipA = createPageOwnership();
    await ownershipA.attachContext(world.context);
    const botA = world.addPage("bot-a");
    await ownershipA.markOpened(botA);
    await ownershipA.settle();

    const ownershipB = createPageOwnership();
    await ownershipB.attachContext(world.context);
    const botB = world.addPage("bot-b");
    await ownershipB.markOpened(botB);
    await ownershipB.settle();

    const proc = new EventEmitter();
    proc.stdin = new EventEmitter();
    const getter = () => world.context;
    const run = blankPagesOnExit(getter, { proc, ownership: ownershipA, budgetMs: 2000 });
    const runAgain = blankPagesOnExit(getter, { proc, ownership: ownershipB, budgetMs: 2000 });
    assert.equal(runAgain, run, "both calls are handed the same one cleanup back");

    proc.stdin.emit("close");
    await run();

    assert.deepEqual(
      botA.calls.goto,
      ["about:blank"],
      "the FIRST server's bot page is still cleaned up: a second ownership with the same getter function is a second PAIR, not a replacement for the first one's",
    );
    assert.equal(botA.calls.close, 1, "…and closed");
    assert.deepEqual(botB.calls.goto, ["about:blank"], "…as is the second server's bot page");
    assert.equal(botB.calls.close, 1, "…and closed");
    assert.deepEqual(world.crashSends, [], "nothing failed, so nothing is crashed");
  }
});

// M3b: two legacy registrations (no ownership) are two pairs, not one with a swapped getter.
test("M3b: two legacy registrations with different getters clean both contexts", async () => {
  // (2) two LEGACY registrations (no ownership at all) with different getters are two
  //     pairs: both contexts are cleaned. (No ownership compares equal to no
  //     ownership, which is how they get merged today.)
  {
    const firstWorld = makeWorld();
    const firstPage = firstWorld.addPage("legacy-a");
    const secondWorld = makeWorld();
    const secondPage = secondWorld.addPage("legacy-b");

    const proc = new EventEmitter();
    proc.stdin = new EventEmitter();
    const run = blankPagesOnExit(() => firstWorld.context, { proc, budgetMs: 2000 });
    const runAgain = blankPagesOnExit(() => secondWorld.context, { proc, budgetMs: 2000 });
    assert.equal(runAgain, run, "both calls are handed the same one cleanup back");

    proc.stdin.emit("close");
    await run();

    assert.deepEqual(
      firstPage.calls.goto,
      ["about:blank"],
      "two legacy registrations are two pairs: the first context is cleaned too, not replaced by the second one's getter",
    );
    assert.equal(firstPage.calls.close, 1, "…its page is closed");
    assert.deepEqual(secondPage.calls.goto, ["about:blank"], "…and the second context's page is blanked");
    assert.equal(secondPage.calls.close, 1, "…and closed");
    assert.equal(firstWorld.newPageCalls, 1, "each legacy context makes its own survivor");
    assert.equal(secondWorld.newPageCalls, 1, "…both of them");
  }
});

// M3c: a repeat with the SAME ownership swaps only that pair's getter.
test("M3c: a repeat call with the same ownership swaps that pair's getter instead of adding a pair", async () => {
  // (3) CONTROL: a repeat call with the SAME ownership swaps that pair's getter and
  //     adds no second pair, so only the newest context is walked.
  {
    const firstWorld = makeWorld();
    const ownership = createPageOwnership();
    await ownership.attachContext(firstWorld.context);
    const inFirst = firstWorld.addPage("bot-in-first");
    await ownership.markOpened(inFirst);
    await ownership.settle();

    const secondWorld = makeWorld();
    await ownership.attachContext(secondWorld.context);
    const inSecond = secondWorld.addPage("bot-in-second");
    await ownership.markOpened(inSecond);
    await ownership.settle();

    const proc = new EventEmitter();
    proc.stdin = new EventEmitter();
    const run = blankPagesOnExit(() => firstWorld.context, { proc, ownership, budgetMs: 2000 });
    blankPagesOnExit(() => secondWorld.context, { proc, ownership, budgetMs: 2000 });

    // Snapshotted AFTER the marks: a mark's own target-id lookup is a CDP session on
    // the page, and that is not the cleanup touching it.
    const baseline = touchCounts(inFirst);

    proc.stdin.emit("close");
    await run();

    assert.deepEqual(inSecond.calls.goto, ["about:blank"], "CONTROL: the pair reads the NEWEST getter, so that context is cleaned");
    assert.equal(inSecond.calls.close, 1, "CONTROL: …and its bot page is closed");
    assert.deepEqual(
      touchCounts(inFirst),
      baseline,
      "CONTROL: the pair was SWAPPED, not duplicated: the old getter's context is never walked (the page is not even probed)",
    );
  }
});

// ---------------------------------------------------------------------------
// 14. contract round 8 (T19): the SIMPLIFIED fail-closed ownership rule
//
// The old rules 2-3 (the `nothingLeftToDecide()` narrowing, with its
// `marksInFlight` counter) and A1's "release the unresolved mark on close" are
// REPLACED by one rule. A page is the OPERATOR's only on POSITIVE PROOF:
//
//   (i)  it existed when this context was attached (and no reconnect claim matched
//        it), or
//   (ii) it arrived with an opener that is a PROVEN operator page: `opener()`
//        resolved to a page whose class is `operator`, or `opener()` said nothing
//        and the CDP `openerId` equals the target id of a LIVE page classed
//        `operator` (those ids are resolved ON DEMAND at that moment, bounded by
//        the 1000 ms lookup timeout — never at attach).
//
// A page that arrives with NO `openerId` at all (a successful lookup that answered
// none) and was not made through `newPage` is an INDEPENDENT tab: `uncertain`, left
// alone. A popup of an `uncertain` page is `uncertain` too. EVERYTHING ELSE that
// arrives while attached is BOT, fail closed: an openerId nobody can prove, a
// lookup that failed or timed out, the openerId of a closed operator page, an
// openerId the id table does not hold. Bot target ids are NEVER evicted (no cap),
// and a bot page that closes while its id lookup is in flight still counts. An
// unresolved bot mark is never released (that is the rewritten A1 case above; T19-6
// lives there, since the old A1 case is where the release used to be asserted).
//
// Every case comes with its controls: the arrival that is NOT the bot's (an
// independent tab, or an openerId that IS a live operator page's id), so the
// fail-closed rule cannot pass by making everything the bot's. RED at HEAD where
// noted: the failure is the bug report.
// ---------------------------------------------------------------------------

/**
 * The operator closed that tab: Playwright stops listing it in `context.pages()` and
 * `page.isClosed()` answers true. Nothing about the tab is provable afterwards — its
 * id is not a LIVE page's id any more.
 */
function closeTab(world, page) {
  page.closed = true;
  const at = world.pages.indexOf(page);
  if (at !== -1) world.pages.splice(at, 1);
  if (typeof page.emitEvent === "function") page.emitEvent("close");
  return page;
}

/**
 * A scene with both halves of the new rule next to each other: an operator page that
 * EXISTED at attach (proof (i), target id `target-operator`), and a bot page whose id
 * (`target-bot`) is resolved. An arrival named "arrival" reports `openerId` as its CDP
 * openerId. Returns the ownership, the world and both pages.
 */
async function proofScene(openerId, options = {}) {
  const world = worldWithTargetInfo({
    openerIdFor: (page) => (page && page.name === "arrival" ? openerId : undefined),
  });
  const operatorPage = world.addPage("O", { targetId: "target-operator" });
  const ownership = createPageOwnership(options);
  await ownership.attachContext(world.context);
  const botPage = world.addPage("B", { targetId: "target-bot" });
  await ownership.markOpened(botPage);
  await ownership.settle();
  return { world, ownership, operatorPage, botPage };
}

// T19-1: the popup chain does not escape through a close during the id lookup.
test("T19-1: a popup whose bot opener closes while its id lookup is in flight is BOT", async () => {
  /**
   * B is the bot's and its target-id lookup is a REAL round trip (120 ms), so a close
   * can land while the answer is still on its way: the answer comes back for a page
   * that is gone, so the id is DROPPED and the tab is never remembered by id.
   */
  const scene = async () => {
    const world = worldWithTargetInfo({ openerIdFor: (page) => (page && page.name === "P" ? "target-b" : undefined) });
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    const botPage = pageWithEvents(world.addPage("B", { targetId: "target-b" }));
    const browser = controlledContext(botPage, { lookup: "answer", delayMs: 120, connected: true });
    ownership.markOpened(botPage); // the mark lands now; its id lookup is in flight
    return { world, ownership, botPage, browser };
  };

  // CONTROL 1: the same chain with B still open and its id resolved — BOT, so the
  // case below is the close and not the shape of the scene.
  {
    const { world, ownership } = await scene();
    await ownership.settle();
    const popup = world.addPage("P");
    world.emitPage(popup);
    await ownership.settle();
    assert.equal(ownership.classify(popup), "bot", "CONTROL: the id of a bot page that is still open is proof enough (BOT)");
  }

  // CONTROL 2: the same arrival shape, with an openerId that IS a live operator
  // page's id — the operator's popup, so "BOT" below is not a blanket answer.
  {
    const { world, ownership, operatorPage } = await proofScene("target-operator");
    assert.equal(ownership.classify(operatorPage), "operator", "CONTROL: the operator page existed at attach (proof (i))");
    const popup = world.addPage("arrival");
    world.emitPage(popup);
    await ownership.settle();
    assert.equal(
      ownership.classify(popup),
      "operator",
      "CONTROL: an openerId that names the live operator page's resolved id makes the popup the operator's (proof (ii))",
    );
  }

  // THE CASE (RED at HEAD: the popup is handed to the operator). B closes while its
  // id lookup is in flight; then P arrives with `opener()` null and `openerId` = B's
  // id, a tab the id table does not hold.
  {
    const { world, ownership, botPage, browser } = await scene();
    await later(10);
    assert.equal(browser.sessions, 1, "the bot mark's target-id lookup really is in flight (the case is not vacuous)");
    botPage.emitEvent("close");
    await ownership.settle();

    const popup = world.addPage("P");
    world.emitPage(popup);
    await ownership.settle();
    assert.equal(
      ownership.classify(popup),
      "bot",
      "a popup whose bot opener closed while its id lookup was in flight is BOT: nothing proves it is the operator's, and an id the table does not hold is no proof either (fail closed)",
    );
  }
});

// T19-2: a close does not make an id that never resolved provable.
test("T19-2: an id lookup that failed is not made provable by a close — the later arrival naming it is BOT", async () => {
  /** B's target id cannot be had at all; the browser is still connected when it closes. */
  const scene = async () => {
    const world = worldWithTargetInfo({
      openerIdFor: (page) => (page && page.name === "arrival" ? "target-unknown-bot" : undefined),
      throwFor: (page) => Boolean(page) && page.name === "B",
    });
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    const botPage = pageWithEvents(world.addPage("B", { targetId: "target-unknown-bot" }));
    controlledContext(botPage, { lookup: "throw", connected: true });
    await ownership.markOpened(botPage);
    await ownership.settle();
    assert.equal(ownership.classify(botPage), "bot", "the mark itself never depends on the lookup");
    return { world, ownership, botPage };
  };

  // CONTROL: the same arrival, and the openerId IS a live operator page's resolved id.
  {
    const { world, ownership, operatorPage } = await proofScene("target-operator");
    assert.equal(ownership.classify(operatorPage), "operator", "CONTROL: a page that existed at attach is the operator's");

    const arrival = world.addPage("arrival");
    world.emitPage(arrival);
    await ownership.settle();
    assert.equal(
      ownership.classify(arrival),
      "operator",
      "CONTROL: the same arrival whose openerId names a LIVE operator page is the operator's — proof, resolved on demand at that moment",
    );
  }

  // THE CASE (RED at HEAD: the arrival is handed to the operator): the lookup failed,
  // so the tab is not remembered by id, and the page then closes — the close the old
  // rule used to release the mark on. A later arrival whose openerId names that
  // unknown id proves nothing.
  {
    const { world, ownership, botPage } = await scene();
    botPage.emitEvent("close");
    await later(5);
    await ownership.settle();

    const arrival = world.addPage("arrival");
    world.emitPage(arrival);
    await ownership.settle();
    assert.equal(
      ownership.classify(arrival),
      "bot",
      "an openerId naming a bot id nobody could resolve — not even after the page closed — is BOT: a lookup that failed proves nothing, and a close adds no proof (fail closed)",
    );
  }
});

// T19-3: bot target ids are never evicted.
test("T19-3: bot target ids are never evicted, so the FIRST of 1100 bot pages still proves its popup", async () => {
  // CONTROL: the same arrival shape, openerId a live operator page's id — the
  // operator's popup.
  {
    const { world, ownership } = await proofScene("target-operator");
    const popup = world.addPage("arrival");
    world.emitPage(popup);
    await ownership.settle();
    assert.equal(ownership.classify(popup), "operator", "CONTROL: an openerId that names a live operator page is proof, so the popup is the operator's");
  }

  // THE CASE (RED at HEAD: a cap of 1000 evicts the oldest id, and its popup is
  // handed to the operator). 1100 fakes, cheap: the ids come from the fake pages.
  {
    const world = worldWithTargetInfo({
      openerIdFor: (page) => (page && page.name === "oldest-popup" ? "target-bot-0" : undefined),
    });
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    for (let i = 0; i < 1100; i++) {
      ownership.markTouched(world.addPage(`bot-${i}`, { targetId: `target-bot-${i}` }));
      // Mark in batches of 50 and drain between them: queueing all 1100 pages' lookups at once needs ~3 GB (memory).
      if ((i + 1) % 50 === 0) await ownership.settle();
    }
    await ownership.settle();
    assert.equal(ownership.classify(world.pages[0]), "bot", "the first of the 1100 bot pages is the bot's");

    const popup = world.addPage("oldest-popup");
    world.emitPage(popup);
    await ownership.settle();
    assert.equal(
      ownership.classify(popup),
      "bot",
      "a popup whose openerId names the FIRST of 1100 bot pages is BOT: bot target ids are never evicted, so that tab is still the bot's whatever its age",
    );
  }
});

// T19-4: an openerId of a CLOSED operator page is not proof, and proves nothing.
test("T19-4: the openerId of a closed operator page is BOT; the same arrival while it is live is the operator's", async () => {
  const scene = async () => {
    const { world, ownership, operatorPage } = await proofScene("target-operator");
    assert.equal(ownership.classify(operatorPage), "operator", "a page that existed at attach is the operator's (proof (i))");
    return { world, ownership, operatorPage };
  };

  // CONTROL: the operator's own tab is still open when the popup arrives, so its id
  // is a live operator page's id and the popup is the operator's (proof (ii)).
  {
    const { world, ownership } = await scene();
    const popup = world.addPage("arrival");
    world.emitPage(popup);
    await ownership.settle();
    assert.equal(
      ownership.classify(popup),
      "operator",
      "CONTROL: the openerId resolves to a live page classed operator, so the popup is the operator's",
    );
  }

  // THE CASE (RED at HEAD: the operator's id is unprovable, which the old narrowing
  // read as "nothing to decide" and handed back to the operator). The opener tab is
  // gone by the time the popup arrives: its id no longer names a live operator page,
  // so nothing positive is left.
  {
    const { world, ownership, operatorPage } = await scene();
    closeTab(world, operatorPage);
    const popup = world.addPage("arrival");
    world.emitPage(popup);
    await ownership.settle();
    assert.equal(
      ownership.classify(popup),
      "bot",
      "an openerId that names a tab which is GONE cannot be proven to have been the operator's: with no positive proof left the page is BOT (fail closed)",
    );
  }
});

// T19-5: the independent-tab discriminator (lane A's createTarget, the operator's Ctrl+T).
// T20 (FIX3): the two arrivals here are LATE — past a short `botActionWindowMs` — because
// an independent tab that appears WITHIN the bot-action window is the bot's now (see
// section 15); this case pins the no-openerId discriminator itself.
test("T19-5: an independent tab (no openerId, not via newPage) stays 'uncertain', even with a bot page owned", async () => {
  const world = worldWithTargetInfo(); // answers target info without any openerId at all
  const ownership = createPageOwnership({ botActionWindowMs: 100 });
  await ownership.attachContext(world.context);
  const botPage = world.addPage("B", { targetId: "target-bot" });
  ownership.markOpened(botPage);
  await ownership.settle();
  await later(250); // past the bot-action window

  const independent = world.addPage("independent");
  world.emitPage(independent);
  await ownership.settle();
  assert.equal(
    ownership.classify(independent),
    "uncertain",
    "a successful lookup that answers NO openerId is an independent tab (lane A's Target.createTarget, the operator's fresh Ctrl+T): 'uncertain', left alone",
  );

  const second = world.addPage("independent-2");
  world.emitPage(second);
  await ownership.settle();
  assert.equal(ownership.classify(second), "uncertain", "…and the next one too: 'uncertain' is a real class, not an accident of the first page");

  // CONTROL: the same null-opener arrival through ownership.newPage is the bot's.
  const created = await ownership.newPage(world.context);
  await ownership.settle();
  assert.equal(
    ownership.classify(created),
    "bot",
    "CONTROL: a page this MCP created through ownership.newPage is the bot's, whatever the lookup would have said",
  );
});

// T19-7: uncertainty is inherited down a popup chain (T19-6 is the rewritten A1 case).
test("T19-7: a popup of an 'uncertain' page is 'uncertain'; a popup of a proven operator page is the operator's", async () => {
  // The ownership's bot-action window is SHORT here and stepped over before the
  // independent arrival below: this case is about inheritance, not about FIX3's window.
  const { world, ownership, operatorPage } = await proofScene("target-operator", { botActionWindowMs: 100 });

  // CONTROL FIRST: `opener()` resolved to a page classed OPERATOR — proof (ii) — and the
  // popup stays the operator's when the bot drives a page UNRELATED to it (STICKY).
  const operatorPopup = world.addPage("operator-popup", { opener: operatorPage });
  world.emitPage(operatorPopup);
  await ownership.settle();
  assert.equal(
    ownership.classify(operatorPopup),
    "operator",
    "CONTROL: opener() resolved to a page whose class is operator, so its popup is the operator's",
  );
  const unrelated = world.addPage("unrelated");
  world.emitPage(unrelated);
  await ownership.settle();
  ownership.markTouched(unrelated);
  await ownership.settle();
  assert.equal(ownership.classify(unrelated), "bot", "the unrelated page the bot drove is the bot's");
  assert.equal(
    ownership.classify(operatorPopup),
    "operator",
    "CONTROL: STICKY — the bot driving an UNRELATED page does not change the popup's hands",
  );

  // THE CASE (RED at HEAD: an opener of class 'uncertain' was read as "not the
  // bot's", i.e. the operator's). Nothing more can be proven about a popup than
  // about the page that opened it. The arrival is LATE (past the short bot-action
  // window), so FIX3's window is not what decides it.
  await later(250);
  const independent = world.addPage("independent");
  world.emitPage(independent);
  await ownership.settle();
  assert.equal(ownership.classify(independent), "uncertain", "an independent tab is 'uncertain' (no openerId at all, not via newPage)");

  const popup = world.addPage("popup-of-independent", { opener: independent });
  world.emitPage(popup);
  await ownership.settle();
  assert.equal(
    ownership.classify(popup),
    "uncertain",
    "a popup of an independent tab inherits 'uncertain': an opener of class 'uncertain' stays 'uncertain' (it is neither proven the operator's nor the bot's)",
  );

  // And a popup of a page classed BOT is BOT (the other end of the same chain): the bot
  // drives the OPERATOR's page now, and a window it opens from then on is the bot's.
  ownership.markTouched(operatorPage);
  await ownership.settle();
  const botPopup = world.addPage("popup-of-bot", { opener: operatorPage });
  world.emitPage(botPopup);
  await ownership.settle();
  assert.equal(
    ownership.classify(botPopup),
    "bot",
    "a popup of a page the bot drove is the bot's (the touch reaches the windows it opens)",
  );
});

// ---------------------------------------------------------------------------
// 15. contract round 9 (T20): three findings
//
//   FIX1  a reconnect must WAIT for in-flight bot mark lookups. `attachContext` read
//         the unresolved-mark count and the id table while a mark's target-id lookup
//         was still on its way, so a lookup that then FAILED made its mark unresolved
//         too late: the tabs the reconnect should have failed closed on were handed
//         back to the operator. The wait is bounded by the existing 1000 ms lookup
//         timeout per lookup.
//   FIX2  ownership of RELATIVES follows `markTouched`: driving a page makes the pages
//         that opened it (its opener chain, by `opener()` OR by CDP `openerId`) and
//         every popup it opened (transitively) the bot's — permanently, and the work
//         starts once per page, not once per mark. Arrival marks and `markOpened` do
//         NOT reach relatives.
//   FIX3  an INDEPENDENT tab (no `opener()`, a successful lookup that names no
//         `openerId`) that appears within `botActionWindowMs` (default 5000) after the
//         latest `markTouched`/`markOpened` is the bot's. Real Chromium opens
//         ctrl-clicked and middle-clicked tabs exactly that way (no opener, no
//         openerId), while target=_blank, rel=noopener, window.open(noopener) and COOP
//         popups all carry an opener/openerId. The window is measured at ARRIVAL, and
//         proof (iii) is decided before it.
//   D1    proof (iii) re-checks its candidate's class after awaiting that candidate's
//         target id: a candidate marked the bot's during the await proves nothing.
//
// Every case comes with its control, and the cases are RED at HEAD where the finding
// is: the failure is the bug report, not a broken test.
// ---------------------------------------------------------------------------

/** Poll `check` until it is true (or the ceiling passes): a held lookup really is held. */
async function waitFor(check, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await later(10);
  }
  return false;
}

/**
 * A world whose CDP session for ONE page can be HELD OPEN and then failed, answered or
 * left hanging — the fake half of "this mark's target-id lookup is still in flight when
 * the reconnect happens".
 *
 * `holdLookup(page)` gates the sessions for that page; `heldEntered(page)` counts the
 * lookups waiting on the gate (so a case can prove it is not vacuous); `failLookup`
 * rejects them (a session that dies: the lookup resolves to no id, i.e. the mark is
 * UNRESOLVED) and `releaseLookup` lets them answer normally.
 */
function worldWithHeldLookup(options = {}) {
  const world = worldWithTargetInfo(options);
  const base = world.context.newCDPSession.bind(world.context);
  const gates = new Map();
  const gateFor = (page) => {
    let state = gates.get(page);
    if (!state) {
      let settle = null;
      const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      state = { promise, settle, entered: 0 };
      gates.set(page, state);
    }
    return state;
  };
  world.holdLookup = (page) => { gateFor(page); };
  world.heldEntered = (page) => (gates.get(page) || { entered: 0 }).entered;
  world.releaseLookup = (page) => {
    const state = gates.get(page);
    if (!state) return 0;
    state.settle.resolve();
    return state.entered;
  };
  world.failLookup = (page) => {
    const state = gates.get(page);
    if (!state) return 0;
    // Nobody waiting: resolving is the same as no gate at all, and a rejected promise
    // nobody awaits would only be an unhandled one.
    if (!state.entered) state.settle.resolve();
    else state.settle.reject(new Error(`the CDP session for ${page && page.name} went away`));
    return state.entered;
  };
  world.context.newCDPSession = async (page) => {
    const state = gates.get(page);
    if (state) {
      state.entered += 1;
      await state.promise;
    }
    return base(page);
  };
  return world;
}

// A1: the reconnect WAITS for an in-flight bot mark lookup, so its failure fails closed.
test("FIX1-T20 A1: a reconnect waits for a pending bot mark lookup — when it then FAILS, the unmatched page is BOT", async () => {
  /**
   * The scene: one bot page, marked, whose target-id lookup is HELD; then a reconnect to
   * a context with one page P the id table cannot claim. `outcome` says what the held
   * lookup does while the reconnect is in flight: "fail" (a session that dies) or
   * "answer" (the id resolves late). `claimP` gives P the bot page's own target id.
   */
  const scene = async (outcome, claimP = false) => {
    const world = worldWithHeldLookup();
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    const botPage = world.addPage("B");
    world.holdLookup(botPage);
    ownership.markTouched(botPage); // the mark lands now; its lookup is held
    assert.equal(ownership.classify(botPage), "bot", "the mark lands synchronously; only its target-id lookup is in flight");
    assert.ok(
      await waitFor(() => world.heldEntered(botPage) > 0),
      "the bot mark's target-id lookup really is in flight (the case is not vacuous)",
    );

    const second = makeWorld();
    const unmatched = second.addPage("P", { targetId: claimP ? botPage.targetId : "target-p" });
    const attached = ownership.attachContext(second.context);
    await later(20); // the reconnect is in flight now (at HEAD it has already returned)
    if (outcome === "fail") world.failLookup(botPage);
    else world.releaseLookup(botPage);
    await attached;
    await ownership.settle();
    return ownership.classify(unmatched);
  };

  // CONTROL 1: the held lookup ANSWERS an id that is not P's — nothing is unresolved,
  // so P is the operator's (proof (i)).
  assert.equal(
    await scene("answer"),
    "operator",
    "CONTROL: a bot mark whose lookup ANSWERS leaves nothing unresolved, so an unmatched page is the operator's",
  );

  // CONTROL 2: the held lookup answers P's OWN id — the reconnect claims P by id.
  assert.equal(
    await scene("answer", true),
    "bot",
    "CONTROL: when the pending lookup answers the id P lives under, the reconnect claims P as the bot's",
  );

  // THE CASE (RED at HEAD: the reconnect read "no unresolved mark" while the lookup was
  // still in flight and handed P to the operator).
  assert.equal(
    await scene("fail"),
    "bot",
    "a reconnect must WAIT for an in-flight bot mark lookup: when it then fails, that mark is unresolved and the unmatched page is BOT (fail closed)",
  );
});

// A2: a lookup that never answers bounds the reconnect, and still fails closed.
test("FIX1-T20 A2: a bot mark lookup that never answers is bounded, and the reconnect still fails closed", async () => {
  // CONTROL FIRST: with nothing in flight the reconnect is not delayed at all, and the
  // same unmatched page is the operator's.
  {
    const quick = worldWithTargetInfo();
    const quickOwnership = createPageOwnership();
    await quickOwnership.attachContext(quick.context);
    quickOwnership.markTouched(quick.addPage("B2", { targetId: "target-b2" }));
    await quickOwnership.settle();

    const quickSecond = makeWorld();
    const quickPage = quickSecond.addPage("P", { targetId: "target-p" });
    const { outcome, elapsed } = await timed(() => quickOwnership.attachContext(quickSecond.context));
    assert.equal(outcome, "done", `CONTROL: the reconnect comes back (outcome ${outcome} after ${elapsed} ms)`);
    assert.ok(elapsed < 500, `CONTROL: with nothing in flight it is not delayed (took ${elapsed} ms)`);
    assert.equal(quickOwnership.classify(quickPage), "operator", "CONTROL: …and the unmatched page is the operator's");
  }

  // THE CASE (RED at HEAD: attachContext returned at once and P was the operator's).
  const world = worldWithHeldLookup();
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  const botPage = world.addPage("B");
  world.holdLookup(botPage);
  ownership.markTouched(botPage);
  assert.ok(
    await waitFor(() => world.heldEntered(botPage) > 0),
    "the bot mark's target-id lookup really is in flight (the case is not vacuous)",
  );

  const second = makeWorld();
  const unmatched = second.addPage("P", { targetId: "target-p" });
  const { outcome, elapsed } = await timed(() => ownership.attachContext(second.context));
  assert.equal(outcome, "done", `the bounded wait has to come back (outcome ${outcome} after ${elapsed} ms)`);
  assert.ok(elapsed < 3000, `…within the 1000 ms lookup timeout plus overhead (took ${elapsed} ms)`);
  assert.equal(
    ownership.classify(unmatched),
    "bot",
    "a lookup that never answers is no answer: the mark is unresolved and the unmatched page is BOT (fail closed)",
  );
});

// A3: a POPUP mark's pending lookup is awaited by the reconnect too.
test("FIX1-T20 A3: a reconnect waits for a pending POPUP mark lookup as well", async () => {
  const scene = async (outcome) => {
    const world = worldWithHeldLookup();
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    const botPage = pageWithEvents(world.addPage("B", { targetId: "target-b" }));
    ownership.markTouched(botPage); // installs the synchronous popup listener
    await ownership.settle();

    const popup = pageWithEvents(world.addPage("Q"));
    world.holdLookup(popup);
    botPage.emitEvent("popup", popup); // the listener marks Q the bot's inside the emit
    assert.equal(ownership.classify(popup), "bot", "the popup listener marks Q the bot's with no await in between");
    assert.ok(
      await waitFor(() => world.heldEntered(popup) > 0),
      "the popup mark's target-id lookup really is in flight (the case is not vacuous)",
    );

    const second = makeWorld();
    const unmatched = second.addPage("R", { targetId: "target-r" });
    const attached = ownership.attachContext(second.context);
    await later(20);
    if (outcome === "fail") world.failLookup(popup);
    else world.releaseLookup(popup);
    await attached;
    await ownership.settle();
    return ownership.classify(unmatched);
  };

  // CONTROL: the popup's held lookup ANSWERS — nothing is unresolved, so R is the operator's.
  assert.equal(
    await scene("answer"),
    "operator",
    "CONTROL: a popup mark whose id resolves leaves nothing unresolved, so the unmatched page is the operator's",
  );

  // THE CASE (RED at HEAD: R was the operator's).
  assert.equal(
    await scene("fail"),
    "bot",
    "a popup mark whose lookup FAILS while the reconnect is in flight makes that mark unresolved, so the unmatched page is BOT (fail closed)",
  );
});

/**
 * A popup chain and its controls, all OPERATOR pages: O (there at attach) opened Q, Q
 * opened S, and an unrelated U (also there at attach) opened V. Nothing is the bot's yet.
 */
async function operatorChainScene() {
  const world = makeWorld();
  const O = world.addPage("O");
  const U = world.addPage("U");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context); // O and U: proof (i), the operator's
  const Q = world.addPage("Q", { opener: O });
  world.emitPage(Q);
  await ownership.settle();
  const S = world.addPage("S", { opener: Q });
  world.emitPage(S);
  await ownership.settle();
  const V = world.addPage("V", { opener: U });
  world.emitPage(V);
  await ownership.settle();
  return { world, ownership, O, Q, S, U, V };
}

// B1: touching a popup makes its opener chain the bot's.
test("FIX2-T20 B1: touching a popup marks it AND its opener chain the bot's; an unrelated operator page is untouched", async () => {
  const world = makeWorld();
  const O = world.addPage("O");
  const U = world.addPage("U");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  const Q = world.addPage("Q", { opener: O }); // the operator's own popup: opener() resolves O
  world.emitPage(Q);
  await ownership.settle();

  assert.equal(ownership.classify(Q), "operator", "CONTROL: a popup of a proven operator page is the operator's");
  assert.equal(ownership.classify(O), "operator", "CONTROL: …and so is its opener, before anything is touched");
  assert.equal(ownership.classify(U), "operator", "CONTROL: …and so is the unrelated operator page");

  ownership.markTouched(Q);
  await ownership.settle();
  assert.equal(ownership.classify(Q), "bot", "the page the bot drove is the bot's");
  assert.equal(
    ownership.classify(O),
    "bot",
    "…and so is the page that OPENED it: a window the bot drove came from that tab, so its opener chain is the bot's too",
  );
  assert.equal(ownership.classify(U), "operator", "CONTROL: an unrelated operator page stays the operator's");
});

// B2: transitive, in both directions down the chain.
test("FIX2-T20 B2: touching the deepest popup marks the whole chain; touching the root marks every popup it opened", async () => {
  // (a) touch S: S, Q and O are the bot's; the unrelated pair stays the operator's.
  {
    const { ownership, O, Q, S, U, V } = await operatorChainScene();
    assert.equal(ownership.classify(S), "operator", "CONTROL: the popup chain is the operator's before the touch");
    ownership.markTouched(S);
    await ownership.settle();
    assert.equal(ownership.classify(S), "bot", "the page the bot drove is the bot's");
    assert.equal(ownership.classify(Q), "bot", "…the popup that opened it too (one step up the opener chain)");
    assert.equal(ownership.classify(O), "bot", "…and the tab at the root of the chain (transitively)");
    assert.equal(ownership.classify(U), "operator", "CONTROL: the unrelated operator page stays the operator's");
    assert.equal(ownership.classify(V), "operator", "CONTROL: …and so does its own popup");
  }

  // (b) a SEPARATE scene, touch O: every popup it opened, transitively, follows.
  {
    const { ownership, O, Q, S, U, V } = await operatorChainScene();
    assert.equal(ownership.classify(Q), "operator", "CONTROL: the popups are the operator's before the touch");
    assert.equal(ownership.classify(S), "operator", "CONTROL: …the deepest one too");
    ownership.markTouched(O);
    await ownership.settle();
    assert.equal(ownership.classify(O), "bot", "the page the bot drove is the bot's");
    assert.equal(ownership.classify(Q), "bot", "…the popup it opened is the bot's too");
    assert.equal(ownership.classify(S), "bot", "…and the popup THAT popup opened (transitively)");
    assert.equal(ownership.classify(U), "operator", "CONTROL: the sibling operator page stays the operator's");
    assert.equal(ownership.classify(V), "operator", "CONTROL: …and its popup too");
  }
});

// B3: relatives known only by the CDP openerId.
test("FIX2-T20 B3: a relative known only by CDP openerId follows the touch in both directions", async () => {
  /**
   * O existed at attach (proof (i)); Q is its popup, opened with `opener()` NULL and only
   * the CDP `openerId` naming O (proof (iii)), so nothing but the id connects the two. A
   * bot page has to be owned for the openerId to be asked at all.
   */
  const scene = async () => {
    const world = worldWithTargetInfo({ openerIdFor: (page) => (page && page.name === "Q" ? "target-O" : undefined) });
    const O = world.addPage("O", { targetId: "target-O" });
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    const botPage = world.addPage("B", { targetId: "target-bot" });
    ownership.markTouched(botPage);
    await ownership.settle();

    const Q = world.addPage("Q");
    world.emitPage(Q);
    await ownership.settle();
    return { world, ownership, O, Q };
  };

  // CONTROL: Q is the operator's by proof (iii) — its openerId names the live operator
  // page O — and O stays the operator's. Nothing is touched.
  {
    const { ownership, O, Q } = await scene();
    assert.equal(ownership.classify(O), "operator", "CONTROL: the page that existed at attach is the operator's");
    assert.equal(
      ownership.classify(Q),
      "operator",
      "CONTROL: a popup whose openerId names the LIVE operator page's id is the operator's (proof (iii)) — the two are related by the id alone",
    );
  }

  // (a) touch Q: the opener NAMED ONLY BY openerId follows (RED at HEAD: O stayed the operator's).
  {
    const { ownership, O, Q } = await scene();
    ownership.markTouched(Q);
    await ownership.settle();
    assert.equal(ownership.classify(Q), "bot", "the page the bot drove is the bot's");
    assert.equal(
      ownership.classify(O),
      "bot",
      "…and the page its CDP openerId names, though opener() reported nothing: the relation is the id's",
    );
  }

  // (b) the other direction, in its own scene: touch O, and the popup named only by
  // openerId follows.
  {
    const { ownership, O, Q } = await scene();
    ownership.markTouched(O);
    await ownership.settle();
    assert.equal(ownership.classify(O), "bot", "the page the bot drove is the bot's");
    assert.equal(
      ownership.classify(Q),
      "bot",
      "…and the popup whose CDP openerId names it: every popup it opened follows the touch, however the relation was learned",
    );
  }
});

// B4: a relative that is gone, or whose own lookup fails, is simply skipped.
test("FIX2-T20 B4: a relative that is closed or whose lookup fails is skipped, and the touched page is still the bot's", async () => {
  // (a) the opener is CLOSED: touching its popup marks the popup, skips the gone relative
  // and throws nothing.
  {
    const world = makeWorld();
    const O = world.addPage("O");
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    const Q = world.addPage("Q", { opener: O });
    world.emitPage(Q);
    await ownership.settle();
    assert.equal(ownership.classify(Q), "operator", "CONTROL: the popup is the operator's before the touch");
    closeTab(world, O);
    assert.equal(O.closed, true, "the relative really is gone");

    ownership.markTouched(Q);
    await ownership.settle();
    assert.equal(ownership.classify(Q), "bot", "the touched page is still the bot's when a relative of its is gone");
  }

  // (b) a relative whose own lookup REJECTS (`opener()` throws) is skipped too: the
  // touched page is the bot's and no error escapes into the marks.
  {
    const world = makeWorld();
    const R = world.addPage("R", { openerThrows: true });
    const unrelated = world.addPage("U");
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    ownership.markTouched(R);
    await ownership.settle();
    assert.equal(ownership.classify(R), "bot", "the page the bot drove is the bot's even though its opener() rejects");
    assert.equal(ownership.classify(unrelated), "operator", "CONTROL: an unrelated page is untouched and no error escaped the marks");
  }
});

// B5 lives with the case it rewrites (section 2, "touching the opener makes its popup
// the bot's").

// B6: the relatives work starts once per page, not once per mark.
test("FIX2-T20 B6: touching the same page 50 times starts the relatives work once", async () => {
  const world = makeWorld();
  const O = world.addPage("O");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  const Q = world.addPage("Q", { opener: O });
  world.emitPage(Q);
  await ownership.settle();
  assert.equal(ownership.classify(Q), "operator", "CONTROL: the popup is the operator's before the first touch");

  ownership.markTouched(Q);
  await ownership.settle();
  assert.equal(ownership.classify(O), "bot", "the first touch marked the opener chain (the case's precondition)");
  const afterFirstTouch = { openerCalls: Q.calls.opener + O.calls.opener, sessions: world.cdpSessions };
  assert.ok(afterFirstTouch.openerCalls > 0, "the first touch asked for the opener chain (the counter is not vacuous)");

  for (let i = 0; i < 49; i++) ownership.markTouched(Q);
  await ownership.settle();
  assert.deepEqual(
    { openerCalls: Q.calls.opener + O.calls.opener, sessions: world.cdpSessions },
    afterFirstTouch,
    "49 more marks on a page that is already the bot's start no second relatives walk and open no second CDP session",
  );
  assert.equal(ownership.classify(Q), "bot", "and the page is still the bot's");
  assert.equal(ownership.classify(O), "bot", "…as is its opener chain");
});

// C1: an independent tab that arrives inside the bot-action window is the bot's.
test("FIX3-T20 C1: an independent tab arriving inside the bot-action window is BOT; outside it (and with no bot action) it is not", async () => {
  /** One arrival: a bot action at t0, the independent tab `gapMs` later, window `windowMs`. */
  const scene = async ({ windowMs, gapMs }) => {
    const world = worldWithTargetInfo();
    const botPage = world.addPage("B", { targetId: "target-bot" });
    const ownership = createPageOwnership({ botActionWindowMs: windowMs });
    await ownership.attachContext(world.context);
    ownership.markTouched(botPage);
    await ownership.settle();
    if (gapMs) await later(gapMs);
    const arrival = world.addPage("arrival");
    world.emitPage(arrival);
    await ownership.settle();
    return ownership.classify(arrival);
  };

  // CONTROL 1: the same arrival AFTER the window has passed — an independent tab.
  assert.equal(
    await scene({ windowMs: 100, gapMs: 250 }),
    "uncertain",
    "CONTROL: an independent arrival AFTER the bot-action window is 'uncertain' (left alone), as before",
  );

  // CONTROL 2: no bot action ever happened: the window claims nothing.
  {
    const world = worldWithTargetInfo();
    const ownership = createPageOwnership({ botActionWindowMs: 5000 });
    await ownership.attachContext(world.context);
    const arrival = world.addPage("arrival");
    world.emitPage(arrival);
    await ownership.settle();
    assert.equal(
      ownership.classify(arrival),
      "uncertain",
      "CONTROL: with no bot action at all, the same arrival is 'uncertain' — the window is not a blanket",
    );
  }

  // THE CASE (RED at HEAD: 'uncertain').
  assert.equal(
    await scene({ windowMs: 1000, gapMs: 50 }),
    "bot",
    "an independent tab (no opener(), a successful lookup naming no openerId) that arrives within botActionWindowMs of a bot action is BOT: ctrl-click and middle-click open exactly this shape",
  );
});

// C2: the window is measured at ARRIVAL, not at decision.
test("FIX3-T20 C2: the bot-action window is measured at ARRIVAL — a slow lookup does not lose it", async () => {
  /** A bot action at t0, then an independent arrival `gapMs` later; every CDP lookup takes 300 ms. */
  const scene = async ({ gapMs }) => {
    const world = worldWithTargetInfo({ delayMs: 300 });
    const ownership = createPageOwnership({ botActionWindowMs: 150 });
    await ownership.attachContext(world.context);
    const botPage = world.addPage("B");
    ownership.markTouched(botPage); // the bot action is at t0
    await later(gapMs);
    const arrival = world.addPage("arrival");
    world.emitPage(arrival);
    await ownership.settle(); // its openerId lookup takes 300 ms: the decision lands well after the window
    return ownership.classify(arrival);
  };

  // CONTROL: the same shape with the arrival AFTER the window — 'uncertain'. Both
  // decisions land after the window, so the difference is the ARRIVAL time alone.
  assert.equal(
    await scene({ gapMs: 200 }),
    "uncertain",
    "CONTROL: an arrival after the 150 ms window is 'uncertain', even though its lookup is just as slow",
  );

  // THE CASE (RED at HEAD: 'uncertain').
  assert.equal(
    await scene({ gapMs: 50 }),
    "bot",
    "the window is measured when the page ARRIVES (50 ms in, inside 150 ms), not when its slow openerId lookup finally decides (≈300 ms later): still BOT",
  );
});

// C3: the window does not override proof (iii).
test("FIX3-T20 C3: proof (iii) is decided before the window — an operator-proven popup inside the window is the operator's", async () => {
  const world = worldWithTargetInfo({
    openerIdFor: (page) => (page && page.name === "arrival" ? "target-operator" : undefined),
  });
  const operatorPage = world.addPage("O", { targetId: "target-operator" });
  const ownership = createPageOwnership({ botActionWindowMs: 5000 });
  await ownership.attachContext(world.context);
  const botPage = world.addPage("B", { targetId: "target-bot" });
  ownership.markTouched(botPage); // the bot action is 0 ms old: the arrival is INSIDE the window
  await ownership.settle();

  // CONTROL: in the SAME scene an independent tab that arrives now IS claimed by the
  // window, so the operator's popup below is not "operator" because the window is inert.
  const independent = world.addPage("independent");
  world.emitPage(independent);
  await ownership.settle();
  assert.equal(ownership.classify(independent), "bot", "CONTROL: the window is live in this scene — a no-openerId arrival right after the mark is BOT");

  const arrival = world.addPage("arrival");
  world.emitPage(arrival);
  await ownership.settle();
  assert.equal(
    ownership.classify(arrival),
    "operator",
    "a popup whose openerId names a LIVE page classed operator is the operator's (proof (iii)), even though it arrived inside the bot-action window: the window never overrides a proof",
  );
});

// D1: proof (iii) re-checks its candidate's class after the await.
test("FIX3-T20 D1: a candidate marked BOT while proof (iii) awaits its target id proves nothing", async () => {
  /**
   * The arrival's `openerId` names the operator page O, so proof (iii) resolves O's target
   * id — a lookup that is HELD. `touchWhileAwaited` marks O the bot's during that await.
   */
  const scene = async ({ touchWhileAwaited }) => {
    const world = worldWithHeldLookup({
      openerIdFor: (page) => (page && page.name === "arrival" ? "target-operator" : undefined),
    });
    const operatorPage = world.addPage("O", { targetId: "target-operator" });
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    const botPage = world.addPage("B", { targetId: "target-bot" });
    ownership.markTouched(botPage);
    await ownership.settle();
    assert.equal(ownership.classify(operatorPage), "operator", "the candidate existed at attach (proof (i))");

    world.holdLookup(operatorPage); // proof (iii)'s on-demand lookup of the candidate hangs
    const arrival = world.addPage("arrival");
    world.emitPage(arrival);
    assert.ok(
      await waitFor(() => world.heldEntered(operatorPage) > 0),
      "proof (iii) is awaiting the candidate's target id (the case is not vacuous)",
    );
    if (touchWhileAwaited) ownership.markTouched(operatorPage); // the candidate changes hands DURING the await
    world.releaseLookup(operatorPage);
    await ownership.settle();
    return ownership.classify(arrival);
  };

  // CONTROL: the candidate stays the operator's, so the id it answers IS proof.
  assert.equal(
    await scene({ touchWhileAwaited: false }),
    "operator",
    "CONTROL: a candidate that stays the operator's proves the arrival (proof (iii)): the arrival is the operator's",
  );

  // THE CASE (RED at HEAD: the stale "operator" read before the await made the arrival
  // the operator's).
  assert.equal(
    await scene({ touchWhileAwaited: true }),
    "bot",
    "a candidate marked BOT while proof (iii) awaits its id is no longer proof: the scan re-checks the class after the await, so the arrival is BOT (fail closed)",
  );
});

// ---------------------------------------------------------------------------
// 16. T22: the round-10 findings (RED tests, tests only)
//
//   A  relations learned LATE. The relatives walk has to wait for the arrival
//      classifications it depends on (A1); an opener relation has to be recorded
//      even when a mark already landed on the page, including on a page that was
//      classed before its "page" event fired (A2); and a relation learned for a
//      page ALREADY touched has to mark the counterpart at that moment (A3).
//   B  PRE-EXISTING relatives. A page that existed at attach has no recorded
//      relation at all, so touching it (or its popup) proves nothing at HEAD. The
//      whole connected opener/popup component has to be learned at touch time:
//      the popup (B1), the chain above it (B2), the same shapes after a reconnect
//      (B3), and the SIBLING popups a popup reachable through its opener (B4).
//   C  walk robustness. A walk whose lookup failed must not burn the one walk a
//      page gets (C1); the walk has ONE overall deadline and parallel candidate
//      lookups (C2); and a mark whose lookup is STILL pending when a reconnect
//      decides has to count as unresolved (C3 — kept as a control if HEAD's
//      bounded lookups already give it).
//   D  the bot-action window is anchored to the ACTION, not to its start:
//      beginBotAction()/endBotAction() (nestable) plus an arrival-time snapshot
//      (D1–D4). RED at HEAD because the two methods do not exist yet.
//   E  server.js wraps server.tool AFTER installLeaseGuard, before the first
//      registration, so every tool handler runs between begin and end — proven
//      behaviourally against wrapToolWithBotAction(server, ownership) and
//      statically for the server.js wiring. The END is the handler's PROMISE
//      SETTLING, not the handler returning it (E2): a slow call is still an open
//      action — and its tab still arrives inside it — while it runs.
//
// The product code is the NEXT task's (I22). Every case carries its control, so a
// fail-closed rule cannot pass by making everything the bot's, and every case is
// RED at HEAD where the finding is (the failure is the bug report).
// ---------------------------------------------------------------------------

/**
 * `ownership[name]`, asserted to exist (T22-D): a missing method has to be a
 * readable failure, not a bare TypeError three lines into the scene.
 */
function botAction(ownership, name) {
  assert.equal(
    typeof ownership[name],
    "function",
    `page-ownership.js must provide ownership.${name}() (T22-D): the bot-action window is anchored to the action, not to its start`,
  );
  return ownership[name].bind(ownership);
}

/**
 * Count the calls to the real beginBotAction/endBotAction, and let the real state
 * change happen (so a case can tell "an action is in progress" from "the counter was
 * bumped"). Installed BEFORE the wrapper is wrapped, so a wrapper that binds the
 * methods at install time is counted too.
 */
function spyBotActions(ownership) {
  const calls = [];
  for (const name of ["beginBotAction", "endBotAction"]) {
    const real = botAction(ownership, name);
    ownership[name] = (...args) => {
      calls.push(name);
      return real(...args);
    };
  }
  return calls;
}

/**
 * A promise nobody has settled yet, plus the two ways to settle it (T22-E2): a slow
 * tool handler hands its promise back and the test decides when the call is done.
 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A fake McpServer: `tool(name, ...rest)` records the registration and returns a marker.
 * Only `tool` is used — that is the one method `wrapToolWithBotAction` touches.
 */
function fakeToolServer() {
  const registered = [];
  const server = {
    tool(name, ...rest) {
      registered.push({ name, args: rest });
      return `registered:${name}`;
    },
  };
  return { server, registered };
}

// A1: the walk waits for the arrival classifications it depends on.
test("T22-A1: a touch waits for the arrival classifications it needs — an operator popup whose opener() is still in flight follows the touch", async () => {
  /**
   * O and U existed at attach (proof (i): the operator's). Q is the operator's popup of
   * O, and its `opener()` is a real 200 ms round trip, so the arrival classification is
   * still in flight when the bot touches O.
   *
   * `touchAfterSettle` is the control: the same scene with the touch after Q has been
   * classified (the relation is known by then).
   */
  const scene = async ({ touchAfterSettle }) => {
    const world = makeWorld();
    const O = world.addPage("O");
    const U = world.addPage("U");
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context); // O and U: proof (i), the operator's
    const Q = world.addPage("Q", { opener: O, openerDelayMs: 200 });
    world.emitPage(Q); // Q's classification starts; its opener() is 200 ms away
    if (touchAfterSettle) {
      await ownership.settle(); // CONTROL: the touch lands after Q settled
    } else {
      await later(20); // the bot touches O while Q is still being classified
    }
    const atTouch = { openerCalls: Q.calls.opener };
    ownership.markTouched(O);
    await ownership.settle();
    return { ownership, O, Q, U, atTouch };
  };

  // CONTROL: the same scene, same window, the touch after Q settled — Q is the bot's (the
  // relation `Q.opener() -> O` is recorded by then), and U stays the operator's.
  {
    const { ownership, O, Q, U } = await scene({ touchAfterSettle: true });
    assert.equal(ownership.classify(O), "bot", "CONTROL: the touched page is the bot's");
    assert.equal(
      ownership.classify(Q),
      "bot",
      "CONTROL: touching O AFTER Q settled marks the popup Q the operator's page opened — the relation is known",
    );
    assert.equal(ownership.classify(U), "operator", "CONTROL: an unrelated operator page stays the operator's");
  }

  // THE CASE (RED at HEAD: Q ends as 'operator'). The walk for O runs at 20 ms, before
  // Q's classification has recorded the `O -> Q` relation, and finds nothing; the walk is
  // recorded as done (`relativesWalked`), so nothing ever retries it, and the touch of the
  // page that OPENED Q never reaches Q.
  {
    const { ownership, O, Q, U, atTouch } = await scene({ touchAfterSettle: false });
    assert.equal(ownership.classify(O), "bot", "the touched page is the bot's");
    assert.equal(
      atTouch.openerCalls,
      1,
      "the case is not vacuous: Q's arrival classification was in flight (its slow opener() had been asked once) when the touch landed",
    );
    assert.equal(
      ownership.classify(Q),
      "bot",
      "a popup of a page the bot drove is the bot's even when its own arrival classification was still in flight at the touch: the walk must wait for the classifications it depends on (a bot-driven page reaches its popups, and that script outlives the turn)",
    );
    assert.equal(ownership.classify(U), "operator", "CONTROL: an unrelated operator page stays the operator's");
  }
});

// A2: an opener relation is recorded even when a mark already landed.
test("T22-A2: the opener relation is recorded even when a mark already landed — and even for a page classed BEFORE its event fired", async () => {
  // (a) a mark lands while opener() is in flight. HEAD already passes this half (the walk
  // asks the touched page's own opener() as a fallback), so it is kept as a CONTROL: the
  // relation survives a mark that lands mid-flight.
  {
    const world = makeWorld();
    const O = world.addPage("O");
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    const Q = world.addPage("Q", { opener: O, openerDelayMs: 200 });
    world.emitPage(Q); // the classification starts
    await later(20);
    ownership.markTouched(Q); // a mark lands while opener() is still in flight
    await ownership.settle();
    assert.equal(ownership.classify(Q), "bot", "the page the bot drove is the bot's, whatever its arrival would have said");
    assert.equal(
      ownership.classify(O),
      "bot",
      "CONTROL: the relation Q -> O survives the mark landing mid-flight: the page that opened the bot's page is the bot's too",
    );
  }

  // (b) THE RED HALF: a page classed BEFORE its "page" event fires. The event must still
  // record the relation, or the chain above a bot page is lost for good.
  //   O (operator, existed at attach) -> Q (marked BOT before its event) -> R (a popup of
  //   Q, arrived through the event path). Touching R has to reach O through Q.
  {
    const world = makeWorld();
    const O = world.addPage("O");
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    const Q = world.addPage("Q", { opener: O });
    ownership.markOpened(Q); // Q is classed BOT before its "page" event fires
    await ownership.settle();
    assert.equal(ownership.classify(Q), "bot", "the mark landed first (the case's shape)");
    world.emitPage(Q); // …and now the event fires for a page that is already classed
    await ownership.settle();
    assert.equal(ownership.classify(O), "operator", "CONTROL: the event must not CHANGE a class — O is still the operator's here");

    const R = world.addPage("R", { opener: Q });
    world.emitPage(R);
    await ownership.settle();
    assert.equal(ownership.classify(R), "bot", "CONTROL: R is a popup of a bot page, so it arrives as the bot's");

    ownership.markTouched(R);
    await ownership.settle();
    assert.equal(ownership.classify(R), "bot", "the page the bot drove is the bot's");
    assert.equal(ownership.classify(Q), "bot", "…the page that opened it too");
    assert.equal(
      ownership.classify(O),
      "bot",
      "a page classed BEFORE its \"page\" event fired still has its opener relation recorded: the chain R -> Q -> O follows to the top (RED at HEAD: the early return in considerArrival skipped noteRelation, so O stayed the operator's while a script in R can reach it through window.opener)",
    );
  }
});

// A3: a relation learned for a page ALREADY touched marks the counterpart at that moment.
test("T22-A3: a relation learned late marks the already-touched counterpart at that moment", async () => {
  // (a) touch O first; the popup Q of O arrives afterwards.
  {
    const world = makeWorld();
    const O = world.addPage("O");
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    ownership.markTouched(O);
    await ownership.settle();
    assert.equal(ownership.classify(O), "bot", "the touched page is the bot's");
    const Q = world.addPage("Q", { opener: O });
    world.emitPage(Q);
    await ownership.settle();
    assert.equal(
      ownership.classify(Q),
      "bot",
      "a popup that arrives AFTER its opener was touched is the bot's (the popup listener, or the arrival that names an opener the bot owns)",
    );
  }

  // (b) THE RED HALF: touch Q first, and learn the relation to O later from the CDP
  // `openerId` (Q's `opener()` says nothing). When the relation lands, O is the bot's.
  {
    const world = worldWithTargetInfo({
      openerIdFor: (page) => (page && page.name === "Q" ? "target-O" : undefined),
      delayMs: 150, // the openerId lookup is a real round trip
    });
    const O = world.addPage("O", { targetId: "target-O" });
    const ownership = createPageOwnership({ botActionWindowMs: 100 });
    await ownership.attachContext(world.context);
    const botPage = world.addPage("B", { targetId: "target-bot" });
    ownership.markTouched(botPage); // a bot page has to be owned for the openerId to be asked
    await ownership.settle();
    await later(150); // past the window: nothing here is claimed by the clock
    assert.equal(ownership.classify(O), "operator", "CONTROL: O existed at attach (proof (i))");

    const Q = world.addPage("Q"); // opener() answers nothing: only the CDP openerId connects Q to O
    world.emitPage(Q); // the classification starts; its openerId lookup is 150 ms away
    await later(20);
    ownership.markTouched(Q); // the bot touches Q WHILE that lookup is in flight
    assert.equal(ownership.classify(Q), "bot", "the touched page is the bot's");
    await ownership.settle();
    assert.equal(
      ownership.classify(O),
      "bot",
      "an openerId relation learned AFTER the page was touched still marks the counterpart: the page the bot drove was opened by O, so a script in Q reaches O (RED at HEAD: the early return after the lookup dropped the relation)",
    );
  }

  // (c) CONTROL: a relation learned for a page that is NOT the bot's marks nothing.
  {
    const world = worldWithTargetInfo({
      openerIdFor: (page) => (page && page.name === "S" ? "target-O" : undefined),
    });
    const O = world.addPage("O", { targetId: "target-O" });
    const ownership = createPageOwnership({ botActionWindowMs: 100 });
    await ownership.attachContext(world.context);
    const botPage = world.addPage("B", { targetId: "target-bot" });
    ownership.markTouched(botPage);
    await ownership.settle();
    await later(150);
    const S = world.addPage("S");
    world.emitPage(S);
    await ownership.settle();
    assert.equal(ownership.classify(S), "operator", "CONTROL: S is a popup of the live operator page O (proof (iii))");
    assert.equal(
      ownership.classify(O),
      "operator",
      "CONTROL: a relation learned for a page the bot never drove marks its counterpart not at all",
    );
  }
});

// B1: a pre-existing popup follows the touch of its opener.
test("T22-B1: pre-existing relatives — touching an operator tab marks the popup it had already opened", async () => {
  const world = worldWithTargetInfo();
  const U = world.addPage("U"); // an unrelated pre-existing tab
  const P = world.addPage("P"); // the operator's tab
  const Q = world.addPage("Q", { opener: P }); // the popup it opened — also open at attach
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  assert.equal(ownership.classify(P), "operator", "CONTROL: a page that existed at attach is the operator's (proof (i))");
  assert.equal(ownership.classify(Q), "operator", "CONTROL: …and so is its popup, and the unrelated tab");
  assert.equal(ownership.classify(U), "operator", "CONTROL: …the unrelated tab too");

  ownership.markTouched(P);
  await ownership.settle();
  assert.equal(ownership.classify(P), "bot", "the page the bot drove is the bot's");
  assert.equal(
    ownership.classify(Q),
    "bot",
    "a popup that already existed at attach follows the touch of its opener: a script in P reaches it, and a page that old has no recorded relation to help (RED at HEAD: the popup stayed the operator's)",
  );
  assert.equal(ownership.classify(U), "operator", "CONTROL: an unrelated pre-existing tab stays the operator's");
});

// B2: a pre-existing chain, transitively upward.
test("T22-B2: pre-existing chain G -> O -> R — touching R marks O AND G", async () => {
  const world = worldWithTargetInfo();
  const G = world.addPage("G");
  const O = world.addPage("O", { opener: G });
  const R = world.addPage("R", { opener: O });
  const W = world.addPage("W"); // unrelated
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  assert.equal(ownership.classify(R), "operator", "CONTROL: the whole chain is the operator's before the touch");
  assert.equal(ownership.classify(O), "operator", "CONTROL: …the middle link too");
  assert.equal(ownership.classify(G), "operator", "CONTROL: …and the root");

  ownership.markTouched(R);
  await ownership.settle();
  assert.equal(ownership.classify(R), "bot", "the page the bot drove is the bot's");
  assert.equal(ownership.classify(O), "bot", "…the page that opened it too (one step up the opener chain)");
  assert.equal(
    ownership.classify(G),
    "bot",
    "…and the tab at the ROOT of a chain that was already open at attach (RED at HEAD: G stayed the operator's, because only one live opener() call is ever made for the touched page)",
  );
  assert.equal(ownership.classify(W), "operator", "CONTROL: an unrelated pre-existing page stays the operator's");
});

// B3: the same shapes after a reconnect, and no unbounded opener() growth.
test("T22-B3: the pre-existing shapes still work for the pages of a RE-ATTACHED context", async () => {
  const first = worldWithTargetInfo();
  first.addPage("old-tab");
  const ownership = createPageOwnership();
  await ownership.attachContext(first.context);

  // A reconnect: the same browser, NEW Page objects for the tabs that are open now.
  const second = worldWithTargetInfo();
  const U2 = second.addPage("U2");
  const P2 = second.addPage("P2");
  const Q2 = second.addPage("Q2", { opener: P2 });
  await ownership.attachContext(second.context);
  assert.equal(ownership.classify(P2), "operator", "CONTROL: the pages of the re-attached context are the operator's (proof (i))");
  assert.equal(ownership.classify(Q2), "operator", "CONTROL: …its popup too");

  ownership.markTouched(P2);
  await ownership.settle();
  assert.equal(ownership.classify(P2), "bot", "the touched page of the new context is the bot's");
  assert.equal(
    ownership.classify(Q2),
    "bot",
    "a popup of the same tab after a reconnect follows the touch too (RED at HEAD: no relation was ever recorded for either page)",
  );
  assert.equal(ownership.classify(U2), "operator", "CONTROL: an unrelated pre-existing page of the new context stays the operator's");

  // CONTROL (Opus minor): the walks are bounded — 50 more touches start no new work.
  const before = { opener: P2.calls.opener + Q2.calls.opener, sessions: second.cdpSessions };
  assert.ok(before.opener > 0 || before.sessions > 0, "the first touch did ask the browser something (the counter is not vacuous)");
  for (let i = 0; i < 50; i++) ownership.markTouched(P2);
  await ownership.settle();
  assert.deepEqual(
    { opener: P2.calls.opener + Q2.calls.opener, sessions: second.cdpSessions },
    before,
    "CONTROL: 50 more touches of the same page add no opener() call and no CDP session — the relation work does not grow without bound",
  );
});

// B4: sibling popups are one connected component.
test("T22-B4: sibling popups — touching R marks O AND S (a script in R reaches S through O)", async () => {
  const world = worldWithTargetInfo();
  const O = world.addPage("O");
  const R = world.addPage("R", { opener: O });
  const S = world.addPage("S", { opener: O });
  const U = world.addPage("U"); // unrelated
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  assert.equal(ownership.classify(R), "operator", "CONTROL: the popups are the operator's before the touch");
  assert.equal(ownership.classify(S), "operator", "CONTROL: …both of them");

  ownership.markTouched(R);
  await ownership.settle();
  assert.equal(ownership.classify(R), "bot", "the page the bot drove is the bot's");
  assert.equal(ownership.classify(O), "bot", "…the tab that opened it too");
  assert.equal(
    ownership.classify(S),
    "bot",
    "…and the SIBLING popup: a script in R reaches S through window.opener, so the whole connected opener/popup component is the bot's (RED at HEAD: S stayed the operator's)",
  );
  assert.equal(ownership.classify(U), "operator", "CONTROL: an unrelated pre-existing page stays the operator's");
});

// C1: a failed lookup does not burn the one walk a page gets.
test("T22-C1: a walk whose lookup failed is retried by a later touch; a complete walk is not repeated", async () => {
  /**
   * The scene: O is the operator's page that Q came from, and Q's `opener()` says nothing,
   * so the only relation is Q's CDP `openerId`. `state.failOpenerLookup` makes O's id
   * unanswerable — the walk finds nothing either way.
   */
  const scene = () => {
    const state = { failOpenerLookup: true };
    const world = worldWithTargetInfo({
      openerIdFor: (page) => (page && page.name === "Q" ? "target-O" : undefined),
      throwFor: (page) => state.failOpenerLookup && Boolean(page) && page.name === "O",
    });
    const O = world.addPage("O", { targetId: "target-O" });
    const ownership = createPageOwnership({ botActionWindowMs: 100 });
    return { state, world, O, ownership };
  };

  // THE CASE (RED at HEAD: `relativesWalked` blocks the second touch, so O stays the
  // operator's for the life of the process).
  {
    const { state, world, O, ownership } = scene();
    await ownership.attachContext(world.context);
    const botPage = world.addPage("B", { targetId: "target-bot" });
    ownership.markTouched(botPage);
    await ownership.settle();
    await later(150);

    const Q = world.addPage("Q");
    world.emitPage(Q);
    await ownership.settle(); // Q's openerId names O, which cannot answer: Q fails closed (BOT)
    assert.equal(ownership.classify(O), "operator", "CONTROL: O is the operator's page, and its id cannot be had");

    ownership.markTouched(Q);
    await ownership.settle();
    assert.equal(ownership.classify(O), "operator", "the failing lookup really did leave O the operator's (the case's precondition)");

    state.failOpenerLookup = false; // the browser answers again
    ownership.markTouched(Q); // the same page, touched again
    await ownership.settle();
    assert.equal(
      ownership.classify(O),
      "bot",
      "a walk whose lookup failed must not be recorded as done: the later touch, with the lookup working, follows the relation to O (RED at HEAD: the page was already in relativesWalked)",
    );
  }

  // CONTROL: a COMPLETE walk is not repeated — 50 more touches add no opener()/CDP work.
  {
    const world = worldWithTargetInfo({ openerIdFor: (page) => (page && page.name === "Q" ? "target-O" : undefined) });
    const O = world.addPage("O", { targetId: "target-O" });
    const ownership = createPageOwnership({ botActionWindowMs: 100 });
    await ownership.attachContext(world.context);
    const botPage = world.addPage("B", { targetId: "target-bot" });
    ownership.markTouched(botPage);
    await ownership.settle();
    await later(150);
    const Q = world.addPage("Q");
    world.emitPage(Q);
    await ownership.settle();

    ownership.markTouched(Q);
    await ownership.settle();
    assert.equal(ownership.classify(O), "bot", "the first touch follows the relation (the case's precondition)");
    const before = { opener: Q.calls.opener + O.calls.opener, sessions: world.cdpSessions };
    assert.ok(before.sessions > 0, "the first touch did ask the browser something (the counter is not vacuous)");

    for (let i = 0; i < 50; i++) ownership.markTouched(Q);
    await ownership.settle();
    assert.deepEqual(
      { opener: Q.calls.opener + O.calls.opener, sessions: world.cdpSessions },
      before,
      "CONTROL: a COMPLETE walk is not repeated — 50 more touches add no opener() call and no CDP session",
    );
    assert.equal(ownership.classify(Q), "bot", "and the touched page is still the bot's");
  }
});

// C2: one overall deadline, and parallel candidate lookups.
test("T22-C2: the relative walk has ONE overall deadline and looks candidates up in parallel", async () => {
  // 12 live pages, and every CDP lookup is a 900 ms round trip: a walk that resolves each
  // candidate one after the other needs ~11 s, and one with no deadline at all can never
  // come back.
  const world = worldWithTargetInfo({ delayMs: 900 });
  const ownership = createPageOwnership();
  const live = [];
  for (let i = 0; i < 12; i++) live.push(world.addPage(`L${i}`, { targetId: `target-l${i}` }));
  await ownership.attachContext(world.context); // nothing of the bot's yet: no CDP call at all

  const touched = live[0];
  ownership.markTouched(touched); // the walk this case times starts here
  const { outcome, elapsed } = await timed(async () => {
    await ownership.settle(); // waits for the mark's lookup AND the tracked walk
  }, 3500);
  assert.equal(outcome, "done", `the tracked walk has to come back (outcome ${outcome} after ${elapsed} ms)`);
  assert.ok(
    elapsed < 3500,
    `the whole walk finishes well under the 3500 ms ceiling: one overall deadline (~1500 ms) and parallel candidate lookups, not a lookup per candidate in series (took ${elapsed} ms)`,
  );
  assert.equal(ownership.classify(touched), "bot", "the touched page is the bot's");
  assert.ok(
    touched.calls.newCDPSession > 0,
    "the case is not vacuous: the walk really did have to ask the browser for a target id",
  );
});

// C3: a mark whose lookup is STILL pending when the reconnect decides.
test("T22-C3: a mark whose lookup is still pending at the reconnect's decision counts as unresolved (the unmatched page is BOT)", async () => {
  // NOTE: HEAD's bounded lookups may already make this one green (the held lookup is
  // timed out at TARGET_LOOKUP_TIMEOUT_MS, which the reconnect's settle() awaits, and a
  // timed-out mark counts as unresolved). It is kept as the control for the FIX1 residual
  // either way; the runner output says which it is.
  const world = worldWithHeldLookup();
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  const botPage = world.addPage("B");
  world.holdLookup(botPage);
  ownership.markTouched(botPage);
  assert.ok(
    await waitFor(() => world.heldEntered(botPage) > 0),
    "the mark's target-id lookup really is in flight (the case is not vacuous)",
  );

  const second = makeWorld();
  const unmatched = second.addPage("P", { targetId: "target-p" });
  const { outcome } = await timed(() => ownership.attachContext(second.context));
  assert.equal(outcome, "done", `the reconnect has to come back (outcome ${outcome})`);
  assert.equal(
    ownership.classify(unmatched),
    "bot",
    "a mark whose lookup is still pending when the reconnect decides must not be read as resolved: it can be ANY tab, so the unmatched page is BOT (fail closed)",
  );
  assert.equal(unresolvedSeam(ownership), 1, "…and it stays counted as unresolved afterwards");
});

// D1: a running action claims an arrival, however long it has been running.
test("T22-D1: a bot action IN PROGRESS claims an independent arrival, even long past the window", async () => {
  const world = worldWithTargetInfo();
  const ownership = createPageOwnership({ botActionWindowMs: 200 });
  await ownership.attachContext(world.context);
  const botPage = world.addPage("B", { targetId: "target-bot" });
  ownership.markTouched(botPage);
  await ownership.settle();
  await later(300); // past the 200 ms window: the clock alone claims nothing now

  // CONTROL 1: the same arrival with no action in progress → 'uncertain'.
  const control = world.addPage("control");
  world.emitPage(control);
  await ownership.settle();
  assert.equal(
    ownership.classify(control),
    "uncertain",
    "CONTROL: an independent arrival (no opener, a lookup that names no openerId) after the window, with no action in progress, is 'uncertain'",
  );

  // THE CASE (RED at HEAD: beginBotAction() does not exist).
  const begin = botAction(ownership, "beginBotAction");
  const end = botAction(ownership, "endBotAction");
  begin();
  await later(500); // 500 ms into the action: the window is long gone, only the action is left
  const arrival = world.addPage("arrival");
  world.emitPage(arrival);
  await ownership.settle();
  assert.equal(
    ownership.classify(arrival),
    "bot",
    "an arrival with no opener and no openerId is BOT while a bot action is in progress (beginBotAction with no matching endBotAction), however long the action runs: a slow click's tab arrives at the END, not at the start",
  );

  // CONTROL 2: the action ends and the window passes → 'uncertain' again.
  end();
  await later(400);
  const after = world.addPage("after");
  world.emitPage(after);
  await ownership.settle();
  assert.equal(ownership.classify(after), "uncertain", "CONTROL: after endBotAction and past the window the same arrival is 'uncertain' again");

  // CONTROL 3: no bot action ever → 'uncertain'.
  {
    const fresh = worldWithTargetInfo();
    const freshOwnership = createPageOwnership({ botActionWindowMs: 200 });
    await freshOwnership.attachContext(fresh.context);
    const never = fresh.addPage("never");
    fresh.emitPage(never);
    await freshOwnership.settle();
    assert.equal(freshOwnership.classify(never), "uncertain", "CONTROL: with no bot action ever, the same arrival is 'uncertain'");
  }
});

// D2: the window is live after the call returns.
test("T22-D2: an arrival inside the window AFTER the call returned is BOT", async () => {
  const world = worldWithTargetInfo();
  const ownership = createPageOwnership({ botActionWindowMs: 300 });
  await ownership.attachContext(world.context);
  const botPage = world.addPage("B", { targetId: "target-bot" });
  ownership.markTouched(botPage);
  await ownership.settle();
  await later(400); // the mark is outside the window now: only the call below is left

  const begin = botAction(ownership, "beginBotAction");
  const end = botAction(ownership, "endBotAction");
  begin();
  end(); // one tool call: begin and end together
  await later(100); // 100 ms after the call returned, inside the 300 ms window
  const arrival = world.addPage("arrival");
  world.emitPage(arrival);
  await ownership.settle();
  assert.equal(
    ownership.classify(arrival),
    "bot",
    "an independent arrival 100 ms after endBotAction is BOT: the window is measured from the END of the action too, so a tab the click produced just after the call returned is still the bot's (RED at HEAD: the methods do not exist)",
  );

  // CONTROL: the same arrival after the window → 'uncertain'.
  begin();
  end();
  await later(400);
  const late = world.addPage("late");
  world.emitPage(late);
  await ownership.settle();
  assert.equal(ownership.classify(late), "uncertain", "CONTROL: 400 ms after the call, past the 300 ms window, the same arrival is 'uncertain'");
});

// D3: the arrival-time snapshot, never the latest timestamp.
test("T22-D3: the window uses the ARRIVAL-time snapshot, never the latest bot timestamp", async () => {
  /**
   * The bot action at t0, the arrival at `arrivalGapMs`, then a LATER tool call 100 ms
   * after the arrival, and only then the arrival's slow (300 ms) openerId lookup answers.
   */
  const scene = async ({ arrivalGapMs }) => {
    const world = worldWithTargetInfo({ delayMs: 300 });
    const ownership = createPageOwnership({ botActionWindowMs: 300 });
    await ownership.attachContext(world.context);
    const p0 = world.addPage("p0", { targetId: "target-p0" });
    ownership.markTouched(p0); // the bot action, at t0
    await later(arrivalGapMs);
    const arrival = world.addPage("arrival");
    world.emitPage(arrival);
    await later(100);
    ownership.markTouched(p0); // a LATER tool call: the latest timestamp is now AFTER the arrival
    await ownership.settle(); // the arrival's openerId lookup answers well after both
    return ownership.classify(arrival);
  };

  // THE CASE (RED at HEAD: 'uncertain' — the decision reads the LATEST timestamp, which is
  // the second mark 100 ms AFTER the arrival). The arrival was 100 ms after an action, i.e.
  // inside the 300 ms window AT THE MOMENT IT ARRIVED, which is what decides it.
  assert.equal(
    await scene({ arrivalGapMs: 100 }),
    "bot",
    "the window is taken when the page ARRIVES: an arrival 100 ms after a bot action is BOT even though a later tool call moves the latest timestamp past it while its lookup is still in flight (RED at HEAD: 'uncertain')",
  );

  // CONTROL: the same scene with the arrival OUTSIDE the window — 'uncertain' (the later
  // mark does not claim it either, and the snapshot agrees).
  assert.equal(
    await scene({ arrivalGapMs: 400 }),
    "uncertain",
    "CONTROL: the same tab arriving 400 ms after the action, past the 300 ms window, is 'uncertain'",
  );

  // CONTROL: the same tab arriving long before ANY bot action → 'uncertain'.
  {
    const world = worldWithTargetInfo({ delayMs: 300 });
    const ownership = createPageOwnership({ botActionWindowMs: 300 });
    await ownership.attachContext(world.context);
    const arrival = world.addPage("arrival");
    world.emitPage(arrival);
    await later(50);
    const p0 = world.addPage("p0");
    ownership.markTouched(p0);
    await ownership.settle();
    assert.equal(ownership.classify(arrival), "uncertain", "CONTROL: an arrival that lands before any bot action is 'uncertain' — the window never looks backwards");
  }
});

// D4: the proofs still come first.
test("T22-D4: proof (iii) is decided before the action — an operator-proven popup inside a running action stays the operator's", async () => {
  const world = worldWithTargetInfo({
    openerIdFor: (page) => (page && page.name === "arrival" ? "target-operator" : undefined),
  });
  const operatorPage = world.addPage("O", { targetId: "target-operator" });
  const ownership = createPageOwnership({ botActionWindowMs: 150 });
  await ownership.attachContext(world.context);
  const botPage = world.addPage("B", { targetId: "target-bot" });
  ownership.markTouched(botPage);
  await ownership.settle();
  await later(300); // outside the window: only the running action is left
  assert.equal(ownership.classify(operatorPage), "operator", "the operator page existed at attach (proof (i))");

  const begin = botAction(ownership, "beginBotAction");
  const end = botAction(ownership, "endBotAction");
  begin();

  // CONTROL: the action really is live — a no-openerId arrival right now is BOT.
  const independent = world.addPage("independent");
  world.emitPage(independent);
  await ownership.settle();
  assert.equal(ownership.classify(independent), "bot", "CONTROL: the running action is live in this scene — an independent arrival is BOT");

  const arrival = world.addPage("arrival");
  world.emitPage(arrival);
  await ownership.settle();
  end();
  assert.equal(
    ownership.classify(arrival),
    "operator",
    "a popup whose openerId names a LIVE page classed operator is the operator's (proof (iii)) — the action/window never overrides a proof",
  );
});

// E (behavioural): the tool-handler wrapper the server installs.
test("T22-E: wrapToolWithBotAction puts every handler between beginBotAction and endBotAction (success and throw)", async () => {
  const wrap = ownershipModule.wrapToolWithBotAction;
  assert.equal(
    typeof wrap,
    "function",
    "page-ownership.js must export wrapToolWithBotAction(server, ownership): server.js installs it so every registered tool handler runs inside a bot action",
  );

  // (a) registrations pass through: the name, the non-function arguments and the RETURN
  // VALUE of server.tool are the caller's, and only the handler is replaced.
  {
    const ownership = createPageOwnership();
    const calls = spyBotActions(ownership);
    const { server, registered } = fakeToolServer();
    wrap(server, ownership);

    const schema = { inputSchema: { type: "object" } };
    const handler = async () => "acted";
    const returned = server.tool("demo_tool", "a description", schema, handler);
    assert.equal(returned, "registered:demo_tool", "the wrapper returns whatever server.tool returned");
    assert.equal(registered.length, 1, "the registration reaches the server once");
    assert.equal(registered[0].name, "demo_tool", "the tool name is untouched");
    assert.equal(registered[0].args[0], "a description", "a non-function argument before the handler is untouched (same value)");
    assert.equal(registered[0].args[1], schema, "…the schema too (same object)");
    assert.equal(typeof registered[0].args[2], "function", "the handler slot still holds a function");
    assert.ok(registered[0].args[2] !== handler, "…the WRAPPED one, not the handler the caller passed");
    assert.deepEqual(calls, [], "registering a tool begins no action: only CALLING it does");

    // A registration whose last argument is not a function is left completely alone.
    const meta = { title: "no handler here" };
    server.tool("meta_only", meta);
    assert.equal(registered[1].args.length, 1, "one argument in, one argument out");
    assert.equal(registered[1].args[0], meta, "a registration with no handler is unchanged");
  }

  // (b) the handler runs BETWEEN begin and end, with its arguments, its `this` and its
  // return value preserved — and the action is closed again afterwards.
  {
    const ownership = createPageOwnership();
    const calls = spyBotActions(ownership);
    const { server, registered } = fakeToolServer();
    wrap(server, ownership);

    const ctx = { name: "the MCP server" };
    const seen = {};
    function handler(a, b) {
      seen.args = [a, b];
      seen.this = this;
      seen.callsDuring = calls.slice();
      return { content: [{ type: "text", text: "acted" }] };
    }
    server.tool("demo_tool", {}, handler);
    const wrapped = registered[0].args[1];
    const result = wrapped.call(ctx, 1, 2);
    assert.deepEqual(seen.args, [1, 2], "the handler gets the arguments the caller passed");
    assert.equal(seen.this, ctx, "the handler is called with the caller's `this`");
    assert.deepEqual(seen.callsDuring, ["beginBotAction"], "beginBotAction runs BEFORE the handler, and endBotAction has not run yet");
    assert.deepEqual(result, { content: [{ type: "text", text: "acted" }] }, "the handler's return value passes through");
    assert.deepEqual(calls, ["beginBotAction", "endBotAction"], "…and the action is ended once the handler returned");
  }

  // (c) a handler that THROWS still ends the action: an action left in progress would
  // claim every later arrival as the bot's. An `async` handler's throw is a REJECTED
  // PROMISE, never a synchronous throw — `assert.throws` on it could only pass if the
  // wrapper threw before it ever called the handler, so `assert.rejects` is the right
  // form here. The SYNCHRONOUS throw is the separate case below, where `assert.throws`
  // is.
  {
    const ownership = createPageOwnership();
    const calls = spyBotActions(ownership);
    const { server, registered } = fakeToolServer();
    wrap(server, ownership);

    const boom = new Error("the tool threw");
    server.tool("throws_async", {}, async () => { throw boom; });
    const wrappedAsync = registered[0].args[1];
    await assert.rejects(
      wrappedAsync(),
      (err) => err === boom,
      "the async handler's rejection propagates unchanged (an async handler CANNOT throw synchronously: a synchronous assert.throws here would only pass vacuously)",
    );
    assert.deepEqual(calls, ["beginBotAction", "endBotAction"], "endBotAction runs for a rejecting handler too: no action is left in progress");

    // …and a handler that really does throw synchronously (it is NOT `async`) is the
    // case `assert.throws` is for: the throw leaves the wrapped call synchronously.
    server.tool("throws_sync", {}, () => { throw boom; });
    const wrappedSync = registered[1].args[1];
    assert.throws(() => wrappedSync(), (err) => err === boom, "a synchronous handler's throw propagates unchanged");
    assert.deepEqual(
      calls,
      ["beginBotAction", "endBotAction", "beginBotAction", "endBotAction"],
      "endBotAction runs for a synchronous throw as well, before the call returns",
    );

    // …and two calls are two nested-safe pairs, never a counter that drifts.
    server.tool("ok", {}, async () => "fine");
    const ok = registered[2].args[1];
    await ok();
    await ok();
    assert.deepEqual(
      calls,
      [
        "beginBotAction",
        "endBotAction",
        "beginBotAction",
        "endBotAction",
        "beginBotAction",
        "endBotAction",
        "beginBotAction",
        "endBotAction",
      ],
      "every call is one begin and one end, in that order",
    );
  }
});

// E2 (behavioural): the action ends when the handler's PROMISE SETTLES, not when the
// handler returns it. At HEAD the try/finally closes the action the moment the handler
// hands its promise back, so a slow click is "finished" long before its tab arrives.
test("T22-E2: endBotAction waits for the handler's promise to settle — a slow call is still an open action while it runs", async () => {
  const wrap = ownershipModule.wrapToolWithBotAction;
  assert.equal(typeof wrap, "function", "page-ownership.js must export wrapToolWithBotAction(server, ownership)");

  /**
   * A real ownership in the scene a slow call runs in: a short window (150 ms) and one bot
   * page, because an arrival with no `opener()` is not even looked at while nothing of the
   * bot's is owned. The mark's own window is stepped over BEFORE the call, so from then on
   * only a RUNNING ACTION can claim an independent arrival.
   */
  const scene = async () => {
    const world = worldWithTargetInfo();
    const ownership = createPageOwnership({ botActionWindowMs: 150 });
    await ownership.attachContext(world.context);
    const botPage = world.addPage("B", { targetId: "target-bot" });
    ownership.markTouched(botPage);
    await ownership.settle();
    await later(250); // past the window the mark opened: the mark claims nothing now
    const calls = spyBotActions(ownership);
    const { server, registered } = fakeToolServer();
    wrap(server, ownership);
    return { world, ownership, calls, server, registered };
  };

  /** Emit an independent arrival (no `opener()`, no `openerId`) NOW and report its class. */
  const arrivalClass = async (world, ownership, name) => {
    const page = world.addPage(name);
    world.emitPage(page);
    await ownership.settle();
    return ownership.classify(page);
  };

  // (a) A slow call that RESOLVES. While it runs the action is open — the spy log says so
  // AND an independent arrival is classed BOT — and it ends only when the promise settles.
  {
    const { world, ownership, calls, server, registered } = await scene();
    const gate = deferred();
    server.tool("slow", {}, () => gate.promise);
    const wrapped = registered[0].args[1];

    const running = wrapped();
    assert.ok(running && typeof running.then === "function", "the wrapped call hands back a promise (thenable) the caller can await");
    assert.deepEqual(calls, ["beginBotAction"], "beginBotAction runs BEFORE the handler, and endBotAction has not run yet");

    await later(250); // 250 ms into the call, well past the 150 ms window
    assert.deepEqual(
      calls,
      ["beginBotAction"],
      "the action is STILL OPEN 250 ms into the call: endBotAction waits for the handler's promise to settle (RED at HEAD: it runs the moment the handler returns the promise)",
    );
    assert.equal(
      await arrivalClass(world, ownership, "during"),
      "bot",
      "an independent arrival while the call is still running is BOT — the open action is what claims a slow click's tab (RED at HEAD: the flag is already off and the window passed, so 'uncertain')",
    );
    assert.deepEqual(calls, ["beginBotAction"], "classifying an arrival neither opens nor closes an action");

    gate.resolve("done");
    assert.equal(await running, "done", "the handler's resolved value reaches the caller unchanged");
    assert.deepEqual(calls, ["beginBotAction", "endBotAction"], "endBotAction runs once, AFTER the promise resolved");

    // CONTROL: the same arrival after the end, past the window → 'uncertain'. So the 'bot'
    // above came from the RUNNING ACTION, not from a scene that claims everything.
    await later(250);
    assert.equal(
      await arrivalClass(world, ownership, "after"),
      "uncertain",
      "CONTROL: an independent arrival after endBotAction and past the window is 'uncertain' — the action, not the scene, made the arrival BOT",
    );
  }

  // (b) The same for a slow call that REJECTS: the action stays open until the rejection
  // lands, and the rejection itself is preserved.
  {
    const { world, ownership, calls, server, registered } = await scene();
    const gate = deferred();
    const boom = new Error("the slow tool failed");
    server.tool("slow", {}, () => gate.promise);
    const wrapped = registered[0].args[1];

    const running = wrapped();
    // Attached before the rejection happens, so node never reports it as unhandled.
    const rejected = assert.rejects(running, (err) => err === boom, "the handler's rejection reaches the caller unchanged");
    await later(250);
    assert.deepEqual(
      calls,
      ["beginBotAction"],
      "the action is still open while the rejecting call runs (RED at HEAD: it ended when the handler returned the promise)",
    );
    assert.equal(
      await arrivalClass(world, ownership, "during-reject"),
      "bot",
      "an independent arrival while the call is still running is BOT, whatever the call will end as (RED at HEAD: 'uncertain')",
    );

    gate.reject(boom);
    await rejected;
    assert.deepEqual(calls, ["beginBotAction", "endBotAction"], "endBotAction runs after the promise REJECTED too: a failed call leaves no action open");

    // CONTROL: past the window after the end, nothing is claimed.
    await later(250);
    assert.equal(
      await arrivalClass(world, ownership, "after-reject"),
      "uncertain",
      "CONTROL: an independent arrival after the rejected call ended and the window passed is 'uncertain'",
    );
  }

  // (c) TWO overlapping calls: the counter stays above zero until BOTH settle, so a call
  // ending does not end the machine's action. The 250 ms wait after the first settlement is
  // what makes this about the COUNTER and not about the window: at HEAD the first call's
  // return has already stamped the end 250 ms ago, past the window, so nothing but an
  // action still in progress can class the arrival BOT.
  {
    const { world, ownership, calls, server, registered } = await scene();
    const first = deferred();
    const second = deferred();
    server.tool("first", {}, () => first.promise);
    server.tool("second", {}, () => second.promise);
    const runFirst = registered[0].args[1]();
    const runSecond = registered[1].args[1]();
    assert.deepEqual(calls, ["beginBotAction", "beginBotAction"], "two overlapping calls are two opens");

    first.resolve("one");
    assert.equal(await runFirst, "one", "the first call's value reaches its caller");
    assert.deepEqual(
      calls,
      ["beginBotAction", "beginBotAction", "endBotAction"],
      "the first call ending leaves the SECOND call's action open — one settlement must not end the other call's action",
    );

    await later(250);
    assert.equal(
      await arrivalClass(world, ownership, "during-second"),
      "bot",
      "…so an independent arrival is still BOT while the second call runs, 250 ms after the first ended and past the window: the action is still in progress (RED at HEAD: both ended on return, so 'uncertain')",
    );

    second.resolve("two");
    assert.equal(await runSecond, "two", "the second call's value reaches its caller");
    assert.deepEqual(
      calls,
      ["beginBotAction", "beginBotAction", "endBotAction", "endBotAction"],
      "the second settlement ends the second action, and only then is the counter back to zero",
    );

    // CONTROL: with BOTH calls settled and the window passed, the same arrival is nobody's.
    await later(250);
    assert.equal(
      await arrivalClass(world, ownership, "after-both"),
      "uncertain",
      "CONTROL: after both calls settled and the window passed, the same arrival is 'uncertain'",
    );
  }
});

// E (static): where server.js installs the wrapper, and what the wrapper must contain.
test("T22-E (static): server.js installs the bot-action wrapper ONCE, after installLeaseGuard and before the first tool", () => {
  // HONEST LABEL: this half is a STATIC test on the product source (server.js and
  // page-ownership.js). The behaviour is covered by the T22-E case above; this one pins
  // the WIRING, which cannot be exercised without a real browser connection.
  const source = readFileSync(SERVER_JS, "utf8");
  const ownershipSource = readFileSync(OWNERSHIP_JS, "utf8");

  const leaseAt = source.indexOf("installLeaseGuard(");
  const firstToolAt = source.indexOf("server.tool(");
  assert.notEqual(leaseAt, -1, "server.js calls installLeaseGuard( (the lease guard has to be installed)");
  assert.notEqual(firstToolAt, -1, "server.js registers its tools with server.tool(");

  assert.ok(
    /import\s*\{[^}]*\bwrapToolWithBotAction\b[^}]*\}\s*from\s*["']\.\/page-ownership\.js["']/s.test(source),
    "server.js imports wrapToolWithBotAction from ./page-ownership.js (next to createPageOwnership)",
  );

  const callSites = [];
  const re = /\bwrapToolWithBotAction\s*\(/g;
  let match;
  while ((match = re.exec(source)) !== null) callSites.push(match.index);
  assert.equal(
    callSites.length,
    1,
    `server.js installs the bot-action wrapper EXACTLY once (found ${callSites.length} calls): a second wrap would nest two actions per tool call`,
  );
  assert.ok(
    callSites[0] > leaseAt,
    "the wrapper is installed AFTER installLeaseGuard( — both wrap server.tool, and the lease guard has to be the inner one so the lease is taken before the action starts",
  );
  assert.ok(
    callSites[0] < firstToolAt,
    "…and BEFORE the first server.tool( registration: a tool registered before the wrap runs outside every bot action",
  );

  const declAt = Math.max(
    ownershipSource.lastIndexOf("export function wrapToolWithBotAction"),
    ownershipSource.lastIndexOf("export const wrapToolWithBotAction"),
  );
  assert.notEqual(
    declAt,
    -1,
    "page-ownership.js EXPORTS wrapToolWithBotAction(server, ownership) — server.js imports it, so it cannot be a private helper",
  );
  const body = ownershipSource.slice(declAt, declAt + 2500);
  assert.ok(/beginBotAction/.test(body), "the wrapper begins a bot action for each call");
  assert.ok(
    /\bfinally\b/.test(body),
    "the wrapper ends the action in a `finally`: a handler that throws must not leave an action in progress (it would claim every later arrival as the bot's)",
  );
  assert.ok(/endBotAction/.test(body), "…by calling endBotAction");
});

// ---------------------------------------------------------------------------
// 17. T24: the round-11 findings (RED tests, tests only)
//
//   N1  BLOCKING, and fail-OPEN. The relatives walk waits for the arrival
//       classification of EVERY live page (`waitForArrivals`), bounded only by the
//       walk's own deadline — and when that wait runs out the walk is SKIPPED
//       ENTIRELY, not merely truncated. So one unrelated tab, whose `opener()` is a
//       ~900 ms round trip and whose `openerId` lookup is another ~900 ms, leaves
//       the walk out of time before it looked at anything: the operator popup of the
//       tab the bot just drove stays the operator's, and the exit cleanup closes the
//       browser over it unguarded. The requirement, in four parts:
//         (a) wait only for the touched page's OWN arrival, plus arrivals whose
//             recorded/pending relation can involve it — not every live page;
//         (b) when that wait times out the walk runs ANYWAY, marked incomplete
//             (complete = false), so a later touch retries it;
//         (c) settle() re-runs, ONCE, the walk of every touched page that is not in
//             `relativesWalked`, so the exit cleanup never reads pages over an
//             unfinished walk;
//         (d) fail closed at exit: the live candidates whose `opener()` lookup never
//             answered are marked BOT once that one re-run is done.
//   M1  COST against the EXIT BUDGET: ONE process-wide walk deadline, which settle()
//       passes down, and a walk started from inside settle starts no further walks.
//       Chained walks with slow lookups must not stretch settle() past the budget.
//   M2  an action that never ends must not claim fresh tabs forever: each
//       beginBotAction records its start, and an action open longer than
//       `maxBotActionMs` (default 60000; these cases pass 200) counts as ENDED for
//       the arrival-time snapshot.
//   M3  COST: one touch runs ONE walk of a component — at most one live `opener()`
//       call per page of it, not two.
//
// The product code is the NEXT task's (I24). Every case carries its control, so a
// fail-closed rule cannot pass by marking everything the bot's, and every case is RED
// at HEAD where the finding is (the failure is the bug report).
// ---------------------------------------------------------------------------

/** A page whose live `opener()` NEVER answers — counted, so "it was asked" is a number. */
function openerNeverAnswers(page) {
  page.calls.opener = 0;
  page.opener = () => {
    page.calls.opener += 1;
    return new Promise(() => {});
  };
  return page;
}

/**
 * The repro3 scene (N1): an operator tab P with a popup Q that existed at attach, one
 * bot page, and an UNRELATED tab R whose arrival classification is still in flight —
 * its `opener()` is a 900 ms round trip and its CDP `openerId` lookup is another 900 ms,
 * so the classification lasts ~1800 ms. Returns with R still unclassified.
 */
async function slowUnrelatedArrivalScene() {
  const world = worldWithTargetInfo({ delayMs: 900 }); // every CDP lookup here is 900 ms
  const ownership = createPageOwnership({ botActionWindowMs: 100 });
  const P = world.addPage("P"); // the operator's tab, open at attach
  const Q = world.addPage("Q", { opener: P }); // the popup it had already opened
  await ownership.attachContext(world.context);
  const botPage = world.addPage("B", { targetId: "target-bot" });
  ownership.markTouched(botPage);
  await ownership.settle();
  await later(150); // past the 100 ms bot-action window: only a walk can claim anything now

  const unrelated = world.addPage("R", { openerDelayMs: 900 });
  world.emitPage(unrelated); // its classification starts; ~900 + ~900 ms away
  await later(20); // the arrival really is in flight (the case is not vacuous)
  return { world, ownership, P, Q, botPage, unrelated };
}

// N1-1: the repro3 scene — the touch of P must still reach its popup Q.
test("N1-1: an unrelated SLOW arrival does not make the touch walk skip the component (the repro3 scene)", async () => {
  const { ownership, P, Q, botPage, unrelated } = await slowUnrelatedArrivalScene();

  ownership.markTouched(P); // the bot drives the operator tab whose popup Q is open
  await ownership.settle();

  assert.equal(ownership.classify(P), "bot", "the page the bot drove is the bot's");
  assert.equal(
    ownership.classify(Q),
    "bot",
    "a popup that already existed at attach follows the touch of its opener even when an UNRELATED tab's slow arrival is still being classified: the walk must wait only for the touched page's own arrival and the ones whose relation can involve it — and must run anyway when that wait times out (RED at HEAD: the walk is skipped entirely, so Q stays the operator's)",
  );
  assert.equal(ownership.classify(botPage), "bot", "the page marked before the arrival is still the bot's");
  assert.equal(
    ownership.classify(unrelated),
    "uncertain",
    "CONTROL: the unrelated arrival (no opener, a lookup that names no openerId, outside the window) stays 'uncertain' — left alone, never claimed by a walk that merely gave up waiting",
  );
});

// N1-2: and it does not DELAY the marking either.
test("N1-2: the unrelated slow arrival does not delay the touched page's marking", async () => {
  const { ownership, P, Q } = await slowUnrelatedArrivalScene();

  ownership.markTouched(P);
  const { outcome, elapsed } = await timed(async () => {
    assert.ok(
      await waitFor(() => ownership.classify(Q) === "bot", 800),
      "Q has to be the bot's within the touched page's own settle: an unrelated arrival's 900 + 900 ms of lookups must not hold the walk (RED at HEAD: the walk waits on R, runs out of its deadline and is skipped, so Q is never marked)",
    );
  }, 1500);
  assert.equal(outcome, "done", `the marking has to land without waiting for the unrelated arrival (outcome ${outcome} after ${elapsed} ms)`);
  assert.ok(
    elapsed < 1200,
    `the unrelated arrival's classification lasts ~1800 ms; the touched page's marking must not be held behind it (took ${elapsed} ms)`,
  );

  await ownership.settle(); // let the unrelated arrival land before the case ends
  assert.equal(ownership.classify(Q), "bot", "and Q is still the bot's after everything settled");
});

// N1-3: a GUARD on the narrowing — the touched page's OWN slow arrival is still waited for.
test("N1-3: the touched page's OWN arrival is still waited for, because its relation is what the walk needs", async () => {
  const world = worldWithTargetInfo();
  const O = world.addPage("O"); // the operator root, open at attach
  const Q = world.addPage("Q", { opener: O }); // its popup, open at attach too
  const U = world.addPage("U"); // an unrelated operator tab
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  // P arrives mid-session as a popup of O, and its opener() is a 900 ms round trip: the
  // relation P -> O is only recorded when its own arrival classification answers.
  const P = world.addPage("P", { opener: O, openerDelayMs: 900 });
  world.emitPage(P);
  await later(20);
  ownership.markTouched(P);
  await ownership.settle();

  assert.equal(P.calls.opener, 1, "the case is not vacuous: the touched page's own slow opener() was asked");
  assert.equal(ownership.classify(P), "bot", "the page the bot drove is the bot's");
  assert.equal(
    ownership.classify(O),
    "bot",
    "the touched page's OWN arrival is still waited for: the relation P -> O is learned from it, so O — the tab that opened the page the bot drove — is the bot's",
  );
  assert.equal(ownership.classify(Q), "bot", "…and the sibling popup of O follows the same component");
  assert.equal(ownership.classify(U), "operator", "CONTROL: an unrelated operator tab is untouched by all of it");
});

// N1-4: the fail-closed half at exit (requirement (d)).
test("N1-4: a walk left incomplete fail-closes on the live candidate whose opener() never answered", async () => {
  /**
   * P (touched) and two further live tabs: `C`, whose opener() either never answers or
   * answers "no opener: unrelated", and `U`, whose opener() answers the same way. A walk
   * that cannot read C's opener proves nothing about C, and the exit cleanup must not
   * leave it running unguarded.
   */
  const scene = async ({ hangs }) => {
    const world = worldWithTargetInfo();
    const P = world.addPage("P");
    const candidate = world.addPage("C");
    if (hangs) openerNeverAnswers(candidate);
    const U = world.addPage("U");
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    ownership.markTouched(P);
    await ownership.settle();
    return { ownership, P, candidate, U };
  };

  // CONTROL: the same scene with the candidate's opener() ANSWERING ("no opener: nobody's
  // popup"): nothing is proven against it, so it stays the operator's.
  {
    const { ownership, P, candidate, U } = await scene({ hangs: false });
    assert.equal(ownership.classify(P), "bot", "CONTROL: the touched page is the bot's");
    assert.equal(
      ownership.classify(candidate),
      "operator",
      "CONTROL: a live candidate whose opener() ANSWERED ('no opener: unrelated') stays the operator's — the fail-closed mark is for the ones that answered nothing",
    );
    assert.equal(ownership.classify(U), "operator", "CONTROL: …and so does the other answered candidate");
  }

  // THE CASE (RED at HEAD: the candidate stays the operator's, because a walk whose lookup
  // never answered proves nothing and nothing acts on that).
  {
    const { ownership, P, candidate, U } = await scene({ hangs: true });
    assert.ok(
      candidate.calls.opener > 0,
      "the case is not vacuous: the walk really did ask C for its opener (and got no answer)",
    );
    assert.equal(ownership.classify(P), "bot", "the touched page is the bot's");
    assert.equal(
      ownership.classify(candidate),
      "bot",
      "when a walk is still incomplete after settle()'s one re-run, a live candidate whose opener() lookup never answered is marked BOT (fail closed): anything else leaves a tab nobody can prove is the operator's running unguarded after the exit (RED at HEAD: it stays the operator's)",
    );
    assert.equal(ownership.classify(U), "operator", "CONTROL: the candidate whose opener() answered is still the operator's");
  }
});

// M1: one process-wide walk deadline, so chained walks cannot stretch settle().
test("M1: one process-wide walk deadline bounds settle(), however many walks are chained inside it", async () => {
  /**
   * A chain N0 -> N1 -> … -> Nk: N0 is the page the bot drives, every link reports the
   * one above it, and every `opener()` is a 900 ms round trip. Each walk that climbs the
   * chain is spawned from the previous one (a relation landing for the touched page while
   * its predecessor is still walking), so HEAD runs several walks, each with its OWN
   * deadline, one after the other.
   */
  const chainScene = async (length) => {
    const world = worldWithTargetInfo();
    const pages = [];
    for (let index = length; index >= 0; index--) {
      pages[index] = world.addPage(`N${index}`, {
        opener: index === length ? null : pages[index + 1],
        openerDelayMs: 900,
      });
    }
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    ownership.markTouched(pages[0]);
    return { ownership, pages };
  };

  // CONTROL first, so a wrong control is reported instead of being hidden behind the red
  // assertion below: a normal, fast scene is unaffected — it completes well inside the
  // same budget and still marks the popup of the page the bot drove.
  {
    const world = worldWithTargetInfo();
    const P = world.addPage("P");
    const Q = world.addPage("Q", { opener: P });
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    ownership.markTouched(P);
    const { outcome, elapsed } = await timed(() => ownership.settle(), 3500);
    assert.equal(outcome, "done", `CONTROL: the fast scene settles (${outcome} after ${elapsed} ms)`);
    assert.ok(elapsed < 800, `CONTROL: a fast component is walked without delay (took ${elapsed} ms)`);
    assert.equal(ownership.classify(P), "bot", "CONTROL: the touched page is the bot's");
    assert.equal(ownership.classify(Q), "bot", "CONTROL: …and its popup is still marked (the deadline bounds the walk, it does not neuter it)");
  }

  // THE CASE, with one chain and with more rounds of it: the whole of it has to fit the
  // exit budget, i.e. inside one walk deadline, not one deadline per chained walk.
  for (const length of [4, 8]) {
    const { ownership, pages } = await chainScene(length);
    const { outcome, elapsed } = await timed(() => ownership.settle(), 3500);
    assert.equal(outcome, "done", `settle() has to come back (chain of ${length}: ${outcome} after ${elapsed} ms)`);
    assert.ok(
      elapsed < 1800,
      `the walks chained inside one settle() share ONE deadline (~1500 ms): a walk started from inside settle starts no further walk (chain of ${length} took ${elapsed} ms — RED at HEAD: every chained walk gets its own deadline, so the total grows past the exit budget)`,
    );
    assert.equal(ownership.classify(pages[0]), "bot", `the touched page is the bot's (chain of ${length})`);
  }
});

// M2 REWRITTEN for T26 (round 12, F2): the `maxBotActionMs` CAP IS GONE. An action that is
// open stays open for the arrival-time snapshot however long it has been running. The cap was
// a FAIL-OPEN: it handed an arrival to the "independent tab" branch — left running unguarded
// after the exit — while the bot's own tool call was still running, which is exactly the shape
// a slow click's tab arrives in. What ends an action is its own end now: `endBotAction()`, or
// the tool-dispatch wrapper's own `maxToolActionMs` timeout (F2, section 18).
test("M2 (T26): an action that is open stays open for the snapshot, however long — maxBotActionMs no longer caps it", async () => {
  /**
   * The scene a leaked action is read in: one bot page, a short window (100 ms) and a
   * `maxBotActionMs: 200` option the ownership must IGNORE (the option is gone), stepped over
   * before the action starts, so from then on ONLY a running action can claim an arrival.
   */
  const scene = async () => {
    const world = worldWithTargetInfo();
    const ownership = createPageOwnership({ botActionWindowMs: 100, maxBotActionMs: 200 });
    await ownership.attachContext(world.context);
    const botPage = world.addPage("B", { targetId: "target-bot" });
    ownership.markTouched(botPage);
    await ownership.settle();
    await later(150); // past the window: nothing but an open action can claim an arrival now
    return { world, ownership };
  };

  /** Emit a no-opener/no-openerId arrival NOW and report its class. */
  const arrivalClass = async (world, ownership, name) => {
    const page = world.addPage(name);
    world.emitPage(page);
    await ownership.settle();
    return ownership.classify(page);
  };

  // (a) beginBotAction() with no endBotAction at all.
  {
    const { world, ownership } = await scene();
    const begin = botAction(ownership, "beginBotAction");
    const end = botAction(ownership, "endBotAction");
    begin();

    // CONTROL: an arrival early in the action is claimed — the OPEN ACTION is the reason, so
    // the case below is not a scene that claims everything.
    await later(50);
    assert.equal(
      await arrivalClass(world, ownership, "early-in-action"),
      "bot",
      "CONTROL: an independent arrival 50 ms into an open action is BOT (the action is genuinely in progress)",
    );

    await later(500); // ~550 ms into the action: far past the 200 ms the old cap used, and past the window
    assert.equal(
      await arrivalClass(world, ownership, "past-old-cap"),
      "bot",
      "an action open longer than what used to be maxBotActionMs is STILL open for the arrival snapshot: the cap was fail-open (a running tool call's own slow click) and it is gone, so this arrival is BOT (RED at HEAD: the 200 ms cap counted the action as ended, so this was 'uncertain')",
    );

    end(); // close the leaked action before the case ends
    await later(200); // past the window that end stamped
    assert.equal(
      await arrivalClass(world, ownership, "after-end"),
      "uncertain",
      "CONTROL: after endBotAction and past the window the same arrival is 'uncertain' again — the OPEN ACTION, not the scene, claimed it",
    );
  }

  // (b) The same through the wrapper the server installs, with a handler whose promise NEVER
  // settles: an open call is an open action for as long as it runs — nothing in the wrapper ends
  // it on a clock any more (T29: the bracket ends only in try/finally or on the handler's own
  // settle; F2 in section 18 pins that, timer and all).
  {
    const wrap = ownershipModule.wrapToolWithBotAction;
    assert.equal(typeof wrap, "function", "page-ownership.js exports wrapToolWithBotAction(server, ownership) (T22-E)");

    const { world, ownership } = await scene();
    const { server, registered } = fakeToolServer();
    wrap(server, ownership);
    const gate = deferred(); // nobody ever settles it: the handler never ends
    server.tool("never_settles", {}, () => gate.promise);
    const running = registered[0].args[1]();
    assert.ok(running && typeof running.then === "function", "the wrapped call hands back the handler's promise");

    // CONTROL: early in the call the open action still claims an arrival.
    await later(50);
    assert.equal(
      await arrivalClass(world, ownership, "inside-cap-wrapped"),
      "bot",
      "CONTROL: an independent arrival early in a never-settling tool call is BOT",
    );

    await later(500);
    assert.equal(
      await arrivalClass(world, ownership, "past-old-cap-wrapped"),
      "bot",
      "a tool call whose handler never settles is an OPEN action however long it has run (T29: only the handler's own settle ends it): an independent arrival stays the bot's, not the operator's",
    );
    // The promise is abandoned on purpose; settle it and attach a handler so node is quiet.
    gate.resolve("late");
    running.catch(() => {});
    await later(200);
  }
});

// M3: one touch, ONE walk of the component.
test("M3: one touch runs ONE walk of a component — at most one live opener() per page", async () => {
  // The component: G <- O <- Q (Q is the popup of O, O the popup of G), plus an unrelated
  // operator tab U. All of them existed at attach, so every relation has to be learned by
  // asking; a second walk of the same component asks the same tabs again.
  const world = worldWithTargetInfo();
  const G = world.addPage("G");
  const O = world.addPage("O", { opener: G });
  const Q = world.addPage("Q", { opener: O });
  const U = world.addPage("U");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  const before = { Q: Q.calls.opener, O: O.calls.opener, G: G.calls.opener, U: U.calls.opener };
  ownership.markTouched(Q); // ONE touch
  await ownership.settle();

  assert.equal(ownership.classify(Q), "bot", "the page the bot drove is the bot's");
  assert.equal(ownership.classify(O), "bot", "…the tab that opened it too (one step up the chain)");
  assert.equal(ownership.classify(G), "bot", "…and the root of the chain");
  assert.equal(ownership.classify(U), "operator", "CONTROL: an unrelated operator tab stays the operator's");

  const counts = {
    Q: Q.calls.opener - before.Q,
    O: O.calls.opener - before.O,
    G: G.calls.opener - before.G,
    U: U.calls.opener - before.U,
  };
  assert.ok(counts.Q + counts.O + counts.G + counts.U > 0, `the case is not vacuous: the walk really did ask for openers (${JSON.stringify(counts)})`);
  assert.ok(
    counts.Q <= 1 && counts.O <= 1 && counts.G <= 1,
    `one touch is ONE walk of the component: at most one live opener() call per page of it (saw ${JSON.stringify(counts)} — RED at HEAD: the relation the walk records spawns a second walk over the same pages)`,
  );
  assert.ok(counts.U <= 1, `…and a live candidate outside it is asked once, not once per walk (saw ${JSON.stringify(counts)})`);
});

// ---------------------------------------------------------------------------
// 18. T26: the round-12 findings (RED tests, tests only)
//
//   F1  settleWalks() is fail-OPEN in three places, and the rule for all three is the one
//       this module exists for: ANY DOUBT -> BOT. Only a page with no `openerId` that arrives
//       with NO action open and OUTSIDE the window may be left `uncertain`.
//         (a) a node's UPWARD live `opener()` that does not answer before the walk's deadline
//             is never added to the walk's `unanswered` set, so settle()'s fail-closed step
//             never sees it;
//         (b) a page still queued — or never looked at at all — when the walk deadline cuts
//             the walk short is left at the OPERATOR DEFAULT: the component scan has to be
//             failed closed too, not only the answers that ran out of time;
//         (c) settleWalks() computes its re-run deadline BEFORE `await settleWork()`, so the
//             wait itself eats the re-run's budget and the re-run walks nothing at all.
//   F2  an action that is OPEN stays open for the arrival snapshot however long it runs (the
//       `maxBotActionMs` cap dropped a running tool call's own slow click), and the ONE thing
//       that ends an abandoned action is the tool-dispatch wrapper's own timeout
//       (`maxToolActionMs`, default 300000), which ends it EXACTLY once.
//   F3  beginBotAction()/endBotAction() bookkeeping is a bare stack pop, so ending action A
//       also ends action B. Tokens instead: begin hands one back, end(token) removes exactly
//       that entry, end() with no argument still removes the OLDEST open entry, and an
//       unknown/already-ended token is a no-op (never below zero).
//
// The product code is the NEXT task's (I26). Every case carries its control, so a fail-closed
// rule cannot pass by making everything the bot's, and every case is RED at HEAD where the
// finding is (the failure is the bug report).
// ---------------------------------------------------------------------------

/**
 * Count the calls to beginBotAction/endBotAction AND what each hands back / is handed
 * (T26-F3): the wrapper has to END its action with the very token its BEGIN returned.
 *
 * Installed BEFORE the wrapper is wrapped, so a wrapper that binds the methods at install
 * time is counted too; the real state change still happens.
 */
function spyBotActionTokens(ownership) {
  const calls = [];
  const begin = botAction(ownership, "beginBotAction");
  const end = botAction(ownership, "endBotAction");
  ownership.beginBotAction = (...args) => {
    const token = begin(...args);
    calls.push({ name: "beginBotAction", args, token });
    return token;
  };
  ownership.endBotAction = (...args) => {
    calls.push({ name: "endBotAction", args });
    return end(...args);
  };
  return calls;
}

/**
 * An arrival that is DETERMINISTICALLY still being classified after a walk's 1500 ms deadline
 * has passed: its `opener()` never answers (bounded at the 1000 ms lookup timeout) and the CDP
 * `openerId` ask that follows it is another real 900 ms round trip, so `settleWork()` is still
 * waiting on it at ~1900 ms.
 *
 * That wait is the "slow in-flight lookup before the re-run" the F1 cases need: with today's
 * `settleWalks()` it is taken out of the re-run's own deadline — deterministically, with no
 * timing race, because the deadline captured before the wait is long gone when the re-run
 * starts. The page is NOT in the context's live list (a tab that closed mid-classification),
 * so it is never a walk candidate: it is the CLOCK, not a verdict. Emitted AFTER the touch, so
 * the ownership owns a bot page and really does ask the browser for the `openerId`.
 */
function slowInFlightArrival(world, name = "slow-arrival") {
  const page = fakePage(world, name, { openerDelayMs: 1200 });
  controlledContext(page, { lookup: "answer", delayMs: 900 });
  world.emitPage(page);
  return page;
}

// F1(a)+(b): a walk cut short must fail closed on what it could not read.
test("F1a: an upward live opener() that never answers is failed closed at settle; the same page answering 'no opener' stays the operator's", async () => {
  /**
   * The component: P is the page the bot drives, O is the live page next to it. `hangs`
   * decides whether the two `opener()` calls ANSWER: hanging, the walk can prove nothing and
   * F1(b)'s sweep must not leave O at the operator default; answering "no opener", the walk
   * COMPLETES and O was answered-unrelated.
   */
  const scene = async ({ hangs }) => {
    const world = worldWithTargetInfo();
    const P = world.addPage("P");
    const O = world.addPage("O");
    if (hangs) {
      openerNeverAnswers(P); // the touched page's own UPWARD lookup never answers
      openerNeverAnswers(O); // …and so does the live page the walk has to look at
    }
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    ownership.markTouched(P);
    slowInFlightArrival(world); // still being classified at ~1900 ms: past the walk's 1500 ms deadline
    await ownership.settle();
    return { ownership, P, O };
  };

  // CONTROL FIRST, so a wrong control is reported instead of being hidden behind the red
  // assertion below: both opener() calls answer "no opener", the walk COMPLETES, and the live
  // page that ANSWERED (unrelated) stays the operator's.
  {
    const { ownership, P, O } = await scene({ hangs: false });
    assert.equal(ownership.classify(P), "bot", "CONTROL: the page the bot drove is the bot's");
    assert.ok(O.calls.opener > 0, "CONTROL: the walk really did ask O for its opener (the counter is not vacuous)");
    assert.equal(
      ownership.classify(O),
      "operator",
      "CONTROL: a live page whose opener() ANSWERED 'no opener' is not the bot's — the fail-closed mark is for the ones that answered nothing",
    );
  }

  // THE CASE (RED at HEAD: the walk is cut, its unanswered set is never acted on, and O is left
  // at the operator default although nothing proves it is the operator's).
  {
    const { ownership, P, O } = await scene({ hangs: true });
    assert.ok(P.calls.opener > 0, "the case is not vacuous: the touched page's own upward opener() was asked and never answered");
    assert.equal(ownership.classify(P), "bot", "the page the bot drove is the bot's");
    assert.equal(
      ownership.classify(O),
      "bot",
      "an upward live opener() that never answers leaves the walk unprovable, and settle() has to fail closed on it: O is BOT (RED at HEAD: the unanswered lookup was never added to the walk's fail-closed set, and O was left at the operator default)",
    );
  }
});

// F1(b): the pages the deadline cut the component scan short of.
test("F1b: a component scan cut by the deadline leaves NO page at the operator default — everything not answered-unrelated is BOT", async () => {
  const PAGE_COUNT = 12;
  /**
   * `slow` picks the case's shape: the touched page's own upward ask NEVER answers (it eats the
   * walk's budget) and the 12 live pages answer after 900 ms each, so the scan is cut; with
   * `slow` off every ask answers at once and the walk COMPLETES.
   */
  const scene = async ({ slow }) => {
    const world = worldWithTargetInfo();
    const touched = world.addPage("P");
    const others = [];
    for (let index = 0; index < PAGE_COUNT; index++) others.push(world.addPage(`L${index}`));
    if (slow) {
      openerNeverAnswers(touched); // the walk's own UPWARD ask never answers: it eats the deadline
      for (const page of others) page.openerDelayMs = 900; // 900 ms per live opener(): the scan is cut
    }
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    ownership.markTouched(touched);
    slowInFlightArrival(world); // settleWork() is still on it at ~1900 ms: past the 1500 ms deadline
    const { outcome, elapsed } = await timed(() => ownership.settle(), 9000);
    return { ownership, touched, others, outcome, elapsed };
  };

  // CONTROL FIRST: the same component with FAST answers — the walk completes, every one of the
  // 12 pages was ASKED and ANSWERED ("no opener: unrelated"), so they stay the operator's.
  {
    const { ownership, touched, others, outcome } = await scene({ slow: false });
    assert.equal(outcome, "done", `CONTROL: settle() comes back (${outcome})`);
    assert.equal(ownership.classify(touched), "bot", "CONTROL: the page the bot drove is the bot's");
    for (const page of others) {
      assert.ok(page.calls.opener > 0, `CONTROL: ${page.name} was asked for its opener (the walk completed)`);
      assert.equal(ownership.classify(page), "operator", `CONTROL: ${page.name} answered 'no opener' and stays the operator's`);
    }
  }

  // THE CASE (RED at HEAD: the walk is cut by its deadline and settle()'s re-run has no budget
  // left, so all 12 pages stay operator-by-default — and the exit closes the browser over tabs
  // nobody could prove are the operator's).
  {
    const { ownership, touched, others, outcome, elapsed } = await scene({ slow: true });
    assert.equal(outcome, "done", `settle() has to come back (${outcome} after ${elapsed} ms)`);
    assert.equal(ownership.classify(touched), "bot", "the page the bot drove is the bot's");
    const leftOperator = others.filter((page) => ownership.classify(page) !== "bot").map((page) => page.name);
    assert.deepEqual(
      leftOperator,
      [],
      `every live page of the component that was NOT answered-unrelated is BOT after settle: a walk cut short by its deadline proves nothing about them, and the exit must not close the browser over a tab nobody could prove is the operator's (left at the operator default: ${JSON.stringify(leftOperator)}, settle took ${elapsed} ms)`,
    );
    assert.ok(
      elapsed < 6000,
      `settle() still finishes — the re-run cannot grow the exit past its budget without bound (took ${elapsed} ms)`,
    );
  }
});

// F1(c): the re-run's budget is measured AFTER `await settleWork()`.
test("F1c: settle's re-run gets its FULL deadline after settleWork — a slow in-flight lookup does not eat it", async () => {
  /**
   * The chain is P ->(100 ms) M ->(recorded) G, so finishing the walk is a few hundred ms of
   * lookups; R is a live tab whose `opener()` is a 600 ms round trip and which is related to
   * nothing, so it can only be ANSWERED (and left the operator's) if the re-run has a real
   * budget.
   *
   * The touch walk's OWN first ask on P never answers (~1000 ms), and a `slowInFlightArrival`
   * adds its ~900 ms `openerId` round trip on top: that is the slow in-flight lookup
   * `settleWork()` waits for — the wait today's `settleWalks()` takes straight out of the
   * re-run's deadline. With the deadline captured before the wait, the re-run starts on an
   * expired one and walks nothing (RED at HEAD): M and G stay at the operator default although
   * the page the bot drove opened them.
   */
  const world = worldWithTargetInfo();
  const G = world.addPage("G");
  const R = world.addPage("R", { openerDelayMs: 600 }); // related to nothing: 600 ms to answer
  const M = world.addPage("M", { opener: G });
  const P = world.addPage("P", { opener: M, openerDelayMs: 100 });

  const ownership = createPageOwnership();
  await ownership.attachContext(world.context); // every page existed at attach: nothing is the bot's yet
  world.emitPage(M); // records the M -> G relation; M stays the operator's (proof (i))
  await ownership.settle();
  assert.equal(ownership.classify(M), "operator", "CONTROL: M is the operator's before the touch (proof (i))");
  assert.equal(ownership.classify(G), "operator", "CONTROL: G is the operator's before the touch (proof (i))");

  // The FIRST upward ask for P never answers (the slow in-flight lookup); a later one is the
  // fake's ordinary 100 ms round trip to M.
  const realOpener = P.opener;
  let asks = 0;
  P.calls.opener = 0;
  P.opener = () => {
    P.calls.opener += 1;
    asks += 1;
    if (asks === 1) return new Promise(() => {});
    return realOpener();
  };

  ownership.markTouched(P);
  await later(30); // the touch walk's own ask is in flight now (and it is the one that hangs)
  assert.equal(P.calls.opener, 1, "the case is not vacuous: the first upward ask is IN FLIGHT (and never answers) when settle() is called");
  slowInFlightArrival(world); // settleWork() is still on it at ~1900 ms: past the 1500 ms deadline
  const { outcome, elapsed } = await timed(() => ownership.settle(), 9000);

  assert.equal(outcome, "done", `settle() has to come back (${outcome} after ${elapsed} ms)`);
  assert.ok(
    elapsed > 1500,
    `the case is not vacuous: settleWork() really waited longer than one walk deadline (${elapsed} ms) — which is exactly the wait that used to be taken out of the re-run's budget`,
  );
  assert.equal(ownership.classify(P), "bot", "the page the bot drove is the bot's");
  assert.equal(
    ownership.classify(M),
    "bot",
    `the re-run COMPLETED the walk the touch's first (hanging) ask could not: M — the tab that opened the page the bot drove — is the bot's (RED at HEAD: the re-run's deadline was captured before settleWork(), so the wait ate it and the re-run walked nothing; the hanging ask was asked ${P.calls.opener} time(s) in all)`,
  );
  assert.equal(ownership.classify(G), "bot", "…and the chain above M follows to the root: the re-run had a full deadline to climb it");
  assert.ok(R.calls.opener > 0, "the case is not vacuous: the re-run did ask the unrelated tab for its opener");
  assert.equal(
    ownership.classify(R),
    "operator",
    "CONTROL: R is related to nothing and ANSWERED 'no opener' (a 600 ms round trip the re-run's full deadline still covered): it stays the operator's — the re-run must not fail closed on pages it managed to read",
  );
});

// F2 REWRITTEN for T29 (round 14): the wrapper has NO TIMER. An action stays OPEN until the
// handler actually settles (or throws), however long that takes — the bracket ends only in
// try/finally, or on the promise's settle. The removed `maxToolActionMs` timer ended the action
// under a call that was still RUNNING, which is a FAIL-OPEN: the tab a slow click produces
// arrives after that timer, so it arrived after the action it belonged to had been ended (and
// after the window) and was left unguarded. The option may still be ACCEPTED for back-compat,
// but it must have NO EFFECT at all.
test("F2 (T29): a never-settling handler keeps its action OPEN past the old maxToolActionMs — only the handler's own settle ends it, exactly once", async () => {
  const wrap = ownershipModule.wrapToolWithBotAction;
  assert.equal(
    typeof wrap,
    "function",
    "page-ownership.js exports wrapToolWithBotAction(server, ownership, options)",
  );

  /**
   * The scene F2 is read in: one bot page and a 120 ms window, stepped over BEFORE the call,
   * so from then on only an OPEN ACTION can claim an independent arrival.
   */
  const scene = async () => {
    const world = worldWithTargetInfo();
    const ownership = createPageOwnership({ botActionWindowMs: 120 });
    await ownership.attachContext(world.context);
    const botPage = world.addPage("B", { targetId: "target-bot" });
    ownership.markTouched(botPage);
    await ownership.settle();
    await later(200); // past the window the mark opened: only an OPEN action can claim from here
    const calls = spyBotActions(ownership);
    const { server, registered } = fakeToolServer();
    return { world, ownership, calls, server, registered };
  };

  /** Emit a no-opener/no-openerId arrival NOW and report its class. */
  const arrivalClass = async (world, ownership, name) => {
    const page = world.addPage(name);
    world.emitPage(page);
    await ownership.settle();
    return ownership.classify(page);
  };

  // (a) THE OLD CAP IS HANDED IN AND IGNORED: `maxToolActionMs: 150`, with a call that runs
  // three times longer, must end nothing.
  {
    const { world, ownership, calls, server, registered } = await scene();
    const returned = wrap(server, ownership, { maxToolActionMs: 150 });
    assert.equal(returned, server, "the wrapper returns the server it was handed");

    const gate = deferred(); // the handler's promise: settled by THIS case, never by a clock
    server.tool("never_settles", {}, () => gate.promise);
    const running = registered[0].args[1]();
    assert.ok(running && typeof running.then === "function", "the wrapped call hands back a promise the caller can await");
    assert.deepEqual(calls, ["beginBotAction"], "beginBotAction runs before the handler, and endBotAction has not run yet");

    // 500 ms in — well past the 150 ms `maxToolActionMs` the wrapper was handed.
    await later(500);
    assert.deepEqual(
      calls,
      ["beginBotAction"],
      "the action is STILL OPEN 500 ms into the call: the bracket ends only when the handler settles, NEVER on a timer, and maxToolActionMs has no effect (RED at HEAD: the 150 ms timer called endBotAction 350 ms ago, so the log is [beginBotAction, endBotAction])",
    );
    assert.equal(
      await arrivalClass(world, ownership, "during"),
      "bot",
      "an independent arrival 500 ms into a still-running call is BOT: the action is open (RED at HEAD: the timer ended the action at 150 ms and the 120 ms window was long past, so 'uncertain')",
    );
    assert.deepEqual(calls, ["beginBotAction"], "classifying an arrival neither opens nor closes an action");

    gate.resolve("late");
    assert.equal(await running, "late", "the handler's value reaches the caller unchanged when it finally settles");
    assert.deepEqual(
      calls,
      ["beginBotAction", "endBotAction"],
      "endBotAction runs EXACTLY ONCE, and only AFTER the handler's promise settled — no end from a timer, none a second time from the settle",
    );

    // CONTROL: past the window the settle stamped, the window rule governs again.
    await later(200);
    assert.equal(
      await arrivalClass(world, ownership, "after"),
      "uncertain",
      "CONTROL: an independent arrival after the call settled and past the 120 ms window is 'uncertain' — the OPEN ACTION, not the scene, made 'during' the bot's",
    );
  }

  // (b) The same with NO options at all: the wrapper's own DEFAULT must not end anything on a
  // clock either (a default cap is still a timer).
  {
    const { world, ownership, calls, server, registered } = await scene();
    wrap(server, ownership);
    const gate = deferred();
    server.tool("never_settles_default", {}, () => gate.promise);
    const running = registered[0].args[1]();
    assert.deepEqual(calls, ["beginBotAction"], "the call begins one action");

    await later(500);
    assert.deepEqual(
      calls,
      ["beginBotAction"],
      "with NO options the action is still open 500 ms in: there is no default timer left in the wrapper — the bracket ends with the handler and with nothing else",
    );
    assert.equal(
      await arrivalClass(world, ownership, "during-default"),
      "bot",
      "…so an independent arrival during it is BOT",
    );

    gate.resolve("done");
    assert.equal(await running, "done", "the handler's value passes through");
    assert.deepEqual(calls, ["beginBotAction", "endBotAction"], "the settle ends it, exactly once");
    await later(200);
    assert.equal(
      await arrivalClass(world, ownership, "after-default"),
      "uncertain",
      "CONTROL: after the settle and past the window nothing claims the arrival",
    );
  }
});

// F3: tokens, not a bare stack pop.
test("F3: beginBotAction returns a token, endBotAction(token) ends exactly that action, and endBotAction() still ends the oldest", async () => {
  /** The scene F3 is read in: one bot page, a 100 ms window stepped over before any action. */
  const scene = async () => {
    const world = worldWithTargetInfo();
    const ownership = createPageOwnership({ botActionWindowMs: 100 });
    await ownership.attachContext(world.context);
    const botPage = world.addPage("B", { targetId: "target-bot" });
    ownership.markTouched(botPage);
    await ownership.settle();
    await later(150); // past the window: only an OPEN action can claim an arrival from here
    return { world, ownership };
  };
  const arrivalClass = async (world, ownership, name) => {
    const page = world.addPage(name);
    world.emitPage(page);
    await ownership.settle();
    return ownership.classify(page);
  };

  // (a) OVERLAPPING actions A and B: ending A must leave B OPEN.
  {
    const { world, ownership } = await scene();
    const a = botAction(ownership, "beginBotAction")();
    const b = botAction(ownership, "beginBotAction")();
    assert.ok(
      a !== undefined && a !== null,
      "beginBotAction() returns a TOKEN (an opaque id) for the action it opened (RED at HEAD: it returns nothing, so a caller cannot say WHICH action it is ending)",
    );
    assert.ok(b !== undefined && b !== null && b !== a, "a second beginBotAction() hands back a different token");

    botAction(ownership, "endBotAction")(a); // A ends; B stays open
    assert.equal(
      await arrivalClass(world, ownership, "after-ending-a"),
      "bot",
      "B is STILL OPEN after endBotAction(A), so an independent arrival is still the bot's (RED at HEAD: endBotAction pops the stack, so ending A removed B and left nothing open)",
    );

    botAction(ownership, "endBotAction")(b);
    await later(150);
    assert.equal(
      await arrivalClass(world, ownership, "after-ending-b"),
      "uncertain",
      "CONTROL: with both actions ended and the window past, the same arrival is 'uncertain'",
    );

    // A double end, and a token nobody ever got: both no-ops, never below zero.
    botAction(ownership, "endBotAction")(a);
    botAction(ownership, "endBotAction")("no-such-token");
    await later(150);
    assert.equal(
      await arrivalClass(world, ownership, "after-double-end"),
      "uncertain",
      "CONTROL: an already-ended token, and a token nobody knows, are no-ops — nothing is ended twice and the count never goes below zero",
    );

    // …and the state machine still works afterwards.
    botAction(ownership, "beginBotAction")();
    assert.equal(
      await arrivalClass(world, ownership, "fresh-action"),
      "bot",
      "a NEW action after the double end still claims an independent arrival",
    );
    botAction(ownership, "endBotAction")(); // no argument: still accepted
  }

  // (b) BACK-COMPAT: endBotAction() with NO argument is still accepted, and removes the OLDEST
  // open entry — so the later action is the one left open.
  {
    const { world, ownership } = await scene();
    botAction(ownership, "beginBotAction")(); // the oldest
    botAction(ownership, "beginBotAction")(); // the later one
    botAction(ownership, "endBotAction")(); // no argument
    assert.equal(
      await arrivalClass(world, ownership, "after-bare-end"),
      "bot",
      "endBotAction() with no argument stays accepted and removes the OLDEST open entry, so the later action is still open and still claims a no-openerId arrival",
    );
    botAction(ownership, "endBotAction")();
    await later(150);
    assert.equal(
      await arrivalClass(world, ownership, "after-both"),
      "uncertain",
      "CONTROL: once the second action is ended too, nothing claims the arrival",
    );
  }

  // (c) the WRAPPER uses tokens: it ends its action with the very token its begin returned.
  {
    const ownership = createPageOwnership();
    const calls = spyBotActionTokens(ownership);
    const { server, registered } = fakeToolServer();
    ownershipModule.wrapToolWithBotAction(server, ownership);
    server.tool("demo_tool", {}, async () => "acted");
    assert.equal(await registered[0].args[1](), "acted", "the wrapped handler's value passes through");
    assert.equal(calls.length, 2, `one call is one begin and one end (calls: ${JSON.stringify(calls.map((call) => call.name))})`);
    assert.equal(calls[0].name, "beginBotAction", "the begin comes first");
    assert.equal(calls[1].name, "endBotAction", "…and the end second");
    assert.ok(calls[0].token !== undefined && calls[0].token !== null, "beginBotAction hands the wrapper its token");
    assert.equal(
      calls[1].args[0],
      calls[0].token,
      "the wrapper ends its action with the TOKEN its own begin returned (RED at HEAD: begin returns nothing and end is called with no argument at all)",
    );
  }
});

// ---------------------------------------------------------------------------
// 19. T27: the REST of the round-12 findings (RED tests, tests only)
//
//   B1  BLOCKING, and fail-OPEN. `settleWalks()` takes its re-run deadline BEFORE
//       `await settleWork()`, so that wait is spent out of the re-run's own budget: a
//       `settle()` started straight after a touch re-runs the walk on an ALREADY
//       EXPIRED deadline, `walkComponent()` returns at its first loop-top check, and
//       nothing it never looked at is marked. The popup of the page the bot just drove
//       therefore stays at the operator default, over the exit.
//       THE RULE, and it is the one this module exists for (any doubt -> BOT):
//         (a) the re-run's deadline is taken AFTER `settleWork()`;
//         (b) in fail-closed mode EVERY early exit of `walkComponent()` — the deadline
//             at the loop top, the depth cap, a failed id lookup for a NAMED candidate,
//             an incomplete upward lookup — marks BOT every live page of the scanned
//             context that is not in `seen` and has no proven "unrelated" answer for
//             that walk.
//       Every one of those four early exits has its own case below, each next to the
//       control that keeps it honest (a page that DID answer "no opener" stays the
//       operator's), and the repro5 scene (pre-attach O -> P -> Q, a 900 ms `opener()`
//       on P and a 1200 ms one on Q) is B1-a.
//   m2  an upward live `opener()` that never answers gives up one channel too early: the
//       node's CDP `openerId` (`Target.getTargetInfo`, a SEPARATE ask from `opener()`) is
//       not tried, so the tab that opened the page the bot drove keeps the operator
//       default although the browser itself still says which tab it was.
//   m1  the settle BUDGET is not guaranteed end to end. `settle()` takes no budget at
//       all, so a settle the exit cleanup starts can outlive the cleanup's own budget
//       and the pages behind it are read while it runs. It takes `settle({ budgetMs })`
//       (optional): the cap covers `settleWork()` AND the re-run, it returns when the
//       budget is spent, and whatever it did not walk is failed closed. And
//       private-address.js's exit cleanup has to HAND its remaining budget in.
//
// The product code is the NEXT task's (I27). Every case carries its control, so a
// fail-closed rule cannot pass by marking everything the bot's, and every case is RED
// at HEAD where the finding is (the failure is the bug report).
// ---------------------------------------------------------------------------

const PRIVATE_ADDRESS_JS = new URL("../bundles/browser/server/private-address.js", import.meta.url);

// B1(a): the repro5 scene. O existed at attach, P is O's popup and Q is P's popup, all
// three of them open at attach; P's `opener()` is a 900 ms round trip and Q's is 1200 ms,
// i.e. past the 1 s bound on one lookup. `settle()` runs IMMEDIATELY after the touch, so
// the touch walk has not finished when the re-run is decided — and a `slowInFlightArrival`
// makes the `settleWork()` wait outlast the walk's own deadline deterministically (without
// it the re-run starts within a millisecond of the deadline, which is a race, not a case).
test("B1-a (T27): a settle started straight after the touch still reaches the popup Q the touch walk could not read", async () => {
  const world = makeWorld();
  const O = world.addPage("O"); // the operator's tab, open at attach
  const P = world.addPage("P", { opener: O, openerDelayMs: 900 }); // its popup, open at attach
  const Q = world.addPage("Q", { opener: P, openerDelayMs: 1200 }); // P's popup: past the 1 s bound
  const U = world.addPage("U"); // unrelated, and its opener() answers "no opener" at once
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  assert.equal(ownership.classify(P), "operator", "CONTROL: P existed at attach (proof (i))");
  assert.equal(ownership.classify(Q), "operator", "CONTROL: …and so did Q, its popup");

  ownership.markTouched(P);
  slowInFlightArrival(world); // still being classified at ~1900 ms: past the walk's 1500 ms deadline
  await ownership.settle(); // IMMEDIATELY: the touch walk is still in flight

  assert.equal(ownership.classify(P), "bot", "the page the bot drove is the bot's");
  assert.equal(ownership.classify(O), "bot", "the tab that opened it follows the touch (its 900 ms opener() answered)");
  assert.ok(Q.calls.opener > 0, "the case is not vacuous: Q's opener() really was asked and did not answer within the 1 s bound");
  assert.equal(
    ownership.classify(Q),
    "bot",
    "the popup of the page the bot drove is BOT even when settle() runs straight after the touch: a re-run on a deadline the settleWork() wait already spent walks NOTHING, and a walk that never looked at Q proved nothing about it (RED at HEAD: Q keeps the operator default over the exit)",
  );
  assert.equal(
    ownership.classify(U),
    "operator",
    "CONTROL: U answered 'no opener' in time, so it is not part of the component and stays the operator's",
  );
});

// B1(a) control: the same scene with the settle started AFTER the touch walk ran out of
// time. The re-run gets a deadline of its own there, which is the `settleWork()` half of
// the same bug — GREEN at HEAD, so the case above is the immediate settle and not the scene.
test("B1-a control (T27): the same scene with the settle started 1.6 s after the touch reaches Q (green at HEAD)", async () => {
  const world = makeWorld();
  const O = world.addPage("O");
  const P = world.addPage("P", { opener: O, openerDelayMs: 900 });
  const Q = world.addPage("Q", { opener: P, openerDelayMs: 1200 });
  const U = world.addPage("U");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  ownership.markTouched(P);
  await later(1600); // past the touch walk's own 1500 ms deadline
  await ownership.settle();

  assert.equal(ownership.classify(P), "bot", "CONTROL: the page the bot drove is the bot's");
  assert.equal(ownership.classify(O), "bot", "CONTROL: …as is the tab that opened it");
  assert.equal(
    ownership.classify(Q),
    "bot",
    "CONTROL: with the settle started after the touch walk ran out of time, the re-run has a deadline of its own and Q's 1200 ms opener() still lands inside it — so 'BOT' above is the immediate settle, not the scene",
  );
  assert.equal(ownership.classify(U), "operator", "CONTROL: U answered 'no opener' and stays the operator's");
});

// B1(b), first early exit (the deadline at the loop top) — the pages the sweep reaches are not
// only the component's: a live page of the scanned context that answered NOTHING is not the
// operator's by default either.
test("B1-a (T27), the other direction: an unrelated tab whose opener() never answers is BOT in the immediate-settle case", async () => {
  const world = makeWorld();
  const O = world.addPage("O");
  const P = world.addPage("P", { opener: O, openerDelayMs: 900 });
  const Q = world.addPage("Q", { opener: P, openerDelayMs: 1200 });
  const U = world.addPage("U");
  openerNeverAnswers(U); // nothing proves this one is not the bot's
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  ownership.markTouched(P);
  slowInFlightArrival(world); // the settleWork() wait outlasts the walk's deadline (see B1-a)
  await ownership.settle();

  assert.ok(U.calls.opener > 0, "the case is not vacuous: the touch walk asked U for its opener and got no answer");
  assert.equal(
    ownership.classify(U),
    "bot",
    "a live page of the scanned context with no proven 'unrelated' answer is BOT once the walk is fail-closed: leaving it at the operator default is a tab nobody could prove running unguarded after the exit (RED at HEAD: the expired re-run marks nothing)",
  );
  assert.equal(ownership.classify(Q), "bot", "…and so is the popup of the page the bot drove (B1-a's own page)");
});

// B1(b), second early exit: the DEPTH CAP. A chain longer than MAX_RELATIVE_DEPTH (100,
// private to the product code) is walked only as far as the cap; the links past it were
// never looked at, so nothing proves them the operator's.
test("B1-b (T27): the depth cap marks the chain beyond MAX_RELATIVE_DEPTH BOT; the root that answered 'no opener' stays the operator's", async () => {
  const CHAIN = 130; // well past the cap of 100
  const world = makeWorld();
  const chain = [];
  for (let index = 0; index <= CHAIN; index++) chain.push(world.addPage(`N${index}`));
  for (let index = 0; index < CHAIN; index++) chain[index].openerPage = chain[index + 1]; // N0 opened by N1, … by N130
  const U = world.addPage("U"); // unrelated: nothing opened it
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  // The relations a live browser hands over while the chain is opened: each link's "page"
  // event. Every page here existed at attach (proof (i)), so the events record the
  // relations and change no class.
  for (let index = 0; index < CHAIN; index++) world.emitPage(chain[index]);
  await ownership.settle();
  assert.equal(ownership.classify(chain[CHAIN]), "operator", "CONTROL: the root of the chain is the operator's before the touch");

  ownership.markTouched(chain[0]);
  await ownership.settle();

  assert.equal(ownership.classify(chain[0]), "bot", "the page the bot drove is the bot's");
  assert.equal(
    ownership.classify(chain[120]),
    "bot",
    "a link the walk never reached (it stopped at the depth cap) has NO proven 'unrelated' answer, so it is BOT: the walk proved nothing about it (RED at HEAD: the cap only makes the walk incomplete, and the links past it keep the operator default)",
  );
  assert.equal(
    ownership.classify(chain[CHAIN]),
    "operator",
    "CONTROL: the root answered 'no opener' when the walk asked it as a live candidate, so it is proven unrelated and stays the operator's",
  );
  assert.equal(ownership.classify(U), "operator", "CONTROL: …and so does the unrelated tab that answered the same way");
});

// B1(b), third early exit: a FAILED id lookup for a NAMED candidate. The walk judges a
// candidate whose CDP `openerId` is on record by that id instead of asking it, and that
// judgement needs the NODE's own target id. When that lookup fails the candidate is left
// unjudged — which is not a proof that it is the operator's.
test("B1-c (T27): a failed id lookup leaves the NAMED candidate BOT instead of at the operator default", async () => {
  const world = worldWithTargetInfo({
    openerIdFor: (page) => (page && page.name === "N" ? "target-O" : undefined),
    throwFor: (page) => Boolean(page) && page.name === "P",
  });
  const O = world.addPage("O", { targetId: "target-O" });
  const P = world.addPage("P");
  const N = world.addPage("N");
  const U = world.addPage("U");
  // P's own target id cannot be had from EITHER source: its page's context throws, and so
  // does the attached one (the fake above).
  controlledContext(P, { lookup: "throw" });
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  // A bot page has to be owned for an arrival's `openerId` to be asked at all.
  const B = world.addPage("B", { targetId: "target-bot" });
  ownership.markTouched(B);
  await ownership.settle();

  // N arrives as the operator's popup of O (its `openerId` names the LIVE operator page
  // O, proof (iii)), so the id is on record and the walk will judge it by that id alone.
  world.emitPage(N);
  await ownership.settle();
  assert.equal(ownership.classify(N), "operator", "CONTROL: N's openerId names the live operator page O (proof (iii))");
  assert.equal(ownership.classify(U), "operator", "CONTROL: U existed at attach (proof (i))");

  ownership.markTouched(P);
  await ownership.settle();

  assert.equal(ownership.classify(P), "bot", "the page the bot drove is the bot's");
  assert.equal(
    ownership.classify(N),
    "bot",
    "a NAMED candidate the walk could not judge (the node's own target id could not be had) is BOT: the walk's business is proving pages unrelated, and this one it never proved (RED at HEAD: the failed lookup only marks the walk incomplete, and N keeps the operator default)",
  );
  assert.equal(ownership.classify(U), "operator", "CONTROL: U answered 'no opener' in the walk, so it stays the operator's");
  assert.ok(O.calls.opener > 0, "CONTROL: O was asked as a live candidate and answered 'no opener' — the id, not that answer, is what judges N");
});

// B1(b), fourth early exit: an INCOMPLETE UPWARD lookup. The walked page's own `opener()`
// never answered, so the walk could not finish — and a page with a RECORDED opener is
// never one of the live candidates, so nothing ever asked it either.
test("B1-d (T27): an incomplete upward lookup marks the pages the walk never proved BOT", async () => {
  const world = makeWorld();
  const P = world.addPage("P");
  openerNeverAnswers(P); // the walk's own upward ask for the touched page
  const A = world.addPage("A"); // has a RECORDED opener, so the walk never asks it
  const W = world.addPage("W"); // A's opener: answers "no opener"
  const U = world.addPage("U"); // unrelated: answers "no opener"
  A.openerPage = W;
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  world.emitPage(A); // records A -> W (A stays the operator's: proof (i))
  await ownership.settle();
  assert.equal(ownership.classify(A), "operator", "CONTROL: A existed at attach (proof (i))");

  ownership.markTouched(P);
  await ownership.settle();

  assert.ok(P.calls.opener > 0, "the case is not vacuous: the touched page's own upward opener() was asked and never answered");
  assert.equal(ownership.classify(P), "bot", "the page the bot drove is the bot's");
  assert.equal(
    ownership.classify(A),
    "bot",
    "a page an incomplete walk never proved (it has a recorded opener, so it is never one of the live candidates) is BOT: the walk that cannot finish proves nothing about it (RED at HEAD: A keeps the operator default)",
  );
  assert.equal(ownership.classify(W), "operator", "CONTROL: W answered 'no opener' as a live candidate, so it is proven unrelated");
  assert.equal(ownership.classify(U), "operator", "CONTROL: …and so does U");
});

// m2: the CDP `openerId` of the node, a SEPARATE channel from `opener()`.
test("m2 (T27): an upward opener() that never answers falls back to the node's CDP openerId", async () => {
  const world = worldWithTargetInfo({ openerIdFor: (page) => (page && page.name === "P" ? "target-O" : undefined) });
  const O = world.addPage("O", { targetId: "target-O" });
  const P = world.addPage("P");
  openerNeverAnswers(P); // the upward live ask never comes back
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  ownership.markTouched(P);
  await ownership.settle();

  assert.ok(P.calls.opener > 0, "the case is not vacuous: the upward live opener() was asked and never answered");
  assert.equal(ownership.classify(P), "bot", "the page the bot drove is the bot's");
  assert.equal(
    ownership.classify(O),
    "bot",
    "when the upward opener() does not answer, the node's CDP openerId is asked BEFORE giving up — it is a separate ask (`Target.getTargetInfo`), and it names O's target id, so O — the tab that opened the page the bot drove — is BOT (RED at HEAD: only opener() is asked, its answer never comes, and O keeps the operator default)",
  );
});

// m2 control: with nothing for the fallback to find, the fail-closed component rule decides.
test("m2 control (T27): with no openerId to fall back to and nothing answering, the fail-closed rule decides", async () => {
  const world = worldWithTargetInfo(); // answers target info without any openerId at all
  const O = world.addPage("O");
  openerNeverAnswers(O); // nothing answers for O either
  const P = world.addPage("P");
  openerNeverAnswers(P);
  const U = world.addPage("U"); // answers "no opener" at once
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  ownership.markTouched(P);
  await ownership.settle();

  assert.equal(ownership.classify(P), "bot", "CONTROL: the page the bot drove is the bot's");
  assert.equal(
    ownership.classify(O),
    "bot",
    "CONTROL: both channels answer nothing, so the fail-closed component rule is what decides — a live page nobody could prove is the operator's is BOT",
  );
  assert.equal(ownership.classify(U), "operator", "CONTROL: U answered 'no opener' in the walk, so the rule is not a blanket");
});

// m1: the settle budget, end to end.
test("m1 (T27): settle({ budgetMs }) returns when the budget is spent and leaves nothing operator-by-default", async () => {
  const world = makeWorld();
  const O = world.addPage("O");
  const P = world.addPage("P", { opener: O, openerDelayMs: 900 });
  const Q = world.addPage("Q", { opener: P, openerDelayMs: 1200 });
  const L = world.addPage("L", { openerDelayMs: 900 }); // unrelated, and slow: nobody can prove it either way in time
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  ownership.markTouched(P);
  const started = Date.now();
  const { outcome, elapsed } = await timed(() => ownership.settle({ budgetMs: 800 }), 3500);
  const took = Math.max(elapsed, Date.now() - started);

  assert.equal(outcome, "done", `settle({ budgetMs: 800 }) has to come back (outcome ${outcome} after ${took} ms)`);
  assert.ok(
    took <= 1100,
    `the budget has to cover settleWork() AND the re-run: settle({ budgetMs: 800 }) must not wait out the 1500 ms walk it started (took ${took} ms — RED at HEAD: settle() takes no budget at all, so it waits for the whole batch)`,
  );
  assert.equal(ownership.classify(P), "bot", "the page the bot drove is the bot's");
  assert.equal(ownership.classify(O), "bot", "a page the budget did not leave time to prove unrelated is BOT");
  assert.equal(
    ownership.classify(Q),
    "bot",
    "…and so is the popup of the page the bot drove: a settle that returns when its budget is spent must fail closed on what it did not walk, not leave it at the operator default (RED at HEAD)",
  );
  assert.equal(ownership.classify(L), "bot", "…and a live page whose 900 ms opener() did not answer inside the budget is BOT too");
});

// m1 control: the budget does not take a page that DID answer away from the operator.
test("m1 control (T27): a page that answered 'no opener' inside the budget stays the operator's", async () => {
  const world = makeWorld();
  const P = world.addPage("P");
  const U = world.addPage("U");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  ownership.markTouched(P);
  const { outcome, elapsed } = await timed(() => ownership.settle({ budgetMs: 800 }), 3500);
  assert.equal(outcome, "done", `CONTROL: settle({ budgetMs: 800 }) comes back (outcome ${outcome} after ${elapsed} ms)`);
  assert.equal(ownership.classify(P), "bot", "CONTROL: the page the bot drove is the bot's");
  assert.ok(U.calls.opener > 0, "CONTROL: the walk asked U for its opener (the counter is not vacuous)");
  assert.equal(
    ownership.classify(U),
    "operator",
    "CONTROL: U answered 'no opener' inside the budget, so the fail-closed rule does not take it: the budget bounds the walk, it does not neuter it",
  );
});

// m1, the other end: the exit cleanup has to HAND its remaining budget to settle().
test("m1 (T27): private-address.js's exit cleanup passes its remaining budget into settle()", async () => {
  // STATIC half: every settle() the cleanup makes carries a budgetMs draw. A settle with
  // no budget is one the cleanup cannot bound, which is the finding.
  const code = stripComments(readFileSync(PRIVATE_ADDRESS_JS, "utf8"));
  const settleCalls = [];
  const re = /\.settle\s*\(/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    settleCalls.push(balanced(code, match.index + match[0].length - 1));
  }
  assert.ok(settleCalls.length > 0, "private-address.js calls ownership.settle() (the pages are read only after it)");
  for (const args of settleCalls) {
    assert.match(
      args,
      /budgetMs\s*:\s*\S/,
      `every settle() the exit cleanup makes has to carry its remaining budget as { budgetMs: <number> }: a settle with no budget can outlive the cleanup's own (saw settle(${args.trim()}))`,
    );
    assert.doesNotMatch(args, /budgetMs\s*:\s*0*\.?0+\s*[,}]/, "…and it is not a budget that is already spent");
  }

  // BEHAVIOURAL half, through the existing exit-cleanup fake: the number is a real one,
  // and it is never larger than the cleanup's own budget.
  const world = makeWorld();
  const operatorPage = world.addPage("operator");
  const seen = [];
  const fakeOwnership = {
    classify: () => "operator",
    settle: (options) => {
      seen.push(options);
      return Promise.resolve();
    },
    pending: () => false,
    botPageCount: () => 0,
    unresolvedMarks: () => 0,
  };
  await runExitCleanup(world, { ownership: fakeOwnership, budgetMs: 1500 });

  assert.ok(seen.length > 0, "the exit cleanup really did call settle() (the fake counted none)");
  for (const options of seen) {
    assert.ok(options && typeof options === "object", `settle() is called with an options object (saw ${JSON.stringify(options)})`);
    assert.equal(typeof options.budgetMs, "number", "…whose budgetMs is a NUMBER");
    assert.ok(Number.isFinite(options.budgetMs), `…a finite one (saw ${options.budgetMs})`);
    assert.ok(options.budgetMs > 0, `…that is not already spent (saw ${options.budgetMs})`);
    assert.ok(
      options.budgetMs <= 1500,
      `…and never larger than the cleanup's own budget (saw ${options.budgetMs} against 1500): the settle has to fit INSIDE the cleanup, not start a second full one`,
    );
  }
  assert.deepEqual(callCounts(operatorPage), ZERO_CALLS, "the operator's page is still never navigated, closed, probed or attached");
});

// ---------------------------------------------------------------------------
// 20. T28: the round-13 minors, m2 and m3 (RED tests, tests only)
//
//   m2  settle() must not EAT the whole exit budget. The cleanup hands it
//       `remainingBudgetMs() - reserve`, a 500 ms reserve kept back for the blanking
//       and closing the cleanup still has to do (floor 1 ms), so a settle can never
//       spend the budget the work behind it needs. At HEAD the settle is handed the
//       whole remainder (`remainingBudgetMs()`): it may take every millisecond the
//       cleanup has and leave nothing to blank a page with.
//   m3  crow_browser_wait_for's `timeout_ms` must be capped at or below the
//       tool-dispatch wrapper's `maxToolActionMs` default (300000 ms). A call that
//       waits longer than the action bracketing it outlives its own action: the
//       action ends while the call still runs, so the tabs its slow click produces
//       stop being claimed. The cap takes the number from ONE place —
//       `DEFAULT_MAX_TOOL_ACTION_MS`, exported by page-ownership.js — so the schema
//       cannot drift away from the wrapper's own default.
//
// The product code is the NEXT task's. Every case is RED at HEAD where the finding
// is (the failure is the bug report), and each one carries its control.
// ---------------------------------------------------------------------------

/** The reserve m2 is about: what the exit cleanup keeps back for blanking and closing. */
const EXIT_SETTLE_RESERVE_MS = 500;

/**
 * A fake ownership for `blankPagesOnExit` that RECORDS every settle() it is handed:
 * `{ at, budgetMs }` per call, so "what is left minus the reserve" is a list of numbers
 * and not an impression. `classify` answers BOT for every page — a context holding
 * nothing of the bot's stops before its second settle, which would make "a later call"
 * vacuous — and `delayFirstMs` makes the FIRST settle take real time, so a later call is
 * measured against a budget that genuinely shrank.
 */
function recordingSettleOwnership(options = {}) {
  const calls = [];
  const delayFirstMs = Number(options.delayFirstMs) || 0;
  return {
    calls,
    classify: () => "bot",
    settle: async (settleOptions) => {
      calls.push({ at: Date.now(), budgetMs: settleOptions ? settleOptions.budgetMs : undefined });
      if (delayFirstMs && calls.length === 1) await later(delayFirstMs);
    },
    pending: () => false,
    botPageCount: () => 2,
    unresolvedMarks: () => 0,
  };
}

// m2: the reserve. The cleanup's own budget is 2000 ms, so a settle handed the whole
// remainder (~2000) has already eaten more than the reserve the blanking behind it needs.
test("m2 (T28): the exit cleanup hands settle() its remaining budget MINUS a 500 ms reserve for blanking and closing", async () => {
  const CLEANUP_BUDGET_MS = 2000;
  const world = makeWorld();
  world.addPage("bot-1");
  world.addPage("bot-2");
  const ownership = recordingSettleOwnership({ delayFirstMs: 120 });
  const startedAt = Date.now();
  await runExitCleanup(world, { ownership, budgetMs: CLEANUP_BUDGET_MS });
  const calls = ownership.calls;

  assert.ok(
    calls.length >= 2,
    `the cleanup settled more than once, so "a later call" is not vacuous (saw ${calls.length})`,
  );
  for (const call of calls) {
    assert.equal(
      typeof call.budgetMs,
      "number",
      `every settle() is handed a budgetMs NUMBER (saw ${JSON.stringify(call.budgetMs)})`,
    );
  }

  const first = calls[0];
  assert.ok(first.budgetMs >= 1, `the first settle budget is at least 1 ms (saw ${first.budgetMs})`);
  assert.ok(
    first.budgetMs <= CLEANUP_BUDGET_MS - EXIT_SETTLE_RESERVE_MS,
    `the first settle() must NOT eat the whole exit budget: it is handed what is left MINUS the ${EXIT_SETTLE_RESERVE_MS} ms reserve kept back for the blanking and closing behind it ` +
      `(saw ${first.budgetMs} against a ${CLEANUP_BUDGET_MS} ms cleanup budget — RED at HEAD: it is handed the whole remaining budget, so the settle may spend every millisecond the cleanup has and leave none for the work it starts)`,
  );

  // A LATER call, after real time passed inside the cleanup: still bounded by what is
  // left minus the reserve, and never below the 1 ms floor. `startedAt` is taken BEFORE
  // the cleanup starts, so this ceiling is at worst generous by the fraction of a
  // millisecond in between — never tight enough to be a race.
  for (const call of calls.slice(1)) {
    const elapsed = call.at - startedAt;
    assert.ok(
      call.budgetMs >= 1,
      `a later settle budget is still at least 1 ms after ${elapsed} ms, never 0 or a negative number (saw ${call.budgetMs})`,
    );
    assert.ok(
      call.budgetMs === 1 || call.budgetMs <= CLEANUP_BUDGET_MS - EXIT_SETTLE_RESERVE_MS - elapsed,
      `a settle taken ${elapsed} ms into the cleanup is still what is left minus the reserve (saw ${call.budgetMs}, ceiling ${CLEANUP_BUDGET_MS - EXIT_SETTLE_RESERVE_MS - elapsed} — RED at HEAD: the whole remainder is handed over)`,
    );
  }
});

// m2 control, the floor: a cleanup budget SMALLER than the reserve would make
// `remaining - reserve` negative, and the settle is floored at 1 ms instead.
test("m2 control (T28): a cleanup budget below the reserve leaves settle() exactly the 1 ms floor — never 0, never negative, never undefined", async () => {
  const CLEANUP_BUDGET_MS = 300; // 300 - 500 is negative: the reserve alone would be a spent budget
  const world = makeWorld();
  world.addPage("bot-1");
  const ownership = recordingSettleOwnership();
  // The budget may expire into the fail-closed path here; its console line is not what
  // this case is about.
  await withConsoleError(() => runExitCleanup(world, { ownership, budgetMs: CLEANUP_BUDGET_MS }));

  assert.ok(ownership.calls.length > 0, "the cleanup really did call settle() (the recorder counted none)");
  for (const call of ownership.calls) {
    assert.equal(
      call.budgetMs,
      1,
      `with a ${CLEANUP_BUDGET_MS} ms cleanup budget the remaining-minus-reserve draw is negative, so the floor is 1 ms — never 0, never a negative number, never undefined ` +
        `(saw ${String(call.budgetMs)}; RED at HEAD: the whole ${CLEANUP_BUDGET_MS} ms budget is handed over)`,
    );
  }
});

/** The crow_browser_wait_for REGISTRATION's arguments, up to its handler: the schema region. */
function waitForSchemaRegion(source) {
  const nameAt = source.indexOf('"crow_browser_wait_for"');
  assert.notEqual(nameAt, -1, `${SERVER_JS.pathname} registers crow_browser_wait_for`);
  const handlerAt = source.indexOf("async (", nameAt);
  assert.notEqual(handlerAt, -1, "the crow_browser_wait_for registration has a handler after its schema");
  return source.slice(nameAt, handlerAt);
}

/**
 * The expression a schema field `name:` is given, up to the comma (or the closing
 * bracket) that ends it — a zod chain is one expression, however it is wrapped.
 */
function schemaFieldExpression(region, name) {
  const at = region.indexOf(`${name}:`);
  assert.notEqual(at, -1, `the schema region has a ${name} field (saw: ${region.trim().slice(0, 400)})`);
  let depth = 0;
  let quote = null;
  let out = "";
  for (let i = at + name.length + 1; i < region.length; i++) {
    const c = region[i];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += region[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth -= 1;
    }
    if (c === "," && depth === 0) break;
    out += c;
  }
  return out.trim();
}

/**
 * The margin every wait/timeout schema keeps BELOW the tool-wait cap (T29): 300000 - 5000, so a
 * parameter's bound is 295000 ms. A call asked to wait the full cap would still be running when
 * the bracket around it has to close, and the tab its slow click produces would be unclaimed.
 */
const TOOL_WAIT_CAP_MARGIN_MS = 5000;

/**
 * The tool-wait cap page-ownership.js exports: `DEFAULT_MAX_TOOL_ACTION_MS` (the name I28
 * shipped), or `TOOL_WAIT_CAP_MS` if the product renamed it. Resolved by READING the module, so
 * the tests follow the product instead of guessing.
 */
function toolWaitCap() {
  for (const name of ["DEFAULT_MAX_TOOL_ACTION_MS", "TOOL_WAIT_CAP_MS"]) {
    const value = ownershipModule[name];
    if (typeof value === "number" && Number.isFinite(value)) return { name, ms: value };
  }
  assert.fail(
    "page-ownership.js exports the tool-wait cap as DEFAULT_MAX_TOOL_ACTION_MS (or TOOL_WAIT_CAP_MS): server.js has to cap every wait parameter below THAT number",
  );
}

/**
 * The milliseconds a `.max(…)` bound stands for: a literal (295000), the cap itself, or the cap
 * minus a written-out margin (`DEFAULT_MAX_TOOL_ACTION_MS - 5000`). Null when it is none of
 * those — an expression the test cannot read is a bound the test cannot vouch for.
 */
function boundMsOf(expression, cap) {
  const text = String(expression).replace(/\s+/g, " ").trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (text === cap.name) return cap.ms;
  const withMargin = new RegExp(`^${cap.name} ?- ?(\\d+)$`).exec(text);
  if (withMargin) return cap.ms - Number(withMargin[1]);
  return null;
}

/** The REGISTRATION arguments of `toolName`, up to its handler: that tool's schema region. */
function toolSchemaRegion(source, toolName) {
  const nameAt = source.indexOf(`"${toolName}"`);
  assert.notEqual(nameAt, -1, `${SERVER_JS.pathname} registers ${toolName}`);
  const handlerAt = source.indexOf("async (", nameAt);
  assert.notEqual(handlerAt, -1, `the ${toolName} registration has a handler after its schema`);
  return source.slice(nameAt, handlerAt);
}

// m3 (T29): the schema bound, statically. A tool call must not be able to outlive the action
// the tool-dispatch wrapper brackets it with, so the schema caps it BELOW the tool-wait cap
// (cap minus the 5000 ms margin). The bound may be the plain cap expression or that minus the
// margin — what it may not be is unbounded, or above the cap.
test("m3 (T28/T29): crow_browser_wait_for's timeout_ms is capped below the tool-wait cap (cap minus the 5000 ms margin)", () => {
  const code = stripComments(readFileSync(SERVER_JS, "utf8"));
  const region = waitForSchemaRegion(code);
  const chain = schemaFieldExpression(region, "timeout_ms");
  assert.match(
    chain,
    /\.max\s*\(/,
    `the zod schema for crow_browser_wait_for's timeout_ms has to carry a .max() cap, so a tool call cannot outlive the action bracketing it ` +
      `(saw ${chain} — RED at HEAD: timeout_ms is unbounded, so a 10-minute wait outlives the action it runs in)`,
  );

  const maxAt = chain.indexOf(".max");
  const capArg = balanced(chain, chain.indexOf("(", maxAt)).trim();
  assert.ok(capArg.length > 0, `the .max() cap has a value (saw ${chain})`);
  const cap = toolWaitCap();
  const capMs = boundMsOf(capArg, cap);
  assert.notEqual(
    capMs,
    null,
    `the cap is a number of milliseconds, the exported ${cap.name}, or ${cap.name} - <margin> (saw ${capArg})`,
  );
  assert.ok(
    capMs <= cap.ms - TOOL_WAIT_CAP_MARGIN_MS,
    `the cap is at or below the tool-wait cap (${cap.ms} ms) minus the ${TOOL_WAIT_CAP_MARGIN_MS} ms margin — ${cap.ms - TOOL_WAIT_CAP_MARGIN_MS} ms ` +
      `(saw ${capMs} from ${capArg}), so a tool call cannot outlive its own action`,
  );
});

// m3, the other end: ONE number, exported, from which every wait schema takes its bound — so the
// schemas and the cap cannot drift apart.
test("m3 (T28/T29): DEFAULT_MAX_TOOL_ACTION_MS is exported as 300000, and server.js uses it for the wait_for cap", () => {
  assert.equal(
    ownershipModule.DEFAULT_MAX_TOOL_ACTION_MS,
    300000,
    "page-ownership.js exports DEFAULT_MAX_TOOL_ACTION_MS = 300000 — the ONE number the wait/timeout schemas take their bound from (cap minus the 5000 ms margin)",
  );

  const code = stripComments(readFileSync(SERVER_JS, "utf8"));
  assert.match(
    code,
    /import\s*\{[^}]*\bDEFAULT_MAX_TOOL_ACTION_MS\b[^}]*\}\s*from\s*"\.\/page-ownership\.js"/,
    "server.js imports DEFAULT_MAX_TOOL_ACTION_MS from ./page-ownership.js instead of repeating the number (RED at HEAD: server.js imports only createPageOwnership and wrapToolWithBotAction)",
  );
  assert.match(
    waitForSchemaRegion(code),
    /\bDEFAULT_MAX_TOOL_ACTION_MS\b/,
    "the crow_browser_wait_for schema itself references DEFAULT_MAX_TOOL_ACTION_MS (directly, or as `DEFAULT_MAX_TOOL_ACTION_MS - 5000`), so the bound and the cap cannot drift apart",
  );
});

// ---------------------------------------------------------------------------
// 21. T29: the round-14 findings (RED tests, tests only)
//
//   THE NEW RULE, which supersedes T26 F2's timer and T28 m3's cap-only: the bot action stays
//   OPEN until the handler actually settles (or throws), however long that takes. The bracket
//   ends ONLY in try/finally or on the promise's settle, NEVER on a timer. The timer it
//   replaces was a FAIL-OPEN: a call that outlived it lost the tab its own slow click produced,
//   which then arrived after the action and after the window and was left unguarded.
//
//   The second line of defence is the SCHEMA: every wait/timeout parameter a tool accepts is
//   an integral, non-negative number bounded BELOW the tool-wait cap (cap minus a 5000 ms
//   margin, so 295000 ms; `scroll_pause_ms` its own much smaller 10000 ms), so no caller can
//   ask a tool to wait longer than the bracket it runs in can hold.
//
// The product code is the NEXT task's. Every case is RED at HEAD where the finding is (the
// failure is the bug report), and each one carries its control.
// ---------------------------------------------------------------------------

/** The BODY of the exported function `name` in `source` (skips the `{}` of a default parameter). */
function exportedFunctionBody(source, name) {
  const at = source.lastIndexOf(`export function ${name}`);
  assert.notEqual(at, -1, `page-ownership.js EXPORTS ${name}() as a function declaration`);
  const parenAt = source.indexOf("(", at);
  assert.notEqual(parenAt, -1, `${name}() has a parameter list`);
  const params = balanced(source, parenAt);
  const braceAt = source.indexOf("{", parenAt + params.length + 2);
  assert.notEqual(braceAt, -1, `${name}() has a body`);
  return balanced(source, braceAt);
}

// T29 (3): NO TIMER IN THE WRAPPER, statically. The action's end is the handler's own end.
test("T29 (static): the tool-dispatch wrapper contains no setTimeout — the bracket ends only with the handler", () => {
  const source = readFileSync(OWNERSHIP_JS, "utf8");
  const body = stripComments(exportedFunctionBody(source, "wrapToolWithBotAction"));

  assert.ok(body.length > 100, `the wrapper's body was really read (saw ${body.length} characters)`);
  assert.ok(/beginBotAction/.test(body), "the wrapper begins a bot action for each call");
  assert.ok(/endBotAction/.test(body), "…and ends it");
  assert.ok(
    !/\bsetTimeout\b/.test(body),
    "the wrapper contains NO setTimeout: the action stays open until the handler settles (or throws), however long that takes, so nothing on a clock may end it " +
      "(RED at HEAD: the wrapper ends the action from a setTimeout(maxToolActionMs) timer, so a call that outlives it loses the tab its own slow click produces)",
  );
  assert.ok(
    !/\bsetInterval\b/.test(body),
    "…and no setInterval either: no clock at all ends the bracket",
  );
});

// T29 (2): every wait/timeout PARAMETER of every tool is a bounded, integral, non-negative number.
test("T29 (static): every wait/timeout parameter's zod schema is .int().min(0) and capped below the tool-wait cap", () => {
  const code = stripComments(readFileSync(SERVER_JS, "utf8"));
  const cap = toolWaitCap();
  const capBound = cap.ms - TOOL_WAIT_CAP_MARGIN_MS;
  const params = [
    { tool: "crow_browser_wait_for", field: "timeout_ms", limitMs: capBound },
    { tool: "crow_browser_download", field: "timeout_ms", limitMs: capBound },
    { tool: "crow_browser_click", field: "wait_after", limitMs: capBound },
    { tool: "crow_browser_scroll_extract", field: "scroll_pause_ms", limitMs: 10000 },
  ];
  const problems = [];

  for (const { tool, field, limitMs } of params) {
    const chain = schemaFieldExpression(toolSchemaRegion(code, tool), field);
    const where = `${tool}.${field}`;

    if (!/^\s*z\s*\.\s*number\s*\(\s*\)/.test(chain)) {
      problems.push(`${where}: is not a zod number (saw ${chain})`);
    }
    const intAt = chain.search(/\.\s*int\s*\(\s*\)/);
    if (intAt === -1) {
      problems.push(`${where}: has no .int() — a fractional millisecond count is not a duration anyone meant (saw ${chain})`);
    }
    const minAt = chain.search(/\.\s*min\s*\(\s*0\s*\)/);
    if (minAt === -1) {
      problems.push(`${where}: has no .min(0) — a negative wait is refused by the schema, not by luck (saw ${chain})`);
    }
    if (intAt !== -1 && minAt !== -1 && minAt < intAt) {
      problems.push(`${where}: applies .min(0) before .int() (saw ${chain})`);
    }
    const maxAt = chain.search(/\.\s*max\s*\(/);
    if (maxAt === -1) {
      problems.push(`${where}: has no .max(…) — a wait longer than the action bracketing it stops being claimed when the action ends (saw ${chain})`);
      continue;
    }
    if (minAt !== -1 && maxAt < minAt) {
      problems.push(`${where}: applies .max(…) before .min(0) (saw ${chain})`);
    }

    const arg = balanced(chain, chain.indexOf("(", maxAt)).trim();
    const boundMs = boundMsOf(arg, cap);
    if (boundMs === null) {
      problems.push(`${where}: .max(${arg}) is not a number of milliseconds, ${cap.name}, or ${cap.name} - <margin>`);
    } else if (boundMs > limitMs) {
      problems.push(
        `${where}: .max(${arg}) is ${boundMs} ms, above its ${limitMs} ms bound (the tool-wait cap is ${cap.ms} ms and every wait keeps the ${TOOL_WAIT_CAP_MARGIN_MS} ms margin below it, so no call can be asked to outlive the action it runs in)`,
      );
    }
  }

  assert.deepEqual(
    problems,
    [],
    `every wait/timeout parameter is integral, non-negative and capped below the tool-wait cap (${cap.ms} - ${TOOL_WAIT_CAP_MARGIN_MS} = ${capBound} ms; 10000 ms for scroll_pause_ms). RED at HEAD:\n  - ${problems.join("\n  - ")}`,
  );
});

// ---------------------------------------------------------------------------
// 22. T30: the round-14 minors n1 and n2 (RED tests, tests only)
//
//   n1  `endOnUnfinishedSettle` (private-address.js) reads `ownership.pending()` as
//       "a classification is still in flight", and fails the cleanup closed when it
//       still is after ONE retry. But `pending()` (inFlight.size > 0) also counts the
//       TARGET-ID lookups and the `openerId` relation lookups a bot mark starts —
//       lookups that cannot change any page's class. The sequence that costs the
//       operator their browser: an exit settle hits an incomplete relatives walk,
//       `failClosedOnWalk` marks every live page it never proved BOT, EACH of those
//       marks starts an ~800 ms target-id lookup, and the settle returns with only
//       those on their way — every page is classified by then. The retry gets what is
//       left of the budget (about a millisecond), still sees them pending, and the
//       browser is crashed although the page list was complete.
//
//       The rule: the ownership exposes `classifying()` — an ARRIVAL classification
//       (`considerArrival` work) or a relatives walk in flight, EXCLUDING target-id and
//       relation-only lookups — and `classificationsInFlight` reads THAT. `pending()`
//       is unchanged: it stays the budget's question (`ownsBotWork`), where pending
//       work counts only while a bot page or an unresolved mark stands.
//
//   n2  The same path ends SILENTLY when nothing of the bot's is armed: the cleanup
//       stops with classification work unfinished and touches nothing at all. A silent
//       stop reads as a finished cleanup, so ONE `console.error` line says so — in the
//       style of the armed path (which already has its own line).
//
// The product code is the NEXT task's. Every case is RED at HEAD where the finding is
// (the failure is the bug report), and each one carries its control, so a fix cannot
// pass by never crashing on unfinished classification at all.
// ---------------------------------------------------------------------------

// n1, the unit half: `classifying()` answers the CLASS question, `pending()` the wider one.
test("n1 (T30): classifying() is false for a target-id lookup, true for an arrival classification or a walk — pending() stays wider", async () => {
  // A target-id lookup is a real round trip here (the fake CDP answers 400 ms late), so
  // "is it in flight" is a fact a test can stand on and not a race.
  const world = worldWithTargetInfo({ delayMs: 400 });
  const marked = world.addPage("marked");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  assert.equal(
    typeof ownership.classifying,
    "function",
    "the ownership exposes classifying(): whether an ARRIVAL classification or a relatives walk — the only work that can change a page's class — is still in flight (RED at HEAD: it does not exist, so the exit cleanup has nothing but pending() to read)",
  );
  assert.equal(ownership.classifying(), false, "idle: nothing is in flight, so classifying() is false");
  assert.equal(ownership.pending(), false, "…and pending() is false too");

  // (1) A bot MARK's target-id lookup: pending() sees it, classifying() must NOT. An id
  // lookup records an id; it decides nothing about any page.
  const lookup = ownership.markOpened(marked);
  assert.equal(
    ownership.pending(),
    true,
    "the mark's target-id lookup really is in flight, so pending() is true — the budget's question, and it has to stay that way",
  );
  assert.equal(
    ownership.classifying(),
    false,
    "…but classifying() is FALSE: a target-id lookup cannot change any page's class, so the page list is exactly as final as it was before it started (RED at HEAD: classifying() does not exist)",
  );
  await lookup;
  assert.equal(ownership.pending(), false, "once the lookup answered, nothing is in flight");

  // (2) A real ARRIVAL classification: `considerArrival` work, whose opener() round trip
  // is in flight. That IS classification work — its verdict is the page's class.
  const arrival = world.addPage("arrival", { opener: marked, openerDelayMs: 300 });
  world.emitPage(arrival);
  assert.equal(
    ownership.classifying(),
    true,
    "an arrival's opener() lookup is in flight, so classifying() is true: the verdict it is deciding is a page's CLASS",
  );
  assert.equal(ownership.pending(), true, "…and pending() is true as well");
  await ownership.settle();
  assert.equal(ownership.classify(arrival), "bot", "CONTROL: the arrival was decided (a popup of a bot page), so the case is not vacuous");
  assert.equal(ownership.classifying(), false, "once the arrival is decided, classifying() is false again");

  // (3) A relatives WALK: marking a page the bot DROVE starts one, and a walk marks what
  // it reaches — that is a class decision too.
  const touched = world.addPage("touched", { openerDelayMs: 300 });
  ownership.markTouched(touched);
  assert.equal(
    ownership.classifying(),
    true,
    "markTouched starts a relatives walk, and a walk that reaches a page makes it the bot's, so classifying() is true while it runs",
  );
  await ownership.settle();
  assert.ok(touched.calls.opener > 0, "CONTROL: the walk really did ask for an opener (the counter is not vacuous)");
  assert.equal(ownership.classifying(), false, "…and once the walk is done, classifying() is false again (idle)");
  assert.equal(ownership.pending(), false, "…with nothing left in flight for pending() either");
});

// n1, the behavioural half: an exit settle that ends with only target-id lookups pending
// has FINISHED the page list, so the cleanup blanks and closes instead of crashing.
test("n1 (T30): an exit settle ending with only target-id lookups pending still blanks and closes — no Browser.crash", async () => {
  // Every target-id lookup is an 800 ms round trip. The bot page's own `opener()` never
  // answers, so its relatives walk cannot finish: the exit settle's re-run fail-closes on
  // the rest of the context, marking both swept pages BOT — and each of those marks starts
  // an 800 ms target-id lookup that is still on its way when the settle returns.
  const world = worldWithTargetInfo({ delayMs: 800 });
  const sweptOne = openerNeverAnswers(world.addPage("swept-1"));
  const sweptTwo = openerNeverAnswers(world.addPage("swept-2"));
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  const botPage = openerNeverAnswers(world.addPage("bot"));
  ownership.markTouched(botPage); // the walk starts here, and runs out of time
  await later(20); // the exit cleanup begins with that walk still running, so the settle's budget is spent on it

  const lines = await withConsoleError(() => runExitCleanup(world, { ownership, budgetMs: 2000 }));

  assert.deepEqual(
    world.crashSends,
    [],
    "every page was classified before the cleanup read the list: what is still in flight is target-id lookups, which cannot change a class. Crashing the browser over them destroys pages that were already decided " +
      `(RED at HEAD: pending() is read as "a classification is still in flight", the retry settle gets about a millisecond of budget, the 800 ms lookups are still on their way, and the browser is crashed — lines: ${JSON.stringify(lines)})`,
  );
  assert.deepEqual(botPage.calls.goto, ["about:blank"], "the bot's page is blanked");
  assert.equal(botPage.calls.close, 1, "…and then closed");

  // The pages the incomplete walk failed closed on are the bot's now, so they are cleaned
  // up too — and their marks are what started the lookups the cleanup must not crash over.
  for (const page of [sweptOne, sweptTwo]) {
    assert.equal(ownership.classify(page), "bot", `${page.name} was swept BOT by the incomplete walk (the case is not vacuous)`);
    assert.ok(
      page.calls.newCDPSession > 0,
      `${page.name}'s BOT mark really did start a target-id lookup — that lookup is what the settle returns with pending`,
    );
    assert.deepEqual(page.calls.goto, ["about:blank"], `${page.name} is blanked like every page the sweep classed BOT`);
    assert.equal(page.calls.close, 1, `…and closed`);
  }
});

// n1 control: a REAL classification in flight at the end of the retry is still fail-closed.
test("n1 control (T30): an arrival classification still in flight at the retry still crashes the browser (fail closed)", async () => {
  const world = worldWithTargetInfo({ delayMs: 800 });
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  const botPage = world.addPage("bot");
  await ownership.markOpened(botPage); // bot work is ARMED: a page of the bot's is known
  await ownership.settle();
  assert.equal(ownership.botPageCount(), 1, "CONTROL: the bot owns a page, so the fail-closed end is the right one for unfinished classification work");

  // The arrival's opener() takes 1500 ms — past the 1 s bound on one lookup — so the
  // classification goes on to the CDP `openerId` ask (800 ms more) and is still deciding
  // this page's class when the settle's budget runs out.
  const arrival = world.addPage("arrival", { openerDelayMs: 1500 });
  world.emitPage(arrival);
  const startedAt = Date.now();
  await withConsoleError(() => runExitCleanup(world, { ownership, budgetMs: 2000 }));
  const elapsed = Date.now() - startedAt;

  assert.ok(
    elapsed < 1900,
    `the cleanup ends when its settle budget is spent, not when the arrival finally answers (took ${elapsed} ms) — so the classification really was still in flight`,
  );
  assert.deepEqual(
    world.crashSends,
    ["Browser.crash"],
    "an ARRIVAL classification still in flight at the end of the retry is a page whose class could still be decided; with bot work armed the browser is crashed (fail closed), exactly as before n1",
  );
  assert.deepEqual(botPage.calls.goto, [], "…and the bot's page is NOT blanked: the crash ends the cleanup");
  assert.equal(botPage.calls.close, 0, "…and nothing is closed");
});

// n2: the unarmed end of the same path is not silent any more.
test("n2 (T30): an exit cleanup that stops with classification unfinished and NOTHING of the bot's armed says so in one console.error line", async () => {
  // The path `endOnUnfinishedSettle` ends SILENTLY at HEAD: classification work is still
  // in flight and nothing of the bot's is armed, so the cleanup stops without touching a
  // page. A silent stop reads as a finished cleanup, which is what n2 is about.
  const world = makeWorld();
  const operatorPage = world.addPage("operator");
  const ownership = {
    classify: () => "operator",
    settle: async () => {},
    classifying: () => true, // a CLASSIFICATION is still in flight …
    pending: () => false,
    botPageCount: () => 0, // … and nothing of the bot's is armed
    unresolvedMarks: () => 0,
  };

  const lines = await withConsoleError(() => runExitCleanup(world, { ownership, budgetMs: 2000 }));
  const unclassified = lines.filter((line) => /unclassified/i.test(line));

  assert.equal(
    unclassified.length,
    1,
    `exactly one console.error line names the unfinished classification this cleanup stopped on (lines: ${JSON.stringify(lines)} — RED at HEAD: the path returns true without a line at all)`,
  );
  assert.match(
    unclassified[0],
    /classification/i,
    `…and it says what was unfinished, in the style of the armed path's line (saw ${JSON.stringify(unclassified[0])})`,
  );
  assert.deepEqual(world.crashSends, [], "nothing of the bot's is armed, so nothing is crashed either");
  assert.deepEqual(
    callCounts(operatorPage),
    ZERO_CALLS,
    "…and no page is navigated, closed, probed or given a CDP session: the cleanup stops before it reads them",
  );
});

// n2 control: a normal exit writes no such line.
test("n2 control (T30): a clean exit writes no 'unclassified' line", async () => {
  const world = makeWorld();
  const operatorPage = world.addPage("operator");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);
  const botPage = world.addPage("bot");
  ownership.markOpened(botPage);
  await ownership.settle();

  const lines = await withConsoleError(() => runExitCleanup(world, { ownership }));

  assert.deepEqual(
    lines.filter((line) => /unclassified/i.test(line)),
    [],
    `CONTROL: a clean exit — every page classified, the bot's page blanked and closed — writes no such line (lines: ${JSON.stringify(lines)})`,
  );
  assert.deepEqual(botPage.calls.goto, ["about:blank"], "CONTROL: and the bot's page really was cleaned up");
  assert.equal(botPage.calls.close, 1, "…blanked and closed");
  assert.deepEqual(callCounts(operatorPage), ZERO_CALLS, "…with the operator's page left exactly as it was");
  assert.deepEqual(world.crashSends, [], "…and nothing to crash");
});

// ---------------------------------------------------------------------------
// 23. T31: `classifying()` is kept by hand, and it drifts (RED tests, tests only)
//
//   `classifying()` is the NARROW question the exit cleanup asks — "can any page's CLASS
//   still change?" — and the count behind it is kept BY HAND: a `classificationsRunning`
//   counter is bumped in `considerArrival` and in `walkRelatives`, and nowhere else. But
//   those are not the only two paths that change a page's class:
//
//     - `attachContext`'s CLAIM changes it directly: a page of a re-connected context
//       whose target-id lookup is still on its way gets `setClass(page, OPERATOR)` (or a
//       BOT mark, fail closed) at the end of that claim. While the claim is in flight the
//       page's class is undecided — and `classifying()` reads FALSE, so a cleanup that
//       asks it treats a page list as FINAL when one of its pages is still being decided.
//     - `actOnOpenerIdRelation`'s lookup changes it too, indirectly but really: the page it
//       resolves is `noteRelation`'d, and `actOnRelation` marks the touched page's
//       counterpart BOT at that moment. That is a class decision — false `classifying()`.
//
//   The required shape: `track(promise, kind)` itself counts. Every tracked promise bumps
//   the `classifying` count at start and gives it back in `finally`, unless it was tracked
//   with the explicit opt-out kind `"lookup"` — the bookkeeping that cannot change a class
//   (`rememberTarget`'s target-id lookup). The DEFAULT (no kind) counts, so a new tracked
//   path cannot be left out by forgetting to bump the counter next to it, and the hand-kept
//   `classificationsRunning` is gone. Belt and braces: `classifying()` is ALSO true while a
//   LIVE, UNCLASSIFIED page has an entry in `arrivals`.
//
//   (a) and (b) are RED at HEAD (the hand counter misses both paths). (c) and (d) are the
//   controls this change must not cost: a counted promise that rejects or throws still gives
//   the count back, and T30's answers (an id lookup is NOT classification, an arrival and a
//   walk ARE) stay exactly as they were.
// ---------------------------------------------------------------------------

// (a) attachContext's claim is classification work: it decides the page's CLASS.
test("T31-a: attachContext's claim counts as classifying() — true while the reconnect page's target-id lookup is in flight, false after", async () => {
  // A first context with one bot page whose target id RESOLVED, so the reconnect below has
  // an id to look for and nothing unresolved (its claim is by id, not the fail-closed sweep).
  const first = makeWorld();
  const botPage = first.addPage("B", { targetId: "target-bot" });
  const ownership = createPageOwnership();
  await ownership.attachContext(first.context);
  await ownership.markOpened(botPage);
  await ownership.settle();
  assert.deepEqual(
    [ownership.botPageCount(), ownership.unresolvedMarks()],
    [1, 0],
    "CONTROL: the bot owns one page and every mark resolved, so the reconnect claims tab by tab instead of failing closed",
  );

  // The reconnect. This tab's target-id lookup is a real 500 ms round trip (the page's own
  // context answers it), so "is the claim in flight" is a fact and not a race.
  const second = makeWorld();
  const slowClaim = second.addPage("slow-claim", { targetId: "target-stranger" });
  controlledContext(slowClaim, { lookup: "answer", delayMs: 500 });

  const attaching = ownership.attachContext(second.context);
  await later(100);
  assert.equal(
    ownership.pending(),
    true,
    "the claim's target-id lookup really is in flight, so pending() (the wide question) is true — the case is not vacuous",
  );
  assert.equal(
    ownership.classifying(),
    true,
    "an attachContext CLAIM decides its page's class at the end of the lookup (`setClass(page, OPERATOR)`, or a BOT mark when nothing answered), so the page list is NOT final while it runs: classifying() must be true (RED at HEAD: the hand-kept counter is bumped only in considerArrival and walkRelatives, so it reads false here)",
  );
  await attaching;
  assert.equal(ownership.classifying(), false, "…and once the claim settled, classifying() is false again");
  assert.equal(ownership.pending(), false, "…with nothing left in flight for pending() either");
  assert.equal(
    ownership.classify(slowClaim),
    "operator",
    "CONTROL: the claim answered an id no bot mark remembers, so this tab is the operator's — the claim really did decide this page's class",
  );
});

// (b) actOnOpenerIdRelation's lookup is classification work too: what it resolves is marked.
test("T31-b: actOnOpenerIdRelation's lookup counts as classifying() — true while the relation's live-page id resolves, false after", async () => {
  // A bot page with a resolved id (so `botPagesCounted > 0`: the `openerId` is asked at all).
  const world = worldWithTargetInfo({
    openerIdFor: (page) => (page && page.name === "P" ? "target-relation" : undefined),
  });
  const ownership = createPageOwnership({ botActionWindowMs: 100 });
  const botPage = world.addPage("B", { targetId: "target-bot" });
  await ownership.attachContext(world.context);
  await ownership.markOpened(botPage);
  await ownership.settle();

  // The page the bot DROVE: `actOnOpenerIdRelation` resolves the relation and acts on it
  // (the counterpart of a driven page is the bot's) only for a touched/walked page.
  const driven = world.addPage("P", { targetId: "target-p" });
  ownership.markTouched(driven);
  await ownership.settle();
  assert.equal(
    ownership.classifying(),
    false,
    "CONTROL: the walk the touch started has finished, so nothing is classifying yet",
  );

  // The counterpart the relation names: a LIVE page whose target id is NOT cached and whose
  // id lookup is a 400 ms round trip. It is created only NOW — after the touch's relatives
  // walk has FINISHED — so the walk provably could not have asked for (and cached) its target
  // id: whether it got there first used to be timing, and the relation's lookup was then served
  // from the cache and opened no session at all.
  const relation = world.addPage("O", { targetId: "target-relation" });
  const relationLookups = controlledContext(relation, { lookup: "answer", delayMs: 400 });
  // `relationLookups.sessions` is where THAT session is counted: the lookup is answered by O's
  // OWN context (`controlledContext` replaces it), while `page.calls.newCDPSession` is only
  // bumped by the WORLD context — which is never asked for O's target id, because its own
  // context answers first. A before/after delta of that counter therefore reads 0 -> 0 in this
  // scene no matter how the timing falls, which is why it is not asserted any more.
  assert.deepEqual(
    [relation.calls.newCDPSession, relationLookups.sessions],
    [0, 0],
    "SETUP: nothing has asked O for its target id yet — the walk is finished and the page is brand new — so the relation's lookup below is the one that resolves it (a walk that had cached it first would make the case vacuous)",
  );

  // The driven page's own "page" event lands AFTER its mark: its class is already decided, so
  // the arrival records the `openerId` as a RELATION only and resolves it (`actOnOpenerIdRelation`).
  world.emitPage(driven);
  await later(100);
  assert.equal(
    ownership.pending(),
    true,
    "the relation's live-page id lookup really is in flight, so pending() is true — the case is not vacuous",
  );
  assert.equal(
    ownership.classifying(),
    true,
    "the page that lookup resolves is marked BOT (`noteRelation` -> `actOnRelation`, the counterpart of a driven page), so it changes a page's CLASS: classifying() must be true while it runs (RED at HEAD: `actOnOpenerIdRelation` tracks its lookup without bumping the hand-kept counter, which reads false here)",
  );
  await ownership.settle();
  assert.equal(ownership.classifying(), false, "…and once it settled, classifying() is false again");
  assert.equal(ownership.pending(), false, "…with nothing left in flight for pending() either");
  assert.equal(
    ownership.classify(relation),
    "bot",
    "CONTROL: the relation really resolved to the live page O and made it the bot's — the lookup decided a class, and the delay is not vacuous",
  );
  assert.ok(
    relationLookups.sessions >= 1,
    `CONTROL: O's target id was really asked for — a CDP session was opened on O's own context and answered 400 ms late (${relationLookups.sessions} session(s))`,
  );
});

// (c) the control: a counted promise that REJECTS or throws still gives the count back.
test("T31-c (control): a counted promise that rejects or throws still decrements — classifying() returns to false", async () => {
  // (1) the arrival's `opener()` REJECTS (after a 300 ms round trip). The classification's own
  //     promise is what carries it, and the count must come back down whichever way it went.
  {
    const world = worldWithTargetInfo();
    const ownership = createPageOwnership({ botActionWindowMs: 100 });
    await ownership.attachContext(world.context);
    const botPage = world.addPage("B");
    await ownership.markOpened(botPage);
    await ownership.settle();
    await later(150); // past the short window: this case is about the rejection, not FIX3's clock

    const rejecting = world.addPage("rejecting-opener", { openerThrows: true, openerDelayMs: 300 });
    world.emitPage(rejecting);
    await later(50);
    assert.equal(
      ownership.classifying(),
      true,
      "the arrival whose opener() is about to REJECT is still deciding its page's class, so classifying() is true",
    );
    await ownership.settle();
    assert.equal(
      ownership.classifying(),
      false,
      "a counted classification whose opener() REJECTED still gives the count back: classifying() is false (a `finally`, not a success-only decrement)",
    );
    assert.equal(
      ownership.classify(rejecting),
      "uncertain",
      "CONTROL: the rejection is no evidence of an owner, and the arrival is outside the bot-action window, so it stays 'uncertain'",
    );
  }

  // (2) the same arrival, and now the CDP session it asks for its `openerId` THROWS as well:
  //     the classification fails closed (BOT) — and still gives the count back.
  {
    const world = worldWithTargetInfo({ throwFor: (page) => Boolean(page) && page.name === "failing" });
    const ownership = createPageOwnership({ botActionWindowMs: 100 });
    await ownership.attachContext(world.context);
    const botPage = world.addPage("B");
    await ownership.markOpened(botPage);
    await ownership.settle();

    const failing = world.addPage("failing", { openerThrows: true, openerDelayMs: 200 });
    world.emitPage(failing);
    await later(50);
    assert.equal(ownership.classifying(), true, "…still classification work while the failing lookups are in flight");
    await ownership.settle();
    assert.equal(
      ownership.classifying(),
      false,
      "a classification whose opener() threw AND whose CDP session threw still gives the count back: classifying() is false",
    );
    assert.equal(
      ownership.classify(failing),
      "bot",
      "CONTROL: no target would answer, which is no evidence at all, so the page is BOT (fail closed)",
    );
  }

  // (3) the same for a WALK: its reaches are class decisions, and a walk that throws on a
  //     page's `opener` access must leave the count where it found it.
  {
    const world = makeWorld();
    const ownership = createPageOwnership();
    await ownership.attachContext(world.context);
    const hostile = world.addPage("hostile");
    Object.defineProperty(hostile, "opener", {
      configurable: true,
      get() { throw new Error("no opener property for hostile"); },
    });

    ownership.markTouched(hostile);
    assert.equal(ownership.classifying(), true, "markTouched starts a relatives walk, which IS classification work");
    await ownership.settle();
    assert.equal(
      ownership.classifying(),
      false,
      "a walk that threw on a page's `opener` access still gives the count back: classifying() is false (a `finally`, not a success-only decrement)",
    );
    assert.equal(ownership.classify(hostile), "bot", "CONTROL: the page the bot drove is the bot's");
  }
});

// (d) T30's answers stay: the narrow question, read the same way.
test("T31-d (control): T30's classifying() answers stay — a target-id lookup is NOT classification, an arrival and a walk ARE", async () => {
  // The same seam T30 pinned, re-asserted here because this change moves where the count
  // comes from: every tracked promise now counts by default, and only the explicit opt-out
  // kind ("lookup": `rememberTarget`'s bookkeeping) stays out of the narrow question.
  const world = worldWithTargetInfo({ delayMs: 400 });
  const marked = world.addPage("marked");
  const ownership = createPageOwnership();
  await ownership.attachContext(world.context);

  // (1) a bot MARK's target-id lookup: pending() sees it, classifying() must NOT — an id
  //     lookup records an id and decides nothing about any page (T30 n1).
  const lookup = ownership.markOpened(marked);
  assert.equal(ownership.pending(), true, "the mark's target-id lookup really is in flight, so pending() is true");
  assert.equal(
    ownership.classifying(),
    false,
    "CONTROL (T30 n1): a target-id lookup cannot change any page's class, so classifying() is false — the explicit 'lookup' opt-out must stay narrow enough to leave it out",
  );
  await lookup;
  assert.equal(ownership.pending(), false, "once the lookup answered, nothing is in flight");

  // (2) a real ARRIVAL classification: its verdict IS a page's class.
  const arrival = world.addPage("arrival", { opener: marked, openerDelayMs: 300 });
  world.emitPage(arrival);
  assert.equal(ownership.classifying(), true, "CONTROL (T30 n1): an arrival's opener() lookup is in flight, so classifying() is true");
  await ownership.settle();
  assert.equal(ownership.classifying(), false, "…and false once the arrival is decided");
  assert.equal(ownership.classify(arrival), "bot", "CONTROL: the arrival was decided (a popup of a bot page)");

  // (3) a relatives WALK marks every page it reaches.
  const touched = world.addPage("touched", { openerDelayMs: 300 });
  ownership.markTouched(touched);
  assert.equal(ownership.classifying(), true, "CONTROL (T30 n1): markTouched starts a relatives walk, so classifying() is true while it runs");
  await ownership.settle();
  assert.equal(ownership.classifying(), false, "…and false once the walk is done");
  assert.ok(touched.calls.opener > 0, "CONTROL: the walk really did ask for an opener (the counter is not vacuous)");
  assert.equal(ownership.pending(), false, "…with nothing left in flight for pending() either");
});
