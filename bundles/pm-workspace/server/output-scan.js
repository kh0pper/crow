// Deterministic secret/PII scan over bot output. Pure functions; the rules
// file is operator-supplied (PM_SCAN_RULES_FILE) and never ships in the repo.
import { readFileSync, statSync } from "node:fs";

export function loadRules(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const list = Array.isArray(raw) ? raw : raw.rules || [];
  return list.map((r) => ({
    name: String(r.name),
    severity: r.severity || "secret",
    pattern: new RegExp(r.pattern, r.flags || "g"),
  }));
}

export function scanText(text, rules) {
  const findings = [];
  const s = String(text || "");
  for (const r of rules) {
    r.pattern.lastIndex = 0;
    let m;
    while ((m = r.pattern.exec(s)) !== null) {
      findings.push({ name: r.name, severity: r.severity, index: m.index, length: m[0].length });
      if (m.index === r.pattern.lastIndex) r.pattern.lastIndex++;
    }
  }
  return findings.sort((a, b) => a.index - b.index);
}

const MAX_SCAN_BYTES = 5 * 1024 * 1024;

export function scanFiles(paths, rules) {
  const out = {};
  for (const p of paths) {
    try {
      if (statSync(p).size > MAX_SCAN_BYTES) {
        // Fail closed: an unscannable file counts as a finding, never a pass.
        out[p] = [{ name: "unscannable-large", severity: "error" }];
        continue;
      }
      out[p] = scanText(readFileSync(p, "utf8"), rules);
    }
    catch (e) { out[p] = [{ name: "unreadable", severity: "error", error: String(e.message || e) }]; }
  }
  return out;
}

export function redact(text, findings) {
  let s = String(text || "");
  // Replace from the end so earlier indexes stay valid.
  for (const f of [...findings].sort((a, b) => b.index - a.index)) {
    if (typeof f.index !== "number") continue;
    s = s.slice(0, f.index) + `[REDACTED:${f.name}]` + s.slice(f.index + f.length);
  }
  return s;
}
