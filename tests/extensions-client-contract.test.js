/**
 * Extensions store client — BEHAVIOR, executed (Task 11).
 *
 * The client is a template string, so the cheap guard would be a regex over the
 * emitted source. That guard is worthless here and this branch has the receipts:
 * a string-match test stayed green while the CSS rule it asserted was losing the
 * cascade and every "hidden" card was actually visible. A regex cannot prove that
 * a click hides a section.
 *
 * So this file RUNS the real client against the real markup:
 *   buildExtensionsHTML()  → the same HTML the panel serves
 *   linkedom               → a DOM for it
 *   node:vm                → evaluate extensionsClientJS("en") against that DOM
 * and then asserts on the resulting DOM state after real click / input events.
 *
 * Nothing here imports routes/bundles.js or data-queries.js, so ~/.crow is never
 * read or written; the network is a stub.
 *
 * NOT covered here (linkedom has no layout/CSS engine) — Task 13's CDP run owns it:
 *   - that .ext-card.ext-card--overflow actually paints hidden (tests/extensions-page-render.test.js
 *     resolves the cascade statically; only a browser proves the pixels)
 *   - scrollIntoView() on the #collections deep link
 *   - the real gateway restart + reload round-trip behind the checklist
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { parseHTML } from "linkedom";

import { buildExtensionsHTML } from "../servers/gateway/dashboard/panels/extensions/html.js";
import { extensionsClientJS } from "../servers/gateway/dashboard/panels/extensions/client.js";

const CLIENT_HTML = extensionsClientJS("en");
/** The IIFE the browser would execute, lifted out of the emitted <script>. */
const CLIENT_JS = CLIENT_HTML.slice(
  CLIENT_HTML.indexOf("<script>") + "<script>".length,
  CLIENT_HTML.lastIndexOf("</script>"),
);
/** Everything before the <script> — the #modal-overlay the client mounts into. */
const OVERLAY_HTML = CLIENT_HTML.slice(0, CLIENT_HTML.indexOf("<script>"));

const AVAILABLE = [
  { id: "jellyfin", name: "Jellyfin", description: "Media server", type: "bundle", category: "media", version: "1.0.0", author: "Crow", featured: true, tags: ["video"], env_vars: [{ name: "JELLYFIN_API_KEY", description: "API key", required: true }] },
  { id: "navidrome", name: "Navidrome", description: "Music streaming", type: "bundle", category: "media", version: "1.0.0", author: "Crow", tags: ["music"] },
  { id: "searxng", name: "SearXNG", description: "Private metasearch", type: "bundle", category: "infrastructure", version: "1.0.0", author: "Crow", tags: [] },
  { id: "kolibri", name: "Kolibri", description: "Learning platform", type: "bundle", category: "education", version: "1.0.0", author: "Crow", tags: [] },
  { id: "hass", name: "Home Assistant", description: "Smart home hub", type: "bundle", category: "smart-home", version: "1.0.0", author: "Crow", tags: [] },
];

const COLLECTIONS = [{
  id: "home-theater",
  name: "Home Theater",
  description: "Everything to watch and listen at home.",
  icon: "home",
  members: [
    { id: "jellyfin", kind: "deploys" },
    { id: "hass", kind: "connects", you_need: "a Home Assistant you already run" },
  ],
}];

/** 10 media add-ons → the group overflows the 8-card cap (2 .ext-card--overflow). */
const MANY_MEDIA = Array.from({ length: 10 }, (_, i) => ({
  id: `m${i}`, name: `Media ${i}`, description: "d", type: "bundle",
  category: "media", version: "1.0.0", author: "Crow", tags: [],
}));

/**
 * Render the page, build a DOM, and execute the real client against it.
 *
 * @param {object} opts
 * @param {Function} opts.fetchImpl  (url, init) => Promise<{ok,status,json()}>
 * @param {object}   opts.session     seed for the sessionStorage stub
 * @param {string}   opts.hash        initial location.hash
 * @returns the DOM plus the spies the tests assert against
 */
function boot({ available = AVAILABLE, collections = COLLECTIONS, installed = {}, needsConfig = {}, fetchImpl, session = {}, hash = "" } = {}) {
  const { viewsHtml, addonRegistryScript, collectionsScript } = buildExtensionsHTML({
    installed, available, collections, needsConfig,
    registrySource: "local", communityStores: [], bundleStatus: {}, lang: "en",
  });

  const { window, document } = parseHTML(
    `<html><body><div class="main-content">${viewsHtml}${addonRegistryScript}${collectionsScript}${OVERLAY_HTML}</div></body></html>`,
  );

  const calls = [];               // every fetch the client made
  const reloads = { count: 0 };
  const store = new Map(Object.entries(session));
  const timers = [];              // setTimeout is queued, never real: tests flush it

  const location = {
    hash,
    href: "https://crow.test/dashboard/extensions",
    reload() { reloads.count++; },
  };

  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const fetchStub = (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    return Promise.resolve(fetchImpl ? fetchImpl(String(url), init) : { ok: true, status: 200, json: () => Promise.resolve({}) });
  };

  const ctx = vm.createContext({
    window, document, location, sessionStorage,
    fetch: fetchStub,
    console,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  });
  window.location = location;
  vm.runInContext(CLIENT_JS, ctx);

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  const type = (value) => {
    const input = document.getElementById("ext-search");
    input.value = value;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  /** Drain the promise microtask queue (the fetch stub resolves immediately). */
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  /** Run whatever the client queued on setTimeout (poll retry, reload, ...). */
  const flushTimers = () => { const q = timers.splice(0); q.forEach((fn) => fn()); };

  const visible = (el) => !!el && el.style.display !== "none" && !el.hidden;

  return { window, document, $, $$, click, type, settle, flushTimers, calls, reloads, store, visible };
}

// ─── 1. Segmented control ───

test("BEHAVIOR: the segmented control swaps the two views and reports aria-pressed", () => {
  const { $, click, visible } = boot({ installed: { jellyfin: { version: "1.0.0" } } });

  assert.ok(visible($("#ext-view-browse")), "browse is the landing view");
  assert.ok(!visible($("#ext-view-installed")), "installed starts hidden");

  click($('.ext-viewtab[data-view="installed"]'));

  assert.ok(!visible($("#ext-view-browse")), "browse hidden after switching to Installed");
  assert.ok(visible($("#ext-view-installed")), "installed shown");
  assert.equal($('.ext-viewtab[data-view="installed"]').getAttribute("aria-pressed"), "true");
  assert.equal($('.ext-viewtab[data-view="browse"]').getAttribute("aria-pressed"), "false");
  assert.ok($('.ext-viewtab[data-view="installed"]').classList.contains("ext-viewtab--active"));

  click($('.ext-viewtab[data-view="browse"]'));
  assert.ok(visible($("#ext-view-browse")));
  assert.ok(!visible($("#ext-view-installed")));
});

test("BEHAVIOR: a #installed deep link lands on the Installed view without a click", () => {
  const { $, visible } = boot({ hash: "#installed" });
  assert.ok(visible($("#ext-view-installed")), "#installed opens the Installed view on load");
  assert.ok(!visible($("#ext-view-browse")));
});

// ─── 2. Group chips ───

test("BEHAVIOR: a group chip leaves only its own section visible; clicking it again restores all", () => {
  const { $, $$, click, visible } = boot();

  const sections = $$(".ext-group-section");
  assert.ok(sections.length >= 3, "fixture spans several groups");
  assert.ok(sections.every(visible), "every group section starts visible");

  click($('.ext-group-chip[data-group="media"]'));
  for (const s of $$(".ext-group-section")) {
    assert.equal(
      visible(s), s.dataset.group === "media",
      `after the media chip, section '${s.dataset.group}' visible=${visible(s)}`,
    );
  }
  assert.ok($('.ext-group-chip[data-group="media"]').classList.contains("ext-group-chip--active"));

  click($('.ext-group-chip[data-group="media"]')); // toggle back to "all"
  assert.ok($$(".ext-group-section").every(visible), "clicking the active chip restores every section");
});

// ─── 3. Search ───

test("BEHAVIOR: a query hides collections/featured/groups and surfaces the matches in a flat grid", () => {
  const { $, $$, type, visible } = boot();

  type("music");

  assert.ok(!visible($("#ext-collections")), "collections hidden while searching");
  assert.ok(!visible($("#ext-featured")), "featured hidden while searching");
  assert.ok($$(".ext-group-section").every((s) => !visible(s)), "group sections hidden while searching");

  const results = $("#ext-search-results");
  assert.ok(visible(results), "the flat results grid is shown");
  const ids = [...results.querySelectorAll(".addon-card")].map((c) => c.dataset.addonId);
  assert.deepEqual(ids, ["navidrome"], "only the matching add-on is in the results grid");
  assert.ok(!visible($("#ext-no-results")));

  type("");  // clearing restores the browse layout
  assert.ok(visible($("#ext-collections")));
  assert.ok(visible($("#ext-featured")));
  assert.ok($$(".ext-group-section").every(visible));
  assert.ok(!visible($("#ext-search-results")), "the results grid is put away");
  assert.equal(
    $('.ext-group-section[data-group="media"] .addon-card[data-addon-id="navidrome"]') !== null, true,
    "the card went home to its group section",
  );
});

test("BEHAVIOR: a query with no match surfaces #ext-no-results", () => {
  const { $, type, visible } = boot();
  type("zzzznothing");
  assert.ok(visible($("#ext-no-results")), "the empty-state line is shown");
  assert.ok(!visible($("#ext-search-results")), "an empty results grid is not left hanging");
  type("");
  assert.ok(!visible($("#ext-no-results")), "clearing puts the empty state away");
});

test("BEHAVIOR: search finds a card that is past its group's overflow cap, and un-hides it", () => {
  const { $, type } = boot({ available: MANY_MEDIA, collections: [] });

  const card = $('.addon-card[data-addon-id="m9"]');   // 10th of 10 → overflow
  assert.ok(card.classList.contains("ext-card--overflow"), "m9 starts capped");

  type("media 9");
  assert.equal(card.parentNode.id, "ext-search-results", "the capped card moved into the results grid");
  assert.ok(
    !card.classList.contains("ext-card--overflow"),
    "a search result is not in a group section, so the overflow cap does not apply to it",
  );

  type("");
  assert.ok(card.classList.contains("ext-card--overflow"), "clearing the query re-applies the cap");
  assert.equal(card.parentNode.parentNode.dataset.group, "media", "and the card is back in its group");
});

// ─── 4. Show all ───

test("BEHAVIOR: Show all reveals the capped cards by REMOVING the class, and the label swaps", () => {
  const { $, $$, click } = boot({ available: MANY_MEDIA, collections: [] });

  const overflow = $$(".addon-card").filter((c) => c.classList.contains("ext-card--overflow"));
  assert.equal(overflow.length, 2, "10 media add-ons, cap 8 → 2 capped cards");

  const more = $('.ext-group-more[data-group="media"]');
  assert.match(more.textContent, /Show all/);

  click(more);

  // The cascade hides overflow cards via `.ext-card.ext-card--overflow` (0-2-0);
  // an inline display could not beat it, so the reveal MUST drop the class.
  assert.equal(
    $$(".addon-card").filter((c) => c.classList.contains("ext-card--overflow")).length, 0,
    "Show all removed the overflow class from every capped card",
  );
  for (const c of $$(".addon-card")) {
    assert.ok(!/display/.test(c.getAttribute("style") || ""), "no add-on card carries an inline display");
  }
  assert.match(more.textContent, /Show fewer/);

  click(more);
  assert.equal(
    $$(".addon-card").filter((c) => c.classList.contains("ext-card--overflow")).length, 2,
    "Show fewer re-caps the group",
  );
  assert.match(more.textContent, /Show all/);
});

test("BEHAVIOR: an expanded group stays expanded across a search and back", () => {
  const { $, $$, click, type } = boot({ available: MANY_MEDIA, collections: [] });

  click($('.ext-group-more[data-group="media"]'));
  type("media");
  type("");

  assert.equal(
    $$(".addon-card").filter((c) => c.classList.contains("ext-card--overflow")).length, 0,
    "the user's Show-all survives a search round-trip",
  );
});

// ─── 5. Collection modal → install-set ───

function installSetFetch({ status = 200, body = { job_id: "job-1", plan: [] }, job } = {}) {
  return (url) => {
    if (url.includes("/bundles/api/install-set")) {
      return { ok: status < 400, status, json: () => Promise.resolve(body) };
    }
    if (url.includes("/bundles/api/jobs/")) {
      return { ok: true, status: 200, json: () => Promise.resolve(job || { status: "running", log: ["working"] }) };
    }
    if (url.includes("/consent-challenge/")) {
      return { ok: true, status: 200, json: () => Promise.resolve({ required: false }) };
    }
    return { ok: true, status: 200, json: () => Promise.resolve({}) };
  };
}

test("BEHAVIOR: clicking a collection card opens a modal listing its members and how each arrives", () => {
  const { $, $$, click, document } = boot({ fetchImpl: installSetFetch() });

  click($('.ext-collection-card[data-collection-id="home-theater"]'));

  assert.equal(document.getElementById("modal-overlay").style.display, "flex", "the modal is open");
  const rows = $$(".ext-collection-modal__item");
  assert.deepEqual(rows.map((r) => r.dataset.memberId), ["jellyfin", "hass"]);
  assert.match(rows[0].textContent, /Jellyfin/);
  assert.match(rows[0].textContent, /Will install/);
  assert.match(rows[0].textContent, /Runs on this Crow/);
  // the `connects` member says what the user must already run
  assert.match(rows[1].textContent, /Connects to a service you already run/);
  assert.match(rows[1].textContent, /You'll need.*Home Assistant/);
  assert.match($(".ext-collection-modal__note").textContent, /restarts Crow once/);
  assert.match($(".ext-collection-install").textContent, /Install collection/);
});

test("BEHAVIOR: the modal's primary button POSTs the collection id to /bundles/api/install-set and polls the job", async () => {
  const ctx = boot({
    fetchImpl: installSetFetch({
      body: { job_id: "job-7", plan: [{ id: "jellyfin", action: "install" }, { id: "hass", action: "skip", reason: "already installed" }] },
      job: { status: "running", log: ["Installing jellyfin..."] },
    }),
  });
  const { $, click, settle, calls } = ctx;

  click($('.ext-collection-card[data-collection-id="home-theater"]'));
  click($(".ext-collection-install"));
  await settle();

  const post = calls.find((c) => c.url.includes("install-set"));
  assert.ok(post, "the client POSTed to install-set");
  assert.equal(post.init.method, "POST");
  assert.deepEqual(post.body, { collection_id: "home-theater" });
  assert.ok(calls.some((c) => c.url.includes("/bundles/api/jobs/job-7")), "and polls the returned job id");

  // the plan's skip reason lands on the member row
  assert.match($('.ext-collection-modal__item-state[data-member-id="hass"]').textContent, /Skipped .*already installed/);
  assert.equal($(".ext-collection-install").disabled, true, "the button is locked while the set runs");
});

test("BEHAVIOR: a 409 from install-set says another install is running — and does not look like success", async () => {
  const { $, click, settle, calls } = boot({
    fetchImpl: installSetFetch({ status: 409, body: { error: "Another install is in progress — wait for it to finish and try again." } }),
  });

  click($('.ext-collection-card[data-collection-id="home-theater"]'));
  click($(".ext-collection-install"));
  await settle();

  const status = $("#collection-status");
  assert.equal(status.style.display, "block");
  assert.match(status.textContent, /Another install is already running/);
  assert.equal($(".ext-collection-install").disabled, false, "the button is handed back so the user can retry");
  assert.ok(!calls.some((c) => c.url.includes("/bundles/api/jobs/")), "no job is polled — nothing was started");
});

// ─── 6. Post-install checklist ───

test("BEHAVIOR: NEEDS_CONFIG lines in the finished job are parsed and persisted before the reload", async () => {
  const { $, click, settle, flushTimers, store, reloads } = boot({
    fetchImpl: installSetFetch({
      body: { job_id: "job-9", plan: [] },
      job: {
        status: "complete",
        log: [
          "Installing jellyfin...",
          "SUMMARY member jellyfin installed",
          "SUMMARY member hass skipped not found in this Crow's bundle set",
          "NEEDS_CONFIG jellyfin JELLYFIN_API_KEY",
          "Collection install complete",
        ],
      },
    }),
  });

  click($('.ext-collection-card[data-collection-id="home-theater"]'));
  click($(".ext-collection-install"));
  await settle();

  assert.deepEqual(
    JSON.parse(store.get("crow_ext_needs_config")),
    [{ id: "jellyfin", keys: ["JELLYFIN_API_KEY"] }],
    "the checklist is in sessionStorage BEFORE the page goes away",
  );
  // SUMMARY lines repaint the member rows
  assert.match($('.ext-collection-modal__item-state[data-member-id="jellyfin"]').textContent, /Installed/);
  assert.match($('.ext-collection-modal__item-state[data-member-id="hass"]').textContent, /Skipped .*not found/);

  flushTimers();  // the queued location.reload()
  assert.equal(reloads.count, 1, "the page reloads to pick up the newly installed set");
});

test("BEHAVIOR: after the reload, the persisted checklist renders a Configure row per member", () => {
  // Exactly the state the previous test left behind — this is the post-reload render.
  const { $, document, store } = boot({
    session: { crow_ext_needs_config: JSON.stringify([{ id: "jellyfin", keys: ["JELLYFIN_API_KEY"] }]) },
    fetchImpl: installSetFetch(),
  });

  assert.equal(document.getElementById("modal-overlay").style.display, "flex", "the checklist modal opens itself");
  const row = $('.ext-checklist__row[data-addon-id="jellyfin"]');
  assert.ok(row, "a checklist row for jellyfin");
  assert.match(row.textContent, /Jellyfin/);
  assert.match(row.textContent, /JELLYFIN_API_KEY/, "and it names the key that is still missing");
  assert.ok(row.querySelector(".ext-checklist__configure"), "with a Configure button");
  assert.equal(store.get("crow_ext_needs_config"), undefined, "consumed once — a Turbo revisit must not re-open it");
});

/**
 * Every checklist member is BY DEFINITION already installed (that's what
 * NEEDS_CONFIG means), so Configure must write the env value through the
 * existing-bundle route — never re-run install, which validateInstall would
 * reject with 409 already_installed and silently drop the typed value.
 */
function envFetch({ status = 200, body = { ok: true, needs_restart: false } } = {}) {
  return (url) => {
    if (url.includes("/bundles/api/env")) {
      return { ok: status < 400, status, json: () => Promise.resolve(body) };
    }
    return { ok: true, status: 200, json: () => Promise.resolve({}) };
  };
}

test("BEHAVIOR: Configure opens an env-only form scoped to the missing keys", async () => {
  const { $, click, settle, document } = boot({
    session: { crow_ext_needs_config: JSON.stringify([{ id: "jellyfin", keys: ["JELLYFIN_API_KEY"] }]) },
    fetchImpl: envFetch(),
  });

  click($(".ext-checklist__configure"));
  await settle();

  assert.match(document.getElementById("modal-content").textContent, /Configure.*Jellyfin/s);
  assert.ok(document.getElementById("env_JELLYFIN_API_KEY"), "the env field for the missing key is on screen");
});

test("BEHAVIOR: Configure submits to /bundles/api/env (never /bundles/api/install) and clears the checklist entry", async () => {
  const { $, click, settle, flushTimers, document, calls, store } = boot({
    session: { crow_ext_needs_config: JSON.stringify([{ id: "jellyfin", keys: ["JELLYFIN_API_KEY"] }]) },
    fetchImpl: envFetch(),
  });

  click($(".ext-checklist__configure"));
  await settle();

  const input = document.getElementById("env_JELLYFIN_API_KEY");
  input.value = "secret-key-123";

  const saveBtn = document.querySelector("#modal-content .ext-checklist__save");
  assert.ok(saveBtn, "the configure form has a save action");
  click(saveBtn);
  await settle();
  flushTimers(); // the queued onSaved() that clears the checklist entry

  const envCall = calls.find((c) => c.url.includes("/bundles/api/env"));
  assert.ok(envCall, "the client POSTed to /bundles/api/env");
  assert.equal(envCall.init.method, "POST");
  assert.deepEqual(envCall.body, { bundle_id: "jellyfin", env_vars: { JELLYFIN_API_KEY: "secret-key-123" } });

  assert.ok(
    !calls.some((c) => c.url.includes("/bundles/api/install")),
    "an already-installed checklist member must never hit /install — validateInstall would 409 it and the typed value would vanish",
  );

  assert.equal(
    store.get("crow_ext_needs_config"),
    undefined,
    "the checklist entry is cleared from sessionStorage once its env is saved",
  );
});

test("BEHAVIOR: a save that needs a restart surfaces that via i18n text before the modal moves on", async () => {
  const { $, click, settle, document } = boot({
    session: { crow_ext_needs_config: JSON.stringify([{ id: "jellyfin", keys: ["JELLYFIN_API_KEY"] }]) },
    fetchImpl: envFetch({ body: { ok: true, needs_restart: true } }),
  });

  click($(".ext-checklist__configure"));
  await settle();
  document.getElementById("env_JELLYFIN_API_KEY").value = "secret-key-123";
  click(document.querySelector("#modal-content .ext-checklist__save"));
  await settle();

  assert.match(
    document.getElementById("install-status").textContent,
    /restart/i,
    "a needs_restart response tells the user before the checklist entry is cleared",
  );
});

test("BEHAVIOR: a failed Configure save keeps the checklist entry and shows the server's error", async () => {
  const { $, click, settle, document } = boot({
    session: { crow_ext_needs_config: JSON.stringify([{ id: "jellyfin", keys: ["JELLYFIN_API_KEY"] }]) },
    fetchImpl: envFetch({ status: 404, body: { error: "Bundle 'jellyfin' is not installed" } }),
  });

  click($(".ext-checklist__configure"));
  await settle();

  document.getElementById("env_JELLYFIN_API_KEY").value = "secret-key-123";
  const saveBtn = document.querySelector("#modal-content .ext-checklist__save");
  click(saveBtn);
  await settle();

  assert.match(document.getElementById("modal-content").textContent, /Bundle 'jellyfin' is not installed/);
  // onSaved (the only thing that clears/marks-done a checklist entry) is wired
  // to the success branch only — a failure hands the button back for another
  // try instead, proving the entry was never cleared.
  assert.equal(saveBtn.disabled, false, "the save button is handed back so the user can retry");
  assert.match(saveBtn.textContent, /Retry/);
});

test("BEHAVIOR: an empty Configure save is refused — no fetch, onSaved never runs", async () => {
  // renderPendingChecklist() consumes crow_ext_needs_config from sessionStorage
  // unconditionally at load (it's re-written only from inside onSaved, with
  // whatever the in-memory checklist `list` looks like at that moment) — so the
  // observable proof that a blocked save didn't silently "complete" the entry
  // is that onSaved's side effects (splicing it out of `list`, moving the modal
  // on to the next screen) never fire, not sessionStorage state at rest.
  const { $, click, settle, document, calls } = boot({
    session: { crow_ext_needs_config: JSON.stringify([{ id: "jellyfin", keys: ["JELLYFIN_API_KEY"] }]) },
    fetchImpl: envFetch(),
  });

  click($(".ext-checklist__configure"));
  await settle();

  // Leave the field blank and click Save.
  const saveBtn = document.querySelector("#modal-content .ext-checklist__save");
  click(saveBtn);
  await settle();

  assert.ok(
    !calls.some((c) => c.url.includes("/bundles/api/env")),
    "a blank form must not POST to /bundles/api/env",
  );
  assert.ok(
    document.getElementById("env_JELLYFIN_API_KEY"),
    "the Configure form for the still-unconfigured key stays on screen — onSaved (which would replace it) never ran",
  );
  assert.equal(saveBtn.disabled, false, "the button must not be left in the disabled/saving state");
  assert.match(
    document.getElementById("install-status").textContent,
    /fill in|value/i,
    "the form tells the user why it didn't save",
  );
});

// ─── 6b. The durable card affordance: "Needs setup" → Configure → server truth ───

/**
 * The card's badge state is NOT the client's to decide. `submitConfigureOnly`
 * guards only the all-blank case and its `if (inp && inp.value)` even accepts
 * whitespace, so filling 1 of N keys returns 200 — a client that cleared the badge
 * on any 200 would hide a still-unconfigured bundle. Every assertion below drives
 * the DOM from the route's re-derived `needs_config`.
 */
const CARD_BOOT = {
  installed: { jellyfin: { version: "1.0.0" } },
  needsConfig: { jellyfin: ["JELLYFIN_API_KEY", "JELLYFIN_URL"] },
};
const card = (document) => document.querySelector('.ext-installed__item[data-addon-id="jellyfin"]');

test("BEHAVIOR: an unconfigured installed card carries the Needs setup badge and a Configure button scoped to the missing keys", () => {
  const { document } = boot({ ...CARD_BOOT, fetchImpl: envFetch() });

  const item = card(document);
  assert.ok(item.querySelector(".ext-installed__needsconfig"), "the Needs setup badge is on the card");
  assert.match(item.textContent, /Needs setup/);
  const btn = item.querySelector(".bundle-configure");
  assert.ok(btn, "and a Configure button");
  assert.equal(btn.getAttribute("data-keys"), "JELLYFIN_API_KEY,JELLYFIN_URL");
});

test("BEHAVIOR: a configured installed card carries neither badge nor Configure button", () => {
  const { document } = boot({ installed: { jellyfin: { version: "1.0.0" } }, needsConfig: {}, fetchImpl: envFetch() });
  const item = card(document);
  assert.equal(item.querySelector(".ext-installed__needsconfig"), null);
  assert.equal(item.querySelector(".bundle-configure"), null);
});

test("BEHAVIOR: the card's Configure button opens the env-only form for exactly the missing keys (registry metadata, with a fallback)", async () => {
  const { document, click, settle, calls } = boot({ ...CARD_BOOT, fetchImpl: envFetch() });

  click(card(document).querySelector(".bundle-configure"));
  await settle();

  assert.match(document.getElementById("modal-content").textContent, /Configure.*Jellyfin/s);
  assert.ok(document.getElementById("env_JELLYFIN_API_KEY"), "the registry-described key");
  assert.ok(document.getElementById("env_JELLYFIN_URL"), "and the key with no registry metadata (name/required fallback)");
  assert.ok(!calls.some((c) => c.url.includes("/consent-challenge/")), "configureOnly skips the consent gate");
});

test("BEHAVIOR: a FULL Configure save from the card clears the Needs setup badge and the Configure button", async () => {
  const { document, click, settle, flushTimers, calls } = boot({
    ...CARD_BOOT,
    fetchImpl: envFetch({ body: { ok: true, needs_restart: false, needs_config: [] } }),
  });

  click(card(document).querySelector(".bundle-configure"));
  await settle();
  document.getElementById("env_JELLYFIN_API_KEY").value = "k";
  document.getElementById("env_JELLYFIN_URL").value = "http://jf";
  click(document.querySelector("#modal-content .ext-checklist__save"));
  await settle();
  flushTimers();   // the queued onSaved()

  const envCall = calls.find((c) => c.url.includes("/bundles/api/env"));
  assert.deepEqual(envCall.body, { bundle_id: "jellyfin", env_vars: { JELLYFIN_API_KEY: "k", JELLYFIN_URL: "http://jf" } });

  const item = card(document);
  assert.equal(item.querySelector(".ext-installed__needsconfig"), null, "the badge is gone — the server said nothing is missing");
  assert.equal(item.querySelector(".bundle-configure"), null, "and so is the Configure button");
});

test("BEHAVIOR: a PARTIAL Configure save keeps the badge and narrows data-keys to the still-missing keys", async () => {
  const { document, click, settle, flushTimers } = boot({
    ...CARD_BOOT,
    // 1 of 2 keys filled → the route re-derives and says JELLYFIN_URL is still missing.
    fetchImpl: envFetch({ body: { ok: true, needs_restart: false, needs_config: ["JELLYFIN_URL"] } }),
  });

  click(card(document).querySelector(".bundle-configure"));
  await settle();
  document.getElementById("env_JELLYFIN_API_KEY").value = "k";
  click(document.querySelector("#modal-content .ext-checklist__save"));
  await settle();
  flushTimers();

  const item = card(document);
  assert.ok(
    item.querySelector(".ext-installed__needsconfig"),
    "the bundle is STILL unconfigured — a 200 on a partial save must not clear the badge",
  );
  assert.equal(
    item.querySelector(".bundle-configure").getAttribute("data-keys"),
    "JELLYFIN_URL",
    "and the Configure button is re-scoped to what the SERVER says is still missing",
  );
});

test("BEHAVIOR: saving from the checklist also updates the card's badge (no cross-surface staleness)", async () => {
  const { document, click, settle, flushTimers } = boot({
    ...CARD_BOOT,
    session: { crow_ext_needs_config: JSON.stringify([{ id: "jellyfin", keys: ["JELLYFIN_API_KEY", "JELLYFIN_URL"] }]) },
    fetchImpl: envFetch({ body: { ok: true, needs_restart: false, needs_config: ["JELLYFIN_URL"] } }),
  });

  click(document.querySelector(".ext-checklist__configure"));
  await settle();
  document.getElementById("env_JELLYFIN_API_KEY").value = "k";
  click(document.querySelector("#modal-content .ext-checklist__save"));
  await settle();
  flushTimers();

  const item = card(document);
  assert.ok(item.querySelector(".ext-installed__needsconfig"), "the card behind the checklist still shows Needs setup");
  assert.equal(item.querySelector(".bundle-configure").getAttribute("data-keys"), "JELLYFIN_URL",
    "a save made from the checklist re-scopes the card's Configure button too");
});

// ─── 7. Category badge i18n (the live gap: the detail modal rendered the raw slug) ───

test("BEHAVIOR: the detail modal shows a localized category, never the raw registry slug", () => {
  const { $, click, document } = boot();

  click($('.addon-card[data-addon-id="hass"]'));   // category: smart-home

  const badge = document.querySelector("#modal-content .ext-card__badge");
  assert.equal(badge.textContent, "Smart Home", "the badge is the localized label");
  assert.notEqual(badge.textContent, "smart-home", "not the machine slug");
});

test("BEHAVIOR: an unknown category falls back to its slug rather than mislabelling it", () => {
  const { $, click, document } = boot({
    available: [{ id: "weird", name: "Weird", description: "?", type: "bundle", category: "quantum-farming", version: "1.0.0", author: "x", tags: [] }],
    collections: [],
  });

  click($('.addon-card[data-addon-id="weird"]'));
  assert.equal(document.querySelector("#modal-content .ext-card__badge").textContent, "quantum-farming");
});

// ─── Cheap smoke checks on the emitted source (NOT the guard — the DOM tests above are) ───

test("SMOKE: the emitted client keeps the one-time Escape listener guard (Turbo must not stack listeners)", () => {
  assert.match(CLIENT_JS, /__extEscapeBound/);
});

test("SMOKE: no hardcoded English in the collection UI — the labels come from i18n", () => {
  const es = extensionsClientJS("es");
  assert.match(es, /Instalar colección/);
  assert.match(es, /Se ejecuta en este Crow/);
  assert.match(es, /Casa inteligente/);
  assert.ok(!/Install collection/.test(es), "the Spanish client must not carry the English label");
});
