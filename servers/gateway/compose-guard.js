/**
 * The install security check, on the compose model Docker Compose itself applies.
 *
 * The text check (validateComposeFile in routes/bundles.js) reads docker-compose.yml as
 * written, which leaves a gap between what it reads and what Compose runs: YAML anchors
 * and merge keys, flow/JSON style, interpolated `${VAR}` host paths, override files,
 * COMPOSE_FILE in .env, symlinks inside the bundle, top-level volumes with a bind
 * `device`. This module closes the gap by asking Compose for the model it will apply
 * (`docker compose config --format json`, run in the bundle dir with the same env as
 * `up`) and checking THAT, then resolving every host path through symlinks.
 *
 * Fail-closed: if Compose cannot produce a model, the bundle is refused. A model it
 * cannot reason about (unknown volume shape) is refused too.
 *
 * Every gateway path that runs `compose up` calls checkBundleCompose first: install
 * (single and collection: both go through runInstallJob), Start/recreate, and the
 * shared-storage re-apply.
 */
import { existsSync, readFileSync, realpathSync, lstatSync, readlinkSync } from "node:fs";
import { join, resolve as resolvePath, dirname, basename, sep, isAbsolute } from "node:path";
import { homedir } from "node:os";

const DANGEROUS_CAPS = new Set(["ALL", "NET_ADMIN", "SYS_ADMIN", "SYS_PTRACE", "SYS_RAWIO", "NET_RAW", "SYS_MODULE", "DAC_READ_SEARCH", "SYS_BOOT", "SYS_TIME", "MAC_ADMIN", "MAC_OVERRIDE", "BPF", "PERFMON"]);
// A value Compose sees for a `${VAR:?}` the install left blank (a collection member,
// finished later with Configure): relative, so it resolves inside the bundle dir.
export const UNSET_SENTINEL = "./crow-unset-value";

/** realpath of p, or of its nearest existing ancestor + the rest (a path Docker would create). */
export function resolveHostPath(p, depth = 0) {
  let cur = resolvePath(p);
  const rest = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch {
      // A dangling symlink still decides where Docker creates the path: follow it.
      try {
        if (depth < 40 && lstatSync(cur).isSymbolicLink()) {
          const target = resolvePath(dirname(cur), readlinkSync(cur));
          return resolveHostPath(rest.length ? join(target, ...rest.reverse()) : target, depth + 1);
        }
      } catch { /* not there at all */ }
      const parent = dirname(cur);
      if (parent === cur) return resolvePath(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

const under = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * @param {object} ctx
 * @param {string} ctx.crowHome
 * @param {string} [ctx.dataDir]   the instance's data dir (crow.db lives here)
 * @param {string} [ctx.appRoot]   the gateway checkout (its .env holds gateway secrets)
 * @param {string} [ctx.home]
 */
export function sensitiveRoots(ctx) {
  const home = ctx.home || homedir();
  const real = (p) => resolveHostPath(p);
  const dataDirs = [...new Set([ctx.dataDir, join(ctx.crowHome, "data"), join(home, ".crow", "data")].filter(Boolean).map(real))];
  return {
    exact: new Set([real("/"), real(ctx.crowHome), real(home), ...(ctx.appRoot ? [real(ctx.appRoot)] : [])]),
    trees: [
      { root: real("/etc"), why: "/etc" },
      { root: real("/root"), why: "/root" },
      { root: real("/boot"), why: "/boot" },
      { root: real("/var/lib/docker"), why: "Docker's own data" },
      { root: real("/run"), why: "/run (system sockets)" },
      { root: real("/var/run"), why: "/var/run (system sockets)" },
      { root: real("/dev"), why: "/dev (host devices)" },
      { root: real("/proc"), why: "/proc", hostInfo: true },
      { root: real("/sys"), why: "/sys", hostInfo: true },
      { root: real(join(home, ".ssh")), why: "~/.ssh" },
      { root: real(join(ctx.crowHome, "secrets")), why: "Crow's secrets folder" },
      ...dataDirs.map((d) => ({ root: d, why: "Crow's data folder", dataDir: true })),
      ...(ctx.appRoot ? [{ root: real(join(ctx.appRoot, ".env")), why: "the gateway .env" }] : []),
      { root: real(join(ctx.crowHome, ".env")), why: "Crow's .env" },
      { root: real(join(ctx.crowHome, "mcp-addons.json")), why: "the extension registry (holds extension settings)" },
      { root: real(join(ctx.crowHome, "bundles")), why: "the extensions folder (holds other extensions' settings)", bundlesDir: true },
    ],
    dockerSockets: new Set([real("/var/run/docker.sock"), real("/run/docker.sock")]),
    localtime: real("/etc/localtime"),
  };
}

/**
 * Check a Compose model (the parsed `docker compose config --format json` output).
 * @returns {{valid: true} | {valid: false, reason: string}}
 */
export function checkComposeModel(model, { bundleDir, manifest, consentVerified = false, ctx }) {
  const isPrivilegedAllowed = !!(manifest?.privileged && consentVerified && manifest?.origin !== "community");
  const isConsentBundle = !!(manifest?.consent_required && consentVerified && manifest?.origin !== "community");
  const roots = sensitiveRoots(ctx);
  const bundleReal = resolveHostPath(bundleDir);
  const ownId = /^[a-z0-9][a-z0-9-]*$/.test(String(manifest?.id || "")) ? manifest.id : null;
  const refuse = (reason) => ({ valid: false, reason });
  const needPriv = (what) => (isPrivilegedAllowed ? null : refuse(`Compose file uses ${what} but manifest does not declare 'privileged: true' (or consent was not verified)`));
  if (!model || typeof model !== "object" || !model.services || typeof model.services !== "object") return refuse("Docker Compose produced no services model");

  /** A host path the container gets, read-only or not. */
  const checkOne = (p, { readOnly, what }) => {
    if (roots.dockerSockets.has(p)) {
      if (!readOnly) return refuse("Read-write Docker socket mounts are not permitted");
      if (!isConsentBundle && !isPrivilegedAllowed) return refuse("Docker socket mount requires manifest 'consent_required: true' and verified consent");
      return null;
    }
    if (roots.exact.has(p)) return refuse(`${what}: mounts a sensitive host path (${p === "/" ? "/" : "a top-level folder"})`);
    if ((p === "/etc/localtime" || p === roots.localtime) && readOnly) return null;
    for (const t of roots.trees) {
      if (!(under(p, t.root) || under(t.root, p))) continue;
      // /proc and /sys read-only: host metrics (netdata), only for a bundle the user consented to.
      if (t.hostInfo && readOnly && under(p, t.root) && (isConsentBundle || isPrivilegedAllowed)) continue;
      // The one data-folder file a privileged bundle may READ with consent: crow.db (the
      // companion reads its bot settings from it). Its consent text says so.
      if (t.dataDir && readOnly && isPrivilegedAllowed && basename(p) === "crow.db" && dirname(p) === t.root) continue;
      // The bundle's OWN subfolder of the data folder (<data>/<bundle id>), never a parent.
      if (t.dataDir && ownId && under(p, join(t.root, ownId))) continue;
      // The extensions folder, read-only, with privileged consent (companion's text says so).
      if (t.bundlesDir && readOnly && isPrivilegedAllowed && p === t.root) continue;
      // A bundle's own folder sits under the extensions folder: its own files are fine.
      if (t.bundlesDir && under(p, bundleReal)) continue;
      return refuse(`${what}: mounts a sensitive host path (${t.why})`);
    }
    return null;
  };
  /** Both the path as written and where it really leads (symlinks): /etc/localtime is a
   * link out of /etc, yet a read-write mount of it still writes a host system file. */
  const checkHostPath = (src, { readOnly, what }) => {
    if (typeof src !== "string" || src === "") return refuse(`${what}: a host path Compose could not resolve`);
    if (!isAbsolute(src)) return refuse(`${what}: a host path that is not absolute after Compose resolved it (${src.slice(0, 80)})`);
    const lex = resolvePath(src);
    const real = resolveHostPath(src);
    return checkOne(lex, { readOnly, what }) || (real !== lex ? checkOne(real, { readOnly, what }) : null);
  };
  const insideBundle = (src, what, { allowOutside = false } = {}) => {
    if (typeof src !== "string" || src === "") return refuse(`${what}: a path Compose could not resolve`);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src) || /^git@/.test(src)) return null; // a remote build context reads nothing local
    const p = resolveHostPath(src);
    if (under(p, bundleReal) || allowOutside) return null;
    return refuse(`${what}: reads a host path outside the bundle`);
  };

  for (const [name, s] of Object.entries(model.services)) {
    if (!s || typeof s !== "object") return refuse(`service ${name}: not a mapping`);
    const tag = `service ${name}`;
    let r;
    if (s.privileged === true && (r = needPriv("privileged mode"))) return r;
    for (const c of s.cap_add || []) {
      const cap = String(c).toUpperCase().replace(/^CAP_/, "");
      if (DANGEROUS_CAPS.has(cap) && (r = needPriv(`a dangerous capability (${cap})`))) return r;
    }
    const nm = String(s.network_mode || "");
    if ((nm === "host" || nm.startsWith("container:")) && (r = needPriv(nm === "host" ? "host networking" : "another container's network"))) return r;
    for (const k of ["pid", "ipc", "userns_mode", "uts", "cgroup"]) {
      const v = String(s[k] || "");
      if ((v === "host" || v.startsWith("container:")) && (r = needPriv(`${k}: ${v}`))) return r;
    }
    for (const o of s.security_opt || []) {
      if (/unconfined|label[=:]disable|systempaths=unconfined/i.test(String(o)) && (r = needPriv(`security_opt ${o}`))) return r;
    }
    if (Array.isArray(s.volumes_from) && s.volumes_from.length && (r = needPriv("volumes_from"))) return r;
    // Host devices (raw disks, the TUN device…) need privileged consent; the GPU render
    // nodes are the exception every GPU app needs.
    for (const d of s.devices || []) {
      const src = typeof d === "string" ? d.split(":")[0] : d?.source;
      const gpu = /^\/dev\/(dri(\/.*)?|kfd|nvidia[a-z0-9-]*)$/.test(String(src || ""));
      if (!gpu && (r = needPriv(`a host device (${String(src || "?").slice(0, 60)})`))) return r;
    }
    for (const v of s.volumes || []) {
      if (!v || typeof v !== "object") return refuse(`${tag}: a volume Compose did not normalize`);
      if (v.type === "bind") {
        if ((r = checkHostPath(v.source, { readOnly: v.read_only === true, what: tag }))) return r;
      } else if (!["volume", "tmpfs", "npipe", "image"].includes(v.type)) {
        return refuse(`${tag}: an unknown volume type (${v.type})`);
      }
    }
    for (const e of s.env_file || []) {
      const path = typeof e === "string" ? e : e?.path;
      if ((r = insideBundle(path, `${tag} env_file`, { allowOutside: manifest?.inference === true }))) return r;
    }
    if (s.build) {
      const b = typeof s.build === "string" ? { context: s.build } : s.build;
      if ((r = insideBundle(b.context, `${tag} build context`))) return r;
      for (const c of Object.values(b.additional_contexts || {})) {
        if (/^(docker-image|service|oci-layout):/.test(String(c))) continue;
        if ((r = insideBundle(c, `${tag} build additional_contexts`))) return r;
      }
    }
  }
  for (const [kind, items] of [["secrets", model.secrets], ["configs", model.configs]]) {
    for (const [name, it] of Object.entries(items || {})) {
      if (it && typeof it.file === "string") {
        const r = insideBundle(it.file, `${kind} ${name}`);
        if (r) return r;
      }
    }
  }
  for (const [name, vol] of Object.entries(model.volumes || {})) {
    const dev = vol?.driver_opts?.device;
    const o = String(vol?.driver_opts?.o || "");
    const isBind = /(?:^|,)r?bind(?:,|$)/.test(o) || vol?.driver_opts?.type === "none";
    if (typeof dev === "string" && isBind && !dev.startsWith("/")) return refuse(`volume ${name}: a bind device that is not an absolute path`);
    if (typeof dev === "string" && dev.startsWith("/")) {
      const ro = /(?:^|,)ro(?:,|$)/.test(String(vol.driver_opts.o || ""));
      const r = checkHostPath(dev, { readOnly: ro, what: `volume ${name}` });
      if (r) return r;
    }
  }
  return { valid: true };
}

/** `${VAR:?…}` / `${VAR?…}` names in a compose text (the ones Compose refuses to leave blank). */
export function requiredComposeVars(text) {
  const out = new Set();
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*):?\?/g;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) out.add(m[1]);
  return [...out];
}

function parseDotEnv(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch { /* none */ }
  return out;
}

/**
 * The model `docker compose up` would apply in bundleDir. `runConfig(args, {cwd, env})`
 * runs `docker compose <args>` and resolves {stdout}. A `${VAR:?}` left blank (collection
 * installs leave required keys for "Finish setup") gets UNSET_SENTINEL so the rest of the
 * model can still be checked; Start re-runs this check once the real value is set.
 * @returns {Promise<{model: object} | {error: string}>}
 */
export async function loadComposeModel(bundleDir, { env, runConfig }) {
  const args = ["config", "--format", "json", "--no-env-resolution"];
  const attempt = async (e) => {
    const { stdout } = await runConfig(args, { cwd: bundleDir, env: e });
    return JSON.parse(String(stdout));
  };
  try {
    return { model: await attempt(env) };
  } catch (first) {
    let text = "";
    for (const f of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
      try { if (existsSync(join(bundleDir, f))) text += readFileSync(join(bundleDir, f), "utf8") + "\n"; } catch { /* skip */ }
    }
    const dot = parseDotEnv(join(bundleDir, ".env"));
    const filled = { ...env };
    let changed = false;
    for (const k of requiredComposeVars(text)) {
      if (!filled[k] && !dot[k]) { filled[k] = UNSET_SENTINEL; changed = true; }
    }
    if (changed) {
      try { return { model: await attempt(filled) }; } catch { /* fall through */ }
    }
    const msg = String(first?.stderr || first?.message || "unknown error").split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" ");
    return { error: `Docker Compose could not read the bundle's compose file (${msg.slice(0, 300)})` };
  }
}
