/**
 * Crow Artifacts — the viewer page (spec v1.6 D25, plan PR-2 Task 2.1):
 * `/dashboard/artifacts/view/:id[?v=n&thread=t]`.
 *
 * A standalone document (no dashboard chrome): the Perch hub shows it beside
 * a chat (split pane or phone sheet, same-origin iframe) or in a new window.
 * It is the ONLY page that frames the artifact origin. Its headers:
 *  - `content-security-policy: viewerCsp(<origin>)` — the ONE core policy
 *    (servers/gateway/artifact-origin/policy.js): frame-src is only the
 *    artifact origin's /v/ path, frame-ancestors 'self' (the hub frames it);
 *  - no-store.
 * viewer.js additionally refuses to show content unless that policy is
 * proven in force (the CSP canary), and drives the navigation tripwire and
 * D24. viewer-client.js draws everything else; every authored string is
 * placed with textContent there. This module only escapes attributes.
 */
export const VIEWER_STRINGS = {
  en: {
    title: "Artifact", version: "Version", current: "current", proposed: "proposed", flagged_v: "flagged",
    made_by: "made by {bot} · this content can't see your Crow", you: "you", bot: "bot",
    comment: "Comment", commenting: "Click what you want to comment on", send_n: "Send {n} comments to chat", send_1: "Send 1 comment to chat",
    send_none: "No comments to send", send_go: "Send to chat", add_comment: "Add comment", cancel: "Cancel", comments_n: "{n} comments", comments_1: "1 comment",
    no_comments: "No comments yet. Turn on Comment and click what you want changed.",
    more: "More", reload: "Reload view", reload_note: "Reloading the view starts it fresh (anything you typed inside it is lost).",
    sections: "Sections", pick_section: "Comment on a section", quote: "Exact words (optional)",
    open_chat: "Open chat", close: "Close",
    tripped: "This version tried to leave its frame. It was closed and flagged.", flagged_note: "Flagged versions are never shown again. Pick another version.",
    retry_title: "Couldn't load this artifact.", retry: "Retry",
    scripts_off: "Shaped by someone outside your Crow, so its scripts are off.", run_scripts: "Run scripts",
    preview_title: "Send these comments to the chat?", contact_thread: "From a contact — off unless you include it", include: "Include",
    round_running: "A round is already running", revising: "{bot} is working on your comments…", ready: "Version {n} is ready", show_v: "Show version {n}",
    proposed_note: "Version {n} is proposed", accept: "Make it current", drop: "Drop it",
    no_session: "The bot isn't running. How should it get your comments?", new_session: "Start a new Perch session", board_card: "Create a board card",
    queued: "Waiting for a free session", delivery_failed: "The bot couldn't get your comments ({e}).",
    resolved: "resolved", moved: "anchor moved", csp_missing: "This page isn't protected yet. Reload it to view the artifact.",
    unavailable: "The artifact view is not set up on this instance.", weaker: "On this install the artifact view shares the dashboard's host name, so its isolation is weaker.",
    fallback_remote: "Artifacts on this install can only be shown on the machine Crow runs on.",
    never_password: "Crow never asks for your password inside an artifact.", gone: "This artifact is gone.", pin: "Comment {n}",
    nav: "Leave the artifact", library: "Library", nest: "Crow's Nest",
    edit: "Edit", delete: "Delete", save: "Save", edited: "edited", delete_confirm: "Delete this comment?",
    locked_note: "This comment is with the bot right now. You can change it when the bot is done.",
  },
  es: {
    title: "Artefacto", version: "Versión", current: "actual", proposed: "propuesta", flagged_v: "marcada",
    made_by: "hecho por {bot} · este contenido no puede ver tu Crow", you: "tú", bot: "bot",
    comment: "Comentar", commenting: "Haz clic en lo que quieras comentar", send_n: "Enviar {n} comentarios al chat", send_1: "Enviar 1 comentario al chat",
    send_none: "No hay comentarios para enviar", send_go: "Enviar al chat", add_comment: "Añadir comentario", cancel: "Cancelar", comments_n: "{n} comentarios", comments_1: "1 comentario",
    no_comments: "Aún no hay comentarios. Activa Comentar y haz clic en lo que quieras cambiar.",
    more: "Más", reload: "Recargar vista", reload_note: "Recargar la vista la reinicia (se pierde lo que escribiste dentro).",
    sections: "Secciones", pick_section: "Comentar una sección", quote: "Palabras exactas (opcional)",
    open_chat: "Abrir chat", close: "Cerrar",
    tripped: "Esta versión intentó salir de su marco. Se cerró y quedó marcada.", flagged_note: "Las versiones marcadas no se vuelven a mostrar. Elige otra versión.",
    retry_title: "No se pudo cargar este artefacto.", retry: "Reintentar",
    scripts_off: "Lo influyó alguien fuera de tu Crow, así que sus scripts están desactivados.", run_scripts: "Ejecutar scripts",
    preview_title: "¿Enviar estos comentarios al chat?", contact_thread: "De un contacto: no se envía salvo que lo incluyas", include: "Incluir",
    round_running: "Ya hay una ronda en curso", revising: "{bot} está trabajando en tus comentarios…", ready: "La versión {n} está lista", show_v: "Mostrar la versión {n}",
    proposed_note: "La versión {n} está propuesta", accept: "Hacerla actual", drop: "Descartarla",
    no_session: "El bot no está activo. ¿Cómo debe recibir tus comentarios?", new_session: "Iniciar una sesión nueva en Perch", board_card: "Crear una tarjeta en el tablero",
    queued: "Esperando una sesión libre", delivery_failed: "El bot no pudo recibir tus comentarios ({e}).",
    resolved: "resuelto", moved: "ancla movida", csp_missing: "Esta página aún no está protegida. Recárgala para ver el artefacto.",
    unavailable: "La vista de artefactos no está configurada en esta instancia.", weaker: "En esta instalación la vista comparte el nombre de host del panel, así que su aislamiento es más débil.",
    fallback_remote: "Los artefactos de esta instalación solo pueden verse en la máquina donde corre Crow.",
    never_password: "Crow nunca te pide la contraseña dentro de un artefacto.", gone: "Este artefacto ya no existe.", pin: "Comentario {n}",
    nav: "Salir del artefacto", library: "Biblioteca", nest: "Nido del Cuervo",
    edit: "Editar", delete: "Eliminar", save: "Guardar", edited: "editado", delete_confirm: "¿Eliminar este comentario?",
    locked_note: "Este comentario está con el bot ahora mismo. Podrás cambiarlo cuando el bot termine.",
  },
};

export const ARTIFACT_ID_RE = /^art_[A-Za-z0-9_-]{6,40}$/;
export const THREAD_PARAM_RE = /^[A-Za-z0-9_-]{1,80}$/;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The page's query, validated: v a positive integer, thread a plain id. */
export function viewerParams(query = {}) {
  const v = typeof query.v === "string" && /^[1-9]\d{0,5}$/.test(query.v) ? Number(query.v) : null;
  const thread = typeof query.thread === "string" && THREAD_PARAM_RE.test(query.thread) ? query.thread : null;
  return { v, thread };
}

/** The page's headers: the core viewerCsp (frame-ancestors 'self' included). */
export function viewerHeaders(viewerCsp, origin) {
  return { "content-security-policy": viewerCsp(origin), "cache-control": "no-store", "referrer-policy": "same-origin" };
}

export function renderViewerPage({ lang = "en", id, v = null, thread = null }) {
  const L = lang === "es" ? "es" : "en";
  const T = VIEWER_STRINGS[L];
  return `<!doctype html>
<html lang="${L}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="turbo-visit-control" content="reload">
<meta name="referrer" content="same-origin">
<title>${esc(T.title)}</title>
<link rel="stylesheet" href="/artifacts/static/viewer.css">
</head><body>
<div id="crow-artifact-viewer" data-lang="${L}" data-artifact="${esc(id)}" data-version="${v == null ? "" : esc(v)}" data-thread="${thread == null ? "" : esc(thread)}" data-strings="${esc(JSON.stringify(T))}"></div>
<script src="/artifacts/static/viewer.js"></script>
<script src="/artifacts/static/viewer-client.js"></script>
</body></html>`;
}
