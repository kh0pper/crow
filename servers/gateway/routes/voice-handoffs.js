/**
 * The phone confirm page (voice hand-off PR 4, Task 4.2). A hand-off asked on a kiosk (a shared display) is
 * never confirmed by a voice in the room: it becomes an `awaiting_phone` row and a push to the operator's
 * phone (voice/handoff.js proposeToPhone), and the push opens this page.
 *
 *   GET  /dashboard/voice/handoffs/:id          the display, bot, task, when, the asked words and the status;
 *                                               Confirm / Decline only while the row can still be decided here
 *   POST /dashboard/voice/handoffs/:id/decide   { decision: "confirm" | "decline", _csrf } → 303 back to the GET
 *
 * MOUNT: inside dashboard/index.js after dashboardAuth and the real csrfMiddleware (the perch-api siblings'
 * slot), and the router installs dashboardAuth on its own prefix too, so it is closed wherever it is mounted.
 * The GET never changes state; only the POST decides.
 *
 * WHO MAY DECIDE: the owner at this instance's own sign-in. A session minted by a paired peer's single sign-on
 * (scopes "dashboard sso src:<peer>") or a signed peer call gets 403: a peer's operator never confirms work
 * here. The page refuses to be framed (X-Frame-Options DENY, CSP frame-ancestors 'none'): it carries a one-tap
 * Confirm.
 *
 * WHAT MAY BE DECIDED [rv1 C4]: before any core call the id must be a hand-off id, the decision exactly
 * "confirm" or "decline" (else 400), and the row a kiosk's live `awaiting_phone` row (expires_at > now). The
 * dispatch is on kind: a `handoff` row → core.confirm(…, "phone"), whose CAS from awaiting_phone with the TTL
 * is the final word; a `stop` row → core.decideStop (PR 5, voice/handoff-stop.js: it checks the target is the
 * same kiosk's and bot's hand-off before any write, then runs core.stop, and never creates a card); a build
 * without decideStop gives a stop row 404. A row already decided or expired is simply shown again (303), so a
 * double tap creates nothing.
 *
 * One crow.db client per request, closed in finally. The core is the process singleton the voice turn uses
 * (getHandoffCore: the same store, in-flight set and clock), so a confirm here and a sweep agree.
 */
import { Router } from "express";
import { createDbClient } from "../../db.js";
import { getHandoffCore, botName } from "../voice/handoff.js";
import { cardDrawerHref } from "../board/card-link.js";
import { parseCookies } from "../dashboard/auth.js";
import { isLocalPasswordSessionOn } from "../dashboard/local-session.js";
import { csrfInput } from "../dashboard/shared/csrf.js";
import { escapeHtml } from "../dashboard/shared/components.js";
import { t, fill, SUPPORTED_LANGS } from "../dashboard/shared/i18n.js";
import { readSetting } from "../dashboard/settings/registry.js";

const P = "/dashboard/voice/handoffs";
const ID_RE = /^vh-[0-9a-f]{16}$/;
const DECISIONS = { confirm: "yes", decline: "no" };
/** Confirm's statuses that are the caller's mistake, not a state to show (P9). */
const NOT_FOUND = new Set(["none", "wrong_kind"]);
/** Failed details with their own reason line; any other detail gets the generic one. */
const FAILED_REASONS = new Set(["not_sent", "not_allowed", "interrupted", "session_ended_no_result"]);

/** The headers every response here carries: never framed, never cached. */
function guardHeaders(req, res, next) {
  res.setHeader("X-Frame-Options", "DENY");
  const csp = String(res.getHeader("Content-Security-Policy") || "");
  const kept = csp.split(";").map((d) => d.trim()).filter((d) => d && !/^frame-ancestors\b/i.test(d));
  res.setHeader("Content-Security-Policy", [...kept, "frame-ancestors 'none'"].join("; "));
  res.setHeader("Cache-Control", "no-store");
  next();
}

/** The page's language: the row's (the language the hand-off was asked in, as its push title), else the
 * dashboard's (the setting, else the login pages' cookie), "en" by default. */
async function pageLang(db, req, row = null) {
  if (row && SUPPORTED_LANGS.includes(row.lang)) return row.lang;
  let lang = null;
  try { lang = await readSetting(db, "language"); } catch { /* no settings table: the cookie decides */ }
  if (!SUPPORTED_LANGS.includes(lang)) lang = parseCookies(req).crow_lang;
  return SUPPORTED_LANGS.includes(lang) ? lang : "en";
}

const live = (row, now) => row.status === "awaiting_phone" && Number(row.expires_at) > now;

/** The row is one this page may decide: a kiosk's live phone confirmation, of a kind this build can decide. */
function decidable(core, row, now) {
  if (row.surface !== "kiosk" || !live(row, now)) return false;
  if (row.kind === "handoff") return true;
  return row.kind === "stop" && typeof core.decideStop === "function";
}

function formatTime(ms, lang, opts) {
  try { return new Intl.DateTimeFormat(lang, opts).format(new Date(Number(ms))); }
  catch { return new Date(Number(ms)).toISOString(); }
}

/** The status line for a row that is not waiting on this page. */
function statusLine(row, now, lang, vars) {
  const status = row.status === "awaiting_phone" && !live(row, now) ? "expired" : row.status;
  // A stop row's lines are its own (P26): a stop in progress, one that expired or one whose target had already
  // ended never read as a hand-off's "nothing was started".
  if (row.kind === "stop") {
    // done carries core.stop's status as its detail: a stop still landing (pending_start, stopping) is not "Stopped".
    if (status === "done" && (row.detail === "pending_start" || row.detail === "stopping")) return fill(t(`voiceHandoff.stopStatus.done_${row.detail}`, lang), vars);
    if (status === "failed" && (row.detail === "already" || row.detail === "not_sent")) return fill(t(`voiceHandoff.stopStatus.${row.detail}`, lang), vars);
    if (["done", "declined", "failed", "starting", "expired"].includes(status)) return fill(t(`voiceHandoff.stopStatus.${status}`, lang), vars);
  }
  if (status === "failed" && FAILED_REASONS.has(row.detail)) return fill(t(`voiceHandoff.failed.${row.detail}`, lang), vars);
  // A failed row that has a card ran and could not finish (the bot's own failure report, PR 5): its detail is
  // the bot's summary, not a reason code, and "nothing was started" would be false (P26).
  if (status === "failed" && row.card_id != null) return fill(t("voiceHandoff.failed.finish", lang), vars);
  if (status === "awaiting_phone") return t("voiceHandoff.notHere", lang);
  const key = `voiceHandoff.status.${status}`;
  const line = t(key, lang);
  return line === key ? "" : fill(line, vars);
}

function page(lang, title, body) {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
:root { --bg: #f7f6f3; --card: #ffffff; --text: #1d1c1a; --muted: #6b6862; --line: #e3e0da; --accent: #2b5fd9; --accent-text: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --card: #201f1d; --text: #ecebe8; --muted: #a29f98; --line: #34322f; --accent: #7aa2ff; --accent-text: #0d0d0c; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 32rem; margin: 0 auto; padding: 24px 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 20px; }
h1 { font-size: 1.3rem; line-height: 1.3; margin: 0 0 6px; overflow-wrap: anywhere; }
.meta, .label { color: var(--muted); font-size: .9rem; }
.label { margin: 16px 0 2px; }
.task, .asked { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.status { margin: 18px 0 0; font-weight: 600; }
form { display: flex; gap: 10px; margin-top: 22px; }
button { flex: 1; min-height: 48px; border-radius: 10px; font: inherit; font-weight: 600; cursor: pointer; border: 1px solid var(--line); background: var(--card); color: var(--text); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
a { color: var(--accent); }
.link { display: inline-block; margin-top: 14px; }
</style>
</head>
<body><main><div class="card">${body}</div></main></body>
</html>`;
}

function message(res, code, lang, key) {
  res.status(code).type("html").send(page(lang, t("voiceHandoff.pageTitle", lang), `<p class="status">${escapeHtml(t(key, lang))}</p>`));
}

async function renderRow(req, db, core, row, lang) {
  const now = core.now();
  const bot = await botName(db, row.bot_id);
  const display = (typeof row.device_name === "string" && row.device_name.trim()) || t("voiceHandoff.displayFallback", lang);
  const vars = { bot };
  const stop = row.kind === "stop";
  const heading = fill(t(stop ? "voiceHandoff.stopHeading" : "voiceHandoff.heading", lang), vars);
  const when = formatTime(row.created_at, lang, { dateStyle: "medium", timeStyle: "short" });
  let body = `<h1>${escapeHtml(heading)}</h1>
<p class="meta">${escapeHtml(fill(t("voiceHandoff.from", lang), { display, when }))}</p>
<p class="label">${escapeHtml(t("voiceHandoff.task", lang))}</p>
<p class="task">${escapeHtml(row.task)}</p>`;
  if (row.asked != null && String(row.asked).trim()) {
    body += `
<p class="label">${escapeHtml(t("voiceHandoff.asked", lang))}</p>
<p class="asked">“${escapeHtml(row.asked)}”</p>`;
  }
  if (decidable(core, row, now)) {
    if (await isLocalPasswordSessionOn(db, req)) {
      const until = formatTime(row.expires_at, lang, { timeStyle: "short" });
      body += `
<p class="status">${escapeHtml(fill(t("voiceHandoff.waiting", lang), { time: until }))}</p>
<form method="post" action="${P}/${row.id}/decide" data-turbo="false">
${csrfInput(req)}
<button class="primary" type="submit" name="decision" value="confirm">${escapeHtml(t(stop ? "voiceHandoff.stopConfirm" : "voiceHandoff.confirm", lang))}</button>
<button type="submit" name="decision" value="decline">${escapeHtml(t(stop ? "voiceHandoff.stopDecline" : "voiceHandoff.decline", lang))}</button>
</form>`;
    } else {
      body += `
<p class="status">${escapeHtml(t("voiceHandoff.notOwner", lang))}</p>`;
    }
  } else {
    const line = statusLine(row, now, lang, vars);
    if (line) body += `
<p class="status">${escapeHtml(line)}</p>`;
    const href = row.card_id != null ? await cardDrawerHref(db, row.card_id).catch(() => null) : null;
    if (href) body += `
<a class="link" href="${escapeHtml(href)}">${escapeHtml(t("voiceHandoff.openCard", lang))}</a>`;
  }
  return page(lang, t("voiceHandoff.pageTitle", lang), body);
}

/**
 * The router. `core` is the shared hand-off core (tests inject one with a fake clock); `openDb` mints the
 * request's crow.db client.
 */
export function voiceHandoffsRouter(dashboardAuth, { core = getHandoffCore(), openDb = () => createDbClient() } = {}) {
  const router = Router();
  router.use(P, dashboardAuth);
  router.use(P, guardHeaders);

  router.get(`${P}/:id`, async (req, res) => {
    const id = String(req.params.id);
    const db = openDb();
    let lang = "en";
    try {
      lang = await pageLang(db, req);
      const row = ID_RE.test(id) ? await core.store.get(db, id) : null;
      if (!row) return message(res, 404, lang, "voiceHandoff.notFound");
      lang = await pageLang(db, req, row);
      res.type("html").send(await renderRow(req, db, core, row, lang));
    } catch (err) {
      console.warn(`[voice-handoffs] page ${id}: ${err?.message || err}`);
      if (!res.headersSent) message(res, 500, lang, "voiceHandoff.error");
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  router.post(`${P}/:id/decide`, async (req, res) => {
    const id = String(req.params.id);
    const db = openDb();
    let lang = "en";
    try {
      lang = await pageLang(db, req);
      if (!ID_RE.test(id)) return message(res, 404, lang, "voiceHandoff.notFound");
      if (!(await isLocalPasswordSessionOn(db, req))) return message(res, 403, lang, "voiceHandoff.notOwner");
      const raw = req.body && typeof req.body === "object" ? req.body.decision : undefined;
      const decision = typeof raw === "string" && Object.hasOwn(DECISIONS, raw) ? DECISIONS[raw] : null;
      if (!decision) return message(res, 400, lang, "voiceHandoff.badRequest");
      const row = await core.store.get(db, id);
      if (!row || row.surface !== "kiosk" || !["handoff", "stop"].includes(row.kind)) return message(res, 404, lang, "voiceHandoff.notFound");
      if (row.kind === "stop" && typeof core.decideStop !== "function") return message(res, 404, lang, "voiceHandoff.notFound");
      const back = () => res.redirect(303, `${P}/${id}`);
      const now = core.now();
      if (!live(row, now)) {
        // Decided already, or past its TTL: nothing to decide. An awaiting_phone row past expires_at is moved out now.
        if (row.status === "awaiting_phone") await core.store.transition(db, id, ["awaiting_phone"], "expired");
        return back();
      }
      const r = row.kind === "handoff"
        ? await core.confirm(db, id, decision, "phone")
        : await core.decideStop(db, id, decision);
      const status = r && r.status;
      if (status === "bad_decision") return message(res, 400, lang, "voiceHandoff.badRequest");
      if (NOT_FOUND.has(status)) return message(res, 404, lang, "voiceHandoff.notFound");
      return back();
    } catch (err) {
      console.warn(`[voice-handoffs] decide ${id}: ${err?.message || err}`);
      if (!res.headersSent) message(res, 500, lang, "voiceHandoff.error");
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  return router;
}

export default voiceHandoffsRouter;
