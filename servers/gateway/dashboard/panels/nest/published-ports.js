/**
 * Published ports — the snapshot reader and the pure classifier behind the
 * `publishedPorts` health signal (implementation plan PR S5a).
 *
 * The snapshot is written by the fence's root-run snapshot job (PR S5b) to
 * `CROW_PUBLISH_SNAPSHOT` (default /var/lib/crow-fence/snapshot.json). This
 * module reads that ONE file and classifies what it says; it never runs docker,
 * iptables or anything else (no shell calls, so the gateway's signal path stays
 * cheap and cannot hang on a wedged daemon).
 *
 * `publishedPorts` is an AUDIT: it reports what is reachable beyond loopback,
 * so a tailnet-address publish that carries the interface-pinned raw fence rule
 * is *info* (fenced, listed) and anything without a fence is *warn*.
 *
 * Snapshot states (see loadPublishSnapshot):
 *   ok        — usable
 *   stale     — taken_at older than PUBLISH_SNAPSHOT_STALE_MS: the rows are
 *               still listed but no rule in it is trusted, so a tailnet-address
 *               publish is "fence unknown" (warn)
 *   future    — taken_at after now + skew: same treatment as stale (a clock move
 *               makes the age meaningless)
 *   missing / unreadable / malformed — nothing to classify; the signal says
 *               "unknown" (info, never ok-looking, and never a warn by itself)
 *
 * The direct-docker fallback is deliberately OUT of this PR: with no snapshot
 * the answer is "unknown", and the detail says which of the M4 blind spots could
 * not be inspected.
 *
 * ## Snapshot shape read here (tolerant; a missing optional field is not fatal)
 *
 *   {
 *     "taken_at": "2026-11-04T12:00:00Z",
 *     "docker": { "version": "28.0.1", "firewall_backend": "nftables",
 *                 "userland_proxy": true },
 *     "fence": { "unit_active": true,
 *                "conf_sha256": "…", "conf_saved_sha256": "…",
 *                "docker_flags_sha256": "…", "docker_flags_saved_sha256": "…" },
 *     "tailscale": { "v4": "100.64.20.5", "v6": "fd7a:115c:a1e0::20" },
 *     "containers": [ {
 *       "id": "0123456789ab", "name": "crow-example",
 *       "labels": { "crow.runtime": "docker",
 *                   "crow.bundle": "example",
 *                   "com.docker.compose.project": "example",
 *                   "com.docker.compose.project.working_dir":
 *                     "/home/crow/.crow/bundles/example" },
 *       "host_config": { "network_mode": "default",
 *                        "port_bindings": { "8005/tcp": [ { "HostIp": "0.0.0.0",
 *                                                          "HostPort": "8005" } ] } },
 *       "networks": ["bridge"]
 *     } ],
 *     "listeners": [ { "address": "0.0.0.0", "port": 8005 } ],
 *     "raw_rules": { "v4": ["-A CROW-ENGINE-FENCE -d 100.64.20.5/32 -p tcp …"],
 *                    "v6": [] }
 *   }
 *
 * `listeners` (the `ss -ltn` rows) are carried but not classified: they have no
 * owner and no process names, so they are a hint for the operator, not a fact
 * about a container.
 *
 * The bundle MANIFEST field read here is `publishedPortsAllowlist` (an array of
 * ports or "<port>/<proto>"), and only from a first-party, version-pinned
 * bundle — see readManifestAllowlist.
 *
 * ## Fields the snapshot writer (PR S5b) MUST include
 *
 * Beyond `taken_at`, `docker`, `fence`, `tailscale`, `containers`, `listeners`
 * and `raw_rules`, each container carries the two labels the allowlist check
 * needs — and both are required, so a writer that omits the second one leaves
 * every bundle outside its own manifest allowlist (fail closed, never widened):
 *
 *   labels["crow.bundle"]                            the bundle the container
 *                                                    claims to belong to
 *   labels["com.docker.compose.project.working_dir"] the compose project's
 *                                                    working directory, which
 *                                                    must resolve under
 *                                                    <CROW_HOME>/bundles/<id>
 *
 * `containers` itself is required: a snapshot whose `containers` is not an
 * array is `malformed` (the audit says "unknown"), because an unreadable shape
 * must never read as "nothing is published beyond loopback".
 */

import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCrowHome } from "../../../../shared/crow-home.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Env key that overrides the snapshot path (the installer may move it). */
export const PUBLISH_SNAPSHOT_ENV = "CROW_PUBLISH_SNAPSHOT";
export const DEFAULT_PUBLISH_SNAPSHOT_PATH = "/var/lib/crow-fence/snapshot.json";

/** A snapshot older than this is stale: its rules are not trusted. */
export const PUBLISH_SNAPSHOT_STALE_MS = 15 * 60 * 1000;

/** Tolerated clock skew before a taken_at counts as future-dated. */
const FUTURE_SKEW_MS = 2 * 60 * 1000;

/**
 * The minimum Docker server version for a published engine. The SAME constant
 * ships with the engine-bind rules (PR S3) — S3 imports it from here so the
 * audit and the refusal can never disagree.
 */
export const DOCKER_FLOOR = 28;

/** The operator's local (never synced) allowlist of published ports. */
export const PUBLISHED_PORTS_ALLOWLIST_KEY = "published_ports_allowlist";

/**
 * A first-party bundle manifest may name its own public ports here — but only
 * when the bundle is shipped in this repo AND its installed manifest is the
 * repo's version (see readManifestAllowlist). Example: the caddy bundle's
 * 80/443.
 */
export const MANIFEST_ALLOWLIST_KEY = "publishedPortsAllowlist";

/**
 * The compose label naming the project's working directory on disk. Together
 * with `crow.bundle` it is what ties a container to an installed bundle — and
 * it is the half a container cannot fake by labelling itself (the value has to
 * resolve under `<CROW_HOME>/bundles/<id>`).
 */
export const COMPOSE_WORKDIR_LABEL = "com.docker.compose.project.working_dir";

/**
 * The M4 shapes this audit cannot see, or can only see when the snapshot
 * carries the field. Every report lists which of these were inspected.
 */
export const BLIND_SPOTS = Object.freeze({
  "host-network": "a container with network_mode: host publishes nothing and listens on every address",
  "userland-proxy-false": "with userland-proxy=false the docker-proxy listener is gone; the published port is reachable through NAT only",
  "rootless-or-podman": "rootless Docker and podman use a different socket and never appear in this snapshot",
  "other-netns": "listeners inside another network namespace are invisible to this host's socket table",
});

const DEFAULT_FILE_READER = (path) => readFileSync(path, "utf8");

const repoBundlesDir = () => fileURLToPath(new URL("../../../../../bundles/", import.meta.url));
const installedBundlesDir = () => join(resolveCrowHome(), "bundles");

// ─── Address helpers ─────────────────────────────────────────────────────────

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** ::ffff:127.0.0.1 and ::ffff:7f00:1 → 127.0.0.1; other values unchanged. */
export function unmapIPv4(host) {
  const h = String(host ?? "").trim().replace(/^\[|\]$/g, "").toLowerCase();
  const dotted = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return h;
  const a = parseInt(hex[1], 16);
  const b = parseInt(hex[2], 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

export function isIPv4(addr) {
  return IPV4_RE.test(String(addr ?? ""));
}

/** A loose v6 test: hex digits, colons, at least two colons. */
export function isIPv6(addr) {
  const a = String(addr ?? "");
  return a.includes(":") && /^[0-9a-f:]+$/.test(a) && a.split(":").length >= 3;
}

export function isLoopbackAddress(addr) {
  const a = unmapIPv4(addr);
  // `127.0.0.0/8` only, and only for a real dotted quad: a bare "127." or a
  // lookalike such as "1270.0.0.1" is not loopback.
  return a === "::1" || (isIPv4(a) && a.startsWith("127."));
}

/** This host's tailnet address space: CGNAT v4 and the ULA prefix Tailscale uses. */
export function isTailnetAddress(addr) {
  const a = unmapIPv4(addr);
  if (isIPv4(a)) {
    const [octet0, octet1] = a.split(".").map((n) => Number(n));
    return octet0 === 100 && octet1 >= 64 && octet1 <= 127;
  }
  return a.startsWith("fd7a:115c:a1e0:");
}

/** 172.16.0.0/12 — a Docker bridge (the default bridge is 172.17.0.0/16). */
export function isBridgeAddress(addr) {
  const a = unmapIPv4(addr);
  return /^172\.(1[6-9]|2\d|3[01])\./.test(a);
}

export function sameAddress(a, b) {
  const x = unmapIPv4(a);
  const y = unmapIPv4(b);
  return !!x && x === y;
}

// ─── Raw rule parser ─────────────────────────────────────────────────────────

function tokenize(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(line ?? ""))) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Parse one `iptables -S` / `ip6tables -S` line into a rule, or null when the
 * line is not a DROP rule with a destination port.
 *
 * ONE function holds the exact spelling: `-S` prints `-A <chain> -d <addr>/32
 * -p tcp -m tcp --dport <port> ! -i <iface> -m comment --comment
 * "crow-engine-fence:<id>:g<n>" -j DROP` for the addressed form and the same
 * without `-d` (plus `-m addrtype --dst-type LOCAL`) for the port-only form.
 * That text is a hand-written fixture until a real capture from the acceptance
 * probe replaces it; anything this parser does not recognise is simply not a
 * fence rule, so an unrecognised spelling can only ever make a publish look
 * LESS fenced (never more).
 *
 * @param {string} line
 * @returns {null|{raw:string, port:number, proto:string|null, addr:string|null,
 *   iface:string|null, portOnly:boolean, dstTypeLocal:boolean, tag:string|null,
 *   id:string|null, generation:string|null}}
 */
const FENCE_CHAIN = "CROW-ENGINE-FENCE";
const FENCE_MATCH_MODULES = new Set(["tcp", "udp", "addrtype", "comment"]);

export function parseFenceRule(line) {
  const raw = String(line ?? "").trim();
  if (!raw || !/\bdrop\b/i.test(raw)) return null;
  const tokens = tokenize(raw);

  let chain = null;
  let jump = null;
  let dest = null;
  let proto = null;
  let portToken = null;
  let destType = null;
  let comment = null;
  let iface = null; // only ever set from a `! -i <iface>` pair
  let negatedIface = false;

  const valueAt = (i) => {
    const v = tokens[i + 1];
    return v === undefined || v === "!" || v.startsWith("-") ? null : v;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token) {
      case "-A":
      case "--append": {
        const v = valueAt(i);
        if (v == null || chain != null) return null;
        chain = v;
        i++;
        break;
      }
      case "-j":
      case "--jump": {
        const v = valueAt(i);
        if (v == null || jump != null) return null;
        jump = v;
        i++;
        break;
      }
      case "-d":
      case "--destination": {
        const v = valueAt(i);
        if (v == null || dest != null) return null;
        dest = v;
        i++;
        break;
      }
      case "-p":
      case "--protocol": {
        const v = valueAt(i);
        if (v == null || proto != null) return null;
        proto = v;
        i++;
        break;
      }
      case "-m":
      case "--match": {
        const v = valueAt(i);
        if (v == null || !FENCE_MATCH_MODULES.has(v.toLowerCase())) return null;
        i++;
        break;
      }
      case "--dport":
      case "--destination-port": {
        const v = valueAt(i);
        if (v == null || portToken != null) return null;
        portToken = v;
        i++;
        break;
      }
      case "--dst-type": {
        const v = valueAt(i);
        if (v == null || destType != null) return null;
        destType = v;
        i++;
        break;
      }
      case "--comment": {
        const v = valueAt(i);
        if (v == null || comment != null) return null;
        comment = v;
        i++;
        break;
      }
      case "!": {
        // Only the interface pin may be negated, and the `!` must sit
        // immediately before it. `! -d`, `! -p`, `! --sport`, ... are not
        // spellings this fence writes, so they reject the whole line.
        if (negatedIface) return null;
        const next = tokens[i + 1];
        if (next !== "-i" && next !== "--in-interface") return null;
        const v = tokens[i + 2];
        if (v === undefined || v === "!" || v.startsWith("-")) return null;
        iface = v;
        negatedIface = true;
        i += 2;
        break;
      }
      case "-i":
      case "--in-interface":
        // A plain (non-negated) `-i <iface>` is NOT a spelling the fence writes:
        // without the negation it would drop tailnet traffic too. Return null on
        // ANY such token — including a line that also carries `! -i <iface>` —
        // so two interface matches can never be folded into one pinned rule.
        return null;
      case "-s":
      case "--source":
      case "-o":
      case "--out-interface":
      case "--sport":
      case "--source-port":
        // A fence rule has no source side or output interface.
        return null;
      default:
        // Fail closed on any token this parser does not know (`-m conntrack`,
        // `-m set`, an unknown option, a stray word).
        return null;
    }
  }

  if (!jump || jump.toUpperCase() !== "DROP") return null;
  if (!portToken) return null;
  const port = Number(String(portToken).split(":")[0]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  const tag = /crow-engine-fence:([^:\s"]+)(?::(g\d+))?(?::(portonly))?/.exec(comment || "");
  // The fence tags every rule it writes. Without the tag this is somebody
  // else's DROP, and counting it as a fence would be a false "ok" — so an
  // untagged line is not a fence rule at all.
  if (!tag) return null;

  return {
    raw,
    chain,
    port,
    proto: proto ? String(proto).toLowerCase() : null,
    addr: dest ? String(dest).replace(/\/\d+$/, "") : null,
    iface,
    portOnly: !dest,
    dstTypeLocal: !!destType && String(destType).toUpperCase() === "LOCAL",
    tag: comment || null,
    id: tag[1],
    generation: tag[2] || null,
  };
}

/**
 * Parse the snapshot's raw-rule block. Accepts `{ v4: [...], v6: [...] }`, a
 * flat array of lines (all treated as v4), or any of the tolerant aliases the
 * snapshot writer may use. Lines that are not fence-shaped are dropped, and so
 * is a tagged rule outside CROW-ENGINE-FENCE (it is some other chain's DROP).
 *
 * The result records, per family, whether the block contains the PREROUTING
 * jump into the fence chain: a rule in the chain is only live if the chain is
 * reachable.
 */
export function parseFenceRules(rawRules) {
  const block = rawRules && typeof rawRules === "object" && !Array.isArray(rawRules) ? rawRules : null;
  const v4 = block ? block.v4 ?? block.ipv4 ?? block.raw_v4 ?? [] : rawRules;
  const v6 = block ? block.v6 ?? block.ipv6 ?? block.raw_v6 ?? [] : [];
  const family = (lines) => {
    const list = Array.isArray(lines) ? lines : [lines];
    return {
      rules: list.map(parseFenceRule).filter(Boolean).filter((r) => r.chain === FENCE_CHAIN),
      jump: list.some((line) => isFenceJump(line)),
    };
  };
  const parsedV4 = family(v4);
  const parsedV6 = family(v6);
  return { v4: parsedV4.rules, v6: parsedV6.rules, jumps: { v4: parsedV4.jump, v6: parsedV6.jump } };
}

/**
 * The jump that makes the chain reachable — and ONLY its exact spelling:
 *
 *   -A PREROUTING -j CROW-ENGINE-FENCE
 *   -A PREROUTING -m comment --comment "…" -j CROW-ENGINE-FENCE   (comment optional)
 *
 * Anything else on the line (`-s`, `-i lo`, a second `-j`, an unknown token)
 * means the chain is not traversed for the traffic we care about, so this is
 * not a jump. Same strict tokenizer as parseFenceRule: an unrecognised spelling
 * can only ever leave a publish LESS fenced, never more.
 */
function isFenceJump(line) {
  const tokens = tokenize(line);
  let append = null;
  let jump = null;
  let matchComment = false;
  let commentText = null;

  const valueAt = (i) => {
    const v = tokens[i + 1];
    return v === undefined || v === "!" || v.startsWith("-") ? null : v;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token) {
      case "-A":
      case "--append": {
        const v = valueAt(i);
        if (v == null || append != null) return false;
        append = v;
        i++;
        break;
      }
      case "-j":
      case "--jump": {
        const v = valueAt(i);
        if (v == null || jump != null) return false;
        jump = v;
        i++;
        break;
      }
      case "-m":
      case "--match": {
        const v = valueAt(i);
        if (v == null || matchComment || v.toLowerCase() !== "comment") return false;
        matchComment = true;
        i++;
        break;
      }
      case "--comment": {
        const v = valueAt(i);
        if (v == null || !matchComment || commentText != null) return false;
        commentText = v;
        i++;
        break;
      }
      default:
        // A jump line carries no match of its own: `-s`, `-i`, `-o`, a second
        // `-A`, a stray word — all reject the line.
        return false;
    }
  }

  return append === "PREROUTING" && jump === FENCE_CHAIN;
}

/**
 * Rules that could fence this (address, port): an addressed rule or a port-only
 * one, inside CROW-ENGINE-FENCE, with the PREROUTING jump present for that
 * family (a v4 jump says nothing about v6).
 */
export function findFenceRule(rules, address, port, proto = "tcp") {
  const family = isIPv6(unmapIPv4(address)) ? "v6" : "v4";
  // Without the jump into the chain, no rule in it is ever reached.
  if (!rules?.jumps?.[family]) return null;
  // Interface-pinned only: a rule without `! -i <iface>` is not the fence the
  // plan asks for (it would drop tailnet traffic too), so it does not count.
  const candidates = (rules[family] || []).filter((r) => r.port === port && (!r.proto || r.proto === "tcp") && r.iface);
  const addressed = candidates.find((r) => r.addr && sameAddress(r.addr, address));
  if (addressed && proto === "tcp") return { kind: "addressed", rule: addressed };
  const portOnly = candidates.find((r) => r.portOnly);
  if (portOnly && proto === "tcp") return { kind: "port-only", rule: portOnly };
  return null;
}

/** An addressed rule for this port pinned to a DIFFERENT tailnet-shaped address. */
function findMismatchedRule(rules, address, port) {
  const family = isIPv6(unmapIPv4(address)) ? rules.v6 : rules.v4;
  return family.find((r) => r.port === port && r.addr && isTailnetAddress(r.addr) && !sameAddress(r.addr, address)) || null;
}

// ─── Snapshot reader ─────────────────────────────────────────────────────────

function parseTakenAt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const s = String(value ?? "").trim();
  if (!s) return NaN;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Read and vet the snapshot file. Never throws.
 *
 * @param {object} [opts]
 * @param {string} [opts.snapshotPath]
 * @param {number} [opts.nowMs]
 * @param {function} [opts.readFile]  (path) => text  (test seam)
 * @returns {{status: "ok"|"stale"|"future"|"missing"|"unreadable"|"malformed",
 *   snapshot: object|null, ageMs: number|null, reason: string|null, path: string}}
 */
export function loadPublishSnapshot({
  snapshotPath = process.env[PUBLISH_SNAPSHOT_ENV] || DEFAULT_PUBLISH_SNAPSHOT_PATH,
  nowMs = Date.now(),
  readFile = DEFAULT_FILE_READER,
} = {}) {
  const path = snapshotPath;
  let text;
  try {
    text = readFile(path);
  } catch (err) {
    // ENOENT is the ordinary "the fence was never installed" case; anything
    // else (EACCES, EIO) is unreadable. Both are "unknown", never "ok".
    const status = err && err.code === "ENOENT" ? "missing" : "unreadable";
    return { status, snapshot: null, ageMs: null, reason: err?.code || err?.message || null, path };
  }

  let snapshot;
  try {
    snapshot = JSON.parse(text);
  } catch {
    return { status: "malformed", snapshot: null, ageMs: null, reason: "not JSON", path };
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { status: "malformed", snapshot: null, ageMs: null, reason: "not an object", path };
  }
  const takenAt = parseTakenAt(snapshot.taken_at ?? snapshot.takenAt);
  if (!Number.isFinite(takenAt)) {
    return { status: "malformed", snapshot: null, ageMs: null, reason: "taken_at missing or unparseable", path };
  }
  // `containers` is not optional. A snapshot whose container list is a string,
  // an object or missing tells us nothing about what is published — reading it
  // as an empty list would print "none beyond loopback" for an unknown host.
  const containerList = Array.isArray(snapshot.containers)
    ? snapshot.containers
    : Array.isArray(snapshot.Containers) ? snapshot.Containers : null;
  if (!containerList) {
    return { status: "malformed", snapshot: null, ageMs: null, reason: "containers is not an array", path };
  }

  const ageMs = nowMs - takenAt;
  if (ageMs < -FUTURE_SKEW_MS) {
    return { status: "future", snapshot, ageMs, reason: "taken_at is in the future", path };
  }
  if (ageMs > PUBLISH_SNAPSHOT_STALE_MS) {
    return { status: "stale", snapshot, ageMs, reason: `older than ${Math.round(PUBLISH_SNAPSHOT_STALE_MS / 60000)} min`, path };
  }
  return { status: "ok", snapshot, ageMs, reason: null, path };
}

// ─── Snapshot normalisation ──────────────────────────────────────────────────

const pick = (...vals) => vals.find((v) => v !== undefined && v !== null);

function normLabels(labels) {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return {};
  const out = {};
  for (const [k, v] of Object.entries(labels)) out[String(k)] = v == null ? "" : String(v);
  return out;
}

function normNetworks(networks) {
  if (Array.isArray(networks)) return networks.map((n) => (typeof n === "string" ? n : n?.name)).filter(Boolean);
  if (networks && typeof networks === "object") return Object.keys(networks);
  return [];
}

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** The only key spelling Docker's PortBindings uses: `<container port>/<proto>`. */
const BINDING_KEY_RE = /^(\d{1,5})(?:\/([A-Za-z0-9]+))?$/;

/**
 * Docker's PortBindings shape, tolerantly: `{ "8005/tcp": [ { HostIp, HostPort } ] }`
 * (inspect's spelling), lowercase host_ip/host_port, or a bare port string.
 *
 * Returns `{ bindings, unreadable }`. `unreadable` is true when the bindings
 * value itself is not a plain object (a string, a number, an array) AND when ANY
 * key does not spell a container port — so the caller flags the container (see
 * inspectPublishedPorts) instead of letting a shape it cannot read read as
 * "nothing published". `null` is Docker's own spelling for "no bindings" and is
 * not unreadable.
 */
function normPortBindings(bindings) {
  if (!isPlainObject(bindings)) return { bindings: [], unreadable: bindings != null };
  const out = [];
  let unreadable = false;
  for (const [key, value] of Object.entries(bindings)) {
    const m = BINDING_KEY_RE.exec(String(key).trim());
    const port = m ? Number(m[1]) : NaN;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      // An unparseable port key is a shape this module cannot read: flag it,
      // never skip the key silently.
      unreadable = true;
      continue;
    }
    const proto = m[2] ? m[2].toLowerCase() : "tcp";
    const list = Array.isArray(value) ? value : value == null ? [] : [value];
    if (list.length === 0) {
      // A binding with no host entry at all: nothing is published, nothing to report.
      continue;
    }
    for (const entry of list) {
      const hostIp = pick(entry?.HostIp, entry?.host_ip, entry?.hostIp);
      const hostPort = pick(entry?.HostPort, entry?.host_port, entry?.hostPort, m[1]);
      out.push({ port: Number(hostPort) || port, containerPort: port, proto, hostIp: hostIp === undefined ? "" : String(hostIp) });
    }
  }
  return { bindings: out, unreadable };
}

function normContainer(c) {
  const rawHostConfig = pick(c?.host_config, c?.HostConfig);
  // A missing or non-object host_config is not "no ports": nothing about this
  // container's publish shape could be read, so it takes the SAME unreadable
  // path as a malformed port_bindings (see inspectPublishedPorts) — flagged,
  // never a silent skip.
  const hostConfigReadable = isPlainObject(rawHostConfig);
  const hostConfig = hostConfigReadable ? rawHostConfig : {};
  const labels = normLabels(pick(c?.labels, c?.Labels));
  const rawBindings = pick(hostConfig.port_bindings, hostConfig.PortBindings, c?.port_bindings);
  const bindings = normPortBindings(rawBindings);
  return {
    id: String(pick(c?.id, c?.short_id, c?.Id, "") || ""),
    name: String(pick(c?.name, c?.Name, "") || ""),
    labels,
    networkMode: String(pick(hostConfig.network_mode, hostConfig.NetworkMode, c?.network_mode, "") || ""),
    portBindings: bindings.bindings,
    // An unreadable host_config, or a port_bindings this module cannot read
    // (an array, a string, a number, an unparseable port key), is a shape it
    // cannot classify. It is flagged, never treated as "nothing published" —
    // see inspectPublishedPorts.
    portBindingsUnreadable: !hostConfigReadable || bindings.unreadable,
    networks: normNetworks(pick(c?.networks, c?.NetworkSettings?.Networks)),
  };
}

function normTailnetAddresses(snapshot) {
  const block = snapshot?.tailscale || snapshot?.tailnet || {};
  const raw = [block.v4, block.v6, block.ipv4, block.ipv6, snapshot?.tailscale_v4, snapshot?.tailscale_v6];
  const out = [];
  const push = (v) => {
    if (Array.isArray(v)) return v.forEach(push);
    if (typeof v !== "string") return;
    for (const piece of v.split(/[\s,]+/)) {
      const addr = unmapIPv4(piece);
      if (addr && !out.includes(addr)) out.push(addr);
    }
  };
  raw.forEach(push);
  return out;
}

function normFence(snapshot) {
  const f = snapshot?.fence && typeof snapshot.fence === "object" ? snapshot.fence : {};
  const hashes = f.hashes && typeof f.hashes === "object" ? f.hashes : {};
  const hash = (flatKey, nestedKey) => pick(f[flatKey], hashes[nestedKey]);
  const unitActive = pick(f.unit_active, f.unitActive, snapshot?.fence_unit_active);
  return {
    unitActive: typeof unitActive === "boolean" ? unitActive : null,
    confSha: hash("conf_sha256", "conf"),
    confSavedSha: hash("conf_saved_sha256", "conf_saved"),
    flagsSha: hash("docker_flags_sha256", "docker_flags"),
    flagsSavedSha: hash("docker_flags_saved_sha256", "docker_flags_saved"),
  };
}

/** Parse a Docker version string to its major number; null when unreadable. */
export function parseDockerVersion(version) {
  if (typeof version === "number" && Number.isFinite(version)) return Math.trunc(version);
  const m = /^v?(\d+)(?:\.|$)/.exec(String(version ?? "").trim());
  return m ? Number(m[1]) : null;
}

// ─── Allowlists (M6) ─────────────────────────────────────────────────────────

/**
 * The operator's `published_ports_allowlist` setting: a JSON array (or a
 * comma/newline separated string) of entries. An entry is a port
 * ("8005", "8005/tcp", "8005/udp") or a container selector plus a port
 * ("crow-caddy:443", "0123456789ab:8080"). "*" as the selector matches any
 * container. Malformed entries are ignored (they cannot widen the allowlist).
 */
export function parseAllowlistSetting(raw) {
  if (raw == null) return [];
  let items;
  if (Array.isArray(raw)) items = raw;
  else {
    const text = String(raw).trim();
    if (!text) return [];
    if (text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) return [];
        items = parsed;
      } catch {
        return [];
      }
    } else {
      items = text.split(/[\s,]+/);
    }
  }
  const out = [];
  for (const item of items) {
    const text = String(item ?? "").trim();
    if (!text) continue;
    const m = /^(?:(.+):)?(\d+)(?:\/(tcp|udp))?$/i.exec(text);
    if (!m) continue;
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    out.push({
      selector: m[1] ? m[1].trim().toLowerCase() : null,
      port,
      proto: m[3] ? m[3].toLowerCase() : null,
    });
  }
  return out;
}

function publishMatchesAllowlistEntry(entry, publish) {
  if (entry.port !== publish.port) return false;
  if (entry.proto && entry.proto !== publish.proto) return false;
  if (!entry.selector) return true;
  if (entry.selector === "*") return true;
  // A selector names ONE container: it must equal the container's name or its
  // container id exactly, or the container's bundle id when that identity is
  // VERIFIED (both the bundle label and a compose working dir under
  // `<CROW_HOME>/bundles/<id>` — see bundleIdOf). A claimed bundle label on its
  // own never widens the operator's allowlist. Prefix matching is deliberately
  // not offered in either direction — `crow` must not cover `crow-caddy`, and a
  // truncated id must not cover the full one.
  const haystack = [publish.name, publish.containerId, publish.verifiedBundleId]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
  return haystack.some((h) => h === entry.selector);
}

function normManifestPorts(value) {
  if (value == null) return [];
  const items = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  const out = [];
  for (const item of items) {
    const m = /^(\d+)(?:\/(tcp|udp))?$/i.exec(String(item ?? "").trim());
    if (!m) continue;
    const port = Number(m[1]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    out.push({ port, proto: m[2] ? m[2].toLowerCase() : null });
  }
  return out;
}

const BUNDLE_ID_RE = /^[A-Za-z0-9._-]+$/;

function readManifestFile(dir, bundleId, readFile) {
  if (!dir || !bundleId) return null;
  if (!BUNDLE_ID_RE.test(bundleId)) return null; // never join a path segment from a label
  try {
    const parsed = JSON.parse(readFile(join(dir, bundleId, "manifest.json")));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A bundle may declare its own public ports in its manifest — but ONLY a
 * first-party, version-pinned bundle (M6). Qualifying means: the bundle id is
 * shipped in THIS repo, the installed manifest is byte-for-byte the repo's
 * version (the same comparison refreshVersionedBundle makes), the installed
 * copy did not opt out with `"refresh": false`, and the ports are read from the
 * REPO manifest — so an edited installed manifest can never add one.
 *
 * Returns { qualifies: false, ports: [], reason } for anything else, including
 * a third-party manifest that declares `publishedPortsAllowlist` itself.
 */
export function readManifestAllowlist(bundleId, {
  repoDir = repoBundlesDir(),
  installedDir = installedBundlesDir(),
  readFile = DEFAULT_FILE_READER,
} = {}) {
  const fail = (reason) => ({ qualifies: false, ports: [], reason });
  if (!bundleId) return fail("no bundle label");
  const repoManifest = readManifestFile(repoDir, bundleId, readFile);
  if (!repoManifest) return fail("not a first-party bundle");
  const installedManifest = readManifestFile(installedDir, bundleId, readFile);
  if (!installedManifest) return fail("not installed from this repo");
  if (installedManifest.refresh === false) return fail("installed copy opts out of refresh");
  const repoVersion = repoManifest.version;
  const installedVersion = installedManifest.version;
  if (repoVersion === undefined || installedVersion === undefined || String(repoVersion) !== String(installedVersion)) {
    return fail("installed manifest is not the repo's version");
  }
  return { qualifies: true, ports: normManifestPorts(repoManifest[MANIFEST_ALLOWLIST_KEY]), reason: null };
}

// ─── Classification ──────────────────────────────────────────────────────────

function shortId(id, name) {
  if (id) return String(id).slice(0, 12);
  return String(name || "container").slice(0, 12);
}

/** Any of these labels is enough to treat a container as Crow-managed. */
const CROW_MANAGED_LABELS = Object.freeze(["crow.runtime", "crow.bundle", "crow.component"]);

/**
 * Whether a container counts as Crow-managed for the warns that treat Crow's
 * own workloads differently (the host-network entry).
 *
 * FAIL TOWARD WARN. Not every Crow launcher sets `crow.runtime` yet, so a
 * container is treated as Crow-managed when it carries ANY of `crow.runtime`,
 * `crow.bundle` or `crow.component`, or when bundleIdOf can tie its bundle label
 * to an installed bundle. Labels only ever ADD flagging: nothing here can make a
 * publish look safer, and a label never makes something LESS flagged.
 */
export function isCrowLabelled(labels, { installedDir = installedBundlesDir() } = {}) {
  if (!labels || typeof labels !== "object") return false;
  if (CROW_MANAGED_LABELS.some((key) => Object.hasOwn(labels, key))) return true;
  return bundleIdOf(labels, { installedDir }) != null;
}

/** The bundle id a container CLAIMS. Only Crow's own label counts: a compose
 * project name is set by whoever runs the container. */
function claimedBundleId(labels) {
  const id = labels?.["crow.bundle"];
  return id ? String(id) : null;
}

/**
 * The bundle id that may earn a first-party manifest allowlist — and BOTH
 * labels are required:
 *
 *   labels["crow.bundle"]                             the bundle it claims to be
 *   labels["com.docker.compose.project.working_dir"]  must resolve to
 *                                                     <installedDir>/<id>
 *                                                     (or a path inside it)
 *
 * Labelling itself is not enough: the compose working dir is what ties a
 * container to the installed bundle directory. A missing working-dir label does
 * not qualify, and `com.docker.compose.project` alone is never accepted.
 *
 * BE PLAIN ABOUT WHAT THIS PROVES: the label check RAISES THE BAR, it does not
 * prove identity. A container can still set its own labels, including a
 * `crow.bundle` id and a compose working dir that points at an installed bundle
 * — so a hostile container on this Docker socket can claim a first-party
 * bundle's identity. That must never be rewarded with operator trust, which is
 * why the two labels never widen the OPERATOR allowlist (a `bundle:` selector
 * only matches this verified id) and why the manifest half needs a first-party,
 * version-pinned bundle: the residual — at most the ports that bundle's own
 * installed, first-party manifest declares — is bounded by the repo's manifest,
 * not by what the container asks for.
 */
export function bundleIdOf(labels, { installedDir = installedBundlesDir() } = {}) {
  const id = claimedBundleId(labels);
  if (!id || !BUNDLE_ID_RE.test(id)) return null;
  const workdir = labels?.[COMPOSE_WORKDIR_LABEL];
  if (typeof workdir !== "string" || !workdir.trim()) return null;
  if (!installedDir) return null;
  const root = resolve(String(installedDir), id);
  const actual = resolve(workdir.trim());
  return actual === root || actual.startsWith(root + sep) ? id : null;
}

/**
 * Classify one HostIp. `kind` is the severity-bearing class:
 *   empty | wildcard | bridge | lan   → warn
 *   tailnet                           → depends on the fence rule
 *   loopback                          → silent
 *   unknown                           → warn (fail closed: a shape we cannot
 *                                       read is never dropped)
 */
export function classifyHostIp(hostIp) {
  const raw = String(hostIp ?? "").trim();
  if (raw === "") return { kind: "empty", address: "" };
  const addr = unmapIPv4(raw);
  if (addr === "0.0.0.0" || addr === "::" || addr === "*" || addr === "0::0") {
    return { kind: "wildcard", address: addr };
  }
  if (isLoopbackAddress(addr)) return { kind: "loopback", address: addr };
  if (isTailnetAddress(addr)) return { kind: "tailnet", address: addr };
  if (isBridgeAddress(addr)) return { kind: "bridge", address: addr };
  if (isIPv4(addr) || isIPv6(addr)) return { kind: "lan", address: addr };
  return { kind: "unknown", address: raw };
}

function blindSpotReport({ inspected, snapshot }) {
  const docker = snapshot?.docker && typeof snapshot.docker === "object" ? snapshot.docker : {};
  const userlandProxy = pick(docker.userland_proxy, docker.userlandProxy);
  return [
    { code: "host-network", inspected: inspected, note: BLIND_SPOTS["host-network"] },
    { code: "userland-proxy-false", inspected: inspected && typeof userlandProxy === "boolean", note: BLIND_SPOTS["userland-proxy-false"] },
    { code: "rootless-or-podman", inspected: false, note: BLIND_SPOTS["rootless-or-podman"] },
    { code: "other-netns", inspected: false, note: BLIND_SPOTS["other-netns"] },
  ];
}

/**
 * The whole audit, from one snapshot read.
 *
 * @param {object} [opts]
 * @param {number} [opts.nowMs]
 * @param {string} [opts.snapshotPath]
 * @param {function} [opts.readFile]
 * @param {Array} [opts.allowlist]              parsed operator allowlist entries
 * @param {string} [opts.repoBundlesDir]
 * @param {string} [opts.installedBundlesDir]
 * @returns {object} { status, trusted, publishes[], docker, fence, blindSpots[], tailnetAddresses[] }
 *   Each publish: { id, containerId, name, bundleId, verifiedBundleId, port,
 *                  proto, hostIp, kind,
 *                  severity: "warn"|"info", code, fenced: "addressed"|"port-only"|null,
 *                  allowlisted: boolean }
 *   `id` is the issue id stem: `published-ports:<short-id>:<port>`, and
 *   `published-ports:<short-id>:host-network` / `…:unknown-host` for the two
 *   container-level entries. `bundleId` is the bundle the container CLAIMS
 *   (display only); `verifiedBundleId` is the id that also carries a compose
 *   working dir under the installed bundle directory, and it is the only
 *   bundle identity either allowlist accepts.
 */
export function inspectPublishedPorts({
  nowMs = Date.now(),
  snapshotPath = process.env[PUBLISH_SNAPSHOT_ENV] || DEFAULT_PUBLISH_SNAPSHOT_PATH,
  readFile = DEFAULT_FILE_READER,
  allowlist = [],
  repoBundlesDir: repoDir = repoBundlesDir(),
  installedBundlesDir: installedDir = installedBundlesDir(),
} = {}) {
  const loaded = loadPublishSnapshot({ snapshotPath, nowMs, readFile });
  const snapshot = loaded.snapshot;
  const hasRows = !!snapshot;
  const trusted = loaded.status === "ok";

  const dockerBlock = snapshot?.docker && typeof snapshot.docker === "object" ? snapshot.docker : {};
  const dockerVersion = pick(dockerBlock.version, dockerBlock.server_version, snapshot?.docker_version) ?? null;
  const dockerMajor = parseDockerVersion(dockerVersion);

  const fence = normFence(snapshot);
  const hashMismatch = [];
  if (fence.confSha && fence.confSavedSha && String(fence.confSha) !== String(fence.confSavedSha)) hashMismatch.push("conf");
  if (fence.flagsSha && fence.flagsSavedSha && String(fence.flagsSha) !== String(fence.flagsSavedSha)) hashMismatch.push("docker-flags");

  const rawRules = pick(snapshot?.raw_rules, snapshot?.rawRules, snapshot?.iptables_raw, []);
  const rules = parseFenceRules(rawRules);
  const tailnetAddresses = normTailnetAddresses(snapshot);

  const containers = Array.isArray(snapshot?.containers)
    ? snapshot.containers.map(normContainer)
    : Array.isArray(snapshot?.Containers) ? snapshot.Containers.map(normContainer) : [];

  const manifestCache = new Map();
  const manifestAllowlistFor = (bundleId) => {
    if (!manifestCache.has(bundleId)) {
      manifestCache.set(bundleId, readManifestAllowlist(bundleId, { repoDir, installedDir, readFile }));
    }
    return manifestCache.get(bundleId);
  };

  const publishes = [];
  let loopbackCount = 0;

  for (const c of containers) {
    const bundleId = claimedBundleId(c.labels);
    const allowlistBundleId = bundleIdOf(c.labels, { installedDir });
    const allowlistForManifest = allowlistBundleId
      ? manifestAllowlistFor(allowlistBundleId)
      : { qualifies: false, ports: [] };
    const hostNetwork = c.networkMode.toLowerCase() === "host";

    if (c.portBindingsUnreadable) {
      // A port_bindings this module cannot read is NOT "nothing published":
      // the container is flagged so an unreadable shape can never read as
      // "none beyond loopback".
      publishes.push({
        id: `published-ports:${shortId(c.id, c.name)}:unknown-host`,
        containerId: c.id,
        name: c.name,
        bundleId,
        verifiedBundleId: allowlistBundleId,
        port: null,
        proto: null,
        hostIp: "",
        kind: "unknown",
        severity: "warn",
        code: "unknown-host",
        fenced: null,
        allowlisted: false,
      });
      continue;
    }

    if (hostNetwork) {
      // A host-network container publishes nothing; its own listeners sit on
      // every address of the host. Crow's own engine on host networking is a
      // warn of its own; anything else is listed as info (visible, not silent).
      const crowLabelled = isCrowLabelled(c.labels, { installedDir });
      publishes.push({
        id: `published-ports:${shortId(c.id, c.name)}:host-network`,
        containerId: c.id,
        name: c.name,
        bundleId,
        verifiedBundleId: allowlistBundleId,
        port: null,
        proto: null,
        hostIp: null,
        kind: "host-network",
        severity: crowLabelled ? "warn" : "info",
        code: crowLabelled ? "host-network-engine" : "host-network",
        fenced: null,
        allowlisted: false,
      });
      continue;
    }

    for (const binding of c.portBindings) {
      const cls = classifyHostIp(binding.hostIp);
      const entry = {
        id: `published-ports:${shortId(c.id, c.name)}:${binding.port}`,
        containerId: c.id,
        name: c.name,
        bundleId,
        verifiedBundleId: allowlistBundleId,
        port: binding.port,
        proto: binding.proto,
        hostIp: cls.address || binding.hostIp || "",
        kind: cls.kind,
        severity: "warn",
        code: cls.kind,
        fenced: null,
        allowlisted: false,
      };

      if (cls.kind === "loopback") { loopbackCount++; continue; } // silent, by rule

      // The operator's setting covers anything else; a first-party
      // version-pinned bundle's manifest covers only itself.
      const allowMatch = allowlist.find((e) => publishMatchesAllowlistEntry(e, entry));
      const manifestMatch = allowlistForManifest.qualifies
        && allowlistForManifest.ports.some((p) => p.port === entry.port && (!p.proto || p.proto === entry.proto));
      if (allowMatch || manifestMatch) {
        entry.severity = "info";
        entry.code = "allowlisted";
        entry.allowlisted = true;
        publishes.push(entry);
        continue;
      }

      if (cls.kind === "tailnet") {
        if (entry.proto !== "tcp") {
          // The fence generates TCP rules only, so a UDP publish can never be fenced.
          entry.code = "unfenced-protocol";
        } else if (!trusted) {
          // A stale/future snapshot's rules cannot be trusted: "fence unknown".
          entry.code = "fence-unknown";
          entry.fenced = null;
        } else {
          const found = findFenceRule(rules, cls.address, entry.port, entry.proto);
          if (found) {
            entry.severity = "info";
            entry.code = found.kind === "port-only" ? "fenced-port-only" : "fenced";
            entry.fenced = found.kind;
          } else if (findMismatchedRule(rules, cls.address, entry.port)) {
            entry.code = "address-mismatch";
          } else {
            entry.code = "unfenced";
          }
        }
        publishes.push(entry);
        continue;
      }

      if (cls.kind === "empty") { entry.code = "empty-host"; publishes.push(entry); continue; }
      if (cls.kind === "wildcard") { entry.code = "wildcard"; publishes.push(entry); continue; }
      if (cls.kind === "bridge") { entry.code = "bridge"; publishes.push(entry); continue; }
      if (cls.kind === "lan") { entry.code = "lan"; publishes.push(entry); continue; }
      entry.code = "unknown-host"; // fail closed: unreadable shape is flagged
      publishes.push(entry);
    }
  }

  return {
    status: loaded.status,
    reason: loaded.reason,
    snapshotPath: loaded.path,
    ageMs: loaded.ageMs,
    trusted,
    hasRows,
    docker: {
      version: dockerVersion,
      major: dockerMajor,
      floor: DOCKER_FLOOR,
      belowFloor: dockerMajor == null ? null : dockerMajor < DOCKER_FLOOR,
    },
    fence: {
      unitActive: fence.unitActive,
      hashMismatch,
      ruleCount: rules.v4.length + rules.v6.length,
    },
    tailnetAddresses,
    containerCount: containers.length,
    publishes,
    loopbackCount,
    blindSpots: blindSpotReport({ inspected: hasRows, snapshot }),
  };
}