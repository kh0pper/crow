/**
 * Compose rules a satellite adds on top of the shared check (SAT-3, spec §7.1). Read from the
 * model `docker compose config --format json` produces (what `up` would really apply), after
 * compose-guard's checkComposeModel has passed. No consent unlocks any of these:
 *
 *   refused   host networking (network_mode host / container:, host-level network drivers),
 *             privileged, any Docker socket mount (or use_api_socket), a published port bound
 *             to anything but 127.0.0.1 (Serve and Caddy are the only ways in)
 *   required  mem_limit on every service, oom_score_adj ≥ 300 on every service (the kernel
 *             kills a container before the agent or sshd)
 */
import { parseByteSize, usesHostNetwork } from "../gateway/compose-guard.js";

export const MIN_OOM_SCORE_ADJ = 300;
const SOCKET = /(?:^|\/)docker\.sock$/;

export function checkSatelliteComposeModel(model) {
  const refuse = (reason) => ({ valid: false, reason: `Not allowed on a small server: ${reason}` });
  const services = model && typeof model === "object" ? model.services : null;
  if (!services || typeof services !== "object" || Object.keys(services).length === 0) return refuse("the compose file has no services");
  if (usesHostNetwork(model)) return refuse("the host network (network_mode host, another container's network, or a host-level network driver)");
  for (const [name, s] of Object.entries(services)) {
    const svc = s && typeof s === "object" ? s : {};
    if (svc.privileged === true || svc.privileged === "true") return refuse(`service ${name} is privileged`);
    if (svc.use_api_socket) return refuse(`service ${name} asks for the Docker socket`);
    for (const v of Array.isArray(svc.volumes) ? svc.volumes : []) {
      const src = typeof v === "string" ? v.split(":")[0] : String(v?.source || "");
      if (SOCKET.test(src.replace(/\/+$/, ""))) return refuse(`service ${name} mounts the Docker socket`);
    }
    for (const p of Array.isArray(svc.ports) ? svc.ports : []) {
      if (!p || typeof p !== "object" || p.host_ip !== "127.0.0.1") {
        return refuse(`service ${name} publishes a port on ${p?.host_ip || "every address"}; only 127.0.0.1 is allowed`);
      }
    }
    const limit = parseByteSize(svc.mem_limit);
    if (!limit) return refuse(`service ${name} has no mem_limit`);
    if (typeof svc.oom_score_adj !== "number" || svc.oom_score_adj < MIN_OOM_SCORE_ADJ) {
      return refuse(`service ${name} needs oom_score_adj of at least ${MIN_OOM_SCORE_ADJ}`);
    }
  }
  return { valid: true };
}
