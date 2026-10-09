/**
 * Crow Artifacts — dashboard panel (the trusted side, spec §3.3, §5.1).
 * COPIED ALONE to $CROW_HOME/panels/artifacts.js: no relative imports; app
 * modules are imported by absolute file:// URL (phone/ramble pattern).
 *
 * The page is a shell; panel-client.js draws the list and the viewer frame
 * (via viewer.js). The comment rail and the round preview arrive with step 3.
 * All user- and contact-authored text is set with textContent on the client —
 * never HTML.
 *
 * CSP: the gateway's global policy allows `frame-src 'self' https:`. The
 * artifact origin on its own https hostname fits that. The loopback fallback
 * (http://localhost:<port>) does not, so this page sends the core
 * `viewerCsp()` (servers/gateway/artifact-origin/policy.js — ONE definition,
 * shared with the isolation tests) adding the configured origin to frame-src,
 * and asks Turbo for a full reload (turbo-visit-control) so that header is
 * the one the document runs under. viewer.js additionally refuses to show
 * content unless that policy is proven in force (the CSP canary).
 */
export const ARTIFACTS_STRINGS = {
  en: {
    title: "Artifacts", empty: "No artifacts yet. Ask a bot to make a page, a document or a diagram.",
    made_by: "made by {bot} · this content can't see your Crow", comment_mode: "Comment mode",
    send_feedback: "Send feedback", ask_now: "Ask the bot now", add_comment: "Add comment", cancel: "Cancel",
    preview_title: "Send these threads to the bot?", contact_thread: "From a contact — off unless you include it",
    include: "Include", round_running: "A round is already running", revising: "{bot} is revising… (round {n})",
    ready: "Version {n} is ready", tripped: "This version tried to leave its frame. It was closed and flagged.",
    weaker: "On this install the artifact view shares the dashboard's host name, so its isolation is weaker.",
    fallback_remote: "Artifacts on this install can only be shown on the machine Crow runs on.",
    unavailable: "The artifact view is not set up on this instance.", proposed: "Proposed version {n}",
    accept: "Make it current", drop: "Drop it", new_session: "Start a new Perch session", board_card: "Create a board card",
    no_session: "The bot isn't running. How should it get your feedback?", queued: "Waiting for a free session",
    reload_note: "Reloading the view starts it fresh (anything you typed inside it is lost).", reload: "Reload view",
    blocks: "Sections", pick_block: "Pick a section to comment on", quote: "Exact words (optional)",
    never_password: "Crow never asks for your password inside an artifact.", resolved: "resolved", moved: "anchor moved",
    scripts_off: "This version was shaped by someone outside your Crow, so its scripts are off.", run_scripts: "Run this version's scripts",
    csp_missing: "This page isn't protected yet. Reload it to view artifacts.",
  },
  es: {
    title: "Artefactos", empty: "Aún no hay artefactos. Pídele a un bot que haga una página, un documento o un diagrama.",
    made_by: "hecho por {bot} · este contenido no puede ver tu Crow", comment_mode: "Modo comentario",
    send_feedback: "Enviar comentarios", ask_now: "Preguntar al bot ahora", add_comment: "Añadir comentario", cancel: "Cancelar",
    preview_title: "¿Enviar estos hilos al bot?", contact_thread: "De un contacto: no se envía salvo que lo incluyas",
    include: "Incluir", round_running: "Ya hay una ronda en curso", revising: "{bot} está revisando… (ronda {n})",
    ready: "La versión {n} está lista", tripped: "Esta versión intentó salir de su marco. Se cerró y quedó marcada.",
    weaker: "En esta instalación la vista comparte el nombre de host del panel, así que su aislamiento es más débil.",
    fallback_remote: "Los artefactos de esta instalación solo pueden verse en la máquina donde corre Crow.",
    unavailable: "La vista de artefactos no está configurada en esta instancia.", proposed: "Versión propuesta {n}",
    accept: "Hacerla actual", drop: "Descartarla", new_session: "Iniciar una sesión nueva en Perch", board_card: "Crear una tarjeta en el tablero",
    no_session: "El bot no está activo. ¿Cómo debe recibir tus comentarios?", queued: "Esperando una sesión libre",
    reload_note: "Recargar la vista la reinicia (se pierde lo que escribiste dentro).", reload: "Recargar vista",
    blocks: "Secciones", pick_block: "Elige una sección para comentar", quote: "Palabras exactas (opcional)",
    never_password: "Crow nunca te pide la contraseña dentro de un artefacto.", resolved: "resuelto", moved: "ancla movida",
    scripts_off: "Esta versión la influyó alguien fuera de tu Crow, así que sus scripts están desactivados.", run_scripts: "Ejecutar los scripts de esta versión",
    csp_missing: "Esta página aún no está protegida. Recárgala para ver artefactos.",
  },
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The app's own module by absolute path — panels are copied alone at install. */
function appModule(rel) {
  const root = process.env.CROW_APP_ROOT || process.cwd();
  return import(new URL(rel, "file://" + root + "/").href);
}

// Fail closed: without the core policy, frame-src is 'none' and nothing can
// be framed (the canary in viewer.js then refuses to show any content).
const NO_FRAME_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";

export default {
  id: "artifacts",
  name: "Artifacts",
  icon: "layers",
  route: "/dashboard/artifacts",
  navOrder: 125,
  category: "productivity",

  async handler(req, res, { layout, lang }) {
    const L = lang === "es" ? "es" : "en";
    let origin = null;
    let csp = NO_FRAME_CSP;
    try {
      const [rt, pol] = await Promise.all([
        appModule("servers/gateway/artifact-origin/runtime.js"),
        appModule("servers/gateway/artifact-origin/policy.js"),
      ]);
      origin = rt.artifactOriginInfo()?.baseUrl || null;
      csp = pol.viewerCsp(origin);
    } catch { /* fail closed: NO_FRAME_CSP */ }
    res.setHeader("content-security-policy", csp);
    const id = typeof req.query?.id === "string" && /^art_[A-Za-z0-9_-]{6,40}$/.test(req.query.id) ? req.query.id : "";
    // turbo-visit-control lives in <head> (Turbo reads it only there), so a
    // Turbo visit becomes a full load under THIS page's CSP. viewer.js also
    // refuses to show content unless that CSP is proven in force (canary).
    const head = '<meta name="turbo-visit-control" content="reload">';
    const content = `
      <link rel="stylesheet" href="/artifacts/static/panel.css">
      <div id="crow-artifacts" data-lang="${L}" data-artifact="${esc(id)}" data-strings="${esc(JSON.stringify(ARTIFACTS_STRINGS[L]))}"></div>
      <script src="/artifacts/static/viewer.js"></script>
      <script src="/artifacts/static/panel-client.js"></script>`;
    res.send(layout({ title: ARTIFACTS_STRINGS[L].title, content, head }));
  },
};
