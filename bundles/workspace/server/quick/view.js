/** Quick edit (spec §8): server-rendered, phone-first, no client script. Every value is HTML-escaped. */
import { getConfig } from "../config.js";
import { WsError } from "../result.js";
import { list, stat, getFile } from "../nc/dav.js";
import { splitFolder, splitPath, joinPath } from "../nc/paths.js";
import { listVersions } from "../nc/versions.js";
import { openDocx, paragraphText, paragraphHeadingLevel } from "../ooxml/docx-model.js";
import { kids, NS } from "../ooxml/xml.js";
import { openXlsx, readRange, colName } from "../ooxml/xlsx.js";
import { openPptx, readDeck } from "../ooxml/pptx.js";
import { QUICK_MAX_BYTES } from "./actions.js";

export const QUICK_STRINGS = {
  en: {
    tabSetup: "Setup", tabQuick: "Quick edit",
    intro: "Small text and cell changes from your phone. Crow saves a version before every change, so you can always undo. You see exactly what is shared with “Crow bot”.",
    up: "Up", open: "Open", edit: "Edit", save: "Save", cancel: "Cancel", undo: "Undo", restore: "Restore", versions: "Recent versions",
    saved: "Saved.", undone: "Undone.", restored: "Restored.", cancelled: "The waiting change was cancelled.",
    empty: "Nothing here is shared with Crow bot yet. In Workspace, share a folder with “Crow bot”.",
    paragraph: "Paragraph", cell: "Cell", tab: "Tab", slide: "Slide", formulaHint: "Start with = for a formula.",
    openBy: "is editing this file right now.", tryAgain: "Try again", saveAnyway: "Save anyway (closes their editor; their typing is saved first)",
    errorPrefix: "Could not save:", more: "More", notConfigured: "Workspace is not set up yet (see Setup).", notSupported: "Quick edit works on .docx, .xlsx and .pptx files.",
    someone: "Someone", queuedP: "has this file open. Your change is waiting: it will appear in their editor, or when they close it.",
    cancelChange: "Cancel change", applyNow: "Apply now (closes their editor)", applyNowP: "Their typing is saved first, but their editor will close.", applyYes: "Yes, apply now", back: "Back",
    err_stale_view: "This changed since the page loaded. Reload it and try again.",
    err_not_plain_text: "This paragraph has a link, picture, field or footnote. Edit it in the editor on a computer so nothing is lost.",
    err_bad_path: "That is not a valid file path.", err_wrong_type: "Quick edit works on .docx, .xlsx and .pptx files.",
    err_too_large: "This file is too big for Quick edit (over 20 MB). Use the editor on a computer.",
    err_open_in_editor: "Someone has this file open. Try again after they close it.",
    err_locked_by_person: "Someone locked this file in Workspace. Try again after they unlock it.",
    err_not_pending: "That change was already being applied, so it was not cancelled and nothing else was changed.",
    err_changed_since: "The file changed after that edit, so it was not undone. Pick a version below to restore instead.",
    err_version_gone: "Workspace no longer keeps that version, so it cannot be undone automatically.",
    err_read_only: "Crow bot can see this file but was not given edit rights. Ask the owner to share it with edit permission.",
    err_busy: "The file is being saved right now. Try again in a few seconds.",
  },
  es: {
    tabSetup: "Configuración", tabQuick: "Edición rápida",
    intro: "Cambios pequeños de texto y celdas desde tu teléfono. Crow guarda una versión antes de cada cambio, así siempre puedes deshacer. Ves exactamente lo que está compartido con “Crow bot”.",
    up: "Subir", open: "Abrir", edit: "Editar", save: "Guardar", cancel: "Cancelar", undo: "Deshacer", restore: "Restaurar", versions: "Versiones recientes",
    saved: "Guardado.", undone: "Deshecho.", restored: "Restaurado.", cancelled: "Se canceló el cambio en espera.",
    empty: "Todavía no hay nada compartido con Crow bot. En Workspace, comparte una carpeta con “Crow bot”.",
    paragraph: "Párrafo", cell: "Celda", tab: "Hoja", slide: "Diapositiva", formulaHint: "Empieza con = para una fórmula.",
    openBy: "está editando este archivo ahora mismo.", tryAgain: "Intentar de nuevo", saveAnyway: "Guardar de todos modos (cierra su editor; lo que escribió se guarda primero)",
    errorPrefix: "No se pudo guardar:", more: "Más", notConfigured: "Workspace aún no está configurado (ver Configuración).", notSupported: "La edición rápida funciona con archivos .docx, .xlsx y .pptx.",
    someone: "Alguien", queuedP: "tiene este archivo abierto. Tu cambio está esperando: aparecerá en su editor o cuando lo cierre.",
    cancelChange: "Cancelar el cambio", applyNow: "Aplicar ahora (cierra su editor)", applyNowP: "Lo que escribió se guarda primero, pero su editor se cerrará.", applyYes: "Sí, aplicar ahora", back: "Volver",
    err_stale_view: "Esto cambió desde que se cargó la página. Vuelve a cargarla e inténtalo de nuevo.",
    err_not_plain_text: "Este párrafo tiene un enlace, imagen, campo o nota al pie. Edítalo en el editor desde una computadora para no perder nada.",
    err_bad_path: "Esa no es una ruta de archivo válida.", err_wrong_type: "La edición rápida funciona con archivos .docx, .xlsx y .pptx.",
    err_too_large: "Este archivo es demasiado grande para la edición rápida (más de 20 MB). Usa el editor desde una computadora.",
    err_open_in_editor: "Alguien tiene este archivo abierto. Inténtalo de nuevo cuando lo cierre.",
    err_locked_by_person: "Alguien bloqueó este archivo en Workspace. Inténtalo de nuevo cuando lo desbloquee.",
    err_not_pending: "Ese cambio ya se estaba aplicando, así que no se canceló y no se cambió nada más.",
    err_changed_since: "El archivo cambió después de esa edición, así que no se deshizo. Elige abajo una versión para restaurar.",
    err_version_gone: "Workspace ya no guarda esa versión, así que no se puede deshacer automáticamente.",
    err_read_only: "Crow bot puede ver este archivo pero no tiene permiso de edición. Pide al dueño que lo comparta con permiso de edición.",
    err_busy: "El archivo se está guardando en este momento. Inténtalo de nuevo en unos segundos.",
  },
};
const strings = (lang) => QUICK_STRINGS[lang === "es" ? "es" : "en"];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const q = (o) => `/dashboard/workspace?${new URLSearchParams({ view: "quick", ...o }).toString()}`;
const STYLE = `<style>.wq a.btn,.wq button{display:inline-block;min-height:44px;padding:.55rem .9rem;border-radius:8px;border:1px solid var(--crow-border);background:var(--crow-bg-elevated);color:inherit;text-decoration:none;font-size:1rem}.wq ul{list-style:none;padding:0;margin:0}.wq li{padding:.5rem 0;border-bottom:1px solid var(--crow-border);display:flex;gap:.5rem;align-items:center;justify-content:space-between}.wq textarea,.wq input[type=text]{width:100%;font-size:1rem;padding:.5rem;box-sizing:border-box}.wq .note{border-left:3px solid var(--crow-accent);padding:.4rem .6rem;margin:.5rem 0}.wq table{border-collapse:collapse;display:block;overflow-x:auto}.wq td,.wq th{border:1px solid var(--crow-border);padding:.35rem .5rem;min-width:3rem}.wq td a{display:block;min-height:44px;line-height:44px}.wq .h{font-weight:600}</style>`;
const PAGE_STYLE = "body{font-family:system-ui,sans-serif;margin:16px;max-width:40rem}button{min-height:44px;padding:.55rem .9rem;font-size:1rem;margin:.25rem 0;width:100%}details{margin-top:1rem}summary{min-height:44px;line-height:44px}";
const hidden = (csrf, o) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">${Object.entries(o).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}`;
const postForm = (action, csrf, fields, label, style = "") => `<form method="post" action="/api/workspace/quick/${action}" data-turbo="false"${style ? ` style="${style}"` : ""}>${hidden(csrf, fields)}<button>${esc(label)}</button></form>`;
const standalone = (lang, title, body) => `<!doctype html><html lang="${lang === "es" ? "es" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`;
/** What the save form carries back (the confirm and retry forms re-post it unchanged). */
const keepOf = (form) => ({ path: form.path, kind: form.kind, target: form.target, value: form.value, shown: form.shown });

/** A notice code from the redirect → a localized sentence. Unknown codes fall back to the (redacted) message. */
function noticeText(t, query) {
  const n = String(query.notice || "");
  if (["saved", "undone", "restored", "cancelled"].includes(n)) return t[n];
  return `${t.errorPrefix} ${Object.hasOwn(t, `err_${n}`) ? t[`err_${n}`] : query.msg || n}`;
}

async function versionsBlock(cfg, t, csrf, e) {
  const vs = (await listVersions(cfg, e.fileId).catch(() => [])).filter((v) => v.versionId !== String(e.mtime)).slice(0, 20); // B1: hide the CURRENT row, keep the undone one (redo)
  if (!vs.length) return "";
  return `<h3>${esc(t.versions)}</h3><ul>${vs.map((v) => `<li><span>${esc(new Date(v.modified).toLocaleString())} · ${esc(v.author)}${v.label ? ` · ${esc(v.label)}` : ""}</span>${postForm("restore", csrf, { path: e.path, version_id: v.versionId }, t.restore)}</li>`).join("")}</ul>`;
}

export async function renderQuick({ lang, csrf, query = {}, cfg: cfgIn = null }) {
  const t = strings(lang);
  let cfg = cfgIn;
  if (!cfg) { try { cfg = getConfig(); } catch { return `${STYLE}<div class="wq"><p class="note">${esc(t.notConfigured)}</p></div>`; } }
  const undoBtn = query.notice === "saved" && query.v ? ` ${postForm("undo", csrf, { path: query.path, version_id: query.v }, t.undo, "display:inline")}` : "";
  const notice = query.notice ? `<p class="note">${esc(noticeText(t, query))}${undoBtn}</p>` : "";
  try {
    const path = String(query.path || "");
    const segs = path ? splitPath(path) : [];
    const e = segs.length ? await stat(cfg, segs) : { isFolder: true, path: "" };
    if (e.isFolder) {
      const items = (await list(cfg, splitFolder(path))).filter((x) => x.isFolder || /\.(docx|xlsx|pptx)$/i.test(x.name));
      const up = segs.length ? `<p><a class="btn" href="${esc(q({ path: joinPath(segs.slice(0, -1)) }))}">${esc(t.up)}</a></p>` : "";
      return `${STYLE}<div class="wq"><p>${esc(t.intro)}</p>${notice}${up}${items.length ? `<ul>${items.map((x) => `<li><span>${x.isFolder ? "📁" : "📄"} ${esc(x.name)}</span><a class="btn" href="${esc(q({ path: x.path }))}">${esc(t.open)}</a></li>`).join("")}</ul>` : `<p>${esc(t.empty)}</p>`}</div>`;
    }
    const kind = (e.name.split(".").pop() || "").toLowerCase();
    if (!["docx", "xlsx", "pptx"].includes(kind)) return `${STYLE}<div class="wq">${notice}<p>${esc(t.notSupported)}</p></div>`;
    const { bytes } = await getFile(cfg, segs, { maxBytes: QUICK_MAX_BYTES });
    const form = (target, label, value, multiline) => `<form method="post" action="/api/workspace/quick/save" data-turbo="false">${hidden(csrf, { path: e.path, kind, target, shown: value })}<label>${esc(label)}${multiline ? `<textarea name="value" rows="5">${esc(value)}</textarea>` : `<input type="text" name="value" value="${esc(value)}">`}</label>${kind === "xlsx" ? `<small>${esc(t.formulaHint)}</small>` : ""}<p><button>${esc(t.save)}</button> <a class="btn" href="${esc(q({ path: e.path }))}">${esc(t.cancel)}</a></p></form>`;
    const page = Math.max(0, Math.floor(Number(query.page) || 0));
    let body = "";
    if (kind === "docx") {
      const d = openDocx(bytes); const ps = kids(d.body, NS.w, "p");
      if (query.target !== undefined) { const p = ps[Number(query.target)]; body = p ? form(String(query.target), `${t.paragraph} ${Number(query.target) + 1}`, paragraphText(p), true) : ""; }
      else body = `<ul>${ps.slice(page * 50, page * 50 + 50).map((p, i) => ({ p, i: page * 50 + i })).filter(({ p }) => paragraphText(p).trim()).map(({ p, i }) => `<li><span class="${paragraphHeadingLevel(d, p) ? "h" : ""}">${i + 1}. ${esc(paragraphText(p).slice(0, 160))}</span><a class="btn" href="${esc(q({ path: e.path, target: String(i) }))}">${esc(t.edit)}</a></li>`).join("")}</ul>${ps.length > (page + 1) * 50 ? `<p><a class="btn" href="${esc(q({ path: e.path, page: String(page + 1) }))}">${esc(t.more)}</a></p>` : ""}`;
    } else if (kind === "xlsx") {
      const wb = openXlsx(bytes); const tab = query.tab && wb.sheets.some((s) => s.name === query.tab) ? query.tab : wb.sheets[0].name;
      const quoted = `'${tab.replace(/'/g, "''")}'`;
      if (query.target) { const cur = readRange(wb, String(query.target), "FORMULA").values[0]?.[0] ?? ""; body = form(String(query.target), `${t.cell} ${query.target}`, cur, false); }
      else {
        const r1 = page * 100 + 1; const vals = readRange(wb, `${quoted}!A${r1}:Z${r1 + 99}`).values;
        const tabs = wb.sheets.map((s) => `<a class="btn" href="${esc(q({ path: e.path, tab: s.name }))}">${esc(s.name)}</a>`).join(" ");
        body = `<p>${esc(t.tab)}: ${tabs}</p><table><tbody>${vals.map((row, i) => `<tr><th>${r1 + i}</th>${row.map((v, j) => `<td><a href="${esc(q({ path: e.path, tab, target: `${quoted}!${colName(j + 1)}${r1 + i}` }))}">${esc(v) || "·"}</a></td>`).join("")}</tr>`).join("")}</tbody></table>${vals.length === 100 ? `<p><a class="btn" href="${esc(q({ path: e.path, tab, page: String(page + 1) }))}">${esc(t.more)}</a></p>` : ""}`;
      }
    } else {
      const slides = readDeck(openPptx(bytes), false);
      if (query.target) { const sh = slides.flatMap((s) => s.shapes).find((x) => x.object_id === query.target); body = sh ? form(String(query.target), t.slide, sh.text, true) : ""; }
      else body = slides.map((s, i) => `<h3>${esc(t.slide)} ${i + 1}: ${esc(s.title)}</h3><ul>${s.shapes.filter((x) => x.text).map((x) => `<li><span>${esc(x.text.slice(0, 160))}</span><a class="btn" href="${esc(q({ path: e.path, target: x.object_id }))}">${esc(t.edit)}</a></li>`).join("")}</ul>`).join("");
    }
    return `${STYLE}<div class="wq"><p><a class="btn" href="${esc(q({ path: joinPath(segs.slice(0, -1)) }))}">${esc(t.up)}</a> <strong>${esc(e.name)}</strong></p>${notice}${body}${await versionsBlock(cfg, t, csrf, e)}</div>`;
  } catch (err) {
    const msg = err instanceof WsError ? (Object.hasOwn(t, `err_${err.code}`) ? t[`err_${err.code}`] : err.message) : "unexpected error";
    return `${STYLE}<div class="wq">${notice}<p class="note">${esc(t.errorPrefix)} ${esc(msg)}</p><p><a class="btn" href="${esc(q({}))}">${esc(t.up)}</a></p></div>`;
  }
}

/** K5: the change was queued (the file is open). No choice is needed; the override sits behind its own confirm. */
export function renderQueued({ lang, csrf, form, r }) {
  const t = strings(lang);
  const who = (r.open_by || []).join(", ") || t.someone;
  return standalone(lang, t.tabQuick, `<p><strong>${esc(who)}</strong> ${esc(t.queuedP)}</p>
${postForm("cancel", csrf, { path: form.path, change_id: r.change_id }, t.cancelChange)}
<details><summary>${esc(t.applyNow)}</summary><p>${esc(t.applyNowP)}</p>
${postForm("save", csrf, { ...keepOf(form), if_open: "force_close", cancel_first: r.change_id }, t.applyYes)}</details>
<p><a href="${esc(q({ path: form.path }))}">${esc(t.back)}</a></p>`);
}

/** A save that could not be queued (e.g. a person's manual lock): offer Try again, and the override only when allowed. */
export function renderChoice({ lang, csrf, form, err }) {
  const t = strings(lang);
  const who = (err.data?.open_by || []).join(", ") || t.someone;
  return standalone(lang, t.tabQuick, `<p><strong>${esc(who)}</strong> ${esc(t.openBy)}</p>
${postForm("save", csrf, keepOf(form), t.tryAgain)}
${err.data?.can_proceed ? postForm("save", csrf, { ...keepOf(form), if_open: "force_close" }, t.saveAnyway) : `<p>${esc(err.message)}</p>`}
<p><a href="${esc(q({ path: form.path }))}">${esc(t.cancel)}</a></p>`);
}
