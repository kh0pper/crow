/**
 * Legacy Crow-wide sources — what the retired hard-coded integrations list used
 * to spawn, now read from the registry's service bundles (their `connect` block).
 *
 * A service configured today through the gateway's .env (or an installed add-on
 * whose fields are set) keeps starting Crow-wide, exactly as before, until each
 * instance's sources move into a project (the Home migration).
 *
 * Pure: never spawns a child and never writes a file.
 */
import { serviceCatalog, renderDerivedEnv } from "../../shared/service-catalog.js";
import { docsUrl } from "../dashboard/shared/components.js";

// Env-configured Google: not a service bundle yet, so it stays a literal here.
const ENV_GOOGLE = {
  id: "google-workspace",
  name: "Google Workspace",
  description: "Gmail, Calendar, Docs, Sheets, Slides, Chat",
  command: "uvx",
  args: ["workspace-mcp"],
  envVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  requires: ["uvx"],
  keyUrl: "https://console.cloud.google.com/apis/credentials",
  keyInstructions: "Create OAuth 2.0 Client ID (Desktop App type). Enable Gmail, Calendar, Sheets, Docs, and Slides APIs.",
  category: "productivity",
};

// Where the old Settings cards linked for a key (links only; the steps text
// comes from the bundle's connect.steps).
const KEY_URLS = {
  trello: "https://trello.com/power-ups/admin",
  "canvas-lms": "https://community.canvaslms.com/t5/Admin-Guide/How-do-I-manage-API-access-tokens/ta-p/89",
  github: "https://github.com/settings/tokens",
  "brave-search": "https://brave.com/search/api/",
  notion: "https://www.notion.so/my-integrations",
  discord: "https://discord.com/developers/applications",
  zotero: "https://www.zotero.org/settings/keys",
  render: "https://dashboard.render.com/account/api-keys",
  "home-assistant": "https://www.home-assistant.io/docs/authentication/",
};

const CARD_CATEGORIES = new Set(["productivity", "communication", "development"]);

function fieldNames(service) {
  return (service.fields || []).map((f) => f.name);
}

/** The env keys a legacy source is configured by: its fields, or a toggle's enable flag. */
function legacyEnvVars(service) {
  if (service.crowWide) return service.legacyEnableEnv ? [service.legacyEnableEnv] : [];
  return fieldNames(service);
}

function isEnvConfigured(service, env) {
  const vars = legacyEnvVars(service);
  return vars.length > 0 && vars.every((v) => env[v]);
}

function pick(vars, env) {
  const out = {};
  for (const v of vars) if (env[v]) out[v] = env[v];
  return out;
}

/**
 * The Crow-wide sources configured through the environment, in the shape
 * connectToServer() spawns: one per non-toggle service whose every field is set,
 * one per toggle whose legacy enable flag is set, plus env-configured Google.
 * `env` is the child's own vars (fields + derived_env); the spawn layers it over
 * process.env as before.
 *
 * Deleted by PR 4 (Home migration); the google-workspace entry by PR 6.
 */
export function legacyEnvSources(env = process.env, catalog = serviceCatalog()) {
  const out = [];
  for (const service of catalog) {
    if (!isEnvConfigured(service, env)) continue;
    const envVars = legacyEnvVars(service);
    const own = pick(envVars, env);
    out.push({
      id: service.id,
      name: service.name,
      command: service.server.command,
      args: [...service.server.args],
      envVars,
      requires: [...(service.requiresBins || [])],
      env: { ...own, ...renderDerivedEnv(service, own) },
    });
  }
  if (ENV_GOOGLE.envVars.every((v) => env[v])) {
    out.push({
      id: ENV_GOOGLE.id,
      name: ENV_GOOGLE.name,
      command: ENV_GOOGLE.command,
      args: [...ENV_GOOGLE.args],
      envVars: [...ENV_GOOGLE.envVars],
      requires: [...ENV_GOOGLE.requires],
      env: pick(ENV_GOOGLE.envVars, env),
    });
  }
  return out;
}

/**
 * Whether an mcp-addons.json entry still starts Crow-wide. A non-service add-on
 * always does. A service add-on does when every field is set, in its own
 * `entry.env` or in `env` (the add-on child inherits process.env).
 *
 * Deleted by PR 4 (Home migration); the google-workspace entry by PR 6.
 */
export function isLegacyConfiguredAddon(id, entry, catalog = serviceCatalog(), env = process.env) {
  const service = catalog.find((s) => s.id === id);
  if (!service) return true;
  const own = (entry && entry.env) || {};
  return fieldNames(service).every((f) => own[f] || env[f]);
}

/**
 * The Settings → Integrations cards, in the old getProxyStatus card shape
 * (without the live status fields getProxyStatus adds): every service, then
 * env-configured Google.
 *
 * Deleted by PR 4 (Home migration); the google-workspace entry by PR 6.
 */
export function legacyIntegrationsView(catalog = serviceCatalog(), env = process.env) {
  const cards = catalog.map((service) => ({
    id: service.id,
    name: service.name,
    description: service.description,
    configured: isEnvConfigured(service, env),
    envVars: legacyEnvVars(service),
    keyUrl: KEY_URLS[service.id] || null,
    keyInstructions: null,
    steps: [...(service.steps || [])],
    toggleEnv: service.crowWide ? service.legacyEnableEnv : null,
    requires: [...(service.requiresBins || [])],
    docsUrl: docsUrl(`integrations/${service.id}`),
    category: CARD_CATEGORIES.has(service.category) ? service.category : "productivity",
  }));
  cards.push({
    id: ENV_GOOGLE.id,
    name: ENV_GOOGLE.name,
    description: ENV_GOOGLE.description,
    configured: ENV_GOOGLE.envVars.every((v) => env[v]),
    envVars: [...ENV_GOOGLE.envVars],
    keyUrl: ENV_GOOGLE.keyUrl,
    keyInstructions: ENV_GOOGLE.keyInstructions,
    steps: [],
    toggleEnv: null,
    requires: [...ENV_GOOGLE.requires],
    docsUrl: docsUrl("integrations/google-workspace"),
    category: ENV_GOOGLE.category,
  });
  return cards;
}
