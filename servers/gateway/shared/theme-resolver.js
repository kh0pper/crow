/**
 * Theme Resolver — Resolves effective theme state from settings.
 *
 * Used by blog-public.js, songbook.js, and layout.js to compute
 * theme classes from dashboard_settings values.
 */

/**
 * Resolve the effective theme for a given surface.
 * @param {object} settings - Settings object with theme_mode, theme_glass, etc.
 * @param {string} [surface] - "dashboard" or "blog" (omit for global)
 * @returns {{ mode: string, glass: boolean, serif: boolean }}
 */
export function resolveTheme(settings, surface) {
  const globalMode = settings.theme_mode || "dark";
  const mode = (surface && settings[`theme_${surface}_mode`]) || globalMode;
  const glass = settings.theme_glass === "true";
  const serif = settings.theme_serif !== "false"; // default ON
  return { mode, glass, serif };
}

/**
 * Build CSS class string from resolved theme.
 * @param {{ mode: string, glass: boolean, serif: boolean }} theme
 * @returns {string}
 */
export function themeClasses({ mode, glass, serif }) {
  const classes = [];
  if (mode === "light") classes.push("theme-light");
  if (glass) classes.push("theme-glass");
  if (serif) classes.push("theme-serif");
  return classes.join(" ");
}
