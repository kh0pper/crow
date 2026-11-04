/**
 * The "What needs me" widget API (widgets phase 1): the JSON summary BOTH renderers draw (the in-Crow
 * widget on For You, and the Android home-screen widget) and the one act endpoint that answers an item
 * in place.
 *
 *   GET  /dashboard/widgets-api/needs-me       the NeedsMeSummary JSON (widgets/needs-me.js)
 *   POST /dashboard/widgets-api/needs-me/act   { key, action, nonce } → { ok: true, summary }
 *   POST /dashboard/widgets-api/push           { on: boolean } → { ok: true, on }
 *   GET  /dashboard/widgets-api/bird           "your bird" (widgets phase 3): { mood, steps, steps_goal, walked, svg }
 *   GET  /dashboard/widgets-api/cell           one widget's cell body for a grid cell the page did
 *                                              NOT load with it: { id, html } (widgets/grid-client.js
 *                                              fetches it the moment the device shows the cell)
 *
 * YOUR BIRD: the phone has no SVG decoder, so the gateway hands it the drawing itself — the SAME
 * string the profile picture is made of (servers/sharing/profile-avatar.js renderBirdSvg, over
 * readPortrait: the active bird, its current decayed mood, its outfit and the walked-today badge),
 * plus today's steps read the way For You's Today card reads them (for-you/today.js rambleState: the
 * installed bundle's pet.petState / steps.stepsState, never an HTTP self-call). No Ramble installed
 * is 404 { code: "no_ramble" }; an installed Ramble with no hatched bird is 404 { code: "no_bird" } —
 * the app tells those two from a sign-in and falls back to the app icon.
 *
 * THE PUSH SWITCH: the silent, content-free push (widgets/changed.js) only goes out while the
 * LOCAL-scope setting widgets_push is "on", and only the app that draws the widget flips it — the
 * Android provider calls it when the first widget is added and when the last one is removed. Until
 * then, an older phone app would turn every silent ping into a blank notification.
 *
 * MOUNT: inside dashboard/index.js beside voiceHandoffsRouter, i.e. after dashboardAuth AND after the
 * real csrfMiddleware, so a state-changing act carries the crow_csrf double-submit token (header
 * X-Crow-Csrf, or a _csrf body field). The router also installs dashboardAuth on its own prefix, so it
 * stays closed wherever it is mounted. Every response is JSON, no-store, and never framed.
 *
 * WHO: the owner at THIS instance's own sign-in, and nobody else (isLocalPasswordSessionOn): an
 * SSO-minted session, one minted by a login from this machine itself, a plain-scope session or a
 * peer-signed call gets 404 on the summary and on the act alike, with nothing decided.
 *
 * ACT, WITH NO NEW AUTHORITY: the tap re-reads the item and recomputes its nonce (itemNonce, Task 1)
 * BEFORE any service is called, so a widget drawn before a change on another device can never decide
 * twice. A nonce that no longer matches is 409 { code: "stale" }; the services are exactly the ones the
 * dashboard already calls — decideOption (board/decision-service.js), decideResult
 * (board/result-service.js) and the hand-off core's confirm (voice/handoff.js, via "phone") — and every
 * write is attributed to DASHBOARD_ACTOR, as on routes/bot-board-api.js and routes/voice-handoffs.js.
 * A 409 from a service (already answered elsewhere, archived, expired, held by a bot) is reported as
 * stale too: the item changed, so the client refreshes instead of retrying.
 *
 * PLANS ARE NEVER APPROVED INLINE (the operator's ruling, 2026-11-03): a plan item has no actions, so a
 * plan key with any action is 400 { code: "bad_action" } and the card link is the only way through.
 *
 * not_now: a four-hour snooze in the LOCAL-scope setting widgets_snoozed, stored as { [key]: untilMs }
 * (never synced to paired instances, and it never touches the card).
 */
import { WIDGETS_PUSH_KEY, notifyWidgetsChanged } from "../widgets/changed.js";
import { Router } from "express";

import { createDbClient } from "../../db.js";
import { tasksDbPath } from "../../../scripts/pi-bots/instance-paths.mjs";
import { activeProjectWhere } from "../../shared/shell-items.js";
import { getHandoffCore } from "../voice/handoff.js";
import { isLocalPasswordSessionOn } from "../dashboard/local-session.js";
import { parseCookies } from "../dashboard/auth.js";
import { readPortrait, renderBirdSvg } from "../../sharing/profile-avatar.js";
import { rambleState } from "../for-you/today.js";
import { resolveCrowHome } from "../../shared/crow-home.js";
import { SUPPORTED_LANGS } from "../dashboard/shared/i18n.js";
import { readSetting, writeSetting } from "../dashboard/settings/registry.js";
import { findNeedsMeItem, loadNeedsMe } from "../widgets/needs-me.js";
import { loadWidgets, widgetsForPage } from "../widgets/registry.js";
import { cellBodyHtml } from "../widgets/grid-html.js";
import { forYouContext } from "../dashboard/panels/for-you.js";
import { forYouEnabled } from "../for-you/flag.js";
import { readForYouSettings } from "../for-you/settings.js";
import { instanceZone } from "../../shared/schedule-store.js";
import { decideOption } from "../board/decision-service.js";
import { decideResult } from "../board/result-service.js";
import { isEnabledBot } from "../board/bot-lookup.js";
import { jsonError } from "./_error.js";

const P = "/dashboard/widgets-api";
const SUMMARY = `${P}/needs-me`;
const ACT = `${P}/needs-me/act`;
const PUSH = `${P}/push`;
const BIRD = `${P}/bird`;
const CELL = `${P}/cell`;

/**
 * The two pages that draw the widget grid, and so the two a cell may be fetched for. Both are For
 * You's own surface: they share its enable flag and its owner gate.
 */
const CELL_PAGES = new Set(["for-you", "widgets"]);

/** The local-scope setting the Not-now snoozes live in, and how long one lasts. */
export const WIDGETS_SNOOZED_KEY = "widgets_snoozed";
export const SNOOZE_MS = 4 * 60 * 60 * 1000;

/** Every dashboard-originated write is attributed to this actor (provenance; the brief-pinned shape). */
const DASHBOARD_ACTOR = Object.freeze({ kind: "human", id: null, jobId: null });

/** The three moods the engine draws (bird-svg.cjs MOODS): anything else is the portrait's own. */
const BIRD_MOODS = new Set(["happy", "tired", "alarmed"]);

// Item keys (widgets/needs-me.js owns their shape): the id spaces the services need back.
const CARD_KEY = /^card:(\d+):(?:decision|plan:(\d+)|result:(\d+))$/;
const HANDOFF_KEY = /^handoff:([A-Za-z0-9._-]{1,80})$/;

/** A stale item, in the shape every renderer's refresh path already expects. */
const stale = (message) => ({ http: 409, error: message, code: "stale" });

/**
 * A service-layer {code, http} error as the JSON this API speaks: 409s keep their reason text and
 * report code "stale" (the item the widget drew is not answerable any more), anything else keeps its
 * own status and code, and an unexpected error is a 500.
 */
function serviceError(res, e) {
  if (e && e.http === 409) return res.status(409).json({ reason: e.message, code: "stale" });
  if (e && e.http) return jsonError(res, e.http, e.message, e.code ? { code: e.code } : undefined);
  // The detail stays in the route's own log line: SQL or path text never reaches the widget.
  return jsonError(res, 500, "The action failed");
}

/**
 * The router. `core` is the shared hand-off core (tests inject a fake one) and `openDb` mints the
 * request's crow.db client; `now` (ms) is the clock, injected where a test needs a later hour.
 */
export function widgetsRouter(dashboardAuth, { core = getHandoffCore(), openDb = () => createDbClient(), now = Date.now } = {}) {
  const router = Router();
  router.use(P, dashboardAuth);

  // This list names the operator's cards: never cached, never framed.
  router.use(P, (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  // The summary's hand-off source is the core's own store, so what the act confirms is what was drawn.
  const handoffStore = core && core.store && typeof core.store.openRows === "function" ? core.store : undefined;

  const langOf = (req) => {
    const lang = parseCookies(req).crow_lang;
    return SUPPORTED_LANGS.includes(lang) ? lang : "en";
  };

  /** The live projects the Board lane's names and cache key come from; a failure costs the names. */
  async function liveProjects(db) {
    try {
      return (await db.execute({
        sql: `SELECT id, name, slug FROM project_spaces WHERE ${activeProjectWhere()} ORDER BY id`,
        args: [],
      })).rows || [];
    } catch {
      return [];
    }
  }

  /** A tasks.db client, or null: a missing store costs the Board's lines, never the whole summary. */
  function openTasks(path) {
    try {
      return createDbClient(path);
    } catch (err) {
      console.warn(`[widgets] tasks store unavailable: ${err && err.message}`);
      return null;
    }
  }

  async function summaryArgs(db, req) {
    return {
      now: Number(now()),
      projects: await liveProjects(db),
      handoffStore,
      lang: langOf(req),
      tasksDbPath: tasksDbPath(),
    };
  }

  // `fresh` reads the Board lane without For You's 45 s cache: an act must see what it just changed.
  async function loadSummary(db, req, snoozed, fresh = false) {
    const args = await summaryArgs(db, req);
    const tdb = openTasks(args.tasksDbPath);
    try {
      return await loadNeedsMe(db, tdb, { ...args, snoozed, fresh });
    } finally {
      if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
    }
  }

  /** The one item a tap names, as it is NOW (findNeedsMeItem re-reads it and recomputes its nonce). */
  async function readItem(db, req, key) {
    const args = await summaryArgs(db, req);
    const tdb = openTasks(args.tasksDbPath);
    try {
      return await findNeedsMeItem(db, tdb, key, { ...args, fresh: true });
    } finally {
      if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
    }
  }

  /** Stored snoozes, as { [key]: untilMs } (a malformed setting reads as none). */
  async function readSnoozes(db) {
    let raw = null;
    try { raw = JSON.parse((await readSetting(db, WIDGETS_SNOOZED_KEY)) || "null"); } catch { raw = null; }
    const out = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, until] of Object.entries(raw)) {
        const ms = Number(until);
        if (Number.isFinite(ms)) out[key] = ms;
      }
    }
    return out;
  }

  /** Not now: hide the item for SNOOZE_MS, local scope only. A run-out entry is dropped, never kept. */
  async function snooze(db, key) {
    const at = Number(now());
    const kept = Object.fromEntries(Object.entries(await readSnoozes(db)).filter(([, until]) => until > at));
    kept[key] = at + SNOOZE_MS;
    await writeSetting(db, WIDGETS_SNOOZED_KEY, JSON.stringify(kept), { scope: "local" });
  }

  /**
   * The refusal for a key this widget could have drawn but no longer draws — the card was answered on
   * another device, moved or archived; the hand-off was decided or lapsed — is 409 stale (refresh,
   * never retry). A key it never draws, or one that never existed, is a 404.
   */
  async function missingItem(db, key) {
    const card = CARD_KEY.exec(key);
    if (card) {
      const tdb = openTasks(tasksDbPath());
      try {
        const row = tdb && (await tdb.execute({
          sql: "SELECT 1 AS ok FROM tasks_items WHERE id=? AND board_id IS NULL",
          args: [Number(card[1])],
        })).rows[0];
        if (row) return stale("This item changed since the widget drew it");
      } catch { /* unreadable store: the key is unknown */ }
      finally {
        if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
      }
      return { http: 404, error: "No such item" };
    }
    if (HANDOFF_KEY.test(key) && core.store && typeof core.store.get === "function") {
      const id = HANDOFF_KEY.exec(key)[1];
      try {
        if (await core.store.get(db, id)) return stale("This hand-off changed since the widget drew it");
      } catch { /* the store could not answer: fall through to 404 */ }
    }
    return { http: 404, error: "No such item" };
  }

  /**
   * Run the action the item offers. Returns a refusal ({ http, error, code }) when the item's state has
   * moved on, or null once the action landed. Anything unexpected propagates to serviceError.
   */
  async function act(db, item, action) {
    if (action === "not_now") {
      await snooze(db, item.key);
      return null;
    }

    if (item.kind === "decision") {
      const m = CARD_KEY.exec(item.key);
      const index = Number(String(action).replace(/^option:/, ""));
      if (!m || !Number.isInteger(index)) return { http: 400, error: "That action is not offered by this item", code: "bad_action" };
      const tdb = openTasks(tasksDbPath());
      if (!tdb) return { http: 404, error: "No such item" };
      try {
        await decideOption(tdb, db, Number(m[1]), { index }, DASHBOARD_ACTOR,
          { isEnabledBot: (botId) => isEnabledBot(db, botId) });
      } catch (e) {
        // Already answered on another device, archived, expired, closed or held by a bot: the item
        // the widget drew is not answerable now. Never a retry.
        if (e && e.http === 409) return stale(e.message);
        throw e;
      } finally {
        try { tdb.close(); } catch { /* already closed */ }
      }
      return null;
    }

    if (item.kind === "result") {
      const m = CARD_KEY.exec(item.key);
      if (!m || m[3] == null) return { http: 400, error: "That action is not offered by this item", code: "bad_action" };
      const tdb = openTasks(tasksDbPath());
      if (!tdb) return { http: 404, error: "No such item" };
      try {
        // Accept = approve; the card is NOT moved (decideResult's own contract, as on the Board).
        await decideResult(tdb, Number(m[1]), Number(m[3]), "approved", DASHBOARD_ACTOR, "widget", { newestOnly: true });
      } catch (e) {
        if (e && e.http === 409) return stale(e.message);
        throw e;
      } finally {
        try { tdb.close(); } catch { /* already closed */ }
      }
      return null;
    }

    if (item.kind === "handoff") {
      const m = HANDOFF_KEY.exec(item.key);
      if (!m) return { http: 404, error: "No such item" };
      const r = await core.confirm(db, m[1], action === "yes" ? "yes" : "no", "phone");
      const status = r && r.status;
      if (status === "none" || status === "wrong_kind") return { http: 404, error: "No such hand-off" };
      if (status === "bad_decision") return { http: 400, error: "That action is not offered by this item", code: "bad_action" };
      if (status === "already" || status === "expired") return stale("This hand-off changed since the widget drew it");
      return null;
    }

    // A plan (or anything else with no actions): inline approval does not exist here.
    return { http: 400, error: "That action is not offered by this item", code: "bad_action" };
  }

  router.get(SUMMARY, async (req, res) => {
    const db = openDb();
    try {
      if (!(await isLocalPasswordSessionOn(db, req))) return jsonError(res, 404, "Not found");
      return res.json(await loadSummary(db, req, await readSnoozes(db)));
    } catch (err) {
      console.warn(`[widgets] summary: ${err && err.message}`);
      return jsonError(res, 500, "The summary could not be built");
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  router.post(ACT, async (req, res) => {
    const db = openDb();
    try {
      if (!(await isLocalPasswordSessionOn(db, req))) return jsonError(res, 404, "Not found");
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const key = typeof body.key === "string" ? body.key : "";
      const action = typeof body.action === "string" ? body.action : "";
      const nonce = typeof body.nonce === "string" ? body.nonce : "";
      if (!key || !action) return jsonError(res, 400, "key and action are required", { code: "bad_action" });
      if (key.length > 200 || action.length > 64 || nonce.length > 64) return jsonError(res, 400, "That action is not offered by this item", { code: "bad_action" });

      // The re-read and the nonce check come FIRST: nothing is decided from a stale drawing.
      const item = await readItem(db, req, key);
      if (!item) {
        const refused = await missingItem(db, key);
        return jsonError(res, refused.http, refused.error, refused.code ? { code: refused.code } : undefined);
      }
      if (nonce !== item.nonce) return jsonError(res, 409, "This item changed since the widget drew it", { code: "stale" });
      if (!item.actions.some((a) => a.id === action)) {
        return jsonError(res, 400, "That action is not offered by this item", { code: "bad_action" });
      }

      const refused = await act(db, item, action);
      if (refused) return jsonError(res, refused.http, refused.error, refused.code ? { code: refused.code } : undefined);
      notifyWidgetsChanged(); // other devices' widgets re-read too
      return res.json({ ok: true, summary: await loadSummary(db, req, await readSnoozes(db), true) });
    } catch (err) {
      console.warn(`[widgets] act: ${err && err.message}`);
      return serviceError(res, err);
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  // The silent push on/off, flipped by the Android app when the widget comes and goes. Local scope:
  // whether THIS instance pushes to THIS phone is not a setting any paired peer inherits.
  router.post(PUSH, async (req, res) => {
    const db = openDb();
    try {
      if (!(await isLocalPasswordSessionOn(db, req))) return jsonError(res, 404, "Not found");
      const body = req.body && typeof req.body === "object" ? req.body : {};
      if (typeof body.on !== "boolean") return jsonError(res, 400, "on must be true or false", { code: "bad_request" });
      await writeSetting(db, WIDGETS_PUSH_KEY, body.on ? "on" : "off", { scope: "local" });
      return res.json({ ok: true, on: body.on });
    } catch (err) {
      console.warn(`[widgets] push: ${err && err.message}`);
      return jsonError(res, 500, "The action failed");
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  // "Your bird" (widgets phase 3): the drawing, the mood and today's steps, for the owner's own
  // phone. Only paths, no HTML and no data URI — the app renders the SVG itself.
  router.get(BIRD, async (req, res) => {
    const db = openDb();
    try {
      if (!(await isLocalPasswordSessionOn(db, req))) return jsonError(res, 404, "Not found");
      const at = Number(now());
      const { installed, state } = await rambleState(db, { crowHome: resolveCrowHome(), now: at });
      if (!installed) return jsonError(res, 404, "Ramble is not installed", { code: "no_ramble" });
      // The same portrait the profile picture is drawn from: bird, decayed mood, outfit, walk badge.
      const bird = await readPortrait(db, { now: at });
      if (!bird) return jsonError(res, 404, "There is no bird yet", { code: "no_bird" });
      // Ramble's own read is the same decay-on-read the portrait makes, so it names the same mood; when
      // it does, the DRAWING takes it too — the word and the face never disagree.
      const reported = state && typeof state.mood === "string" ? state.mood.trim() : "";
      const mood = BIRD_MOODS.has(reported) ? reported : bird.mood;

      const svg = renderBirdSvg({ ...bird, mood });
      if (!svg) return jsonError(res, 404, "There is no bird yet", { code: "no_bird" });

      const steps = state && state.steps ? Number(state.steps.today) : 0;
      const goal = state && state.steps ? Number(state.steps.goal) : 0;
      return res.json({
        mood: String(mood || "happy"),
        steps: Number.isFinite(steps) ? steps : 0,
        steps_goal: Number.isFinite(goal) ? goal : 0,
        walked: bird.walked === true,
        svg,
      });
    } catch (err) {
      console.warn(`[widgets] bird: ${err && err.message}`);
      return jsonError(res, 500, "The bird could not be drawn");
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  // One widget's cell body, for a device that has just shown a cell the page did not load with it:
  // the grid's lazy fill (widgets/grid-client.js). The page the cell belongs to decides the offer —
  // its own enable flag (forYouEnabled, the gate panels/for-you.js and panels/widgets.js apply) and
  // its own widget list (widgetsForPage: the For You switches, the installed add-ons and their
  // availability all apply there, and nothing is ever looked up any other way). The body is rendered
  // by the same function the page draws a cell with, so a fetched cell and a drawn one cannot
  // disagree; a loader that threw is that widget's own error line, never a 500.
  router.get(CELL, async (req, res) => {
    const db = openDb();
    try {
      if (!(await isLocalPasswordSessionOn(db, req))) return jsonError(res, 404, "Not found");
      const page = typeof req.query.page === "string" ? req.query.page : "";
      if (!CELL_PAGES.has(page)) return jsonError(res, 404, "Not found");
      if (!forYouEnabled()) return jsonError(res, 404, "Not found");
      const id = typeof req.query.id === "string" ? req.query.id : "";
      const settings = await readForYouSettings(db);
      const crowHome = resolveCrowHome();
      const widget = widgetsForPage(page, { settings, crowHome }).find((w) => w.id === id);
      if (!widget) return jsonError(res, 404, "Not found", { code: "no_widget" });
      const at = Number(now());
      let tz;
      try { tz = await instanceZone(db); } catch { tz = undefined; }
      const lang = langOf(req);
      const context = forYouContext(db, { settings, crowHome, now: at, tz, lang });
      const [entry] = await loadWidgets([widget], context);
      // "" means the widget has nothing to show: the device draws the grid's own nothing line.
      return res.json({ id: widget.id, html: cellBodyHtml(entry, lang, at) });
    } catch (err) {
      console.warn(`[widgets] cell: ${err && err.message}`);
      return jsonError(res, 500, "The widget could not be drawn");
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  return router;
}

export default widgetsRouter;