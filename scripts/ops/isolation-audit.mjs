#!/usr/bin/env node
/**
 * isolation-audit — read-only report of where a Crow host still exposes
 * secrets or cross-instance access (queue item 19, migration steps 0-1).
 *
 * Prints NAMES, paths, modes and booleans. It never prints a value and never
 * reads a secret's contents.
 *
 *   node scripts/ops/isolation-audit.mjs [--json] [--sensitive <path>]... [--check <path>]...
 *
 *   --sensitive <path>  a path this process should NOT be able to open
 *                       (another instance's home, a key dir). Defaults: the
 *                       other ~/.crow* homes next to this instance's, ~/.ssh,
 *                       ~/.gnupg.
 *   --check <path>      report the mode/owner of an operator file (e.g. a file
 *                       that may hold a credential) and whether it is group-
 *                       or world-accessible.
 *
 * Run it as the unit you are hardening to see that unit's view, e.g.
 *   systemd-run --pipe --wait -p User=<user> -p PrivateUsers=yes ... node scripts/ops/isolation-audit.mjs
 * Exit status is always 0: this is a report, not a gate.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolationReport, formatIsolationLine, secretEnvNames } from "../../servers/shared/isolation-check.js";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function defaultSystemctl(args) {
  const r = spawnSync("systemctl", args, { encoding: "utf8", timeout: 15000 });
  return r.status === 0 ? r.stdout : "";
}

function modeInfo(path) {
  try {
    const st = statSync(path);
    const mode = st.mode & 0o777;
    return { path, exists: true, mode: "0" + mode.toString(8), uid: st.uid, groupOrWorld: (mode & 0o077) !== 0 };
  } catch {
    return { path, exists: false };
  }
}

/** Crow units (gateway or bot runner) and what their definitions expose. */
export function auditUnits({ systemctl = defaultSystemctl, appRoot = APP_ROOT } = {}) {
  const list = systemctl(["list-units", "--type=service", "--all", "--plain", "--no-legend", "--no-pager"]);
  const units = list.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((u) => u && u.endsWith(".service"));
  const out = [];
  for (const unit of units) {
    const show = systemctl(["show", unit, "-p", "ExecStart", "-p", "WorkingDirectory", "-p", "FragmentPath", "-p", "DropInPaths", "-p", "EnvironmentFiles", "-p", "User"]);
    const prop = (k) => ((show.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1] || "").trim();
    const exec = prop("ExecStart");
    const isCrow = /servers\/gateway\/index\.js|gateways\/gateway_runner\.mjs/.test(exec) || prop("WorkingDirectory") === appRoot;
    if (!isCrow) continue;
    const envOut = systemctl(["show", unit, "-p", "Environment", "--value"]);
    const envFiles = [...prop("EnvironmentFiles").matchAll(/(\/\S+)\s+\(ignore_errors=/g)].map((m) => m[1]);
    const files = [prop("FragmentPath"), ...prop("DropInPaths").split(/\s+/)].filter(Boolean);
    out.push({
      unit,
      user: prop("User") || "root",
      secretLikeEnvironment: secretEnvNames(envOut),
      environmentFiles: envFiles.map(modeInfo),
      unitFiles: files.map(modeInfo),
    });
  }
  return out;
}

function looksLikeInstanceHome(p) {
  try { if (!statSync(p).isDirectory()) return false; } catch { return false; }
  for (const marker of ["installed.json", "mcp-addons.json", "data"]) {
    try { statSync(join(p, marker)); return true; } catch {}
  }
  return false;
}

/** Default sensitive paths: the other ~/.crow* homes, ~/.ssh, ~/.gnupg. */
export function defaultSensitivePaths({ home = homedir(), crowHome = process.env.CROW_HOME || join(homedir(), ".crow") } = {}) {
  const own = resolve(crowHome);
  const parent = dirname(own);
  const paths = [];
  try {
    for (const e of readdirSync(parent)) {
      const p = join(parent, e);
      // An instance home, not any dir that starts with .crow (backups, flags).
      if (/^\.crow(-|$)/.test(e) && p !== own && looksLikeInstanceHome(p)) paths.push(p);
    }
  } catch {}
  for (const d of [".ssh", ".gnupg"]) paths.push(join(home, d));
  return [...new Set(paths)];
}

/** The instance's own secret files: mode and owner only. */
export function auditInstanceFiles({ crowHome = process.env.CROW_HOME || join(homedir(), ".crow"),
  dataDir = process.env.CROW_DATA_DIR || join(crowHome, "data"), appEnv = process.env.CROW_APP_ENV_PATH || join(APP_ROOT, ".env") } = {}) {
  const paths = [appEnv, join(dataDir, "identity.json"), join(crowHome, "secrets"), join(crowHome, "peer-tokens.json"), join(crowHome, "env")];
  try {
    for (const e of readdirSync(crowHome)) if (/-token$/.test(e)) paths.push(join(crowHome, e));
  } catch {}
  return paths.map(modeInfo).filter((m) => m.exists);
}

export function runAudit({ sensitive = [], check = [], systemctl } = {}) {
  const sensitivePaths = sensitive.length ? sensitive : defaultSensitivePaths();
  const report = isolationReport({ sensitivePaths });
  return {
    process: { line: formatIsolationLine(report), ...report },
    units: auditUnits({ systemctl }),
    instanceFiles: auditInstanceFiles(),
    checked: check.map(modeInfo),
  };
}

function parseArgs(argv) {
  const o = { json: false, sensitive: [], check: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--sensitive" && argv[i + 1]) o.sensitive.push(resolve(argv[++i]));
    else if (a === "--check" && argv[i + 1]) o.check.push(resolve(argv[++i]));
  }
  return o;
}

if (process.argv[1] && basename(process.argv[1]) === "isolation-audit.mjs") {
  const o = parseArgs(process.argv.slice(2));
  const r = runAudit(o);
  if (o.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(r.process.line);
    for (const u of r.units) {
      console.log(`unit ${u.unit} (User=${u.user})`);
      if (u.secretLikeEnvironment.length) console.log(`  secret-like Environment= names (readable by any local user): ${u.secretLikeEnvironment.join(", ")}`);
      for (const f of u.environmentFiles) if (f.exists && f.groupOrWorld) console.log(`  EnvironmentFile ${f.path} is ${f.mode} (group/world bits)`);
    }
    for (const f of r.instanceFiles) if (f.groupOrWorld) console.log(`instance file ${f.path} is ${f.mode} (group/world bits)`);
    for (const f of r.checked) console.log(`check ${f.path}: ${f.exists ? f.mode + (f.groupOrWorld ? " (group/world bits)" : "") : "absent"}`);
  }
}
