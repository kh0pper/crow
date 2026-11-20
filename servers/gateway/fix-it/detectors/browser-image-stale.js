// Copy approved by the operator 2026-11-19. Every user-facing string this card shows, EN and ES.
// The card renderer (fix-it/index.js) writes one text into fix_it_items and shows it
// as it is, so the card uses `.en` today; `.es` is kept beside it for the operator's
// approval and for the day the cards carry the viewer's `lang`. Plain, short
// sentences, no jargon. "Not now" is not here on purpose: it is the ONE dismissal
// button every Fix-it card already renders (fix-it/index.js → store.dismiss, a 7-day
// snooze, nothing changed), not a per-card string.
export const COPY = Object.freeze({
  title: {
    en: "The browser add-on is still running the old version",
    es: "El complemento del navegador sigue ejecutando la versión anterior",
  },
  body: {
    en: "Crow updated the browser add-on, but the copy that is running is still the old one. "
      + "Restart it to load the update. A restart cannot be undone, and the pages that are open in the browser now will close. "
      + "Saved logins and cookies are kept.",
    es: "Crow actualizó el complemento del navegador, pero la copia que está en marcha sigue siendo la anterior. "
      + "Reinícialo para cargar la actualización. Un reinicio no se puede deshacer, y las páginas que están abiertas ahora en el navegador se cerrarán. "
      + "Los inicios de sesión y las cookies guardados se conservan.",
  },
  restartAction: {
    en: "Restart the browser add-on",
    es: "Reiniciar el complemento del navegador",
  },
  openExtensions: {
    en: "Open Extensions",
    es: "Abrir Extensiones",
  },
});

/**
 * Fix-it detector: the browser add-on is RUNNING files that differ from the ones Crow
 * installed (the "stale browser image" card for existing installs).
 *
 * Why this card exists. bundles/browser/cdp-relay.mjs (the WebRTC launch flag, the
 * refusal to honour Target.createTarget, the BackForwardCache flag) runs INSIDE the
 * browser container: it is COPYed into the image. A bundle refresh copies the new
 * files into ~/.crow/bundles/browser/, and its version-gated refresh is what an
 * upgraded install gets — but nothing rebuilds or restarts a running container
 * (routes/bundles.js: "No automatic rebuild: Extensions Restart/Start runs
 * `up -d --build`"). So an existing install keeps answering with the old relay until
 * someone restarts the add-on, silently. This card says so and offers that restart.
 *
 * ── The signal, and why this one ────────────────────────────────────────────
 * The add-on is STALE when a RUNNING container of the bundle's compose project holds
 * different bytes at the image's COPY destinations than the files Crow has installed,
 * or does not hold one of those files at all. The comparison is CONTENT, read out of
 * the running container itself:
 *
 *   docker ps --filter label=com.docker.compose.project=<project> --filter status=running
 *     → the running container ids
 *   docker exec <id> sha256sum <dest paths…>   → the hashes inside that container
 *   sha256(<installed source file>)            → node:crypto, on this host
 *
 * The destination paths come from the INSTALLED bundle's Dockerfile: WORKDIR sets the
 * base, and each COPY/ADD whose source is a literal name that really exists in the
 * build context contributes one destination — a relative dest resolves against
 * WORKDIR, a dest ending in "/" or equal to "." / "./" takes the source's basename,
 * and `COPY --from=` (another stage) is skipped. The build context comes from the
 * installed compose file; an install whose compose declares no build has nothing in
 * an image to compare and is quiet. The Dockerfile itself is NOT inside the image, so
 * it is never hashed. When the Dockerfile cannot be read or names nothing copyable,
 * the two files that image is known to carry (entrypoint.sh, cdp-relay.mjs) are
 * compared at the image's /app.
 *
 * An EARLIER rule compared the running image's `Created` time with the newest mtime
 * among those inputs, and it was wrong. A bundle refresh writes the files fresh, so
 * their mtimes move to now, while BuildKit caches layers by CONTENT: a rebuild after a
 * content-preserving refresh reuses the cached layers and leaves the image's Created
 * time old. The card therefore came straight back after the Restart it had just
 * performed. Bytes do not lie — identical content means the running container already
 * has what was installed, whatever the timestamps say.
 *
 * Considered and rejected: manifest.refreshFiles (a curated LIST of files a refresh
 * re-copies — it also names docker-compose.yml, which needs a recreate but not a
 * rebuild, and it says nothing about what an image contains); installed.json's
 * version (it follows the installed manifest, not the container: an install refreshed
 * at boot has the new version and the old bytes, which is the very case this card is
 * for); and an image label (the browser Dockerfile carries none, and a label would
 * only exist on images built after this change — useless for the installs that need
 * the card).
 *
 * Known limits, honestly:
 *
 *   Dockerfile only   the Dockerfile is not in the image, so a change to the Dockerfile
 *                     alone (a new RUN line, a new base image) is NOT seen by this
 *                     rule. It does not need to be: a Dockerfile change arrives with a
 *                     manifest version bump, and that path rebuilds.
 *   directories       a `COPY <dir>/ …` line names a directory, which is not walked:
 *                     only regular files named directly are hashed, so an edit INSIDE
 *                     a copied directory is not seen. The browser image copies single
 *                     files (cdp-relay.mjs, entrypoint.sh, package.json).
 *   stopped           only RUNNING containers are checked. A stopped add-on gets no
 *                     card — Start runs `up -d --build`, which rebuilds it anyway.
 *
 * Quiet (and the card resolves itself) when: the bundle is not installed or lives on
 * a satellite, its compose declares no build context, the Dockerfile yields nothing
 * to compare, no container of the project is running, or every compared file matches
 * the installed one. Docker failing is quiet too: docker itself unreachable, or the
 * `sha256sum` exec failing/timing out/answering something unreadable, gives no card,
 * one log line, and a pending card is left exactly as it is (no evidence either way).
 * A path sha256sum reports as missing IS evidence — the file the image is built from
 * is not in the running container.
 *
 * No event fires for a container's content, so this is a BOOT check
 * (`runBootChecks()`), and it rides the Extensions Start/stop/install re-check the
 * bind-drift detector already gets (`recheckOnContainerChange`, fix-it/index.js) — so
 * the card clears as soon as the restarted container is in place, without a second
 * call site in the routes.
 *
 * The docker calls go through bundle-core's `docker` runner (the same seam as the
 * rest of the bundle code) and are time-bounded; the restart itself is never done
 * here (fix-it/remedies/restart-browser-addon.js owns it).
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CROW_HOME, manifestComposeFile } from "../../bundles-config.js";
import { composeProjectName } from "../../bundle-lifecycle.js";
import { dockerRunner, readInstalled } from "../../bundle-core.js";
import { composeEnv, parseDotEnv } from "../../compose-guard.js";
import { isSatelliteEntry } from "../../satellites/installs.js";
import { ACTION_ID as RESTART_ACTION_ID } from "../remedies/restart-browser-addon.js";

export const SOURCE = "browser-image-stale";
/** The one bundle this detector watches. */
export const BUNDLE_ID = "browser";
/** One card for the browser bundle; the `:image-stale` kind keeps it apart from the drift cards. */
export const DEDUP_KEY = `bundle:${BUNDLE_ID}:image-stale`;
/** The link remedy whose target lives in code (fix-it/index.js LINK_REMEDIES). */
export const REMEDY_ACTION_ID = "open-extensions-page";

/** `docker ps` / `docker exec` bounds — never an unbounded docker call. */
export const DOCKER_PS_TIMEOUT_MS = 15_000;
/** Reading the hashes out of a running container (a cold exec can take a moment). */
export const DOCKER_EXEC_TIMEOUT_MS = 20_000;
/** What is compared when the Dockerfile cannot be read or names nothing copyable. */
export const FALLBACK_INPUTS = Object.freeze(["entrypoint.sh", "cdp-relay.mjs"]);
/** The browser image's WORKDIR, for the fallback above (the Dockerfile is unreadable). */
export const FALLBACK_WORKDIR = "/app";
/** A COPY source or destination that is a glob, a URL or a variable is not a path we can use. */
const LITERAL_SOURCE = /^[^$*?[\]{}]+$/;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/** A path inside `root` (relative, no escape), or null. */
function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? rel : null;
}

const unquote = (v) => String(v).replace(/^["']|["']$/g, "");
const escapeRegExp = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A path inside the image, relative ones resolved against the current WORKDIR. */
function imagePath(workdir, path) {
  return isAbsolute(path) ? resolve(path) : resolve(workdir, path);
}

/** The sha256 of an installed file, or null when it cannot be read. */
function fileSha256(path) {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return null; }
}

/**
 * The build contexts the compose text declares, as `[{ contextDir, dockerfile }]` in
 * absolute paths inside `dir`. Regex over the lines, exactly the shape the bundle
 * refresh reads (routes/bundles.js `composeBuildContexts`): this detector must not
 * pull in that module, which drags express and the DB.
 */
export function buildSpecs({ composeText, composeRel = "docker-compose.yml", dir }) {
  const composeDir = dirname(join(dir, composeRel));
  const lines = String(composeText || "").split(/\r?\n/);
  const clean = (v) => String(v).replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
  const specs = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s+)build:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let context = "";
    let dockerfile = "Dockerfile";
    const inline = clean(m[2]);
    if (inline && !inline.startsWith("{")) {
      // `build: .` — the short form, no dockerfile key.
      context = inline;
    } else {
      const indent = m[1].length;
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim() || /^\s*#/.test(lines[j])) continue;
        if (/^(\s*)/.exec(lines[j])[1].length <= indent) break;
        const c = /^\s+context:\s*(.+)$/.exec(lines[j]);
        if (c) { context = clean(c[1]); continue; }
        const d = /^\s+dockerfile:\s*(.+)$/.exec(lines[j]);
        if (d) dockerfile = clean(d[1]);
      }
    }
    // A context that is absolute, a variable or a URL is not something to stat.
    if (!context || isAbsolute(context) || !LITERAL_SOURCE.test(context)) continue;
    const contextDir = resolve(composeDir, context);
    if (inside(dir, contextDir) === null) continue;
    const dockerfilePath = isAbsolute(dockerfile) ? dockerfile : resolve(contextDir, dockerfile);
    if (inside(contextDir, dockerfilePath) === null) continue;
    specs.push({ contextDir, dockerfile: dockerfilePath });
  }
  return specs;
}

/**
 * Where a build context's Dockerfile copies its files TO inside the image, paired with
 * the installed source each one comes from: `[{ source, dest }]`, absolute paths.
 * `null` when the Dockerfile cannot be read, so the caller can fall back.
 *
 * Only files, never directories, and only literal names that exist in the context;
 * multi-stage `COPY --from=` lines copy from another stage, not from the context, and
 * are skipped. A destination ending in "/" (or "." / "./") is a directory, so the
 * file keeps its own basename; everything else is a full destination path. The
 * Dockerfile itself is not copied into the image and never appears here.
 */
export function dockerfileCopies(dockerfilePath, contextDir) {
  let text;
  try { text = readFileSync(dockerfilePath, "utf8"); } catch { return null; }
  const copies = new Map(); // dest → installed source, so two lines to one dest count once
  let workdir = "/";
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const wd = /^\s*WORKDIR\s+(.+)$/i.exec(line);
    if (wd) { workdir = imagePath(workdir, unquote(wd[1].trim())); continue; }
    const m = /^\s*(?:COPY|ADD)\s+(.+)$/i.exec(line);
    if (!m) continue;
    const tokens = m[1].trim().split(/\s+/).filter(Boolean);
    // Leading flags (--chown=…, --chmod=…); `--from=` is another stage, not this context.
    let fromStage = false;
    while (tokens.length > 0 && tokens[0].startsWith("--")) {
      if (tokens[0].startsWith("--from")) fromStage = true;
      tokens.shift();
    }
    if (fromStage || tokens.length < 2) continue;
    const rawDest = unquote(tokens[tokens.length - 1]);
    // A destination built from a variable or a glob is not a path we can name.
    if (!LITERAL_SOURCE.test(rawDest)) continue;
    const destIsDir = rawDest.endsWith("/") || rawDest === "." || rawDest === "./";
    // The last token is the destination inside the image; the rest are sources.
    for (const rawSrc of tokens.slice(0, -1)) {
      const src = unquote(rawSrc);
      if (!LITERAL_SOURCE.test(src)) continue;
      const abs = resolve(contextDir, src);
      if (inside(contextDir, abs) === null) continue;
      // A source that is not on disk is not something the image can carry: it is skipped,
      // never compared (a dest with no installed file to compare against would be a guess).
      try { if (!statSync(abs).isFile()) continue; } catch { continue; }
      const dest = destIsDir ? imagePath(imagePath(workdir, rawDest), basename(abs)) : imagePath(workdir, rawDest);
      copies.set(dest, abs);
    }
  }
  return [...copies].map(([dest, source]) => ({ dest, source }));
}

/**
 * Every (installed source → path inside the image) pair the bundle's images carry.
 * Falls back to FALLBACK_INPUTS at FALLBACK_WORKDIR when the Dockerfile yields nothing
 * usable — the files those images are known to carry.
 */
export function imageCopies({ composeText, composeRel, dir }) {
  const copies = new Map(); // dest → source, across every build context of the compose
  for (const spec of buildSpecs({ composeText, composeRel, dir })) {
    const parsed = dockerfileCopies(spec.dockerfile, spec.contextDir);
    const list = parsed && parsed.length > 0
      ? parsed
      : FALLBACK_INPUTS.map((rel) => ({ source: resolve(spec.contextDir, rel), dest: imagePath(FALLBACK_WORKDIR, rel) }));
    for (const { source, dest } of list) {
      const abs = resolve(source);
      if (inside(spec.contextDir, abs) === null) continue;
      try { if (!statSync(abs).isFile()) continue; } catch { continue; }
      if (!copies.has(dest)) copies.set(dest, abs);
    }
  }
  return [...copies].map(([dest, source]) => ({ dest, source }));
}

/**
 * `docker exec <id> sha256sum <dests…>`, parsed. `{ hashes, missing }` when the answer
 * is readable evidence, `null` when it is not (exec failed, timed out, or printed
 * something that is not `sha256sum` output) — the caller stays quiet then.
 *
 * sha256sum exits non-zero for a file it cannot open and names it on stderr, so an
 * unreported dest is "missing" ONLY when stderr says exactly that about it; anything
 * else unreported means the answer as a whole is unreadable.
 */
async function containerHashes({ id, dests, runner }) {
  let stdout = "";
  let stderr = "";
  try {
    const out = await runner("docker", ["exec", id, "sha256sum", ...dests], { timeout: DOCKER_EXEC_TIMEOUT_MS });
    stdout = String(out?.stdout ?? "");
    stderr = String(out?.stderr ?? "");
  } catch (err) {
    stdout = String(err?.stdout ?? "");
    stderr = String(err?.stderr ?? "");
  }
  const hashes = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m) hashes.set(m[2], m[1].toLowerCase());
  }
  const missing = new Set();
  for (const dest of dests) {
    if (hashes.has(dest)) continue;
    const absent = new RegExp(`^sha256sum: ${escapeRegExp(dest)}: No such file or directory$`, "m");
    if (!absent.test(stderr)) return null;
    missing.add(dest);
  }
  return { hashes, missing };
}

export default {
  source: SOURCE,
  // A container's content emits no event: runBootChecks() calls check() at gateway start.
  events: [],
  async onEvent() {},
  /**
   * A running container's own state changes at every Start, stop and rebuild — the
   * same moments routes/bundles.js already re-runs the bind-drift check for one
   * bundle. Declaring it here lets fix-it/index.js fan that re-check out to this
   * detector, so the card clears once the restarted container is in place (no second
   * call site).
   */
  recheckOnContainerChange: true,
  /**
   * `opts`: { crowHome, bundlesDir, installedPath, runner, log, only } — `only` limits
   * the pass to the bundle ids the caller just restarted, exactly as the bind-drift
   * detector does. One card, resolved by itself once the container holds the installed
   * bytes. Never throws into boot.
   */
  async check(store, opts = {}) {
    const crowHome = opts.crowHome || CROW_HOME;
    const bundlesDir = opts.bundlesDir || join(crowHome, "bundles");
    const runner = opts.runner || dockerRunner();
    const log = opts.log || console;
    const only = opts.only ? new Set(Array.isArray(opts.only) ? opts.only : [opts.only]) : null;
    const resolveCard = async () => {
      try { await store.resolveByKey(SOURCE, DEDUP_KEY); } catch { /* no row yet, or no store */ }
    };

    // Another bundle's container changed: this one's card is none of that pass's business.
    if (only && !only.has(BUNDLE_ID)) return { cards: [] };

    const installed = readInstalled(opts.installedPath || join(crowHome, "installed.json"));
    const record = installed.find((r) => (typeof r === "string" ? r : r?.id) === BUNDLE_ID);
    // Not installed (or hosted on a satellite): any card left from before is stale.
    if (!record || isSatelliteEntry(record)) { await resolveCard(); return { cards: [] }; }

    const dir = join(bundlesDir, BUNDLE_ID);
    const manifest = readJson(join(dir, "manifest.json"));
    const composeRel = manifestComposeFile(manifest);
    let composeText = null;
    if (composeRel) {
      try { composeText = readFileSync(join(dir, composeRel), "utf8"); } catch { composeText = null; }
    }
    if (!composeText) { await resolveCard(); return { cards: [] }; }

    // What the image is built from, and the hash each of those files has on disk now.
    const planned = imageCopies({ composeText, composeRel, dir })
      .map(({ dest, source }) => ({ dest, source, sha256: fileSha256(source) }))
      .filter((p) => p.sha256 !== null);
    // Nothing comparable: no build context, an unreadable input, nothing to say.
    if (planned.length === 0) { await resolveCard(); return { cards: [] }; }
    const dests = planned.map((p) => p.dest);

    const env = { ...parseDotEnv(join(dir, ".env")), ...composeEnv(process.env, crowHome) };
    let ids;
    try {
      const { stdout } = await runner("docker", [
        "ps",
        "--filter", `label=com.docker.compose.project=${composeProjectName(composeText, dir, env)}`,
        "--filter", "status=running",
        "--format", "{{.ID}}",
      ], { timeout: DOCKER_PS_TIMEOUT_MS });
      ids = String(stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      // Docker unreachable: no card, and a pending one is left as it is (silence is
      // not evidence either way). One line per pass, never one per bundle.
      log.warn("[fix-it] browser image check skipped: docker is not reachable (the browser card was left as it is)");
      return { cards: [] };
    }

    // Nothing running: a stopped add-on gets no card (Start rebuilds it anyway).
    if (ids.length === 0) { await resolveCard(); return { cards: [] }; }

    const differences = [];
    for (const id of ids) {
      const answer = await containerHashes({ id, dests, runner });
      if (!answer) {
        // The exec failed, timed out or answered something we cannot read: no evidence
        // either way. No card, and a pending card is left exactly as it is.
        log.warn(`[fix-it] browser image check skipped: could not read the files in container ${id} (the browser card was left as it is)`);
        return { cards: [] };
      }
      for (const p of planned) {
        if (answer.missing.has(p.dest)) { differences.push(p.dest); continue; }
        if (answer.hashes.get(p.dest) !== p.sha256) differences.push(p.dest);
      }
    }

    // The running containers already hold exactly the installed bytes.
    if (differences.length === 0) { await resolveCard(); return { cards: [] }; }

    await store.upsertItem({
      source: SOURCE,
      dedupKey: DEDUP_KEY,
      title: COPY.title.en,
      why: COPY.body.en,
      severity: "warn",
      remedies: [
        { actionId: RESTART_ACTION_ID, kind: "instant", label: COPY.restartAction.en, args: { bundle: BUNDLE_ID } },
        { actionId: REMEDY_ACTION_ID, kind: "link", label: COPY.openExtensions.en },
      ],
      context: {
        bundle: BUNDLE_ID,
        // Where inside the image the bytes differ from the files Crow installed.
        files: [...new Set(differences)].slice(0, 8),
        installed: [...new Set(planned.map((p) => relative(dir, p.source)))].slice(0, 8),
      },
    });
    return { cards: [`${BUNDLE_ID}: the running container holds files that differ from the installed ones`] };
  },
};