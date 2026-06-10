/**
 * First-run onboarding — a hidden, server-rendered guided tour shown once after
 * a new user sets their dashboard password (and replayable from Settings, Help
 * and Setup). Orient-and-route: each step explains one thing and deep-links to
 * the existing surface that does the work. No inline config, no .env writes.
 * Step navigation is a ?step=N query param (no client JS; refresh/back safe).
 */
import { stepper, section, callout, button } from "../shared/components.js";
import { t } from "../shared/i18n.js";
import { parseCookies } from "../auth.js";

const STEP_KEYS = ["welcome", "integrations", "bot", "connect", "done"];

/**
 * Resolve language cookie-first. The panel-dispatch lang derives from the DB
 * "language" setting, which a brand-new user has not set, so it would default
 * to English even for a user who chose Spanish on the setup/login pages. Those
 * pages persist the choice in the crow_lang cookie, so honor it here (matches
 * what settings/sections/help-setup.js already does).
 */
function resolveLang(req) {
  return parseCookies(req).crow_lang === "es" ? "es" : "en";
}

/** A secondary button that opens an existing surface in a new tab so the tour
 *  stays open behind it. */
function deepLink(label, href) {
  return button(label, { variant: "secondary", href, attrs: 'target="_blank" rel="noopener"' });
}

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
        + linkWrap(deepLink(t("onboarding.openConnections", lang), "/dashboard/settings?section=help-setup"));
    case "done":
      return body + callout(t("onboarding.doneNote", lang), "success");
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

  async handler(req, res, { layout }) {
    const lang = resolveLang(req);

    // Clamp step into [0, last]; non-numeric or out-of-range falls to a valid page.
    const raw = parseInt(req.query.step, 10);
    const last = STEP_KEYS.length - 1;
    const current = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), last) : 0;
    const stem = STEP_KEYS[current];

    const steps = STEP_KEYS.map((k) => ({ label: t(`onboarding.${k}.title`, lang) }));
    const content =
      stepper(steps, current) +
      section(t(`onboarding.${stem}.title`, lang), renderStepBody(stem, lang)) +
      renderNav(current, lang);

    return layout({ title: t("onboarding.title", lang), content });
  },
};
