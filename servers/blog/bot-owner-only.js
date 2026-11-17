/**
 * Crow Blog — the owner-only class map for the blog server's tools, and the guard that enforces it
 * on every path.
 *
 * Every tool the blog server registers is placed in exactly one of three classes:
 *
 *   owner_only  refused for any bot actor (see below)
 *   bot_draft   allowed for a bot, but only on DRAFTS: create a draft, edit a draft, list drafts,
 *               read a draft. The handler is told so per call (the guard's third argument, never a
 *               model-supplied field), and applies the draft-only rule itself.
 *   harmless    allowed for a bot: a static lookup that reads nothing of the operator's
 *
 * The rule is the operator's: a bot never publishes, unpublishes, deletes, shares or configures the
 * operator's blog, and never touches the songbook. Each owner_only tool here either writes what the
 * public site says, changes who can reach a post, rewrites the blog's identity or theme, or reveals
 * the operator's settings and songs.
 *
 * The draft allowance is the operator's decision, and its trade-off is stated plainly because it is
 * real: `blog_posts` has NO author column, so nothing on a post row says who wrote it. A bot that is
 * allowed to reach drafts therefore sees and edits every DRAFT on this instance — the operator's own
 * drafts included, not just the ones the bot wrote. That is accepted: drafts are not on the public
 * site, the bot still cannot publish one, and the alternative (an author column) would be a schema
 * change. It also means a bot can read a draft SONG's body through crow_get_post (songs are blog
 * posts tagged "songbook"); the songbook tools themselves stay owner_only, so it cannot list, write,
 * transpose, publish or delete one.
 *
 * Exactly four tools are bot_draft — crow_create_post, crow_edit_post, crow_list_posts and
 * crow_get_post — and everything they do for a bot is pinned to `status = 'draft'` in the handler:
 * a bot's new post is inserted as a draft explicitly (and read back to prove it), an edit is one
 * UPDATE carrying `AND status = 'draft'` so it can never land on a post that went live, a listing
 * forces the status filter to 'draft' whatever the call asked for, and a read adds the same
 * predicate so a live post is exactly as invisible as a missing one. A bot can never change a
 * post's status through any of them: crow_edit_post has no status field at all.
 *
 * ONE exception, the operator's own spoken turn: the frozen operator-voice actor (isOperatorVoice —
 * the reserved crow.voice id with the frozen marker, never an id or a def field a caller can send)
 * keeps every tool. Every other bot is refused them, including the voice bot reached any other way
 * (the pi engine's session with that id, a per-call `_meta`/header claiming it, or a copy of the
 * actor that is not the frozen one), because a relayed turn can put words in its mouth. A relay
 * voice turn is one of those other ways by construction: its executor is built as the plain bound
 * bot (tool-executor's opts.relay), so it never carries the marker this exception reads. A call
 * that only CLAIMS to be a bot is treated as one too — a `crow/actor` header or `_meta` of kind
 * "bot" with no usable id resolves to "unknown", the actor an unmarked local client gets, so the
 * claim is read again here (claimsBot) rather than letting an unverifiable bot act as the operator
 * (it is refused an owner_only tool and held to the draft-only rule on a bot_draft one).
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
const BOT_DRAFT = "bot_draft";
const HARMLESS = "harmless";

/**
 * The one refusal a draft-only bot gets for a post it may not edit, whether the post is not a draft
 * or does not exist at all: the two must be indistinguishable. The handler enforces it in the UPDATE
 * itself (`AND status = 'draft'`), so nothing changes on the refused path.
 */
export const DRAFT_ONLY_EDIT_REFUSAL = "A bot can only edit draft posts.";

/** The tool result for that refusal, in the shape every ACL refusal on these servers uses. */
export function draftOnlyEditRefusal() {
  return refusalResult(DRAFT_ONLY_EDIT_REFUSAL);
}

/**
 * Every blog tool name → its class. One line per tool says why.
 *
 * `bot_draft` is exactly the four post tools a bot needs to write a draft: create, edit, list and
 * read. Each handler pins those to drafts (servers/blog/server.js), so the class is the permission
 * to reach the tool, not the permission to reach a live post.
 *
 * `harmless` is exactly one entry: the chord diagram is a pure function of a chord name (a static
 * shape table), with no post, no setting and no song row.
 */
export const BLOG_TOOL_CLASS = Object.freeze({
  // --- posts ---
  crow_create_post: BOT_DRAFT, // a bot writes a draft; the handler always inserts status 'draft'
  crow_edit_post: BOT_DRAFT, // a bot edits a DRAFT only: the UPDATE carries `AND status = 'draft'`
  crow_publish_post: OWNER_ONLY, // puts a post on the public site (a confirmation token is not a credential)
  crow_unpublish_post: OWNER_ONLY, // takes the operator's published post off the site
  crow_list_posts: BOT_DRAFT, // a bot lists drafts only; the status filter is forced to 'draft'
  crow_get_post: BOT_DRAFT, // a bot reads a draft only; a live post reads as not found
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

/** This tool name's class, or undefined for a name the map does not class (fail closed). */
function classOf(name) {
  return Object.prototype.hasOwnProperty.call(BLOG_TOOL_CLASS, name)
    ? BLOG_TOOL_CLASS[name]
    : undefined;
}

/** May this actor call this tool? A bot may reach a harmless tool and a bot_draft one (the handler
 *  then pins it to drafts); the frozen operator-voice actor (and only it) may reach the rest.
 *  Everything else is refused. */
function allowedFor(actor, name) {
  const cls = classOf(name);
  if (cls === HARMLESS || cls === BOT_DRAFT) return true;
  return isOperatorVoice(actor);
}

/**
 * Did this CALL itself claim to be a bot — a `crow/actor` of kind "bot" in its `_meta`, or an
 * `x-crow-actor-kind: bot` request header?
 *
 * The claim is read again here because the resolved actor cannot carry it: `resolveCallActor`
 * reports a bot claim with no usable id (and any id-less bot an upstream router forwarded) as
 * "unknown", the very actor an unmarked local client gets — so the actor alone would let an
 * unverifiable bot claim write the operator's blog. Same fail-closed reading as the memory server's
 * writing-rules guard. Only the marker is read here; whether the caller may proceed is still
 * `allowedFor`'s decision, so the frozen operator-voice actor's own turn is untouched.
 */
function claimsBot(extra) {
  const meta = extra && typeof extra === "object" ? extra._meta : undefined;
  const claimed = meta && typeof meta === "object" ? meta["crow/actor"] : undefined;
  if (claimed && typeof claimed === "object" && claimed.kind === "bot") return true;
  const headers = extra && extra.requestInfo && extra.requestInfo.headers;
  const raw = headers && typeof headers === "object" ? headers["x-crow-actor-kind"] : undefined;
  const kind = Array.isArray(raw) ? raw[0] : raw;
  return typeof kind === "string" && kind.trim().toLowerCase() === "bot";
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
 * tool that is `owner_only` (or a name the map does not class) gets the fixed owner-only refusal
 * and the handler does not run — unless the actor is the frozen operator-voice actor. A call that
 * CLAIMS to be a bot but resolved to something else (an id-less bot claim arrives as "unknown") is
 * treated as a bot here, never as the operator's own client: refused an owner_only tool, and given
 * the draft-only rule on a bot_draft one. Owner/unknown/peer actors that claim nothing pass through
 * untouched.
 *
 * A bot that reaches a `bot_draft` tool is told so: the real handler is called with a third
 * argument, a frozen per-call context `{ draftOnly }` derived from the actor the guard RESOLVED (and
 * from the claim it read, with the same fail-closed reading as the refusal). That context is never
 * built from the call's arguments and never from `_meta` beyond what `resolveCallActor`/`claimsBot`
 * already read, so a model cannot ask for it and a handler cannot be talked out of it. It is `true`
 * only for a bot-bound caller on a bot_draft tool — the frozen operator-voice actor's own turn is
 * `false`, so that path is byte-identical to before. Handlers that do not read it are unaffected.
 *
 * `onCallActor(actor, toolName)` is a test seam that sees every resolution, like the storage
 * server's: the guard's decision is otherwise only visible through the refusal or the handler's
 * own draft-only behaviour.
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
      // A bot actor, or a call that CLAIMS to be one and did not resolve to a usable bot: either
      // way only the frozen operator-voice actor goes on (a claim can never produce that marker).
      const botCall = isBot(actor) || claimsBot(extra);
      if (botCall && !allowedFor(actor, name)) {
        return refusalResult(new ShareRefusal(OWNER_ONLY).message);
      }
      // The draft-only rule reaches the handler for a bot-bound caller only. The frozen
      // operator-voice actor is a bot too, so it is excluded explicitly: its own turn keeps every
      // tool exactly as before. Frozen, so a handler cannot widen it for the rest of its call.
      const context = Object.freeze({
        draftOnly: botCall && !isOperatorVoice(actor) && classOf(name) === BOT_DRAFT,
      });
      return handler(callArgs, extra, context);
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
