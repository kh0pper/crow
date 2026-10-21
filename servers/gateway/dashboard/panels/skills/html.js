/**
 * Skills panel, option C: the list page (strip, grouped switch rows, one
 * detail) and the create dialog. Pure HTML from a model the handler builds
 * (skills.js); no file or DB access here.
 *
 * Layout: one `.sk-detail` at most, rendered right after its row. On a phone
 * it sits under the row; on wide (≥ 769px) CSS pins it as a side pane and
 * reserves the list's right edge (css.js).
 */
import { escapeHtml, formField } from "../../shared/components.js";
import { t, fill } from "../../shared/i18n.js";
import { EXEMPT_FROM_OFF } from "../../../../../scripts/pi-bots/skill_resolver.mjs";

const esc = escapeHtml;
const href = (params) => esc("/dashboard/skills" + (params ? "?" + params : ""));
const qs = (o) => Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
const vh = (s) => `<span class="sk-vh"> ${esc(s)}</span>`;
/** A single-quoted JS string inside an HTML attribute. */
const jsAttr = (str) => esc(String(str).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, " "));

/** Status → [i18n key, tone] for the row meta and chips. */
const STATUS = {
  update: ["skills.st.update", "info"],
  behind: ["skills.st.behind", "warning"],
  removed: ["skills.st.removed", "error"],
  orphan: ["skills.st.orphan", "warning"],
  "ext-removed": ["skills.st.extRemoved", "muted"],
  replaced: ["skills.st.replaced", "muted"],
  "needs-kit": ["skills.st.needsKit", "muted"],
  off: ["skills.st.off", "off"],
};

/** Accents off and lowercase, the same fold the server's search and file names use. */
export const fold = (s) => String(s || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

const usedByText = (n, lang) => (n === 0 ? t("skills.usedBy0", lang) : n === 1 ? t("skills.usedBy1", lang) : fill(t("skills.usedByN", lang), { n }));

function hue(id) { let h = 0; for (const c of String(id)) h = (h * 31 + c.codePointAt(0)) % 360; return h; }
function avatar(r) {
  const ini = (String(r.title || r.name).replace(/[^\p{L}\p{N}]/gu, "")[0] || "?").toUpperCase();
  const kind = r.source === "builtin" ? "builtin" : r.source === "yours" ? "yours" : "ext";
  const hueVar = kind === "ext" ? ` style="--sk-h:${hue(r.bundle || r.name)}"` : "";
  return `<span class="sk-av sk-av-${kind}"${hueVar} aria-hidden="true">${esc(ini)}</span>`;
}
const langAttr = (l, lang) => (l && l !== lang ? ` lang="${l}"` : "");

function sourceChip(r, lang) {
  const ext = r.bundleName || r.bundle || "";
  if (r.source === "ext") return `<span class="sk-chip sk-chip-ext">${esc(fill(t("skills.fromExt", lang), { ext }))}${r.linked ? " · " + esc(t("skills.linked", lang)) : ""}</span>`;
  if (r.source === "yours") return `<span class="sk-chip sk-chip-yours">${esc(r.basedOn ? fill(t("skills.copyOf", lang), { ext }) : t("skills.yoursBadge", lang))}</span>`;
  if (r.source === "missing") return "";
  return `<span class="sk-chip sk-chip-builtin">${esc(t("skills.builtInBadge", lang))}</span>`;
}
function flags(r, lang) {
  let o = "";
  if (r.experimental) o += ` <span class="sk-chip sk-chip-flag">${esc(t("skills.experimental", lang))}</span>`;
  if (r.replacesBuiltin) o += ` <span class="sk-chip sk-chip-plain">${esc(t("skills.replacesBuiltin", lang))}</span>`;
  return o;
}
function statusOf(r, m) {
  if (r.shadow) return "replaced";
  if (m.off.has(r.name) && r.status !== "removed") return "off";
  return r.status;
}
function stChip(status, lang, key) {
  const s = STATUS[status];
  if (!s) return "";
  return `<span class="sk-st sk-st-${s[1]}"><span class="sk-dot" aria-hidden="true"></span>${esc(t(key || s[0], lang))}</span>`;
}

/** The on/off switch: a real POST form, so it works without JS and through Turbo's CSRF header. */
function switchForm(name, title, isOff, focus, lang) {
  return `<form method="POST" class="sk-switch-form"><input type="hidden" name="action" value="${isOff ? "set-on" : "set-off"}"><input type="hidden" name="skill" value="${esc(name)}">` +
    `<button type="submit" class="sk-switch" role="switch" aria-checked="${isOff ? "false" : "true"}" aria-label="${esc(title)}"${focus ? " autofocus" : ""}><span class="sk-switch-track" aria-hidden="true"></span><span class="sk-switch-text" aria-hidden="true">${esc(t(isOff ? "skills.st.off" : "skills.swOn", lang))}</span></button></form>`;
}
function postButton(action, fields, label, { cls = "btn btn-secondary", confirm = null, extra = "" } = {}) {
  const inputs = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v ?? "")}">`).join("");
  const onsubmit = confirm ? ` onsubmit="return confirm('${jsAttr(confirm)}')"` : "";
  return `<form method="POST" class="sk-inline-form"${onsubmit}><input type="hidden" name="action" value="${action}">${inputs}<button type="submit" class="${cls}">${label}</button>${extra}</form>`;
}

// ---------------------------------------------------------------- strip

function attentionStrip(m) {
  const { lang } = m;
  if (!m.attention.length) {
    return `<section class="sk-attn ok" aria-label="${esc(t("skills.attnOk", lang))}"><span class="sk-st sk-st-ok"><span class="sk-dot" aria-hidden="true"></span>${esc(t("skills.attnOk", lang))}</span></section>`;
  }
  const items = m.attention.map((it) => {
    const r = it.row;
    const title = r ? r.title : it.name;
    const bot = it.bots[0];
    const takeOff = bot ? `<a class="btn btn-secondary btn-sm sk-act" href="/dashboard/bot-builder?bot=${encodeURIComponent(bot.botId)}&amp;tab=abilities">${esc(fill(t("skills.act.takeOff", lang), { bot: bot.name }))}</a>` : "";
    let label, action;
    if (it.kind === "update") { label = t(r.updateAtBoot === false ? "skills.st.updateAvailable" : "skills.st.update", lang); action = `<a class="btn btn-secondary btn-sm sk-act" href="${href(qs({ skill: r.name, compare: 1 }))}#skill-${esc(r.name)}">${esc(t("skills.act.review", lang))}${vh(title)}</a>`; }
    else if (it.kind === "behind") { label = t("skills.st.behind", lang); action = `<a class="btn btn-secondary btn-sm sk-act" href="${href(qs({ skill: r.name, compare: 1 }))}#skill-${esc(r.name)}">${esc(t("skills.act.compare", lang))}${vh(title)}</a>`; }
    else if (it.kind === "removed") { label = t("skills.st.removedAsked", lang); action = postButton("restore-shipped", { skill: r.file, srcSha: r.srcSha }, esc(t("skills.act.restore", lang)) + vh(title), { cls: "btn btn-secondary btn-sm sk-act" }) + takeOff; }
    else if (it.kind === "orphan") { label = t("skills.st.orphan", lang); action = postButton("ack", { skill: r.file, srcSha: "" }, esc(t("skills.act.keep", lang)) + vh(title), { cls: "btn btn-secondary btn-sm sk-act" }); }
    else { label = t("skills.st.missingAsked", lang); action = takeOff; }
    const av = r ? avatar(r) : `<span class="sk-av sk-av-missing" aria-hidden="true">?</span>`;
    return `<div class="sk-attn-item">${av}<div class="sk-attn-text"><b${r ? langAttr(r.titleLang, lang) : ""}>${esc(title)}</b><span>${esc(label)}</span></div><div class="sk-attn-acts">${action}</div></div>`;
  }).join("");
  return `<section class="sk-attn" aria-labelledby="sk-attn-h"><h2 id="sk-attn-h">${esc(fill(t("skills.attnTitle", lang), { n: m.attention.length }))}</h2>${items}</section>`;
}

// ---------------------------------------------------------------- detail

function statusNote(r, status, m) {
  const { lang } = m;
  const ext = r.bundleName || r.bundle || "";
  const bots = m.usage.get(r.name) || [];
  switch (status) {
    case "update": return ["info", fill(t(r.hasFile ? "skills.note.update" : "skills.note.updateNew", lang), { ext }) + (r.updateAtBoot === false ? " " + t("skills.note.notAutomatic", lang) : "")];
    case "behind": return ["warn", fill(t("skills.note.behind", lang), { ext })];
    case "removed": return ["err", t(bots.length ? "skills.note.removed" : "skills.note.removedQuiet", lang)];
    case "orphan": return ["warn", fill(t("skills.note.orphan", lang), { ext })];
    case "ext-removed": return ["", fill(t("skills.note.extRemoved", lang), { ext })];
    case "off": return ["", t("skills.note.off", lang)];
    case "replaced": return ["", t("skills.note.replaced", lang)];
    case "needs-kit": return ["", t("skills.needsKitNote", lang)];
  }
  if (r.source === "ext" && !r.linked) return ["", fill(t("skills.note.extUpToDate", lang), { ext })];
  if (r.name === "skill-writing") return ["", t("skills.alwaysSelfAuthoring", lang)];
  return null;
}

function diffBlock(d, m) {
  const { lang } = m;
  if (!d) return "";
  if (!d.lines.some((l) => l.op !== " ")) return `<div class="sk-d-sec"><b>${esc(t("skills.d.changes", lang))}</b><p class="sk-muted">${esc(t("skills.d.noDiff", lang))}</p></div>`;
  const lines = d.lines.map((l) => `<span class="sk-diff-${l.op === "+" ? "add" : l.op === "-" ? "del" : "ctx"}">${l.op === " " ? "  " : l.op + " "}${esc(l.text)}</span>`).join("\n");
  return `<div class="sk-d-sec"><b>${esc(t("skills.d.changes", lang))}</b><p class="sk-muted">${esc(fill(t("skills.d.diffLegend", lang), { from: d.fromLabel, to: d.toLabel }))}</p><pre class="sk-diff" tabindex="0">${lines}</pre></div>`;
}

function detailActions(r, status, m, dx) {
  const { lang } = m;
  const ext = r.bundleName || r.bundle || "";
  const editHref = (src, extra = "") => href(qs({ edit: r.file, source: src })) + extra;
  const acts = [];
  const gotoExt = r.bundle ? `<a class="btn btn-secondary" href="/dashboard/extensions?q=${encodeURIComponent(r.bundle)}">${esc(fill(t("skills.a.goto", lang), { ext }))}</a>` : "";
  const compare = (key) => `<a class="btn btn-secondary" href="${href(qs({ skill: r.name, compare: 1 }))}#skill-${esc(r.name)}">${esc(key)}</a>`;
  if (r.source === "missing") return "";
  if (r.source === "ext" && status === "removed") {
    acts.push(postButton("restore-shipped", { skill: r.file, srcSha: r.srcSha }, esc(t("skills.act.restore", lang)) + vh(r.title), { cls: "btn btn-primary" }));
    acts.push(gotoExt);
  } else if (r.source === "ext" && !r.hasFile) {
    acts.push(postButton("apply-update", { skill: r.file, srcSha: r.srcSha }, esc(t("skills.a.applyUpdate", lang)), { cls: "btn btn-primary" }));
    if (!dx.compare) acts.push(compare(t("skills.a.reviewChanges", lang)));
    acts.push(gotoExt);
  } else if (r.source === "ext" && r.linked) {
    acts.push(`<a class="btn btn-secondary" href="${editHref("user")}">${esc(t("skills.view", lang))}</a>`);
    acts.push(postButton("copy-link", { filename: r.file }, esc(t("skills.makeOwnCopy", lang))));
    acts.push(gotoExt);
  } else if (r.source === "ext") {
    if (status === "update") {
      acts.push(postButton("apply-update", { skill: r.file, srcSha: r.srcSha }, esc(t("skills.a.applyUpdate", lang)), { cls: "btn btn-primary" }));
      if (!dx.compare) acts.push(compare(t("skills.a.reviewChanges", lang)));
    }
    acts.push(`<a class="btn btn-secondary" href="${editHref("user", "&amp;customize=1")}">${esc(t("skills.customize", lang))}</a><small class="sk-act-warn">${esc(fill(t("skills.customizeWarn", lang), { ext }))}</small>`);
    acts.push(gotoExt);
  } else if (r.source === "yours") {
    acts.push(`<a class="btn btn-primary" href="${editHref("user")}">${esc(t("skills.edit", lang))}</a>`);
    if (r.basedOn && r.bundle && (status === "behind" || status === "on" || status === "off") && dx.shipped) {
      if (!dx.compare) acts.push(compare(fill(t("skills.a.compareWith", lang), { ext })));
      acts.push(postButton("restore-shipped", { skill: r.file, srcSha: dx.shipped.sha }, esc(t("skills.a.restoreOriginal", lang)), { confirm: t("skills.a.restoreOriginalWarn", lang), extra: "" }) + `<small class="sk-act-warn">${esc(t("skills.a.restoreOriginalWarn", lang))}</small>`);
      if (status === "behind") acts.push(postButton("ack", { skill: r.file, srcSha: dx.shipped.sha }, esc(t("skills.a.keepMine", lang))));
    }
    if (status === "orphan") acts.push(postButton("ack", { skill: r.file, srcSha: "" }, esc(t("skills.act.keep", lang)) + vh(r.title)));
    if (r.replacesBuiltin && !dx.compare) acts.push(compare(t("skills.a.compareBuiltin", lang)));
    const n = (m.usage.get(r.name) || []).length;
    const delLabel = r.replacesBuiltin ? t("skills.a.resetBuiltin", lang) : t("skills.a.delete", lang);
    acts.push(postButton("delete", { filename: r.file }, esc(delLabel), { cls: "btn btn-danger", confirm: m.deleteConfirm(r, n) }));
  } else {
    acts.push(`<a class="btn btn-secondary" href="${editHref("repo")}">${esc(t("skills.view", lang))}</a>`);
    if (status !== "replaced") acts.push(postButton("override", { filename: r.file }, esc(t("skills.customize", lang)), { confirm: t("skills.overrideConfirm", lang) }) + `<small class="sk-act-warn">${esc(t("skills.a.customizeBuiltinWarn", lang))}</small>`);
  }
  return `<div class="sk-d-acts">${acts.filter(Boolean).join("")}</div>`;
}

function detail(r, m, dx) {
  const { lang } = m;
  const status = statusOf(r, m);
  const note = statusNote(r, status, m);
  const bots = m.usage.get(r.name) || [];
  const used = bots.length
    ? `<div class="sk-chips">${bots.map((b) => `<a class="sk-chip sk-chip-plain sk-chip-link" href="/dashboard/bot-builder?bot=${encodeURIComponent(b.botId)}&amp;tab=abilities">${esc(b.name)}${b.paused ? " " + esc(t("skills.d.paused", lang)) : ""}${b.auto ? " · " + esc(t("skills.d.auto", lang)) : ""}${b.voiceJobOnly ? " " + esc(t("skills.d.voiceJobOnly", lang)) : ""}</a>`).join("")}</div>`
    : `<span class="sk-muted">${esc(t("skills.usedBy0", lang))}</span>`;
  const trig = r.triggers && r.triggers.length
    ? `<div class="sk-d-sec"><b>${esc(t("skills.d.triggers", lang))}</b><div class="sk-chips">${r.triggers.map((x) => `<span class="sk-chip sk-chip-plain">“${esc(x)}”</span>`).join("")}</div></div>` : "";
  const lines = dx.text ? dx.text.split("\n").length : 0;
  const instr = dx.text !== null && dx.text !== undefined
    ? `<details class="sk-d-sec sk-instr"${lines <= 40 ? " open" : ""}><summary><b>${esc(t("skills.d.instructions", lang))}</b></summary><pre class="sk-pre" tabindex="0">${esc(dx.text)}</pre></details>` : "";
  const file = `<div class="sk-d-sec"><b>${esc(t("skills.d.file", lang))}</b><span class="mono">${esc(r.file)}${r.bundle && r.source !== "builtin" ? " · " + esc(r.bundleName || r.bundle) + (dx.version ? " " + esc(dx.version) : "") : ""}</span></div>`;
  return `<div class="sk-detail" id="sk-detail" role="region" aria-labelledby="sk-detail-h">
    <div class="sk-d-head">${avatar(r)}<h2 id="sk-detail-h" tabindex="-1" autofocus${langAttr(r.titleLang, lang)}>${esc(r.title)}${flags(r, lang)}</h2><a class="sk-close" href="${href(m.q ? qs({ q: m.q }) : "")}#skill-${esc(r.name)}" aria-label="${esc(t("skills.d.close", lang))}">✕</a></div>
    ${dx.done ? `<p class="sk-note sk-note-ok" id="sk-done" role="status" tabindex="-1">${esc(dx.done)}</p>` : ""}
    <div class="sk-chips">${sourceChip(r, lang)}${stChip(status, lang, status === "update" && r.updateAtBoot === false ? "skills.st.updateAvailable" : null)}</div>
    ${r.description ? `<p class="sk-d-purpose"${langAttr(r.descriptionLang, lang)}>${esc(r.description)}</p>` : ""}
    ${note ? `<div class="sk-note sk-note-${note[0] || "plain"}">${esc(note[1])}</div>` : ""}
    ${dx.compare ? diffBlock(dx.diff, m) : ""}
    ${detailActions(r, status, m, dx)}
    <div class="sk-d-sec"><b>${esc(t("skills.d.usedBy", lang))}</b>${used}</div>
    ${trig}${instr}${file}
  </div>`;
}

// ---------------------------------------------------------------- rows

function rowHtml(r, m) {
  const { lang } = m;
  const status = statusOf(r, m);
  const bots = m.usage.get(r.name) || [];
  const meta = [];
  // Which extension, in the row (the section says only "From extensions").
  const ext = r.bundleName || r.bundle || "";
  if (r.source === "ext") meta.push(fill(t("skills.fromExt", lang), { ext }) + (r.linked ? " · " + t("skills.linked", lang) : ""));
  else if (r.source === "yours" && r.basedOn) meta.push(fill(t("skills.copyOf", lang), { ext }));
  // The copy-of label already says whose copy it is; its status (behind,
  // extension removed…) is in the strip and the detail, not repeated here.
  if (status !== "on" && !(r.source === "yours" && r.basedOn && status !== "off")) meta.push(t(status === "removed" && bots.length ? "skills.st.removedAsked" : status === "update" && r.updateAtBoot === false ? "skills.st.updateAvailable" : (STATUS[status] || [])[0] || "", lang));
  if (!r.shadow) meta.push(usedByText(bots.length, lang));
  let right;
  if (r.shadow) right = `<span class="sk-chip sk-chip-plain">${esc(t("skills.yoursUsed", lang))}</span>`;
  else if (status === "removed") right = postButton("restore-shipped", { skill: r.file, srcSha: r.srcSha }, esc(t("skills.act.restore", lang)) + vh(r.title), { cls: "btn btn-secondary btn-sm" });
  else if (EXEMPT_FROM_OFF.includes(r.name)) right = `<span class="sk-chip sk-chip-plain" title="${esc(t("skills.alwaysSelfAuthoring", lang))}">${esc(t("skills.swAlways", lang))}</span>`;
  else right = switchForm(r.name, r.title, m.off.has(r.name), m.toggled === r.name, lang);
  const sel = m.selected && m.selected.name === r.name && !!m.selected.shadow === !!r.shadow;
  const id = r.shadow ? `skill-${r.name}-builtin` : `skill-${r.name}`;
  const params = qs({ skill: r.name, q: m.q, builtin: r.shadow ? 1 : null });
  return `<div class="sk-row${sel ? " sel" : ""}" id="${esc(id)}" data-skill="${esc(r.name)}" data-source="${r.source}" data-search="${esc(fold([r.name, r.title, r.description, r.bundleName, r.bundle, r.file].join(" ")))}">` +
    `<a class="sk-hit" href="${href(params)}#${esc(id)}"${sel ? ` aria-current="true"` : ""}>${avatar(r)}<span class="sk-main"><span class="sk-name"${langAttr(r.titleLang, lang)}>${esc(r.title)}${flags(r, lang)}</span>` +
    (r.description ? `<span class="sk-purpose"${langAttr(r.descriptionLang, lang)}>${esc(r.description)}</span>` : "") +
    `<span class="sk-meta">${esc(meta.filter(Boolean).join(" · "))}</span></span></a>${right}</div>` +
    (sel ? detail(r, m, m.selected.dx) : "");
}

function offMissingRow(name, m) {
  const { lang } = m;
  return `<div class="sk-row" id="skill-${esc(name)}" data-skill="${esc(name)}" data-source="missing" data-search="${esc(fold(name))}"><span class="sk-hit sk-hit-static"><span class="sk-av sk-av-missing" aria-hidden="true">?</span><span class="sk-main"><span class="sk-name">${esc(name)}</span><span class="sk-meta">${esc(t("skills.st.offMissing", lang))}</span></span></span>${switchForm(name, name, true, m.toggled === name, lang)}</div>`;
}

function sections(m) {
  const { lang } = m;
  const groups = [
    ["yours", t("skills.secYours", lang), (r) => r.source === "yours" || r.source === "missing"],
    ["ext", t("skills.secExt", lang), (r) => r.source === "ext"],
    ["builtin", t("skills.secBuiltin", lang), (r) => r.source === "builtin"],
  ];
  return groups.map(([key, label, pick]) => {
    const rows = m.rows.filter(pick);
    const missing = key === "yours" ? m.offMissing : [];
    const offN = rows.filter((r) => !r.shadow && m.off.has(r.name)).length + missing.length;
    const count = rows.filter((r) => !r.shadow).length + missing.length;
    if (!count && key !== "yours") return "";
    const open = key !== "builtin" || !!m.q || (m.selected && m.selected.source === "builtin") || rows.some((r) => r.name === m.toggled);
    const body = count
      ? rows.map((r) => rowHtml(r, m)).join("") + missing.map((n) => offMissingRow(n, m)).join("")
      : `<div class="sk-empty"><b>${esc(t("skills.yoursEmptyTitle", lang))}</b><span>${esc(t("skills.yoursEmptyText", lang))}</span><a class="btn btn-primary" href="${href("new=1")}" data-sk-new>${esc(t("skills.newSkill", lang))}</a></div>`;
    return `<details class="sk-sec" data-sec="${key}"${open ? " open" : ""}><summary class="sk-sec-h"><b>${esc(label)}</b><span class="sk-sec-count">${esc(offN ? fill(t("skills.secCountOff", lang), { n: count, off: offN }) : String(count))}</span></summary>${body}</details>`;
  }).join("");
}

// ---------------------------------------------------------------- create

function createDialog(m) {
  const { lang } = m;
  const cs = m.createState;
  const typed = cs ? cs.typed : { filename: m.newName || "", purpose: "", content: "" };
  let err = "";
  if (cs) {
    const open = cs.existing ? ` <a href="${href(qs({ edit: cs.existing.file, source: cs.existing.source }))}">${esc(t("skills.openExisting", lang))}</a>` : "";
    err = `<div class="skills-notice sk-note sk-note-err" role="alert">${esc(cs.message)}${open}</div>`;
  }
  const focus = cs ? (cs.code === "empty" ? "content" : "filename") : "filename";
  const withFocus = (html, name) => (focus === name ? html.replace(`id="field-${name}"`, `id="field-${name}" autofocus`) : html);
  const openOnLoad = cs || m.createOpen;
  return `<dialog id="sk-create" class="sk-dialog" aria-labelledby="sk-create-h"${openOnLoad ? " data-open-on-load" : ""}>
    <form method="POST" id="skill-create">
      <input type="hidden" name="action" value="create">
      <div class="sk-d-head"><h2 id="sk-create-h">${esc(t("skills.createTitle", lang))}</h2><button type="button" class="sk-close" data-sk-close aria-label="${esc(t("skills.cancel", lang))}">✕</button></div>
      ${err}
      ${withFocus(formField(t("skills.filenameLabel", lang), "filename", { placeholder: t("skills.filenamePlaceholder", lang), required: true, value: typed.filename }), "filename")}
      <p class="sk-hint" id="sk-file-hint" data-label="${esc(t("skills.fileHint", lang))}">${esc(fill(t("skills.fileHint", lang), { file: m.fileHint(typed.filename) }))} · ${esc(t("skills.fileHintNote", lang))}</p>
      ${formField(t("skills.purposeLabel", lang), "purpose", { value: typed.purpose })}
      ${withFocus(formField(t("skills.instructionsLabel", lang), "content", { type: "textarea", required: true, placeholder: t("skills.contentPlaceholder", lang), rows: 8, value: typed.content }), "content")}
      <div class="sk-d-acts"><button type="submit" class="btn btn-primary">${esc(t("skills.createSkill", lang))}</button><button type="button" class="btn btn-secondary" data-sk-close>${esc(t("skills.cancel", lang))}</button></div>
    </form>
  </dialog>
  <noscript><style>#sk-create[data-open-on-load]{display:block;position:static;margin:0 0 1rem}</style></noscript>`;
}

// ---------------------------------------------------------------- page

/**
 * @param {object} m  model: lang, rows, off (Set), usage (Map), attention,
 *   offMissing (names), q, selected ({name, shadow, source, dx}|null),
 *   toggled, toast, notice (html), stateBanner (html), createState,
 *   createOpen, newName, fileHint(name), deleteConfirm(row, n)
 */
export function renderSkillsPage(m) {
  const { lang } = m;
  const anyRows = m.rows.length + m.offMissing.length;
  const noMatch = m.q && !anyRows
    ? `<div class="sk-empty sk-nomatch"><b>${esc(fill(t("skills.noMatch", lang), { q: m.q }))}</b><div class="sk-d-acts"><a class="btn btn-primary" href="${href(qs({ new: 1, name: m.q }))}" data-sk-new data-sk-name="${esc(m.q)}">${esc(fill(t("skills.createNamed", lang), { q: m.q }))}</a><a class="btn btn-secondary" href="/dashboard/extensions">${esc(t("skills.browseExtensions", lang))}</a></div></div>`
    : "";
  const liveNoMatch = `<div class="sk-empty sk-nomatch" id="sk-nomatch-live" hidden><b data-tpl="${esc(t("skills.noMatch", lang))}"></b><div class="sk-d-acts"><a class="btn btn-primary" href="${href("new=1")}" data-sk-new data-tpl="${esc(t("skills.createNamed", lang))}"></a><a class="btn btn-secondary" href="/dashboard/extensions">${esc(t("skills.browseExtensions", lang))}</a></div></div>`;
  const toast = `<div class="skills-toast" role="status" id="skills-toast"${m.toast ? ` data-skills-toast="${esc(m.toast)}"` : ""}></div>`;
  return `<div class="sk-page${m.selected ? " has-detail" : ""}">
    <p class="sk-lede">${esc(t("skills.lede", lang))}</p>
    ${m.notice || ""}${m.stateBanner || ""}
    <form method="GET" action="/dashboard/skills" class="sk-toolbar" role="search">
      <label class="sk-search"><span aria-hidden="true">⌕</span><input type="search" name="q" id="sk-q" value="${esc(m.q || "")}" placeholder="${esc(t("skills.searchLabel", lang))}" aria-label="${esc(t("skills.searchLabel", lang))}" autocomplete="off"></label>
      <a class="btn btn-primary sk-new" href="${href("new=1")}" data-sk-new>${esc(t("skills.newSkill", lang))}</a>
    </form>
    ${attentionStrip(m)}
    <div class="sk-list">${noMatch || sections(m)}${liveNoMatch}</div>
    <div class="sk-foot"><span>${esc(t("skills.footBehavior", lang))}</span><a href="${href("view=behavior")}">${esc(t("skills.behaviorLink", lang))}</a></div>
    ${createDialog(m)}
    ${toast}
  </div>`;
}
