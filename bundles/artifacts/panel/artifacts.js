/**
 * Crow Artifacts — the Library (spec v1.6 D27; plan PR-2 Task 2.5).
 * COPIED ALONE to $CROW_HOME/panels/artifacts.js: no relative imports.
 *
 * The Library lists artifacts; opening one goes to the viewer page
 * (`/dashboard/artifacts/view/:id`, served by the bundle's routes), the ONE
 * page that frames the artifact origin. This page frames nothing and sends NO
 * CSP of its own: it is a Turbo page, and Turbo keeps the first document's
 * policy across visits — a narrowed policy here would ride into the next
 * panel (e.g. block the Perch hub's same-origin viewer pane). The
 * gateway-wide policy applies. An old deep link (`?id=art_…`, e.g. a notification's
 * action_url) is redirected to the viewer page. PR-3 (D27): badges, search
 * and filters, and a detail drawer (Versions, Linked chats, Projects and
 * Sharing stubs, Audit); every authored string is placed with textContent by
 * panel-client.js.
 */
export const ARTIFACTS_STRINGS = {
  en: {
    title: "Artifacts", empty: "No artifacts yet. Ask a bot to make a page, a document or a diagram.",
    weaker: "On this install the artifact view shares the dashboard's host name, so its isolation is weaker.",
    fallback_remote: "Artifacts on this install can only be shown on the machine Crow runs on.",
    unavailable: "The artifact view is not set up on this instance.", made_by: "made by {bot}",
    search: "Search artifacts", all_types: "All types", t_page: "Page", t_document: "Document", t_diagram: "Diagram",
    all_states: "Any state", st_scripts_off: "Scripts off", st_contact: "Contact comments", st_linked: "Linked to a chat", no_match: "Nothing matches.",
    open: "Open", details: "Details", close: "Close", contact_n: "{n} contact comments", links_n: "{n} linked chats", scripts_off: "scripts off",
    tab_versions: "Versions", tab_links: "Linked chats", tab_projects: "Projects", tab_sharing: "Sharing", tab_audit: "Audit",
    v_current: "current", v_proposed: "proposed", v_past: "earlier", v_tainted: "shaped outside your Crow", v_flagged: "flagged", approve: "Approve",
    open_chat: "Open chat", unlink: "Unlink", no_links: "Not linked to any chat.", asleep: "stopped",
    soon_projects: "Adding artifacts to projects is coming soon.", soon_sharing: "Sharing artifacts with contacts is coming soon.",
    no_audit: "Nothing recorded yet.", failed: "That didn't work. Try again.",
  },
  es: {
    title: "Artefactos", empty: "Aún no hay artefactos. Pídele a un bot que haga una página, un documento o un diagrama.",
    weaker: "En esta instalación la vista comparte el nombre de host del panel, así que su aislamiento es más débil.",
    fallback_remote: "Los artefactos de esta instalación solo pueden verse en la máquina donde corre Crow.",
    unavailable: "La vista de artefactos no está configurada en esta instancia.", made_by: "hecho por {bot}",
    search: "Buscar artefactos", all_types: "Todos los tipos", t_page: "Página", t_document: "Documento", t_diagram: "Diagrama",
    all_states: "Cualquier estado", st_scripts_off: "Scripts desactivados", st_contact: "Comentarios de contactos", st_linked: "Vinculado a un chat", no_match: "Nada coincide.",
    open: "Abrir", details: "Detalles", close: "Cerrar", contact_n: "{n} comentarios de contactos", links_n: "{n} chats vinculados", scripts_off: "scripts desactivados",
    tab_versions: "Versiones", tab_links: "Chats vinculados", tab_projects: "Proyectos", tab_sharing: "Compartir", tab_audit: "Auditoría",
    v_current: "actual", v_proposed: "propuesta", v_past: "anterior", v_tainted: "influida desde fuera de tu Crow", v_flagged: "marcada", approve: "Aprobar",
    open_chat: "Abrir chat", unlink: "Desvincular", no_links: "No está vinculado a ningún chat.", asleep: "detenido",
    soon_projects: "Pronto podrás añadir artefactos a proyectos.", soon_sharing: "Pronto podrás compartir artefactos con tus contactos.",
    no_audit: "Aún no hay registros.", failed: "No funcionó. Inténtalo de nuevo.",
  },
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const ID_RE = /^art_[A-Za-z0-9_-]{6,40}$/;

export default {
  id: "artifacts",
  name: "Artifacts",
  icon: "layers",
  route: "/dashboard/artifacts",
  navOrder: 125,
  category: "productivity",

  async handler(req, res, { layout, lang }) {
    const L = lang === "es" ? "es" : "en";
    // Old deep links (?id=) open the viewer page.
    if (typeof req.query?.id === "string" && ID_RE.test(req.query.id)) {
      return res.redirect(302, "/dashboard/artifacts/view/" + encodeURIComponent(req.query.id));
    }
    const content = `
      <link rel="stylesheet" href="/artifacts/static/panel.css">
      <div id="crow-artifacts" data-lang="${L}" data-strings="${esc(JSON.stringify(ARTIFACTS_STRINGS[L]))}"></div>
      <script src="/artifacts/static/panel-client.js"></script>`;
    res.send(layout({ title: ARTIFACTS_STRINGS[L].title, content }));
  },
};
