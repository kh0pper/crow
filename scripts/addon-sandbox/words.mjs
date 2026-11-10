/**
 * Every word an add-on's wall status can show, in one leaf module (no imports).
 *
 * The status page, the Nest card, the boot notice, the change watch and the
 * profile labels all read their text from here, so two surfaces can never
 * disagree about what one add-on's state is called. English is the source of
 * truth; a language this module does not know falls back to English.
 *
 * An add-on is "walled" or "not walled". The word "contained" is never used for
 * an add-on.
 */

/** The per-add-on status word. */
export const WALL_WORDS = Object.freeze({
  walled: { en: "walled", es: "aislado" },
  crowDb: { en: "not walled: shares Crow's database", es: "no aislado: comparte la base de datos de Crow" },
  storage: { en: "not walled: can use all of Crow's storage", es: "no aislado: puede usar todo el almacenamiento de Crow" },
  owner: { en: "not walled (your choice)", es: "no aislado (tu elección)" },
  hostOff: { en: "not walled (switched off for this computer)", es: "no aislado (desactivado en este equipo)" },
  killSwitch: { en: "not walled (switched off by the operator)", es: "no aislado (desactivado por el operador)" },
  noBwrap: { en: "not walled on this computer; docker reachable", es: "no aislado en este equipo; docker accesible" },
  backend: { en: "not walled (approved commands)", es: "no aislado (comandos aprobados)" },
  failed: { en: "off: it could not run inside its wall", es: "apagado: no pudo ejecutarse dentro de su aislamiento" },
  stopped: { en: "off: it stopped", es: "apagado: se detuvo" },
});

/** What a walled add-on still reaches beyond its wall. */
export const RESIDUAL_LINE = Object.freeze({
  en: "Bots' and satellites' copies of add-ons, and approved data backends, are not walled.",
  es: "Las copias de los complementos en bots y satélites, y los orígenes de datos aprobados, no están aisladas.",
});

/** The one summary sentence the status page, the settings block and the Nest card share. */
export const SUMMARY = Object.freeze({
  killSwitch: {
    en: "Add-ons: walls switched off by the operator (CROW_ADDON_WALLS=off)",
    es: "Complementos: aislamiento desactivado por el operador (CROW_ADDON_WALLS=off)",
  },
  noBwrap: {
    en: "Add-ons: not walled off on this computer; docker reachable",
    es: "Complementos: no aislados en este equipo; docker accesible",
  },
  hostOff: {
    en: "Add-ons: not walled (switched off for this computer)",
    es: "Complementos: no aislados (desactivado en este equipo)",
  },
  none: { en: "Add-ons: none running here", es: "Complementos: no hay ninguno en ejecución" },
  allWalled: { en: "Add-ons: walled off", es: "Complementos: aislados" },
  counts: { en: "Add-ons: {n} of {m} walled off", es: "Complementos: {n} de {m} aislados" },
});

/** The bell notifications and the card that points at them. */
export const NOTICE = Object.freeze({
  bootTitle: { en: "Some add-ons are not walled", es: "Algunos complementos no están aislados" },
  walledTitle: {
    en: "Add-ons now run inside walls on this computer",
    es: "Ahora los complementos se ejecutan aislados en este equipo",
  },
  outsideTitle: {
    en: "Add-on wall settings were changed outside Crow",
    es: "La configuración de aislamiento de complementos se cambió fuera de Crow",
  },
  killSwitchLine: {
    en: "Kill switch (CROW_ADDON_WALLS=off): {state}",
    es: "Interruptor de emergencia (CROW_ADDON_WALLS=off): {state}",
  },
  stateOn: { en: "on", es: "activado" },
  stateOff: { en: "off", es: "desactivado" },
  noChoice: { en: "no choice", es: "sin elección" },
  otherChanged: {
    en: "Other wall settings in addon-walls.json changed",
    es: "Otros ajustes de aislamiento en addon-walls.json cambiaron",
  },
  label: { en: "Add-on walls", es: "Aislamiento de complementos" },
  action: { en: "Check add-ons", es: "Revisar complementos" },
});

/** The two ways one sandbox line opens, depending on whether walls are on here. */
export const SANDBOX_LINE = Object.freeze({
  walled: { en: "This add-on can: ", es: "Este complemento puede: " },
  unwalled: { en: "When walled, this add-on can: ", es: "Cuando esté aislado, este complemento puede: " },
});

/** The one language this module speaks besides English. */
export function langOf(lang) {
  return lang === "es" ? "es" : "en";
}

/** `{ en, es }` in `lang`, falling back to English. */
export function langText(text, lang) {
  if (!text || typeof text !== "object") return "";
  const value = text[langOf(lang)];
  return typeof value === "string" ? value : (typeof text.en === "string" ? text.en : "");
}

/** Replace every `{name}` in `text` with `vars[name]`. */
export function fillText(text, vars = {}) {
  return String(text ?? "").replace(/\{(\w+)\}/g, (all, key) =>
    vars && Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : all);
}

/** One add-on status word in `lang`. */
export function wallWord(key, lang = "en") {
  const word = WALL_WORDS[key];
  return word ? langText(word, lang) : "";
}

/**
 * The phrases one profile part is shown as. The first entries are the words the
 * generated profiles (`registry/addon-profiles.json`) are built from, byte for
 * byte; the last two describe a host the owner has not filled in yet, and the
 * storage residual a walled add-on still carries.
 */
export function labelPhrase(part) {
  switch (part?.kind) {
    case "internet":
      return ["use the internet", "usar internet"];
    case "local-host":
      return [`reach ${part.label} on this computer`, `acceder a ${part.label} en este equipo`];
    case "network-host":
      return [`reach ${part.host}:${part.port} on your network`, `acceder a ${part.host}:${part.port} en tu red`];
    case "door":
      return [`talk to Crow's ${part.id} door`, `hablar con la puerta ${part.id} de Crow`];
    case "own-folder":
      return ["keep files in its own folder", "guardar archivos en su propia carpeta"];
    case "oauth-dir":
      return ["use the sign-in folder you chose", "usar la carpeta de inicio de sesión que elegiste"];
    case "crow-db":
      return ["can read Crow's stored keys and change its database", "puede leer las claves guardadas de Crow y cambiar su base de datos"];
    case "pending-host":
      return ["reach the address you enter below", "acceder a la dirección que ingreses abajo"];
    case "storage":
      return ["can use all of Crow's storage", "puede usar todo el almacenamiento de Crow"];
    default:
      return ["", ""];
  }
}

/** The LAN-shaped part kinds a not-yet-known address sits behind. */
const NETWORK_KINDS = new Set(["internet", "local-host", "network-host"]);

/**
 * One sentence about what an add-on can reach, from a derived profile.
 *
 * `walled` false says "When walled, …": a manifest-only profile (the install
 * modal, an add-on whose wall is off) must never claim a limit nothing enforces.
 * `pendingHostFields` are the address fields the owner has not filled in yet:
 * they fold into ONE phrase, right after the network parts.
 */
export function sandboxLine(profile, lang = "en", { walled = true, pendingHostFields = [], residuals = [] } = {}) {
  const idx = langOf(lang) === "es" ? 1 : 0;
  const parts = Array.isArray(profile?.labelParts) ? profile.labelParts.filter((p) => p && typeof p === "object") : [];
  const closed = parts.filter((p) => p.kind !== "crow-db");
  const hasCrowDb = parts.some((p) => p.kind === "crow-db");

  let insertAt = 0;
  for (let i = 0; i < closed.length; i++) {
    if (NETWORK_KINDS.has(closed[i].kind)) insertAt = i + 1;
  }
  if (Array.isArray(pendingHostFields) && pendingHostFields.length > 0) {
    closed.splice(insertAt, 0, { kind: "pending-host" });
  }
  for (const residual of Array.isArray(residuals) ? residuals : []) {
    if (residual && typeof residual.kind === "string") closed.push({ kind: residual.kind });
  }
  if (hasCrowDb) closed.push({ kind: "crow-db" });

  const phrases = closed.map((part) => labelPhrase(part)[idx]).filter((phrase) => phrase);
  const prefix = langText(walled ? SANDBOX_LINE.walled : SANDBOX_LINE.unwalled, lang);
  return prefix + phrases.join("; ");
}