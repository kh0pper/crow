/**
 * Read-only helpers over pi's agent directory (settings.json and
 * agents/<name>.md). A leaf: node built-ins only, so both the consumer scan
 * and the role seed can use it without pulling in each other's graphs.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** A trimmed non-empty string, else null. */
export const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/** Minimal frontmatter parse: the leading `---` block, `key: value` lines. */
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** name -> frontmatter `model:` of every agents/*.md that declares one. */
export function agentModels(piAgentDir) {
  const dir = join(piAgentDir, "agents");
  const out = {};
  let names = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { return out; }
  for (const f of names) {
    let fm;
    try { fm = frontmatter(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    const model = str(fm.model);
    if (model) out[f.slice(0, -3)] = model;
  }
  return out;
}

const AGENT_NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * The model pi runs sub-agent `name` on: settings.json
 * `subagent.modelOverrides[name]`, else agents/<name>.md frontmatter
 * `model:`, else null. Never throws.
 */
export function effectiveAgentModel(piAgentDir, name) {
  if (!piAgentDir || typeof name !== "string" || !AGENT_NAME_RE.test(name)) return null;
  const st = readJsonFile(join(piAgentDir, "settings.json"));
  const override = str(st?.subagent?.modelOverrides?.[name]);
  if (override) return override;
  try {
    return str(frontmatter(readFileSync(join(piAgentDir, "agents", name + ".md"), "utf8")).model);
  } catch {
    return null;
  }
}
