// The restart path needs its own answer, not the exit cleanup's.
//
// `crow_browser_launch` replaces the browser on a proxy change and on a restart,
// and it closes the bot's pages through closeGuardedPages first (deny-all
// session, about:blank, close after the grace). But `{ ok: false }` there does
// NOT mean the browser is gone: the cleanup also answers false when it could not
// open a browser CDP session to crash it, or when `Browser.crash` was refused —
// the browser is still running, with the bot's pages possibly unguarded. Dropping
// the connection on that answer (as the launcher does today) loses the state a
// retry needs, and the retry then restarts the container with those pages still
// open behind routes that no longer exist.
//
// So the distinction lives in one helper — bundles/browser/server/safe-restart.js,
// `closePagesBeforeRestart({ closeGuardedPages, getContext, ownership, isConnected,
// wait, pollMs, maxWaitMs })` → `{ proceed, dropConnection }`:
//
//   ok:true                → { proceed: true,  dropConnection: true }   (the pages
//                             were closed; browser.close() may follow)
//   ok:false, isConnected    false while polling → { proceed: false, dropConnection:
//                             true }   (the browser is gone: the connection is dead anyway)
//   ok:false, isConnected    true at the end      → { proceed: false, dropConnection:
//                             false }  (the browser is alive with pages possibly
//                             unguarded: keep browser/context so a retry runs the safe
//                             close again)
//
// It never throws: a throwing closeGuardedPages counts as ok:false, a throwing
// isConnected counts as still connected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { closeGuardedPages } from "../bundles/browser/server/private-address.js";

const SAFE_RESTART = new URL("../bundles/browser/server/safe-restart.js", import.meta.url);
const SERVER_JS = new URL("../bundles/browser/server/server.js", import.meta.url);

/**
 * The helper this file is about. Imported through a function and not as a static
 * import: the module does not exist yet, and a static import of a missing file is
 * a load-time error that would take the controls in this file down with it.
 */
async function loadClosePagesBeforeRestart() {
  let mod = null;
  try {
    mod = await import(SAFE_RESTART.href);
  } catch (err) {
    assert.fail(
      "bundles/browser/server/safe-restart.js has to exist and export " +
        "`async function closePagesBeforeRestart({ closeGuardedPages, getContext, ownership, isConnected, " +
        "wait, pollMs, maxWaitMs })` returning { proceed, dropConnection }: crow_browser_launch's two branches " +
        `have to tell "the pages were closed" from "the browser is gone" from "the browser is still there with ` +
        `its pages unguarded" before they touch browser/context/page/cdpSession (import failed: ${err.message})`,
    );
  }
  assert.equal(
    typeof mod.closePagesBeforeRestart,
    "function",
    "bundles/browser/server/safe-restart.js has to export closePagesBeforeRestart as a function " +
      `(got ${typeof mod.closePagesBeforeRestart})`,
  );
  return mod.closePagesBeforeRestart;
}

// ---------------------------------------------------------------------------
// plain stubs (no Playwright, no real browser: the helper's whole job is to
// decide what an answer plus a connectivity probe means)
// ---------------------------------------------------------------------------

/** A closeGuardedPages stub: records its arguments and answers (or throws) as told. */
function stubCloseGuardedPages({ ok = true, throws = false } = {}) {
  const calls = [];
  const fn = async (getContext, opts) => {
    calls.push({ getContext, opts });
    if (throws) throw new Error("closeGuardedPages blew up");
    return { ok };
  };
  fn.calls = calls;
  return fn;
}

/** An isConnected stub: answers the given list in turn, repeating the last one. */
function stubIsConnected(answers) {
  const calls = [];
  const fn = () => {
    const answer = answers[Math.min(calls.length, answers.length - 1)];
    calls.push(answer);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  fn.calls = calls;
  return fn;
}

/** A wait stub: records every requested delay and settles at once (no real sleeping). */
function stubWait() {
  const calls = [];
  const fn = async (ms) => {
    calls.push(ms);
    await Promise.resolve();
  };
  fn.calls = calls;
  fn.totalMs = () => calls.reduce((sum, ms) => sum + ms, 0);
  return fn;
}

/** The ownership a caller hands over; the helper only has to pass it through. */
const OWNERSHIP = { classify: () => "bot" };

const PROCEEDED = { proceed: true, dropConnection: true };
const GONE = { proceed: false, dropConnection: true };
const STILL_THERE = { proceed: false, dropConnection: false };

// ---------------------------------------------------------------------------
// the four outcomes
// ---------------------------------------------------------------------------

test("(B1) ok:true proceeds and drops the connection: the pages are closed and the browser is closed next", async () => {
  const closePagesBeforeRestart = await loadClosePagesBeforeRestart();
  const getContext = () => ({ pages: () => [] });
  const close = stubCloseGuardedPages({ ok: true });
  const isConnected = stubIsConnected([false]);
  const wait = stubWait();

  const outcome = await closePagesBeforeRestart({
    closeGuardedPages: close,
    getContext,
    ownership: OWNERSHIP,
    isConnected,
    wait,
  });

  assert.deepEqual(
    outcome,
    PROCEEDED,
    `a clean close means the restart may go ahead and the old connection is over (got ${JSON.stringify(outcome)})`,
  );
  assert.equal(close.calls.length, 1, `closeGuardedPages is awaited exactly once (got ${close.calls.length})`);
  assert.equal(close.calls[0].getContext, getContext, "the helper hands over the caller's own getContext");
  assert.deepEqual(
    close.calls[0].opts,
    { ownership: OWNERSHIP },
    `closeGuardedPages is called as (getContext, { ownership }), which is what it reads (got ` +
      `${JSON.stringify(close.calls[0].opts)})`,
  );
  assert.equal(
    isConnected.calls.length,
    0,
    `nothing is gone when the pages were closed cleanly, so there is nothing to poll (the helper asked ` +
      `${isConnected.calls.length} time(s))`,
  );
});

test("(B1) ok:false with the browser already disconnected drops the connection and does not proceed", async () => {
  const closePagesBeforeRestart = await loadClosePagesBeforeRestart();
  const close = stubCloseGuardedPages({ ok: false });
  const isConnected = stubIsConnected([false]);
  const wait = stubWait();

  const outcome = await closePagesBeforeRestart({
    closeGuardedPages: close,
    getContext: () => null,
    ownership: OWNERSHIP,
    isConnected,
    wait,
  });

  assert.deepEqual(
    outcome,
    GONE,
    `the browser is not there any more, so the connection is dead whatever the cleanup said: the caller may ` +
      `restart, and must not keep a connection to nothing (got ${JSON.stringify(outcome)})`,
  );
  assert.ok(isConnected.calls.length >= 1, "the helper asked whether the browser is still connected");
});

test("(B1) ok:false with the browser going away a few polls later still drops the connection", async () => {
  const closePagesBeforeRestart = await loadClosePagesBeforeRestart();
  const close = stubCloseGuardedPages({ ok: false });
  const isConnected = stubIsConnected([true, true, false]);
  const wait = stubWait();

  const outcome = await closePagesBeforeRestart({
    closeGuardedPages: close,
    getContext: () => null,
    ownership: OWNERSHIP,
    isConnected,
    wait,
    pollMs: 100,
    maxWaitMs: 1500,
  });

  assert.deepEqual(
    outcome,
    GONE,
    `a crash that takes a moment to show up is still a crash: the connection goes once the browser is gone ` +
      `(got ${JSON.stringify(outcome)}; polls: ${JSON.stringify(isConnected.calls)})`,
  );
  assert.equal(
    isConnected.calls.length,
    3,
    `the helper polls until the answer changes, not a fixed number of times (polls: ${isConnected.calls.length})`,
  );
  assert.ok(wait.calls.length >= 2, `and it waits between the polls (waits: ${JSON.stringify(wait.calls)})`);
  for (const ms of wait.calls) {
    assert.equal(ms, 100, `every wait is the caller's pollMs (got ${JSON.stringify(wait.calls)})`);
  }
  assert.ok(
    wait.totalMs() <= 1500,
    `the polling never spends more than maxWaitMs (spent ${wait.totalMs()} ms; waits: ${JSON.stringify(wait.calls)})`,
  );
});

test("(B1) ok:false with the browser STILL CONNECTED keeps the connection, so a retry runs the safe close again", async () => {
  const closePagesBeforeRestart = await loadClosePagesBeforeRestart();
  const close = stubCloseGuardedPages({ ok: false });
  const isConnected = stubIsConnected([true]);
  const wait = stubWait();

  const outcome = await closePagesBeforeRestart({
    closeGuardedPages: close,
    getContext: () => null,
    ownership: OWNERSHIP,
    isConnected,
    wait,
    pollMs: 10,
    maxWaitMs: 50,
  });

  assert.deepEqual(
    outcome,
    STILL_THERE,
    `the cleanup could not close the pages but the browser is alive: that is NOT a crash, and dropping ` +
      `browser/context/page/cdpSession here is what makes the retry skip the safe close and restart the ` +
      `container over the bot's unguarded pages (got ${JSON.stringify(outcome)}; polls: ` +
      `${JSON.stringify(isConnected.calls)})`,
  );
  assert.ok(wait.calls.length >= 1, `it polls until maxWaitMs before concluding the browser is still there`);
  for (const ms of wait.calls) {
    assert.equal(ms, 10, `every wait is the caller's pollMs (got ${JSON.stringify(wait.calls)})`);
  }
  assert.ok(
    wait.totalMs() > 0,
    `the browser gets time to go before it is called alive (waits: ${JSON.stringify(wait.calls)})`,
  );
  assert.ok(
    wait.totalMs() <= 50,
    `and that time is bounded by maxWaitMs (spent ${wait.totalMs()} ms; waits: ${JSON.stringify(wait.calls)})`,
  );
});

test("(B1) the defaults are pollMs 100 and maxWaitMs 1500", async () => {
  const closePagesBeforeRestart = await loadClosePagesBeforeRestart();
  const close = stubCloseGuardedPages({ ok: false });
  const isConnected = stubIsConnected([true]);
  const wait = stubWait();

  const outcome = await closePagesBeforeRestart({
    closeGuardedPages: close,
    getContext: () => null,
    isConnected,
    wait,
  });

  assert.deepEqual(outcome, STILL_THERE, `with no pollMs/maxWaitMs the helper still answers (got ${JSON.stringify(outcome)})`);
  for (const ms of wait.calls) {
    assert.equal(ms, 100, `a wait with no pollMs given is 100 ms (got ${JSON.stringify(wait.calls)})`);
  }
  assert.ok(
    wait.totalMs() <= 1500,
    `and the whole poll is bounded by 1500 ms (spent ${wait.totalMs()} ms; waits: ${JSON.stringify(wait.calls)})`,
  );
  assert.ok(
    wait.totalMs() >= 1400,
    `it does use the grace it was given (spent ${wait.totalMs()} ms; waits: ${JSON.stringify(wait.calls)})`,
  );
});

// ---------------------------------------------------------------------------
// it never throws
// ---------------------------------------------------------------------------

test("(B1) a closeGuardedPages that THROWS counts as ok:false and never makes the helper throw", async () => {
  const closePagesBeforeRestart = await loadClosePagesBeforeRestart();
  const close = stubCloseGuardedPages({ throws: true });
  const isConnected = stubIsConnected([true]);
  const wait = stubWait();

  const outcome = await closePagesBeforeRestart({
    closeGuardedPages: close,
    getContext: () => null,
    ownership: OWNERSHIP,
    isConnected,
    wait,
    pollMs: 10,
    maxWaitMs: 30,
  });

  assert.deepEqual(
    outcome,
    STILL_THERE,
    `a close that threw proves nothing about the browser, so the helper must not proceed and must not claim the ` +
      `connection is gone while it is still there (got ${JSON.stringify(outcome)})`,
  );

  // The same throw, with the browser gone: the connection goes.
  const goneClose = stubCloseGuardedPages({ throws: true });
  const gone = await closePagesBeforeRestart({
    closeGuardedPages: goneClose,
    getContext: () => null,
    ownership: OWNERSHIP,
    isConnected: stubIsConnected([false]),
    wait: stubWait(),
  });
  assert.deepEqual(
    gone,
    GONE,
    `a throwing close with the browser disconnected is still a dead connection (got ${JSON.stringify(gone)})`,
  );
});

test("(B1) a throwing isConnected counts as STILL CONNECTED, poll by poll", async () => {
  const closePagesBeforeRestart = await loadClosePagesBeforeRestart();
  const wait = stubWait();

  const always = await closePagesBeforeRestart({
    closeGuardedPages: stubCloseGuardedPages({ ok: false }),
    getContext: () => null,
    ownership: OWNERSHIP,
    isConnected: stubIsConnected([new Error("the CDP socket blew up")]),
    wait,
    pollMs: 10,
    maxWaitMs: 30,
  });
  assert.deepEqual(
    always,
    STILL_THERE,
    `a probe that throws has not said "gone": treating it as gone would throw away a connection that may be ` +
      `perfectly able to run the safe close again (got ${JSON.stringify(always)})`,
  );

  const thenGone = await closePagesBeforeRestart({
    closeGuardedPages: stubCloseGuardedPages({ ok: false }),
    getContext: () => null,
    ownership: OWNERSHIP,
    isConnected: stubIsConnected([new Error("the CDP socket blew up"), false]),
    wait: stubWait(),
    pollMs: 10,
    maxWaitMs: 30,
  });
  assert.deepEqual(
    thenGone,
    GONE,
    `and a later poll that answers false is still a gone browser (got ${JSON.stringify(thenGone)})`,
  );
});

// ---------------------------------------------------------------------------
// a retry
// ---------------------------------------------------------------------------

test("(B1) a retry after the refusal calls closeGuardedPages AGAIN, with the state the caller kept", async () => {
  const closePagesBeforeRestart = await loadClosePagesBeforeRestart();
  const getContext = () => ({ pages: () => [] });
  const close = stubCloseGuardedPages({ ok: false });
  const wait = stubWait();
  const isConnected = stubIsConnected([true]);

  const first = await closePagesBeforeRestart({
    closeGuardedPages: close,
    getContext,
    ownership: OWNERSHIP,
    isConnected,
    wait,
    pollMs: 10,
    maxWaitMs: 20,
  });
  assert.deepEqual(first, STILL_THERE, `the first attempt did not finish the close (got ${JSON.stringify(first)})`);

  // The retry: the same getContext and the same ownership, because the caller kept
  // browser/context instead of nulling them (dropConnection was false).
  const second = await closePagesBeforeRestart({
    closeGuardedPages: close,
    getContext,
    ownership: OWNERSHIP,
    isConnected,
    wait,
    pollMs: 10,
    maxWaitMs: 20,
  });
  assert.deepEqual(second, STILL_THERE, `the retry answers for its own attempt (got ${JSON.stringify(second)})`);
  assert.equal(
    close.calls.length,
    2,
    `the safe close has to run again on the retry: nothing about the first refusal makes the pages safe ` +
      `(closeGuardedPages calls: ${close.calls.length})`,
  );
  assert.equal(close.calls[1].getContext, getContext, "the retry reads the same context the caller kept");
  assert.deepEqual(close.calls[1].opts, { ownership: OWNERSHIP }, "and the same ownership");
});

// ---------------------------------------------------------------------------
// CONTROL — what the current launcher gets wrong, which is why the helper exists
// ---------------------------------------------------------------------------

/**
 * A guarded context in exactly the state B1 is about: one bot page, and a browser
 * that offers no CDP session to crash. closeGuardedPages cannot blank-and-close
 * the page and cannot kill the browser, so it answers `{ ok: false }` while the
 * browser is very much still running — which the launch handler reads today as
 * "drop browser/context/page/cdpSession".
 */
function fakeAliveContext() {
  const log = [];
  const botRec = { url: "http://127.0.0.1:9/0", gotos: [], closes: 0 };
  const botPage = {
    rec: botRec,
    url: () => botRec.url,
    isClosed: () => false,
    frames: () => [],
    context: () => ({ async newCDPSession() { return { on() {}, async send() {} }; } }),
    async goto(target) {
      botRec.gotos.push(target);
      log.push("goto:0:start");
      await new Promise((resolve) => setTimeout(resolve, 0));
      log.push("goto:0:rejected");
      throw new Error("the blank of the bot's page failed");
    },
    async close() {
      botRec.closes += 1;
      log.push("close:0");
    },
  };
  let survivor = null;
  const context = {
    pages: () => (survivor ? [botPage, survivor] : [botPage]),
    async newPage() {
      log.push("newPage");
      const rec = { url: "about:blank", gotos: [], closes: 0 };
      survivor = {
        rec,
        url: () => rec.url,
        isClosed: () => false,
        async goto(target) { rec.gotos.push(target); },
        async close() { rec.closes += 1; },
      };
      return survivor;
    },
    browser: () => ({
      async newBrowserCDPSession() {
        log.push("browser:newSession:rejected");
        throw new Error("no browser CDP session: the connection is not there");
      },
    }),
  };
  const ownership = {
    classify: (page) => (page === survivor ? "operator" : "bot"),
    async settle() {},
    classifying: () => false,
    botPageCount: () => 1,
    unresolvedMarks: () => 0,
    pending: () => false,
  };
  return { log, context, ownership, botRec };
}

test("(B1 CONTROL) { ok: false } can mean the browser is still alive, which is why dropping the connection is wrong", async () => {
  const fake = fakeAliveContext();
  const answer = await closeGuardedPages(() => fake.context, { ownership: fake.ownership, budgetMs: 5000 });

  assert.deepEqual(
    answer,
    { ok: false },
    `the cleanup cannot close the page and has no session to crash the browser over, so it answers false ` +
      `(got ${JSON.stringify(answer)}; log: ${fake.log.join(", ")})`,
  );
  assert.equal(fake.botRec.closes, 0, `and it closed nothing (got ${fake.botRec.closes}; log: ${fake.log.join(", ")})`);
  assert.ok(
    fake.log.includes("browser:newSession:rejected"),
    `the answer is false because no browser CDP session could be opened — the browser itself was never crashed ` +
      `(log: ${fake.log.join(", ")})`,
  );
  assert.ok(
    !fake.log.some((entry) => entry === "browser:send:Browser.crash"),
    `no crash was sent at all, so the browser and this connection are still there (log: ${fake.log.join(", ")})`,
  );
});

// ---------------------------------------------------------------------------
// the launcher itself
// ---------------------------------------------------------------------------

/** The headers of the blocks around `index`, innermost first. */
function enclosingBlockHeaders(text, index) {
  const headers = [];
  let depth = 0;
  for (let i = index - 1; i >= 0 && headers.length < 4; i--) {
    const ch = text[i];
    if (ch === "}") {
      depth += 1;
      continue;
    }
    if (ch !== "{") continue;
    if (depth > 0) {
      depth -= 1;
      continue;
    }
    const before = text.slice(Math.max(0, i - 260), i);
    const cut = Math.max(before.lastIndexOf("}"), before.lastIndexOf("{"), before.lastIndexOf(";"));
    headers.push(before.slice(cut + 1));
  }
  return headers;
}

/** The body of the block that opens after `fromIndex` (brace-matched), or "". */
function blockBodyAfter(text, fromIndex) {
  const open = text.indexOf("{", fromIndex);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return "";
}

test("(B1) both crow_browser_launch branches go through closePagesBeforeRestart, and drop the connection only when it says to", () => {
  const text = readFileSync(SERVER_JS, "utf8");

  assert.match(
    text,
    /import\s*\{[^}]*\bclosePagesBeforeRestart\b[^}]*\}\s*from\s*"\.\/safe-restart\.js"/,
    "server.js has to import closePagesBeforeRestart from ./safe-restart.js: the launch tool is the caller " +
      "that cannot tell a crash from a browser that is still there, and the helper is where that distinction lives",
  );

  const bare = [...text.matchAll(/\bcloseGuardedPages\s*\(/g)];
  assert.equal(
    bare.length,
    0,
    `closeGuardedPages must not be CALLED in server.js any more: it is handed to closePagesBeforeRestart as an ` +
      `argument, and the helper decides what { ok: false } means (found ${bare.length} call(s) at ` +
      `${JSON.stringify(bare.map((m) => m.index))})`,
  );

  const launchAt = text.indexOf('"crow_browser_launch"');
  const statusAt = text.indexOf('"crow_browser_status"');
  assert.ok(
    launchAt > 0 && statusAt > launchAt,
    "the crow_browser_launch tool is still where this test can read it (its handler sits before crow_browser_status)",
  );
  const handler = text.slice(launchAt, statusAt);

  const proxyAt = handler.indexOf("if (changingProxy) {");
  const restartAt = handler.indexOf("} else if (restart) {");
  const afterChainAt = handler.indexOf("await ensureConnected();", restartAt);
  assert.ok(proxyAt > 0 && restartAt > proxyAt, "both branches (proxy_url and restart) are still in the handler");
  assert.ok(afterChainAt > restartAt, "the handler still carries on with ensureConnected() after the two branches");

  for (const [label, branch] of [
    ["proxy_url", handler.slice(proxyAt, restartAt)],
    ["restart", handler.slice(restartAt, afterChainAt)],
  ]) {
    const helperAt = branch.indexOf("closePagesBeforeRestart");
    assert.ok(
      helperAt >= 0,
      `the ${label} branch replaces the browser: its pages have to go through closePagesBeforeRestart, which is ` +
        `the only thing that tells a crashed browser from one that is still there (branch text: ` +
        `${JSON.stringify(branch.slice(0, 300))})`,
    );

    const bareCloseAt = branch.indexOf("browser.close(");
    if (bareCloseAt >= 0) {
      assert.ok(
        helperAt < bareCloseAt,
        `the ${label} branch calls browser.close( before the safe close ran: that closes the live pages, and every ` +
          `one of those closes fires the pagehide/unload beacons this whole module exists to stop ` +
          `(closePagesBeforeRestart at ${helperAt}, browser.close( at ${bareCloseAt})`,
      );
    }

    // `proceed` is what says the pages were closed and the browser may be closed next.
    assert.ok(
      /\bproceed\b/.test(branch),
      `the ${label} branch has to read \`proceed\` from the helper's answer: false means nothing may be restarted ` +
        `and nothing may be closed (branch text: ${JSON.stringify(branch.slice(0, 400))})`,
    );

    // The refusal: proceed false → an MCP error, so the model is told rather than the
    // launch reading as a clean restart.
    const refusalTest =
      /if\s*\(\s*(?:!\s*[\w$.]*proceed\b|[\w$.]*proceed\s*===?\s*false)/.exec(branch) ||
      /if\s*\(\s*[\w$.]*proceed\s*(?:!==|!=)\s*true/.exec(branch);
    assert.ok(
      refusalTest,
      `the ${label} branch has to refuse on proceed === false (branch text: ${JSON.stringify(branch.slice(0, 400))})`,
    );
    const refusalBody = blockBodyAfter(branch, refusalTest.index);
    assert.match(
      refusalBody,
      /isError:\s*true/,
      `a refusal in the ${label} branch has to come back as an MCP error (isError: true): the model has to be ` +
        `told the browser's pages were not closed through the safe path (body: ${JSON.stringify(refusalBody.slice(0, 400))})`,
    );

    // Nothing of the connection is thrown away unless dropConnection says the browser
    // is really gone.
    const nullings = [...branch.matchAll(/\b(browser|context|page|cdpSession)\s*=\s*null\b/g)];
    for (const nulling of nullings) {
      const headers = enclosingBlockHeaders(branch, nulling.index);
      assert.ok(
        headers.some((header) => /dropConnection/.test(header)),
        `the ${label} branch nulls ${nulling[1]} outside a dropConnection check: when the cleanup could not ` +
          `crash the browser (no browser CDP session, or Browser.crash refused) the browser and the bot's pages ` +
          `are still there, and nulling the state makes the retry skip the safe close and restart the container ` +
          `over them (enclosing blocks: ${JSON.stringify(headers.map((h) => h.trim().slice(0, 120)))})`,
      );
    }
  }
});