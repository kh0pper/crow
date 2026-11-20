/**
 * message-drafts-ui-live — the Messages saved-drafts UI in a real browser (bot-door plan, PR A
 * part 2), at phone 390×844 and desktop 1280×800, in English and Spanish.
 *
 * The REAL dashboard router is mounted over a scratch CROW_DATA_DIR (real init-db'd crow.db, real
 * panel render, real drafts API, real SSE stream), with the vendored Turbo, and a private headless
 * Chrome drives it. Requests are marked as coming from the owner's laptop (tests/helpers/off-box.js)
 * behind the stubbed dashboard auth, because the drafts API is owner-only on purpose and a loopback
 * request is never the owner's turn.
 *
 * What the test does, per viewport and language:
 *   1. the Drafts section is there on an empty install: "Drafts (0)" and the empty line, no sideways
 *      scroll, 44 px targets;
 *   2. open a thread, type — 800 ms later the draft is saved ("Saved"), and it appears under Drafts;
 *   3. a full page reload keeps it: the thread's composer comes back pre-filled and the row is
 *      server-rendered;
 *   4. Send posts the composer's text, shows "Sent to <name>" and the draft is gone from Drafts;
 *   5. Discard from the list row asks first: Escape closes it and changes nothing; confirming
 *      discards it and empties the composer;
 *   6. a SECOND TAB edits the same draft: the first tab's autosave loses the race and shows
 *      "This draft changed somewhere else." with Reload — which takes the other tab's words; and a
 *      draft the second tab discards disappears from the first tab's list live (SSE).
 *
 * Skips cleanly without Chrome (CROW_REQUIRE_TEST_CHROME=1 turns that into a failure).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
// This process's HTTP client stands in for tailscaled's Serve socket owner, and every request (the
// browser's included) carries Serve's headers for a tailnet client: the dashboard's network gate
// allows that source, and the owner check (isLocalPasswordSessionOn) refuses a request that starts
// on this machine — a test's loopback request would be exactly that.
actAsServe();

const dir = mkdtempSync(join(tmpdir(), "message-drafts-live-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
mkdirSync(process.env.CROW_HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
const REPO = new URL("..", import.meta.url).pathname;
const SESSION = "drafts-live-session";
const CSRF = "drafts-live-csrf";

let server = null;
let server2 = null;
let base = "";
let base2 = "";
let chrome = null;
let setLang = null;
let t = null;
let fill = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: REPO,
  });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const raw = new Database(join(dir, "crow.db"));
  raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', datetime('now','+1 day'))")
    .run(hashToken(SESSION));
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();

  ({ t, fill } = await import("../servers/gateway/dashboard/shared/i18n.js"));
  const { createDbClient } = await import("../servers/db.js");
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  setLang = async (lang) => {
    const db = createDbClient();
    try { await writeSetting(db, "language", lang); } finally { db.close(); }
  };
  await setLang("en");

  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: streamsRouter } = await import("../servers/gateway/routes/streams.js");
  const { default: peerMessagesRouter } = await import("../servers/gateway/routes/peer-messages.js");
  const { setMessagesDraftsRuntime, clearMessagesDraftsRuntime } = await import("../servers/gateway/routes/messages-drafts-api.js");
  const { parseCookies } = await import("../servers/gateway/dashboard/auth.js");
  const { default: express } = await import("express");

  // The relay stand-in: a draft send hands the text to the instance's peer send path, and this stub
  // is that path's delivery half — it writes the local row a real relay would have written and acks
  // it. Nothing leaves the box; the panel sees exactly what a delivered message looks like.
  setMessagesDraftsRuntime({
    send: async (db, draft, text) => {
      const r = await db.execute({
        sql: `INSERT INTO messages (contact_id, content, direction, is_read, delivery_status, created_at)
              VALUES (?, ?, 'sent', 1, 'relayed', datetime('now'))`,
        args: [draft.conversationId, text],
      });
      return { ok: true, messageId: String(r.lastInsertRowid) };
    },
  });

  const app = express();
  app.use(express.static(new URL("../servers/gateway/public", import.meta.url).pathname));
  // The session the stub auth would have resolved from the cookie (dashboardAuth is stubbed so the
  // test can mount the panel router without a real login flow).
  app.use((req, res, next) => {
    const cookies = parseCookies(req);
    if (cookies.crow_session) req.dashboardSession = cookies.crow_session;
    next();
  });
  const noAuth = (req, res, next) => next();
  app.use(streamsRouter(noAuth));
  // The peer/room Messages API is mounted at app root by boot/feature-mounts.js; the panel's client
  // fetches it directly, so the live harness needs it too (the draft send goes through it).
  app.use(peerMessagesRouter(noAuth));
  app.use(dashboardRouter(noAuth));

  chrome = await startHeadlessChrome();
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = "http://127.0.0.1:" + server.address().port;
  // A SECOND origin for the second tab. A browser gives one origin six HTTP/1.1 connections, and a
  // page here holds three SSE streams (the badge turbo-stream-source, the panel's messages stream and
  // the drafts stream), so a second tab on the same origin would starve its own fetches. Different
  // port, same app, same crow.db.
  await new Promise((resolve) => { server2 = app.listen(0, "127.0.0.1", resolve); });
  base2 = "http://127.0.0.1:" + server2.address().port;
});

after(async () => {
  for (const s of [server, server2]) {
    if (!s) continue;
    try { s.closeAllConnections?.(); } catch { /* already gone */ }
    try { s.close(); } catch { /* already gone */ }
  }
  if (chrome) await chrome.close();
  try {
    const mod = await import("../servers/gateway/routes/messages-drafts-api.js");
    mod.clearMessagesDraftsRuntime();
  } catch { /* the module was never loaded */ }
  rmSync(dir, { recursive: true, force: true });
});

/** One contact and nothing else: every test starts from an empty Drafts list. */
function resetDb() {
  const raw = new Database(join(dir, "crow.db"));
  for (const table of ["message_drafts", "message_draft_audit", "messages", "contact_group_members",
    "contact_groups", "contacts"]) {
    try { raw.prepare(`DELETE FROM ${table}`).run(); } catch { /* table absent */ }
  }
  raw.prepare(`INSERT INTO contacts (id, crow_id, display_name, secp256k1_pubkey, ed25519_pubkey, contact_type)
               VALUES (1, 'crow:peer', 'Peer', ?, ?, 'crow')`).run("02" + "a".repeat(64), "e".repeat(64));
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();
}

/** A room with the peer in it, and its group id. Created mid-test where a test needs one. */
function mkRoom(name = "The Den") {
  const raw = new Database(join(dir, "crow.db"));
  try {
    const roomId = Number(raw.prepare("INSERT INTO contact_groups (name, room_uid, host_crow_id, mode) VALUES (?, ?, 'crow:me', 'addressed')")
      .run(name, "r".repeat(32)).lastInsertRowid);
    raw.prepare("INSERT INTO contact_group_members (group_id, contact_id) VALUES (?, 1)").run(roomId);
    return roomId;
  } finally {
    raw.pragma("wal_checkpoint(TRUNCATE)");
    raw.close();
  }
}

/**
 * One owner draft, written the way the gateway writes one (the real store, the real seal, the real
 * live event): this is what makes the page's list refresh, because the draft stream forwards the
 * store's bus event and the panel re-reads the drafts API on every frame.
 */
async function mkDraft(kind, conversationId, body) {
  const { createDbClient } = await import("../servers/db.js");
  const { createDraft } = await import("../servers/gateway/messages/drafts-store.js");
  const { resolveConversation } = await import("../servers/gateway/messages/conversations.js");
  const db = createDbClient();
  try {
    const conversation = await resolveConversation(db, { kind, id: conversationId });
    assert.equal(conversation.ok, true, `the ${kind} resolves`);
    const out = await createDraft(db, {
      conversationKind: kind,
      conversationId,
      body,
      recipients: conversation.recipients,
    });
    assert.equal(out.ok, true, "the store made the draft");
    return out.draft;
  } finally {
    db.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READY = "!!window.Turbo && document.readyState === 'complete' && !!document.querySelector('.msg-hub') && !document.documentElement.hasAttribute('aria-busy')";
const TWO_FRAMES = "new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})";
const NO_H_SCROLL = "document.documentElement.scrollWidth <= window.innerWidth";

/** A tab at a viewport, signed in, with the header/footer Turbo would run. */
async function open(path, { width = 390, height = 844, origin = null } = {}) {
  const pageBase = origin || base;
  const target = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const on = (raw) => {
      const m = JSON.parse(raw);
      if (m.id !== mine) return;
      ws.off("message", on);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result || {});
    };
    ws.on("message", on);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const ev = async (expression) => {
    const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error("page threw: " + JSON.stringify(out.exceptionDetails));
    return out.result.value;
  };
  const errors = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.method === "Runtime.exceptionThrown") {
      errors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    }
  });
  const until = async (expression, what, ms = 12000) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = await ev(expression); } catch { /* mid-navigation */ }
      if (v) return v;
      if (Date.now() > end) {
        let where = "";
        try { where = await ev("location.href"); } catch {}
        throw new Error("timed out waiting for " + what + " (" + expression + ") at " + where
          + (errors.length ? "; page errors: " + errors.slice(-4).join(" | ") : ""));
      }
      await sleep(80);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.clearBrowserCookies");
  await send("Network.setExtraHTTPHeaders", { headers: serveHeaders("operator@example.invalid") });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
  for (const ck of [{ name: "crow_session", value: SESSION }, { name: "crow_csrf", value: CSRF }]) {
    await send("Network.setCookie", { ...ck, url: pageBase, path: "/" });
  }
  await send("Page.navigate", { url: pageBase + path });
  await until(READY, "the Messages page");
  await ev(TWO_FRAMES);

  const clickSel = async (sel) => {
    // Scroll first, settle, then click: the shell scrolls smoothly, so a rect read in the same tick
    // as scrollIntoView would be the pre-scroll position and the click would land on whatever is
    // there now (found live: a click meant for the avatar strip hit the Drafts section).
    await ev(`(function(){ var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 0;
      e.scrollIntoView({ block: 'center' }); return 1; })()`);
    await sleep(200);
    const p = await ev(`(function(){ var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null;
      var b=e.getBoundingClientRect(); return { x: b.left + b.width/2, y: b.top + b.height/2 }; })()`);
    assert.ok(p, "no element " + sel);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
    }
    await sleep(80);
  };
  /** Real typing into the focused element (fires the input events the panel listens for). */
  const typeInto = async (sel, text) => {
    await ev(`(function(){ var e=document.querySelector(${JSON.stringify(sel)}); e.focus(); return 1; })()`);
    await send("Input.insertText", { text });
    await sleep(60);
  };
  const pressEscape = async () => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(60);
  };
  const text = (sel) => ev(`(function(){ var e=document.querySelector(${JSON.stringify(sel)}); return e ? e.textContent : null; })()`);
  const count = (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  return { send, ev, until, clickSel, typeInto, pressEscape, text, count, errors, close: async () => {
    ws.close();
    await fetch(chrome.cdp + "/json/close/" + target.id).catch(() => {});
  } };
}

const OPEN_THREAD = ".msg-avatar-item[data-type='peer']";
const composerText = "Hello from the drafts UI";

/** The heading / empty line / receipts in the panel's language. */
function copy(lang) {
  return {
    heading: (n) => fill(t("messages.draft.draftsHeading", lang), { n }),
    empty: t("messages.draft.draftsEmpty", lang),
    saved: t("messages.draft.saved", lang),
    changed: t("messages.draft.changedElsewhere", lang),
    sentTo: (name) => fill(t("messages.draft.sentReceipt", lang), { name }),
    discardConfirm: t("messages.draft.discardConfirm", lang),
  };
}

const SMALL = (sel) => `(function(){ var bad=[], count=0;
  document.querySelectorAll(${JSON.stringify(sel)}).forEach(function(el){
    var cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden') return;
    var r=el.getBoundingClientRect(); if(!r.width&&!r.height) return;
    count++;
    if(r.width<44||r.height<44) bad.push((el.className||el.tagName)+':'+Math.round(r.width)+'x'+Math.round(r.height));
  }); return { count: count, bad: bad }; })()`;

for (const [width, height] of [[390, 844], [1280, 800]]) {
  for (const lang of ["en", "es"]) {
    test(`${width}×${height} ${lang}: draft → Drafts → open → Saved → Send → gone; Discard with the confirm; a second tab's edit`, async (ctx) => {
      if (!chrome) return ctx.skip("no headless Chrome");
      await setLang(lang);
      resetDb();
      const c = copy(lang);
      const tab1 = await open("/dashboard/messages", { width, height });
      let tab2 = null;
      try {
        assert.equal(await tab1.ev("document.documentElement.lang"), lang, "the page is in the requested language");

        // 1. The section on an empty install.
        await tab1.until(`(function(){ var e=document.querySelector('#msg-drafts-count'); return e && e.textContent === ${JSON.stringify(c.heading(0))}; })()`, "the empty Drafts heading");
        assert.equal(await tab1.text("#msg-drafts-empty"), c.empty, "the empty line");
        assert.equal(await tab1.ev(NO_H_SCROLL), true, "no sideways scroll");
        const head = await tab1.ev(SMALL(".msg-drafts-head"));
        assert.equal(head.bad.length, 0, "the fold header is a 44 px target");

        // 2. Open the thread, type, and wait for the debounced save.
        await tab1.clickSel(OPEN_THREAD);
        await tab1.until("!!document.getElementById('msg-input')", "the composer");
        await tab1.typeInto("#msg-input", composerText);
        await tab1.until(`(function(){ var e=document.querySelector('#msg-draft-status'); return e && e.textContent === ${JSON.stringify(c.saved)}; })()`, "Saved");
        await tab1.until(`(function(){ var e=document.querySelector('#msg-drafts-count'); return e && e.textContent === ${JSON.stringify(c.heading(1))}; })()`, "the draft in the Drafts list");
        assert.equal(await tab1.count(".msg-drafts-row"), 1, "one row");
        assert.match(await tab1.text(".msg-drafts-preview"), /Hello from the drafts UI/, "the row previews the text");
        assert.equal(await tab1.ev(NO_H_SCROLL), true, "no sideways scroll with a draft");
        for (const sel of [".msg-drafts-row", ".msg-draft-send", ".msg-draft-discard", "#msg-draft-bar-discard"]) {
          const r = await tab1.ev(SMALL(sel));
          assert.ok(r.count >= 1, `${sel} is present`);
          assert.deepEqual(r.bad, [], `${sel} is a 44 px target (${width}px)`);
        }

        // 3. A full reload keeps the draft: the row renders server-side and the composer pre-fills.
        await tab1.send("Page.navigate", { url: base + "/dashboard/messages" });
        await tab1.until(READY, "the page again");
        await tab1.until(`document.querySelectorAll('.msg-drafts-row').length === 1`, "the server-rendered row");
        await tab1.clickSel(OPEN_THREAD);
        await tab1.until(`(function(){ var e=document.getElementById('msg-input'); return e && e.value === ${JSON.stringify(composerText)}; })()`, "the composer pre-filled from the draft");

        // 4. Send: the exact text, a receipt, and the draft leaves the list.
        await tab1.typeInto("#msg-input", " and goodbye");
        await tab1.until(`(function(){ var e=document.querySelector('#msg-draft-status'); return e && e.textContent === ${JSON.stringify(c.saved)}; })()`, "Saved before sending");
        await tab1.clickSel("#msg-send-btn");
        await tab1.until(`(function(){ var e=document.querySelector('#msg-draft-status'); return e && e.textContent === ${JSON.stringify(c.sentTo("Peer"))}; })()`, "the sent receipt");
        await tab1.until(`(function(){ var e=document.querySelector('#msg-drafts-count'); return e && e.textContent === ${JSON.stringify(c.heading(0))}; })()`, "the draft gone from Drafts");
        await tab1.until("document.querySelectorAll('.msg-bubble.sent').length >= 1", "the sent bubble");

        // 5. Discard: Escape changes nothing, confirming empties the composer.
        await tab1.typeInto("#msg-input", "Never mind this one");
        await tab1.until(`document.querySelectorAll('.msg-drafts-row').length === 1`, "the second draft");
        await tab1.clickSel(".msg-drafts-row .msg-draft-discard");
        await tab1.until("document.querySelector('#msg-draft-confirm') && !document.querySelector('#msg-draft-confirm').hasAttribute('hidden')", "the confirmation");
        assert.equal(await tab1.text("#msg-draft-confirm-text"), c.discardConfirm, "the approved confirmation copy");
        await tab1.pressEscape();
        await tab1.until("document.querySelector('#msg-draft-confirm').hasAttribute('hidden')", "Escape to close it");
        assert.equal(await tab1.count(".msg-drafts-row"), 1, "Escape discarded nothing");
        assert.equal(await tab1.ev("document.activeElement && document.activeElement.className.indexOf('msg-draft-discard') >= 0"), true,
          "focus went back to the Discard button");
        await tab1.clickSel(".msg-drafts-row .msg-draft-discard");
        await tab1.until("document.querySelector('#msg-draft-confirm') && !document.querySelector('#msg-draft-confirm').hasAttribute('hidden')", "the confirmation again");
        await tab1.clickSel("#msg-draft-confirm-yes");
        await tab1.until(`(function(){ var e=document.querySelector('#msg-drafts-count'); return e && e.textContent === ${JSON.stringify(c.heading(0))}; })()`, "the discard to land");
        assert.equal(await tab1.ev("document.getElementById('msg-input').value"), "", "the composer was emptied");

        // 6. A draft for the second tab to race against.
        await tab1.typeInto("#msg-input", "the first tab's words");
        await tab1.until(`(function(){ var e=document.querySelector('#msg-draft-status'); return e && e.textContent === ${JSON.stringify(c.saved)}; })()`, "the first tab's draft saved");

        tab2 = await open("/dashboard/messages", { width, height, origin: base2 });
        await tab2.until("document.querySelectorAll('.msg-drafts-row').length === 1", "the row in the second tab");
        await tab2.clickSel(OPEN_THREAD);
        await tab2.until("!!document.getElementById('msg-input')", "the second tab's composer");
        const prefilled = await tab2.ev("document.getElementById('msg-input').value");
        assert.equal(prefilled, "the first tab's words", "the second tab's composer is pre-filled from the same draft");

        // The first tab has LOCAL, unsaved words when the other tab writes. The second tab's write
        // goes through the draft API directly (its own debounced composer path is covered above and
        // by message-drafts-panel), so the race is deterministic instead of two 800 ms timers racing.
        await tab1.typeInto("#msg-input", " plus the first tab");
        const patched = await tab2.ev(`(function(){
          var csrf = (document.cookie.match(/(?:^|\\s*)crow_csrf=([^;]*)/) || [])[1] || '';
          return fetch('/dashboard/messages/api/drafts?conversation=contact%3A1')
            .then(function(r){ return r.json(); })
            .then(function(j){
              var d = j.drafts[0];
              return fetch('/dashboard/messages/api/drafts/' + encodeURIComponent(d.id) + '/body', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'X-Crow-Csrf': csrf },
                body: JSON.stringify({ body: d.body + ' plus the second tab', expectVersion: d.version }),
              }).then(function(r2){ return r2.status; });
            });
        })()`);
        assert.equal(patched, 200, "the second tab's edit was accepted");

        // The first tab's autosave loses the race: it is offered Reload, never a blind overwrite.
        await tab1.until(
          "(function(){ var e=document.querySelector('#msg-draft-changed'); return e && e.className.indexOf('visible') >= 0; })()",
          "changed elsewhere",
        );
        assert.match(await tab1.text("#msg-draft-changed"), new RegExp(c.changed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        const changedTargets = await tab1.ev(SMALL("#msg-draft-reload"));
        assert.deepEqual(changedTargets.bad, [], "Reload is a 44 px target");

        // Reload takes the other tab's words — and never re-POSTs its own.
        await tab1.clickSel("#msg-draft-reload");
        await tab1.until("(function(){ var e=document.getElementById('msg-input'); return e && e.value.indexOf('plus the second tab') >= 0; })()", "the other tab's text after Reload");
        await tab1.until("(function(){ var e=document.querySelector('#msg-draft-changed'); return e && e.className.indexOf('visible') < 0; })()", "the warning to clear");

        // A discard in the second tab reaches the first tab's list live (SSE), no reload.
        await tab2.clickSel(".msg-drafts-row .msg-draft-discard");
        await tab2.until("document.querySelector('#msg-draft-confirm') && !document.querySelector('#msg-draft-confirm').hasAttribute('hidden')", "the second tab's confirmation");
        await tab2.clickSel("#msg-draft-confirm-yes");
        await tab1.until(`(function(){ var e=document.querySelector('#msg-drafts-count'); return e && e.textContent === ${JSON.stringify(c.heading(0))}; })()`, "the first tab's live Drafts update");

        assert.deepEqual(tab1.errors, [], "no page errors in the first tab");
        assert.deepEqual(tab2.errors, [], "no page errors in the second tab");
      } finally {
        await tab1.close();
        if (tab2) await tab2.close();
      }
    });
  }
}

/**
 * THE BLOCKER THIS COVERS (Opus review of PR A): after any LIVE refresh the Drafts rows lost their
 * kind and their label. The API answered the store's raw columns (`conversationKind`, no `label`),
 * the client's redraw wrote `data-kind=""`, and a ROOM draft's row then opened a CONTACT thread with
 * the room's group id — a different person's conversation. So: create the drafts while the page is
 * open, let the SSE frame refresh the list (NO reload), and open each row from the list.
 */
test("1280×800 en: a live Drafts refresh keeps kind and label — the room row opens the room, the peer row its peer", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  await setLang("en");
  resetDb();
  const c = copy("en");
  const tab = await open("/dashboard/messages", { width: 1280, height: 800 });
  try {
    await tab.until(`(function(){ var e=document.querySelector('#msg-drafts-count'); return e && e.textContent === ${JSON.stringify(c.heading(0))}; })()`, "the empty Drafts heading");
    // The panel's own EventSource, connected — every later refresh comes from a frame on it.
    await tab.until("window.__crowDraftStream && window.__crowDraftStream.readyState === 1", "the draft stream to connect");

    const roomId = mkRoom("The Den");
    const roomText = "Hello den, this is the room draft";
    const peerText = "Peer draft words";
    const roomDraft = await mkDraft("room", roomId, roomText);
    const peerDraft = await mkDraft("contact", 1, peerText);

    // No reload, no click: the two writes reach the page as crow-draft frames and the list redraws.
    await tab.until(`document.querySelectorAll('.msg-drafts-row').length === 2`, "the live Drafts refresh");
    await tab.until(`(function(){ var e=document.querySelector('#msg-drafts-count'); return e && e.textContent === ${JSON.stringify(c.heading(2))}; })()`, "the count after the live refresh");

    const roomRow = `.msg-drafts-row[data-draft-id="${roomDraft.id}"]`;
    const peerRow = `.msg-drafts-row[data-draft-id="${peerDraft.id}"]`;
    const attr = (sel, name) => tab.ev(`(function(){ var e=document.querySelector(${JSON.stringify(sel)}); return e ? e.getAttribute(${JSON.stringify(name)}) : null; })()`);

    assert.equal(await attr(roomRow, "data-kind"), "room", "a room draft's row kept its kind through the live redraw");
    assert.equal(await attr(roomRow, "data-conversation-id"), String(roomId));
    assert.match(await tab.text(roomRow + " .msg-drafts-name"), /The Den/, "and its name");
    assert.equal(await attr(peerRow, "data-kind"), "contact");
    assert.equal(await attr(peerRow, "data-conversation-id"), "1");
    assert.match(await tab.text(peerRow + " .msg-drafts-name"), /Peer/);

    // The room draft's row opens the ROOM — its header, its thread, its draft in the composer.
    await tab.clickSel(roomRow + " .msg-drafts-open");
    await tab.until("(function(){ var e=document.querySelector('.msg-chat-header-name'); return e && e.textContent === 'The Den'; })()", "the room thread");
    await tab.until(`(function(){ var e=document.getElementById('msg-input'); return e && e.value === ${JSON.stringify(roomText)}; })()`, "the room draft in the composer");

    // And a peer draft's row still opens that peer.
    await tab.clickSel(peerRow + " .msg-drafts-open");
    await tab.until("(function(){ var e=document.querySelector('.msg-chat-header-name'); return e && e.textContent === 'Peer'; })()", "the peer thread");
    await tab.until(`(function(){ var e=document.getElementById('msg-input'); return e && e.value === ${JSON.stringify(peerText)}; })()`, "the peer draft in the composer");

    assert.deepEqual(tab.errors, [], "no page errors");
  } finally {
    await tab.close();
  }
});