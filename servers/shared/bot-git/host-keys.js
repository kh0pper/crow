/**
 * Per-bot git access: the host keys a bot's git-over-ssh trusts, and the
 * parsing/validation of everything that reaches known_hosts.
 *
 * A bot's key dir carries a generated `known_hosts` made of exactly two parts:
 * the pinned GitHub lines below, and the lines the owner confirmed for other
 * hosts through the dashboard. Nothing else is trusted, and a bot can write
 * neither part (the secrets dir is a read-only tmpfs inside its sandbox): a bot
 * that could edit its own trusted host list could MITM itself.
 *
 * Two rules keep the file honest:
 *   - Every line is RE-SERIALISED from parsed parts (`parseKeyLine`), never
 *     copied. A line with extra fields, a comment, a wildcard, a hashed host,
 *     a marker (`@cert-authority`, `@revoked`) or several hosts never reaches
 *     the file, so a pasted `@cert-authority` or `*` line cannot widen the set.
 *   - A confirmed line naming a pinned host is dropped: OpenSSH accepts a
 *     connection when the server's key matches ANY entry for that host, so an
 *     extra `github.com` line would defeat the pin.
 *
 * Pinned host names: `github.com` only, port 22. `ssh.github.com` on port 443
 * is out of scope for this version.
 */
import { createHash } from "node:crypto";

/** The one host whose keys are pinned here. */
export const GITHUB_HOST = "github.com";

/**
 * GitHub's published ssh host keys, copied from the meta endpoint.
 *
 * Source: https://api.github.com/meta, field `ssh_keys`, fetched 2026-11-12;
 * the three lines below are verbatim from that response. Cross-checked against
 * the same response's `ssh_key_fingerprints` field and GitHub's "SSH key
 * fingerprints" docs page. `tests/bot-git-host-keys.test.js` recomputes each
 * fingerprint from the key below and refuses a mismatch — a pasted key must
 * never be trusted on its own.
 */
export const GITHUB_HOST_KEYS = Object.freeze([
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
]);

/**
 * The fingerprints GitHub publishes for those keys, per key type, as
 * `SHA256:` + base64 of the key blob's sha256 with `=` padding stripped.
 * Kept beside the keys so the pin test can compare two independent sources.
 */
export const GITHUB_FINGERPRINTS = Object.freeze({
  "ssh-ed25519": "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
  "ecdsa-sha2-nistp256": "SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
  "ssh-rsa": "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
});

/** Key types a known_hosts line may carry (v1: no `ssh-dss`, no sk-* keys). */
export const ALLOWED_KEY_TYPES = Object.freeze([
  "ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa",
]);
const KEY_TYPES = new Set(ALLOWED_KEY_TYPES);

/** One DNS label, or a dotted quad below: the shapes a host field may take. */
const HOSTNAME_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Base64, optionally padded (ssh writes it padded). */
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
/**
 * A label that is a NUMBER in some base the C library's resolver accepts
 * (decimal, octal with a leading 0, or 0x-prefixed hex), or — the wider net —
 * any label made only of hex digits. `inet_aton` reads `0x7f.0.0.1`,
 * `0177.0.0.1` and `127.1` as 127.0.0.1, so a host made only of such labels is
 * treated as an ADDRESS below, never as a host name.
 *
 * FAIR WARNING: that rule also refuses a real host name whose labels happen to
 * be all hex — `cafe.de`, `abc`, `beef.example`. It is deliberate and it fails
 * closed: the resolver could read those labels as an address, so a host that
 * ambiguous is never confirmed (and never reaches a known_hosts line). A name
 * with one non-hex label (`abc.example`, `git.cafe.de`) is unaffected.
 */
const NUMERIC_LABEL_RE = /^(?:0x[0-9a-f]+|[0-9a-f]+)$/;

/** `SHA256:…` of a public key's base64 blob (OpenSSH's own spelling). */
export function fingerprintOf(keyB64) {
  const blob = Buffer.from(String(keyB64 == null ? "" : keyB64), "base64");
  return "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}

/** A 4-octet dotted quad, each octet 0-255, no leading zeros; else null. */
function ipv4(s) {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
    if (Number(part) > 255) return null;
  }
  return s;
}

/**
 * Syntax only: a dotted quad or dot-separated host name labels; lower-case.
 *
 * A label starting with `0x`/`0X`, and any host whose labels are ALL
 * numeric-or-hex, is an address as far as the resolver is concerned (glibc's
 * `inet_aton` accepts hex/octal/short forms), so it must be a strict dotted
 * quad — each octet 0-255, no leading zeros — before hostRefused() ever looks
 * at 127/0.0.0.0. Without this, `0x7f.0.0.1` passed as a host-name label and
 * resolved to 127.0.0.1, bypassing the loopback refusal. The cost is the
 * all-hex real host name (`cafe.de`, `abc`): read as an address, not a dotted
 * quad, and so refused — deliberately, and fail closed.
 * (Resolve-then-pin was considered and not taken: a confirmed host is
 * owner-only input and the LAN is allowed by design.)
 */
function parseHostSyntax(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 253) return null;
  const host = raw.toLowerCase();
  const labels = host.split(".");
  const hexPrefixed = labels.some((label) => label.startsWith("0x"));
  const allNumeric = labels.every((label) => NUMERIC_LABEL_RE.test(label));
  if (hexPrefixed || allNumeric) return ipv4(host);
  for (const label of labels) if (!HOSTNAME_LABEL_RE.test(label)) return null;
  return host;
}

/** True for hosts no owner may confirm: localhost and its aliases, the
 * unspecified address, our own loopback range, and anything GitHub serves
 * (only the pinned keys are used for those). */
function hostRefused(host) {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0") return true;
  if (/^127\./.test(host)) return true;
  if (host === GITHUB_HOST || host.endsWith("." + GITHUB_HOST)) return true;
  return false;
}

/** `[host]:port` for a non-default port, `host` otherwise. */
export function knownHostsName({ host, port = 22 } = {}) {
  const h = String(host == null ? "" : host).toLowerCase();
  const p = Number(port);
  return p === 22 ? h : "[" + h + "]:" + p;
}

/**
 * A normalised host the owner may confirm: `{ host, port }`, or null.
 * Accepts `host`, `host:port` and an IPv4 dotted quad (v1 has no IPv6);
 * refuses a leading `-` (an ssh option in disguise), localhost/127.0.0.0/8,
 * 0.0.0.0, `::1`, and `github.com` / anything under it (pinned only).
 */
export function normalizeHost(input) {
  if (typeof input !== "string") return null;
  const raw = input.trim().toLowerCase();
  if (!raw || raw.length > 260 || raw.startsWith("-")) return null;
  if (raw.startsWith("[") || raw.includes("::")) return null;   // IPv6: v1 refuses it
  let hostPart = raw;
  let port = 22;
  const withPort = /^([^:]+):([1-9][0-9]{0,4})$/.exec(raw);
  if (withPort) {
    hostPart = withPort[1];
    port = Number(withPort[2]);
    if (port > 65535) return null;
  } else if (raw.includes(":")) {
    return null;
  }
  if (hostPart.startsWith("-")) return null;
  const host = parseHostSyntax(hostPart);
  if (!host || hostRefused(host)) return null;
  return { host, port };
}

/** The type string a key blob starts with (its first SSH string field). */
function blobTypeMatches(blob, type) {
  if (blob.length < 4 + type.length) return false;
  if (blob.readUInt32BE(0) !== type.length) return false;
  return blob.subarray(4, 4 + type.length).toString("latin1") === type;
}

/** The host field of a known_hosts line: `host`, or `[host]:port`. */
function parseHostField(field) {
  if (field.startsWith("[")) {
    const m = /^\[([^\]]+)\]:([1-9][0-9]{0,4})$/.exec(field);
    if (!m) return null;
    const port = Number(m[2]);
    if (port > 65535) return null;
    const host = parseHostSyntax(m[1]);
    return host ? { host, port } : null;
  }
  const host = parseHostSyntax(field);
  return host ? { host, port: 22 } : null;
}

/**
 * One `known_hosts` line → `{ host, port, type, key }`, or null.
 *
 * Exactly three whitespace-separated fields (`host type key`): a fourth field
 * would be a comment, and lines are rebuilt from these parts, never copied.
 * Refuses hashed hosts (`|1|…`), markers (`@cert-authority`, `@revoked`, any
 * `@…`), wildcard/negation/alternation shapes (`*`, `?`, `!`, `,`), unknown key
 * types, key material that is not base64, and a blob that does not start with
 * the type it claims.
 */
export function parseKeyLine(line) {
  if (typeof line !== "string") return null;
  const text = line.trim();
  if (!text || text.startsWith("#")) return null;
  const fields = text.split(/\s+/);
  if (fields.length !== 3) return null;
  const [hostField, type, key] = fields;
  if (hostField.startsWith("@") || hostField.startsWith("|")) return null;
  if (/[*?!,]/.test(hostField)) return null;
  const host = parseHostField(hostField);
  if (!host) return null;
  if (!KEY_TYPES.has(type)) return null;
  if (!B64_RE.test(key)) return null;
  const blob = Buffer.from(key, "base64");
  if (!blobTypeMatches(blob, type)) return null;
  return { host: host.host, port: host.port, type, key };
}

function toLines(input) {
  if (typeof input === "string") return input.split(/\r?\n/);
  if (Array.isArray(input)) return input;
  return [];
}

/**
 * The `known_hosts` text a bot's git uses: GitHub's pinned lines, then every
 * owner-confirmed line re-serialised from `parseKeyLine`.
 *
 * A confirmed line that does not parse, or that names a pinned host or a host
 * no owner could confirm, is dropped rather than trusted; duplicates collapse
 * so a repeated confirm cannot make the file grow.
 */
export function buildKnownHosts(confirmedLines = []) {
  const out = [];
  const seen = new Set();
  const push = (line) => {
    if (seen.has(line)) return;
    seen.add(line);
    out.push(line);
  };
  for (const pinned of GITHUB_HOST_KEYS) {
    const parsed = parseKeyLine(GITHUB_HOST + " " + pinned);
    if (parsed) push(GITHUB_HOST + " " + parsed.type + " " + parsed.key);
  }
  for (const raw of toLines(confirmedLines)) {
    const parsed = parseKeyLine(raw);
    if (!parsed) continue;
    if (hostRefused(parsed.host)) continue;
    push(knownHostsName(parsed) + " " + parsed.type + " " + parsed.key);
  }
  return out.length ? out.join("\n") + "\n" : "";
}

/**
 * `ssh-keyscan -p <port> <host>` output → `[{ type, key, fingerprint }]` for
 * the lines about that host (as `known_hosts` spells it), deduplicated. The
 * `#` banner/comment lines and any other host's lines are ignored, and each
 * line goes through `parseKeyLine`, so a scan result cannot smuggle a marker
 * or a wildcard into a confirm prompt.
 */
export function parseKeyscan(stdout, { host, port = 22 } = {}) {
  if (typeof stdout !== "string") return [];
  const want = knownHostsName({ host, port });
  const out = [];
  const seen = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const parsed = parseKeyLine(line);
    if (!parsed) continue;
    if (knownHostsName(parsed) !== want) continue;
    const id = parsed.type + " " + parsed.key;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ type: parsed.type, key: parsed.key, fingerprint: fingerprintOf(parsed.key) });
  }
  return out;
}