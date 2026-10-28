/**
 * Who is acting on a Workspace document, for the w:author of the comments Crow writes. Sources, in order:
 * the process env (a pi bot's stdio server: CROW_ACTOR_KIND/_BOT_ID/_BOT_NAME, or the owner's CROW_OWNER_NAME), then
 * the MCP request's `_meta["crow/actor"]` (a gateway-run bot call; kind "bot" only). Never the tool arguments.
 */
import { appImport } from "./app-root.js";

const { sanitizeActorName } = await appImport("scripts/pi-bots/actor-env.mjs");

const botActor = (id, name) => {
  const clean = sanitizeActorName(name, id);
  return clean ? { kind: "bot", id: String(id ?? ""), name: clean } : null;
};

/** → {kind:"bot", id, name} | {kind:"owner", name} | null. An env that names a kind decides alone. */
export function resolveActor(env = {}, extra) {
  const kind = env?.CROW_ACTOR_KIND;
  if (kind === "bot") return botActor(env.CROW_ACTOR_BOT_ID, env.CROW_ACTOR_BOT_NAME);
  if (kind === "owner") { const name = sanitizeActorName(env.CROW_OWNER_NAME, ""); return name ? { kind: "owner", name } : null; }
  const m = extra?._meta?.["crow/actor"];
  if (m && typeof m === "object" && m.kind === "bot") return botActor(m.id, m.name);
  return null;
}

/** The comment author and initials for an actor (null → "Crow"). */
export function authorFor(actor) {
  if (actor?.kind === "bot" && actor.name) return { author: `${actor.name} (bot)`, initials: `${Array.from(actor.name).slice(0, 2).join("").toUpperCase()}B` };
  if (actor?.kind === "owner" && actor.name) return { author: actor.name, initials: actor.name.split(/\s+/).filter(Boolean).map((w) => Array.from(w)[0]).join("").toUpperCase().slice(0, 3) };
  return { author: "Crow", initials: "C" };
}
