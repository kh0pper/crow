import { readFileSync, writeFileSync, existsSync, copyFileSync, statSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = resolve(__dirname, "../..");

export function resolveEnvPath() {
  const crowEnv = join(homedir(), ".crow", ".env");
  if (existsSync(crowEnv)) return crowEnv;
  return join(APP_ROOT, ".env");
}

export function readEnvFile(envPath) {
  if (!existsSync(envPath)) {
    return { lines: [], vars: new Map() };
  }
  const content = readFileSync(envPath, "utf-8");
  const lines = content.split("\n");
  const vars = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    const key = line.substring(0, eqIndex).trim();
    let value = line.substring(eqIndex + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars.set(key, { lineIndex: i, value });
  }

  return { lines, vars };
}

export function sanitizeEnvValue(value) {
  if (typeof value !== "string") return String(value);
  return value.replace(/[\r\n\0]/g, "");
}

function createBackup(envPath) {
  if (!existsSync(envPath)) return;
  const bakPath = envPath + ".bak";
  if (existsSync(bakPath)) {
    const envStat = statSync(envPath);
    const bakStat = statSync(bakPath);
    if (bakStat.mtimeMs >= envStat.mtimeMs) return;
  }
  copyFileSync(envPath, bakPath);
}

export function writeEnvVar(envPath, key, value) {
  createBackup(envPath);

  if (value === "" || value === null || value === undefined) {
    return removeEnvVar(envPath, key);
  }

  const sanitized = sanitizeEnvValue(value);
  const { lines, vars } = readEnvFile(envPath);
  const newLine = `${key}=${sanitized}`;

  if (vars.has(key)) {
    lines[vars.get(key).lineIndex] = newLine;
  } else {
    lines.push(newLine);
  }

  writeFileSync(envPath, lines.join("\n"));
}

export function removeEnvVar(envPath, key) {
  createBackup(envPath);

  const { lines, vars } = readEnvFile(envPath);
  if (!vars.has(key)) return;

  const idx = vars.get(key).lineIndex;
  lines[idx] = `# ${lines[idx]}`;

  writeFileSync(envPath, lines.join("\n"));
}
