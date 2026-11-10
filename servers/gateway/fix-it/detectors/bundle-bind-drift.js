/**
 * Fix-it detector: an installed docker bundle is running with wider port binds
 * than its compose file now declares (security audit N8-1).
 *
 * Crow refreshes a docker bundle's compose file on a version change when the
 * installed copy is unmodified (routes/bundles.js `refreshInstalledCompose`).
 * The file changes on disk straight away, but a running container keeps the
 * ports it was created with: nothing re-reads the compose until the bundle is
 * restarted. So a bundle whose bind was tightened from `0.0.0.0` to
 * `127.0.0.1` stays reachable from other devices, silently, until someone
 * restarts it. This card says so — and never restarts anything itself.
 *
 * A second card covers the other half: a compose file the owner edited is kept
 * as it is (Crow never overwrites an edit), so the refresh could not apply.
 *
 * No event fires for a running container's port bindings, so this is a BOOT
 * check (`runBootChecks()`), and the gateway re-runs it for one bundle after a
 * Start so the card clears as soon as the new binds are in effect.
 *
 * The comparison itself is pure (compose-guard.js `composePortExpectations` /
 * `portBindDrift`); the docker calls go through bundle-core's `docker` runner
 * (the same seam as the rest of the bundle code) and are time-bounded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CROW_HOME, manifestComposeFile } from "../../bundles-config.js";
import { composeEnv, composeOverrideFiles, composePortExpectations, parseDotEnv, portBindDrift } from "../../compose-guard.js";
import { composeProjectName } from "../../bundle-lifecycle.js";
import { dockerRunner, readInstalled } from "../../bundle-core.js";
import { readComposeEdited } from "../../bundle-compose-state.js";

export const SOURCE = "bundle-bind-drift";
export const COMPOSE_EDITED_SOURCE = "bundle-compose-edited";
/** The link remedy whose target lives in code (fix-it/index.js LINK_REMEDIES). */
export const REMEDY_ACTION_ID = "open-extensions-page";

/** `docker ps` / `docker inspect` bounds — never an unbounded docker call. */
export const DOCKER_PS_TIMEOUT_MS = 15_000;
export const DOCKER_INSPECT_TIMEOUT_MS = 20_000;

export const dedupKeyFor = (bundleId) => `bundle:${bundleId}`;

/** The card's title, for the bundle's display name. */
export function driftTitle(name) {
  return `Restart ${name} to apply its updated network settings`;
}

/** The card's body for a running bind that is wider than the compose file's. */
export function widerBindBody(name, hostIp, hostPort) {
  return `${name} is still reachable on ${hostIp}:${hostPort} from other devices, but its settings now keep it on this computer only. `
    + "Restart it on the Extensions page to apply them.";
}

/** The card's body for a published port the compose file no longer has. */
export function extraPortBody(name, hostIp, hostPort) {
  return `${name} is still reachable on ${hostIp}:${hostPort} from other devices, but its settings no longer publish that port. `
    + "Restart it on the Extensions page to apply them.";
}

export function composeEditedTitle(name) {
  return `${name}'s compose file has local changes`;
}

/**
 * The Extensions page has no "Update" action (a version change refreshes the
 * installed copy at the next gateway boot), so the card says to remove the edit
 * rather than naming a button that does not exist.
 */
export function composeEditedBody(name) {
  return `${name}'s compose file has local changes, so Crow did not update it. `
    + "Move your changes into docker-compose.override.yml and remove them from the compose file so Crow can update it.";
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function bundleName(manifest, id) {
  const name = manifest?.name;
  return typeof name === "string" && name.trim() ? name.trim() : id;
}

/**
 * The installed compose (plus the override files compose merges from its
 * directory) and the env its `${VAR}` values resolve against: the bundle's .env,
 * then the same allowlisted env a gateway-run compose gets — exactly what the
 * rest of the bundle code expands with.
 */
function readBundleCompose({ bundlesDir, id, manifest, crowHome }) {
  const composeRel = manifestComposeFile(manifest);
  if (!composeRel) return null;
  const dir = join(bundlesDir, id);
  let head;
  try { head = readFileSync(join(dir, composeRel), "utf8"); } catch { return null; }
  const texts = [head];
  for (const rel of composeOverrideFiles(composeRel)) {
    try { texts.push(readFileSync(join(dir, rel), "utf8")); } catch { /* no override */ }
  }
  const env = { ...parseDotEnv(join(dir, ".env")), ...composeEnv(process.env, crowHome) };
  return { composeRel, dir, env, text: texts.join("\n") };
}

/**
 * The published host binds of the RUNNING containers of one compose project:
 * `[{ containerPort, protocol, hostIp, hostPort }]`. Docker unreachable or the
 * output unreadable → throws (the caller turns that into one log line and no
 * card). Not published at all → an empty list.
 */
async function runningPortBinds({ project, runner }) {
  const { stdout: idOut } = await runner("docker", [
    "ps",
    "--filter", `label=com.docker.compose.project=${project}`,
    "--filter", "status=running",
    "--format", "{{.ID}}",
  ], { timeout: DOCKER_PS_TIMEOUT_MS });
  const ids = String(idOut || "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return [];
  const { stdout } = await runner("docker", ["inspect", ...ids], { timeout: DOCKER_INSPECT_TIMEOUT_MS });
  const rows = JSON.parse(String(stdout || "[]"));
  const binds = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const ports = row?.NetworkSettings?.Ports ?? row?.HostConfig?.PortBindings ?? {};
    for (const [key, list] of Object.entries(ports || {})) {
      if (!Array.isArray(list)) continue;
      const slash = key.lastIndexOf("/");
      const containerPort = slash >= 0 ? key.slice(0, slash) : key;
      const protocol = (slash >= 0 ? key.slice(slash + 1) : "tcp").toLowerCase();
      for (const bind of list) {
        binds.push({
          containerPort,
          protocol,
          hostIp: String(bind?.HostIp ?? ""),
          hostPort: String(bind?.HostPort ?? ""),
        });
      }
    }
  }
  return binds;
}

async function resolveCard(store, source, bundleId) {
  try { await store.resolveByKey(source, dedupKeyFor(bundleId)); } catch { /* no row yet, or no store */ }
}

export default {
  source: SOURCE,
  // Running containers emit no event: runBootChecks() calls check() at gateway start
  // (and the Start route re-runs it for the bundle that just restarted).
  events: [],
  async onEvent() {},
  /**
   * One "restart to apply" card per drifting bundle and one "compose edited" card
   * per bundle whose compose was kept, each RESOLVING itself once the condition is
   * gone. Never throws into boot (runBootChecks isolates a detector, but a broken
   * docker must not even log per bundle).
   *
   * `opts`: { crowHome, bundlesDir, installedPath, runner, log, only } — the last
   * limits the pass to those bundle ids (the Start route passes the one bundle it
   * just restarted), so answering a card does not re-inspect every other bundle.
   */
  async check(store, opts = {}) {
    const crowHome = opts.crowHome || CROW_HOME;
    const bundlesDir = opts.bundlesDir || join(crowHome, "bundles");
    const runner = opts.runner || dockerRunner();
    const log = opts.log || console;
    const only = opts.only ? new Set(Array.isArray(opts.only) ? opts.only : [opts.only]) : null;
    const installed = readInstalled(opts.installedPath || join(crowHome, "installed.json"));
    const remedies = [{ actionId: REMEDY_ACTION_ID, kind: "link", label: "Open Extensions" }];

    let dockerFailed = false;
    const cards = [];
    for (const rec of installed) {
      const id = typeof rec === "string" ? rec : rec?.id;
      if (typeof id !== "string" || !id) continue;
      if (rec && typeof rec === "object" && rec.mode === "satellite") continue; // hosted on a satellite
      if (only && !only.has(id)) continue;

      const dir = join(bundlesDir, id);
      const manifest = readJson(join(dir, "manifest.json"));
      const compose = readBundleCompose({ bundlesDir, id, manifest, crowHome });
      if (!compose) continue;
      const name = bundleName(manifest, id);

      if (readComposeEdited(dir)) {
        await store.upsertItem({
          source: COMPOSE_EDITED_SOURCE,
          dedupKey: dedupKeyFor(id),
          title: composeEditedTitle(name),
          why: composeEditedBody(name),
          severity: "warn",
          remedies,
          context: { bundle: id, compose: compose.composeRel },
        });
        cards.push(`${id}: compose-edited`);
      } else {
        await resolveCard(store, COMPOSE_EDITED_SOURCE, id);
      }

      if (dockerFailed) continue;
      let drifted;
      try {
        const project = composeProjectName(compose.text, compose.dir, compose.env);
        const running = await runningPortBinds({ project, runner });
        drifted = portBindDrift({ expected: composePortExpectations(compose.text, compose.env), running });
      } catch {
        dockerFailed = true;
        continue;
      }
      if (drifted.length === 0) {
        await resolveCard(store, SOURCE, id);
        continue;
      }
      const first = drifted[0];
      const hostIp = first.hostIp || "0.0.0.0";
      await store.upsertItem({
        source: SOURCE,
        dedupKey: dedupKeyFor(id),
        title: driftTitle(name),
        why: first.kind === "extra" ? extraPortBody(name, hostIp, first.hostPort) : widerBindBody(name, hostIp, first.hostPort),
        severity: "warn",
        remedies,
        context: { bundle: id, bind: `${hostIp}:${first.hostPort}`, containerPort: `${first.containerPort}/${first.protocol}` },
      });
      cards.push(`${id}: ${drifted.length} bind(s)`);
    }
    if (dockerFailed) {
      log.warn("[fix-it] bundle bind check skipped: docker is not reachable (the restart-to-apply cards were left as they are)");
    }
    return { cards };
  },
};