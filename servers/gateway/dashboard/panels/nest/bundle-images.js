/**
 * Nest Panel — bundle image age (security audit N1c-7).
 *
 * A bundle pins the tag it installs with, and nothing moves that tag until the
 * owner reinstalls: an image can sit on a release with a published CVE for a
 * year while every health card reads green. This module answers one question —
 * how old are the images the installed bundles RUN — and it does no I/O of its
 * own: health-signals.js runs the two bounded `docker` calls (a `ps` that maps
 * containers to bundle directories, and one `image inspect` for their created
 * times) and hands their stdout here.
 *
 * Informational only. An old image is a fact, not a failure: nothing here can
 * produce a warn.
 *
 * Why the compose working-directory label and not a container name: it is the
 * only thing that ties a container to `<CROW_HOME>/bundles/<id>` without
 * trusting a name (see published-ports.js, which draws the same line).
 */
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { resolveCrowHome } from "../../../../shared/crow-home.js";
import { COMPOSE_WORKDIR_LABEL } from "./published-ports.js";

/** An image older than this is worth a line in the strip. */
export const BUNDLE_IMAGE_STALE_DAYS = 90;

/** Same shape published-ports.js accepts for a bundle id. */
const BUNDLE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** The label health-signals.js asks `docker ps` for, next to the image ref. */
export const BUNDLE_PS_FORMAT = `{{.Label "${COMPOSE_WORKDIR_LABEL}"}}\t{{.Image}}`;

const defaultBundlesDir = () => join(resolveCrowHome(), "bundles");

/**
 * The bundles installed on THIS instance, from `<CROW_HOME>/installed.json`.
 * Same tolerance as bundle-core's readInstalled (array, or an id-keyed object),
 * but only the ids: the signal never needs the rest of the record. A missing or
 * unreadable file is "nothing installed", never a throw.
 */
export function readInstalledBundleIds({ crowHome = resolveCrowHome(), readFile = (p) => readFileSync(p, "utf8") } = {}) {
  let data;
  try {
    data = JSON.parse(readFile(join(crowHome, "installed.json")));
  } catch {
    return [];
  }
  const arr = Array.isArray(data) ? data : (data && typeof data === "object" ? Object.entries(data).map(([id, v]) => ({ id, ...v })) : []);
  return arr
    .map((e) => (typeof e === "string" ? e : e && e.id))
    .filter((id) => typeof id === "string" && BUNDLE_ID_RE.test(id));
}

/**
 * `docker ps` rows → the running images of installed bundles.
 *
 * Each row is `<compose working dir>\t<image>`. A row whose working directory is
 * not inside `<bundlesDir>/<installed id>` belongs to something else (another
 * Crow, a hand-run compose, a plain `docker run`) and is dropped: the signal
 * only ever reports on bundles this instance installed.
 *
 * @returns {Array<{bundleId: string, image: string}>} deduped by bundle+image
 */
export function parseRunningBundleImages(stdout, { installedIds = [], installedDir } = {}) {
  const dir = installedDir || defaultBundlesDir();
  const roots = [];
  for (const id of installedIds) {
    if (typeof id !== "string" || !BUNDLE_ID_RE.test(id)) continue;
    roots.push([resolve(dir, id), id]);
  }
  const out = [];
  const seen = new Set();
  for (const row of String(stdout || "").split("\n")) {
    if (!row.trim()) continue;
    const tab = row.indexOf("\t");
    if (tab < 0) continue;
    const workdir = row.slice(0, tab).trim();
    const image = row.slice(tab + 1).trim();
    if (!workdir || !image) continue;
    const actual = resolve(workdir);
    const hit = roots.find(([root]) => actual === root || actual.startsWith(root + sep));
    if (!hit) continue;
    const key = `${hit[1]}\t${image}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ bundleId: hit[1], image });
  }
  return out;
}

/** A Go RFC3339Nano timestamp as epoch ms, or null. JS Date parsing only defines up to milliseconds. */
export function parseDockerTimestamp(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const ms = Date.parse(s.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * `docker image inspect --format '{{.Created}}' <images…>` → image → epoch ms.
 *
 * Docker answers one line per image in argv order, so the answer is zipped with
 * the request. A ragged answer (a line count that does not match) is not
 * trusted at all: a silently shifted zip would attribute one image's age to
 * another, and "unknown age" is the honest answer there.
 */
export function parseImageCreated(stdout, images = []) {
  const lines = String(stdout || "").split("\n").filter((l) => l.trim() !== "");
  const out = new Map();
  if (lines.length !== images.length) return out;
  for (let i = 0; i < images.length; i++) {
    const ms = parseDockerTimestamp(lines[i]);
    if (ms != null) out.set(images[i], ms);
  }
  return out;
}

/**
 * The age verdict. Per bundle, the OLDEST running image decides (a bundle whose
 * database sidecar is fresh but whose app image is two years old is a two-year-
 * old bundle).
 *
 * @returns {{old: Array<{bundleId: string, image: string, days: number}>, unknown: string[]}}
 *   `old` is sorted oldest first; `unknown` lists images docker reported no
 *   creation time for.
 */
export function bundleImageAges({ images = [], created = new Map(), nowMs = Date.now(), staleDays = BUNDLE_IMAGE_STALE_DAYS } = {}) {
  const oldest = new Map();
  const unknown = [];
  for (const { bundleId, image } of images) {
    const at = created.get(image);
    if (at == null) {
      if (!unknown.includes(image)) unknown.push(image);
      continue;
    }
    const days = Math.max(0, Math.floor((nowMs - at) / 86_400_000));
    const prev = oldest.get(bundleId);
    if (!prev || days > prev.days) oldest.set(bundleId, { image, days });
  }
  const old = [...oldest.entries()]
    .map(([bundleId, v]) => ({ bundleId, image: v.image, days: v.days }))
    .filter((e) => e.days >= staleDays)
    .sort((a, b) => b.days - a.days || (a.bundleId < b.bundleId ? -1 : a.bundleId > b.bundleId ? 1 : 0));
  return { old, unknown };
}