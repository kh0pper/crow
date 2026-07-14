/**
 * First-run onboarding — a hidden, server-rendered guided tour shown once after
 * a new user sets their dashboard password (and replayable from Settings, Help
 * and Setup). Orient-and-route: each step explains one thing and deep-links to
 * the existing surface that does the work. No inline config, no .env writes.
 * Step navigation is a ?step=N query param (no client JS; refresh/back safe).
 *
 * W3-3 additions:
 *   - Reaching the "done" step sets onboarding_completed_at (first time only)
 *   - Done step shows a subtle CSS-only celebration + "what to try" cards
 */
import { stepper, section, callout, button, escapeHtml } from "../shared/components.js";
import { t, SUPPORTED_LANGS } from "../shared/i18n.js";
import { parseCookies } from "../auth.js";
import { upsertSetting, readSetting } from "../settings/registry.js";
import { loadCollections } from "./extensions/collections.js";
import { csrfInput } from "../shared/csrf.js";
import { buildIdentityBackup, loadInstanceSeed, deriveInstanceIdentity } from "../../../sharing/identity.js";
import { instanceSeedDir } from "../../../../scripts/pi-bots/instance-paths.mjs";

/** Exported so tests derive step positions (indexOf/length) instead of pinning indices. */
export const STEP_KEYS = ["welcome", "ai", "integrations", "bot", "starter", "connect", "done"];

/**
 * Resolve language cookie-first. The panel-dispatch lang derives from the DB
 * "language" setting, which a brand-new user has not set, so it would default
 * to English even for a user who chose Spanish on the setup/login pages. Those
 * pages persist the choice in the crow_lang cookie, so honor it here (matches
 * what settings/sections/help-setup.js already does).
 */
function resolveLang(req) {
  const lang = parseCookies(req).crow_lang;
  return SUPPORTED_LANGS.includes(lang) ? lang : "en";
}

/** A secondary button that opens an existing surface in a new tab so the tour
 *  stays open behind it. */
function deepLink(label, href) {
  return button(label, { variant: "secondary", href, attrs: 'target="_blank" rel="noopener"' });
}

/**
 * Is this href a same-origin dashboard path? Deliberately conservative: only a
 * leading "/" counts, and a protocol-relative "//host" does not (it is a
 * cross-origin URL wearing a slash). Anything else — absolute http(s), mailto:,
 * javascript:, a bare relative path — is treated as external.
 * @param {string} href
 * @returns {boolean}
 */
export function isInternalHref(href) {
  return typeof href === "string" && href.startsWith("/") && !href.startsWith("//");
}

/**
 * The target/rel attributes an action card's CTA should carry, decided by href.
 * Internal links navigate in the same tab (the tour is over by the time the done
 * step renders, so a new tab is just noise); external links keep opening a new tab,
 * with rel="noopener" so the opened page cannot reach back through window.opener.
 * Classifying by href means a card added later gets the right behavior for free.
 * @param {string} href
 * @returns {string} attribute string for button({ attrs })  ("" for internal)
 */
export function cardLinkAttrs(href) {
  return isInternalHref(href) ? "" : 'target="_blank" rel="noopener"';
}

/**
 * "What to try first" action cards shown on the done step (W3-3; extensions
 * overhaul added the fourth, starter-collections, card). Each card is a link,
 * description, and CTA button.
 */
function renderActionCards(lang) {
  const cards = [
    {
      titleKey: "onboarding.firstMemory.title",
      bodyKey: "onboarding.firstMemory.body",
      actionKey: "onboarding.firstMemory.action",
      href: "/dashboard/memory",
    },
    {
      titleKey: "onboarding.firstAgent.title",
      bodyKey: "onboarding.firstAgent.body",
      actionKey: "onboarding.firstAgent.action",
      href: "/dashboard/bot-builder",
    },
    {
      titleKey: "onboarding.firstConnect.title",
      bodyKey: "onboarding.firstConnect.body",
      actionKey: "onboarding.firstConnect.action",
      href: "/dashboard/connect",
    },
    {
      titleKey: "onboarding.tryCollections.title",
      bodyKey: "onboarding.tryCollections.body",
      actionKey: "onboarding.tryCollections.action",
      href: "/dashboard/extensions#collections",
    },
  ];

  const cardHtml = cards.map(c => `
    <div class="onboarding-action-card">
      <div class="onboarding-action-card-title">${t(c.titleKey, lang)}</div>
      <div class="onboarding-action-card-body">${t(c.bodyKey, lang)}</div>
      ${button(t(c.actionKey, lang), { variant: "secondary", size: "sm", href: c.href, attrs: cardLinkAttrs(c.href) })}
    </div>`).join("");

  return `${CARD_CSS}<div class="onboarding-action-cards">${cardHtml}</div>`;
}

/**
 * Starter-collection cards (4d): one card per registry/collections.json entry —
 * title, description, member count. Orientation only: install UX lives on the
 * extensions page, so the single deepLink below the grid is the only action.
 * loadCollections() never throws (missing/corrupt file → []); empty → no grid.
 */
function renderStarterCards(lang) {
  const collections = loadCollections();
  if (!collections.length) return "";
  const cardHtml = collections.map((c) => `
    <div class="onboarding-action-card">
      <div class="onboarding-action-card-title">${escapeHtml(c.name || c.id)}</div>
      <div class="onboarding-action-card-body">${escapeHtml(c.description || "")}</div>
      <div class="onboarding-action-card-count">${t("onboarding.starterMemberCount", lang).replace("{n}", String(c.members.length))}</div>
    </div>`).join("");
  return `${CARD_CSS}<div class="onboarding-action-cards">${cardHtml}</div>`;
}

/**
 * Celebration CSS — scoped to onboarding done step. Subtle pop animation on
 * the checkmark; design-token colors only.
 */
const CELEBRATION_CSS = `
<style>
.onboarding-celebrate {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: var(--crow-space-5);
  padding: 0.75rem 1rem;
  background: rgba(34,197,94,0.07);
  border: 1px solid rgba(34,197,94,0.2);
  border-radius: 10px;
}
.onboarding-celebrate-check {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--crow-success);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  font-weight: 700;
  flex-shrink: 0;
  animation: celebrate-pop 0.45s cubic-bezier(0.175, 0.885, 0.32, 1.275) both;
}
@keyframes celebrate-pop {
  0%   { transform: scale(0); opacity: 0; }
  60%  { transform: scale(1.25); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
.onboarding-celebrate-label {
  font-weight: 600;
  color: var(--crow-success);
  font-size: var(--crow-text-base);
}
</style>
`;

/**
 * Action-card grid CSS — shared by the done step's "what to try" cards and the
 * starter step's collection cards (each step is its own page, so emitting the
 * <style> block per step never duplicates it in one document).
 */
const CARD_CSS = `
<style>
.onboarding-action-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--crow-space-3);
  margin-top: var(--crow-space-5);
}
.onboarding-action-card {
  background: var(--crow-bg-surface);
  border: 1px solid var(--crow-border);
  border-radius: 10px;
  padding: var(--crow-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--crow-space-2);
}
.onboarding-action-card-title {
  font-weight: 600;
  font-size: var(--crow-text-sm);
  color: var(--crow-text-primary);
}
.onboarding-action-card-body {
  font-size: var(--crow-text-sm);
  color: var(--crow-text-secondary);
  line-height: var(--crow-leading-relaxed);
  flex: 1;
}
.onboarding-action-card-count {
  font-size: var(--crow-text-sm);
  color: var(--crow-text-tertiary);
}
</style>
`;

/**
 * The instance crowId for the done step's backup section, or null when there
 * is no readable plaintext-seed identity.json (fresh install where the sharing
 * server has not run yet, or an encrypted-at-rest identity). Null → the
 * section renders an honest "no identity yet" note instead of the form; the
 * wizard must never crash over it. Same seed anchor as the backup endpoint
 * (identity.js's resolveDataDir, via instanceSeedDir()).
 * @returns {string|null}
 */
function readInstanceCrowId() {
  try {
    const seed = loadInstanceSeed(instanceSeedDir());
    return deriveInstanceIdentity(seed).crowId;
  } catch {
    return null;
  }
}

/**
 * "Back up your identity" section on the done step (4-PR3). Passphrase +
 * confirm POST to the hand-registered /dashboard/onboarding/identity-backup
 * route (dashboard-authed + CSRF-protected in dashboard/index.js). data-pw is
 * carried for parity with the settings password-toggle pattern, but the wizard
 * page has no toggle script — plain password fields by design.
 * @param {string} lang
 * @param {{crowId: string|null, req?: object}} ctx
 */
function renderBackupSection(lang, ctx = {}) {
  const req = ctx.req || null;
  const heading = `<h3 style="font-size:var(--crow-text-base);font-weight:600;margin:var(--crow-space-5) 0 var(--crow-space-2)">${t("onboarding.backup.title", lang)}</h3>`;
  if (!ctx.crowId) {
    return `${heading}<p style="font-size:var(--crow-text-sm);color:var(--crow-text-secondary)">${t("onboarding.backup.noIdentity", lang)}</p>`;
  }
  const rawError = req && req.query ? req.query.backup_error : "";
  const errorHtml = rawError
    ? `<p style="color:var(--crow-error);font-size:var(--crow-text-sm);margin-bottom:var(--crow-space-2)">${escapeHtml(String(rawError))}</p>`
    : "";
  const fieldStyle = "display:block;width:100%;max-width:320px;margin-top:2px;padding:0.4rem 0.6rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:6px;color:var(--crow-text-primary)";
  const labelStyle = "display:block;font-size:var(--crow-text-sm);color:var(--crow-text-secondary);margin-bottom:var(--crow-space-2)";
  return `${heading}
    <p style="font-size:var(--crow-text-sm);color:var(--crow-text-secondary);margin-bottom:var(--crow-space-2)">${t("onboarding.backup.crowIdLabel", lang)}: <code>${escapeHtml(ctx.crowId)}</code></p>
    <p style="font-size:var(--crow-text-sm);color:var(--crow-text-secondary);line-height:var(--crow-leading-relaxed);margin-bottom:var(--crow-space-3)">${t("onboarding.backup.body", lang)}</p>
    ${errorHtml}
    <form method="POST" action="/dashboard/onboarding/identity-backup">
      ${csrfInput(req)}
      <label style="${labelStyle}">${t("onboarding.backup.passphraseLabel", lang)}
        <input type="password" name="passphrase" data-pw minlength="12" required autocomplete="new-password" style="${fieldStyle}">
      </label>
      <label style="${labelStyle}">${t("onboarding.backup.confirmLabel", lang)}
        <input type="password" name="confirm" data-pw minlength="12" required autocomplete="new-password" style="${fieldStyle}">
      </label>
      <p style="font-size:var(--crow-text-sm);color:var(--crow-text-tertiary);margin-bottom:var(--crow-space-3)">${t("onboarding.backup.hint", lang)}</p>
      ${button(t("onboarding.backup.submit", lang), { variant: "secondary", size: "sm", type: "submit" })}
    </form>`;
}

/**
 * POST /dashboard/onboarding/identity-backup — hand-registered in
 * dashboard/index.js BEHIND dashboardAuth + csrfMiddleware (same mounting slot
 * as the fix-it action POST). Validates passphrase (minlength 12 + confirm
 * match), then streams the buildIdentityBackup payload as an attachment.
 * Never logs or echoes the passphrase; unexpected failures redirect with a
 * generic message instead of 500ing.
 */
export async function handleIdentityBackupPost(req, res) {
  const lang = resolveLang(req);
  const doneIdx = STEP_KEYS.indexOf("done");
  const back = (msgKey) =>
    res.redirectAfterPost(`/dashboard/onboarding?step=${doneIdx}&backup_error=${encodeURIComponent(t(msgKey, lang))}`);
  try {
    const passphrase = typeof req.body?.passphrase === "string" ? req.body.passphrase : "";
    const confirm = typeof req.body?.confirm === "string" ? req.body.confirm : "";
    if (passphrase.length < 12) return back("onboarding.backup.errTooShort");
    if (passphrase !== confirm) return back("onboarding.backup.errMismatch");
    const payload = buildIdentityBackup(passphrase);
    res.setHeader("Content-Disposition", 'attachment; filename="crow-identity-backup.json"');
    return res.type("application/json").send(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error("[onboarding] identity backup failed:", err.message); // message only — never the passphrase
    return back("onboarding.backup.errGeneric");
  }
}

/**
 * Count enabled rows in the providers table. Returns null when there is no db
 * or the query fails — the caller renders no count claim at all in that case
 * (asserting "nothing configured yet" on a db error could be a lie, and the
 * wizard must never 500 over an orientation detail).
 * @returns {Promise<number|null>}
 */
async function countProviders(db) {
  if (!db) return null;
  try {
    const { rows } = await db.execute("SELECT COUNT(*) AS n FROM providers WHERE disabled = 0");
    const n = Number(rows?.[0]?.n);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} stem - STEP_KEYS entry
 * @param {string} lang
 * @param {{providersCount?: number|null, crowId?: string|null, req?: object}} [ctx]
 *   - server-fetched data the step body needs (ai: providersCount; done:
 *     crowId + req for the backup form); handler-populated so this stays sync.
 */
function renderStepBody(stem, lang, ctx = {}) {
  const body = `<p style="font-size:var(--crow-text-base);line-height:var(--crow-leading-relaxed);color:var(--crow-text-secondary);margin-bottom:var(--crow-space-4)">${t(`onboarding.${stem}.body`, lang)}</p>`;
  const linkWrap = (html) => `<div style="margin-top:var(--crow-space-4)">${html}</div>`;
  switch (stem) {
    case "ai": {
      const n = ctx.providersCount;
      let note = "";
      if (n === 0) {
        note = callout(t("onboarding.aiEmptyNote", lang), "info");
      } else if (typeof n === "number" && n > 0) {
        note = callout(t("onboarding.aiConfiguredNote", lang).replace("{n}", String(n)), "info");
      }
      // n == null (no db / query failed): no count claim either way.
      return body + note
        + linkWrap(deepLink(t("onboarding.openProviders", lang), "/dashboard/settings?section=llm&tab=providers"));
    }
    case "starter":
      return body + renderStarterCards(lang)
        + linkWrap(deepLink(t("onboarding.openCollections", lang), "/dashboard/extensions#collections"));
    case "integrations":
      return body + callout(t("onboarding.integrationsNote", lang), "info")
        + linkWrap(deepLink(t("onboarding.openIntegrations", lang), "/dashboard/settings?section=integrations"));
    case "bot":
      // Item 5 PR1: deep-link into the guided creation wizard, not the raw panel.
      return body + linkWrap(deepLink(t("onboarding.openBotBuilder", lang), "/dashboard/bot-builder?new=1"));
    case "connect":
      return body + callout(t("onboarding.connectNote", lang), "info")
        + linkWrap(deepLink(t("onboarding.openConnections", lang), "/dashboard/connect"));
    case "done": {
      const celebrateHtml = `${CELEBRATION_CSS}<div class="onboarding-celebrate">
        <div class="onboarding-celebrate-check" aria-hidden="true">&#10003;</div>
        <span class="onboarding-celebrate-label">${t("onboarding.celebration", lang)}</span>
      </div>`;
      return celebrateHtml + body + callout(t("onboarding.doneNote", lang), "success")
        + renderBackupSection(lang, ctx)
        + renderActionCards(lang);
    }
    case "welcome":
    default:
      return body;
  }
}

function renderNav(current, lang) {
  const last = STEP_KEYS.length - 1;
  const parts = [];
  if (current > 0) {
    parts.push(button(t("onboarding.btnBack", lang), { variant: "ghost", href: `/dashboard/onboarding?step=${current - 1}` }));
  }
  if (current < last) {
    parts.push(button(t("onboarding.btnSkip", lang), { variant: "ghost", href: "/dashboard" }));
    parts.push(button(t("onboarding.btnNext", lang), { variant: "primary", href: `/dashboard/onboarding?step=${current + 1}` }));
  } else {
    parts.push(button(t("onboarding.btnGoDashboard", lang), { variant: "primary", href: "/dashboard" }));
  }
  return `<div style="display:flex;gap:var(--crow-space-3);margin-top:var(--crow-space-5);flex-wrap:wrap">${parts.join("")}</div>`;
}

export default {
  id: "onboarding",
  name: "Onboarding",        // literal; never shown (hidden panel)
  icon: "skills",            // unused while hidden; present for registry shape parity
  route: "/dashboard/onboarding",
  navOrder: 96,
  category: "tools",
  hidden: true,              // reachable by URL + first-run redirect, not in the sidebar

  async handler(req, res, { db, layout }) {
    // Cookie-first: the dispatcher-provided context lang derives from the DB
    // "language" setting, which defaults to "en" for a brand-new user who has
    // not saved a preference yet. resolveLang() reads the crow_lang cookie set
    // by the setup/login pages instead, so a user who chose Spanish at setup
    // gets Spanish onboarding. We deliberately do not use the context lang.
    const lang = resolveLang(req);

    // Clamp step into [0, last]; non-numeric or out-of-range falls to a valid page.
    const raw = parseInt(req.query.step, 10);
    const last = STEP_KEYS.length - 1;
    const current = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), last) : 0;
    const stem = STEP_KEYS[current];

    // W3-3: Reaching the "done" step marks onboarding complete (first time only).
    if (stem === "done" && db) {
      try {
        const existing = await readSetting(db, "onboarding_completed_at");
        if (!existing) {
          await upsertSetting(db, "onboarding_completed_at", new Date().toISOString());
        }
      } catch {}
    }

    // The ai step's copy is conditional on whether any provider is configured;
    // fetch the count server-side only when that step is the one rendering.
    // The done step needs the instance crowId (nullable) + req for the backup
    // form (csrf token, backup_error query).
    const ctx = stem === "ai" ? { providersCount: await countProviders(db) }
      : stem === "done" ? { crowId: readInstanceCrowId(), req }
      : {};

    const steps = STEP_KEYS.map((k) => ({ label: t(`onboarding.${k}.title`, lang) }));
    const content =
      stepper(steps, current) +
      section(t(`onboarding.${stem}.title`, lang), renderStepBody(stem, lang, ctx)) +
      renderNav(current, lang);

    return layout({ title: t("onboarding.title", lang), content });
  },
};
