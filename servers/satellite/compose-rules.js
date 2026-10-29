/**
 * Compose rules on a satellite (SAT-3, spec §7.1). A satellite is a public VPS: it never runs a
 * privileged-equivalent container, whatever the owner consents to.
 *
 * checkSatelliteCompose(model, {bundleDir, manifest, ctx}) is the ONE check every `up` on a
 * satellite runs (install, start, restart). It is two layers over the model
 * `docker compose config --format json` produces (what `up` really applies):
 *
 *   1. compose-guard's checkComposeModel in its strictest mode: consent NOT verified, and the
 *      manifest's privileged / consent_required / host_grants stripped, so nothing a full Crow
 *      unlocks with consent or a grant is unlocked here. Consent still gates the install
 *      (bundles.js), but it never widens this check.
 *   2. checkSatelliteComposeModel, refusing outright (no consent, no grant):
 *      - a Docker / podman / containerd socket: every bind source (short or long form, as
 *        written and after resolveHostPath: relative to the bundle dir, symlinks, `..`) and
 *        every top-level volume's driver_opts.device, against compose-guard's dockerSockets
 *        set plus the podman / containerd paths below, and any `*docker.sock`, `*podman.sock`,
 *        `*containerd.sock` name; `use_api_socket`;
 *      - host networking (network_mode host / container:, host-level network drivers);
 *      - privileged; cap_add outside SAT_SAFE_CAPS; pid/ipc/uts/userns_mode/cgroup host (or
 *        another container's namespace); security_opt other than no-new-privileges(:true);
 *      - devices, device reservations, volumes_from, every key compose-guard's SERVICE_PRIV lists;
 *      - a published port on anything but 127.0.0.1;
 *      and requiring mem_limit and oom_score_adj ≥ 300 on every service.
 *
 * SAT_SAFE_CAPS is smaller than compose-guard's safe set: CHOWN, DAC_OVERRIDE, FOWNER, SETUID,
 * SETGID are what an image's entrypoint needs to fix data-folder ownership and drop to its
 * service user (Gitea's s6 / su-exec); NET_BIND_SERVICE lets a service bind a port < 1024
 * inside its own network namespace (Gitea's ssh on 22). Nothing in it reaches the host.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { checkComposeModel, parseByteSize, resolveHostPath, SERVICE_PRIV, sensitiveRoots, usesHostNetwork } from "../gateway/compose-guard.js";

export const MIN_OOM_SCORE_ADJ = 300;
export const SAT_SAFE_CAPS = Object.freeze(new Set(["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID", "NET_BIND_SERVICE"]));
// compose-guard's dockerSockets covers Docker's two paths; a satellite refuses the other runtimes too.
export const EXTRA_RUNTIME_SOCKETS = Object.freeze([
  "/run/podman/podman.sock", "/var/run/podman/podman.sock",
  "/run/containerd/containerd.sock", "/var/run/containerd/containerd.sock",
  "/run/docker/containerd/containerd.sock", "/var/run/docker/containerd/containerd.sock",
]);
const SOCKET_NAME = /(?:^|\/)(?:docker|podman|containerd)\.sock$/;
const NS_KEYS = ["pid", "ipc", "uts", "userns_mode", "cgroup"];

function socketSet(ctx) {
  const set = new Set(sensitiveRoots(ctx).dockerSockets);
  for (const p of EXTRA_RUNTIME_SOCKETS) { set.add(p); set.add(resolveHostPath(p)); }
  return set;
}

/**
 * Where a path really leads, to a fixed point. Node's JS realpathSync stops one hop short on a
 * symlink chain that ends at a socket (link → link → docker.sock yields the middle link), so
 * the native realpath is tried first and resolveHostPath (which also follows dangling links)
 * is the fallback for a path that is not there.
 */
export function deepResolve(p) {
  let cur = resolvePath(p);
  for (let i = 0; i < 40; i++) {
    let next;
    try { next = realpathSync.native(cur); } catch { next = resolveHostPath(cur); }
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** The written path and where it really leads (relative → the bundle dir). */
function pathForms(p, bundleDir) {
  const written = String(p);
  const abs = isAbsolute(written) ? resolvePath(written) : resolvePath(bundleDir || ".", written);
  return [written, abs, resolveHostPath(abs), deepResolve(abs)];
}

export function checkSatelliteComposeModel(model, { bundleDir = ".", ctx = {} } = {}) {
  const refuse = (reason) => ({ valid: false, reason: `Not allowed on a small server: ${reason}` });
  const services = model && typeof model === "object" ? model.services : null;
  if (!services || typeof services !== "object" || Object.keys(services).length === 0) return refuse("the compose file has no services");
  const sockets = socketSet({ crowHome: ctx.crowHome || bundleDir, ...ctx });
  const isSocket = (p) => pathForms(p, bundleDir).some((f) => sockets.has(f) || SOCKET_NAME.test(f.replace(/\/+$/, "")));
  if (usesHostNetwork(model)) return refuse("the host network (network_mode host, another container's network, or a host-level network driver)");
  for (const [name, vol] of Object.entries(model.volumes || {})) {
    const dev = vol?.driver_opts?.device;
    if (dev !== undefined && dev !== null && isSocket(dev)) return refuse(`volume ${name} binds a container runtime socket`);
  }
  for (const [name, s] of Object.entries(services)) {
    const svc = s && typeof s === "object" ? s : {};
    if (svc.privileged !== undefined && svc.privileged !== false && svc.privileged !== "false") return refuse(`service ${name} is privileged`);
    if (svc.use_api_socket) return refuse(`service ${name} asks for the Docker socket`);
    for (const v of Array.isArray(svc.volumes) ? svc.volumes : []) {
      // Short form "src:dst[:mode]" (masking ${…} so its ":-" is not read as the separator).
      const src = typeof v === "string" ? v.replace(/\$\{[^}]*\}/g, (m) => m.replace(/:/g, "\u0000")).split(":")[0].replace(/\u0000/g, ":") : v?.source;
      if (src === undefined || src === null || src === "") continue;
      if (typeof v === "object" && v.type === "volume" && !String(src).includes("/")) continue; // a named volume (its device is checked above)
      // The model is interpolated; a `${…}` left in a source is judged by its default too, and
      // one with no usable default cannot be judged at all.
      const withDefaults = String(src).replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}]*)\}/g, "$1");
      if (isSocket(src) || isSocket(withDefaults)) return refuse(`service ${name} mounts a container runtime socket`);
      if (withDefaults.includes("$")) return refuse(`service ${name} mounts a host path that is not interpolated (${String(src).slice(0, 60)})`);
    }
    for (const c of Array.isArray(svc.cap_add) ? svc.cap_add : svc.cap_add !== undefined ? [svc.cap_add] : []) {
      const cap = String(c).toUpperCase().replace(/^CAP_/, "");
      if (!SAT_SAFE_CAPS.has(cap)) return refuse(`service ${name} adds the capability ${cap.slice(0, 40)}`);
    }
    for (const k of NS_KEYS) {
      if (svc[k] === undefined || svc[k] === null) continue;
      const v = String(svc[k]);
      const ok = (k === "ipc" && (v === "private" || v === "shareable")) || (k === "cgroup" && v === "private");
      if (!ok) return refuse(`service ${name} sets ${k}: ${v.slice(0, 40)}`);
    }
    for (const o of Array.isArray(svc.security_opt) ? svc.security_opt : svc.security_opt !== undefined ? [svc.security_opt] : []) {
      if (!/^no-new-privileges(?:[:=]true)?$/.test(String(o))) return refuse(`service ${name} sets security_opt ${String(o).slice(0, 60)}`);
    }
    if (Array.isArray(svc.devices) ? svc.devices.length : svc.devices !== undefined) return refuse(`service ${name} maps host devices`);
    if ((svc.deploy?.resources?.reservations?.devices || []).length) return refuse(`service ${name} reserves host devices`);
    if (svc.gpus !== undefined) return refuse(`service ${name} asks for GPUs`);
    if (svc.volumes_from !== undefined) return refuse(`service ${name} uses volumes_from`);
    for (const k of Object.keys(svc)) if (SERVICE_PRIV.has(k)) return refuse(`service ${name} sets ${k}`);
    for (const p of Array.isArray(svc.ports) ? svc.ports : []) {
      if (!p || typeof p !== "object" || p.host_ip !== "127.0.0.1") {
        return refuse(`service ${name} publishes a port on ${p?.host_ip || "every address"}; only 127.0.0.1 is allowed`);
      }
    }
    if (!parseByteSize(svc.mem_limit)) {
      const viaDeploy = svc.deploy?.resources?.limits?.memory !== undefined;
      return refuse(`service ${name} has no mem_limit; mem_limit is required${viaDeploy ? " (deploy.resources.limits.memory alone is not enough)" : ""}`);
    }
    if (typeof svc.oom_score_adj !== "number" || svc.oom_score_adj < MIN_OOM_SCORE_ADJ) {
      return refuse(`service ${name} needs oom_score_adj of at least ${MIN_OOM_SCORE_ADJ}`);
    }
  }
  return { valid: true };
}

/** The satellite's one compose check: compose-guard strict, then the satellite rules. */
export function checkSatelliteCompose(model, { bundleDir, manifest, ctx }) {
  if (manifest?.privileged === true) return { valid: false, reason: "Not allowed on a small server: the extension declares privileged access" };
  const strict = { ...(manifest || {}), privileged: false, consent_required: false };
  delete strict.host_grants;
  const shared = checkComposeModel(model, { bundleDir, manifest: strict, consentVerified: false, ctx });
  if (!shared.valid) return shared;
  return checkSatelliteComposeModel(model, { bundleDir, ctx });
}
