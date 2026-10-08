/**
 * Bot Builder — small shared markup helpers for the simplified editor.
 *
 * segGroup(): a labelled radio group (fieldset + legend) that also posts the
 * value it was rendered with as "<name>__was", which is how a save tells an
 * untouched control from a changed one (preserve-unless-changed, see
 * def-adapter.js).
 */
import { escapeHtml } from "../../shared/components.js";

let _seq = 0;

/**
 * @param {object} o
 * @param {string} o.name
 * @param {string} o.legend - already-translated text
 * @param {{value:string, label:string, disabled?:boolean, note?:string}[]} o.options
 * @param {string} o.current
 * @param {string} [o.hint] - already-translated text (escaped here)
 * @param {string} [o.hintHtml] - trusted HTML hint (used instead of hint)
 * @param {string} [o.id]
 * @param {boolean} [o.legendHidden] - visually hide the legend (row already labelled)
 * @param {string} [o.legendId] - id to label the group by instead of a legend
 */
export function segGroup(o) {
  const id = o.id || `btb-seg-${++_seq}`;
  const hintId = `${id}-h`;
  const hint = o.hintHtml || (o.hint ? escapeHtml(o.hint) : "");
  const opts = o.options.map((op) => {
    const checked = op.value === o.current ? " checked" : "";
    const dis = op.disabled ? " disabled" : "";
    const note = op.note ? `<span class="btb-seg-note">${escapeHtml(op.note)}</span>` : "";
    return `<label class="btb-seg-opt${op.disabled ? " btb-seg-disabled" : ""}">` +
      `<input type="radio" name="${escapeHtml(o.name)}" value="${escapeHtml(op.value)}"${checked}${dis}>` +
      `<span>${escapeHtml(op.label)}</span>${note}</label>`;
  }).join("");
  return `<fieldset class="btb-fieldset" id="${escapeHtml(id)}"${hint ? ` aria-describedby="${escapeHtml(hintId)}"` : ""}>` +
    `<legend class="btb-legend${o.legendHidden ? " btb-sr" : ""}">${escapeHtml(o.legend)}</legend>` +
    `<div class="btb-seg">${opts}</div>` +
    `<input type="hidden" name="${escapeHtml(o.name)}__was" value="${escapeHtml(o.current)}">` +
    (hint ? `<p class="btb-hint" id="${escapeHtml(hintId)}">${hint}</p>` : "") +
    `</fieldset>`;
}

/** A section card with a heading and optional lead text (trusted HTML body). */
export function card(title, body, lead = "") {
  return `<section class="btb-card"><h3 class="btb-card-title">${escapeHtml(title)}</h3>` +
    (lead ? `<p class="btb-card-lead">${escapeHtml(lead)}</p>` : "") + body + `</section>`;
}

/** Normalize textarea text for "did it change?" comparisons (CRLF, outer space). */
export function normText(s) {
  return String(s == null ? "" : s).replace(/\r\n?/g, "\n").trim();
}

// ---------------------------------------------------------------- form snapshots
//
// Every save form carries form_was: what the form would post if submitted
// untouched (computed once at render from the rendered markup, the way a
// browser serialises a form). A save then changes only the fields whose
// posted value differs from that snapshot — the general preserve-unless-
// changed rule for every plain field (name, persona, models, channel fields,
// device profiles, kiosk features, folders, board). Hidden inputs are not in
// the snapshot (they are bookkeeping, not controls).

const NL = (v) => String(v).replace(/\r\n?/g, "\n");

// A <textarea>'s text is a raw-text element to the DOM parser used here: its
// character references are not decoded, so decode them the way a browser does.
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : m;
  });
}

/** What an untouched form posts: {name: string[]} (enabled, non-hidden controls). */
export function snapshotForm(form) {
  const out = {};
  const add = (k, v) => { if (!k) return; (out[k] = out[k] || []).push(NL(v)); };
  for (const el of form.querySelectorAll("input, select, textarea")) {
    if (el.hasAttribute("disabled")) continue;
    let p = el.parentElement, off = false;
    while (p && p !== form) { if (p.tagName === "FIELDSET" && p.hasAttribute("disabled")) { off = true; break; } p = p.parentElement; }
    if (off) continue;
    const name = el.getAttribute("name");
    if (!name) continue;
    const tag = el.tagName;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "INPUT" && (type === "hidden" || type === "submit" || type === "button" || type === "search")) continue;
    if (tag === "INPUT" && (type === "checkbox" || type === "radio")) {
      if (!(name in out)) out[name] = [];
      if (el.hasAttribute("checked")) add(name, el.getAttribute("value") ?? "on");
    } else if (tag === "SELECT") {
      const opts = [...el.querySelectorAll("option")];
      const sel = opts.find((o) => o.hasAttribute("selected")) || opts[0];
      add(name, sel ? (sel.getAttribute("value") ?? sel.textContent) : "");
    } else if (tag === "TEXTAREA") {
      // a textarea's first newline right after the tag is dropped by parsers
      add(name, decodeEntities(el.textContent).replace(/^\n/, ""));
    } else {
      add(name, el.getAttribute("value") ?? "");
    }
  }
  return out;
}

/**
 * Add form_was to every save form in a rendered fragment. Save forms are
 * the ones carrying def_rev; the hidden input is inserted right after it.
 */
export async function withFormSnapshots(html) {
  if (!html.includes('name="def_rev"')) return html;
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const snaps = [...document.querySelectorAll("form")]
    .filter((f) => f.querySelector("input[name=def_rev]"))
    .map((f) => JSON.stringify(snapshotForm(f)));
  let i = 0;
  return html.replace(/(<input type="hidden" name="def_rev" value="[^"]*">)/g, (m) => {
    const s = snaps[i++];
    if (s === undefined) return m;
    const esc = s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `${m}<input type="hidden" name="form_was" value="${esc}">`;
  });
}

/**
 * changed(name): did the operator change this control? Without a snapshot
 * (a post from an older page, a script) every present field counts as
 * changed — the old behaviour. A field absent from both is unchanged.
 */
export function changeTracker(body) {
  let snap = null;
  try { snap = typeof body.form_was === "string" ? JSON.parse(body.form_was) : null; } catch { snap = null; }
  const posted = (k) => (body[k] == null ? [] : [].concat(body[k])).map((v) => NL(v));
  const changed = (name) => {
    if (!snap) return name in body;
    const was = Array.isArray(snap[name]) ? snap[name] : (name in snap ? [] : null);
    const now = posted(name);
    if (was === null) return now.length > 0; // a control that was not on the page (another channel's field)
    if (was.length !== now.length) return true;
    return was.some((v, i) => v !== now[i]);
  };
  changed.hasSnapshot = !!snap;
  changed.anyStartingWith = (prefix) => {
    const keys = new Set([...Object.keys(body), ...(snap ? Object.keys(snap) : [])].filter((k) => k.startsWith(prefix) && !k.endsWith("__was")));
    for (const k of keys) if (changed(k)) return true;
    return false;
  };
  return changed;
}

/** JSON for an inline <script>: "<" is escaped so a value can never close the tag. */
export function scriptJson(v) {
  return JSON.stringify(v === undefined ? null : v).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
}
