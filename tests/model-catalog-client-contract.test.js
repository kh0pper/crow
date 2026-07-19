/**
 * Model Catalog panel client — BEHAVIOR, executed (Task 13 fix round 3,
 * the GATING finding).
 *
 * A source-text regex over the client script (what the rest of this
 * panel's test suite otherwise relies on) cannot prove a click computed
 * the right request body, or that a DOM node was actually removed/added —
 * exactly the class of bug this round's finding was: `startDownload` sent
 * `force: fit !== "fits"` and a string-match test would have stayed green
 * forever, because the STRING "force:" appears in the file regardless of
 * whether it's ever `true` when it shouldn't be.
 *
 * So this file RUNS the real client against real server-rendered markup:
 *   renderRuntimeStrip()/renderCuratedTab() → the same HTML the panel serves
 *   linkedom                                → a DOM for it
 *   node:vm                                 → evaluate modelCatalogClientJS("en")
 * and asserts on the resulting DOM state / captured fetch calls after real
 * change/click events — mirrors tests/extensions-client-contract.test.js's
 * established pattern for this exact class of panel.
 *
 * Nothing here boots a real gateway, opens a DB, or reads
 * registry/model-catalog.json — every `data` object is a synthetic fixture,
 * including multi-quant entries the CURRENT shipped catalog doesn't have
 * yet (schema + CI already allow them; this is the "latent" case the
 * finding named).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { parseHTML } from "linkedom";

import { renderRuntimeStrip, renderCuratedTab, modelCatalogClientJS } from "../servers/gateway/dashboard/panels/model-catalog.js";

const CLIENT_HTML = modelCatalogClientJS("en");
/** The IIFE the browser would execute, lifted out of the emitted <script>. */
const CLIENT_JS = CLIENT_HTML.slice(
  CLIENT_HTML.indexOf("<script>") + "<script>".length,
  CLIENT_HTML.lastIndexOf("</script>"),
);
/** Everything before the <script> — the #mcat-modal-overlay the client mounts into. */
const OVERLAY_HTML = CLIENT_HTML.slice(0, CLIENT_HTML.indexOf("<script>"));

function baseData({ models = [], runtimeModels = [], hfTokenConfigured = false } = {}) {
  return {
    runtime: { name: "llama.cpp", release: "b10068" },
    probe: { platform: "linux", wsl2: false, accel: "cpu", gpuName: null, vramMb: null, ramAvailableMb: 8000, diskFreeMb: 500_000, unknown: [] },
    models,
    runtimeModels,
    estimatedRamMb: 0,
    estimatedVramMb: 0,
    hfTokenConfigured,
  };
}

/**
 * Render the strip + curated tab, build a DOM, and execute the real
 * client against it.
 *
 * @param {Function} [fetchImpl] (url, init) => {ok, status, json()} — a
 *   stub response shape; omit for a blanket harmless 200 {}.
 */
function boot({ models = [], runtimeModels = [], hfTokenConfigured = false, fetchImpl } = {}) {
  const data = baseData({ models, runtimeModels, hfTokenConfigured });
  const stripHtml = renderRuntimeStrip(data, "en");
  const curatedHtml = renderCuratedTab(data, "en");

  const { window, document } = parseHTML(
    `<html><body>${stripHtml}<div class="tabs"><div class="tab-panels"><div class="tab-panel tab-active" data-tab-panel="curated">${curatedHtml}</div></div></div>${OVERLAY_HTML}</body></html>`,
  );

  // linkedom@0.18's HTMLSelectElement has a working `.value` GETTER
  // (once an <option>'s own `.selected` is set directly) but a broken
  // `selectedIndex` getter (always undefined) and a no-op `.value`
  // SETTER — a real browser supports both. The panel's own change
  // handler reads `sel.options[sel.selectedIndex]`, so this patch (a
  // DOM-shim fix, not a product workaround) makes `selectedIndex`
  // actually reflect whichever <option> has `.selected === true`,
  // matching real DOM semantics — tests select a quant via
  // `selectQuant()` below, which sets `.selected` directly since
  // `sel.value = "..."` is a silent no-op in this linkedom version.
  if (!window.HTMLSelectElement.prototype.__mcatSelectedIndexPatched) {
    Object.defineProperty(window.HTMLSelectElement.prototype, "selectedIndex", {
      configurable: true,
      get() { return [...this.options].findIndex((o) => o.selected); },
    });
    window.HTMLSelectElement.prototype.__mcatSelectedIndexPatched = true;
  }

  const calls = [];       // every fetch the client made: {url, init, body}
  const timers = [];      // setTimeout is queued, never real: tests flush it
  const location = { href: "https://crow.test/dashboard/model-catalog", reload() {} };

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
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
  });
  vm.runInContext(CLIENT_JS, ctx);

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  const change = (el) => el.dispatchEvent(new window.Event("change", { bubbles: true }));
  /** Select an <option> by value and fire change — `sel.value = "..."` is
   * a no-op setter in this linkedom version (see the patch above), so
   * this sets `.selected` on the matching <option> directly instead. */
  const selectQuant = (sel, value) => {
    for (const opt of sel.options) opt.selected = (opt.value === value);
    change(sel);
  };
  /** Drain the promise microtask queue (the fetch stub resolves immediately). */
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  const flushTimers = () => { const q = timers.splice(0); q.forEach((fn) => fn()); };

  return { window, document, $, $$, click, change, selectQuant, settle, flushTimers, calls };
}

const downloadCalls = (calls) => calls.filter((c) => c.url.indexOf("/download") !== -1 && c.url.indexOf("/downloads") === -1);

// ─── 1a. Never auto-force; a 409 WONT_FIT surfaces an explicit confirm ───

test("BEHAVIOR: startDownload never computes force from the client's own fit belief — the FIRST attempt always sends force:false", async () => {
  const model = {
    id: "single-quant-model", family: "fam", lab: "Lab", license: "mit", gated: false,
    task: "chat", context_len: 4096, tags: ["chat", "small"], notes: null,
    default_quant: "Q4", first_run_default: false, registered: false, registeredQuant: null, running: false,
    quants: [{ quant: "Q4", size_mb: 500, min_ram_mb: 500, min_vram_mb: 0, fitBadge: "fits" }],
  };
  const { $, click, calls, settle } = boot({ models: [model] });

  const downloadBtn = $('.mcat-card__actions[data-model-id="single-quant-model"] [data-action="download"]');
  assert.ok(downloadBtn, "a fits quant renders a Download button");

  click(downloadBtn);
  await settle();

  const call = downloadCalls(calls)[0];
  assert.ok(call, "clicking Download posted to /download");
  assert.equal(call.body.force, false, "no force sent on a plain, unforced click");
});

test("BEHAVIOR: a server 409 WONT_FIT (the source of truth, not the client's stale badge) surfaces an explicit 'Download anyway' confirm; only confirming retries with force:true", async () => {
  const model = {
    id: "single-quant-model", family: "fam", lab: "Lab", license: "mit", gated: false,
    task: "chat", context_len: 4096, tags: ["chat", "small"], notes: null,
    default_quant: "Q4", first_run_default: false, registered: false, registeredQuant: null, running: false,
    quants: [{ quant: "Q4", size_mb: 500, min_ram_mb: 500, min_vram_mb: 0, fitBadge: "fits" }],
  };
  // The server is the authority on fit at request time (hardware can change
  // between page render and click) — this fixture simulates the server
  // disagreeing with the badge that was true when the page rendered,
  // exactly the case an auto-force silently steamrolled.
  let attempt = 0;
  const fetchImpl = (url) => {
    if (url.indexOf("/download") !== -1 && url.indexOf("/downloads") === -1) {
      attempt += 1;
      if (attempt === 1) {
        return { ok: false, status: 409, json: () => Promise.resolve({ code: "WONT_FIT", error: "won't fit", fitBadge: "wont_fit" }) };
      }
      return { ok: true, status: 202, json: () => Promise.resolve({ jobId: "single-quant-model::Q4", status: "downloading" }) };
    }
    return { ok: true, status: 200, json: () => Promise.resolve({}) };
  };
  const { $, click, calls, settle } = boot({ models: [model], fetchImpl });

  const actions = $('.mcat-card__actions[data-model-id="single-quant-model"]');
  const downloadBtn = actions.querySelector('[data-action="download"]');
  click(downloadBtn);
  await settle();

  assert.equal(downloadCalls(calls).length, 1, "no silent retry happened on its own");
  assert.equal(downloadCalls(calls)[0].body.force, false);

  const confirmBtn = actions.querySelector("button");
  assert.ok(confirmBtn, "the 409 replaced the action area with an explicit confirm button");
  assert.notEqual(confirmBtn, downloadBtn, "a fresh element, not the original button silently relabeled");
  assert.equal(confirmBtn.getAttribute("data-action"), null, "NOT wired through the delegated data-action handler — a second listener there would double-fire this exact click");
  assert.equal(confirmBtn.textContent, "Download anyway (may not fit)");

  click(confirmBtn);
  await settle();

  const after = downloadCalls(calls);
  assert.equal(after.length, 2, "exactly one retry, triggered only by the explicit confirm click");
  assert.equal(after[1].body.force, true, "the confirmed retry is the ONLY call that ever carries force:true");
});

// ─── 1b. Quant-select change re-renders the action area ───

test("BEHAVIOR: switching from a wont_fit default to a fitting quant reveals the Download button (previously undownloadable no matter what the operator picked)", async () => {
  const model = {
    id: "multi-quant-model", family: "fam", lab: "Lab", license: "mit", gated: false,
    task: "chat", context_len: 4096, tags: ["chat", "mid"], notes: null,
    default_quant: "Q_BIG", first_run_default: false, registered: false, registeredQuant: null, running: false,
    quants: [
      { quant: "Q_BIG", size_mb: 90_000, min_ram_mb: 90_000, min_vram_mb: 0, fitBadge: "wont_fit" },
      { quant: "Q_SMALL", size_mb: 500, min_ram_mb: 500, min_vram_mb: 0, fitBadge: "fits" },
    ],
  };
  const { $, selectQuant, click, calls } = boot({ models: [model] });

  const actions = $('.mcat-card__actions[data-model-id="multi-quant-model"]');
  assert.equal(actions.querySelector('[data-action="download"]'), null, "wont_fit default renders NO Download button (per spec: disabled, not silently clickable)");
  assert.ok(actions.querySelector(".mcat-card__notice"), "a notice explains why instead");

  const sel = $('.mcat-quant-select[data-model-id="multi-quant-model"]');
  selectQuant(sel, "Q_SMALL");

  const downloadBtn = actions.querySelector('[data-action="download"]');
  assert.ok(downloadBtn, "selecting the fitting alternate quant reveals the Download button — the entry is now actually downloadable, closing the dead end");
  assert.equal(actions.querySelector(".mcat-card__notice"), null);

  click(downloadBtn);
  const call = downloadCalls(calls)[0];
  assert.equal(call.body.quant, "Q_SMALL", "targets the quant actually selected in the dropdown, not the stale wont_fit default");
  assert.equal(call.body.force, false);
});

test("BEHAVIOR: switching from a fitting default to a wont_fit quant HIDES the Download button (never leaves a stale enabled button pointed at an unfittable quant)", () => {
  const model = {
    id: "multi-quant-model-2", family: "fam", lab: "Lab", license: "mit", gated: false,
    task: "chat", context_len: 4096, tags: ["chat", "mid"], notes: null,
    default_quant: "Q_SMALL", first_run_default: false, registered: false, registeredQuant: null, running: false,
    quants: [
      { quant: "Q_SMALL", size_mb: 500, min_ram_mb: 500, min_vram_mb: 0, fitBadge: "fits" },
      { quant: "Q_BIG", size_mb: 90_000, min_ram_mb: 90_000, min_vram_mb: 0, fitBadge: "wont_fit" },
    ],
  };
  const { $, selectQuant } = boot({ models: [model] });
  const actions = $('.mcat-card__actions[data-model-id="multi-quant-model-2"]');
  assert.ok(actions.querySelector('[data-action="download"]'), "fits default starts with a Download button");

  const sel = $('.mcat-quant-select[data-model-id="multi-quant-model-2"]');
  selectQuant(sel, "Q_BIG");

  assert.equal(actions.querySelector('[data-action="download"]'), null, "wont_fit selection removes the button entirely");
  assert.ok(actions.querySelector(".mcat-card__notice"));
});

test("BEHAVIOR: quant change never touches the action area for an already-registered/running model (Start/Stop/Remove stay put)", () => {
  const model = {
    id: "installed-multi-quant", family: "fam", lab: "Lab", license: "mit", gated: false,
    task: "chat", context_len: 4096, tags: ["chat", "mid"], notes: null,
    default_quant: "Q_SMALL", first_run_default: false, registered: true, registeredQuant: "Q_SMALL", running: false,
    quants: [
      { quant: "Q_SMALL", size_mb: 500, min_ram_mb: 500, min_vram_mb: 0, fitBadge: "fits" },
      { quant: "Q_BIG", size_mb: 90_000, min_ram_mb: 90_000, min_vram_mb: 0, fitBadge: "wont_fit" },
    ],
  };
  const { $, selectQuant } = boot({ models: [model] });
  const actions = $('.mcat-card__actions[data-model-id="installed-multi-quant"]');
  assert.ok(actions.querySelector('[data-action="start"]'));
  assert.ok(actions.querySelector('[data-action="remove"]'));

  const sel = $('.mcat-quant-select[data-model-id="installed-multi-quant"]');
  selectQuant(sel, "Q_BIG");

  assert.ok(actions.querySelector('[data-action="start"]'), "Start button untouched by a quant change on an installed model");
  assert.ok(actions.querySelector('[data-action="remove"]'), "Remove button untouched");
  assert.equal(actions.querySelector('[data-action="download"]'), null);
});

// ─── 2. hf-browser Remove affordance in the runtime strip ───

test("BEHAVIOR: the runtime strip renders a Remove button for hf-browser-sourced entries, and NOT for curated ones", () => {
  const runtimeModels = [
    { modelId: "curated-running-model", source: "curated", state: "running", live: true, port: 18101, restartCount: 0, lastError: null, startedAt: "t", pid: 111 },
    { modelId: "hf-model", source: "hf-browser", state: "stopped", live: false, port: null, restartCount: 0, lastError: null, startedAt: null, pid: null },
  ];
  const { $$ } = boot({ models: [], runtimeModels });
  const removeButtons = $$('button[data-action="remove"]');
  const removeIds = removeButtons.map((b) => b.getAttribute("data-model-id"));
  assert.ok(removeIds.includes("hf-model"), "hf-browser row gets a Remove button in the strip (its only removal surface — it has no curated card)");
  assert.ok(!removeIds.includes("curated-running-model"), "curated row does not duplicate Remove in the strip — its own card already has one");
});

test("BEHAVIOR: clicking the strip's Remove button for an hf-browser entry goes through the real delete-confirm flow", async () => {
  const runtimeModels = [
    { modelId: "hf-model", source: "hf-browser", state: "stopped", live: false, port: null, restartCount: 0, lastError: null, startedAt: null, pid: null },
  ];
  const fetchImpl = (url, init) => {
    if (url.indexOf("/api/models/hf-model") !== -1 || url.endsWith("/hf-model")) {
      return {
        ok: true, status: 200,
        json: () => Promise.resolve({ requiresConfirm: true, modelId: "hf-model", bindings: { profiles: [], bots: [] } }),
      };
    }
    return { ok: true, status: 200, json: () => Promise.resolve({}) };
  };
  const { $, click, settle, document } = boot({ models: [], runtimeModels, fetchImpl });
  const removeBtn = $('button[data-action="remove"][data-model-id="hf-model"]');
  assert.ok(removeBtn);

  click(removeBtn);
  await settle();

  const overlay = document.getElementById("mcat-modal-overlay");
  assert.equal(overlay.style.display, "flex", "the confirmation modal opened — the strip's Remove reuses the exact same requestDelete/showDeleteConfirm flow the curated cards use");
  assert.match(document.getElementById("mcat-modal-content").textContent, /nothing else references this model|hf-model/i);
});

// ─── 3. HTTP_401 -> the gatedNoToken copy ───

test("BEHAVIOR: a job that fails with errorCode HTTP_401 shows the 'requires a Hugging Face login' copy (HF answers an unauthenticated gated download 401, not 403)", async () => {
  const model = {
    id: "gated-model", family: "fam", lab: "Lab", license: "gemma", gated: true,
    task: "chat", context_len: 4096, tags: ["chat", "large", "gated"], notes: null,
    default_quant: "Q4", first_run_default: false, registered: false, registeredQuant: null, running: false,
    quants: [{ quant: "Q4", size_mb: 500, min_ram_mb: 500, min_vram_mb: 0, fitBadge: "fits" }],
  };
  const fetchImpl = (url) => {
    if (url.indexOf("/download") !== -1 && url.indexOf("/downloads") === -1) {
      return { ok: true, status: 202, json: () => Promise.resolve({ jobId: "gated-model::Q4", status: "downloading" }) };
    }
    if (url.indexOf("/downloads") !== -1) {
      return {
        ok: true, status: 200,
        json: () => Promise.resolve({ downloads: [{ id: "gated-model::Q4", status: "error", errorCode: "HTTP_401", error: "Unauthorized", bytesDone: 0, totalBytes: null }] }),
      };
    }
    return { ok: true, status: 200, json: () => Promise.resolve({}) };
  };
  const { $, click, settle } = boot({ models: [model], fetchImpl });

  const downloadBtn = $('.mcat-card__actions[data-model-id="gated-model"] [data-action="download"]');
  click(downloadBtn);
  await settle();

  const statusEl = $('.mcat-card__status-text[data-model-id="gated-model"]');
  assert.equal(
    statusEl.textContent,
    "This model requires a Hugging Face login. Add a token in the Browse Hugging Face tab below, then retry.",
  );
});

test("BEHAVIOR: HTTP_403 still shows the distinct 'accept the license, then retry' copy (401 and 403 stay separately meaningful)", async () => {
  const model = {
    id: "gated-model-403", family: "fam", lab: "Lab", license: "gemma", gated: true,
    task: "chat", context_len: 4096, tags: ["chat", "large", "gated"], notes: null,
    default_quant: "Q4", first_run_default: false, registered: false, registeredQuant: null, running: false,
    quants: [{ quant: "Q4", size_mb: 500, min_ram_mb: 500, min_vram_mb: 0, fitBadge: "fits" }],
  };
  const fetchImpl = (url) => {
    if (url.indexOf("/download") !== -1 && url.indexOf("/downloads") === -1) {
      return { ok: true, status: 202, json: () => Promise.resolve({ jobId: "gated-model-403::Q4", status: "downloading" }) };
    }
    if (url.indexOf("/downloads") !== -1) {
      return {
        ok: true, status: 200,
        json: () => Promise.resolve({ downloads: [{ id: "gated-model-403::Q4", status: "error", errorCode: "HTTP_403", error: "Forbidden", bytesDone: 0, totalBytes: null }] }),
      };
    }
    return { ok: true, status: 200, json: () => Promise.resolve({}) };
  };
  const { $, click, settle } = boot({ models: [model], fetchImpl });

  const downloadBtn = $('.mcat-card__actions[data-model-id="gated-model-403"] [data-action="download"]');
  click(downloadBtn);
  await settle();

  const statusEl = $('.mcat-card__status-text[data-model-id="gated-model-403"]');
  assert.match(statusEl.textContent, /accept the license/i);
  assert.doesNotMatch(statusEl.textContent, /requires a Hugging Face login/);
});
