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
  const s = String(text || "");
  const numeric = findings.filter((f) => typeof f.index === "number" && typeof f.length === "number");
  if (numeric.length === 0) return s;

  // Coalesce overlapping/adjacent spans BEFORE replacing (review round 1,
  // CRITICAL 1). Two findings can legitimately overlap — e.g. an SSN-shaped
  // rule matching a substring inside a longer slack-token match — and
  // replacing them independently corrupts offsets: the inner replacement
  // shifts the string, so the outer span's stale end index slices the wrong
  // place and raw secret bytes survive in the "redacted" output. Merging
  // first means every replacement below operates on a set of disjoint spans,
  // so replacing from the end (descending start) never invalidates an
  // index computed for a span still to be processed.
  const sorted = [...numeric].sort((a, b) => a.index - b.index);
  const merged = [];
  for (const f of sorted) {
    const start = f.index;
    const end = f.index + f.length;
    const last = merged[merged.length - 1];
    if (last && start <= last.end) {
      if (end > last.end) last.end = end;
      if (!last.names.includes(f.name)) last.names.push(f.name);
    } else {
      merged.push({ start, end, names: [f.name] });
    }
  }

  let out = s;
  for (const span of [...merged].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, span.start) + `[REDACTED:${span.names.join("+")}]` + out.slice(span.end);
  }
  return out;
}
