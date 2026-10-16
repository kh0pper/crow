/**
 * The player bar on first-party pages WITHOUT the dashboard layout (bar on every Crow page, 2026-10-16):
 * the artifact viewer and the markdown file viewer. The dashboard keeps its layout path
 * (dashboard/index.js → renderLayout); this is the same bar and the same script, verbatim.
 *
 * RULE: only a route that has ALREADY passed dashboardAuth may emit this fragment. Never a route that
 * answers anonymously, never a public page (/blog, /kb, playlists, songbook), never anything reachable
 * through Tailscale Funnel (tests/player-shell-exposure.test.js keeps the list of callers).
 *
 * playerShellHtml(lang, { dark }) → one fragment to place just before </body>:
 *   1. the design tokens (custom properties only) and a zero sidebar offset on the bar (no sidebar here);
 *      dark: true pins the bar to the dark token set (a page that is dark whatever the OS says);
 *   2. playerBarHtml(lang);
 *   3. a guard that runs BEFORE the player: inside a frame (Perch's "Open beside chat") the bar is
 *      removed, so the player exits at once — the hosting page already has the tab's one player;
 *   4. playerBarJs(lang);
 *   5. the reserve script: --crow-player-h on <html> is the bar's height while it shows, else 0px, so a
 *      page pads its content and bottom sheets with var(--crow-player-h,0px). Installs once per document.
 */
import { designTokensCss } from "./design-tokens.js";
import { playerBarHtml, playerBarJs } from "./player.js";

/** The dark :root declarations of the one token source, scoped to the bar. */
function darkBarTokens() {
  const m = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/.exec(designTokensCss());
  return m ? "#crow-player-bar{color-scheme:dark;" + m[1].trim().replace(/\s+/g, " ") + "}" : "";
}

const FRAME_GUARD = `if (window.top !== window) { var b = document.getElementById('crow-player-bar'); if (b && b.parentNode) b.parentNode.removeChild(b); }`;

const RESERVE = `(function () {
  var root = document.documentElement;
  if (root.getAttribute('data-crow-player-reserve') === '1') return;
  root.setAttribute('data-crow-player-reserve', '1');
  var bar = document.getElementById('crow-player-bar');
  function set() {
    var shown = !!bar && bar.isConnected !== false && bar.style.display !== 'none';
    root.style.setProperty('--crow-player-h', (shown ? (bar.offsetHeight || 0) : 0) + 'px');
  }
  set();
  if (!bar) return;
  try { new MutationObserver(set).observe(bar, { attributes: true, attributeFilter: ['style'], childList: true, subtree: true }); } catch (e) {}
  window.addEventListener('resize', set);
})();`;

export function playerShellHtml(lang = "en", { dark = false } = {}) {
  return `<style>${designTokensCss()}
#crow-player-bar{--crow-sidebar-width:0px}${dark ? "\n" + darkBarTokens() : ""}</style>
${playerBarHtml(lang)}
<script>${FRAME_GUARD}</script>
<script>${playerBarJs(lang)}</script>
<script>${RESERVE}</script>`;
}
