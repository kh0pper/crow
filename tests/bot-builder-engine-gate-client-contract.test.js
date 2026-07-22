/**
 * Bot Builder engine-attach gate CLIENT script — BEHAVIOR, executed (C4
 * Task 8 fix round).
 *
 * tests/bot-builder-engine-gate.test.js proves the SERVER-rendered contract
 * (which data attributes land on #btb-gateways-form, in what shape). It
 * cannot prove what the emitted <script> actually DOES with those
 * attributes against a live DOM — that was exactly the class of bug found
 * in this round:
 *
 *   Bug 1 (stale required-fields list hijacks a type-switch submit): the
 *   type <select>'s onchange calls form.requestSubmit() to re-render the
 *   Gateways tab for whatever type the operator just picked. That
 *   re-submit passes through this SAME script's "submit" listener before
 *   the server re-render lands, so the DOM still holds the OLD type's
 *   fields (and this script's `requiredFields` list, captured from the
 *   OLD type's data-engine-required-fields attribute, still matches them).
 *   If those old fields happen to be non-empty, recordIsComplete() said
 *   "complete" for a record that was never submitted as that type,
 *   preventDefault()'d the harmless re-render, and popped the install
 *   modal instead. The fix: a data-engine-fields-type attribute pins which
 *   gwType the required-fields list was computed for; recordIsComplete()
 *   now bails (false) whenever the LIVE select value has already moved on
 *   from that pinned type.
 *
 *   Bug 2 (cancel doesn't stop a delayed auto-resubmit): clicking Install
 *   then Cancel hides the dialog, but the fetch-based job poll keeps
 *   running in the background (the install itself is a real, idempotent
 *   server-side job — correctly left alone). If that job completes after
 *   the cancel, onInstalled() used to fire unconditionally, setting
 *   bypassGate and calling gwForm.requestSubmit() — an unrequested real
 *   POST the operator never asked for after backing out. The fix: an
 *   engineGateCancelled flag, set by the cancel button and the overlay's
 *   click-outside dismiss, checked before both the immediate onDone
 *   callback and the delayed (900ms) hideEngineModal/onInstalled pair.
 *
 * Neither bug is visible to a source-text regex (the string "bypassGate"
 * or "recordIsComplete" appears in the file regardless of whether the
 * logic is actually correct) — this file RUNS the real client
 * (engineGateClientJS) against real server-rendered markup
 * (renderBotEditor) via linkedom + node:vm, mirroring the established
 * pattern in tests/model-catalog-client-contract.test.js and
 * tests/messages-first-run-ux.test.js for this exact class of panel.
 */
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";

const dir = mkdtempSync(join(tmpdir(), "btb-engine-gate-client-"));
process.env.CROW_DATA_DIR = dir;

let db = null;
let renderBotEditor = null;
let _setEngineStatusForTest = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ renderBotEditor } = await import("../servers/gateway/dashboard/panels/bot-builder/editor.js"));
  ({ _setEngineStatusForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js"));
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  _setEngineStatusForTest({ state: "absent" });
  // A complete gmail record so the gate arms and recordIsComplete() would
  // read "complete" for gmail on a fresh render, same fixture shape as
  // tests/bot-builder-engine-gate.test.js.
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1) " +
      "ON CONFLICT(bot_id) DO UPDATE SET definition=excluded.definition",
    args: ["gate-bot", "Gate Bot", JSON.stringify({ gateways: [{ type: "gmail", address: "bot@x.com", allowlist: ["a@b.c"] }], tools: {}, models: {} })],
  });
});

afterEach(() => {
  _setEngineStatusForTest(null);
});

const layout = ({ content }) => content;

function mkGetReq(query) {
  return { method: "GET", query, body: {}, cookies: {}, headers: {} };
}
function mkSendRes() {
  const res = { html: null };
  res.send = (s) => { res.html = s; return res; };
  res.redirectAfterPost = () => {};
  return res;
}

/**
 * Render the real Gateways-tab HTML (form + engine-gate-client script +
 * modal overlay all ship in the SAME renderBotEditor response — see
 * editor.js's `nav + body + engineGateClientJS(lang)`), mount it in a
 * linkedom DOM, and execute the real emitted script against it via
 * node:vm.
 */
async function boot() {
  const res = mkSendRes();
  const req = mkGetReq({ bot: "gate-bot", tab: "gateways" });
  await renderBotEditor(req, res, { db, layout, lang: "en", PAGE_CSS: "", botId: "gate-bot", notice: "", q: req.query });
  assert.match(res.html, /data-engine-gate="1"/, "precondition: the fixture must actually arm the gate");

  const { window, document } = parseHTML(`<html><body>${res.html}</body></html>`);

  const form = document.getElementById("btb-gateways-form");
  assert.ok(form, "precondition: the gateways form must be present");

  // linkedom's HTMLFormElement implements neither requestSubmit() nor
  // submit() (verified against node_modules/linkedom/worker.js) — a real
  // browser has both. Stub requestSubmit directly on THIS element instance
  // (an own-property assignment shadows the missing prototype method) so
  // the client's `if (gwForm.requestSubmit) gwForm.requestSubmit(); else
  // gwForm.submit();` branch is exercised and its calls are observable,
  // same pattern as model-catalog-client-contract.test.js's
  // HTMLSelectElement.prototype patch.
  const requestSubmitCalls = [];
  form.requestSubmit = () => { requestSubmitCalls.push(true); };

  // window.__crowEngineGateOpen is reassigned unconditionally on every
  // script execution (not an `if (window.__x) return` once-guard — verified
  // by reading engine-gate-client.js), so unlike client.js's messages-panel
  // guards (tests/messages-first-run-ux.test.js) there is nothing here that
  // silently leaks stale behavior across boots; still clear it defensively
  // before each run since it is a window.__-prefixed global and linkedom
  // mirrors unqualified `window.foo = x` writes onto the real process
  // globalThis.
  delete globalThis.__crowEngineGateOpen;

  const calls = []; // fetch calls: {url, init, body}
  const timers = []; // queued setTimeout callbacks, never real — tests flush them
  const location = { href: "https://crow.test/dashboard/bot-builder?bot=gate-bot&tab=gateways", reload() {} };

  let fetchImpl = null; // set per-test via setFetchImpl(); default is a harmless 200 {}
  const fetchStub = (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), init, body });
    const result = fetchImpl ? fetchImpl(String(url), init) : { ok: true, status: 200, json: () => Promise.resolve({}) };
    return Promise.resolve(result);
  };

  const ctx = vm.createContext({
    window, document, location,
    fetch: fetchStub,
    console,
    URL,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
  });

  const CLIENT_HTML_START = res.html.indexOf("<script>");
  const CLIENT_HTML_END = res.html.lastIndexOf("</script>");
  const CLIENT_JS = res.html.slice(CLIENT_HTML_START + "<script>".length, CLIENT_HTML_END);
  vm.runInContext(CLIENT_JS, ctx);

  const $ = (sel) => document.querySelector(sel);
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  const change = (el) => el.dispatchEvent(new window.Event("change", { bubbles: true }));
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  const flushTimers = () => { const q = timers.splice(0); q.forEach((fn) => fn()); };
  /** Fire a real, cancelable "submit" event on the gateways form (what
   * requestSubmit()/a real submit click both dispatch) and report whether
   * the client's listener called preventDefault(). */
  const fireSubmit = () => {
    const ev = new window.Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(ev);
    return ev;
  };
  const setFetchImpl = (fn) => { fetchImpl = fn; };
  const overlay = document.getElementById("engine-gate-modal-overlay");
  const modalOpen = () => overlay.style.display === "flex";

  return { window, document, $, form, click, change, fireSubmit, settle, flushTimers, setFetchImpl, calls, requestSubmitCalls, overlay, modalOpen };
}

// ─── Bug 1 regression: a type switch away from a complete old-type record must NOT be intercepted ───

test("BEHAVIOR: switching gw_type on a stale-complete OLD-type record fires the re-render submit through, unintercepted (bug 1)", async () => {
  const { form, fireSubmit, requestSubmitCalls, modalOpen, change } = await boot();

  assert.equal(form.getAttribute("data-engine-fields-type"), "gmail", "precondition: fields-type attribute pins the type the required-fields list was computed for");
  assert.equal(form.getAttribute("data-engine-required-fields"), "gw_address,gw_allowlist");

  const typeSel = form.querySelector("[name='gw_type']");
  assert.ok(typeSel, "precondition: the gw_type select must be present");
  const discordOpt = [...typeSel.options].find((o) => o.value === "discord");
  assert.ok(discordOpt, "precondition: discord must be a selectable option");

  // Simulate the onchange handler's mid-flight state: the operator picked
  // "discord" in the dropdown, but the DOM still holds gmail's fields
  // (gw_address/gw_allowlist), still non-empty, because the server hasn't
  // re-rendered yet. This is exactly what this.form.requestSubmit() fires
  // in a real browser.
  for (const opt of typeSel.options) opt.selected = (opt.value === "discord");
  change(typeSel);

  const ev = fireSubmit();

  assert.equal(ev.defaultPrevented, false, "the re-render submit must NOT be intercepted — a stale old-type completeness reading must never block it (bug 1)");
  assert.equal(modalOpen(), false, "the install modal must not open on a harmless type switch");
  assert.equal(requestSubmitCalls.length, 0, "no gate-triggered resubmit either — this path never touches the gate at all");
});

// ─── Complete-record submit IS intercepted and opens the modal ───

test("BEHAVIOR: a complete gmail record with the engine absent (no type switch) IS intercepted and opens the install modal", async () => {
  const { form, fireSubmit, modalOpen, $ } = await boot();

  assert.equal(form.getAttribute("data-engine-fields-type"), "gmail");

  const ev = fireSubmit();

  assert.equal(ev.defaultPrevented, true, "a genuinely complete record for the CURRENT type must be intercepted");
  assert.equal(modalOpen(), true, "the install modal must open");
  assert.ok($("#engine-gate-modal-content button.btn-primary"), "the modal renders an Install button");
});

// ─── Bug 2 regression: cancel must make a completing job inert ───

test("BEHAVIOR: cancelling the install dialog makes a job that completes afterward inert — no auto-resubmit (bug 2)", async () => {
  const { form, fireSubmit, click, settle, flushTimers, setFetchImpl, calls, requestSubmitCalls, overlay, modalOpen, $ } = await boot();

  fireSubmit(); // opens the modal
  assert.equal(modalOpen(), true);

  let jobPollCount = 0;
  setFetchImpl((url) => {
    if (url.indexOf("/install") !== -1) {
      return { ok: true, status: 202, json: () => Promise.resolve({ job_id: "job-cancel-1" }) };
    }
    if (url.indexOf("/jobs/job-cancel-1") !== -1) {
      jobPollCount += 1;
      if (jobPollCount === 1) {
        return { ok: true, json: () => Promise.resolve({ status: "downloading", log: ["working"] }) };
      }
      return { ok: true, json: () => Promise.resolve({ status: "complete", log: ["done"] }) };
    }
    return { ok: true, status: 200, json: () => Promise.resolve({}) };
  });

  const installBtn = $("#engine-gate-modal-content button.btn-primary");
  assert.ok(installBtn);
  click(installBtn);
  await settle(); // POST /install -> jobId -> first /jobs poll -> "downloading" -> a 1000ms re-poll timer queued

  assert.equal(jobPollCount, 1, "precondition: the first poll landed and found the job still running");
  assert.equal(calls.some((c) => c.url.indexOf("/install") !== -1), true);

  // Operator backs out WHILE the job is still in flight.
  const cancelBtn = $("#engine-gate-modal-content button.btn-secondary");
  assert.ok(cancelBtn);
  click(cancelBtn);
  assert.equal(modalOpen(), false, "cancel hides the modal immediately");

  // The background poll keeps running (per spec: the server-side job is
  // left alone) and now reports completion.
  flushTimers();
  await settle();

  assert.equal(jobPollCount, 2, "precondition: the job did complete after the cancel");
  assert.equal(requestSubmitCalls.length, 0, "a job completing after cancel must NEVER trigger the auto-resubmit (bug 2)");
  assert.equal(modalOpen(), false, "still hidden — no side effect reopened or touched it");

  // Drain whatever the (pre-fix) 900ms post-completion timer would have
  // been, to prove no delayed effect sneaks through either.
  flushTimers();
  await settle();
  assert.equal(requestSubmitCalls.length, 0);
});

// ─── Successful (uncancelled) install path resubmits exactly once ───

test("BEHAVIOR: a successful install (never cancelled) hides the modal and resubmits the form exactly once", async () => {
  const { fireSubmit, click, settle, flushTimers, setFetchImpl, requestSubmitCalls, modalOpen, $ } = await boot();

  fireSubmit();
  assert.equal(modalOpen(), true);

  setFetchImpl((url) => {
    if (url.indexOf("/install") !== -1) {
      return { ok: true, status: 202, json: () => Promise.resolve({ job_id: "job-ok-1" }) };
    }
    if (url.indexOf("/jobs/job-ok-1") !== -1) {
      return { ok: true, json: () => Promise.resolve({ status: "complete", log: ["done"] }) };
    }
    return { ok: true, status: 200, json: () => Promise.resolve({}) };
  });

  const installBtn = $("#engine-gate-modal-content button.btn-primary");
  click(installBtn);
  await settle(); // POST /install -> jobId -> /jobs poll -> "complete" -> onDone(true) -> queues the 900ms hide/resubmit timer

  assert.equal(requestSubmitCalls.length, 0, "the resubmit is delayed ~900ms, not immediate");

  flushTimers(); // fire the 900ms timer
  await settle();

  assert.equal(modalOpen(), false, "the modal closes once installed");
  assert.equal(requestSubmitCalls.length, 1, "the SAME still-populated form is resubmitted exactly once via requestSubmit()");
});
