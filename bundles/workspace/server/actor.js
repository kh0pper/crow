/**
 * Who is acting on a Workspace document, for the w:author of the comments Crow writes. Sources, in order:
 * the process env of a pi bot's stdio server (CROW_ACTOR_KIND/_BOT_ID/_BOT_NAME), then the MCP request's
 * `_meta["crow/actor"]` (a gateway-run bot call, kind "bot"; or a paired instance's call, kind "peer", which the gateway
 * builds from its own row for that instance), then the owner's env (CROW_OWNER_NAME). Never the tool arguments.
 *
 * A `_meta` bot WITH `instance` is a paired instance's bot (0.4.3, item 46 PR-B): that instance's gateway signed
 * which of its bots made the call and this gateway verified it, then forwarded {kind:"bot", id:"<bot>@<instance>",
 * name, instance, from}. It reads "<name> (bot from <from>)", never a local "<name> (bot)" and never the owner.
 */
import { createHash } from "node:crypto";
import { appImport } from "./app-root.js";

const { sanitizeActorName } = await appImport("scripts/pi-bots/actor-env.mjs");

const botActor = (id, name) => {
  const clean = sanitizeActorName(name, id);
  // A bot that sanitizes to nothing must still read as a bot, never fall through to the owner or "Crow".
  return { kind: "bot", id: String(id ?? ""), name: clean || "bot" };
};

// A peer's name never carries parentheses, so it cannot fake a nested label ("x (bot from y)"). The gateway's
// trailing " [hex]" suffix is what tells two same-named peers apart, so the 40-character cap shortens the
// name part and never cuts the suffix.
const PEER_SUFFIX_RE = /^(.*) \[([0-9a-f]{8,64})\]$/s;
function peerFrom(raw) {
  const clean = (s) => sanitizeActorName(String(s ?? "").replace(/[()]/g, ""), "");
  const m = PEER_SUFFIX_RE.exec(String(raw ?? ""));
  if (!m) return clean(raw);
  const suffix = ` [${m[2]}]`;
  const room = Math.max(0, 40 - suffix.length);
  const base = Array.from(clean(m[1])).slice(0, room).join("").trim();
  return base ? `${base}${suffix}` : suffix.trim();
}
const INSTANCE_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const peerActor = (instance, from) => ({
  kind: "peer",
  instance: typeof instance === "string" && INSTANCE_RE.test(instance) ? instance : "",
  from: peerFrom(from),
});

// A paired instance's bot. Its name, like a peer's `from`, never carries parentheses or brackets, so it cannot
// fake a nested label. An `instance` that is not a valid id fails toward the peer form, never a local bot.
function remoteBotActor(m) {
  if (typeof m.instance !== "string" || !INSTANCE_RE.test(m.instance)) return peerActor("", m.from);
  const id = String(m.id ?? "");
  const name = sanitizeActorName(String(m.name ?? "").replace(/[()[\]]/g, ""), "").replace(/ +/g, " ").trim() || "bot";
  return { kind: "bot", id, name, instance: m.instance, from: peerFrom(m.from) };
}

/** → {kind:"bot", id, name} | {kind:"bot", id, name, instance, from} (a paired instance's bot) |
 *  {kind:"peer", instance, from} | {kind:"owner", name} | null. Order: env bot, `_meta` bot, `_meta` peer, env owner.
 *  A bot is never shadowed by an owner env, and a peer's call (or a peer's bot) is never the owner. */
export function resolveActor(env = {}, extra) {
  if (env?.CROW_ACTOR_KIND === "bot") return botActor(env.CROW_ACTOR_BOT_ID, env.CROW_ACTOR_BOT_NAME);
  const m = extra?._meta?.["crow/actor"];
  if (m && typeof m === "object" && m.kind === "bot") return m.instance !== undefined ? remoteBotActor(m) : botActor(m.id, m.name);
  if (m && typeof m === "object" && m.kind === "peer") return peerActor(m.instance, m.from);
  if (env?.CROW_ACTOR_KIND === "owner") { const name = sanitizeActorName(env.CROW_OWNER_NAME, ""); return name ? { kind: "owner", name } : null; }
  return null;
}

const botInitials = (name) => `${Array.from(name).slice(0, 2).join("").toUpperCase()}B`;

/** The comment author and initials for an actor (null, or a peer with no name → "Crow"). A paired instance's bot
 *  with no usable `from` reads "Crow (via peer [<8 hex of sha256(instance)>])", never "<name> (bot)". */
export function authorFor(actor) {
  if (actor?.kind === "bot" && actor.instance) {
    if (actor.from && actor.name) return { author: `${actor.name} (bot from ${actor.from})`, initials: botInitials(actor.name) };
    const h = createHash("sha256").update(String(actor.instance)).digest("hex").slice(0, 8);
    return { author: `Crow (via peer [${h}])`, initials: "C" };
  }
  if (actor?.kind === "peer") return { author: actor.from ? `Crow (via ${actor.from})` : "Crow", initials: "C" };
  if (actor?.kind === "bot" && actor.name) return { author: `${actor.name} (bot)`, initials: botInitials(actor.name) };
  if (actor?.kind === "owner" && actor.name) return { author: actor.name, initials: actor.name.split(/\s+/).filter(Boolean).map((w) => Array.from(w)[0]).join("").toUpperCase().slice(0, 3) };
  return { author: "Crow", initials: "C" };
}
