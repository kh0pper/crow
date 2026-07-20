/**
 * First-run onboarding — a hidden, server-rendered guided tour shown once after
 * a new user sets their dashboard password (and replayable from Settings, Help
 * and Setup). Orient-and-route: each step explains one thing and deep-links to
 * the existing surface that does the work. No inline config, no .env writes.
 * Step navigation is a ?step=N query param, so every step but one is
 * refresh/back-safe with no client JS. The exception is the ai step (Task 7):
 * it ships a small client script (ai-step-client.js) for the local-download
 * progress UI and catalog-derived card facts — the rest of the wizard stays
 * 100% server-rendered.
 *
 * W3-3 additions:
 *   - Reaching the "done" step sets onboarding_completed_at (first time only)
 *   - Done step shows a subtle CSS-only celebration + "what to try" cards
 */
import { stepper, section, callout, button, escapeHtml, docsUrl } from "../shared/components.js";
import { t, SUPPORTED_LANGS } from "../shared/i18n.js";
import { parseCookies } from "../auth.js";
import { upsertSetting, readSetting } from "../settings/registry.js";
import { loadCollections } from "./extensions/collections.js";
import { csrfInput } from "../shared/csrf.js";
import { buildIdentityBackup, loadInstanceSeed, deriveInstanceIdentity } from "../../../sharing/identity.js";
import { instanceSeedDir } from "../../../../scripts/pi-bots/instance-paths.mjs";
import { CLOUD_PRESETS } from "./onboarding/cloud-presets.js";
import { aiStepClientJS } from "./onboarding/ai-step-client.js";
import { upsertProvider } from "../../../shared/providers-db.js";
import { invalidateProvidersCache } from "../../../shared/providers.js";
import { seedStarterMemories, createStarterArtifacts, resolveStarterProvider } from "./onboarding/starter-content.js";

/** Exported so tests derive step positions (indexOf/length) instead of pinning indices. */
export const STEP_KEYS = ["welcome", "ai", "integrations", "bot", "starter", "connect", "meet", "done"];

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
 * Three-choice AI-step CSS (Task 7): the option cards (radio + title + desc)
 * and the local card's download/progress area. Scoped classnames, design
 * tokens only — no fixed colors, matches every other panel's inline
 * <style> block convention (CELEBRATION_CSS/CARD_CSS above).
 */
const AI_OPTIONS_CSS = `
<style>
.onb-ai-options {
  display: grid;
  gap: var(--crow-space-3);
  margin-bottom: var(--crow-space-4);
}
.onb-ai-option {
  display: flex;
  align-items: flex-start;
  gap: var(--crow-space-3);
  padding: var(--crow-space-3) var(--crow-space-4);
  border: 1px solid var(--crow-border);
  border-radius: 10px;
  cursor: pointer;
  background: var(--crow-bg-surface);
}
.onb-ai-option input[type="radio"] {
  /* Scoped override for the global input reset (layout.js's unscoped
   * input, textarea, select { width: 100%; ... } rule) — that rule is not
   * excluded for type=radio/checkbox, so without this the radio inflates
   * to the full row width and crushes the title+desc column to a sliver
   * (CDP round finding #2, C1-B Task 9). Fix here, not in the global
   * reset, to keep this PR's blast radius contained; the global gap is a
   * separate residual-minors candidate (other radios/checkboxes in the
   * app may have quietly compensated for it and could regress).
   */
  width: auto;
  flex: 0 0 auto;
  background: none;
  border: none;
  padding: 0;
  margin-top: 3px;
  flex-shrink: 0;
}
.onb-ai-option-title {
  font-weight: 600;
  font-size: var(--crow-text-sm);
  color: var(--crow-text-primary);
}
.onb-ai-option-desc {
  font-size: var(--crow-text-sm);
  color: var(--crow-text-secondary);
  margin-top: 2px;
}
.onb-ai-panel {
  border: 1px solid var(--crow-border);
  border-radius: 10px;
  padding: var(--crow-space-4);
  margin-bottom: var(--crow-space-4);
  background: var(--crow-bg-surface);
}
.onb-ai-card > div {
  margin-bottom: var(--crow-space-2);
  font-size: var(--crow-text-sm);
  color: var(--crow-text-secondary);
}
.onb-ai-card > div:first-child {
  font-weight: 600;
  color: var(--crow-text-primary);
  font-size: var(--crow-text-base);
}
.onb-ai-field {
  display: block;
  font-size: var(--crow-text-sm);
  color: var(--crow-text-secondary);
  margin-bottom: var(--crow-space-3);
}
.onb-ai-field select,
.onb-ai-field input {
  display: block;
  width: 100%;
  max-width: 360px;
  margin-top: 2px;
  padding: 0.4rem 0.6rem;
  background: var(--crow-bg-deep);
  border: 1px solid var(--crow-border);
  border-radius: 6px;
  color: var(--crow-text-primary);
}
.onb-ai-free-blurb {
  font-size: var(--crow-text-sm);
  color: var(--crow-text-tertiary);
  margin-bottom: var(--crow-space-3);
}
.onb-ai-progress-track {
  height: 6px;
  border-radius: 3px;
  background: var(--crow-bg-deep);
  overflow: hidden;
  margin-bottom: var(--crow-space-2);
}
.onb-ai-progress-bar {
  height: 100%;
  width: 0%;
  background: var(--crow-accent);
  transition: width 0.3s ease;
}
.onb-ai-status {
  font-size: var(--crow-text-sm);
  color: var(--crow-text-secondary);
}
.onb-ai-status--done {
  color: var(--crow-success);
  font-weight: 600;
}
</style>
`;

/**
 * The onboarding AI step's three-choice layout (Task 7): local (default,
 * in-wizard download), cloud (paste-a-key form), skip. Server renders
 * labels + a skeleton local card only — `ai-step-client.js`'s script fills
 * in every catalog-derived fact from its own client fetch (module doc for
 * why: exactly one GET /api/models/catalog, no SSR probe duplication).
 *
 * `?cloud=ok` (set by handleCloudProviderPost's redirect) both shows the
 * success callout AND pre-selects/reveals the cloud panel — a user who just
 * added a provider should land back looking at what they added, not the
 * local card the wizard defaults to otherwise. `?cloud_error=<code>` (Task 7
 * review fix round 1) does the same for a failed submission: reveals the
 * cloud panel so the user lands back on the form they were filling in,
 * with an error callout instead of a page-replacing 400/500. `code` is a
 * closed enum — CLOUD_ERROR_KEYS below is the only place that maps it to an
 * i18n key, so an unrecognized value (a stale link, a typo) renders nothing.
 * @param {string} lang
 * @param {{req?: object}} [ctx]
 */
const CLOUD_ERROR_KEYS = {
  bad_preset: "onboarding.ai.cloudErrBadPreset",
  missing_key: "onboarding.ai.cloudErrMissingKey",
  save_failed: "onboarding.ai.cloudErrSaveFailed",
};

/**
 * The meet step's `?err=` closed enum (same discipline as CLOUD_ERROR_KEYS
 * above): `no_provider` is reserved strictly for handleMeetPost's
 * `{error:"no_provider"}` result (createStarterArtifacts found nothing
 * usable at POST time); `setup_failed` (review fix round 1, Task 8) is
 * every OTHER exception the POST handler catches — a distinct, generic,
 * honest message rather than mislabeling an arbitrary failure as "no
 * provider available". An unrecognized code renders no callout.
 */
const MEET_ERROR_KEYS = {
  no_provider: "onboarding.meet.err",
  setup_failed: "onboarding.meet.errGeneric",
};

function renderAiOptions(lang, ctx = {}) {
  const req = ctx.req || null;
  const cloudOk = !!(req && req.query && req.query.cloud === "ok");
  const cloudErrorKey = CLOUD_ERROR_KEYS[req && req.query ? req.query.cloud_error : undefined] || null;
  const cloudChecked = cloudOk || !!cloudErrorKey;
  const localChecked = !cloudChecked;

  const firstPreset = CLOUD_PRESETS[0] || null;
  const presetOptions = CLOUD_PRESETS.map((p) =>
    `<option value="${escapeHtml(p.id)}" data-default-model="${escapeHtml(p.defaultModel)}" data-key-hint="${escapeHtml(p.keyHint)}">${escapeHtml(p.label)}</option>`
  ).join("");

  const cloudSuccess = cloudOk ? callout(t("onboarding.ai.cloudAdded", lang), "success") : "";
  const cloudError = cloudErrorKey ? callout(t(cloudErrorKey, lang), "error") : "";
  const docsHref = docsUrl((lang === "es" ? "es/" : "") + "guide/ai-providers");

  return `${AI_OPTIONS_CSS}
    <div class="onb-ai-options">
      <label class="onb-ai-option">
        <input type="radio" name="onbAiChoice" id="onb-ai-radio-local" value="local"${localChecked ? " checked" : ""}>
        <span>
          <span class="onb-ai-option-title">${t("onboarding.ai.optionLocalTitle", lang)}</span><br>
          <span class="onb-ai-option-desc">${t("onboarding.ai.optionLocalDesc", lang)}</span>
        </span>
      </label>
      <label class="onb-ai-option">
        <input type="radio" name="onbAiChoice" id="onb-ai-radio-cloud" value="cloud"${cloudChecked ? " checked" : ""}>
        <span>
          <span class="onb-ai-option-title">${t("onboarding.ai.optionCloudTitle", lang)}</span><br>
          <span class="onb-ai-option-desc">${t("onboarding.ai.optionCloudDesc", lang)}</span>
        </span>
      </label>
      <label class="onb-ai-option">
        <input type="radio" name="onbAiChoice" id="onb-ai-radio-skip" value="skip">
        <span>
          <span class="onb-ai-option-title">${t("onboarding.ai.optionSkipTitle", lang)}</span><br>
          <span class="onb-ai-option-desc">${t("onboarding.ai.optionSkipDesc", lang)}</span>
        </span>
      </label>
    </div>

    <div id="onb-ai-panel-local" class="onb-ai-panel"${localChecked ? "" : " hidden"}>
      <div class="onb-ai-card">
        <div id="onb-ai-local-name">${t("common.loading", lang)}</div>
        <div id="onb-ai-local-size"></div>
        <div id="onb-ai-local-fit"></div>
        <div id="onb-ai-local-upsell" hidden></div>
        <div id="onb-ai-local-action"></div>
      </div>
    </div>

    <div id="onb-ai-panel-cloud" class="onb-ai-panel"${cloudChecked ? "" : " hidden"}>
      ${cloudSuccess}
      ${cloudError}
      <form method="POST" action="/dashboard/onboarding/cloud-provider">
        ${csrfInput(req)}
        <label class="onb-ai-field">${t("onboarding.ai.cloudProviderLabel", lang)}
          <select name="preset" id="onb-ai-cloud-preset">${presetOptions}</select>
        </label>
        <label class="onb-ai-field">${t("onboarding.ai.cloudKeyLabel", lang)}
          <input type="password" name="apiKey" id="onb-ai-cloud-key" autocomplete="off" required placeholder="${escapeHtml(firstPreset ? firstPreset.keyHint : "")}">
        </label>
        <label class="onb-ai-field">${t("onboarding.ai.cloudModelLabel", lang)}
          <input type="text" name="model" id="onb-ai-cloud-model" value="${escapeHtml(firstPreset ? firstPreset.defaultModel : "")}">
        </label>
        <p class="onb-ai-free-blurb">${t("onboarding.ai.cloudFreeTiersBlurb", lang)} <a href="${docsHref}" target="_blank" rel="noopener">${t("onboarding.ai.cloudDocsLinkLabel", lang)}</a></p>
        ${button(t("onboarding.ai.cloudSubmit", lang), { variant: "primary", type: "submit" })}
      </form>
    </div>

    <div id="onb-ai-panel-skip" class="onb-ai-panel" hidden>
      <p style="font-size:var(--crow-text-sm);color:var(--crow-text-secondary)">${t("onboarding.ai.optionSkipDesc", lang)}</p>
    </div>

    ${aiStepClientJS(lang)}`;
}

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
 * POST /dashboard/onboarding/cloud-provider — hand-registered in
 * dashboard/index.js the same way as handleIdentityBackupPost, BEHIND
 * dashboardAuth + csrfMiddleware. The cloud option's paste-a-key form
 * (`renderAiOptions` above). dashboard/index.js's route wrapper supplies
 * `{ db }` (mirroring the fix-it action POST's inline db-lifecycle
 * wrapper); `upsertProviderFn`/`invalidateCacheFn` are injectable seams
 * for tests, defaulting to the real providers-db.js / providers.js calls.
 *
 * Task 7 review fix round 1: every failure path redirects back to the ai
 * step instead of replacing the whole page with a bare 400/500 — mirrors
 * handleIdentityBackupPost's `back()` discipline above. `cloud_error` is a
 * closed enum (bad_preset | missing_key | save_failed); renderAiOptions
 * maps it to an i18n key and ignores anything else, so an unexpected query
 * value renders no callout rather than an arbitrary string.
 *
 * Never logs or echoes the API key — mirrors handleIdentityBackupPost's
 * discipline with the passphrase: only `err.message` reaches console.error.
 */
export async function handleCloudProviderPost(req, res, opts = {}) {
  const {
    db = null,
    upsertProviderFn = upsertProvider,
    invalidateCacheFn = invalidateProvidersCache,
  } = opts;
  const aiIdx = STEP_KEYS.indexOf("ai");
  const back = (code) =>
    res.redirectAfterPost(`/dashboard/onboarding?step=${aiIdx}&cloud_error=${encodeURIComponent(code)}`);
  try {
    const presetId = typeof req.body?.preset === "string" ? req.body.preset : "";
    const preset = CLOUD_PRESETS.find((p) => p.id === presetId);
    if (!preset) return back("bad_preset");
    const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
    if (!apiKey) return back("missing_key");
    const modelField = typeof req.body?.model === "string" && req.body.model.trim()
      ? req.body.model.trim()
      : preset.defaultModel;

    await upsertProviderFn(db, {
      id: preset.id,
      baseUrl: preset.baseUrl,
      apiKey,
      host: "cloud",
      bundleId: null,
      description: preset.label + " (onboarding)",
      models: [{ id: modelField }],
      disabled: false,
      providerType: preset.providerType,
    });
    await invalidateCacheFn();
    return res.redirectAfterPost(`/dashboard/onboarding?step=${aiIdx}&cloud=ok`);
  } catch (err) {
    console.error("[onboarding] cloud provider setup failed:", err.message); // message only — never the api key
    return back("save_failed");
  }
}

/**
 * Mark onboarding complete (first time only). Shared by the "done" step's
 * GET render (W3-3) and Task 8's meet-step POST below — reaching either one
 * means the user finished the tour, and the flag must only ever be written
 * once (idempotent replay from Settings must not touch it again).
 * @param {{execute: Function}|null} db
 * @returns {Promise<void>}
 */
async function stampOnboardingCompleted(db) {
  if (!db) return;
  try {
    const existing = await readSetting(db, "onboarding_completed_at");
    if (!existing) {
      await upsertSetting(db, "onboarding_completed_at", new Date().toISOString());
    }
  } catch {}
}

/**
 * POST /dashboard/onboarding/meet — hand-registered in dashboard/index.js the
 * same way as handleIdentityBackupPost/handleCloudProviderPost, BEHIND
 * dashboardAuth + csrfMiddleware. The "Meet your Crow" step's CTA
 * (renderStepBody's "meet" case below): seeds the starter memories (Task 2)
 * and the starter agent + conversation (Task 3), then hands the user
 * straight into that conversation via the `?ai=` deep-link (Task 6) instead
 * of routing back through the "done" step — reaching this endpoint
 * successfully IS finishing the tour, so it stamps
 * onboarding_completed_at itself (stampOnboardingCompleted above — same
 * first-write-only guard the "done" step's GET uses).
 *
 * `seedStarterMemoriesFn`/`createStarterArtifactsFn` are injectable seams for
 * tests (Task 7's `upsertProviderFn`/`invalidateCacheFn` pattern), defaulting
 * to the real starter-content.js exports. Both calls are individually
 * idempotent (starter-content.js module doc), so a double-submit or a retry
 * after a redirect never duplicates the starter memories, bot, or
 * conversation — the client-side onsubmit guard in the "meet" case below is
 * belt-and-suspenders, not load-bearing.
 *
 * `createStarterArtifactsFn` returning `{error:"no_provider"}` is the one
 * failure mode the spec defines (a race between the GET, which hides the
 * form once resolveStarterProvider() finds nothing usable, and the POST —
 * e.g. two open tabs); it is the ONLY path that carries `err=no_provider`.
 * Review fix round 1 (Task 8): any other unexpected failure — a throw from
 * either seam, a bad db, anything not explicitly the no_provider result —
 * redirects with `err=setup_failed` instead, a generic honest message
 * rather than mislabeling an arbitrary exception as "no AI provider
 * available" (which may simply be false). Never logs anything beyond
 * `err.message` — there is no request-body secret here, but the pattern is
 * kept consistent with identity-backup/cloud-provider.
 */
export async function handleMeetPost(req, res, opts = {}) {
  const {
    db = null,
    seedStarterMemoriesFn = seedStarterMemories,
    createStarterArtifactsFn = createStarterArtifacts,
  } = opts;
  const lang = resolveLang(req);
  const meetIdx = STEP_KEYS.indexOf("meet");
  const back = (code) =>
    res.redirectAfterPost(`/dashboard/onboarding?step=${meetIdx}&err=${encodeURIComponent(code)}`);
  try {
    await seedStarterMemoriesFn(db, lang);
    const result = await createStarterArtifactsFn(db, { lang });
    if (result && result.error === "no_provider") {
      return back("no_provider");
    }
    await stampOnboardingCompleted(db);
    return res.redirectAfterPost(`/dashboard/messages?ai=${result.conversationId}`);
  } catch (err) {
    console.error("[onboarding] meet-your-crow setup failed:", err.message); // message only
    return back("setup_failed");
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
 * Resolve the starter provider for the meet step's render gate, honestly
 * folding a throw to null. Review fix round 1 (Task 8): the meet step must
 * render the SAME empty state (no form, advice-shaped callout) whether
 * resolveStarterProvider() legitimately found nothing usable or blew up —
 * neither case may crash the wizard, and the copy shown must not assert a
 * specific cause that could be false in the throw case.
 * `resolveFn` is an injectable seam (tests), defaulting to the real
 * starter-content.js export.
 * @param {object|null} db
 * @param {Function} resolveFn
 * @returns {Promise<{providerId: string, modelId: string}|null>}
 */
async function safeResolveStarterProvider(db, resolveFn) {
  if (!db) return null;
  try {
    return await resolveFn(db);
  } catch {
    return null;
  }
}

/**
 * @param {string} stem - STEP_KEYS entry
 * @param {string} lang
 * @param {{providersCount?: number|null, starterProvider?: {providerId: string, modelId: string}|null, crowId?: string|null, req?: object}} [ctx]
 *   - server-fetched data the step body needs (ai: providersCount; meet:
 *     starterProvider — resolveStarterProvider()'s result, null when there
 *     is nothing usable or the resolve threw; done: crowId + req for the
 *     backup form); handler-populated so this stays sync.
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
        + linkWrap(deepLink(t("onboarding.openProviders", lang), "/dashboard/settings?section=llm&tab=providers"))
        + renderAiOptions(lang, ctx);
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
    case "meet": {
      // Review fix round 1 (Task 8): gates on the SAME question the POST
      // handler actually answers — "is there a usable starter provider?"
      // (resolveStarterProvider(db), fetched by the handler below into
      // ctx.starterProvider) — rather than providersCount, which counts any
      // enabled providers row including empty-models[] placeholders (e.g.
      // no_auto_provider) that resolveStarterProvider treats as unusable.
      // Gating on the wrong signal let a doomed POST through: live CTA
      // renders, POST fires, createStarterArtifacts finds nothing usable,
      // bounces err=no_provider after a wasted seed write. A falsy
      // starterProvider (including a resolve() throw, which the handler
      // below folds to null) hides the CTA and shows the same honest
      // empty-state callout — see onboarding.meet.noProvider's softened,
      // advice-shaped copy for why it must not assert a specific cause.
      const starterProvider = ctx.starterProvider;
      const req = ctx.req || null;
      const errParam = req && req.query ? req.query.err : null;
      const errorKey = MEET_ERROR_KEYS[errParam] || null;
      const errorHtml = errorKey ? callout(t(errorKey, lang), "error") : "";
      const aiIdx = STEP_KEYS.indexOf("ai");
      if (!starterProvider) {
        return body + errorHtml
          + callout(t("onboarding.meet.noProvider", lang), "info")
          + linkWrap(button(t("onboarding.ai.title", lang), { variant: "secondary", href: `/dashboard/onboarding?step=${aiIdx}` }));
      }
      return body + errorHtml + `
        <form method="POST" action="/dashboard/onboarding/meet" data-turbo="false" onsubmit="this.querySelector('button').disabled=true">
          <!-- Full page load required: the messages ?ai= deep-link only arms on real loads (R2-M2) -->
          ${csrfInput(req)}
          ${button(t("onboarding.meet.cta", lang), { variant: "primary", type: "submit" })}
        </form>`;
    }
    case "done": {
      const celebrateHtml = `${CELEBRATION_CSS}<div class="onboarding-celebrate">
        <div class="onboarding-celebrate-check" aria-hidden="true">&#10003;</div>
        <span class="onboarding-celebrate-label">${t("onboarding.celebration", lang)}</span>
      </div>`;
      // Spec C1 "skip": when no provider is configured, agents/chat/voice are
      // dormant — say so plainly and link back to the ai step (same target
      // the meet step's empty state points at).
      const dormantHtml = ctx.providersCount === 0
        ? callout(t("onboarding.doneDormant", lang), "warning")
          + linkWrap(button(t("onboarding.ai.title", lang), { variant: "secondary", href: `/dashboard/onboarding?step=${STEP_KEYS.indexOf("ai")}` }))
        : "";
      return celebrateHtml + body + callout(t("onboarding.doneNote", lang), "success")
        + dormantHtml
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
    // id is a hook for ai-step-client.js's highlightNext() — purely additive,
    // no other step reads it.
    parts.push(button(t("onboarding.btnNext", lang), { variant: "primary", href: `/dashboard/onboarding?step=${current + 1}`, attrs: 'id="onboarding-next-btn"' }));
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

  async handler(req, res, { db, layout, resolveStarterProviderFn = resolveStarterProvider }) {
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
    if (stem === "done") await stampOnboardingCompleted(db);

    // The ai step's copy and the done step's dormant callout are conditional
    // on whether ANY provider is configured (providersCount); the meet step
    // gates on a narrower, different question — is there a provider the
    // starter agent can actually USE (resolveStarterProvider(db), review fix
    // round 1 Task 8) — since a provider row can be enabled with an empty
    // models[] (e.g. a no_auto_provider placeholder) and still count as
    // "configured". `resolveStarterProviderFn` is an injectable seam
    // (tests), defaulting to the real starter-content.js export; wrapped in
    // safeResolveStarterProvider so a throw is folded to null (honest empty
    // state) instead of crashing the wizard. The done step also needs the
    // instance crowId (nullable) + req for the backup form (csrf token,
    // backup_error query); the meet step needs req for its csrf token +
    // ?err= query.
    const ctx = stem === "ai" ? { providersCount: await countProviders(db), req }
      : stem === "meet" ? { starterProvider: await safeResolveStarterProvider(db, resolveStarterProviderFn), req }
      : stem === "done" ? { crowId: readInstanceCrowId(), req, providersCount: await countProviders(db) }
      : {};

    const steps = STEP_KEYS.map((k) => ({ label: t(`onboarding.${k}.title`, lang) }));
    const content =
      stepper(steps, current) +
      section(t(`onboarding.${stem}.title`, lang), renderStepBody(stem, lang, ctx)) +
      renderNav(current, lang);

    return layout({ title: t("onboarding.title", lang), content });
  },
};
