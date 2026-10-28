/**
 * Who is acting on a Workspace document, for the w:author of the comments Crow writes. Sources, in order:
 * the process env of a pi bot's stdio server (CROW_ACTOR_KIND/_BOT_ID/_BOT_NAME), then the MCP request's
 * `_meta["crow/actor"]` (a gateway-run bot call, kind "bot"; or a paired instance's call, kind "peer", which the gateway
 * builds from its own row for that instance), then the owner's env (CROW_OWNER_NAME). Never the tool arguments.
 */
import { appImport } from "./app-root.js";

const { sanitizeActorName } = await appImport("scripts/pi-bots/actor-env.mjs");

const botActor = (id, name) => {
  const clean = sanitizeActorName(name, id);
  // A bot that sanitizes to nothing must still read as a bot, never fall through to the owner or "Crow".
  return { kind: "bot", id: String(id ?? ""), name: clean || "bot" };
};

// A peer's name never carries parentheses, so it cannot fake a nested label ("x (bot from y)").
const peerActor = (instance, from) => ({
  kind: "peer",
  instance: typeof instance === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(instance) ? instance : "",
  from: sanitizeActorName(String(from ?? "").replace(/[()]/g, ""), ""),
});

/** → {kind:"bot", id, name} | {kind:"peer", instance, from} | {kind:"owner", name} | null. Order: env bot, `_meta` bot,
 *  `_meta` peer, env owner. A bot is never shadowed by an owner env, and a peer's call is never the owner. */
export function resolveActor(env = {}, extra) {
  if (env?.CROW_ACTOR_KIND === "bot") return botActor(env.CROW_ACTOR_BOT_ID, env.CROW_ACTOR_BOT_NAME);
  const m = extra?._meta?.["crow/actor"];
  if (m && typeof m === "object" && m.kind === "bot") return botActor(m.id, m.name);
  if (m && typeof m === "object" && m.kind === "peer") return peerActor(m.instance, m.from);
  if (env?.CROW_ACTOR_KIND === "owner") { const name = sanitizeActorName(env.CROW_OWNER_NAME, ""); return name ? { kind: "owner", name } : null; }
  return null;
}

/** The comment author and initials for an actor (null, or a peer with no name → "Crow"). */
export function authorFor(actor) {
  if (actor?.kind === "peer") return { author: actor.from ? `Crow (via ${actor.from})` : "Crow", initials: "C" };
  if (actor?.kind === "bot" && actor.name) return { author: `${actor.name} (bot)`, initials: `${Array.from(actor.name).slice(0, 2).join("").toUpperCase()}B` };
  if (actor?.kind === "owner" && actor.name) return { author: actor.name, initials: actor.name.split(/\s+/).filter(Boolean).map((w) => Array.from(w)[0]).join("").toUpperCase().slice(0, 3) };
  return { author: "Crow", initials: "C" };
}
