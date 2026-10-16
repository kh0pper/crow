// Design kit renderer — short errors (spec §3.3, §6). The engine's message can
// quote the spec, which may hold text from outside the owner's Crow; only a
// fixed category and a line number ever leave the container.
const CATEGORIES = [
  [/parse error|syntax error|unexpected|lexical error|expecting/i, "parse error"],
  [/no diagram type|unknown diagram|unsupported|not supported/i, "unsupported diagram type"],
  [/invalid|schema|must be|is not a valid|unrecognized|missing/i, "invalid spec"],
];
export function shortError(_engine, e) {
  if (e && e.crowTimeout) return { code: "render_failed", category: "timeout", line: null };
  const text = String((e && e.message) || "").slice(0, 2000);
  let category = "render error";
  for (const [re, c] of CATEGORIES) if (re.test(text)) { category = c; break; }
  const m = /line (\d{1,6})/i.exec(text) || /:(\d{1,6}):\d{1,6}/.exec(text);
  return { code: "render_failed", category, line: m ? Number(m[1]) : null };
}
