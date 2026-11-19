/**
 * Crow Sharing — the owner-only class map for the sharing server's tools, and the guard that
 * enforces it on every path.
 *
 * Every tool the sharing server registers is placed in exactly one of two classes:
 *
 *   owner_only  refused for any bot actor (see below)
 *   harmless    allowed for a bot: a static list that carries no contact and no project data
 *
 * The rule is the operator's: a bot never reaches the sharing surface. Each tool here either sends
 * or exports project data to a contact or a peer, changes who can reach this instance, or reveals
 * the operator's contacts and peers.
 *
 * ONE exception, the operator's own spoken turn: the frozen operator-voice actor (isOperatorVoice —
 * the reserved crow.voice id with the frozen marker, never an id or a def field a caller can send)
 * keeps exactly VOICE_ALLOWED, `crow_send_message` and `crow_voice_memo`: a voice turn says something
 * to a contact. Nothing else — not crow_share, not a group send, not a room invite. Every other bot
 * is refused those two as well, including the voice bot reached any other way (the pi engine's
 * session with that id, a per-call `_meta`/header claiming it, or a copy of the actor that is not
 * the frozen one), because a relayed turn can put words in its mouth. A relay voice turn is one of
 * those other ways by construction: its executor is built as the plain bound bot (tool-executor's
 * opts.relay), so it never carries the marker this exception reads.
 *
 * The guard wraps `server.tool` BEFORE the register* calls, so it sees every registration whatever
 * its shape (the handler is the LAST function argument) and leaves registration ORDER untouched.
 * A name that is not in the map is refused (fail closed): a tool added without a class is refused
 * for a bot rather than silently exposed.
 *
 * Two registration shapes cannot be guarded, and are refused AT REGISTRATION rather than left open:
 * a `server.tool(...)` call with no schema (or annotations) object between the name and the handler,
 * where the handler is called with `extra` alone and the guard could not tell it from the call's
 * `args`; and `server.registerTool(name, config, cb)`, whose config object the `tool()` wrapper
 * never sees. Every registration on this server therefore ends up guarded, or the server refuses to
 * build.
 *
 * Owner, unknown and peer actors are untouched: this file only ever narrows a bot.
 */
import { UNKNOWN, resolveCallActor } from "../research/actor.js";
import { ShareRefusal, refusalResult, isOperatorVoice } from "../shared/project-share-scope.js";

const OWNER_ONLY = "owner_only";
const HARMLESS = "harmless";

/**
 * Every sharing tool name → its class. One line per tool says why.
 *
 * `harmless` is exactly one entry: the transform list is a pure static table (source→target pairs),
 * with no contacts, no peers and no project data.
 *
 * The classes below are the rule for EVERY bot. The single exception is the frozen operator-voice
 * actor, and it lives outside this map, in its own exported set (VOICE_ALLOWED) — see the header.
 * So `crow_send_message` and `crow_voice_memo` stay OWNER_ONLY: they are owner-only for every bot
 * except the operator's own spoken turn.
 */
export const SHARING_TOOL_CLASS = Object.freeze({
  // --- contacts (invites, pairing, contact rows) ---
  crow_generate_invite: OWNER_ONLY, // mints a code that lets a stranger reach this instance
  crow_accept_invite: OWNER_ONLY, // pairs this instance with a stranger: adds a contact + keys
  crow_generate_short_invite: OWNER_ONLY, // mints a spoken pairing code that binds a peer
  crow_accept_short_invite: OWNER_ONLY, // consumes a pairing code and adds the contact it names
  crow_add_contact: OWNER_ONLY, // writes a trusted contact row (crow_id + keys) for a peer
  crow_accept_bot_invite: OWNER_ONLY, // accepts a peer bot invite: authorizes it against the owner
  crow_list_contacts: OWNER_ONLY, // reveals the operator's contacts, peers and their online state

  // --- shares and inbox (project data leaving the instance, peer data coming in) ---
  crow_share: OWNER_ONLY, // sends a memory/project/source/note to a contact, or clone-exports a project
  crow_inbox: OWNER_ONLY, // reads incoming shares and the stored text of messages from peers

  // --- messaging ---
  crow_send_message: OWNER_ONLY, // sends a message to a contact as this instance (the operator's voice turn: VOICE_ALLOWED)
  crow_create_message_group: OWNER_ONLY, // builds a group of the operator's contacts to broadcast to
  crow_list_message_groups: OWNER_ONLY, // reveals group membership, which is the contact list
  crow_send_group_message: OWNER_ONLY, // fans a message out to every member of a group of contacts

  // --- sharing admin ---
  crow_revoke_access: OWNER_ONLY, // changes who may reach an already shared item
  crow_sharing_status: OWNER_ONLY, // reports this instance's identity, peers, relays and share counts
  crow_find_contacts: OWNER_ONLY, // looks other people's Crow IDs up by email hash
  crow_set_discoverable: OWNER_ONLY, // changes whether this instance can be discovered by peers

  // --- instances, relays, sync ---
  crow_discover_relays: OWNER_ONLY, // enumerates and probes the relays this instance dials
  crow_add_relay: OWNER_ONLY, // points this instance's messaging at a new relay
  crow_list_instances: OWNER_ONLY, // reveals paired instances, their hostnames and gateway URLs
  crow_register_instance: OWNER_ONLY, // registers another instance as reachable peer
  crow_update_instance: OWNER_ONLY, // rewrites a peer instance's record and reachability
  crow_revoke_instance: OWNER_ONLY, // cuts a paired instance off (irreversible for its sync)
  crow_list_sync_conflicts: OWNER_ONLY, // reveals replication conflicts across instances and projects

  // --- rooms and social ---
  crow_room_invite: OWNER_ONLY, // invites a contact into a live room
  crow_room_close: OWNER_ONLY, // closes the operator's live room out from under them
  crow_voice_memo: OWNER_ONLY, // sends an audio memo to a contact (the operator's voice turn: VOICE_ALLOWED)
  crow_react: OWNER_ONLY, // sends a reaction into a shared room, as the operator

  // --- identity attestations ---
  crow_identity_attest: OWNER_ONLY, // publishes a signed link from an external account to this Crow ID
  crow_identity_verify: OWNER_ONLY, // verifies (and so reads back) someone's identity claims
  crow_identity_revoke: OWNER_ONLY, // revokes a published attestation of this instance
  crow_identity_list: OWNER_ONLY, // lists this instance's attestations and their external handles

  // --- cross-posting ---
  crow_list_crosspost_transforms: HARMLESS, // a static (source, target) table: no contacts, no project rows
  crow_crosspost: OWNER_ONLY, // publishes project content to an external app
  crow_crosspost_cancel: OWNER_ONLY, // cancels the operator's queued publication
  crow_crosspost_mark_published: OWNER_ONLY, // records an external post id against a crosspost
  crow_list_crossposts: OWNER_ONLY, // lists crossposts: targets, ids and published URLs of project content
});

const isBot = (actor) => !!(actor && actor.kind === "bot");

/**
 * The two sharing tools the operator's own voice executor keeps: it speaks to a contact, so a spoken
 * turn may send a message or a memo — and nothing else. Separate from SHARING_TOOL_CLASS (whose
 * values are unchanged) because the exception is about the ACTOR, not about the tool: every other
 * bot is refused these two like any other owner-only tool.
 */
export const VOICE_ALLOWED = Object.freeze(new Set(["crow_send_message", "crow_voice_memo"]));

/** Is this tool name classed harmless? An unknown name is not (fail closed). */
function isHarmless(name) {
  return (
    Object.prototype.hasOwnProperty.call(SHARING_TOOL_CLASS, name) &&
    SHARING_TOOL_CLASS[name] === HARMLESS
  );
}

/**
 * May this actor call this tool? A bot may reach a harmless tool; the frozen operator-voice actor
 * (and only it) may also reach VOICE_ALLOWED. Everything else is refused.
 */
function allowedFor(actor, name) {
  if (isHarmless(name)) return true;
  return VOICE_ALLOWED.has(name) && isOperatorVoice(actor);
}

/**
 * Wrap a sharing server's `server.tool` so that no bot actor reaches an owner-only handler.
 *
 * Call it right after the McpServer is built and BEFORE the register* calls: every registration
 * then goes through it, in the same order, and the handler it registers is the guard's own — the
 * LAST function argument of the registration, whatever the arity of that handler.
 *
 * Per call the guard resolves the actor from the construction-time `baseActor` and the call's
 * `extra` (a `crow/actor` `_meta`, an `x-crow-actor-*` header, a peer token — `resolveCallActor`
 * owns that logic, so a fixed bot base actor is never narrowed back to the owner). A bot calling a
 * tool that is not `harmless`, or a tool name the map does not class, gets the fixed owner-only
 * refusal and the handler does not run — unless the actor is the frozen operator-voice actor and the
 * tool is in VOICE_ALLOWED. Owner/unknown/peer actors pass through untouched.
 *
 * `onCallActor(actor, toolName)` is a test seam that sees every resolution, like the storage
 * server's: the guard's decision is otherwise only visible through the refusal.
 *
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {{baseActor?: object, onCallActor?: (actor: object, toolName: string) => void}} [options]
 */
export function guardSharingServer(server, { baseActor, onCallActor } = {}) {
  const registerTool = server.tool.bind(server);

  server.tool = (...args) => {
    const name = String(args[0]);
    const last = args.length - 1;
    const handler = args[last];
    // Not a registration shape the guard knows (the MCP SDK's `tool()` always ends in its
    // callback): refuse it rather than register a handler nothing guards.
    if (typeof handler !== "function") {
      throw new Error("sharing guard: " + name + " must be registered as server.tool(name, description, schema, handler)");
    }
    // Everything between the name and the handler is the description and, necessarily, one object:
    // the input schema (or the annotations object of the schema-less shape). Without it `tool()`
    // calls the handler as handler(extra) alone, and the guard's `(callArgs, extra)` reading would
    // take the call's own `extra` for `callArgs` — so it is refused at registration time instead.
    const described = args.slice(1, last);
    if (!described.some((a) => a !== null && typeof a === "object")) {
      throw new Error("sharing guard: " + name + " is registered without a schema object before its handler, "
        + "which cannot be guarded; register it as server.tool(name, description, schema, handler)");
    }

    const guarded = (callArgs, extra) => {
      const actor = resolveCallActor(baseActor || UNKNOWN, extra);
      if (typeof onCallActor === "function") onCallActor(actor, name);
      if (isBot(actor) && !allowedFor(actor, name)) {
        return refusalResult(new ShareRefusal(OWNER_ONLY).message);
      }
      return handler(callArgs, extra);
    };

    const next = args.slice();
    next[last] = guarded;
    return registerTool(...next);
  };

  // `registerTool(name, config, cb)` never goes through `tool()`, so this wrapper would not see its
  // handler. It is refused outright: on this server a tool is registered through `tool()` or not
  // at all.
  server.registerTool = (name) => {
    throw new Error("sharing guard: " + String(name) + " cannot be registered through registerTool(); "
      + "use server.tool(name, description, schema, handler) so the owner-only guard sees it");
  };

  return server;
}