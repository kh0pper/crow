/**
 * How the Install / Configure forms present a manifest's env_vars (config-friction
 * stage 1). Pure: shared by the Extensions page render and the friction tests.
 *
 *   hidden     generate:* keys — Crow mints them; never shown, never sent
 *   advanced   folded under a collapsed "Advanced" section:
 *                - `advanced: true` in the manifest (opt-in), or
 *                - automatically: not required AND has a non-blank default
 *              `advanced: false` opts a field out of the automatic rule. A field that
 *              is required with no default (or is a required secret, whose default the
 *              browser never receives) always stays visible — it needs a human,
 *              whatever the manifest says.
 */

const nonBlank = (v) => v !== undefined && v !== null && String(v).trim() !== "";

export function isAdvancedEnvVar(ev) {
  if (!ev || typeof ev !== "object") return false;
  if (ev.required && !nonBlank(ev.default)) return false;
  // A secret's default is never sent to the browser, so a required secret always shows.
  if (ev.required && ev.secret) return false;
  if (ev.advanced === true) return true;
  if (ev.advanced === false) return false;
  return !ev.required && nonBlank(ev.default);
}

/** env_vars the browser may see: installer-generated secrets are never shown or sent. */
export function visibleEnvVars(addon) {
  return (addon?.env_vars || []).filter((ev) => ev && typeof ev.name === "string" && !ev.generate);
}

/**
 * The one browser shape of a field, for the Install button's data attribute AND the
 * detail modal's registry blob. A secret's manifest default is never sent.
 */
export function formEnvVar(ev) {
  return {
    name: ev.name,
    description: ev.description,
    default: ev.secret ? "" : (ev.default || ""),
    required: ev.required,
    secret: !!ev.secret,
    advanced: isAdvancedEnvVar(ev),
    // Configure builds its form from the registry blob: it needs the same opt-ins as Install.
    generatable: ev.generatable === true,
    keychain: ev.keychain === true,
    keychain_configure: ev.keychain_configure === false ? false : undefined,
    pattern: typeof ev.pattern === "string" ? ev.pattern : undefined,
  };
}

export function formEnvVars(addon) {
  return visibleEnvVars(addon).map(formEnvVar);
}

/** Visible fields a typical install shows unfolded (the human's part of the form). */
export function primaryEnvVars(addon) {
  return visibleEnvVars(addon).filter((ev) => !isAdvancedEnvVar(ev));
}
