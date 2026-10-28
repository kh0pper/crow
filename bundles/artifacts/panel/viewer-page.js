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
    no_comments_doc: "No comments yet. Select the words you want changed.",
    more: "More", reload: "Reload view", reload_note: "Reloading the view starts it fresh (anything you typed inside it is lost).",
    sections: "Sections", pick_section: "Comment on a section", quote: "Exact words (optional)",
    open_chat: "Open chat", close: "Close",
    tripped: "This version tried to leave its frame. It was closed and flagged.", flagged_note: "Flagged versions are never shown again. Pick another version.",
    retry_title: "Couldn't load this artifact.", retry: "Retry",
    scripts_off: "Shaped by someone outside your Crow, so its scripts are off.", run_scripts: "Run scripts",
    preview_title: "Send these comments to the chat?", contact_thread: "From a contact — off unless you include it", include: "Include",
    outside_note: "This includes words from outside your Crow, so it goes to a new, locked chat with {bot} (Artifacts tools only), not to a chat picked below.",
    round_running: "A round is already running", revising: "{bot} is working on your comments…", ready: "Version {n} is ready", show_v: "Show version {n}",
    proposed_note: "Version {n} is proposed", accept: "Make it current", drop: "Drop it",
    send_to: "Send to", this_chat: "This chat", a_chat: "Chat {id}", asleep_note: "stopped", new_chat: "New chat with {bot}", board_card: "Create a board card",
    pick_where: "Where should the bot get your comments?",
    queued: "Waiting for a free session", delivery_failed: "The bot couldn't get your comments ({e}).",
    resolved: "resolved", moved: "anchor moved", csp_missing: "This page isn't protected yet. Reload it to view the artifact.",
    unavailable: "The artifact view is not set up on this instance.", weaker: "On this install the artifact view shares the dashboard's host name, so its isolation is weaker.",
    fallback_remote: "Artifacts on this install can only be shown on the machine Crow runs on.",
    never_password: "Crow never asks for your password inside an artifact.", gone: "This artifact is gone.", pin: "Comment {n}",
    nav: "Leave the artifact", library: "Library", nest: "Crow's Nest", library_title: "Artifacts",
    edit: "Edit", delete: "Delete", save: "Save", edited: "edited", delete_confirm: "Delete this comment?",
    locked_note: "This comment is with the bot right now. You can change it when the bot is done.",
    why_target_unlinked: "That chat isn't linked to this artifact anymore.", why_target_asleep: "That chat is asleep. Open it and Send again.",
    why_target_locked: "That chat is limited to one feedback round.", why_target_no_access: "That bot can't work on this artifact.",
    why_target_other_bot: "That chat belongs to another bot.", why_target_not_bots_chat: "That chat belongs to another bot.",
    why_bot_lacks_artifacts: "The bot no longer has the Artifacts tools.",
    comment_selection: "Comment on \u201c{q}\u201d", cant_show: "This version can't be shown right now. Reload the page.",
    let_bot: "Let a bot work on this", grant_title: "Which other bots can work on this?", grant_none: "No other bot has the Artifacts tools.",
    grant_note: "A bot you tick can read and revise this artifact and ask to link it to its chats.", done: "Done",
    cardLink: "Card #{n}", openChat: "Open the chat", backMake: "Make", backChat: "Chat",
    reply: "Reply", sentTo: "Sent to {bot}", busy: "{bot} is already working on this document. Try again when it finishes.",
    mention_not_found: "No bot called @{name}.", mention_forbidden: "@{name} can't open this document.",
    mention_failed: "That didn't reach @{name}. Try again.", mention_stopped: "@{name} couldn't start on this thread. {why}",
  },
  es: {
    title: "Artefacto", version: "Versión", current: "actual", proposed: "propuesta", flagged_v: "marcada",
    made_by: "hecho por {bot} · este contenido no puede ver tu Crow", you: "tú", bot: "bot",
    comment: "Comentar", commenting: "Haz clic en lo que quieras comentar", send_n: "Enviar {n} comentarios al chat", send_1: "Enviar 1 comentario al chat",
    send_none: "No hay comentarios para enviar", send_go: "Enviar al chat", add_comment: "Añadir comentario", cancel: "Cancelar", comments_n: "{n} comentarios", comments_1: "1 comentario",
    no_comments: "Aún no hay comentarios. Activa Comentar y haz clic en lo que quieras cambiar.",
    no_comments_doc: "Aún no hay comentarios. Selecciona las palabras que quieras cambiar.",
    more: "Más", reload: "Recargar vista", reload_note: "Recargar la vista la reinicia (se pierde lo que escribiste dentro).",
    sections: "Secciones", pick_section: "Comentar una sección", quote: "Palabras exactas (opcional)",
    open_chat: "Abrir chat", close: "Cerrar",
    tripped: "Esta versión intentó salir de su marco. Se cerró y quedó marcada.", flagged_note: "Las versiones marcadas no se vuelven a mostrar. Elige otra versión.",
    retry_title: "No se pudo cargar este artefacto.", retry: "Reintentar",
    scripts_off: "Lo influyó alguien fuera de tu Crow, así que sus scripts están desactivados.", run_scripts: "Ejecutar scripts",
    preview_title: "¿Enviar estos comentarios al chat?", contact_thread: "De un contacto: no se envía salvo que lo incluyas", include: "Incluir",
    outside_note: "Incluye palabras de fuera de tu Crow, así que va a un chat nuevo y bloqueado con {bot} (solo herramientas de Artefactos), no a un chat elegido abajo.",
    round_running: "Ya hay una ronda en curso", revising: "{bot} está trabajando en tus comentarios…", ready: "La versión {n} está lista", show_v: "Mostrar la versión {n}",
    proposed_note: "La versión {n} está propuesta", accept: "Hacerla actual", drop: "Descartarla",
    send_to: "Enviar a", this_chat: "Este chat", a_chat: "Conversación {id}", asleep_note: "detenido", new_chat: "Chat nuevo con {bot}", board_card: "Crear una tarjeta en el tablero",
    pick_where: "¿Dónde debe recibir el bot tus comentarios?",
    queued: "Esperando una sesión libre", delivery_failed: "El bot no pudo recibir tus comentarios ({e}).",
    resolved: "resuelto", moved: "ancla movida", csp_missing: "Esta página aún no está protegida. Recárgala para ver el artefacto.",
    unavailable: "La vista de artefactos no está configurada en esta instancia.", weaker: "En esta instalación la vista comparte el nombre de host del panel, así que su aislamiento es más débil.",
    fallback_remote: "Los artefactos de esta instalación solo pueden verse en la máquina donde corre Crow.",
    never_password: "Crow nunca te pide la contraseña dentro de un artefacto.", gone: "Este artefacto ya no existe.", pin: "Comentario {n}",
    nav: "Salir del artefacto", library: "Biblioteca", nest: "Nido del Cuervo", library_title: "Artefactos",
    edit: "Editar", delete: "Eliminar", save: "Guardar", edited: "editado", delete_confirm: "¿Eliminar este comentario?",
    locked_note: "Este comentario está con el bot ahora mismo. Podrás cambiarlo cuando el bot termine.",
    why_target_unlinked: "Ese chat ya no está vinculado a este artefacto.", why_target_asleep: "Ese chat está dormido. Ábrelo y vuelve a enviar.",
    why_target_locked: "Ese chat está limitado a una sola ronda de comentarios.", why_target_no_access: "Ese bot no puede trabajar en este artefacto.",
    why_target_other_bot: "Ese chat pertenece a otro bot.", why_target_not_bots_chat: "Ese chat pertenece a otro bot.",
    why_bot_lacks_artifacts: "El bot ya no tiene las herramientas de Artefactos.",
    comment_selection: "Comentar \u201c{q}\u201d", cant_show: "Esta versión no se puede mostrar ahora. Recarga la página.",
    let_bot: "Dejar que un bot trabaje en esto", grant_title: "¿Qué otros bots pueden trabajar en esto?", grant_none: "Ningún otro bot tiene las herramientas de Artefactos.",
    grant_note: "Un bot que marques puede leer y revisar este artefacto y pedir vincularlo a sus chats.", done: "Listo",
    cardLink: "Tarjeta #{n}", openChat: "Abrir el chat", backMake: "Crear", backChat: "Chat",
    reply: "Responder", sentTo: "Enviado a {bot}", busy: "{bot} ya está trabajando en este documento. Inténtalo cuando termine.",
    mention_not_found: "No hay ningún bot llamado @{name}.", mention_forbidden: "@{name} no puede abrir este documento.",
    mention_failed: "No le llegó a @{name}. Inténtalo de nuevo.", mention_stopped: "@{name} no pudo empezar con este hilo. {why}",
  },
};

export const ARTIFACT_ID_RE = /^art_[A-Za-z0-9_-]{6,40}$/;
export const THREAD_PARAM_RE = /^[A-Za-z0-9_-]{1,80}$/;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The shell tab a viewer was opened from (`?from=`): only these two, anything else is null. */
export const BACK_VALUES = Object.freeze(["make", "chat"]);
/** The only card links the header draws: the card drawer (or no-JS card view) on the board. */
const CARD_HREF_RE = /^\/dashboard\/bot-board[?#][A-Za-z0-9_.~%=&#?-]*$/;

/** The page's query, validated: v a positive integer, thread a plain id, back make|chat. */
export function viewerParams(query = {}) {
  const v = typeof query.v === "string" && /^[1-9]\d{0,5}$/.test(query.v) ? Number(query.v) : null;
  const thread = typeof query.thread === "string" && THREAD_PARAM_RE.test(query.thread) ? query.thread : null;
  const back = typeof query.from === "string" && BACK_VALUES.includes(query.from) ? query.from : null;
  return { v, thread, back };
}

/** The page's headers: the core viewerCsp (frame-ancestors 'self' included). */
export function viewerHeaders(viewerCsp, origin) {
  return { "content-security-policy": viewerCsp(origin), "cache-control": "no-store", "referrer-policy": "same-origin" };
}

/** "‹ Make" or "‹ Chat" (the shell tab the viewer was opened from), or "". */
function backHtml(T, back, thread) {
  if (back === "make") return `<a class="cv-back" id="cv-back" href="/dashboard/make">\u2039 ${esc(T.backMake)}</a>`;
  if (back === "chat") return `<a class="cv-back" id="cv-back" href="${thread ? `/dashboard/perch#${esc(thread)}` : "/dashboard/perch"}">\u2039 ${esc(T.backChat)}</a>`;
  return "";
}

/**
 * The document's card (P6): "Card #n <title>" into the card's drawer, plus "Open the chat"
 * when the card has a conversation that isn't already this page's thread. The title is
 * bot/operator text, escaped here. Links target the top window (the hub frames this page).
 */
function cardHtml(T, card, thread) {
  if (!card || !/^[1-9]\d*$/.test(String(card.id)) || typeof card.href !== "string" || !CARD_HREF_RE.test(card.href)) return "";
  const n = String(card.id);
  const lane = typeof card.lane === "string" && /^[a-z_]{1,20}$/.test(card.lane) ? ` data-lane="${card.lane}"` : "";
  const title = card.title ? ` <span class="cv-card-t">${esc(card.title)}</span>` : "";
  const chat = typeof card.thread === "string" && THREAD_PARAM_RE.test(card.thread) && card.thread !== thread
    ? `<a class="cv-card-chat" href="/dashboard/perch#${esc(card.thread)}" target="_top">${esc(T.openChat)}</a>` : "";
  return `<div class="cv-cardrow" id="cv-cardrow" data-card="${n}"${lane}><a class="cv-card" href="${esc(card.href)}" target="_top"><span class="cv-card-n">${esc(T.cardLink.replace("{n}", n))}</span>${title}</a>${chat}</div>`;
}

/**
 * shellHtml: the core player-bar shell (servers/gateway/dashboard/shared/player-shell.js), passed in by the
 * route, which has already passed dashboardAuth. Empty on an older core: the page then has no bar.
 * back: "make"|"chat"|null (viewerParams' `from`): the way back to the shell tab.
 * card: the route's `{ id, title, lane, href, thread }` or null. viewer-client.js moves both
 * into its bar and header; nothing is built from them on the client.
 */
export function renderViewerPage({ lang = "en", id, v = null, thread = null, back = null, card = null, shellHtml = "" }) {
  const L = lang === "es" ? "es" : "en";
  const T = VIEWER_STRINGS[L];
  const links = backHtml(T, back, thread) + cardHtml(T, card, thread);
  return `<!doctype html>
<html lang="${L}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="turbo-visit-control" content="reload">
<meta name="referrer" content="same-origin">
<title>${esc(T.title)}</title>
<link rel="stylesheet" href="/artifacts/static/viewer.css">
</head><body>
${links ? `<div id="cv-links" hidden>${links}</div>\n` : ""}<div id="crow-artifact-viewer" data-lang="${L}" data-artifact="${esc(id)}" data-version="${v == null ? "" : esc(v)}" data-thread="${thread == null ? "" : esc(thread)}" data-strings="${esc(JSON.stringify(T))}"></div>
<script src="/artifacts/static/viewer.js"></script>
<script src="/artifacts/static/viewer-client.js"></script>
${shellHtml}
</body></html>`;
}
