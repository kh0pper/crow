/**
 * Credential card (R1.2 spec §10.2, §10.5): the bot-only `/secrets/mcp` mount and its one tool,
 * `crow_request_secret`.
 *
 * Where it lives, and where it must not: on its own mount (boot/mcp-mounts.js), on the
 * phone/artifacts pattern — the path-scoped secrets token plus X-Crow-Actor-* headers signed
 * with kind "secrets" (scripts/pi-bots/actor-sig.mjs). Never on /router or the AI-chat
 * tool-executor: those run with owner authority and have no bot thread.
 *
 * Who may call it: only a SIGNED bot actor whose gateway is "perch" and whose thread is a
 * resident, awake Perch session of that same bot. Everything else (no or bad signature, the
 * operator's own token, a channel bot, a paired peer, a hibernating or unknown session) gets
 * one fixed refusal line.
 *
 * What it returns: fixed lines only. The call returns at once; the card is shown through the
 * injectable `emitSecretCard(sessionId, frame, { botId })` seam (request-store.js; the boot wires
 * it to the Perch engine's hook, and absent it is a no-op), and the bot learns the outcome as a fixed note on its next turn
 * (request-store.js takeSecretNotes). No value ever passes through here.
 */
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z as zod } from "zod";
import { createSecretRequest, discardSecret, getSecretRequest, secretFrame, emitSecretCard, setEmitSecretCard, SECRET_NOTES } from "./request-store.js";

// The card hook seam lives in request-store.js (its expiry timer emits through it too).
export { emitSecretCard, setEmitSecretCard };

export const SECRET_TOOL_LINES = Object.freeze({
  showing: "A password card is showing to the operator. You'll get a note on your next turn saying what happened.",
  refused: "Password requests work only in a live Perch chat with the operator.",
  oneOpen: "A password card is already open in this chat. Wait for its note on your next turn.",
  notAvailable: SECRET_NOTES.notAvailable,
  notShown: "The password card couldn't be shown. Nothing was sent.",
  failed: "The password request failed. Nothing was sent.",
});

const TOOL_DESCRIPTION =
  "Ask the operator for a password through a secure card in this Perch chat. You never see the value. " +
  "kind: \"password\". target: \"keychain\" saves it in the operator's keychain under `label` " +
  "(you are told the entry's name and number, never the password). Returns at once; " +
  "what happened arrives as a note at the start of your next turn. One request at a time per chat.";

function header(h, k) {
  const v = h?.[k];
  const s = Array.isArray(v) ? v[0] : v;
  return s == null ? null : String(s);
}

/**
 * The calling bot, or null. Only a local-token caller (a bot's path-scoped token, or the full
 * local token) carrying bot headers whose signature verifies counts; the actor is then
 * `{ id, thread, gateway }`. A peer, an OAuth client or the bare token resolves to null.
 */
export function resolveSecretsActor(extra, verifyActor) {
  const auth = extra?.authInfo;
  if (auth?.clientId !== "local-mcp") return null;
  const h = extra?.requestInfo?.headers || {};
  if (header(h, "x-crow-actor-kind") !== "bot") return null;
  const a = { id: header(h, "x-crow-actor-id"), thread: header(h, "x-crow-actor-thread"), gateway: header(h, "x-crow-actor-gateway") };
  const sig = header(h, "x-crow-actor-sig");
  let valid = false;
  try { valid = !!(a.id && sig && typeof verifyActor === "function" && verifyActor({ botId: a.id, threadId: a.thread, gatewayType: a.gateway, sig })); } catch { valid = false; }
  return valid ? a : null;
}

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/**
 * @param {object} o
 * @param {(a: {botId,threadId,gatewayType,sig}) => boolean} o.verifyActor  the "secrets" verifier
 * @param {(sessionId: string, opts: {botId: string}) => boolean|Promise<boolean>} o.isLiveSession
 *        a resident, awake Perch session of that bot (default: none is live)
 * @param {(sessionId: string, frame: object, opts: {botId: string}) => any} [o.emitSecretCard]
 *        the card hook (default: request-store.js's emitSecretCard seam, which the boot wires to
 *        the Perch engine; a no-op when none is installed). It gets the open frame
 *        `{ type: "secret_request", id, label, state: "open" }`. A result of `{ delivered: false }` (or a throw) drops the request.
 */
export function createSecretsMcpServer({ McpServer = SdkMcpServer, z = zod, verifyActor, isLiveSession, emitSecretCard: cardHook } = {}) {
  const server = new McpServer({ name: "crow-secrets", version: "0.1.0" });
  const emit = typeof cardHook === "function" ? cardHook : emitSecretCard;

  server.tool("crow_request_secret", TOOL_DESCRIPTION,
    { kind: z.string().max(32), target: z.string().max(32), label: z.string().max(400).optional() },
    async (args, extra) => {
      try {
        const actor = resolveSecretsActor(extra, verifyActor);
        if (!actor || actor.gateway !== "perch" || !actor.thread) return text(SECRET_TOOL_LINES.refused, true);
        let live = false;
        try { live = typeof isLiveSession === "function" && (await isLiveSession(actor.thread, { botId: actor.id })) === true; } catch { live = false; }
        if (!live) return text(SECRET_TOOL_LINES.refused, true);

        let id;
        try {
          ({ id } = createSecretRequest({ sessionId: actor.thread, threadId: actor.thread, botId: actor.id, kind: args?.kind, target: args?.target, label: args?.label }));
        } catch (e) {
          if (e && e.code === "one_open") return text(SECRET_TOOL_LINES.oneOpen, true);
          if (e && e.code === "bad_target") return text(SECRET_TOOL_LINES.notAvailable, true);
          return text(SECRET_TOOL_LINES.failed, true);
        }
        let shown;
        const req = getSecretRequest(id);
        try { shown = req ? await emit(actor.thread, secretFrame(req, "open"), { botId: actor.id }) : { delivered: false }; }
        catch { shown = { delivered: false }; }
        if (shown && shown.delivered === false) {
          discardSecret(id);
          return text(SECRET_TOOL_LINES.notShown, true);
        }
        return text(SECRET_TOOL_LINES.showing);
      } catch {
        return text(SECRET_TOOL_LINES.failed, true);
      }
    });
  return server;
}
