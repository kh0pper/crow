/**
 * Crow Blog — the owner-only class map for the blog server's tools, and the guard that enforces it
 * on every path.
 *
 * Every tool the blog server registers is placed in exactly one of two classes:
 *
 *   owner_only  refused for any bot actor (see below)
 *   harmless    allowed for a bot: a static lookup that reads nothing of the operator's
 *
 * The rule is the operator's: a bot never publishes, edits, deletes, shares or configures the
 * operator's blog. Each tool here either writes what the public site says, changes who can reach a
 * post, or reveals the operator's drafts, settings and songs.
 *
 * ONE exception, the operator's own spoken turn: the frozen operator-voice actor (isOperatorVoice —
 * the reserved crow.voice id with the frozen marker, never an id or a def field a caller can send)
 * keeps every tool. Every other bot is refused them, including the voice bot reached any other way
 * (the pi engine's session with that id, a per-call `_meta`/header claiming it, or a copy of the
 * actor that is not the frozen one), because a relayed turn can put words in its mouth. A relay
 * voice turn is one of those other ways by construction: its executor is built as the plain bound
 * bot (tool-executor's opts.relay), so it never carries the marker this exception reads.
 *
 * The guard wraps `server.tool` BEFORE the register calls, so it sees every registration whatever
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
 * Every blog tool name → its class. One line per tool says why.
 *
 * `harmless` is exactly one entry: the chord diagram is a pure function of a chord name (a static
 * shape table), with no post, no setting and no song row.
 */
export const BLOG_TOOL_CLASS = Object.freeze({
  // --- posts ---
  crow_create_post: OWNER_ONLY, // writes a draft into the operator's blog
  crow_edit_post: OWNER_ONLY, // rewrites the title/content of an existing post, draft or live
  crow_publish_post: OWNER_ONLY, // puts a post on the public site (a confirmation token is not a credential)
  crow_unpublish_post: OWNER_ONLY, // takes the operator's published post off the site
  crow_list_posts: OWNER_ONLY, // reveals every post, unpublished drafts included
  crow_get_post: OWNER_ONLY, // reads back a post row, unpublished drafts included
  crow_delete_post: OWNER_ONLY, // deletes a post: content the operator wrote, gone
  crow_share_post: OWNER_ONLY, // exports a post to a peer instance

  // --- the blog's own presentation ---
  crow_export_blog: OWNER_ONLY, // exports the whole blog (every post, draft included) as a site
  crow_blog_settings: OWNER_ONLY, // reads and rewrites the blog's identity (name, tagline, author)
  crow_blog_customize_theme: OWNER_ONLY, // rewrites the theme every visitor to the public site sees
  crow_blog_stats: OWNER_ONLY, // reports the operator's blog activity and reach

  // --- songs and setlists (the songbook lives on this server) ---
  crow_create_song: OWNER_ONLY, // writes a song into the operator's songbook
  crow_transpose_song: OWNER_ONLY, // rewrites a stored song's key
  crow_list_songs: OWNER_ONLY, // reveals the operator's songbook
  crow_get_chord_diagram: HARMLESS, // a static chord shape: no song, no post, no operator data
  crow_create_setlist: OWNER_ONLY, // writes a setlist into the operator's songbook
  crow_add_to_setlist: OWNER_ONLY, // changes what is on a setlist
  crow_remove_from_setlist: OWNER_ONLY, // changes what is on a setlist
  crow_update_setlist: OWNER_ONLY, // rewrites a setlist's name, description and visibility
  crow_list_setlists: OWNER_ONLY, // reveals the operator's setlists
  crow_get_setlist: OWNER_ONLY, // reads back a setlist and its items
  crow_delete_setlist: OWNER_ONLY, // deletes a setlist the operator built
});

const isBot = (actor) => !!(actor && actor.kind === "bot");

/** Is this tool name classed harmless? An unknown name is not (fail closed). */
function isHarmless(name) {
  return (
    Object.prototype.hasOwnProperty.call(BLOG_TOOL_CLASS, name) &&
    BLOG_TOOL_CLASS[name] === HARMLESS
  );
}

/** May this actor call this tool? A bot may reach a harmless tool; the frozen operator-voice actor
 *  (and only it) may reach the rest. Everything else is refused. */
function allowedFor(actor, name) {
  if (isHarmless(name)) return true;
  return isOperatorVoice(actor);
}

/**
 * Wrap a blog server's `server.tool` so that no bot actor reaches an owner-only handler.
 *
 * Call it right after the McpServer is built and BEFORE the tool registrations: every registration
 * then goes through it, in the same order, and the handler it registers is the guard's own — the
 * LAST function argument of the registration, whatever the arity of that handler.
 *
 * Per call the guard resolves the actor from the construction-time `baseActor` and the call's
 * `extra` (a `crow/actor` `_meta`, an `x-crow-actor-*` header, a peer token — `resolveCallActor`
 * owns that logic, so a fixed bot base actor is never narrowed back to the owner). A bot calling a
 * tool that is not `harmless`, or a tool name the map does not class, gets the fixed owner-only
 * refusal and the handler does not run — unless the actor is the frozen operator-voice actor.
 * Owner/unknown/peer actors pass through untouched.
 *
 * `onCallActor(actor, toolName)` is a test seam that sees every resolution, like the storage
 * server's: the guard's decision is otherwise only visible through the refusal.
 *
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {{baseActor?: object, onCallActor?: (actor: object, toolName: string) => void}} [options]
 */
export function guardBlogServer(server, { baseActor, onCallActor } = {}) {
  const registerTool = server.tool.bind(server);

  server.tool = (...args) => {
    const name = String(args[0]);
    const last = args.length - 1;
    const handler = args[last];
    // Not a registration shape the guard knows (the MCP SDK's `tool()` always ends in its
    // callback): refuse it rather than register a handler nothing guards.
    if (typeof handler !== "function") {
      throw new Error("blog guard: " + name + " must be registered as server.tool(name, description, schema, handler)");
    }
    // Everything between the name and the handler is the description and, necessarily, one object:
    // the input schema (or the annotations object of the schema-less shape). Without it `tool()`
    // calls the handler as handler(extra) alone, and the guard's `(callArgs, extra)` reading would
    // take the call's own `extra` for `callArgs` — so it is refused at registration time instead.
    const described = args.slice(1, last);
    if (!described.some((a) => a !== null && typeof a === "object")) {
      throw new Error("blog guard: " + name + " is registered without a schema object before its handler, "
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
    throw new Error("blog guard: " + String(name) + " cannot be registered through registerTool(); "
      + "use server.tool(name, description, schema, handler) so the owner-only guard sees it");
  };

  return server;
}