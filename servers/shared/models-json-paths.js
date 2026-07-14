/**
 * models.json search-path resolution — the ONE source of truth for where
 * provider config files may live, shared by the seed/sync path
 * (providers-db.js) and the runtime loader (providers.js).
 *
 * CROW_MODELS_JSON (env, colon-separated paths) overrides the defaults at
 * CALL time: set it to "" for "no models.json anywhere" (hermetic tests,
 * fresh-install audits) or to explicit fixture paths. Unset = the three
 * standard locations. The repo no longer ships a tracked models.json —
 * see models.example.json for the format.
 */
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || homedir();

const REPO_PATHS = [
  resolve(__dirname, "../../models.json"),
  resolve(__dirname, "../../config/models.json"),
];
const DEFAULT_PATHS = [
  ...REPO_PATHS,
  resolve(HOME, ".pi/agent/models.json"),
];

function envOverride() {
  const env = process.env.CROW_MODELS_JSON;
  if (env === undefined) return null;
  return env.split(":").filter(Boolean);
}

/**
 * Seed/sync search paths (providers-db.js): repo, config, pi-agent — merged
 * by the caller. Honors the CROW_MODELS_JSON override.
 * @returns {string[]}
 */
export function modelsJsonSearchPaths() {
  return envOverride() ?? DEFAULT_PATHS;
}

/**
 * Runtime-loader search paths (providers.js): repo + config only, first file
 * wins in the caller — the pi-agent file has never fed the runtime loader and
 * must not start to. Honors the same CROW_MODELS_JSON override.
 * @returns {string[]}
 */
export function repoModelsJsonSearchPaths() {
  return envOverride() ?? REPO_PATHS;
}
