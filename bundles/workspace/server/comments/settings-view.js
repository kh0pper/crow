/** Office > Setup > "Comments to Crow" card (comment loop, Phase 1): server-rendered, no client script, all values escaped. */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const COMMENT_STRINGS = {
  en: {
    title: "Comments to Crow",
    intro: "Shadow mode only writes what Crow would do to a log. It never replies and never changes a document.",
    scope: "Crow only sees documents shared with Crow bot.",
    modeLegend: "Mode",
    off: "Off", shadow: "Shadow (logs only)",
    since: "Watching since",
    save: "Save",
    pausedPrefix: "Paused:",
    blocked_duplicate_display_name: "another account has the same display name as the owner.",
    blocked_other: "a safety check failed.",
    remedy: "Change that account's display name, then press Check again.",
    recheck: "Check again",
    notice_blocked: "Paused: fix the display name problem first, then try again.",
    notice_unblocked: "The check passed. The pause is cleared.",
    notice_still_blocked: "Another account still has the same display name as the owner.",
    notice_recheck_failed: "The check could not run. The pause stays on. Try again later.",
    notice_env_blocked: "The check passed, but the setup still marks it as paused. Run the Workspace setup again.",
    notice_saved: "Saved.",
    notice_not_yet: "Crow replying to comments is not available yet.",
    notice_bad_mode: "That mode is not valid.",
    notice_error: "Could not save. Finish the Workspace setup and try again.",
  },
  es: {
    title: "Comentarios para Crow",
    intro: "El modo sombra solo anota en un registro lo que Crow haría. Nunca responde ni cambia un documento.",
    scope: "Crow solo ve los documentos compartidos con Crow bot.",
    modeLegend: "Modo",
    off: "Apagado", shadow: "Sombra (solo registra)",
    since: "Vigilando desde",
    save: "Guardar",
    pausedPrefix: "En pausa:",
    blocked_duplicate_display_name: "otra cuenta tiene el mismo nombre visible que el dueño.",
    blocked_other: "falló una revisión de seguridad.",
    remedy: "Cambia el nombre visible de esa cuenta y luego pulsa Revisar de nuevo.",
    recheck: "Revisar de nuevo",
    notice_blocked: "En pausa: primero corrige el problema del nombre visible y vuelve a intentarlo.",
    notice_unblocked: "La revisión pasó. Se quitó la pausa.",
    notice_still_blocked: "Otra cuenta sigue teniendo el mismo nombre visible que el dueño.",
    notice_recheck_failed: "No se pudo hacer la revisión. La pausa sigue. Inténtalo más tarde.",
    notice_env_blocked: "La revisión pasó, pero la configuración aún la marca en pausa. Vuelve a ejecutar la configuración de Workspace.",
    notice_saved: "Guardado.",
    notice_not_yet: "Que Crow responda a los comentarios aún no está disponible.",
    notice_bad_mode: "Ese modo no es válido.",
    notice_error: "No se pudo guardar. Termina la configuración de Workspace y vuelve a intentarlo.",
  },
};

const day = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)).toISOString().slice(0, 10) : "");

/** → html. `watch` is the workspace_comment_watch row (mode, watch_since); `blocked` a reason code or "". */
export function renderCommentSettings({ lang, csrf, watch, blocked, notice }) {
  const t = COMMENT_STRINGS[lang === "es" ? "es" : "en"];
  const mode = watch?.mode === "shadow" ? "shadow" : "off"; // Phase 1 has no other choice to show
  const radio = (v) => `<label style="display:flex;align-items:center;gap:.6rem;min-height:44px"><input type="radio" name="mode" value="${v}" style="width:44px;height:44px;margin:0"${mode === v ? " checked" : ""}> <span>${esc(t[v])}</span></label>`;
  const since = mode === "shadow" && day(watch?.watch_since) ? `<p>${esc(t.since)} ${esc(day(watch.watch_since))}</p>` : "";
  const dup = blocked === "duplicate_display_name";
  const why = blocked ? `<p class="ws-note"><strong>${esc(t.pausedPrefix)}</strong> ${esc(dup ? t.blocked_duplicate_display_name : t.blocked_other)}${dup ? ` ${esc(t.remedy)}` : ""}</p>` : "";
  const recheck = dup ? `<form method="post" action="/api/workspace/comments/recheck"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button type="submit" style="min-height:44px;padding:.55rem .9rem;font-size:1rem">${esc(t.recheck)}</button></form>` : "";
  const note = notice && t[`notice_${notice}`] ? `<p class="ws-note">${esc(t[`notice_${notice}`])}</p>` : "";
  return `<div class="ws-card"><h2>${esc(t.title)}</h2>${note}<p>${esc(t.intro)}</p><p>${esc(t.scope)}</p>${why}${recheck}${since}
<form method="post" action="/api/workspace/comments/mode"><input type="hidden" name="_csrf" value="${esc(csrf)}"><fieldset style="border:0;padding:0;margin:0"><legend>${esc(t.modeLegend)}</legend>${radio("off")}${radio("shadow")}</fieldset>
<button type="submit" style="min-height:44px;padding:.55rem .9rem;font-size:1rem">${esc(t.save)}</button></form></div>`;
}
