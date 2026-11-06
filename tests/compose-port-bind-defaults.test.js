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
 * variable with a NON-EMPTY `:-` default (`${VAR:-127.0.0.1}`), or a REQUIRED
 * `:?` variable (`${VAR:?message}`), which Compose refuses to start without.
 * The colon matters: `${VAR-127.0.0.1}` / `${VAR?message}` only apply when the
 * variable is UNSET, so a variable set to "" still opens every interface. The
 * only exceptions are the deliberate public ports listed in
 * `scripts/port-bind-allowlist.txt` (`path port  # reason`) — today just the
 * reverse proxy's 80/443, which exist to answer the internet. An allowlist
 * entry that no longer matches a real publish is stale and fails this suite.
 *
 * A ports entry that publishes no host port is NOT container-only: Compose
 * publishes a RANDOM host port on 0.0.0.0 (`- "80"`, `- target: 80`), so those
 * are findings too — only `expose:` is container-only. A `ports:` value the
 * checker cannot read at all (`ports: *anchor`, an inline scalar, a short form
 * with four colon parts) is reported as `unreadable` and can never be
 * allowlisted, so a human has to read it. A tag on the key
 * (`ports: !override`) only modifies the list that follows, which is read
 * normally.
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
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

/**
 * `${VAR:-default}` / `${VAR-default}` / `$VAR:-default` — the default is what
 * a fresh host publishes. The separator is captured because only `:-` also
 * substitutes for a variable that is SET BUT EMPTY.
 */
const VAR_WITH_DEFAULT_RE = new RegExp(`^\\$(?:\\{(${VAR_NAME})(:?-)([\\s\\S]*)\\}|(${VAR_NAME})(:?-)([\\s\\S]*))$`);

/**
 * `${VAR:?message}` — Compose refuses to start when the variable is unset, so
 * the publish is always one address. The plain `${VAR?message}` form does not:
 * it accepts an empty value, which is a wildcard.
 */
const VAR_REQUIRED_RE = new RegExp(`^\\$(?:\\{${VAR_NAME}:\\?[^}]*\\}|${VAR_NAME}:\\?.*)$`);

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
    const sep = String(withDefault[2] ?? withDefault[5] ?? "");
    const def = String(withDefault[3] ?? withDefault[6] ?? "").trim();
    if (def === "") return { code: "empty-default", address: ip };
    // Only `:-` covers a variable that is SET BUT EMPTY; `${VAR-x}` yields an
    // empty host IP there, which is 0.0.0.0 again.
    if (sep !== ":-") return { code: "no-default", address: ip };
    // A default may itself be a variable (`${A:-${B:-127.0.0.1}}`): resolve it,
    // and never let an unresolved one pass as literal.
    const inner = classifyHostAddress(def);
    return inner.code === "literal" ? { code: "literal", address: inner.address } : inner;
  }
  // `${VAR?msg}` (no colon) only refuses to start when UNSET, so it does not
  // pin the address; only `:?` does.
  if (VAR_REQUIRED_RE.test(ip)) return { code: "required", address: ip };
  return { code: "no-default", address: ip };
}

/** Is this finding the kind an allowlist entry may excuse? */
export const ALLOWLISTABLE = new Set(["no-host-ip", "wildcard"]);

/** A `ports:` value whose publish shape cannot be read — never allowlistable. */
function unreadable(spec, reason) {
  return { unreadable: true, entry: spec, reason: reason || "unreadable ports entry" };
}

/**
 * One short-syntax `ports:` entry -> a mapping, or `{ skip: true }` when there
 * is no value at all, or `{ unreadable: true }` when the shape cannot be read.
 *
 * A single part (`- "80"`) is NOT container-only: Docker picks a RANDOM host
 * port on 0.0.0.0, so it comes back as a mapping with an empty host port (and
 * therefore an empty host IP, unless one was named). Only `expose:` is
 * container-only. `"127.0.0.1::80"` stays safe: a specific address with a
 * random port cannot be reached from another interface.
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
    if (close < 0 || body[close + 1] !== ":") return unreadable(spec);
    ip = body.slice(1, close);
    rest = body.slice(close + 2).split(":");
    if (rest.length > 2) return unreadable(spec);
    if (rest.length === 1) rest = ["", rest[0]]; // [::1]:80 — random host port on ::1
  } else {
    const parts = splitOutsideVars(body);
    // Four or more parts is not a mapping we can read; guessing would hide a
    // wide-open publish, so report it instead of skipping it.
    if (parts.length > 3) return unreadable(spec);
    if (parts.length === 1) { ip = ""; rest = ["", parts[0]]; } // container port only: "80". Docker picks a random host port on 0.0.0.0
    else if (parts.length === 2) { ip = ""; rest = parts; } // no host IP at all: "8000:8000"
    else { ip = parts[0]; rest = parts.slice(1); }
  }
  const host = rest[0].trim();
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

/** One long-syntax entry -> a mapping, or `{ skip: true }` for an empty one. */
function longMapping(fields) {
  const published = fields.published === undefined ? "" : unquote(fields.published);
  const target = fields.target === undefined ? "" : unquote(String(fields.target));
  // No `published:` is a RANDOM host port on 0.0.0.0 (or on host_ip, if one is
  // given), exactly like the short `- "80"` form — not container-only.
  if (published === "" && target === "") return { skip: true };
  const protoMatch = /\/(tcp|udp|sctp)$/i.exec(published);
  const proto = protoMatch ? protoMatch[1].toLowerCase() : "tcp";
  const host = protoMatch ? published.slice(0, protoMatch.index) : published;
  const ipRaw = fields.host_ip === undefined ? "" : unquote(fields.host_ip);
  return { ip: ipRaw, host: host.trim(), container: target, proto };
}

/**
 * Every published host port in one compose file's `ports:` sections, plus one
 * `{ line, unreadable: true, entry, reason }` item per `ports:` value that
 * cannot be read (so it is a finding, never a silent skip).
 * @returns {Array<{line: number, ip?: string, host?: string, proto?: string, unreadable?: boolean, entry?: string}>}
 */
export function findPublishedPorts(text) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  const push = (line, mapping) => {
    if (!mapping || mapping.skip) return;
    if (mapping.unreadable) { out.push({ line, unreadable: true, entry: mapping.entry, reason: mapping.reason }); return; }
    out.push({ line, ...mapping });
  };

  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s*)ports:\s*(.*)$/.exec(lines[i]);
    if (!head) continue;
    const keyIndent = head[1].length;
    const inlineRaw = stripComment(head[2]).trim();
    // A tag on the key (`ports: !override`, `ports: !reset`) only modifies the
    // list that follows: strip it and read what remains as usual.
    const tag = /^![\w.-]+\s*([\s\S]*)$/.exec(inlineRaw);
    const inline = tag ? tag[1].trim() : inlineRaw;

    // Flow style on the key line: `ports: ["127.0.0.1:8080:80"]`
    if (inline.startsWith("[")) {
      for (const item of inline.replace(/^\[|\]$/g, "").split(",")) {
        const body = item.trim();
        if (!body) continue;
        push(i + 1, body.startsWith("{") ? longMapping(flowFields(body)) : shortMapping(body));
      }
      continue;
    }
    if (inline !== "") {
      // `ports: *anchor`, `ports: ${PORTS}`, any other scalar: the publish shape
      // cannot be read, and skipping it would silently hide a 0.0.0.0 bind.
      push(i + 1, unreadable(inline, "value after `ports:` that cannot be read"));
      continue;
    }

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
  for (const pub of findPublishedPorts(text)) {
    if (pub.unreadable) {
      // No allowlist entry can excuse a shape the checker cannot read: a human
      // has to look at it.
      findings.push({ file, line: pub.line, entry: pub.entry, address: "", port: "", proto: "tcp", code: "unreadable", allowlisted: false });
      continue;
    }
    const { line, ip, host, container, proto } = pub;
    const verdict = classifyHostAddress(ip);
    if (verdict.code === "literal" || verdict.code === "required") continue;
    // A random host port has no port number to pin or allowlist, so it can
    // never be excused — only a specific IP with a random port is safe.
    const port = host === "" ? "" : proto === "tcp" ? host : `${host}/${proto}`;
    const entry = host === ""
      ? (ip === "" ? `${container || "?"} (container port only, random host port)` : `${ip}::${container || "?"}`)
      : ip === "" ? `${host}:${container || "?"}` : `${ip}:${host}:${container || "?"}`;
    findings.push({
      file,
      line,
      entry,
      address: verdict.address,
      port,
      proto,
      code: verdict.code,
      allowlisted: host !== "" && ALLOWLISTABLE.has(verdict.code) && allowlist.some((e) => e.path === file && e.port === port),
    });
  }
  return findings;
}

/** Every `path\tport` key a finding in the repo could be allowlisted by. */
export function collectPortBindKeys(files = findComposeFiles(), dir = ROOT) {
  const keys = new Set();
  for (const file of files) {
    for (const pub of findPublishedPorts(readFileSync(join(dir, file), "utf8"))) {
      // Unreadable entries, and a random host port, can never be allowlisted.
      if (pub.unreadable || pub.host === "") continue;
      const verdict = classifyHostAddress(pub.ip);
      if (!ALLOWLISTABLE.has(verdict.code)) continue;
      keys.add(portBindKey(file, pub.proto === "tcp" ? pub.host : `${pub.host}/${pub.proto}`));
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
    // Select the host-IP VARIABLE line, not a literal loopback line for the same
    // port: kokoro's overlay has both, and a revert of the variable line is
    // exactly what this test exists to catch.
    const entry = findPublishedPorts(text).find((p) => p.host === hostPort && String(p.ip ?? "").startsWith("$"));
    if (!entry) { problems.push(`${file}: no host-IP-variable mapping for host port ${hostPort}`); continue; }
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

test("red: a colon-less default or required-check still leaves a set-but-empty variable wide open", () => {
  // `${VAR-x}` only substitutes when the variable is UNSET, and `${VAR?msg}`
  // only refuses to start when it is UNSET. A variable set to "" gives an empty
  // host IP (0.0.0.0) in both cases, so only `:-` and `:?` count as safe.
  assert.equal(checkComposePortBinds('services:\n  app:\n    ports:\n      - "${TAILSCALE_IP-127.0.0.1}:8000:8000"\n')[0].code, "no-default");
  assert.equal(checkComposePortBinds('services:\n  app:\n    ports:\n      - "${TAILSCALE_IP?Set TAILSCALE_IP}:8000:8000"\n')[0].code, "no-default");
  assert.equal(checkComposePortBinds('services:\n  app:\n    ports:\n      - "${TAILSCALE_IP-}:8000:8000"\n')[0].code, "empty-default");
  // The colon forms are the safe ones (pinned in the green case too).
  assert.deepEqual(checkComposePortBinds('services:\n  app:\n    ports:\n      - "${TAILSCALE_IP:-127.0.0.1}:8000:8000"\n'), []);
  assert.deepEqual(checkComposePortBinds('services:\n  app:\n    ports:\n      - "${TAILSCALE_IP:?Set TAILSCALE_IP}:8000:8000"\n'), []);
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

test("red: a container-port-only entry publishes a random host port on 0.0.0.0", () => {
  // `- "80"` is NOT container-only: Docker picks a random host port on every
  // interface. Only `expose:` is container-only.
  for (const spec of ['- "80"', "- 80", '- "80/udp"']) {
    assert.deepEqual(
      checkComposePortBinds(`services:\n  app:\n    ports:\n      ${spec}\n`).map((f) => [f.line, f.code, f.allowlisted]),
      [[4, "no-host-ip", false]],
      spec,
    );
  }
  assert.deepEqual(checkComposePortBinds('services:\n  app:\n    expose:\n      - "80"\n'), [], "expose: is the container-only form");
  // …and no allowlist entry can excuse a port the host OS picks.
  const allowlisted = parsePortBindAllowlist("bundles/x/docker-compose.yml  80  # nope\n");
  assert.equal(
    checkComposePortBinds('services:\n  app:\n    ports:\n      - "80"\n', { file: "bundles/x/docker-compose.yml", allowlist: allowlisted })[0].allowlisted,
    false,
  );

  // A random host port on an EMPTY or variable IP is the same every-interface publish.
  assert.deepEqual(checkComposePortBinds('services:\n  app:\n    ports:\n      - "::80"\n').map((f) => [f.line, f.code]), [[4, "no-host-ip"]]);
  assert.deepEqual(checkComposePortBinds('services:\n  app:\n    ports:\n      - "${TAILSCALE_IP}::80"\n').map((f) => [f.line, f.code]), [[4, "no-default"]]);
  // A SPECIFIC address with a random port stays safe (loopback, or a set IP).
  assert.deepEqual(checkComposePortBinds('services:\n  app:\n    ports:\n      - "127.0.0.1::80"\n'), []);
  assert.deepEqual(checkComposePortBinds('services:\n  app:\n    ports:\n      - "[::1]::80"\n'), []);

  // Long syntax with no `published:` is the same random host port.
  assert.deepEqual(checkComposePortBinds("services:\n  app:\n    ports:\n      - target: 9000\n").map((f) => [f.line, f.code]), [[4, "no-host-ip"]]);
  assert.deepEqual(checkComposePortBinds("services:\n  app:\n    ports:\n      - { target: 9000 }\n").map((f) => [f.line, f.code]), [[4, "no-host-ip"]]);
  // …unless it names a specific address.
  assert.deepEqual(checkComposePortBinds("services:\n  app:\n    ports:\n      - target: 9000\n        host_ip: 127.0.0.1\n"), []);
});

test("red: a ports: shape the checker cannot read is a finding, never a skip", () => {
  const find = (text) => checkComposePortBinds(text).map((f) => [f.line, f.code, f.allowlisted]);
  // `ports: *anchor` publishes whatever the anchor holds: unreadable.
  assert.deepEqual(find("services:\n  app:\n    ports: *shared-ports\n"), [[3, "unreadable", false]]);
  // Any other inline scalar after `ports:` is not a shape we can read.
  assert.deepEqual(find("services:\n  app:\n    ports: ${APP_PORTS}\n"), [[3, "unreadable", false]]);
  // A short form with four colon-separated parts is not a mapping we can read.
  assert.deepEqual(
    checkComposePortBinds('services:\n  app:\n    ports:\n      - "1:2:3:4"\n').map((f) => [f.line, f.code]),
    [[4, "unreadable"]],
  );
  // …and an allowlist entry can never excuse an unreadable shape.
  const allowlisted = parsePortBindAllowlist("bundles/x/docker-compose.yml  80  # nope\n");
  assert.equal(
    checkComposePortBinds("services:\n  app:\n    ports: *shared-ports\n", { file: "bundles/x/docker-compose.yml", allowlist: allowlisted })[0].allowlisted,
    false,
  );
  // `ports: !override` is a Compose 2.24+ tag on the KEY: the list after it is
  // the real one and must still be read.
  assert.deepEqual(
    checkComposePortBinds('services:\n  app:\n    ports: !override\n      - "0.0.0.0:80:80"\n').map((f) => [f.line, f.code]),
    [[4, "wildcard"]],
  );
  assert.deepEqual(checkComposePortBinds('services:\n  app:\n    ports: !override\n      - "127.0.0.1:80:80"\n'), []);
  // Tagged flow form: an empty list publishes nothing.
  assert.deepEqual(checkComposePortBinds("services:\n  app:\n    ports: !reset []\n"), []);
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
    '      - "127.0.0.1::80"',
    '      - "${TAILSCALE_IP:-127.0.0.1}::8001"',
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
    "        host_ip: 127.0.0.1",
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

// ── the fix reaches installed copies ────────────────────────────────────────

/**
 * A version bump alone does NOT re-copy a docker bundle's compose file:
 * `refreshVersionedBundle` copies one only when the manifest opts in through
 * `refreshFiles` (servers/gateway/routes/bundles.js — a plain relative path
 * inside the bundle is accepted; `.env*`, `data`, `node_modules`, `.git` and
 * read-write bind mounts are not). Without this list the loopback defaults
 * would reach no installed copy until a reinstall.
 */
const COMPOSE_REFRESH = new Map([
  ["kokoro-tts", ["docker-compose.yml", "docker-compose.tailnet.yml"]],
  ["faster-whisper-server", ["docker-compose.yml", "docker-compose.tailnet.yml"]],
  ["llamacpp-vulkan-qwen36-35b-a3b", ["docker-compose.yml"]],
  ["vllm-cuda-embed", ["docker-compose.yml"]],
  ["vllm-cuda-vision", ["docker-compose.yml"]],
  ["vllm-cuda-rerank", ["docker-compose.yml"]],
  ["vllm-rocm-qwen35-4b", ["docker-compose.yml"]],
]);

test("the seven audited bundles refresh their compose file(s) on a version bump", () => {
  const problems = [];
  const registry = JSON.parse(readFileSync(join(ROOT, "registry", "add-ons.json"), "utf8"));
  const entries = registry["add-ons"] || [];
  for (const [id, files] of COMPOSE_REFRESH) {
    const manifest = JSON.parse(readFileSync(join(ROOT, "bundles", id, "manifest.json"), "utf8"));
    const listed = Array.isArray(manifest.refreshFiles) ? manifest.refreshFiles : [];
    const entry = entries.find((e) => e.id === id);
    if (!entry) problems.push(`registry/add-ons.json: no entry for ${id}`);
    for (const file of files) {
      if (!listed.includes(file)) problems.push(`bundles/${id}/manifest.json: refreshFiles is missing ${file}`);
      // A refresh of a file the bundle does not ship is a silent no-op.
      if (!existsSync(join(ROOT, "bundles", id, file))) problems.push(`bundles/${id}/${file}: declared in refreshFiles but not shipped`);
      // The committed registry mirrors every manifest field (build-registry
      // spreads the manifest through), so it must carry this list too.
      if (entry && !(Array.isArray(entry.refreshFiles) ? entry.refreshFiles : []).includes(file)) {
        problems.push(`registry/add-ons.json: ${id} is missing ${file} in refreshFiles`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});