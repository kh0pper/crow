/**
 * Fix-it Cards — gateway wiring. Binds the pure registry + DB store to this
 * gateway: registers the v1 detector/remedy, exposes the fire-and-forget
 * `emitFixIt` chokepoints call, renders the nest card section, and serves the
 * remedy/dismiss POST action.
 */
import * as registry from "../../shared/fix-it/registry.js";
import * as store from "../../shared/fix-it/store.js";
import remoteExposureDetector from "./detectors/remote-exposure.js";
import caddyProxySocketDetector from "./detectors/caddy-proxy-socket.js";
import bootGuardDetector from "./detectors/boot-guard.js";
import dataBackendReapprovalDetector from "./detectors/data-backend-reapproval.js";
import bundleBindDriftDetector from "./detectors/bundle-bind-drift.js";
import addonWallDetector, {
  SOURCE as ADDON_WALL_SOURCE,
  TITLE as ADDON_WALL_TITLE,
  whyText as addonWallWhyText,
} from "./detectors/addon-wall.js";
import exposeCapabilityRemedy from "./remedies/expose-capability.js";
import restoreBundleCompose, {
  ACTION_ID as RESTORE_COMPOSE_ACTION,
} from "./remedies/restore-bundle-compose.js";
import addonUnwallRemedy, {
  FLASH_ID_RE,
  KEEP_OFF_ACTION,
  KEEP_OFF_LABEL,
  STALE_MESSAGE as ADDON_WALL_STALE,
  UNWALL_ACTION,
  UNWALLED_FLASH,
  keepOffRemedy,
  unwallLabel,
} from "./remedies/addon-unwall.js";
import { wallFailureByItemId } from "../../../scripts/addon-sandbox/failures.mjs";
import { recordSuppressedRequest } from "./peer-card-counters.js";
import { CARD_ACTION_IDS } from "./peer-card-policy.js";
import { createNotification } from "../../shared/notifications.js";
import { getInstance } from "../instance-registry.js";
import { escapeHtml } from "../dashboard/shared/components.js";
import { csrfInput } from "../dashboard/shared/csrf.js";

let wired = false;
export function wireFixIt() {
  if (wired) return;
  registry.registerDetector(remoteExposureDetector);
  registry.registerDetector(caddyProxySocketDetector);
  registry.registerDetector(bootGuardDetector);
  registry.registerDetector(dataBackendReapprovalDetector);
  registry.registerDetector(bundleBindDriftDetector);
  registry.registerDetector(addonWallDetector);
  registry.registerRemedy("expose-capability", exposeCapabilityRemedy);
  // The owner's own copy of a bundle compose, put back with the previous file kept
  // as <composefile>.bak (bundle-bind-drift.js's compose-edited card).
  registry.registerRemedy(RESTORE_COMPOSE_ACTION, restoreBundleCompose);
  // An add-on that could not run inside its wall: run it unwalled by the
  // owner's choice, or answer the card and leave it off.
  registry.registerRemedy("addon-unwall", addonUnwallRemedy);
  registry.registerRemedy("addon-keep-off", keepOffRemedy);
  // N1b-8: the peer-scoped card offers three durations, and each button needs
  // its own actionId (the POST carries only action_id). All three run the same
  // one-device grant; the duration rides in the stored args.
  for (const actionId of CARD_ACTION_IDS) registry.registerRemedy(actionId, exposeCapabilityRemedy);
  wired = true;
}

/**
 * The detectors runBootChecks() drives. A condition no request emits an event for
 * belongs here; the list is exported so the set can be asserted, not grepped.
 */
export const BOOT_CHECK_DETECTORS = Object.freeze([caddyProxySocketDetector, bootGuardDetector, dataBackendReapprovalDetector, bundleBindDriftDetector]);

/**
 * Where a `kind: "link"` remedy may point, held HERE and never read from the
 * card: `fix_it_items.remedies` is a crow.db column, so a stored href is a
 * value anything that can write crow.db controls. A browser reads `/\evil.example`
 * (or a tab-terminated variant) as another host, which a sanitiser based on
 * string prefixes misses. A remedy's actionId selects one of these paths; an
 * unknown actionId renders no link at all.
 */
export const LINK_REMEDIES = Object.freeze({
  // The Projects panel's route (servers/gateway/dashboard/panels/projects.js).
  "open-projects-page": "/dashboard/projects",
  // The Extensions page, where a bundle is restarted (its Restart action) and
  // where its compose file is explained. The compose refresh and the bind-drift
  // card never restart anything themselves.
  "open-extensions-page": "/dashboard/extensions",
});

/** The code-held target of a link remedy, or null (never a stored href). */
export function linkRemedyTarget(r) {
  if (!r || typeof r.actionId !== "string") return null;
  return Object.hasOwn(LINK_REMEDIES, r.actionId) ? LINK_REMEDIES[r.actionId] : null;
}

/**
 * The flash codes a remedy may send the owner back with. Fixed here, never read
 * from the remedy result unchecked: the redirect target is built from it.
 */
export const REMEDY_FLASHES = Object.freeze(["fixit_addon_stale", "fixit_addon_unwalled"]);

/** Build a db-bound store; the bound upsertItem also fires urgent push. */
function boundStore(db) {
  return {
    // A boot check that must read a table of its own (data-backend-reapproval)
    // reaches it through the store it was handed, never through a second client.
    db,
    upsertItem: async (item) => {
      const r = await store.upsertItem(db, item);
      if (item.severity === "urgent" && r.notify) {
        try {
          await createNotification(db, {
            title: item.title, body: item.why || null,
            type: "system", source: "fix-it", priority: "high",
            action_url: "/dashboard/nest?open=1",
          });
        } catch (err) { console.warn("[fix-it] push failed:", err.message); }
      }
      return r;
    },
    resolveByKey: (s, k) => store.resolveByKey(db, s, k),
    // N1b-8 rate limits: a detector needs the peer's existing cards to decide
    // whether a denial earns a card, and somewhere to count the ones that don't.
    listBySource: (s) => store.listBySource(db, s),
    recordDuplicate: (id) => store.recordDuplicate(db, id),
    recordSuppressed: (info) => recordSuppressedRequest(db, info),
    // Fix round 3: a pending card raised under another pairing is stale (the
    // remedy refuses it), so the detector answers it before creating the new one.
    markResolved: (id) => store.markResolved(db, id),
  };
}

/**
 * Fire a Fix-it event. Fire-and-forget — never throws, never blocks the caller
 * (it runs on the peer-exposure request path). Enriches the payload with the
 * requesting peer's display name (generic: any payload with `requestingInstance`).
 *
 * N1b-8: for the peer-exposure card the name is ALWAYS resolved here, from this
 * instance's own registry row for the verified id — a payload-supplied name is
 * overwritten. The name is display text only; the card's identity (and the id an
 * "Allow" is scoped to) is `requestingInstance`, which the gate takes from
 * `req.instanceAuth.instance.id`.
 */
export async function emitFixIt(db, eventName, payload) {
  try {
    wireFixIt();
    const p = { ...(payload || {}) };
    if (p.requestingInstance && (!p.requestingInstanceName || eventName === "peer-exposure:denied")) {
      // Resolution may yield nothing (an unknown id): drop whatever the payload
      // claimed rather than display it.
      p.requestingInstanceName = null;
      try {
        const inst = await getInstance(db, p.requestingInstance);
        if (inst && inst.name) p.requestingInstanceName = inst.name;
      } catch { /* best-effort name */ }
    }
    await registry.emit(eventName, p, boundStore(db));
  } catch (err) {
    console.warn("[fix-it] emitFixIt failed:", err.message);
  }
}

/**
 * Re-run ONE boot-check detector now. A dashboard action that answers a boot
 * check (approving the last waiting backend) should clear its card without a
 * gateway restart. Never throws; an unknown source does nothing.
 */
export async function runBootCheck(db, source, opts = {}) {
  const detector = BOOT_CHECK_DETECTORS.find((d) => d.source === source);
  if (!detector) return null;
  wireFixIt();
  try {
    return await detector.check(boundStore(db), opts);
  } catch (err) {
    console.warn(`[fix-it] boot check "${source}" failed:`, err?.message || err);
    return null;
  }
}

/**
 * Boot checks — conditions no request emits an event for. Two: a Caddyfile on
 * this machine that still dials the gateway over loopback (the security audit's
 * finding), and a boot guard that is installed but did not run (N1c-3 L1).
 * Fire-and-forget: never throws, and one broken detector never hides the other.
 */
export async function runBootChecks(db, opts = {}) {
  wireFixIt();
  for (const detector of BOOT_CHECK_DETECTORS) await runBootCheck(db, detector.source, opts);
}

function remedyButton(item, r, req) {
  // A link entry is navigation only: nothing is posted, so no remedy runs. Its
  // destination comes from LINK_REMEDIES, never from the stored entry.
  if (r && r.kind === "link") {
    const href = linkRemedyTarget(r);
    if (!href) return "";
    return `<a class="btn btn-secondary" href="${escapeHtml(href)}" data-fixit-link>${escapeHtml(r.label || "Open")}</a>`;
  }
  const gated = r.kind === "confirm" || r.kind === "guided";
  // v1 ships only `instant`. A gated remedy renders disabled with a note so a
  // destructive action can never be a careless one-tap (framework enforces it
  // here AND in handleFixItAction).
  return `<form method="POST" action="/dashboard/fix-it/action" style="display:inline">
    ${csrfInput(req)}
    <input type="hidden" name="action" value="remedy">
    <input type="hidden" name="item_id" value="${escapeHtml(String(item.id))}">
    <input type="hidden" name="action_id" value="${escapeHtml(r.actionId)}">
    <button type="submit" class="btn btn-secondary" data-fixit-kind="${escapeHtml(r.kind || "instant")}"${gated ? " disabled title=\"Coming soon\"" : ""}>${escapeHtml(r.label || "Fix")}</button>
  </form>`;
}

/**
 * The parts one card shows. A "addon-wall" card never renders a stored title,
 * why, label or context: those are crow.db columns, and the eight add-ons that
 * share crow.db can write them. Everything comes from the live failure record
 * bound to this item, or from this file's constants.
 */
function cardParts(item, req) {
  if (item.source === ADDON_WALL_SOURCE) {
    const record = wallFailureByItemId(Number(item.id));
    const keepOff = { actionId: KEEP_OFF_ACTION, kind: "instant", label: KEEP_OFF_LABEL };
    if (!record) {
      // No record: the card answers nothing, so it offers no fix at all.
      return {
        title: ADDON_WALL_TITLE,
        why: ADDON_WALL_STALE,
        buttons: remedyButton(item, keepOff, req),
        details: "",
      };
    }
    const unwall = { actionId: UNWALL_ACTION, kind: "instant", label: unwallLabel(record.id) };
    return {
      title: ADDON_WALL_TITLE,
      why: addonWallWhyText(record.id, record.reason),
      buttons: remedyButton(item, unwall, req) + remedyButton(item, keepOff, req),
      details: "",
    };
  }

  const remedyBtns = (item.remedies || []).map((r) => remedyButton(item, r, req)).join("");
  const ctx = item.context || {};
  const techRows = [];
  if (ctx.capability) techRows.push(`Capability: <code>${escapeHtml(ctx.capability)}</code>`);
  if (ctx.requestingInstance) techRows.push(`Requesting instance: <code>${escapeHtml(ctx.requestingInstance)}</code>`);
  if (ctx.caddyfile) techRows.push(`Caddyfile: <code>${escapeHtml(ctx.caddyfile)}</code>`);
  const details = techRows.length
    ? `<details style="margin-top:0.5rem"><summary style="cursor:pointer;color:var(--crow-text-muted);font-size:0.8rem">Technical details</summary>
           <div style="font-size:0.8rem;color:var(--crow-text-muted);margin-top:0.3rem">${techRows.join("<br>")}</div></details>`
    : "";
  return { title: item.title, why: item.why || "", buttons: remedyBtns, details };
}

/** Render the nest Fix-it card section (or "" when nothing pending). */
export async function renderFixItCards(db, { lang, req } = {}) {
  let items = [];
  try { items = await store.listPending(db); } catch { return ""; }
  if (!items.length) return "";

  const cards = items.map((item) => {
    const parts = cardParts(item, req);
    const countBadge = item.count > 1
      ? `<span style="font-size:0.7rem;color:var(--crow-text-muted)">×${escapeHtml(String(item.count))}</span>` : "";
    return `<div class="nest-fixit-card" style="border:1px solid var(--crow-border,#2222);border-left:3px solid var(--crow-warning,#e0a000);border-radius:8px;padding:0.8rem 1rem;margin-bottom:0.6rem;background:var(--crow-surface,rgba(255,255,255,0.02))">
      <div style="font-weight:600;margin-bottom:0.2rem">${escapeHtml(parts.title)} ${countBadge}</div>
      ${parts.why ? `<div style="color:var(--crow-text-secondary);font-size:0.9rem;margin-bottom:0.6rem">${escapeHtml(parts.why)}</div>` : ""}
      <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
        ${parts.buttons}
        <form method="POST" action="/dashboard/fix-it/action" style="display:inline">
          ${csrfInput(req)}
          <input type="hidden" name="action" value="dismiss">
          <input type="hidden" name="item_id" value="${escapeHtml(String(item.id))}">
          <button type="submit" class="btn btn-text" style="background:none;border:none;color:var(--crow-text-muted);cursor:pointer">Not now</button>
        </form>
      </div>
      ${parts.details}
    </div>`;
  }).join("");

  return `<div class="nest-fixits" style="margin:0 1rem 1rem" aria-label="Things Crow noticed">${cards}</div>`;
}

/**
 * The `&addon=<id>` a flash may carry: only the unwall flash, and only for a
 * slug id (the param is rendered on the next page, so it is checked here).
 */
function flashAddonQuery(flash, params) {
  if (flash !== UNWALLED_FLASH) return "";
  const id = params && typeof params.addon === "string" ? params.addon : "";
  return FLASH_ID_RE.test(id) ? `&addon=${encodeURIComponent(id)}` : "";
}

/** POST /dashboard/fix-it/action — remedy or dismiss. */
export async function handleFixItAction(req, res, { db }) {
  wireFixIt();
  const body = req.body || {};
  const action = body.action;
  const itemId = Number(body.item_id);
  try {
    if (!Number.isInteger(itemId)) {
      return res.redirectAfterPost("/dashboard/nest?flash=fixit_error");
    }
    if (action === "dismiss") {
      await store.dismiss(db, itemId, 7);
      return res.redirectAfterPost("/dashboard/nest?flash=fixit_dismissed");
    }
    if (action === "remedy") {
      const item = await store.getItem(db, itemId);
      if (!item) return res.redirectAfterPost("/dashboard/nest?flash=fixit_error");
      // N1b-8 review round 1 (N2): only a card that is still open may run its
      // remedy. A stale page, a double submit or a replayed POST would
      // otherwise re-apply a fix the operator already answered (re-granting an
      // allowance, or granting one for a card they dismissed).
      if (item.status !== "pending") {
        return res.redirectAfterPost("/dashboard/nest?flash=fixit_not_pending");
      }
      const entry = (item.remedies || []).find((r) => r.actionId === body.action_id);
      if (!entry) return res.redirectAfterPost("/dashboard/nest?flash=fixit_error");
      if (entry.kind && entry.kind !== "instant") {
        // v1 only runs instant remedies; confirm/guided are gated.
        return res.redirectAfterPost("/dashboard/nest?flash=fixit_error");
      }
      const fn = registry.getRemedy(entry.actionId);
      if (!fn) return res.redirectAfterPost("/dashboard/nest?flash=fixit_error");
      // `req` rides along for a remedy that must prove the OWNER at this machine's
      // dashboard (the compose restore): it is the request, never stored card data.
      const result = await fn(entry.args || {}, { db, item, req });
      if (result && result.resolved) {
        await store.markResolved(db, itemId);
        const done = typeof result.flash === "string" && REMEDY_FLASHES.includes(result.flash) ? result.flash : "fixit_fixed";
        return res.redirectAfterPost(`/dashboard/nest?flash=${done}${flashAddonQuery(done, result.flashParams)}`);
      }
      if (result && typeof result.flash === "string" && REMEDY_FLASHES.includes(result.flash)) {
        return res.redirectAfterPost(`/dashboard/nest?flash=${result.flash}`);
      }
      return res.redirectAfterPost("/dashboard/nest?flash=fixit_error");
    }
    return res.redirectAfterPost("/dashboard/nest?flash=fixit_error");
  } catch (err) {
    console.error("[fix-it] action failed:", err.message);
    return res.redirectAfterPost("/dashboard/nest?flash=fixit_error");
  }
}
