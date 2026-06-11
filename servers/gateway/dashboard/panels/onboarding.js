/**
 * First-run onboarding — a hidden, server-rendered guided tour shown once after
 * a new user sets their dashboard password (and replayable from Settings, Help
 * and Setup). Orient-and-route: each step explains one thing and deep-links to
 * the existing surface that does the work. No inline config, no .env writes.
 * Step navigation is a ?step=N query param (no client JS; refresh/back safe).
 *
 * W3-3 additions:
 *   - Reaching the "done" step sets onboarding_completed_at (first time only)
 *   - Done step shows a subtle CSS-only celebration + three "what to try" cards
 */
import { stepper, section, callout, button } from "../shared/components.js";
import { t, SUPPORTED_LANGS } from "../shared/i18n.js";
import { parseCookies } from "../auth.js";
import { upsertSetting, readSetting } from "../settings/registry.js";

const STEP_KEYS = ["welcome", "integrations", "bot", "connect", "done"];

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
 * Three "what to try first" action cards shown on the done step (W3-3).
 * Each card is a link, description, and CTA button.
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
  ];

  const cardHtml = cards.map(c => `
    <div class="onboarding-action-card">
      <div class="onboarding-action-card-title">${t(c.titleKey, lang)}</div>
      <div class="onboarding-action-card-body">${t(c.bodyKey, lang)}</div>
      ${button(t(c.actionKey, lang), { variant: "secondary", size: "sm", href: c.href, attrs: 'target="_blank" rel="noopener"' })}
    </div>`).join("");

  return `<div class="onboarding-action-cards">${cardHtml}</div>`;
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
</style>
`;

function renderStepBody(stem, lang) {
  const body = `<p style="font-size:var(--crow-text-base);line-height:var(--crow-leading-relaxed);color:var(--crow-text-secondary);margin-bottom:var(--crow-space-4)">${t(`onboarding.${stem}.body`, lang)}</p>`;
  const linkWrap = (html) => `<div style="margin-top:var(--crow-space-4)">${html}</div>`;
  switch (stem) {
    case "integrations":
      return body + callout(t("onboarding.integrationsNote", lang), "info")
        + linkWrap(deepLink(t("onboarding.openIntegrations", lang), "/dashboard/settings?section=integrations"));
    case "bot":
      return body + linkWrap(deepLink(t("onboarding.openBotBuilder", lang), "/dashboard/bot-builder"));
    case "connect":
      return body + callout(t("onboarding.connectNote", lang), "info")
        + linkWrap(deepLink(t("onboarding.openConnections", lang), "/dashboard/connect"));
    case "done": {
      const celebrateHtml = `${CELEBRATION_CSS}<div class="onboarding-celebrate">
        <div class="onboarding-celebrate-check" aria-hidden="true">&#10003;</div>
        <span class="onboarding-celebrate-label">${t("onboarding.celebration", lang)}</span>
      </div>`;
      return celebrateHtml + body + callout(t("onboarding.doneNote", lang), "success")
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

    const steps = STEP_KEYS.map((k) => ({ label: t(`onboarding.${k}.title`, lang) }));
    const content =
      stepper(steps, current) +
      section(t(`onboarding.${stem}.title`, lang), renderStepBody(stem, lang)) +
      renderNav(current, lang);

    return layout({ title: t("onboarding.title", lang), content });
  },
};
