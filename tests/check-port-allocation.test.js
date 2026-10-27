// scripts/check-port-allocation.js (CI static-checks): the host side of every
// compose publish, ${VAR:-N} / ${VAR-N} defaults included, must be unique and
// documented. Before 2026-10 the checker only matched literal digits, so every
// `${VAR:-N}` publish was invisible and four real clashes went unseen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  extractHostMappings,
  extractHostPorts,
  parsePortSpec,
  bindsOverlap,
  checkPortAllocation,
} from "../scripts/check-port-allocation.js";

const compose = (...portLines) => `services:\n  app:\n    image: x\n    ports:\n${portLines.map((l) => `      ${l}`).join("\n")}\n    restart: unless-stopped\n`;

test("${VAR:-N} and ${VAR-N} host ports count as their default", () => {
  assert.deepEqual(extractHostMappings(compose('- "127.0.0.1:${KOLIBRI_HTTP_PORT:-8085}:8080"')), [{ ip: "127.0.0.1", port: 8085 }]);
  assert.deepEqual(extractHostMappings(compose('- "127.0.0.1:${NOMINATIM_PORT-8088}:8080"')), [{ ip: "127.0.0.1", port: 8088 }]);
  assert.deepEqual(extractHostMappings(compose('- "${NTFY_PORT:-2586}:80"')), [{ ip: "", port: 2586 }]);
});

test("plain N, with and without a host IP, quoted or not, with a protocol", () => {
  assert.deepEqual(extractHostMappings(compose('- "8085:8080"')), [{ ip: "", port: 8085 }]);
  assert.deepEqual(extractHostMappings(compose("- 127.0.0.1:3020:3000")), [{ ip: "127.0.0.1", port: 3020 }]);
  assert.deepEqual(extractHostMappings(compose("- '0.0.0.0:443:443/udp'   # QUIC")), [{ ip: "0.0.0.0", port: 443 }]);
  assert.deepEqual(extractHostMappings(compose('- "127.0.0.1:5335:53/tcp"', '- "127.0.0.1:5335:53/udp"')), [{ ip: "127.0.0.1", port: 5335 }]);
});

test("host-IP variables: a default IP resolves, an IP with no default stays a named placeholder", () => {
  assert.deepEqual(extractHostMappings(compose('- "${MINIO_BIND_ADDR:-127.0.0.1}:9000:9000"')), [{ ip: "127.0.0.1", port: 9000 }]);
  assert.deepEqual(extractHostMappings(compose('- "${CROW_TAILSCALE_IP}:8004:8000"')), [{ ip: "$CROW_TAILSCALE_IP", port: 8004 }]);
  assert.deepEqual(
    extractHostMappings(compose('- "${FUNKWHALE_NGINX_BIND_ADDR:-127.0.0.1}:${FUNKWHALE_NGINX_BIND_PORT:-8600}:80"')),
    [{ ip: "127.0.0.1", port: 8600 }],
  );
  assert.deepEqual(extractHostMappings(compose('- "[::1]:8080:80"')), [{ ip: "::1", port: 8080 }]);
});

test("long syntax: published (literal or ${VAR:-N}) and host_ip", () => {
  const text = compose(
    "- target: 80",
    '  published: "${APP_PORT:-8099}"',
    "  host_ip: 127.0.0.1",
    "  protocol: tcp",
    "- target: 53",
    "  published: 5353",
    "- target: 9000",
    "- { target: 81, published: 8098, host_ip: 127.0.0.1 }",
  );
  assert.deepEqual(extractHostMappings(text), [
    { ip: "127.0.0.1", port: 8099 },
    { ip: "", port: 5353 },
    { ip: "127.0.0.1", port: 8098 },
  ]);
});

test("flow sequences and port ranges", () => {
  const flow = 'services:\n  a:\n    ports: ["127.0.0.1:${X_PORT:-8070}:80", "8071:81"]\n';
  assert.deepEqual(extractHostPorts(flow), [8070, 8071]);
  assert.deepEqual(extractHostPorts(compose('- "127.0.0.1:8000-8002:9000-9002"')), [8000, 8001, 8002]);
});

test("nothing published on a fixed host port is skipped", () => {
  assert.equal(parsePortSpec("8080"), null, "container-only");
  assert.equal(parsePortSpec("127.0.0.1::80"), null, "ephemeral host port");
  assert.equal(parsePortSpec("127.0.0.1:${APP_PORT}:80"), null, "variable with no default");
  assert.equal(parsePortSpec("${APP_PORT:?set it}:80"), null, "required variable");
});

test("only ports: sections count; volumes, environment and command lines that look like a:b do not", () => {
  const text = [
    "services:",
    "  app:",
    "    volumes:",
    "      - ${DATA:-./data}:/data",
    "      - /etc/localtime:/etc/localtime:ro",
    "    environment:",
    "      - URL=http://localhost:3040",
    "      - 1234:5678",
    "    ports:",
    "      # a comment inside the block",
    '      - "127.0.0.1:${P:-8077}:80"',
    "",
    "    command:",
    "      - 9999:9999",
    "  other:",
    "    ports:",
    "    - 8076:80", // list items at the key's own indent are valid YAML
    "    expose:",
    '      - "9000"',
  ].join("\n");
  assert.deepEqual(extractHostPorts(text), [8077, 8076]);
});

test("bindsOverlap: same address or a wildcard clashes, two specific addresses do not", () => {
  assert.equal(bindsOverlap("127.0.0.1", "127.0.0.1"), true);
  assert.equal(bindsOverlap("", "127.0.0.1"), true);
  assert.equal(bindsOverlap("0.0.0.0", "$CROW_TAILSCALE_IP"), true);
  assert.equal(bindsOverlap("$CROW_TAILSCALE_IP", "$CROW_TAILSCALE_IP"), true);
  assert.equal(bindsOverlap("127.0.0.1", "$CROW_TAILSCALE_IP"), false);
});

function fixtureTree({ bundles, doc, known = { _comment: "x" } }) {
  const root = mkdtempSync(join(tmpdir(), "port-check-"));
  const bundlesDir = join(root, "bundles");
  mkdirSync(bundlesDir);
  for (const [id, files] of Object.entries(bundles)) {
    mkdirSync(join(bundlesDir, id));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(bundlesDir, id, name), text);
  }
  writeFileSync(join(bundlesDir, "skill-history.json"), "{}"); // a plain file in bundles/ is ignored
  const docPath = join(root, "ports.md");
  writeFileSync(docPath, doc);
  const knownConflictsPath = join(root, "known.json");
  writeFileSync(knownConflictsPath, JSON.stringify(known));
  return { root, opts: { bundlesDir, docPath, knownConflictsPath } };
}

test("checkPortAllocation finds a clash and an undocumented port hidden behind ${VAR:-N} defaults", () => {
  const { root, opts } = fixtureTree({
    bundles: {
      miniflux: { "docker-compose.yml": compose('- "127.0.0.1:8085:8080"') },
      kolibri: { "docker-compose.yml": compose('- "127.0.0.1:${KOLIBRI_HTTP_PORT:-8085}:8080"') },
      ntfy: { "docker-compose.yml": compose('- "127.0.0.1:${NTFY_PORT-2586}:80"') },
    },
    doc: "| Port | Binding |\n|---|---|\n| 8085 | 127.0.0.1 |\n",
  });
  try {
    const r = checkPortAllocation(opts);
    assert.deepEqual(r.collisions, [{ port: 8085, bundles: ["kolibri", "miniflux"] }]);
    assert.deepEqual(r.undocumented, [{ port: 2586, bundles: ["ntfy"] }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkPortAllocation: different specific addresses share a port; overlays are read; allowlisted sets only warn", () => {
  const { root, opts } = fixtureTree({
    bundles: {
      whisper: {
        "docker-compose.yml": compose('- "127.0.0.1:8004:8000"'),
        "docker-compose.tailnet.yml": compose('- "127.0.0.1:8004:8000"', '- "${CROW_TAILSCALE_IP}:8004:8000"'),
      },
      embed: { "docker-compose.yml": compose('- "${CROW_TAILSCALE_IP}:8004:8000"') },
      voice: { "docker-compose.yml": compose('- "${CROW_TAILSCALE_IP}:8011:8000"') },
      a: { "docker-compose.yml": compose('- "9000:9000"') },
      b: { "docker-compose.yml": compose('- "127.0.0.1:9000:9000"') },
    },
    doc: "| 8004 | x |\n| 8011 | x |\n| 9000 | x |\n",
    known: { _comment: "x", 9000: ["b", "a"] },
  });
  try {
    const r = checkPortAllocation(opts);
    // the overlay's tailnet publish meets embed's on the same tailnet address
    assert.deepEqual(r.collisions, [{ port: 8004, bundles: ["embed", "whisper"] }]);
    assert.deepEqual(r.grandfathered, [{ port: 9000, bundles: ["a", "b"] }]);
    assert.deepEqual(r.undocumented, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repo's own bundles pass the check (what CI static-checks runs)", () => {
  const out = execFileSync(process.execPath, [new URL("../scripts/check-port-allocation.js", import.meta.url).pathname], { encoding: "utf8" });
  assert.match(out, /^OK: \d+ unique port\(s\)/);
});

test("importing the checker does not run it", () => {
  // The import at the top of this file would have exited the test process
  // (process.exit in main) if the CLI guard were missing.
  assert.equal(typeof checkPortAllocation, "function");
});
