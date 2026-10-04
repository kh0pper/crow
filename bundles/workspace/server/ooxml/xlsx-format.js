/** Display formatting for common number formats (spec §4.5). Unknown formats fall back to the raw value. */
const BUILTIN = { 0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 14: "yyyy-mm-dd", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "yyyy-mm-dd h:mm", 49: "@" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const codeFor = (id, custom) => custom ?? BUILTIN[id] ?? "General";
/** The format code without quoted literals, [..] blocks (colors, locales, conditions) and \-escapes. */
const strip = (code) => code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
/** A date/time format has a y/d/h/m/s token and no 0 # ? digit placeholder once literals are stripped. */
export const isDateCode = (code) => { const c = strip(code); return /[ydhms]/i.test(c) && !/[0#?]/.test(c) && !/^(General|@)$/i.test(code); };
export function serialToDate(n) { return new Date(Math.round((n - 25569) * 86400000)); }
export function dateToSerial(y, m, d) { return Date.UTC(y, m - 1, d) / 86400000 + 25569; }
const pad = (n, w = 2) => String(n).padStart(w, "0");

function fmtDate(n, code) {
  const dt = serialToDate(n); const c = strip(code.split(";")[0]);
  const ampm = /AM\/PM/i.test(c);
  const H = dt.getUTCHours(); const h12 = H % 12 || 12;
  const toks = c.match(/yyyy|yy|mmmm|mmm|mm|m|dd|d|hh|h|ss|s|AM\/PM|./gi) || [];
  const isPart = (x) => /^[hdsym]/i.test(x);
  let out = "";
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]; const low = t.toLowerCase();
    // m/mm right after an hour token or right before a seconds token means minutes
    const prev = toks.slice(0, i).reverse().find(isPart); const next = toks.slice(i + 1).find(isPart);
    const minute = (low === "mm" || low === "m") && ((prev && /^h/i.test(prev)) || (next && /^s/i.test(next)));
    if (low === "yyyy") out += dt.getUTCFullYear();
    else if (low === "yy") out += pad(dt.getUTCFullYear() % 100);
    else if (low === "mmmm") out += MONTHS_LONG[dt.getUTCMonth()];
    else if (low === "mmm") out += MONTHS[dt.getUTCMonth()];
    else if (minute) out += low === "mm" ? pad(dt.getUTCMinutes()) : dt.getUTCMinutes();
    else if (low === "mm") out += pad(dt.getUTCMonth() + 1);
    else if (low === "m") out += dt.getUTCMonth() + 1;
    else if (low === "dd") out += pad(dt.getUTCDate());
    else if (low === "d") out += dt.getUTCDate();
    else if (low === "hh") out += pad(ampm ? h12 : H);
    else if (low === "h") out += ampm ? h12 : H;
    else if (low === "ss") out += pad(dt.getUTCSeconds());
    else if (low === "s") out += dt.getUTCSeconds();
    else if (low === "am/pm") out += H < 12 ? "AM" : "PM";
    else out += t;
  }
  return out;
}

/** Literal text of a format section ("..", \x, [$sym-locale]); [color]/[condition] blocks are dropped. */
const literal = (s) => s.replace(/"([^"]*)"|\\(.)|\[\$([^\]-]*)[^\]]*\]|\[[^\]]*\]|_.|\*./g, (m, q, e, cur) => q ?? e ?? cur ?? "");

function fmtNumber(n, code) {
  const sec = code.split(";");
  const useNeg = n < 0 && sec.length > 1;
  const c = useNeg ? sec[1] : sec[0];
  // split the section into prefix literal / numeric core / suffix literal around the digit placeholders
  const m = /^((?:"[^"]*"|\\.|\[[^\]]*\]|[^0#?.,%Ee])*)([0#?.,]+(?:[Ee][+-][0#?]+)?%?)(.*)$/.exec(c);
  if (!m) throw new Error("unsupported format");
  const [, pre, core, post] = m;
  const pct = core.includes("%") || post.includes("%");
  const sci = /E[+-]/i.test(core);
  const decimals = ((core.split(/[Ee]/)[0].split(".")[1] || "").match(/[0#?]/g) || []).length;
  const v = Math.abs(pct ? n * 100 : n);
  let s;
  if (sci) { const [mant, exp] = v.toExponential(decimals).split("e"); s = `${mant}E${Number(exp) < 0 ? "-" : "+"}${pad(Math.abs(Number(exp)))}`; }
  else {
    s = v.toFixed(decimals);
    if (/[0#?],[0#?]/.test(core)) { const [i, f] = s.split("."); s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f !== undefined ? `.${f}` : ""); }
  }
  const sign = n < 0 && !useNeg && Number(s.replace(/[^\d]/g, "")) !== 0 ? "-" : "";
  return `${sign}${literal(pre)}${s}${core.endsWith("%") ? "%" : ""}${literal(post)}`;
}

export function formatValue(raw, kind, fmt) {
  if (raw === null || raw === undefined || raw === "") return "";
  if (kind === "b") return raw === "1" || raw === true ? "TRUE" : "FALSE";
  if (kind !== "n") return String(raw);
  const n = Number(raw); const code = fmt?.code ?? "General";
  if (!Number.isFinite(n)) return String(raw);
  if (code === "@") return String(raw);
  if (/^General$/i.test(code)) return String(Number(n.toPrecision(11)));
  try { return isDateCode(code) ? fmtDate(n, code) : fmtNumber(n, code); } catch { return String(raw); }
}
