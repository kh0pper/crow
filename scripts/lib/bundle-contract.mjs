/**
 * Bundle manifest contract — the single source of validation logic, shared by
 * scripts/build-registry.mjs and tests/bundle-contract.test.js.
 *
 * Two layers: (1) shape via ajv against registry/manifest.schema.json, and
 * (2) filesystem referential integrity (declared surface files exist, id ==
 * dirname, dependency bundles exist) — which JSON Schema cannot express.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute, basename } from "node:path";
import Ajv from "ajv";
import { INVITE_HANDLER_NAMES, isInviteHandlerName } from "../../servers/gateway/first-admin/registry.js";
import { firstAdminAfterProblems } from "../../servers/gateway/bundle-first-admin-after.js";
// The "is this a plain path inside the bundle" rule and the panel-id rule live in one leaf
// module, shared with routes/bundles.js (which skips such a value at install) and
// compose-guard.js: a manifest the contract refuses is the same value the runtime refuses.
import { badBundlePath, badPanelId, launcherPathValues } from "../../servers/shared/bundle-declared-paths.js";

const schema = JSON.parse(
  readFileSync(new URL("../../registry/manifest.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv({ allErrors: true, strict: false });
const validateShape = ajv.compile(schema);

// --- G-6 anti-rot: inference-endpoint provider contract + instance-leak scan ---

/** A compose `ports:` stanza, list or inline-array form (heuristic — text match, not a YAML parse). */
const PORT_MAPPING_RE = /\bports:\s*(\n[ \t]*-[ \t]*\S.*|[ \t]*\[[^\]]*\])/;
/** Command/entrypoint markers that smell like an OpenAI-compat inference server. */
const INFERENCE_CMD_RE = /--served-model-name|llama-server|vllm|ollama/i;
/** A compose `command:` key present at all (list or inline form) — i.e. an image-default entrypoint is NOT being used as-is. */
const COMMAND_OVERRIDE_RE = /\bcommand:\s*(\n[ \t]*-[ \t]*\S|\[[^\]]*\]|\S)/;
/**
 * Image names that ship a self-contained OpenAI-compat server with no compose
 * command override at all (models arrive post-install via the image's own
 * CLI/API, e.g. LocalAI's `local-ai models install <name>` / first-use
 * download — the same "unknowable at manifest-write time" shape as ollama).
 * Only consulted when there is NO command override (see below) — a bundle
 * that overrides the command is judged on that command, not its image name.
 */
const INFERENCE_IMAGE_RE = /\bimage:\s*.*\blocal-?ai\b/i;

/**
 * Heuristic-only (WARN, never fails the build): does this bundle's compose file
 * expose a host port AND run something that looks like an OpenAI-compat
 * inference server? Matched against the raw file text (not a real YAML parse
 * — no yaml dependency in this repo, and a text heuristic is all a WARN
 * needs). Two ways to trip it:
 *   1. a command/entrypoint marker (--served-model-name/llama-server/vllm/ollama)
 *      anywhere in the file, or
 *   2. no `command:` override at all, and the image name matches a known
 *      self-contained-server pattern (currently just localai/local-ai).
 */
function composeLooksLikeInferenceEndpoint(bundleDir, composefileRel) {
  if (typeof composefileRel !== "string" || !composefileRel) return false;
  const p = isAbsolute(composefileRel) ? composefileRel : join(bundleDir, composefileRel);
  if (!existsSync(p)) return false;
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return false;
  }
  if (!PORT_MAPPING_RE.test(text)) return false;
  if (INFERENCE_CMD_RE.test(text)) return true;
  if (!COMMAND_OVERRIDE_RE.test(text) && INFERENCE_IMAGE_RE.test(text)) return true;
  return false;
}

/** Tailscale CGNAT range: 100.64.0.0/10 (100.64.x.x - 100.127.x.x). */
const TAILSCALE_IP_RE = /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/;
/** Any *.ts.net hostname (Tailscale MagicDNS). */
const TS_NET_RE = /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net\b/i;
/** 32-hex-char instance-id shape (as minted by servers/shared instance-identity code). */
const INSTANCE_ID_HEX32_RE = /^[0-9a-f]{32}$/i;
const ALLOWED_HOST_VALUES = new Set(["local", "cloud"]);

/**
 * Recursively scan every string value in a manifest for a leaked Tailscale
 * identity: a tailnet IP, a *.ts.net hostname, or (scoped to keys literally
 * named "host") a 32-hex instance-id string other than "local"/"cloud".
 * This is the generalized form of the #217 leak class (see
 * bundles/vllm-cuda-*'s host de-pin, Task 15) — run against every string in
 * every manifest, not just a hardcoded field.
 */
function scanForInstanceLeaks(value, path, errors) {
  if (value == null) return;
  if (typeof value === "string") {
    if (TAILSCALE_IP_RE.test(value)) {
      errors.push(`leaked Tailscale-range IP in ${path}: "${value}"`);
    }
    if (TS_NET_RE.test(value)) {
      errors.push(`leaked *.ts.net hostname in ${path}: "${value}"`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanForInstanceLeaks(v, `${path}[${i}]`, errors));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const childPath = path ? `${path}.${k}` : k;
      if (k === "host" && typeof v === "string" && INSTANCE_ID_HEX32_RE.test(v) && !ALLOWED_HOST_VALUES.has(v)) {
        errors.push(`leaked instance-id-shaped value in ${childPath}: "${v}" (host must be "local"/"cloud", not a pinned peer id)`);
      }
      scanForInstanceLeaks(v, childPath, errors);
    }
  }
}

/** Surfaces a manifest declares, by key presence. */
export function detectSurfaces(manifest) {
  const s = [];
  if (manifest && manifest.docker) s.push("docker");
  if (manifest && manifest.server) s.push("server");
  if (manifest && manifest.panel) s.push("panel");
  if (manifest && manifest.panelRoutes) s.push("panelRoutes");
  if (manifest && Array.isArray(manifest.widgets) && manifest.widgets.length) s.push("widgets");
  if (manifest && Array.isArray(manifest.skills) && manifest.skills.length) s.push("skills");
  return s;
}

function fileExists(bundleDir, rel) {
  if (typeof rel !== "string" || !rel) return false;
  const p = isAbsolute(rel) ? rel : join(bundleDir, rel);
  return existsSync(p);
}

/**
 * `firstAdmin` — how the bundle's OWN first admin account comes to exist
 * (security audit N3-4). A freshly installed web app's first-run setup page is
 * reachable over loopback by anything else on the machine, so every bundle
 * with a web UI must say which of the five modes it is:
 *
 *   crow           Crow creates the admin at install — from the environment, a
 *                  postInstall hook, or (via "setup") a script it runs with the
 *                  password on stdin. Nothing to claim.
 *   finish-setup   the app has its own first-run admin page; the operator must
 *                  finish it now (Crow shows the notice).
 *   default-login  the app ships a documented default login (user + password).
 *   external       it connects to an app the operator already runs; its login
 *                  is that app's (Immich, Kodi) — nothing of ours to claim.
 *   none           no login of its own (public/anonymous UI, or a viewer whose
 *                  gate Crow already applies).
 *
 * One field rides on `finish-setup` (security audit N3-4 phase 2e):
 *
 *   invite         `"finish-setup"` plus `"invite": "vaultwarden"` says Crow can
 *                  make the app INVITE-ONLY through the app's own admin API: it
 *                  invites the owner's email and closes sign-ups. The value is a
 *                  name from Crow's CODE-HELD handler list
 *                  (servers/gateway/first-admin/registry.js), never a path, a URL
 *                  or anything else the manifest supplies.
 *
 * The last rule is the load-bearing one: a webUI without a firstAdmin is an
 * undeclared claim surface, so `build-registry --check` fails it (at runtime
 * the same manifest is treated as `finish-setup` — the warning shows rather
 * than disappearing).
 */
export const FIRST_ADMIN_MODES = Object.freeze(["crow", "finish-setup", "default-login", "external", "none"]);

/** A bundle file's text, or null when it is missing/unreadable. */
function readBundleFile(bundleDir, rel) {
  if (typeof rel !== "string" || !rel) return null;
  const p = isAbsolute(rel) ? rel : join(bundleDir, rel);
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}

function validateFirstAdmin(manifest, bundleDir) {
  const errors = [];
  const fa = manifest ? manifest.firstAdmin : undefined;
  const hasWebUI = !!(manifest && manifest.webUI && typeof manifest.webUI === "object");
  if (fa === undefined || fa === null) {
    if (hasWebUI) {
      errors.push(
        `firstAdmin: a bundle with a webUI must declare firstAdmin (mode ${FIRST_ADMIN_MODES.map((m) => `"${m}"`).join(", ")}) — ` +
          `say how its own first admin is created, or who has to finish its setup`,
      );
    }
    return errors;
  }
  if (typeof fa !== "object" || Array.isArray(fa)) {
    errors.push("firstAdmin must be an object");
    return errors;
  }
  const mode = fa.mode;
  if (!FIRST_ADMIN_MODES.includes(mode)) {
    errors.push(`firstAdmin.mode must be one of ${FIRST_ADMIN_MODES.join(", ")}`);
    return errors; // every mode-specific rule below would only add noise
  }
  if (fa.path !== undefined && (typeof fa.path !== "string" || !fa.path.startsWith("/"))) {
    errors.push(`firstAdmin.path must be an app path starting with "/"`);
  }
  if (fa.note !== undefined && typeof fa.note !== "string") errors.push("firstAdmin.note must be a string");
  // `invite` (N3-4 phase 2e): only on a finish-setup app, and only a handler name
  // Crow really ships — a manifest names code, it never supplies it.
  if (fa.invite !== undefined) {
    if (mode !== "finish-setup") {
      errors.push(`firstAdmin.invite is only allowed with mode "finish-setup"`);
    } else if (!isInviteHandlerName(fa.invite)) {
      errors.push(`firstAdmin.invite must name one of Crow's invite handlers (${INVITE_HANDLER_NAMES.join(", ")})`);
    }
  }
  // `user` is the documented default username, or — via "setup" — the admin
  // username Crow itself creates, so the protocol has something to create.
  const setupUser = mode === "crow" && fa.via === "setup";
  if (fa.user !== undefined && mode !== "default-login" && !setupUser) {
    errors.push(`firstAdmin.user is only allowed with mode "default-login" or with mode "crow" via "setup"`);
  }
  if (mode === "default-login" && (typeof fa.user !== "string" || fa.user.trim() === "")) {
    errors.push(`firstAdmin: mode "default-login" needs user (the documented default username)`);
  }
  if (fa.setup !== undefined && !(mode === "crow" && fa.via === "setup")) {
    errors.push(`firstAdmin.setup is only allowed with mode "crow" via "setup"`);
  }
  for (const field of ["via", "secretEnv", "userEnv", "urlEnv"]) {
    if (fa[field] !== undefined && mode !== "crow") {
      errors.push(`firstAdmin.${field} is only allowed with mode "crow"`);
    }
  }
  if (mode === "crow") errors.push(...validateCrowFirstAdmin(manifest, bundleDir, fa));
  return errors;
}

/**
 * `mode: "crow"` must name the mechanism that really creates the admin — and
 * that mechanism must be wired to THIS app (review round 1, S2). Three shapes:
 *
 *   { "via": "env", "secretEnv": "<NAME>", "userEnv": "<NAME>"? }
 *     `secretEnv` names an env_vars entry with generate: "secret" AND
 *     keychain: true, and the bundle's compose file must reference it
 *     (`${<NAME>...`) — otherwise the generated password never reaches the app
 *     (a Vaultwarden-style ADMIN_TOKEN sitting in .env is not an admin login).
 *     `userEnv`, when given, names a declared env var.
 *
 *   { "via": "postInstall" }
 *     requires a postInstall script, and that script must name at least one
 *     generate:"secret" + keychain:true env var (a text check: the hook is what
 *     turns the generated value into the app's admin).
 *
 *   { "via": "setup", "setup": { "script": "…/first-admin.sh", "timeout_s"? },
 *     "user": "admin", "secretEnv": "<NAME>", "userEnv": "<NAME>"?,
 *     "urlEnv": "<NAME>"? }
 *     the installer runs that script once, with a password Crow generates on its
 *     stdin (the protocol is in docs/developers/bundles.md). `secretEnv` is the
 *     keychain entry name for that password — it does NOT have to be a generated
 *     env_vars entry, because Crow generates the value itself; when an env_vars
 *     entry of that name exists, the value is also written into the bundle's .env.
 *     `user` is required: it is the username the script must create.
 *     `urlEnv` names a declared, NON-SECRET env_vars entry whose installed `.env`
 *     value is the app's own address: the keychain row of the new login carries it
 *     when it is an http(s) URL, so Settings → Passwords can link to the app.
 */
function validateCrowFirstAdmin(manifest, bundleDir, fa) {
  const errors = [];
  const envVars = Array.isArray(manifest.env_vars) ? manifest.env_vars : [];
  const keychainSecrets = envVars.filter((v) => v && v.generate === "secret" && v.keychain === true);
  // `urlEnv` rides on the saved login, whatever created it: it must name a declared field,
  // and never a secret one — an address is not a secret, and a secret is not an address.
  if (fa.urlEnv !== undefined) {
    const entry = envVars.find((v) => v && v.name === fa.urlEnv);
    if (!entry) {
      errors.push(`firstAdmin.urlEnv must name a declared env_vars entry`);
    } else if (entry.secret === true || entry.generate === "secret") {
      errors.push(`firstAdmin.urlEnv "${fa.urlEnv}" must name a non-secret env_vars entry (the app's address is not a secret)`);
    }
  }
  if (fa.via !== "env" && fa.via !== "postInstall" && fa.via !== "setup") {
    errors.push(
      `firstAdmin: mode "crow" needs via "env" (a \${secretEnv} the compose file uses), or "postInstall" ` +
        `(a script that sets the admin), or "setup" (a script Crow runs with the password on stdin) — ` +
        `otherwise declare "finish-setup"`,
    );
    return errors;
  }
  if (fa.via === "setup") return [...errors, ...validateSetupFirstAdmin(manifest, bundleDir, fa)];
  if (fa.via === "env") {
    const name = fa.secretEnv;
    if (typeof name !== "string" || name === "") {
      errors.push(`firstAdmin: mode "crow" via "env" needs secretEnv (the env_vars entry Crow generates and saves in the keychain)`);
    } else if (!keychainSecrets.some((v) => v.name === name)) {
      errors.push(`firstAdmin: secretEnv "${name}" must name an env_vars entry with generate: "secret" and keychain: true`);
    } else {
      const compose = readBundleFile(bundleDir, manifest?.docker?.composefile);
      if (compose === null) {
        errors.push(`firstAdmin: secretEnv "${name}" cannot be confirmed — docker.composefile is missing or unreadable`);
      } else if (!compose.includes(`\${${name}`)) {
        errors.push(
          `firstAdmin: secretEnv "${name}" is never used by the compose file (expected \${${name}…}) — ` +
            `Crow generating a password the app never reads does not create its admin`,
        );
      }
    }
    if (fa.userEnv !== undefined) {
      const declared = typeof fa.userEnv === "string" && envVars.some((v) => v && v.name === fa.userEnv);
      if (!declared) errors.push(`firstAdmin: userEnv must name a declared env_vars entry`);
    }
  } else {
    if (!manifest.postInstall) {
      errors.push(`firstAdmin: mode "crow" via "postInstall" needs a postInstall script`);
    } else {
      const script = readBundleFile(bundleDir, manifest.postInstall.script);
      if (script === null) {
        errors.push(`firstAdmin: postInstall.script "${manifest.postInstall.script}" is missing or unreadable`);
      } else if (keychainSecrets.length === 0) {
        errors.push(
          `firstAdmin: mode "crow" via "postInstall" needs an env_vars entry with generate: "secret" and keychain: true ` +
            `for the script to set`,
        );
      } else if (!keychainSecrets.some((v) => typeof v.name === "string" && v.name !== "" && script.includes(v.name))) {
        errors.push(
          `firstAdmin: postInstall.script "${manifest.postInstall.script}" never names a generate: "secret" + keychain: true env var — ` +
            `the hook must set the admin from one of those`,
        );
      }
    }
  }
  return errors;
}

/**
 * `via: "setup"`: the installer runs a script that gives the app its admin account.
 * It must name a `.sh` file that really ships in the bundle, the username the script
 * has to create, and the keychain entry name its password is kept under. The script
 * itself is not text-checked: what it does to the app is the app's business (its exit
 * codes are the protocol — see docs/developers/bundles.md).
 */
function validateSetupFirstAdmin(manifest, bundleDir, fa) {
  const errors = [];
  const envVars = Array.isArray(manifest.env_vars) ? manifest.env_vars : [];
  // The two names the run writes into the bundle's .env: Crow refuses to touch
  // Compose's, Docker's or its own namespace from a manifest.
  for (const field of ["secretEnv", "userEnv"]) {
    const name = fa[field];
    if (typeof name !== "string" || name === "") continue;
    const prefix = ["COMPOSE_", "DOCKER_", "CROW_"].find((p) => name.startsWith(p));
    if (prefix) errors.push(`firstAdmin.${field} "${name}" must not start with ${prefix} — that prefix is reserved`);
  }
  if (typeof fa.user !== "string" || fa.user.trim() === "") {
    errors.push(`firstAdmin: mode "crow" via "setup" needs user (the admin username the script creates)`);
  }
  if (typeof fa.secretEnv !== "string" || fa.secretEnv === "") {
    errors.push(`firstAdmin: mode "crow" via "setup" needs secretEnv (the keychain entry name for the admin password)`);
  }
  const setup = fa.setup && typeof fa.setup === "object" ? fa.setup : null;
  if (!setup) {
    errors.push(`firstAdmin: mode "crow" via "setup" needs setup.script (a .sh file inside the bundle)`);
  } else {
    const script = setup.script;
    if (typeof script !== "string" || script === "" || isAbsolute(script) || script.split(/[\\/]/).includes("..") || !script.endsWith(".sh")) {
      errors.push(`firstAdmin: setup.script "${script}" must be a relative .sh path inside the bundle`);
    } else if (!fileExists(bundleDir, script)) {
      errors.push(`firstAdmin: setup.script "${script}" not found`);
    }
    if (setup.timeout_s !== undefined && (!Number.isInteger(setup.timeout_s) || setup.timeout_s < 1 || setup.timeout_s > 600)) {
      errors.push(`firstAdmin: setup.timeout_s must be an integer between 1 and 600`);
    }
    // `setup.after` (N3-4, "Crow creates, then closes"): the values Crow writes into the
    // bundle's .env once the admin exists, and whether it recreates the containers so the
    // app reads them. The rules live beside the runtime that applies them
    // (servers/gateway/bundle-first-admin-after.js), so a manifest cannot declare a step
    // Crow would not run.
    errors.push(...firstAdminAfterProblems(manifest));
  }
  if (fa.userEnv !== undefined) {
    const declared = typeof fa.userEnv === "string" && envVars.some((v) => v && v.name === fa.userEnv);
    if (!declared) errors.push(`firstAdmin: userEnv must name a declared env_vars entry`);
  }
  return errors;
}

/** Referential checks for the `connect` block (the ajv shape already passed). */
function validateConnect(manifest) {
  const errors = [];
  const c = manifest.connect;
  const envVars = Array.isArray(manifest.env_vars) ? manifest.env_vars : [];
  const fields = Array.isArray(c.fields) ? c.fields : [];
  const names = new Set(fields.map((f) => f.name));
  if (names.size !== fields.length) errors.push("connect.fields has duplicate field names");
  for (const f of fields) {
    const ev = envVars.find((v) => v && v.name === f.name);
    if (!ev) errors.push(`connect.fields ${f.name} must name a declared env_vars entry`);
    else if (f.kind === "secret" && ev.secret !== true) errors.push(`connect.fields ${f.name}: kind "secret" needs an env_vars entry with secret: true`);
  }
  if (c.method === "toggle" && fields.length > 0) errors.push("connect: method toggle has no fields");
  if (c.legacy_enable_env !== undefined && c.method !== "toggle") errors.push("connect.legacy_enable_env is only for method toggle");
  if (c.oauth !== undefined && c.method !== "oauth") errors.push("connect.oauth is only allowed with method oauth");
  if (c.method === "oauth" && c.oauth === undefined) errors.push("connect: method oauth needs an oauth block");
  if (c.label_from !== undefined && !fields.some((f) => f.kind === "address")) errors.push("connect.label_from needs an address field");

  const checkTemplate = (where, tpl) => {
    for (const m of String(tpl).matchAll(/\$\{([^}]*)\}/g)) {
      if (!names.has(m[1])) errors.push(`connect.${where}: \${${m[1]}} is not a connect field`);
    }
  };
  for (const [key, url] of Object.entries(c.step_links || {})) checkTemplate(`step_links ${key}`, url);
  for (const [env, d] of Object.entries(c.derived_env || {})) checkTemplate(`derived_env ${env}`, d.template);
  const t = c.test;
  if (t && t.kind === "http") {
    checkTemplate("test.url", t.url);
    for (const [h, v] of Object.entries(t.headers || {})) checkTemplate(`test.headers ${h}`, v);
    const addr = fields.filter((f) => f.kind === "address").map((f) => "${" + f.name + "}");
    if (!t.url.startsWith("https://") && !addr.some((a) => t.url.startsWith(a))) {
      errors.push("connect.test.url must start with https:// or an address field template");
    }
  }
  if (c.discover && !c.discover.url.startsWith("http://127.0.0.1:") && !c.discover.url.startsWith("https://")) {
    errors.push("connect.discover.url must start with http://127.0.0.1: or https://");
  }
  return errors;
}

/**
 * Validate one manifest object against the contract.
 * @param {object} manifest parsed manifest.json
 * @param {string} bundleDir absolute path to the bundle directory
 * @param {{bundleExists?: (id:string)=>boolean}} [opts] resolver for requires.bundles / optional_bundles
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateManifest(manifest, bundleDir, opts = {}) {
  // 1. Shape (ajv)
  const shapeOk = validateShape(manifest);
  if (!shapeOk) {
    const errors = (validateShape.errors || []).map((e) => `shape ${e.instancePath || "/"} ${e.message}`);
    return { ok: false, errors, warnings: [] };
  }

  const errors = [];

  // 2. id must equal dirname
  const dirName = basename(String(bundleDir).replace(/[/\\]+$/, ""));
  if (manifest && manifest.id && dirName && manifest.id !== dirName) {
    errors.push(`id "${manifest.id}" must equal directory name "${dirName}"`);
  }

  // 3. Referential integrity per declared surface
  if (manifest && manifest.docker) {
    const composefile = manifest.docker.composefile;
    if (badBundlePath(composefile)) errors.push(`docker.composefile "${composefile}" must be a relative path inside the bundle`);
    else if (!fileExists(bundleDir, composefile)) errors.push(`docker.composefile "${composefile}" not found`);
  }
  // server entry-file: only local node scripts with a non-flag path arg.
  // (typeof null === "object", so `manifest.server &&` correctly skips null.)
  if (manifest && manifest.server && typeof manifest.server === "object") {
    const command = manifest.server.command;
    const arg0 = Array.isArray(manifest.server.args) ? manifest.server.args[0] : undefined;
    // The spawn runs with the bundle folder as its cwd, so every launcher value that makes it
    // LOAD OR RUN CODE (`launcherPathValues`: a relative command, an interpreter's script and
    // code-loading flag values, a runner's local package spec) must be a plain relative path
    // inside the bundle — an absolute one or one that climbs would run a file from elsewhere.
    // Data arguments are not checked: `--data-dir=data`, `--db data/x.db` or `--config=/etc/x`
    // are the program's own input, not code, and the launcher's reader leaves them alone.
    for (const { key, value } of launcherPathValues(manifest)) {
      if (badBundlePath(value)) errors.push(`${key} "${value}" must be a relative path inside the bundle`);
    }
    if (command === "node" && typeof arg0 === "string" && !arg0.startsWith("-") && !fileExists(bundleDir, arg0)) {
      errors.push(`server entry "${arg0}" not found`);
    }
  }
  // panel: file-check only the string form; object panels resolve at runtime.
  if (manifest && typeof manifest.panel === "string") {
    if (badBundlePath(manifest.panel)) errors.push(`panel "${manifest.panel}" must be a relative path inside the bundle`);
    else if (!fileExists(bundleDir, manifest.panel)) errors.push(`panel "${manifest.panel}" not found`);
  }
  // An object panel's code is panel/<id>.js (routes/bundles.js resolvePanelPath), so its id is a
  // file name: a plain name, never a path that separates or climbs.
  if (manifest && manifest.panel && typeof manifest.panel === "object" && !Array.isArray(manifest.panel) && manifest.panel.id !== undefined) {
    const panelId = manifest.panel.id;
    if (badPanelId(panelId)) errors.push(`panel.id "${panelId}" must match ^[a-z0-9][a-z0-9-]*$`);
  }
  if (manifest && typeof manifest.panelRoutes === "string") {
    if (badBundlePath(manifest.panelRoutes)) errors.push(`panelRoutes "${manifest.panelRoutes}" must be a relative path inside the bundle`);
    else if (!fileExists(bundleDir, manifest.panelRoutes)) errors.push(`panelRoutes "${manifest.panelRoutes}" not found`);
  }
  // widgets: each declaration's code is ALWAYS widgets/<id>.js beside the manifest, so the only
  // referential work is the duplicate check and the file check. The shape (id pattern, title,
  // sizes) is the schema's, and a bad id cannot reach this loop: the shape check short-circuits.
  if (manifest && Array.isArray(manifest.widgets)) {
    const seen = new Set();
    for (const w of manifest.widgets) {
      if (!w || typeof w !== "object" || typeof w.id !== "string") continue;
      if (seen.has(w.id)) errors.push(`widgets: duplicate id "${w.id}"`);
      seen.add(w.id);
      if (!fileExists(bundleDir, join("widgets", `${w.id}.js`))) errors.push(`widgets/${w.id}.js not found`);
    }
  }
  if (manifest && Array.isArray(manifest.skills)) {
    for (const sk of manifest.skills) {
      if (badBundlePath(sk)) errors.push(`skill "${sk}" must be a relative path inside the bundle`);
      else if (!fileExists(bundleDir, sk)) errors.push(`skill "${sk}" not found`);
    }
  }
  if (manifest && manifest.postInstall) {
    const script = manifest.postInstall.script;
    if (badBundlePath(script)) errors.push(`postInstall.script "${script}" must be a relative path inside the bundle`);
    else if (!fileExists(bundleDir, script)) errors.push(`postInstall.script "${script}" not found`);
  }
  for (const p of (manifest && manifest.docker && Array.isArray(manifest.docker.precreate)) ? manifest.docker.precreate : []) {
    if (typeof p !== "string" || p === "" || isAbsolute(p) || p.split(/[\\/]/).includes("..")) {
      errors.push(`docker.precreate "${p}" must be a relative path inside CROW_HOME`);
    }
  }

  for (const v of (manifest && Array.isArray(manifest.env_vars)) ? manifest.env_vars : []) {
    if (!v || typeof v !== "object") continue;
    if (v.store_as !== undefined) {
      if (v.store_as !== "argon2id") errors.push(`env_vars ${v.name}: store_as must be "argon2id"`);
      if (v.generate !== "secret") errors.push(`env_vars ${v.name}: store_as needs generate: "secret"`);
      if (v.keychain !== true) errors.push(`env_vars ${v.name}: store_as needs keychain: true (or the plaintext is lost)`);
    }
    if (v.keychain === true && v.secret !== true && v.generate !== "secret") {
      errors.push(`env_vars ${v.name}: keychain needs secret: true or generate: "secret"`);
    }
    if (v.keychain_configure !== undefined) {
      if (typeof v.keychain_configure !== "boolean") errors.push(`env_vars ${v.name}: keychain_configure must be a boolean`);
      else if (v.keychain !== true && v.generatable !== true) errors.push(`env_vars ${v.name}: keychain_configure only applies with keychain: true or generatable: true`);
    }
    if (v.generate !== undefined) {
      const KINDS = ["secret", "laravel_key", "vapid_private_key", "vapid_public_key", "hex32", "garage_key_id"];
      if (!KINDS.includes(v.generate)) errors.push(`env_vars ${v.name}: generate must be one of ${KINDS.join(", ")}`);
      if (v.generate === "vapid_public_key") {
        const pair = manifest.env_vars.find((o) => o && o.name === v.pair);
        if (!pair || pair.generate !== "vapid_private_key") errors.push(`env_vars ${v.name}: generate "vapid_public_key" needs pair: <the name of a generate "vapid_private_key" var>`);
      }
      if (v.propagate === true && v.store_as !== undefined) errors.push(`env_vars ${v.name}: propagate: true cannot be combined with store_as (the gateway would get a hash)`);
    }
    if (v.propagate_as !== undefined) {
      if (typeof v.propagate_as !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(v.propagate_as)) errors.push(`env_vars ${v.name}: propagate_as must be an upper-case env var name`);
      else if (v.propagate !== true || v.generate === undefined) errors.push(`env_vars ${v.name}: propagate_as needs generate and propagate: true`);
      else if ((manifest.env_vars || []).some((o) => o && o.name === v.propagate_as)) errors.push(`env_vars ${v.name}: propagate_as names another declared var (${v.propagate_as})`);
    }
    if (v.advanced !== undefined && typeof v.advanced !== "boolean") errors.push(`env_vars ${v.name}: advanced must be a boolean`);
    if (v.previous_key !== undefined) {
      const other = (manifest.env_vars || []).find((o) => o && o.name === v.previous_key);
      if (typeof v.previous_key !== "string" || !other || other.name === v.name) errors.push(`env_vars ${v.name}: previous_key must name another declared env var`);
    }
    if (v.replace_values_sha256 !== undefined) {
      if (!Array.isArray(v.replace_values_sha256) || v.replace_values_sha256.length === 0 || !v.replace_values_sha256.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h))) {
        errors.push(`env_vars ${v.name}: replace_values_sha256 must be a non-empty list of lowercase sha256 hex digests`);
      } else if (v.generate === undefined || typeof v.previous_key !== "string") {
        errors.push(`env_vars ${v.name}: replace_values_sha256 needs generate and previous_key (the replaced value moves there)`);
      }
    }
    if (v.default_in_crow_home !== undefined) {
      const rel = v.default_in_crow_home;
      if (typeof rel !== "string" || rel === "" || rel.startsWith("/") || rel.includes("\\") || rel.includes("$") || rel.split("/").includes("..")) {
        errors.push(`env_vars ${v.name}: default_in_crow_home must be a plain relative path inside CROW_HOME`);
      }
    }
    if (v.generatable === true) {
      if (v.secret !== true) errors.push(`env_vars ${v.name}: generatable needs secret: true`);
      if (v.generate !== undefined) errors.push(`env_vars ${v.name}: generatable is for typed fields; it cannot be combined with generate`);
      if (v.propagate !== false) errors.push(`env_vars ${v.name}: generatable needs propagate: false (a human password must not be copied into the gateway .env)`);
    }
  }

  // 3b. firstAdmin (security audit N3-4): how the bundle's own first admin is created.
  if (manifest && typeof manifest === "object") errors.push(...validateFirstAdmin(manifest, bundleDir));

  // connect block (project services): referential checks the shape cannot express.
  if (manifest && manifest.connect) errors.push(...validateConnect(manifest));

  // 4. Dependency bundles exist (via injected resolver)
  const deps = [
    ...(manifest && manifest.requires && Array.isArray(manifest.requires.bundles) ? manifest.requires.bundles : []),
    ...(manifest && Array.isArray(manifest.optional_bundles) ? manifest.optional_bundles : []),
  ];
  if (deps.length && typeof opts.bundleExists === "function") {
    for (const d of deps) {
      if (!opts.bundleExists(d)) errors.push(`required bundle "${d}" does not exist`);
    }
  }

  const warnings = [];

  // 5. Inference-endpoint provider contract (G-6 anti-rot).
  //    - `inference: true` promises a resolvable OpenAI-compat endpoint and
  //      must carry a non-empty providers[] array (see the 15 llamacpp-*/
  //      vllm-* manifests stamped by Task 16).
  //    - `no_auto_provider`, when present at all, must be a real non-empty
  //      reason string, not a stub/empty placeholder (see Task 15's 5
  //      side-channel/dynamic-model bundles).
  //    - a manifest declaring neither flag, whose compose looks like it runs
  //      an OpenAI-compat server on an exposed port, gets a WARN (heuristics
  //      don't hard-gate — this catches drift, it doesn't block it).
  const isInference = manifest && manifest.inference === true;
  const hasNoAutoProvider = Boolean(manifest) && Object.prototype.hasOwnProperty.call(manifest, "no_auto_provider");

  if (hasNoAutoProvider) {
    const reason = manifest.no_auto_provider;
    if (typeof reason !== "string" || reason.trim() === "") {
      errors.push(`no_auto_provider must be a non-empty string when present, got ${JSON.stringify(reason)}`);
    }
  }

  if (isInference) {
    if (!Array.isArray(manifest.providers) || manifest.providers.length === 0) {
      errors.push(`inference: true requires a non-empty providers[] array`);
    }
  } else if (!hasNoAutoProvider && manifest && manifest.docker) {
    if (composeLooksLikeInferenceEndpoint(bundleDir, manifest.docker.composefile)) {
      warnings.push(
        `compose exposes a port and a command matching an OpenAI-compat inference server ` +
          `(--served-model-name/llama-server/vllm/ollama), but the manifest declares neither ` +
          `"inference": true nor "no_auto_provider" — verify whether this bundle needs a providers[] block`,
      );
    }
  }

  // 6. Instance-identity leak scan (generalized #217 leak class): no manifest
  //    may carry a tailnet IP, a *.ts.net hostname, or (in a "host" field) a
  //    pinned 32-hex instance id.
  scanForInstanceLeaks(manifest, "", errors);

  return { ok: errors.length === 0, errors, warnings };
}
