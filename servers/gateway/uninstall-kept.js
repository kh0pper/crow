/**
 * uninstall-kept — after a bundle uninstall, say what was left behind.
 *
 * An uninstall removes the bundle's folder, containers and networks, but it never deletes
 * the owner's data: docker named volumes of the compose project, pulled images, and the
 * retained secrets file (<CROW_HOME>/secrets/bundle-env/<id>.env) all survive on purpose,
 * so a reinstall picks them up again. Nothing here deletes anything: this module only
 * LOOKS (read-only docker queries, one existsSync) and turns what it found into lines the
 * install job log and the dashboard can show.
 *
 * Two halves, both pure enough to test without docker:
 *   inspectKept()   runs the lookups through an injected runner (bundle-core's run()) and
 *                   never throws — a docker it cannot talk to becomes `error`, with
 *                   whatever it had gathered so far.
 *   describeKept()  turns that result into log lines + one body sentence, through i18n keys
 *                   (extensions.kept.*) so both languages read naturally.
 */

import { existsSync } from "node:fs";
import { run } from "./bundle-core.js";
import { composeServiceImages } from "./compose-guard.js";
import { retainedEnvPath } from "./bundle-env-secrets.js";
import { t as tr, fill } from "./dashboard/shared/i18n.js";

const LOOKUP_TIMEOUT_MS = 10_000;
/** Docker's answer for an image that is not on this host (the image was pruned or removed). */
const NO_SUCH_IMAGE_RE = /no such image/i;

/** A one-line, bounded rendering of a failed docker call (stderr first: that is where docker talks). */
function shortError(err) {
  const text = String(err?.stderr || "").trim() || String(err?.message || err || "").trim();
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") || "";
  return (first || "docker did not answer").slice(0, 160);
}

/**
 * What an uninstall left on this host. Read-only: nothing is removed, nothing is read.
 *
 * @param {object} opts
 * @param {string} opts.bundleId       the bundle that was just uninstalled
 * @param {string|null} [opts.project] its compose project name (null/empty: no volume lookup)
 * @param {string} [opts.composeText]  its docker-compose.yml text (for the image names)
 * @param {object} [opts.env]          the values compose interpolates into those image names
 * @param {string} [opts.crowHome]     the instance home (holds secrets/bundle-env)
 * @param {Function} [opts.runner]     `run(cmd, args, opts)` → Promise<{stdout, stderr}>
 * @returns {Promise<{volumes: string[], images: {name: string, present: boolean}[], settings: boolean, error: string|null}>}
 */
export async function inspectKept({ bundleId, project, composeText, env = {}, crowHome, runner } = {}) {
  // The kept settings file is a plain path check: it is never opened here (it holds secrets).
  let settings = false;
  if (typeof bundleId === "string" && bundleId !== "" && typeof crowHome === "string" && crowHome !== "") {
    try { settings = existsSync(retainedEnvPath(crowHome, bundleId)); } catch { settings = false; }
  }
  const out = { volumes: [], images: [], settings, error: null };
  const call = typeof runner === "function" ? runner : run;

  if (typeof project === "string" && project.trim() !== "") {
    try {
      const { stdout } = await call("docker", ["volume", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"], { timeout: LOOKUP_TIMEOUT_MS });
      out.volumes = String(stdout || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "").sort();
    } catch (err) {
      out.error = shortError(err);
      return out;
    }
  }

  const names = [...new Set(Object.values(composeServiceImages(composeText, env) || {})
    .filter((name) => typeof name === "string" && name.trim() !== "")
    .map((name) => name.trim()))].sort();
  for (const name of names) {
    try {
      await call("docker", ["image", "inspect", "--format", "{{.Id}}", name], { timeout: LOOKUP_TIMEOUT_MS });
      out.images.push({ name, present: true });
    } catch (err) {
      // An image that is simply gone is the normal case after a prune: not an error.
      if (NO_SUCH_IMAGE_RE.test(`${err?.stderr || ""}\n${err?.message || ""}`)) continue;
      out.error = shortError(err);
      return out;
    }
  }
  return out;
}

/** "a and b" / "a, b, and c" — the joining words are translated too. */
function joinParts(parts, t) {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  const rest = parts.slice(0, -1);
  if (rest.length === 1) return fill(t("extensions.kept.joinTwo"), { a: rest[0], b: last });
  return fill(t("extensions.kept.joinMany"), { a: rest.join(", "), b: last });
}

/** The default `t`: the dashboard table in English. */
const defaultT = (key) => tr(key, "en");

/**
 * What to log (one line per kept item) and what to tell the owner (counts only — the log
 * lines carry the names).
 *
 * @param {object} kept   inspectKept()'s result (a missing/undefined one reads as "nothing")
 * @param {(key: string) => string} [t]  i18n lookup (defaults to English)
 * @returns {{logLines: string[], body: string}}
 */
export function describeKept(kept, t = defaultT) {
  const tt = typeof t === "function" ? t : defaultT;
  if (kept && kept.error) {
    const line = tt("extensions.kept.couldNotCheck");
    return { logLines: [line], body: line };
  }
  const volumes = (Array.isArray(kept?.volumes) ? kept.volumes : []).filter((v) => typeof v === "string" && v !== "");
  const images = (Array.isArray(kept?.images) ? kept.images : [])
    .filter((i) => i && i.present !== false && typeof i.name === "string" && i.name !== "")
    .map((i) => i.name);
  const settings = kept?.settings === true;

  if (volumes.length === 0 && images.length === 0 && !settings) {
    const line = tt("extensions.kept.nothing");
    return { logLines: [line], body: line };
  }

  const logLines = [
    ...volumes.map((name) => fill(tt("extensions.kept.logVolume"), { name })),
    ...images.map((name) => fill(tt("extensions.kept.logImage"), { name })),
    ...(settings ? [tt("extensions.kept.logSettings")] : []),
  ];
  const parts = [];
  if (volumes.length === 1) parts.push(tt("extensions.kept.volumeOne"));
  else if (volumes.length > 1) parts.push(fill(tt("extensions.kept.volumeMany"), { n: volumes.length }));
  if (images.length === 1) parts.push(tt("extensions.kept.imageOne"));
  else if (images.length > 1) parts.push(fill(tt("extensions.kept.imageMany"), { n: images.length }));
  if (settings) parts.push(tt("extensions.kept.settingsPart"));
  return { logLines, body: fill(tt("extensions.kept.body"), { list: joinParts(parts, tt) }) };
}