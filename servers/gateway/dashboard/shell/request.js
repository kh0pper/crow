/**
 * The shell's per-request wiring (redesign P2, Task 2.3), kept out of
 * dashboard/index.js so that shared file only gains a few call sites:
 *
 *   - resolveRequestMode(req, db): new or classic for THIS device, once per
 *     request (stashed on req.crowMode), and the Set-Cookie to persist it.
 *   - resolveScope(req, db): the one scope rule every shell page uses.
 *     A ?project=<slug|all|unassigned> query wins and rewrites the scope
 *     cookie; otherwise the cookie; otherwise Everything. The cookie holds a
 *     slug, checked against the live-project rule on every read, so an
 *     archived project, a learner profile or another instance's slug falls
 *     back to Everything.
 *   - shellRouter(): POST /dashboard/mode and POST /dashboard/scope. Mounted
 *     by dashboard/index.js AFTER dashboardAuth and csrfMiddleware.
 */
import { Router } from "express";
import { parseCookies, cookieSecureSuffix } from "../auth.js";
import {
  MODE_COOKIE, SCOPE_COOKIE, TRY_COOKIE, cookieName, modeCookie, tryCookie,
  resolveDeviceMode, ensureShellSince, sessionCreatedAt,
} from "./mode.js";
import { tryNewCardHtml } from "./chrome.js";
import { needsYouCounts } from "../panels/board/needs-you.js";
import { getInteractiveEngine } from "../../perch-interactive.js";
import { ACTIVE_PROJECT_WHERE, activeProjects } from "../../../shared/shell-items.js";
import { launcherFor } from "../../apps/launcher.js";

/** The tab a panel lights up. bot-board / artifacts stand in until P3 / P4 register board / make. */
export const TAB_OF = Object.freeze({
  perch: "chat",
  board: "board",
  make: "make",
  "bot-board": "board",
  artifacts: "make",
  "project-home": "chat",
});

const SCOPE_MAX_AGE = 34560000; // 400 days, seconds
const DEFAULT_RETURN = "/dashboard/perch";
const EVERYTHING = Object.freeze({ all: true });

function scopeCookie(value) {
  return `${cookieName(SCOPE_COOKIE)}=${encodeURIComponent(value)}; Path=/; Max-Age=${SCOPE_MAX_AGE}; SameSite=Lax; HttpOnly${cookieSecureSuffix()}`;
}

function decode(v) {
  try { return decodeURIComponent(v); } catch { return ""; }
}

/** "all" | "unassigned" | a slug → the scope it means on this instance, and the value to store. */
async function scopeFromValue(db, value, { slugOnly = false } = {}) {
  const v = typeof value === "string" ? value.trim() : "";
  // slugOnly (a project home's path): the value is a slug and nothing else, no
  // keyword and no id; anything that is no live slug is Everything.
  if (!slugOnly && v === "unassigned") return { scope: { unassigned: true }, value: "unassigned" };
  if (!v || (!slugOnly && v === "all")) return { scope: EVERYTHING, value: "all" };
  try {
    // By slug first; a bare positive integer that is no slug is a project id
    // (older links, e.g. the bot board's ?project=<id>). Either way the
    // stored value is the slug.
    const byId = !slugOnly && /^[1-9]\d*$/.test(v);
    const { rows } = await db.execute({
      sql: `SELECT id, slug FROM project_spaces WHERE (slug = ?${byId ? " OR id = ?" : ""}) AND ${ACTIVE_PROJECT_WHERE}
            ORDER BY (slug = ?) DESC LIMIT 1`,
      args: byId ? [v, Number(v), v] : [v, v],
    });
    const p = rows[0];
    if (p) return { scope: { projectId: Number(p.id), slug: String(p.slug) }, value: String(p.slug) };
  } catch (err) {
    console.warn("[shell] scope lookup failed, using Everything:", err.message);
  }
  return { scope: EVERYTHING, value: "all" };
}

/** The one scope rule: ?project= wins (and updates the cookie), else the cookie, else Everything. */
export async function resolveScope(req, db) {
  const q = req.query ? req.query.project : undefined;
  if (typeof q === "string" && q !== "") {
    const { scope, value } = await scopeFromValue(db, q);
    return { scope, setCookie: scopeCookie(value) };
  }
  const stored = parseCookies(req)[cookieName(SCOPE_COOKIE)];
  if (stored) return { scope: (await scopeFromValue(db, decode(stored))).scope, setCookie: null };
  return { scope: EVERYTHING, setCookie: null };
}

/**
 * New or classic for this device, decided once per request. A device with a
 * valid mode cookie costs no DB read; otherwise the session's age against
 * shell_since decides, and the answer is persisted (Set-Cookie on `res`).
 */
export async function resolveRequestMode(req, res, db) {
  if (req.crowMode) return req.crowMode;
  const cookieMode = parseCookies(req)[cookieName(MODE_COOKIE)];
  let decision;
  if (cookieMode === "new" || cookieMode === "classic") {
    decision = resolveDeviceMode({ cookieMode });
  } else {
    try {
      const shellSince = await ensureShellSince(db);
      const created = await sessionCreatedAt(db, req.dashboardSession);
      decision = resolveDeviceMode({ cookieMode, sessionCreatedAt: created, shellSince });
    } catch (err) {
      // A DB that cannot answer must not move a device into the new shell:
      // show classic for this request and remember nothing.
      console.warn("[shell] mode lookup failed, showing classic:", err.message);
      decision = { mode: "classic", offerTry: false, persist: false };
    }
  }
  req.crowMode = decision;
  if (decision.persist && !res.headersSent) res.append("Set-Cookie", modeCookie(decision.mode));
  // The device's first classic render also starts the one-time offer.
  if (decision.offerTry && !res.headersSent) res.append("Set-Cookie", tryCookie("pending"));
  return decision;
}

/** A same-origin /dashboard/ path to land on after a scope change, minus any ?project=. */
export function safeReturnPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return DEFAULT_RETURN;
  if (!value.startsWith("/dashboard/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return DEFAULT_RETURN;
  let u;
  try { u = new URL(value, "http://x"); } catch { return DEFAULT_RETURN; }
  if (u.origin !== "http://x" || !u.pathname.startsWith("/dashboard/")) return DEFAULT_RETURN;
  // The new scope must stick: a ?project= left in the return path would win over it.
  u.searchParams.delete("project");
  return u.pathname + u.search + u.hash;
}

/** POST /dashboard/mode and POST /dashboard/scope. Mount after dashboardAuth + csrfMiddleware. */
export function shellRouter({ createDbClient }) {
  const router = Router();

  router.post("/dashboard/mode", (req, res) => {
    const m = req.body ? req.body.mode : undefined;
    if (m !== "new" && m !== "classic") return res.status(400).type("text/plain").send("mode must be new or classic");
    res.append("Set-Cookie", modeCookie(m));
    if (m === "new") res.append("Set-Cookie", tryCookie("used"));
    // The target's crow-mode meta differs, so Turbo does a full load.
    return res.redirect(303, m === "new" ? "/dashboard/perch" : "/dashboard");
  });

  router.post("/dashboard/mode/try-dismiss", (req, res) => {
    res.append("Set-Cookie", tryCookie("dismissed"));
    const raw = req.body ? req.body.return : undefined;
    const back = safeReturnPath(raw);
    // safeReturnPath's fallback is the shell's Chat; this route's is the classic home.
    return res.redirect(303, back === DEFAULT_RETURN && raw !== DEFAULT_RETURN ? "/dashboard" : back);
  });

  router.post("/dashboard/scope", async (req, res) => {
    const db = createDbClient();
    try {
      const { value } = await scopeFromValue(db, req.body ? req.body.scope : undefined);
      res.append("Set-Cookie", scopeCookie(value));
      // Everything / Unassigned chosen on a project's home leaves the project
      // (the home is that project's page, so staying would contradict the choice).
      const back = safeReturnPath(req.body ? req.body.return : undefined);
      return res.redirect(303, back.startsWith("/dashboard/project/") ? DEFAULT_RETURN : back);
    } finally {
      db.close();
    }
  });

  return router;
}

/**
 * Everything the panel dispatch needs for one page: decides the mode (and
 * persists it), sets req.crowScope, and returns the extra renderLayout options.
 * Classic: { variant: "classic" } only, and the scope stays Everything (a
 * classic page has no chip, so it never filters out of sight). New: the shell
 * with this request's scope, the live projects (read once) and the panel's tab.
 */
export async function resolveShellPage(req, res, db, panelId, lang = "en") {
  const { mode, offerTry } = await resolveRequestMode(req, res, db);
  if (mode !== "new") {
    req.crowScope = EVERYTHING;
    // One rule: the card shows iff crow_try_new is "pending" (this request's own
    // first render counts: its Set-Cookie is not in the request yet).
    const pending = offerTry || parseCookies(req)[cookieName(TRY_COOKIE)] === "pending";
    return pending ? { variant: "classic", tryNewCard: tryNewCardHtml(lang) } : { variant: "classic" };
  }
  // The project home (/dashboard/project/:slug) takes its scope from the path:
  // the slug wins over the cookie and ?project=, and nothing is written (the
  // GET is read-only; Turbo prefetches it on hover). An unknown or archived
  // slug resolves to Everything, and the panel answers 404.
  const homeSlug = panelId === "project-home" && req.params && typeof req.params.slug === "string" ? req.params.slug : null;
  let scope;
  if (panelId === "project-home") {
    scope = homeSlug ? (await scopeFromValue(db, homeSlug, { slugOnly: true })).scope : EVERYTHING;
  } else {
    const r = await resolveScope(req, db);
    scope = r.scope;
    if (r.setCookie && !res.headersSent) res.append("Set-Cookie", r.setCookie);
  }
  req.crowScope = scope;
  let projects = [];
  try { projects = await activeProjects(db); } catch (err) { console.warn("[shell] project list failed:", err.message); }
  let counts = new Map();
  try { counts = await needsYouCounts(db, projects, { engine: getInteractiveEngine({ createIfMissing: false }) }); }
  catch (err) { console.warn("[shell] needs-you counts failed:", err.message); }
  // The project home reads the same Map rather than counting again.
  req.crowShellCounts = counts;
  // The drawer's Apps grid for this scope: the 30 s catalog cache plus, for a
  // project, one pi_bot_defs query (apps/launcher.js). All is fetched on switch.
  let apps = null;
  try { apps = await launcherFor(db, scope, { lang }); } catch (err) { console.warn("[shell] apps launcher failed:", err.message); }
  return { variant: "shell", shell: { scope, projects, counts, homeSlug, apps, tab: TAB_OF[panelId] ?? null } };
}
