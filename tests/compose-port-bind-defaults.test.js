/**
 * compose-port-bind-defaults.test.js — security audit K3.
 *
 * A model, STT or TTS server must never end up reachable from every interface
 * because an environment variable was unset. Docker's default for a publish is
 * 0.0.0.0, so:
 *
 *   - `"8000:8000"` (no host IP) publishes on every address;
 *   - `"0.0.0.0:80:80"` says so explicitly;
 *   - `"${CROW_TAILSCALE_IP}:8003:8000"` publishes on every address whenever
 *     the variable is unset — the case this audit found in seven bundles — and
 *     `${VAR:-}` (empty default) does the same.
 *
 * So every ports entry must name one specific host address: a literal, or a
 * variable with a NON-EMPTY default (`${VAR:-127.0.0.1}`), or a REQUIRED
 * variable (`${VAR:?message}`), which Compose refuses to start without. The
 * only exceptions are the deliberate public ports listed in
 * `scripts/port-bind-allowlist.txt` (`path port  # reason`) — today just the
 * reverse proxy's 80/443, which exist to answer the internet. An allowlist
 * entry that no longer matches a real publish is stale and fails this suite.
 *
 * Every compose file in the repo is walked (root, bundles/**, servers/**),
 * `node_modules`/`.git`/.pi-brief excluded, plus the checkout's own `data/`
 * scratch area at the root only. Short syntax (`"host_ip:host:container[/proto]"`,
 * quoted or not), long syntax (`host_ip:` / `published:` / `target:`, block or
 * flow) are both read. The checker is exported so the red cases below can be
 * driven from fixture strings instead of by editing a real compose file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALLOWLIST_PATH = join(ROOT, "scripts", "port-bind-allowlist.txt");

/** Directories never worth walking: dependencies and VCS. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".pi-brief"]);

/** Skipped ONLY at the repo root: the checkout's generated scratch area. */
const ROOT_SKIP_DIRS = new Set(["data"]);

/** docker-compose.yml / docker-compose.tailnet.yml / compose.yml / *.yaml … */
const COMPOSE_FILE_RE = /^(?:docker-)?compose(?:[.-][A-Za-z0-9_.-]+)?\.ya?ml$/;

/** Addresses Docker treats as "every interface". */
const WILDCARD_ADDRESSES = new Set(["0.0.0.0", "::", "[::]", "*", "0::0"]);

const VAR_NAME = "[A-Za-z_][A-Za-z0-9_]*";

/** `${VAR:-default}` / `${VAR-default}` / `$VAR:-default` — the default is what a fresh host publishes. */
const VAR_WITH_DEFAULT_RE = new RegExp(`^\\$(?:\\{(${VAR_NAME})(:?-)([\\s\\S]*)\\}|(${VAR_NAME})(:?-)([\\s\\S]*))$`);

/** `${VAR:?message}` / `${VAR?message}` — Compose refuses to start when unset, so it is always one address. */
const VAR_REQUIRED_RE = new RegExp(`^\\$(?:\\{${VAR_NAME}:?\\?[^}]*\\}|${VAR_NAME}:?\\?.*)$`);

/** Every compose file under `dir`, as repo-relative POSIX paths, sorted. */
export function findComposeFiles(dir = ROOT) {
  const out = [];
  const walk = (abs, isRoot) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (isRoot && ROOT_SKIP_DIRS.has(e.name))) continue;
        walk(join(abs, e.name), false);
      } else if (e.isFile() && COMPOSE_FILE_RE.test(e.name)) {
        out.push(relative(dir, join(abs, e.name)).split(sep).join("/"));
      }
    }
  };
  walk(dir, true);
  return out.sort();
}

/** A compose scalar without the quotes compose allows around it. */
function unquote(raw) {
  const s = String(raw ?? "").trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) return s.slice(1, -1).trim();
  return s;
}

/** Drop a trailing ` # comment` (a `#` after whitespace, outside a quoted scalar). */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/** Split on ":" outside `${…}`, so `${VAR:-127.0.0.1}:8000:8000` has three parts. */
function splitOutsideVars(text) {
  const out = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "{") {
      const end = text.indexOf("}", i + 2);
      if (end > 0) { cur += text.slice(i, end + 1); i = end; continue; }
    }
    if (text[i] === ":") { out.push(cur); cur = ""; continue; }
    cur += text[i];
  }
  out.push(cur);
  return out;
}

/**
 * What one host-IP field does when the environment is empty.
 * @returns {{code: "literal"|"wildcard"|"no-default"|"empty-default"|"required"|"no-host-ip", address: string}}
 *   `literal`/`required` are fine (one specific address, or Compose refuses to
 *   start). `wildcard` and `no-host-ip` publish on every interface and can only
 *   pass on an allowlist entry. `no-default` / `empty-default` are never allowed.
 */
export function classifyHostAddress(raw) {
  const ip = String(raw ?? "").trim();
  if (ip === "") return { code: "no-host-ip", address: "" };
  if (WILDCARD_ADDRESSES.has(ip)) return { code: "wildcard", address: ip };
  if (!ip.startsWith("$")) return { code: "literal", address: ip };

  const withDefault = VAR_WITH_DEFAULT_RE.exec(ip);
  if (withDefault) {
    const def = String(withDefault[3] ?? withDefault[6] ?? "").trim();
    if (def === "") return { code: "empty-default", address: ip };
    // A default may itself be a variable (`${A:-${B:-127.0.0.1}}`): resolve it,
    // and never let an unresolved one pass as literal.
    const inner = classifyHostAddress(def);
    return inner.code === "literal" ? { code: "literal", address: inner.address } : inner;
  }
  if (VAR_REQUIRED_RE.test(ip)) return { code: "required", address: ip };
  return { code: "no-default", address: ip };
}

/** Is this finding the kind an allowlist entry may excuse? */
export const ALLOWLISTABLE = new Set(["no-host-ip", "wildcard"]);

/**
 * One published host port from a `ports:` entry.
 * `{ skip: true }` for a mapping that publishes nothing on a fixed host port
 * (container-only `- "80"`, ephemeral `127.0.0.1::80`, no `published:`).
 */
function shortMapping(rawSpec) {
  const spec = unquote(rawSpec);
  if (!spec) return { skip: true };
  const protoMatch = /\/(tcp|udp|sctp)$/i.exec(spec);
  const proto = protoMatch ? protoMatch[1].toLowerCase() : "tcp";
  const body = protoMatch ? spec.slice(0, protoMatch.index) : spec;

  let ip;
  let rest;
  if (body.startsWith("[")) {
    // Bracketed IPv6: [::1]:8000:80
    const close = body.indexOf("]");
    if (close < 0 || body[close + 1] !== ":") return { skip: true };
    ip = body.slice(1, close);
    rest = body.slice(close + 2).split(":");
    if (rest.length !== 2) return { skip: true };
  } else {
    const parts = splitOutsideVars(body);
    if (parts.length === 1) return { skip: true }; // container-only: "80"
    if (parts.length === 2) { ip = ""; rest = parts; } // no host IP at all: "8000:8000"
    else if (parts.length === 3) { ip = parts[0]; rest = parts.slice(1); }
    else return { skip: true };
  }
  const host = rest[0].trim();
  if (host === "") return { skip: true }; // ephemeral host port: "127.0.0.1::80"
  return { ip, host, container: rest[1].trim(), proto };
}

/** `path\tport` — the key that pairs an allowlist entry with a real publish. */
export function portBindKey(path, port) {
  return `${path}\t${port}`;
}

function normalizePort(port) {
  return String(port ?? "").trim().toLowerCase();
}

/** `path port  # reason` lines; blank lines and full-line comments are skipped. */
export function parsePortBindAllowlist(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const body = line.replace(/(^|\s)#.*$/, "").trim();
    if (!body) continue;
    const [path, port] = body.split(/\s+/);
    out.push({ path: path ? path.split(sep).join("/") : "", port: normalizePort(port) });
  }
  return out;
}

/** Pull the `key: value` pairs of a long-syntax entry (`- target: 80` … `  host_ip: …`). */
function flowFields(text) {
  const body = text.trim().replace(/^\{|\}$/g, "");
  const parts = [];
  let cur = "";
  let quote = null;
  for (const ch of body) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ",") { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const fields = {};
  for (const part of parts) {
    const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(part.trim());
    if (m) fields[m[1]] = m[2];
  }
  return fields;
}

/** One long-syntax entry -> a mapping, or `{ skip: true }`. */
function longMapping(fields) {
  if (fields.published === undefined) return { skip: true }; // container port only
  const published = unquote(fields.published);
  if (published === "") return { skip: true };
  const protoMatch = /\/(tcp|udp|sctp)$/i.exec(published);
  const proto = protoMatch ? protoMatch[1].toLowerCase() : "tcp";
  const host = protoMatch ? published.slice(0, protoMatch.index) : published;
  const ipRaw = fields.host_ip === undefined ? "" : unquote(fields.host_ip);
  const target = fields.target === undefined ? "" : unquote(String(fields.target));
  return { ip: ipRaw, host: host.trim(), container: target, proto };
}

/**
 * Every published host port in one compose file's `ports:` sections.
 * @returns {Array<{line: number, ip: string, host: string, proto: string}>}
 */
export function findPublishedPorts(text) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  const push = (line, mapping) => { if (mapping && !mapping.skip) out.push({ line, ...mapping }); };

  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s*)ports:\s*(.*)$/.exec(lines[i]);
    if (!head) continue;
    const keyIndent = head[1].length;
    const inline = stripComment(head[2]).trim();

    // Flow style on the key line: `ports: ["127.0.0.1:8080:80"]`
    if (inline.startsWith("[")) {
      for (const item of inline.replace(/^\[|\]$/g, "").split(",")) {
        const body = item.trim();
        if (!body) continue;
        push(i + 1, body.startsWith("{") ? longMapping(flowFields(body)) : shortMapping(body));
      }
      continue;
    }
    if (inline !== "") continue; // not a ports block we can read (never used in this repo)

    let current = null; // long-syntax entry being accumulated
    let itemIndent = -1;
    const flush = () => { if (current) push(current.line, longMapping(current.fields)); current = null; };
    let j = i + 1;
    for (; j < lines.length; j++) {
      const withoutComment = stripComment(lines[j]);
      if (!withoutComment.trim()) continue; // blank or comment line inside the block
      const indent = withoutComment.length - withoutComment.trimStart().length;
      const item = /^(\s*)-\s*(.*)$/.exec(withoutComment);
      // List items sit deeper than the key, but YAML also allows them at the
      // key's own indent (and nothing may sit above it).
      const isItem = item && item[1].length >= keyIndent && (itemIndent < 0 || item[1].length === itemIndent);
      if (isItem) {
        itemIndent = item[1].length;
        flush();
        const body = item[2].trim();
        if (body.startsWith("{")) { push(j + 1, longMapping(flowFields(body))); continue; }
        const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(body);
        if (kv) { current = { line: j + 1, fields: { [kv[1]]: kv[2] } }; continue; }
        push(j + 1, shortMapping(body));
        continue;
      }
      if (indent <= keyIndent) break;
      if (current && indent > itemIndent) {
        const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(withoutComment.trim());
        if (kv) current.fields[kv[1]] = kv[2];
        continue;
      }
      break;
    }
    flush();
    i = j - 1;
  }
  return out;
}

/**
 * The findings for one compose file's text.
 * @param {string} text
 * @param {{file?: string, allowlist?: Array<{path: string, port: string}>}} [opts]
 * @returns {Array<{file: string, line: number, entry: string, address: string, port: string, proto: string, code: string, allowlisted: boolean}>}
 */
export function checkComposePortBinds(text, { file = "(inline)", allowlist = [] } = {}) {
  const findings = [];
  for (const { line, ip, host, container, proto } of findPublishedPorts(text)) {
    const verdict = classifyHostAddress(ip);
    if (verdict.code === "literal" || verdict.code === "required") continue;
    const port = proto === "tcp" ? host : `${host}/${proto}`;
    findings.push({
      file,
      line,
      entry: ip === "" ? `${host}:${container || "?"}` : `${ip}:${host}:${container || "?"}`,
      address: verdict.address,
      port,
      proto,
      code: verdict.code,
      allowlisted: ALLOWLISTABLE.has(verdict.code) && allowlist.some((e) => e.path === file && e.port === port),
    });
  }
  return findings;
}

/** Every `path\tport` key a finding in the repo could be allowlisted by. */
export function collectPortBindKeys(files = findComposeFiles(), dir = ROOT) {
  const keys = new Set();
  for (const file of files) {
    for (const { ip, host, proto } of findPublishedPorts(readFileSync(join(dir, file), "utf8"))) {
      const verdict = classifyHostAddress(ip);
      if (!ALLOWLISTABLE.has(verdict.code)) continue;
      keys.add(portBindKey(file, proto === "tcp" ? host : `${host}/${proto}`));
    }
  }
  return keys;
}

/**
 * The allowlist entries that match NO real publish. That is the whole staleness
 * rule: an entry that no longer names a publish on every interface has rotted
 * into a blanket exemption and must fail the suite.
 */
export function findStaleAllowlist(allowlist, seenKeys) {
  return (allowlist || []).filter((e) => !seenKeys.has(portBindKey(e.path, e.port)));
}

const ALLOWLIST = parsePortBindAllowlist(readFileSync(ALLOWLIST_PATH, "utf8"));

// ── the repo ────────────────────────────────────────────────────────────────

test("every compose port is bound to one specific host address (or is an allowlisted public port)", () => {
  const files = findComposeFiles();
  assert.ok(files.includes("docker-compose.yml"), "the root compose file is walked");
  assert.ok(files.some((f) => f.startsWith("bundles/")), "bundle compose files are walked");
  assert.ok(files.includes("servers/gateway/preview/container/compose.yml"), "every compose*.yml is walked, not just bundles");
  assert.ok(!files.some((f) => f.includes("node_modules")), "node_modules is skipped");

  const bad = [];
  for (const file of files) {
    for (const f of checkComposePortBinds(readFileSync(join(ROOT, file), "utf8"), { file, allowlist: ALLOWLIST })) {
      if (f.allowlisted) continue;
      bad.push(`${f.file}:${f.line} ${f.entry} (${f.code})`);
    }
  }
  assert.deepEqual(bad, [], `ports that could publish on every interface:\n  ${bad.join("\n  ")}`);
});

test("no allowlist entry is stale: each one still matches a real public publish", () => {
  const stale = findStaleAllowlist(ALLOWLIST, collectPortBindKeys()).map((e) => `${e.path} ${e.port}`);
  assert.deepEqual(stale, [], `stale scripts/port-bind-allowlist.txt entries:\n  ${stale.join("\n  ")}`);
});

test("the seven audited model/STT/TTS mappings fall back to loopback", () => {
  // The K3 audit: each of these used a host-IP variable with no default, so a
  // host that never set it published an unauthenticated model, STT or TTS
  // server on 0.0.0.0. Pinned by file and host port, so a revert cannot hide.
  const audited = [
    ["bundles/kokoro-tts/docker-compose.tailnet.yml", "8880"],
    ["bundles/faster-whisper-server/docker-compose.tailnet.yml", "8005"],
    ["bundles/llamacpp-vulkan-qwen36-35b-a3b/docker-compose.yml", "8003"],
    ["bundles/vllm-cuda-embed/docker-compose.yml", "9100"],
    ["bundles/vllm-cuda-vision/docker-compose.yml", "9102"],
    ["bundles/vllm-cuda-rerank/docker-compose.yml", "9101"],
    ["bundles/vllm-rocm-qwen35-4b/docker-compose.yml", "8011"],
  ];
  const problems = [];
  for (const [file, hostPort] of audited) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const entry = findPublishedPorts(text).find((p) => p.host === hostPort);
    if (!entry) { problems.push(`${file}: no mapping for host port ${hostPort}`); continue; }
    const verdict = classifyHostAddress(entry.ip);
    if (verdict.code !== "literal") problems.push(`${file}:${entry.line} ${entry.ip} -> ${verdict.code}`);
    if (verdict.address !== "127.0.0.1") problems.push(`${file}:${entry.line} falls back to ${verdict.address}, not loopback`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

// ── the checker's red cases (fixture strings, never a real file) ──

test("red: a bare host-IP variable publishes on every interface", () => {
  const findings = checkComposePortBinds('services:\n  app:\n    ports:\n      - "${TAILSCALE_IP}:8000:8000"\n');
  assert.deepEqual(findings.map((f) => [f.line, f.code, f.allowlisted]), [[4, "no-default", false]]);
  // …and the unbraced spelling, quoted or not, is the same thing.
  assert.equal(checkComposePortBinds("services:\n  app:\n    ports:\n      - $TAILSCALE_IP:8000:8000\n")[0].code, "no-default");
  // An allowlist entry cannot excuse it: only the public (no-IP / wildcard) kinds are allowlistable.
  const allowlisted = parsePortBindAllowlist("bundles/x/docker-compose.yml  8000  # nope\n");
  assert.equal(checkComposePortBinds('services:\n  app:\n    ports:\n      - "${TAILSCALE_IP}:8000:8000"\n', { file: "bundles/x/docker-compose.yml", allowlist: allowlisted })[0].allowlisted, false);
});

test("red: a port published with no host IP at all is 0.0.0.0", () => {
  const findings = checkComposePortBinds("services:\n  app:\n    ports:\n      - 8000:8000\n");
  assert.deepEqual(findings.map((f) => [f.line, f.code, f.port]), [[4, "no-host-ip", "8000"]]);
  assert.equal(checkComposePortBinds('services:\n  app:\n    ports:\n      - "8000:8000/udp"\n')[0].port, "8000/udp");
  // A wide-open port is exactly what the allowlist is for (the reverse proxy's 80/443).
  const allowlisted = parsePortBindAllowlist("bundles/x/docker-compose.yml  8000  # a public port\n");
  const excused = checkComposePortBinds('services:\n  app:\n    ports:\n      - "8000:8000"\n', { file: "bundles/x/docker-compose.yml", allowlist: allowlisted });
  assert.deepEqual(excused.map((f) => f.allowlisted), [true]);
});

test("red: a variable with an empty default is as wide open as no default", () => {
  const findings = checkComposePortBinds('services:\n  app:\n    ports:\n      - "${TAILSCALE_IP:-}:8000:8000"\n');
  assert.deepEqual(findings.map((f) => [f.line, f.code]), [[4, "empty-default"]]);
  assert.equal(checkComposePortBinds('services:\n  app:\n    ports:\n      - "${TAILSCALE_IP-}:8000:8000"\n')[0].code, "empty-default");
  // A default that is itself a wildcard (or a variable) does not rescue it.
  assert.equal(checkComposePortBinds('services:\n  app:\n    ports:\n      - "${A:-${B}}:8000:8000"\n')[0].code, "no-default");
  assert.deepEqual(
    checkComposePortBinds('services:\n  app:\n    ports:\n      - "${A:-0.0.0.0}:8000:8000"\n').map((f) => f.code),
    ["wildcard"],
  );
});

test("red: long syntax and an explicit wildcard are caught too", () => {
  const long = [
    "services:",
    "  app:",
    "    ports:",
    "      - target: 8000",
    '        published: "8000"',
    "      - target: 8001",
    '        published: "8001"',
    "        host_ip: ${TAILSCALE_IP}",
    "      - target: 8002",
    '        published: "8002"',
    "        host_ip: ''",
  ].join("\n");
  assert.deepEqual(checkComposePortBinds(long).map((f) => [f.line, f.code]), [
    [4, "no-host-ip"],
    [6, "no-default"],
    [9, "no-host-ip"],
  ]);
  assert.deepEqual(checkComposePortBinds('services:\n  app:\n    ports: ["0.0.0.0:80:80", "[::]:443:443/udp"]\n').map((f) => [f.code, f.port]),
    [["wildcard", "80"], ["wildcard", "443/udp"]]);
  assert.equal(checkComposePortBinds('services:\n  app:\n    ports:\n      - "0.0.0.0:443:443/udp"   # HTTP/3\n')[0].port, "443/udp");
});

test("green: loopback literals, non-empty defaults, required variables and CN-only ports pass", () => {
  const text = [
    "services:",
    "  app:",
    "    ports:",
    '      - "127.0.0.1:8080:80"',
    "      - 127.0.0.1:8090:90   # unquoted, trailing comment",
    '      - "${TAILSCALE_IP:-127.0.0.1}:8003:8000"',
    '      - "${MINIO_BIND_ADDR:-127.0.0.1}:9000:9000"',
    '      - "${CROW_TAILSCALE_IP:?Set CROW_TAILSCALE_IP}:8004:8000"',
    '      - "${A:-${B:-127.0.0.1}}:8009:8009"',
    '      - "[::1]:8099:99"',
    '      - "127.0.0.1:8555:8555/udp"',
    '      - "80"',
    '      - "127.0.0.1::80"',
    "    volumes:",
    '      - "${DATA:-./data}:/data"',
    "    environment:",
    '      - "URL=http://localhost:3040"',
  ].join("\n");
  assert.deepEqual(checkComposePortBinds(text), []);

  const long = [
    "services:",
    "  app:",
    "    ports:",
    "      - target: 80",
    '        published: "8080"',
    "        host_ip: 127.0.0.1",
    '      - { target: 443, published: "8443", host_ip: "127.0.0.1" }',
    "      - target: 9000",
  ].join("\n");
  assert.deepEqual(checkComposePortBinds(long), []);
});

test("green: the comment and stanza walk never reads a volume or environment line as a port", () => {
  const text = [
    "services:",
    "  app:",
    "    # ports:",
    '    #   - "8000:8000"',
    "    volumes:",
    '      - "${DATA:-./data}:/data:ro"',
    "    ports:",
    "      # a comment inside the block",
    '      - "127.0.0.1:8081:80"',
    "    environment:",
    '      - "PORT=3001:3001"',
    "  other:",
    "    image: x",
  ].join("\n");
  assert.deepEqual(findPublishedPorts(text).map((p) => [p.line, p.host]), [[9, "8081"]]);
});

// ── allowlist + staleness ───────────────────────────────────────────────────

test("red: an allowlist entry that matches nothing is stale", () => {
  const entries = parsePortBindAllowlist("bundles/gone/docker-compose.yml  80  # removed bundle\n");
  assert.deepEqual(entries, [{ path: "bundles/gone/docker-compose.yml", port: "80" }]);
  const seen = collectPortBindKeys();
  assert.deepEqual(findStaleAllowlist(entries, seen), entries, "the real check flags an entry whose file is gone");
  assert.deepEqual(findStaleAllowlist(ALLOWLIST, seen), [], "the live allowlist is not stale");
  const live = ALLOWLIST[0];
  assert.deepEqual(findStaleAllowlist([live], new Set([portBindKey(live.path, live.port)])), []);
  assert.deepEqual(findStaleAllowlist([live], new Set([portBindKey(live.path, "8443")])), [live],
    "the pair matters, not just the path");
});

test("green: a defaulted host-IP variable needs no allowlist entry (an entry for it would be stale)", () => {
  // Only a publish that CANNOT be pinned to one address is allowlistable; a
  // defaulted variable is simply safe, so listing it would be a stale entry.
  assert.deepEqual(checkComposePortBinds('services:\n  app:\n    ports:\n      - "${BIND:-127.0.0.1}:80:80"\n'), []);
  assert.equal(ALLOWLIST.some((e) => e.port === "80" && e.path !== "bundles/caddy/docker-compose.yml"), false);
});