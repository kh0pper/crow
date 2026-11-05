/**
 * compose-garage-default.test.js — the root docker-compose.yml's object storage.
 *
 * Operator ruling 2026-11-05: Garage is the default object storage, started by
 * `--profile storage`; MinIO moves to `--profile minio-legacy` (same volume, same
 * pin, so an existing deployment keeps running) because MinIO's public images
 * are no longer published. This file owns the *shape* of that decision:
 *
 *  - `storage` is garage, `minio-legacy` is minio — and nothing else;
 *  - Garage's S3 API (3900) and RPC (3901) are never published to the host, only
 *    the admin API (3903) on loopback;
 *  - **the gateway never receives a Garage secret.** Garage reads its five GARAGE_*
 *    values from its own `.env.garage` (its `env_file:`), and `.env` — the file the
 *    gateway loads — carries the S3 key pair in S3_* and nothing else. Garage's admin
 *    token and RPC secret are cluster credentials: the same rule the File Storage
 *    (Garage) extension follows ("the gateway gets S3_* only", tests/garage-bundle.test.js).
 *    No service interpolates `${GARAGE_…}`, so no Garage secret can arrive through `.env`;
 *  - the compose hardcodes no credentials (never a value, never a `${VAR:?}` that an
 *    unrelated profile would have to satisfy) and Garage's own key pair is the same pair
 *    the gateway gets as S3_ACCESS_KEY / S3_SECRET_KEY;
 *  - the image is the bundle's digest-pinned Garage, so the compose profile and
 *    an Extensions install can never drift onto different Garage builds.
 *
 * tests/compose-image-pins.test.js still owns "pinned at all"; this file owns
 * "pinned to THIS".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scanCompose } from "../scripts/check-port-allocation.js";

const ROOT = join(import.meta.dirname, "..");
const COMPOSE = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
const BUNDLE_COMPOSE = readFileSync(join(ROOT, "bundles", "garage", "docker-compose.yml"), "utf8");
const DIGEST = "sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020";

/**
 * The body of every top-level service in a compose file, keyed by service name.
 * A service's body keeps its original indentation (that is what the port and
 * image matchers below expect).
 */
function services(text) {
  const out = new Map();
  let inServices = false;
  let childIndent = -1;
  let current = null;
  // Blank and comment lines between two services describe the NEXT one, so they
  // are held back: a service body must not inherit its neighbour's prose.
  let pending = [];
  const flush = () => {
    if (current) out.get(current).push(...pending);
    pending = [];
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      pending.push(line);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      pending = [];
      inServices = /^services:\s*(?:#.*)?$/.test(line);
      current = null;
      continue;
    }
    if (!inServices) { pending = []; continue; }
    if (childIndent < 0) childIndent = indent;
    if (indent === childIndent) {
      const key = /^\s*["']?([\w.-]+)["']?:\s*(?:#.*)?$/.exec(line);
      if (key) {
        pending = [];
        current = key[1];
        out.set(current, []);
        continue;
      }
    }
    flush();
    if (current) out.get(current).push(line);
  }
  return new Map([...out].map(([name, lines]) => [name, lines.join("\n")]));
}

const SERVICES = services(COMPOSE);
const garage = () => {
  assert.ok(SERVICES.has("garage"), "the root compose has a garage service");
  return SERVICES.get("garage");
};
const minio = () => {
  assert.ok(SERVICES.has("minio"), "the root compose keeps a minio service");
  return SERVICES.get("minio");
};

const profilesOf = (block) => {
  const m = /^\s*profiles:\s*\[([^\]]*)\]\s*$/m.exec(block);
  assert.ok(m, "the service declares a profiles list");
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
};

/** The env file paths a service's `env_file:` declares — long form (`- path: x`) or short. */
function envFilePaths(block) {
  const paths = [];
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*env_file:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const inline = m[1].replace(/\s+#.*$/, "").trim();
    if (inline) {
      for (const part of inline.replace(/^\[/, "").replace(/\]$/, "").split(",")) {
        paths.push(part.trim().replace(/^["']|["']$/g, ""));
      }
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s*-\s+(.+)$/.exec(lines[j]);
      if (!item) break;
      const raw = item[1].replace(/\s+#.*$/, "").trim();
      paths.push((/^path:\s*(.+)$/.exec(raw)?.[1] ?? raw).trim().replace(/^["']|["']$/g, ""));
    }
  }
  return paths;
}

/** Comment lines stripped: prose may NAME a variable without consuming it. */
const codeLines = (block) => block.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

const GARAGE_SECRETS = [
  "GARAGE_RPC_SECRET", "GARAGE_ADMIN_TOKEN", "GARAGE_METRICS_TOKEN",
  "GARAGE_DEFAULT_ACCESS_KEY", "GARAGE_DEFAULT_SECRET_KEY",
];

// ── profiles ──

test("`--profile storage` starts Garage, and only Garage", () => {
  assert.deepEqual(profilesOf(garage()), ["storage"]);
  assert.equal(/^\s*minio:\s*$/m.test(COMPOSE) && profilesOf(minio()).includes("storage"), false,
    "minio must not be under the storage profile any more");
  // Garage is the ONLY service the storage profile starts.
  for (const [name, block] of SERVICES) {
    if (name === "garage") continue;
    assert.ok(!profilesOf(block).includes("storage"), `${name} must not join the storage profile`);
  }
});

test("MinIO moved to `--profile minio-legacy`, unchanged: same image pin, same volume", () => {
  assert.deepEqual(profilesOf(minio()), ["minio-legacy"]);
  assert.match(minio(), /image:\s*minio\/minio:RELEASE\.2025-09-07T16-13-09Z\s*$/m);
  assert.match(minio(), /^\s*-\s*minio-data:\/data\s*$/m, "the existing volume is reused, so no data change");
  assert.match(minio(), /command:\s*server \/data --console-address ":9001"/);
  assert.match(COMPOSE, /^volumes:\n(?:.*\n)*?\s+minio-data:/m, "the minio-data volume stays declared");
});

test("the minio service says why it is legacy-only and points new installs at Garage", () => {
  const block = minio();
  assert.match(block, /existing deployments only/i);
  assert.match(block, /no longer published/i, "the reason the image cannot be pulled");
  assert.match(block, /--profile storage/, "says what new deployments use instead");
});

// ── ports ──

test("garage publishes no S3 API (3900) and no RPC (3901) to the host", () => {
  const block = garage();
  const published = scanCompose(block).mappings.map((m) => m.port);
  assert.deepEqual(published, [3903], "only the admin API is published");
  assert.match(block, /expose:\s*\n\s*-\s*"3900"/, "3900 is exposed to the compose network, not published");
  // Prose may name the RPC port; no ports/expose ENTRY may.
  assert.doesNotMatch(block, /^\s*-\s*"?[\d.\[\]:${}-]*3901/, "the RPC port is neither published nor exposed");
});

test("garage publishes the admin API on loopback only", () => {
  const mappings = scanCompose(garage()).mappings;
  assert.deepEqual(mappings, [{ service: null, ip: "127.0.0.1", port: 3903 }]);
});

// ── no Garage secret reaches the gateway ──

test("garage reads its five secrets from .env.garage, and interpolates none of them", () => {
  const block = garage();
  assert.deepEqual(envFilePaths(block), [".env.garage"],
    "Garage's own env file — not .env, which the gateway loads");
  assert.match(block, /^\s*env_file:\s*\n\s*-\s*path:\s*\.env\.garage\s*\n\s*required:\s*true\s*$/m,
    "declared required: a missing .env.garage is an error, not a Garage with no secrets");
  assert.doesNotMatch(codeLines(block), /\$\{?GARAGE_/,
    "no GARAGE_* interpolation either — that would read the value from .env");
  // Nothing else in the service carries a literal secret-shaped value.
  for (const [key, value] of [...block.matchAll(/^\s+([A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Z0-9_]*):\s*(.+?)\s*$/gm)].map((m) => [m[1], m[2]])) {
    assert.ok(value.startsWith('"${'), `${key} is not hardcoded`);
  }
});

test("no service except garage sees a GARAGE_* value: the gateway gets an S3 key, never the admin token", () => {
  const gw = SERVICES.get("crow-gateway");
  assert.ok(gw, "the gateway service is still there");
  assert.deepEqual(envFilePaths(gw), [".env"], "the gateway loads .env, not Garage's file");
  for (const [name, block] of SERVICES) {
    if (name === "garage") continue;
    assert.ok(!envFilePaths(block).includes(".env.garage"), `${name} must not load .env.garage`);
    assert.doesNotMatch(codeLines(block), /GARAGE_/, `${name} must not reference a Garage secret`);
  }
});

test(".env.example (the gateway's file) carries no Garage secret — only a pointer to .env.garage.example", () => {
  const example = readFileSync(join(ROOT, ".env.example"), "utf8");
  assert.doesNotMatch(example, /^\s*#?\s*(?:export\s+)?GARAGE_[A-Z0-9_]*=/m,
    "no GARAGE_* assignment line, commented out or not: .env must never hold one");
  assert.match(example, /\.env\.garage\.example/, "points at the Garage file instead");
  assert.match(example, /^# S3_ACCESS_KEY=/m, "the S3_* block stays (the gateway's own key)");
  assert.match(example, /^# S3_SECRET_KEY=/m);
});

test(".env.garage.example: the five keys, empty, each with its generating command and the S3_* copy note", () => {
  const text = readFileSync(join(ROOT, ".env.garage.example"), "utf8");
  for (const name of GARAGE_SECRETS) {
    assert.match(text, new RegExp(`^${name}=$`, "m"), `${name} is an empty key, never an example value`);
    assert.ok(text.includes(`echo "${name}=`), `${name} carries its generating command`);
  }
  assert.match(text, /GARAGE_DEFAULT_ACCESS_KEY=GK\$\(openssl rand -hex 12\)/, "key ID: GK + 24 hex");
  for (const name of ["GARAGE_RPC_SECRET", "GARAGE_ADMIN_TOKEN", "GARAGE_METRICS_TOKEN", "GARAGE_DEFAULT_SECRET_KEY"]) {
    assert.ok(text.includes(`echo "${name}=$(openssl rand -hex 32)"`), `${name} is 32 random bytes`);
  }
  assert.match(text, /S3_ACCESS_KEY/, "says the access key is copied into .env");
  assert.match(text, /S3_SECRET_KEY/, "says the secret key is copied into .env");
});

test(".gitignore lists .env.garage next to .env, so the secrets file is never committed", () => {
  const lines = readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n").map((l) => l.trim());
  assert.ok(lines.includes(".env.garage"), ".env.garage is ignored");
  assert.ok(lines.includes(".env"), ".env is still ignored");
});

test("no service with a profiles list uses ${VAR:?} — Compose interpolates inactive profiles too", () => {
  // `docker compose --profile cloud --profile minio-legacy config` failed with
  // "required variable GARAGE_DEFAULT_SECRET_KEY is missing a value" while Garage's
  // profile was OFF: Compose interpolates every service in the file before it filters
  // by profile. So a required `${VAR:?}` on a profiled service demands the values of
  // every other profile as well. These services keep `${VAR:-}` and fail at container
  // start instead (MinIO without a root password; Garage now reads its own .env.garage
  // through env_file and refuses to start without an RPC secret).
  // Comments are stripped first: prose may NAME the rejected form without using it.
  const code = (block) => block.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  for (const [name, block] of SERVICES) {
    if (!/^\s*profiles:\s*\[/m.test(block)) continue;
    const hit = /\$\{[A-Za-z_][A-Za-z0-9_]*:\?/.exec(code(block));
    assert.equal(hit, null,
      name + " has profiles:, so " + (hit?.[0] || "") + " would break every run of another profile");
  }
});

test("the gateway gets no hardcoded storage credentials (they come from .env)", () => {
  const gw = SERVICES.get("crow-gateway");
  assert.ok(gw, "the gateway service is still there");
  assert.doesNotMatch(gw, /S3_(ACCESS_KEY|SECRET_KEY)|MINIO_ROOT_PASSWORD/,
    "the gateway reads them from env_file: .env — never a literal in the compose");
});

// ── the garage service mirrors the bundle ──

test("garage pins the bundle's image + digest, command, healthcheck and config mount", () => {
  const bundleImage = /^\s*image:\s*(\S+)\s*$/m.exec(BUNDLE_COMPOSE)[1];
  assert.ok(bundleImage.endsWith(`@${DIGEST}`), "the bundle keeps its digest pin");
  assert.equal(/^\s*image:\s*(\S+)\s*$/m.exec(garage())[1], bundleImage, "same image, same digest");

  assert.match(garage(), /command:\s*\["\/garage", "server", "--single-node", "--default-access-key"\]/);
  assert.match(garage(), /test:\s*\["CMD", "\/garage", "health"\]/);
  assert.match(garage(), /\.\/bundles\/garage\/garage\.toml:\/etc\/garage\.toml:ro/,
    "the bundle's own rendered config, mounted read-only");
  assert.match(garage(), /garage-meta:\/var\/lib\/garage\/meta/);
  assert.match(garage(), /garage-data:\/var\/lib\/garage\/data/);
  assert.match(COMPOSE, /^volumes:\n(?:.*\n)*?\s+garage-meta:|^volumes:\n(?:.*\n)*?\s+garage-data:/m, "both volumes are declared");
});

test("the mounted garage.toml speaks plain Garage: S3 on 3900, region us-east-1, admin on 3903", () => {
  // The root compose cannot parameterise the toml, so the file it mounts has to
  // describe exactly the container the compose starts (no bundle-only settings).
  const toml = readFileSync(join(ROOT, "bundles", "garage", "garage.toml"), "utf8");
  assert.match(toml, /api_bind_addr = "\[::\]:3900"/);
  assert.match(toml, /s3_region = "us-east-1"/);
  assert.match(toml, /^\[admin\]\napi_bind_addr = "\[::\]:3903"/m);
  assert.match(toml, /metadata_dir = "\/var\/lib\/garage\/meta"/);
  assert.match(toml, /data_dir = "\/var\/lib\/garage\/data"/);
});

// ── the header tells the truth about the profiles ──

test("the header comments list the storage and minio-legacy profiles", () => {
  const header = COMPOSE.split("\nservices:")[0];
  assert.match(header, /--profile storage/);
  assert.match(header, /--profile minio-legacy/);
  assert.match(header, /minio-legacy\s+—\s+MinIO/);
});