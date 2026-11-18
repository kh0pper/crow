/**
 * The secret FILES and FOLDERS a bot's sandbox hides: the files with --ro-bind
 * /dev/null (pi_sandbox.mjs hideFiles), and the operator's credential folders
 * (~/.ssh, ~/.gnupg, ~/.config/gcloud, ~/.aws, …) whole, behind a tmpfs. Built
 * here, per spawn, from the instance's Crow home, the repo checkout and the
 * operator's home.
 *
 * WHICH folders and files are the operator's secrets is ONE list,
 * OPERATOR_SECRET_PATHS in servers/shared/operator-secret-paths.js: this module
 * turns it into masks, the contain tier and the add-on wall into a refuse list,
 * and the isolation report and the file history read the same entries.
 */
import { readdirSync, lstatSync, realpathSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { OPERATOR_SECRET_DIRS, OPERATOR_SECRET_FILES } from "../../servers/shared/operator-secret-paths.js";

/**
 * Bundles whose tool servers read their OWN .env inside the bot's sandbox at
 * run time: bundles/browser/server/instance.js and
 * bundles/workspace/server/config.js. Their .env stays readable until the
 * Phase 2 browser door replaces the file-based CDP token. Every other
 * bundle's .env has no reader inside the sandbox.
 */
export const BUNDLE_ENV_READABLE = ["browser", "workspace"];

/**
 * Root files the gateway side reads and hands the bot in its MCP block
 * headers (scripts/pi-bots/crow-server-catalog.mjs), so a bot never needs the
 * file itself.
 *
 * Deliberately NOT masked, and the reader inside the sandbox:
 *  - models-token: pi-lab's local-models extension.
 *  - llm-cloud-token: pi runs `cat` on it as a provider apiKey.
 *  - kiosk-announce-token: the kiosk MCP server reads it on each call
 *    (bundles/kiosk/server/server.js).
 *  - studio-agent-token: the studio MCP server reads it on each call
 *    (bundles/studio/server/hub-client.js).
 *
 * `.env` and its copies at a root are not named here: they are picked up by
 * the `.env*` name rule (isSecretEnvName), which masks every one of them.
 * Neither is `mcp-addons.json` and its copies: they are picked up by the
 * add-on name rule (isAddonsFileName) at the Crow home root only. The add-on
 * env values carry keys, and the gateway side reads the file and hands those
 * values to the bot in its `.mcp.json` blocks, so a bot never needs it.
 */
export const ROOT_SECRET_FILES = [".keystore-env", "board-token", "phone-token", "artifacts-token"];

/** A `.env` name: `.env` or `.env.<anything>` (a .env.bak-2026... copy too). */
export const BUNDLE_ENV_NAME_RE = /^\.env(\..*)?$/;

/**
 * True for a name whose CONTENT is a secret: BUNDLE_ENV_NAME_RE minus the
 * `.example` templates (`.env.example`, `.env.garage.example`), which are
 * documentation and stay readable — at a bundle dir and at a root.
 */
export function isSecretEnvName(n) {
  return BUNDLE_ENV_NAME_RE.test(n) && !n.endsWith(".example");
}

/**
 * An add-on registry name at the Crow home root: any name starting with
 * `mcp-addons` or `.mcp-addons`, except `mcp-addons.example.json`. That covers
 * the file itself, its backup copies in every shape a writer or an operator
 * leaves (`mcp-addons.json.bak`, `mcp-addons.json.bak-<date>`,
 * `mcp-addons.json.bak.<epoch>`, `mcp-addons.json.pre-<tag>-<date>`,
 * `mcp-addons.bak.json`, `mcp-addons-old.json`, `mcp-addons.json-<date>`, an
 * editor's `mcp-addons.json~`), and the temp files held beside it until one is
 * renamed over it: `.mcp-addons.json.tmp-<pid>-<hex>` (the gateway's
 * writePrivateFile) and `.mcp-addons.json.tmp-<pid>-<base36>`
 * (scripts/addon-sandbox/migrate-linked.mjs writeAtomicPrivate), and the no-dot
 * `mcp-addons.json.tmp-<pid>` (scripts/ops/pin-addon-command.mjs). All of them
 * hold the full add-on env. The exemption is a file NAME ENDING IN
 * `.example.json`, not the name itself: `mcp-addons.example.json` is
 * documentation, not a secret, and so is a dotted `.mcp-addons.example.json`,
 * which the lookahead exempts the same way.
 */
export const ADDONS_FILE_NAME_RE = /^\.?mcp-addons(?!\.example\.json$)[^/]*$/;

/**
 * True for a name whose CONTENT is the add-on registry with its env values:
 * any name at the home root starting with `mcp-addons` or `.mcp-addons`,
 * except a file name ending in `.example.json` (the templates, which stay
 * readable).
 * Over-masking is the safe direction, so every other suffix — `.bak`, a date,
 * another `.json` segment, a `~`, and the writers' temp names — matches.
 */
export function isAddonsFileName(n) {
  return ADDONS_FILE_NAME_RE.test(n);
}

/**
 * Absolute paths of the secret files to mask, for one Crow home (and the
 * repo checkout at appRoot, when given). Pass REAL paths (the caller resolves
 * its roots first). Existence is not checked for the plain candidates:
 * wrapPiSpawn skips a file it cannot stat.
 *
 * Each root — the Crow home and the repo checkout at appRoot — contributes
 * every regular file or symlink directly in it named `.env` or `.env.*` (a
 * backup copy `.env.bak-<date>` too), except the `.example` templates, so a
 * copy beside the real file is masked as well. `.env` itself is listed at
 * both roots whether it exists or not: the plain file is the one secret that
 * must never be missed.
 *
 * Bundles are enumerated in `<crowHome>/bundles` and `<appRoot>/bundles`: every
 * regular file or symlink named `.env` or `.env.*` (except `.example`) in a
 * bundle dir, except the bundles whose server reads its own. A bundle entry
 * that is a symlink is resolved: landing under a trusted root (crowHome or
 * appRoot) its `.env*` files are listed at their real path (the other root's
 * enumeration covers the same files); landing outside every root with an
 * `.env*` behind it, the files are
 * listed under the link's own path, which wrapPiSpawn never follows, so the
 * caller refuses the spawn. A symlink with nothing behind it, and anything
 * that is not a dir, is ignored.
 * A `.env*` entry that is itself a symlink to a regular file under a root is
 * listed at the file's real path (masking the target hides the link's content
 * too); one whose target sits under a dir in `hiddenDirs` (hidden whole, like
 * env/) is already hidden and is not listed; a dangling one is ignored; any
 * other is listed under its own name so the caller refuses.
 *
 * The CROW HOME ONLY (never appRoot, a repo checkout that holds no add-on
 * registry) also contributes `<crowHome>/mcp-addons.json` whether it exists or
 * not, plus every regular file or symlink directly in the home root whose name
 * isAddonsFileName accepts: any name starting with `mcp-addons` or
 * `.mcp-addons`, except a file name ending in `.example.json` (the shipped
 * `mcp-addons.example.json`, and the dotted one). ADDONS_FILE_NAME_RE
 * spells out the covered copies — the `.bak`, `.bak-<date>`, `.bak.<epoch>`,
 * `.pre-<tag>-<date>` and other backup shapes, an editor's `~`, and the
 * `.mcp-addons.json.tmp-*` file a writer holds while it renames one into place
 * — so the rule is the name prefix, not a `mcp-addons.json` prefix. All of them
 * get the same symlink handling as the `.env*` names. The add-on env values
 * carry keys and the gateway side reads the file and hands the bot the env in
 * its `.mcp.json` blocks, so the file itself is never needed inside the
 * sandbox.
 * @param {{crowHome:string, appRoot?:string, hiddenDirs?:string[], readdir?:Function}} opts
 * @returns {string[]}
 */
export function secretFilesFor({ crowHome, appRoot, hiddenDirs = [], readdir = readdirSync }) {
  const out = [];
  const add = (p) => { if (!out.includes(p)) out.push(p); };
  for (const n of ROOT_SECRET_FILES) add(join(crowHome, n));
  add(join(crowHome, ".env"));
  add(join(crowHome, "mcp-addons.json"));
  if (appRoot) add(join(appRoot, ".env"));
  const roots = [crowHome, appRoot].filter(Boolean);
  const underRoot = (p) => roots.some((r) => p === r || p.startsWith(r + "/"));
  const under = (p, dirs) => dirs.some((d) => p === d || p.startsWith(d + "/"));
  const addEnv = (dir, n) => {
    const f = join(dir, n);
    if (entryKind(f) !== "link") { add(f); return; }
    let t; try { t = realpathSync(f); } catch { return; }              // dangling: nothing to hide
    if (under(t, hiddenDirs)) return;                                    // already behind a hidden dir
    let isFile = false; try { isFile = lstatSync(t).isFile(); } catch { /* gone */ }
    if (isFile && underRoot(t)) add(t); else add(f);
  };
  // Every `.env*` file directly in a root (a backup copy too), through the
  // bundle rule's symlink handling: resolved under a root it is listed at its
  // real path, behind a hidden dir it is already hidden, dangling it is
  // ignored, and one leaving the roots is listed under its own name so the
  // caller refuses the spawn.
  for (const root of roots) for (const n of maskedNamesIn(root, readdir, isSecretEnvName)) addEnv(root, n);
  // The add-on registry at the Crow home root only: every name isAddonsFileName
  // accepts (any name starting with `mcp-addons` or `.mcp-addons`, except one
  // whose name ends in `.example.json`) — the file itself, every backup
  // copy shape and a writer's temp file. The repo checkout never holds one, and
  // the env values the file carries are keys.
  for (const n of maskedNamesIn(crowHome, readdir, isAddonsFileName)) addEnv(crowHome, n);
  // Every bundle dir, including a stale copy (x.migrated-...): its .env files
  // are secrets too. A missing bundles dir means none.
  for (const root of roots) {
    for (const id of bundleIds(root, readdir)) {
      if (BUNDLE_ENV_READABLE.includes(id)) continue;
      const dir = join(root, "bundles", id);
      const kind = entryKind(dir);
      if (kind === "dir") { for (const n of maskedNamesIn(dir, readdir, isSecretEnvName)) addEnv(dir, n); continue; }
      if (kind !== "link") continue;
      let real;
      try { real = realpathSync(dir); } catch { continue; }
      if (entryKind(real) !== "dir") continue;
      if (underRoot(real)) { for (const n of maskedNamesIn(real, readdir, isSecretEnvName)) addEnv(real, n); }
      else { for (const n of maskedNamesIn(real, readdir, isSecretEnvName)) add(join(dir, n)); }
    }
  }
  return out;
}

/**
 * The dirs wrapPiSpawn pins (hidePinDirs) so a bot cannot swap one for a
 * symlink or rename it between the listing and the mount: `<root>/bundles` and
 * every bundle dir that is a real dir, with or without a `.env` — for the Crow
 * home AND the repo checkout at appRoot, since both are enumerated and masked.
 * Deduped, so a root listed twice (or one that is the other) is pinned once.
 */
export function secretPinDirsFor({ crowHome, appRoot, readdir = readdirSync }) {
  const out = [];
  for (const root of [crowHome, appRoot].filter(Boolean)) {
    const bundles = join(root, "bundles");
    if (entryKind(bundles) !== "dir") continue;
    if (!out.includes(bundles)) out.push(bundles);
    for (const id of bundleIds(root, readdir)) {
      const dir = join(bundles, id);
      if (entryKind(dir) === "dir" && !out.includes(dir)) out.push(dir);
    }
  }
  return out;
}

/**
 * The refusal shown on a failed turn when a secret file exists but the default
 * tier could not mask it: one sentence, naming the path below its trusted root
 * and never any content. `cause` is what the caller measured:
 *  - "hardlink": another name on disk (masking one leaves the other readable);
 *  - "outside": the path sits under none of the trusted roots;
 *  - "hidden-dir": the path — or the link it is listed through — lands in a
 *    folder already hidden whole (a secrets dir, env/, android-keystore/), so
 *    the link itself is the problem;
 *  - "link-out": the first link on the way up leads outside every root;
 *  - "link-inside": a link, or a path through one, that stays inside the roots.
 * An unknown cause falls back to "link-inside" (the vaguer link sentence).
 *
 * `extra.home` is the Crow home the link path sits in; a link-out sentence
 * adds which home that is (and leaves it out when the caller knows none).
 */
export function unmaskableRefusal(rel, cause, extra = {}) {
  const start = "A bot could not start: " + rel;
  if (cause === "hardlink") return start + " has another name on disk, so Crow can't hide it. Remove the extra link.";
  if (cause === "outside") return start + " is outside the Crow folders, so Crow can't hide it.";
  if (cause === "hidden-dir") return start + " is a link into a hidden folder, so Crow can't hide it. Remove the link.";
  if (cause === "link-out") {
    const home = extra && extra.home;
    return start + " is a link that leads outside the Crow folders, so Crow can't hide it." +
      (home ? " It is in the Crow home " + home + "." : "") + " Remove the link.";
  }
  return start + " is a link or sits behind one, so Crow can't hide it. Remove the link.";
}

/** The refusal when one entry of the list exists but was not masked at all:
 *  hidden-or-refuse, so a bot never runs with an operator credential reachable.
 *  Never used for an entry that does not exist. */
export function secretNotHiddenRefusal(rel) {
  return "A bot could not start: Crow could not hide ~/" + rel + ".";
}
/** ~/.ssh could not be masked (it is hidden whole on every default-tier spawn,
 *  and created empty when it is missing, so this is a real failure). */
export const SSH_NOT_HIDDEN_REFUSAL = secretNotHiddenRefusal(".ssh");

/**
 * The operator's secret FOLDERS, relative to the operator's home — one list,
 * `OPERATOR_SECRET_PATHS` in servers/shared/operator-secret-paths.js. Each is
 * hidden WHOLE (a tmpfs) and each is resolved by resolveHiddenSecretPath below:
 * one walk, one refusal sentence per entry, and (folders only) one identity
 * memory — see the block below for why a FILE has none.
 *
 *  - `~/.ssh`: the operator's ssh keys. Hidden on every default-tier spawn and
 *    created empty (0700) when it is absent, so a bot can never plant
 *    `authorized_keys` under it.
 *  - `~/.gnupg`: gpg's private keys and trust db (and an agent socket).
 *  - `~/.config/gcloud`: the Google Cloud CLI's credential folder.
 *  - `~/.aws`, `~/.azure`, `~/.kube`, `~/.config/gh`, `~/.terraform.d`: the
 *    cloud and provider CLIs' credential and cluster config.
 * A host without one of these tools is left exactly as it is: an absent folder
 * is never created (except `~/.ssh`, which the mask needs) and, when it was
 * never seen, there is simply nothing to hide.
 */
export const SSH_DIR_REL = ".ssh";
export const GNUPG_DIR_REL = ".gnupg";
export const GCLOUD_DIR_REL = ".config/gcloud";
/** Every folder this module hides whole, in the order the bridge asks: the
 *  shared list, never a copy of it. */
export const HIDDEN_SECRET_DIRS = OPERATOR_SECRET_DIRS;
/** The operator's credential FILES from the same list: masked with an empty
 *  file (a read-only /dev/null), never created, and — unlike a folder — never
 *  remembered by (dev, ino): an ordinary rewrite is a new inode at the same
 *  path, and the mask is rebuilt from the path on every spawn. */
export const HIDDEN_SECRET_FILES = OPERATOR_SECRET_FILES;

/** The refusal when an existing ~/.config/gcloud could not be masked at all
 *  (the same rule every entry of the list gets). Never used for a folder that
 *  does not exist. */
export const GCLOUD_NOT_HIDDEN_REFUSAL = secretNotHiddenRefusal(".config/gcloud");
/** The same rule for ~/.gnupg: hidden whole, or the spawn is refused. */
export const GNUPG_NOT_HIDDEN_REFUSAL = secretNotHiddenRefusal(".gnupg");

/**
 * The refusal when ONE of the secret folders exists and the launch's own mask
 * list does not report it hidden, or null when there is nothing to refuse (an
 * absent folder — a host with no gcloud CLI or no gpg — starts exactly as
 * before). Hidden-or-refuse, decided in ONE place so the rule can be exercised
 * without a bwrap host: `dir` is the folder the spawn found, `refusal` the
 * sentence for it, `masked` the dirs wrapPiSpawn says it really masked. A launch
 * that reports nothing at all is not trusted (masked undefined refuses).
 */
export function secretDirNotHiddenRefusal({ dir, refusal, masked } = {}) {
  if (!dir) return null;
  return (masked || []).includes(dir) ? null : refusal;
}

/** The same rule for ~/.config/gcloud, kept as its own named entry point. */
export function gcloudNotHiddenRefusal({ gcloudDir, masked } = {}) {
  return secretDirNotHiddenRefusal({ dir: gcloudDir, refusal: GCLOUD_NOT_HIDDEN_REFUSAL, masked });
}

/**
 * The refusal when a secret folder or file is a link, sits behind one, or a
 * component on the way is not the kind of entry it must be. The mask would
 * follow the link and hide its target, but a bot can re-point a link (its parent
 * is writable inside the sandbox), so the NEXT spawn would mask a decoy and
 * leave the real credential on the host readable. A link is refused outright
 * instead: one fixed sentence per entry, no paths in it (so it can never name a
 * decoy or a target), built from the entry's own name.
 */
export function secretLinkRefusal(rel, kind = "dir") {
  const what = kind === "file" ? "file" : "folder";
  const inside = kind !== "file" && (rel === SSH_DIR_REL || rel === GNUPG_DIR_REL) ? "the keys in it" : "the credentials in it";
  return "A bot could not start: ~/" + rel + " is a link, or sits behind one, so Crow can't hide " + inside +
    ". Replace it with a real " + what + ".";
}
export const SSH_LINK_REFUSAL = secretLinkRefusal(SSH_DIR_REL, "dir");
export const GNUPG_LINK_REFUSAL = secretLinkRefusal(GNUPG_DIR_REL, "dir");
export const GCLOUD_LINK_REFUSAL = secretLinkRefusal(GCLOUD_DIR_REL, "dir");

// ---- the identity memory ----------------------------------------------------

/**
 * The record of WHICH entry each secret FOLDER was (dev:ino), kept inside the
 * instance's secrets dir: that dir is hidden from every bot (a tmpfs in the
 * default tier, never bound in the contain tier), written 0600, and reached
 * through the boot-anchored fd by the bridge. It is the second half of the link
 * rule above: a folder that was hidden before and then goes missing, or is
 * replaced by another one at the same path, is how a re-pointed ancestor or a
 * swapped-in decoy shows up AFTER the fact, and it refuses the spawn until the
 * operator re-confirms (see HIDDEN_DIR_RESET_COMMAND).
 *
 * FOLDERS ONLY, deliberately. A FILE gets no identity memory (its own section in
 * resolveHiddenSecretPath): `npm config set` and `docker login` rewrite
 * `~/.npmrc` / `~/.docker/config.json` by writing a temp file and renaming it
 * over the old one, which is a NEW inode at the same path — an ordinary operator
 * action that would then refuse every bot until a manual reset, on a host with
 * no tampering at all. The mask itself needs no memory: each spawn lstat's the
 * leaf and every component again (a link refuses) and masks whatever file is at
 * that path (`--dev-bind /dev/null`), and the mount is a target a bot inside
 * cannot unlink or rename over (EBUSY), so it cannot swap the masked file for a
 * decoy within its own turn. Folders keep the memory because a folder CAN be
 * swapped between spawns — renamed away and replaced by a decoy at the same
 * path, or replaced by a re-created folder — and because a normal tool flow does
 * NOT change a folder's identity: `gcloud auth login` writes files INSIDE
 * `~/.config/gcloud`, leaving that folder's dev:ino alone (only the folder's own
 * dev:ino is recorded — never its contents or mtime).
 *
 * One file PER HOME (`hidden-secret-dirs-<id>.json`): the folders belong to the
 * operator's home, and several homes can share one instance's secrets dir (a
 * co-hosted test or a moved home), so a record is only ever compared with the
 * home it was written for.
 */
export const HIDDEN_DIR_STATE_PREFIX = "hidden-secret-dirs-";
export const HIDDEN_DIR_STATE_SUFFIX = ".json";
export const HIDDEN_DIR_STATE_VERSION = 1;
/** The operator action that forgets every remembered folder (an alternative to
 *  deleting the record). The next spawn records them all again. Also the remedy
 *  named in the bell that a refused spawn raises. */
export const HIDDEN_DIR_RESET_COMMAND = "node scripts/pi-bots/hidden-dir-memory.mjs --reset";

/** The record's file name for one home: its resolved path hashed, so a moved
 *  home spelling (a symlinked $HOME) and a symlinked `/tmp` do not split it. */
export function hiddenDirStateFile(home) {
  let key = String(home || "");
  try { key = realpathSync(home); } catch { /* no home: hash the spelling */ }
  return HIDDEN_DIR_STATE_PREFIX + createHash("sha256").update(key).digest("hex").slice(0, 16) + HIDDEN_DIR_STATE_SUFFIX;
}

/** Where the identity memory lives for one Crow home and one operator home. */
export function hiddenDirStatePath(crowHome, home) {
  return join(crowHome, "secrets", hiddenDirStateFile(home));
}

/** Every identity record in one Crow home's secrets dir (the CLI's `--list` and
 *  `--reset`; there is one per operator home). */
export function hiddenDirStateFiles(crowHome) {
  const dir = join(crowHome, "secrets");
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.startsWith(HIDDEN_DIR_STATE_PREFIX) && n.endsWith(HIDDEN_DIR_STATE_SUFFIX))
    .map((n) => join(dir, n));
}

/**
 * Read the identity memory: `{dirs: {rel: {dev, ino}}}` (and the home it was
 * written for, informational). A missing file is an empty memory (the first
 * spawn on this instance). Anything unreadable, or not exactly this shape,
 * comes back `ok:false`: the caller refuses the spawn (fail closed) rather than
 * treat a folder it cannot verify as "new".
 *
 * An entry for a FILE of the list is dropped here: files carry no identity
 * memory any more (see the block above), so a record written by an older build
 * keeps working — its file entries are simply forgotten — without an operator
 * reset. Files that are no longer on the list are untouched (the caller never
 * looks them up, and a hand-written record keeps whatever it holds).
 */
export function readHiddenDirMemory(statePath) {
  const bad = { ok: false, reason: "unreadable", dirs: {}, home: null };
  let raw;
  try { raw = readFileSync(statePath, "utf8"); } catch (e) {
    if (e && e.code === "ENOENT") return { ok: true, dirs: {}, home: null };
    return bad;
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return bad; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bad;
  if (parsed.version !== HIDDEN_DIR_STATE_VERSION) return bad;
  const dirs = parsed.dirs;
  if (!dirs || typeof dirs !== "object" || Array.isArray(dirs)) return bad;
  const out = {};
  for (const [rel, id] of Object.entries(dirs)) {
    if (!id || typeof id !== "object" || Array.isArray(id)) return bad;
    if (!Number.isInteger(id.dev) || id.dev < 0 || !Number.isInteger(id.ino) || id.ino < 0) return bad;
    if (HIDDEN_SECRET_FILES.includes(rel)) continue; // files have no identity memory
    out[rel] = { dev: id.dev, ino: id.ino };
  }
  const home = typeof parsed.home === "string" ? parsed.home : null;
  return { ok: true, dirs: out, home };
}

/**
 * Write the identity memory 0600, through a temp file in the same dir and a
 * rename, so a reader never sees half a record. Throws on failure: the caller
 * refuses the spawn then (a folder it cannot remember is a folder it cannot
 * re-check).
 */
export function writeHiddenDirMemory(statePath, dirs, home = null) {
  const tmp = statePath + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify({ version: HIDDEN_DIR_STATE_VERSION, home, dirs }, null, 2) + "\n", { mode: 0o600 });
  try { renameSync(tmp, statePath); } finally { try { unlinkSync(tmp); } catch { /* renamed */ } }
}

/** Forget every remembered folder for one home (the operator's re-confirm).
 *  True when a file was there. */
export function resetHiddenDirIdentity(statePath) {
  try { unlinkSync(statePath); return true; } catch (e) { if (e && e.code === "ENOENT") return false; throw e; }
}

/** Forget every home's record in one Crow home (the CLI's `--reset`), a
 *  half-written temp file included. Returns the files it removed. */
export function resetAllHiddenDirIdentity(crowHome) {
  const dir = join(crowHome, "secrets");
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const gone = [];
  for (const n of names) {
    if (!n.startsWith(HIDDEN_DIR_STATE_PREFIX)) continue;
    try { unlinkSync(join(dir, n)); gone.push(join(dir, n)); } catch { /* next */ }
  }
  return gone;
}

/** The refusal for a record the spawn cannot use: unreadable/corrupt (fail
 *  closed — an entry that cannot be checked is never assumed new), or one it
 *  could not write. */
export function hiddenDirStateRefusal(statePath, why = "unreadable") {
  return "A bot could not start: Crow's record of the secret folders and files it hides is " + why +
    ", so it can't tell whether one moved or was replaced. Run " + HIDDEN_DIR_RESET_COMMAND +
    " (or delete " + statePath + ") and start the bot again.";
}

/**
 * The refusal for an entry that was hidden before and is now gone (`missing`),
 * or is a different entry at the same path (`replaced`). It names the entry (one
 * the operator already knows) and the two ways to re-confirm; no path of a
 * decoy, and never any content. `pathKind` only picks the noun in the replaced
 * sentence (a folder or a file).
 */
export function reConfirmRefusal(rel, kind, statePath, pathKind = "dir") {
  const what = kind === "missing"
    ? "was there the last time a bot ran and is gone now"
    : "is not the " + (pathKind === "file" ? "file" : "folder") + " Crow hid the last time (it was replaced)";
  return "A bot could not start: ~/" + rel + " " + what + ", so Crow won't run a bot until you re-confirm. " +
    "If that was you, run " + HIDDEN_DIR_RESET_COMMAND + " (or delete " + statePath + ") and start the bot again.";
}

/**
 * Resolve ONE operator secret folder or file below `home` (HOME), and (folders
 * only) remember it.
 *
 * `home` itself may be a symlink (a home on another disk): it is resolved ONCE
 * with realpath as the anchor, and every component below that anchor is walked
 * with lstat — a link anywhere on the way (a symlinked `~/.config`, say, not
 * just a symlinked leaf) refuses the spawn, because the mask would otherwise be
 * redirected to a decoy the bot could plant and re-point. A component that is
 * not the kind of entry it must be refuses it too (a file where a folder
 * belongs, a folder or a device where a credential file belongs). A missing
 * component is NOT created: the entry simply is not there. These checks run for
 * a FILE as well as for a folder.
 *
 * The identity memory is for FOLDERS only. The first time a folder really is
 * there its `{dev, ino}` is recorded in `statePath`; on a later spawn a
 * remembered folder that is gone, or that is a different entry, refuses the
 * spawn until the operator re-confirms, and an unusable record refuses it too
 * (fail closed). A FILE is never recorded and never compared: an ordinary tool
 * rewrite renames a new inode over it (see the identity-memory block above), so
 * a missing or replaced credential FILE is simply nothing to mask on that
 * spawn, while an existing one is masked at whatever inode holds that name.
 *
 * @param {string} home        the operator's home (HOME; may be a symlink)
 * @param {string} rel         one of OPERATOR_SECRET_PATHS
 * @param {{kind?:"dir"|"file", statePath?:string, displayPath?:string}} [opts]
 *   `kind` says whether the entry is hidden whole (a folder) or masked with an
 *   empty file (a file). `displayPath` is what a refusal sentence names (the
 *   bridge reads/writes the record through the anchored secrets dir, whose
 *   /proc/self/fd path nobody should have to read).
 * @returns {{rel:string, label:string, kind:"dir"|"file", dir:string|null,
 *            path:string|null, dev?:number, ino?:number, absent:boolean,
 *            remembered:boolean, refusal:string|null, cause:string|null}}
 *   `dir` is the resolved folder (null for a file entry and for every refusal);
 *   `path` is the resolved folder OR file. `cause` is set exactly when `refusal`
 *   is, and says which rule fired — `"link"`, `"missing"`, `"replaced"` or
 *   `"record"` — so a caller can describe it without parsing the sentence (the
 *   operator bell in the bridge does).
 */
export function resolveHiddenSecretPath(home, rel, { kind = "dir", statePath = null, displayPath = null } = {}) {
  const label = "~/" + rel;
  const shown = displayPath || statePath;
  const k = kind === "file" ? "file" : "dir";
  const result = { rel, label, kind: k, dir: null, path: null, absent: false, remembered: false, refusal: null, cause: null };
  const linkRefusal = secretLinkRefusal(rel, k);
  // The record is read FIRST: a corrupt one refuses before anything else is
  // measured, and a state file that cannot be read is never read as "empty".
  const memory = statePath ? readHiddenDirMemory(statePath) : { ok: true, dirs: {} };
  if (!memory.ok) return { ...result, refusal: hiddenDirStateRefusal(shown, memory.reason), cause: "record" };
  // Files are never remembered (the identity-memory block above): their entries
  // are not even looked up, so an old record cannot refuse an ordinary rewrite.
  const remembered = k === "file" ? null : (memory.dirs[rel] || null);
  result.remembered = !!remembered;
  let anchor = null;
  try { anchor = realpathSync(home); } catch { anchor = null; } // no home: nothing can be there
  let found = { absent: true };
  if (anchor) {
    const parts = rel.split("/").filter(Boolean);
    let cur = anchor;
    for (let i = 0; i < parts.length; i++) {
      cur = join(cur, parts[i]);
      let st;
      try { st = lstatSync(cur); } catch (e) {
        found = (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) ? { absent: true } : { refusal: linkRefusal };
        break;
      }
      const last = i === parts.length - 1;
      const wanted = last && k === "file" ? st.isFile() : st.isDirectory();
      if (st.isSymbolicLink() || !wanted) { found = { refusal: linkRefusal }; break; }
      found = { path: cur, st };
    }
  }
  if (found.refusal) return { ...result, refusal: found.refusal, cause: "link" };
  if (found.absent) {
    // Absent: never created here, and nothing is hidden for it. A FOLDER Crow hid
    // before and that is gone now is the tamper signal — refuse, and let the
    // operator re-confirm. A FILE that is gone is just nothing to mask: the
    // operator's tool moved it (or deleted it), and there is no held-open handle
    // to worry about because the mask is remade from whatever is at the path on
    // every spawn.
    result.absent = true;
    if (remembered) { result.refusal = reConfirmRefusal(rel, "missing", shown, k); result.cause = "missing"; }
    return result;
  }
  const { path: resolved, st } = found;
  result.path = resolved;
  if (k === "dir") result.dir = resolved;
  result.dev = st.dev;
  result.ino = st.ino;
  if (remembered && (remembered.dev !== st.dev || remembered.ino !== st.ino)) {
    result.dir = null;
    result.path = null;
    result.refusal = reConfirmRefusal(rel, "replaced", shown, k);
    result.cause = "replaced";
    return result;
  }
  if (k === "dir" && !remembered && statePath) {
    // Only the folder's OWN dev:ino — never its contents, an mtime or a size: a
    // tool that writes files inside it (`gcloud auth login`) changes none of them.
    try { writeHiddenDirMemory(statePath, { ...memory.dirs, [rel]: { dev: st.dev, ino: st.ino } }, anchor); }
    catch { return { ...result, dir: null, path: null, refusal: hiddenDirStateRefusal(shown, "not writable"), cause: "record" }; }
  }
  return result;
}

/** One operator secret FOLDER (hidden whole). Same rules as the file one below. */
export function resolveHiddenSecretDir(home, rel, opts = {}) {
  return resolveHiddenSecretPath(home, rel, { ...opts, kind: "dir" });
}

/** One operator secret FILE (masked with an empty file). No identity memory:
 *  the link checks run, an absent file is nothing to mask (never created), and
 *  whatever file holds the name is masked. */
export function resolveHiddenSecretFile(home, rel, opts = {}) {
  return resolveHiddenSecretPath(home, rel, { ...opts, kind: "file" });
}

function bundleIds(root, readdir) {
  try { return readdir(join(root, "bundles")); } catch { return []; }
}
/** Names of the secret files directly in dir that `match` accepts: regular files, and symlinks too (never masked, so the caller refuses the spawn). */
function maskedNamesIn(dir, readdir, match) {
  let names;
  try { names = readdir(dir); } catch { return []; }
  return names.filter((n) => match(n) && (() => { try { const st = lstatSync(join(dir, n)); return st.isFile() || st.isSymbolicLink(); } catch { return false; } })());
}
function entryKind(p) {
  try { const st = lstatSync(p); return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "other"; } catch { return "none"; }
}
