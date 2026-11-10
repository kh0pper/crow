/**
 * Fix-it detector: an installed docker bundle is running with wider port binds
 * than its compose file now declares (security audit N8-1).
 *
 * Crow keeps an installed docker bundle's compose file up to date on EVERY boot,
 * at any version (routes/bundles.js `catchUpInstalledCompose`). The file changes
 * on disk straight away, but a running container keeps the ports it was created
 * with: nothing re-reads the compose until the bundle is restarted. So a bundle
 * whose bind was tightened from `0.0.0.0` to `127.0.0.1` stays reachable from
 * other devices, silently, until someone restarts it. This card says so — and
 * never restarts anything itself.
 *
 * Three more cards cover the other halves:
 *
 *   compose edited     the owner's copy is kept as it is (Crow never overwrites
 *                      an edit), so the refresh could not apply. The card names
 *                      what to do, offers a restore action, and resolves itself:
 *                      the boot catch-up re-decides every boot and drops the
 *                      `.crow-compose.edited` note once the file matches again.
 *   repo is tighter    the installed compose is edited or `unknown` AND a running
 *                      bind is WIDE while the REPO's compose binds that port to a
 *                      specific IP: the owner's own file is what keeps it open, so
 *                      a restart would not help. Never raised for a port the owner
 *                      declared in an override file (widened on purpose). `unknown`
 *                      is never cached by the boot catch-up (an undecidable boot
 *                      writes nothing and drops the record), so it only comes from
 *                      a record an older install still carries.
 *   needs config       the shipped compose needs a `${X:?…}` the installed .env
 *                      does not set. Copying it would break Start, so the old copy
 *                      stays and the card names the key to set first.
 *   image change       the shipped compose would also change a service's image —
 *                      which may be OLDER than the one running — so the boot
 *                      catch-up kept the old copy instead of applying it. The card
 *                      says why and offers "Apply the update" (owner-only, keeps
 *                      the current file as `<composefile>.bak`). It suppresses the
 *                      repo-tighter card for that bundle: "a restart won't change
 *                      that" would contradict "press Apply the update".
 *
 * No event fires for a running container's port bindings, so this is a BOOT
 * check (`runBootChecks()`), and the gateway re-runs it for one bundle after a
 * Start, a stop and an install's `up` so a card clears as soon as the binds
 * are in effect (or gone).
 *
 * The comparison itself is pure (compose-guard.js `composePortExpectations` /
 * `portBindDrift`); the docker calls go through bundle-core's `docker` runner
 * (the same seam as the rest of the bundle code) and are time-bounded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_BUNDLES, CROW_HOME, manifestComposeFile } from "../../bundles-config.js";
import { composeEnv, composeOverrideFiles, composePortExpectations, parseDotEnv, portBindDrift, portExpectationsFor } from "../../compose-guard.js";
import { composeProjectName } from "../../bundle-lifecycle.js";
import { dockerRunner, readInstalled } from "../../bundle-core.js";
import { readComposeEdited, readComposeImageChange, readComposeNeedsConfig, readComposeState, sha256 } from "../../bundle-compose-state.js";
import { isSatelliteEntry, BUNDLE_ID_RE } from "../../satellites/installs.js";
import { ACTION_ID as RESTORE_COMPOSE_ACTION_ID, APPLY_UPDATE_ACTION_ID, LABEL as RESTORE_COMPOSE_LABEL } from "../remedies/restore-bundle-compose.js";

export const SOURCE = "bundle-bind-drift";
export const COMPOSE_EDITED_SOURCE = "bundle-compose-edited";
export const REPO_DRIFT_SOURCE = "bundle-repo-bind-drift";
export const COMPOSE_NEEDS_CONFIG_SOURCE = "bundle-compose-needs-config";
export const COMPOSE_IMAGE_CHANGE_SOURCE = "bundle-compose-image-change";
/** The link remedy whose target lives in code (fix-it/index.js LINK_REMEDIES). */
export const REMEDY_ACTION_ID = "open-extensions-page";
/** The owner-only restore action (fix-it/remedies/restore-bundle-compose.js). */
export { RESTORE_COMPOSE_ACTION_ID };

/** `docker ps` / `docker inspect` bounds — never an unbounded docker call. */
export const DOCKER_PS_TIMEOUT_MS = 15_000;
export const DOCKER_INSPECT_TIMEOUT_MS = 20_000;

/** One card key per bundle; a second key for the "the repo is tighter" card. */
export const dedupKeyFor = (bundleId, kind = "") => (kind ? `bundle:${bundleId}:${kind}` : `bundle:${bundleId}`);

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
 * What the owner can actually do: the changes belong in the override file, and the
 * compose file is restored from Crow's copy — with the current one kept beside it as
 * `<compose>.bak` when the card's restore action runs.
 */
export function composeEditedBody(name, composeRel = "docker-compose.yml") {
  return `${name}'s compose file has local changes, so Crow did not update it. `
    + `Move your changes into docker-compose.override.yml and restore the compose file (a copy of the current one is kept as ${composeRel}.bak when Crow restores it).`;
}

export function repoDriftTitle(name) {
  return `${name} is still published to other devices`;
}

/**
 * The card for the case a restart cannot fix: the port is wide because the OWNER's
 * compose file says so, and the repo's copy already binds it to this computer only.
 */
export function repoDriftBody(name) {
  return `${name} is published to other devices; Crow now ships it on this computer only. `
    + "Restart won't change that while its compose file has local changes — see the other card.";
}

/** The same case when Crow could not tell whether the file was edited (no git history). */
export function repoDriftUnknownBody(name) {
  return `${name} is published to other devices; Crow now ships it on this computer only. `
    + "Restart won't change that while Crow cannot tell whether the installed compose file has local changes.";
}

export function composeNeedsConfigTitle(name) {
  return `${name}'s settings file was not updated`;
}

export function composeNeedsConfigBody(name, key) {
  return `Crow could not update ${name}'s settings file: it needs ${key} set first (Configure on its Extensions card).`;
}

export function composeImageChangeTitle(name) {
  return `${name}'s settings file has an update Crow did not apply`;
}

/**
 * The image-change hold: the shipped compose also switches a container's image, and
 * that image may be older than the one running (a downgrade can migrate the data on
 * the next restart), so Crow kept the old file. "Apply the update" is the owner's way
 * to take it; the restart card then appears as usual.
 *
 * The sentence follows the kind of change, because "a new image may be older than the
 * one running" is only true of a service whose image is swapped. A service the update
 * ADDS (`from` is null: a helper step such as Vikunja's one-shot volume owner) is named
 * as an addition, one it REMOVES (`to` is null) as a removal. The port sentence belongs
 * to the image swap this card was built for (the tightened bind that comes with it); an
 * added or removed step does not publish the app differently, so it is left out there.
 */
export function composeImageChangeBody(name, change) {
  const from = change?.from || null;
  const to = change?.to || null;
  const service = change?.service || "a helper step";
  const tail = "Back up its data, then press 'Apply the update' to switch, or keep it as it is.";
  if (!from && to) {
    return `Crow keeps ${name} on its current settings because the update would also add a helper step "${service}" that uses the image "${to}". ${tail}`;
  }
  if (from && !to) {
    return `Crow keeps ${name} on its current settings because the update would also remove the step "${service}". ${tail}`;
  }
  return `Crow keeps ${name} on its current settings because the update would also change its image (${from || "none"} → ${to || "none"}; it may be older than what is running). `
    + `The update also tightens how ${name} is published. `
    + tail;
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
 * rest of the bundle code expands with. `sha` is the sha256 of the compose FILE's
 * own bytes (not the merged text), which is what the install record keys on.
 */
function readBundleCompose({ bundlesDir, id, manifest, crowHome }) {
  const composeRel = manifestComposeFile(manifest);
  if (!composeRel) return null;
  const dir = join(bundlesDir, id);
  let head;
  try { head = readFileSync(join(dir, composeRel)); } catch { return null; }
  const texts = [head.toString("utf8")];
  const overrideTexts = [];
  for (const rel of composeOverrideFiles(composeRel)) {
    try {
      const text = readFileSync(join(dir, rel), "utf8");
      overrideTexts.push(text);
      texts.push(text);
    } catch { /* no override */ }
  }
  const env = { ...parseDotEnv(join(dir, ".env")), ...composeEnv(process.env, crowHome) };
  return { composeRel, dir, env, text: texts.join("\n"), overrideTexts, sha: sha256(head) };
}

/** The compose file the checkout now ships for this bundle, or null. */
function readRepoCompose({ repoBundles, id }) {
  const manifest = readJson(join(repoBundles, id, "manifest.json"));
  const rel = manifestComposeFile(manifest);
  if (!rel) return null;
  try { return { rel, text: readFileSync(join(repoBundles, id, rel), "utf8") }; } catch { return null; }
}

/**
 * The published host binds of the RUNNING containers of one compose project:
 * `[{ service, containerPort, protocol, hostIp, hostPort }]`. The compose SERVICE
 * label rides along so two services publishing the same container port cannot mask
 * each other. Docker unreachable or the output unreadable → throws (the caller
 * turns that into one log line and no card). Not published at all → an empty list.
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
    const service = String(row?.Config?.Labels?.["com.docker.compose.service"] ?? "");
    const ports = row?.NetworkSettings?.Ports ?? row?.HostConfig?.PortBindings ?? {};
    for (const [key, list] of Object.entries(ports || {})) {
      if (!Array.isArray(list)) continue;
      const slash = key.lastIndexOf("/");
      const containerPort = slash >= 0 ? key.slice(0, slash) : key;
      const protocol = (slash >= 0 ? key.slice(slash + 1) : "tcp").toLowerCase();
      for (const bind of list) {
        binds.push({
          service,
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

async function resolveCard(store, source, key) {
  try { await store.resolveByKey(source, key); } catch { /* no row yet, or no store */ }
}

/**
 * The published ports the installed override files declare, as the same expectation
 * map the drift comparison uses. An override is the owner's own widening of a port
 * Crow never writes, so a port it names is skipped by the repo-tighter card: the
 * owner chose it on purpose (a range in the override covers the running ports inside
 * it, exactly as the compose side does).
 */
function overridePortExpectations(compose) {
  return compose.overrideTexts.length > 0 ? composePortExpectations(compose.overrideTexts.join("\n"), compose.env) : {};
}

const ownerDeclared = (expectations, drift) => portExpectationsFor(expectations, {
  containerPort: drift.containerPort,
  protocol: drift.protocol,
}).length > 0;

export default {
  source: SOURCE,
  // Running containers emit no event: runBootChecks() calls check() at gateway start
  // (and the Start/stop/install paths re-run it for the bundle that just changed).
  events: [],
  async onEvent() {},
  /**
   * One "restart to apply" card per drifting bundle, one "compose edited" card per
   * bundle whose compose was kept, one "repo is tighter" card for the edited/unknown
   * case a restart cannot fix, and one "needs config" card — each RESOLVING itself
   * once the condition is gone. Never throws into boot (runBootChecks isolates a
   * detector, but a broken docker must not even log per bundle).
   *
   * `opts`: { crowHome, bundlesDir, repoBundlesDir, installedPath, runner, log, only } —
   * the last limits the pass to those bundle ids (the Start route passes the one bundle
   * it just restarted), so answering a card does not re-inspect every other bundle.
   */
  async check(store, opts = {}) {
    const crowHome = opts.crowHome || CROW_HOME;
    const bundlesDir = opts.bundlesDir || join(crowHome, "bundles");
    const repoBundles = opts.repoBundlesDir || APP_BUNDLES;
    const runner = opts.runner || dockerRunner();
    const log = opts.log || console;
    const only = opts.only ? new Set(Array.isArray(opts.only) ? opts.only : [opts.only]) : null;
    const installed = readInstalled(opts.installedPath || join(crowHome, "installed.json"));
    const linkRemedy = { actionId: REMEDY_ACTION_ID, kind: "link", label: "Open Extensions" };

    let dockerFailed = false;
    const cards = [];
    for (const rec of installed) {
      const id = typeof rec === "string" ? rec : rec?.id;
      // Every id reaches a `join`: an id that is not a bundle id is never joined.
      if (typeof id !== "string" || !BUNDLE_ID_RE.test(id)) continue;
      if (isSatelliteEntry(rec)) continue; // hosted on a satellite (SAT-5)
      if (only && !only.has(id)) continue;

      const dir = join(bundlesDir, id);
      const manifest = readJson(join(dir, "manifest.json"));
      const compose = readBundleCompose({ bundlesDir, id, manifest, crowHome });
      if (!compose) continue;
      const name = bundleName(manifest, id);

      // ── the owner's copy was kept: the boot catch-up owns the decision, so this
      //    card follows its note and clears by itself once the file matches again.
      const edited = readComposeEdited(dir);
      if (edited) {
        await store.upsertItem({
          source: COMPOSE_EDITED_SOURCE,
          dedupKey: dedupKeyFor(id),
          title: composeEditedTitle(name),
          why: composeEditedBody(name, compose.composeRel),
          severity: "warn",
          remedies: [
            { actionId: RESTORE_COMPOSE_ACTION_ID, kind: "instant", label: RESTORE_COMPOSE_LABEL, args: { bundle: id } },
            linkRemedy,
          ],
          context: { bundle: id, compose: compose.composeRel },
        });
        cards.push(`${id}: compose-edited`);
      } else {
        await resolveCard(store, COMPOSE_EDITED_SOURCE, dedupKeyFor(id));
      }

      // ── the shipped compose needs a key the installed .env does not set.
      const needsConfig = readComposeNeedsConfig(dir);
      if (needsConfig && needsConfig.missing.length > 0) {
        await store.upsertItem({
          source: COMPOSE_NEEDS_CONFIG_SOURCE,
          dedupKey: dedupKeyFor(id),
          title: composeNeedsConfigTitle(name),
          why: composeNeedsConfigBody(name, needsConfig.missing[0]),
          severity: "warn",
          remedies: [linkRemedy],
          context: { bundle: id, compose: needsConfig.compose || compose.composeRel, key: needsConfig.missing[0] },
        });
        cards.push(`${id}: compose-needs-config`);
      } else {
        await resolveCard(store, COMPOSE_NEEDS_CONFIG_SOURCE, dedupKeyFor(id));
      }

      // ── the shipped compose would also switch a container's image: the boot
      //    catch-up kept the old file instead of applying it (the new tag may be
      //    older than what is running). Applying is the owner's call.
      const imageChange = readComposeImageChange(dir);
      if (imageChange) {
        const first = imageChange[0];
        await store.upsertItem({
          source: COMPOSE_IMAGE_CHANGE_SOURCE,
          dedupKey: dedupKeyFor(id),
          title: composeImageChangeTitle(name),
          why: composeImageChangeBody(name, first),
          severity: "warn",
          remedies: [
            { actionId: APPLY_UPDATE_ACTION_ID, kind: "instant", label: "Apply the update", args: { bundle: id } },
            linkRemedy,
          ],
          context: { bundle: id, compose: compose.composeRel, service: first.service, from: first.from, to: first.to },
        });
        cards.push(`${id}: compose-image-change`);
      } else {
        await resolveCard(store, COMPOSE_IMAGE_CHANGE_SOURCE, dedupKeyFor(id));
      }

      if (dockerFailed) continue;
      let running;
      try {
        const project = composeProjectName(compose.text, compose.dir, compose.env);
        running = await runningPortBinds({ project, runner });
      } catch {
        dockerFailed = true;
        continue;
      }

      // ── running wider than the installed compose declares (a restart applies it).
      const drifted = portBindDrift({ expected: composePortExpectations(compose.text, compose.env), running });
      if (drifted.length === 0) {
        await resolveCard(store, SOURCE, dedupKeyFor(id));
      } else {
        const first = drifted[0];
        const hostIp = first.hostIp || "0.0.0.0";
        await store.upsertItem({
          source: SOURCE,
          dedupKey: dedupKeyFor(id),
          title: driftTitle(name),
          why: first.kind === "extra" ? extraPortBody(name, hostIp, first.hostPort) : widerBindBody(name, hostIp, first.hostPort),
          severity: "warn",
          remedies: [linkRemedy],
          context: { bundle: id, bind: `${hostIp}:${first.hostPort}`, containerPort: `${first.containerPort}/${first.protocol}` },
        });
        cards.push(`${id}: ${drifted.length} bind(s)`);
      }

      // ── running wider than the REPO's compose, while the installed file is one
      //    Crow cannot refresh: a restart cannot fix this one.
      //    A cached `unknown` is a leftover (the catch-up never writes one): the next
      //    boot drops the record, so this branch answers itself away.
      const state = readComposeState(dir);
      const verdict = edited
        ? "edited"
        : state && state.verdict === "unknown" && state.installedSha === compose.sha ? "unknown" : null;
      const repoDriftKey = dedupKeyFor(id, "repo");
      // Held for an image change: "a restart won't change that" would contradict the
      // Apply-the-update card above, which is the one that actually moves this bundle.
      if (imageChange) {
        await resolveCard(store, REPO_DRIFT_SOURCE, repoDriftKey);
        continue;
      }
      if (!verdict) {
        await resolveCard(store, REPO_DRIFT_SOURCE, repoDriftKey);
        continue;
      }
      const repo = readRepoCompose({ repoBundles, id });
      const ownerWidened = overridePortExpectations(compose);
      // A port the INSTALLED file already narrows is the drift card's job: a restart
      // applies it, so saying "a restart won't change that" would contradict it.
      const appliesOnRestart = new Set(drifted.map((d) => `${d.containerPort}/${d.protocol}`));
      const repoDrift = repo
        ? portBindDrift({ expected: composePortExpectations(repo.text, compose.env), running })
          .filter((d) => d.kind === "wider"
            && !ownerDeclared(ownerWidened, d)
            && !appliesOnRestart.has(`${d.containerPort}/${d.protocol}`))
        : [];
      if (repoDrift.length === 0) {
        await resolveCard(store, REPO_DRIFT_SOURCE, repoDriftKey);
        continue;
      }
      const firstRepo = repoDrift[0];
      await store.upsertItem({
        source: REPO_DRIFT_SOURCE,
        dedupKey: repoDriftKey,
        title: repoDriftTitle(name),
        why: verdict === "edited" ? repoDriftBody(name) : repoDriftUnknownBody(name),
        severity: "warn",
        remedies: [linkRemedy],
        context: { bundle: id, bind: `${firstRepo.hostIp || "0.0.0.0"}:${firstRepo.hostPort}`, containerPort: `${firstRepo.containerPort}/${firstRepo.protocol}` },
      });
      cards.push(`${id}: ${repoDrift.length} bind(s) the repo already closes`);
    }
    if (dockerFailed) {
      log.warn("[fix-it] bundle bind check skipped: docker is not reachable (the restart-to-apply cards were left as they are)");
    }
    return { cards };
  },
};