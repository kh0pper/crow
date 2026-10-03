/**
 * Crow's Nest Panel — "Office": the Crow Workspace setup page (W1 §4.5).
 *
 * Server-rendered, no client script. Reads ONLY four non-secret keys from the installed
 * bundle's .env and renders a value only if it passes the same shell-safe patterns the
 * manifest enforces (the admin block is copy-pasted into a terminal). Named "Office" so
 * the sidebar never reads "Workspace › Workspace". Copied alone to
 * $CROW_HOME/panels/workspace.js, so it imports nothing from the bundle.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

// The installer quotes .env values (bundle-env-codec.js); decode them the same way. This
// file runs from $CROW_HOME/panels/, so the app root comes from CROW_APP_ROOT (set by the
// gateway), falling back to the in-repo location for tests.
const __wsAppRoot = (() => {
  const ok = (p) => !!p && existsSync(join(p, "servers", "db.js"));
  const guess = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return ok(process.env.CROW_APP_ROOT) ? process.env.CROW_APP_ROOT : guess;
})();
const { parseEnvText } = await import(pathToFileURL(join(__wsAppRoot, "servers", "gateway", "bundle-env-codec.js")).href);

const T = {
  en: {
    title: "Office",
    subtitle: "Your private office: files, documents, calendars and contacts.",
    notReady: "Workspace is not fully set up yet. Finish the setup by running this command in a terminal on the machine that hosts Crow, then reopen this page:",
    addressH: "Your Workspace address",
    addressP: "Open it in a browser on any device that is on your tailnet. Sign in with your Workspace account (not your Crow password).",
    appPwH: "One app password per device",
    appPwP: "In Workspace: your avatar → Settings → Security → Devices & sessions → Create new app password. Use it instead of your real password on phones and sync apps, so a lost device can be cut off on its own.",
    androidH: "Android",
    androidFiles: "Files: install the Nextcloud app and sign in with this server address:",
    androidDav: "Calendars and contacts: install DAVx⁵, choose “Login with URL and user name”, and paste this base URL:",
    androidDav2: "Pick the calendars (including Menu) and address books to sync. They appear in your phone's normal Calendar and Contacts apps.",
    appleH: "iPhone, iPad and Mac",
    appleP: "Settings → Calendar → Accounts → Add Account → Other → Add CalDAV Account. Server:",
    appleP2: "Do the same under Contacts with “Add CardDAV Account” and the same server. User name: your Workspace login. Password: an app password.",
    laptopH: "Laptop",
    laptopP: "Use the address above in your browser. To keep folders on disk, the Nextcloud desktop client (nextcloud.com/install) can sync them.",
    tailnetNote: "Workspace only works while the device is connected to your tailnet (Tailscale on). It is never reachable from the public internet.",
    officeP: "Document editor address (Workspace opens it for you):",
    adminH: "For the admin",
    serveP: "Run once on this machine to publish Workspace on your tailnet. Never use “tailscale funnel” for these:",
    backupP: "Turn on nightly encrypted backups (shows the backup passphrase once; keep it offline):",
    userP: "Add a household account yourself (prints a one-time password):",
    uninstallP: "Uninstalling keeps your files and database in ~/.crow/workspace, the generated secrets (${CROW_HOME}/secrets/bundle-env/workspace.env, kept so a reinstall can reopen your data), the backup timer and the tailnet addresses. \"Delete data\" does not remove those bind-mounted files. Before uninstalling, disable the backup timer first, then remove the Serve mappings:",
  },
  es: {
    title: "Office",
    subtitle: "Tu oficina privada: archivos, documentos, calendarios y contactos.",
    notReady: "Workspace todavía no está completamente configurado. Termina la configuración ejecutando este comando en una terminal de la máquina que aloja Crow y vuelve a abrir esta página:",
    addressH: "La dirección de tu Workspace",
    addressP: "Ábrela en el navegador de cualquier dispositivo conectado a tu tailnet. Entra con tu cuenta de Workspace (no con tu contraseña de Crow).",
    appPwH: "Una contraseña de aplicación por dispositivo",
    appPwP: "En Workspace: tu avatar → Configuración → Seguridad → Dispositivos y sesiones → Crear nueva contraseña de aplicación. Úsala en lugar de tu contraseña real en teléfonos y apps de sincronización, así un dispositivo perdido se puede desconectar por separado.",
    androidH: "Android",
    androidFiles: "Archivos: instala la app de Nextcloud y entra con esta dirección de servidor:",
    androidDav: "Calendarios y contactos: instala DAVx⁵, elige “Iniciar sesión con URL y nombre de usuario” y pega esta URL base:",
    androidDav2: "Elige los calendarios (incluido Menu) y las libretas de direcciones que quieras sincronizar. Aparecen en las apps normales de Calendario y Contactos del teléfono.",
    appleH: "iPhone, iPad y Mac",
    appleP: "Ajustes → Calendario → Cuentas → Añadir cuenta → Otra → Añadir cuenta CalDAV. Servidor:",
    appleP2: "Haz lo mismo en Contactos con “Añadir cuenta CardDAV” y el mismo servidor. Usuario: tu login de Workspace. Contraseña: una contraseña de aplicación.",
    laptopH: "Computadora",
    laptopP: "Usa la dirección de arriba en tu navegador. Para tener carpetas en el disco, el cliente de escritorio de Nextcloud (nextcloud.com/install) puede sincronizarlas.",
    tailnetNote: "Workspace solo funciona mientras el dispositivo está conectado a tu tailnet (Tailscale activado). Nunca es accesible desde internet público.",
    officeP: "Dirección del editor de documentos (Workspace la abre por ti):",
    adminH: "Para el administrador",
    serveP: "Ejecuta una vez en esta máquina para publicar Workspace en tu tailnet. Nunca uses “tailscale funnel” para esto:",
    backupP: "Activa las copias de seguridad cifradas cada noche (muestra la frase de cifrado una sola vez; guárdala fuera de línea):",
    userP: "Agrega tú mismo una cuenta del hogar (muestra una contraseña de un solo uso):",
    uninstallP: "Desinstalar conserva tus archivos y la base de datos en ~/.crow/workspace, los secretos generados (${CROW_HOME}/secrets/bundle-env/workspace.env, se guardan para que una reinstalación pueda reabrir tus datos), el temporizador de copias y las direcciones de la tailnet. \"Borrar datos\" no elimina esos archivos montados. Antes de desinstalar, desactiva primero el temporizador de copias y luego quita las asignaciones de Serve:",
  },
};
export { T as WORKSPACE_STRINGS };

const PUBLIC_KEYS = ["WORKSPACE_BOOTSTRAP_DONE", "WORKSPACE_PUBLIC_HOST", "WORKSPACE_NC_SERVE_PORT", "WORKSPACE_OO_SERVE_PORT", "WORKSPACE_ADMIN_USER"];
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const PORT_RE = /^[0-9]{2,5}$/;
// Shell-safe rendering of a path: bare when it has only safe characters, else single-quoted.
const shq = (s) => (/^[A-Za-z0-9_\/.@+:-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
const NC_HOST_PORT = 3070;
const OO_HOST_PORT = 3071;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function readPublicSettings(crowHome) {
  const p = join(crowHome, "bundles", "workspace", ".env");
  if (!existsSync(p)) return null;
  const all = parseEnvText(readFileSync(p, "utf8"));
  const out = {};
  for (const k of PUBLIC_KEYS) if (Object.hasOwn(all, k)) out[k] = all[k];
  return out;
}

export function workspaceUrls(s) {
  const rawHost = (s && s.WORKSPACE_PUBLIC_HOST) || "";
  const host = HOST_RE.test(rawHost) ? rawHost : "";
  const ncPort = PORT_RE.test((s && s.WORKSPACE_NC_SERVE_PORT) || "") ? s.WORKSPACE_NC_SERVE_PORT : "8456";
  const ooPort = PORT_RE.test((s && s.WORKSPACE_OO_SERVE_PORT) || "") ? s.WORKSPACE_OO_SERVE_PORT : "8457";
  const nc = `https://${host}:${ncPort}`;
  return { host, ncPort, ooPort, nc, dav: `${nc}/remote.php/dav`, office: `https://${host}:${ooPort}/` };
}

export function renderWorkspacePage(settings, lang, crowHome = join(homedir(), ".crow")) {
  const opsDir = shq(join(crowHome, "bundles", "workspace", "ops"));
  const t = T[lang === "es" ? "es" : "en"];
  const style = `<style>
    .ws-panel h1 { margin: 0 0 .25rem; font-size: 1.5rem; }
    .ws-sub { color: var(--crow-text-muted); margin: 0 0 1rem; }
    .ws-card { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border); border-radius: 10px; padding: .9rem 1rem; margin-bottom: 1rem; }
    .ws-card h2 { font-size: 1.05rem; margin: 0 0 .5rem; }
    .ws-card code, .ws-card pre { background: var(--crow-bg-surface, var(--crow-bg)); border-radius: 4px; padding: .1rem .4rem; overflow-wrap: anywhere; }
    .ws-card pre { padding: .5rem .6rem; white-space: pre-wrap; }
    .ws-note { border-left: 3px solid var(--crow-accent); }
  </style>`;
  const u = workspaceUrls(settings);
  if (!settings || !u.host || settings.WORKSPACE_BOOTSTRAP_DONE !== "1") {
    return `${style}<div class="ws-panel"><h1>${esc(t.title)}</h1><p class="ws-sub">${esc(t.subtitle)}</p><div class="ws-card ws-note"><p>${esc(t.notReady)}</p><pre>bash ${esc(opsDir)}/bootstrap.sh</pre></div></div>`;
  }
  const card = (h, body) => `<div class="ws-card"><h2>${esc(h)}</h2>${body}</div>`;
  return `${style}<div class="ws-panel">
    <h1>${esc(t.title)}</h1><p class="ws-sub">${esc(t.subtitle)}</p>
    <div class="ws-card ws-note"><p>${esc(t.tailnetNote)}</p></div>
    ${card(t.addressH, `<p><a href="${esc(u.nc)}" target="_blank" rel="noopener">${esc(u.nc)}</a></p><p>${esc(t.addressP)}</p><p>${esc(t.officeP)} <code>${esc(u.office)}</code></p>`)}
    ${card(t.appPwH, `<p>${esc(t.appPwP)}</p>`)}
    ${card(t.androidH, `<p>${esc(t.androidFiles)} <code>${esc(u.nc)}</code></p><p>${esc(t.androidDav)} <code>${esc(u.dav)}</code></p><p>${esc(t.androidDav2)}</p>`)}
    ${card(t.appleH, `<p>${esc(t.appleP)} <code>${esc(u.dav)}</code></p><p>${esc(t.appleP2)}</p>`)}
    ${card(t.laptopH, `<p>${esc(t.laptopP)}</p>`)}
    ${card(t.adminH, `<p>${esc(t.serveP)}</p><pre>sudo tailscale serve --bg --https=${u.ncPort} http://127.0.0.1:${NC_HOST_PORT}
sudo tailscale serve --bg --https=${u.ooPort} http://127.0.0.1:${OO_HOST_PORT}</pre>
      <p>${esc(t.backupP)}</p><pre>bash ${esc(opsDir)}/install-backup-timer.sh --dest &lt;backup folder&gt; --mount &lt;drive mountpoint&gt;</pre>
      <p>${esc(t.userP)}</p><pre>bash ${esc(opsDir)}/add-user.sh &lt;login&gt; "&lt;Name&gt;"</pre>
      <p>${esc(t.uninstallP)}</p><pre>systemctl --user disable --now crow-workspace-backup.timer
sudo tailscale serve --https=${u.ncPort} off
sudo tailscale serve --https=${u.ooPort} off</pre>`)}
  </div>`;
}

export default {
  id: "workspace",
  name: "Office",
  icon: "files",
  route: "/dashboard/workspace",
  navOrder: 58,
  category: "productivity",
  async handler(req, res, { layout, lang }) {
    const crowHome = process.env.CROW_HOME || join(homedir(), ".crow");
    const t = T[lang === "es" ? "es" : "en"];
    res.send(layout({ title: t.title, content: renderWorkspacePage(readPublicSettings(crowHome), lang, crowHome) }));
  },
};
