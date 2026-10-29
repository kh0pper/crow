/**
 * Credential card: where a secret the operator typed can go (spec §10.5: the card, the submit
 * route and the request store never change when a target is added).
 *
 * A target is `{ validate(req) -> boolean, deliver(req, value, ctx) -> { ok, note } }`.
 *  - `validate` sees the request metadata only, when the bot asks.
 *  - `deliver` is the ONLY place a value exists, and only as its `value` argument: it must never
 *    assign it to anything that outlives the call, log it, or put it in an error or a note. The
 *    note it returns is a fixed line (plus a label and an entry id), and it is what the bot is told.
 *
 * Shipped: `keychain` only. `browser` is deliberately not registered until bot containment lands
 * (spec §10.5), so a browser request is refused as `bad_target` like any unknown target.
 */
import { keychainKeyState } from "../keychain/key.js";
import { addManualSecret } from "../keychain/store.js";
import { recordCardSecret } from "../../shared/secret-values.js";

export const KEYCHAIN_NOTES = Object.freeze({
  notSetUp: "The keychain isn't set up yet. Nothing was saved.",
  failed: "The password couldn't be saved. Nothing was saved.",
});

/** The fixed success line for a keychain save. */
export function keychainSavedNote(label, id) {
  return `Saved in the keychain as "${label}" (entry ${id}).`;
}

const registry = new Map();

/** Add (or replace) a target. */
export function registerTarget(name, target) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error("secret target: bad name");
  if (!target || typeof target.validate !== "function" || typeof target.deliver !== "function") {
    throw new Error("secret target: validate and deliver are required");
  }
  registry.set(name, Object.freeze({ validate: target.validate, deliver: target.deliver }));
}

/** The registered target, or null. */
export function getTarget(name) {
  return (typeof name === "string" && registry.get(name)) || null;
}

export function targetNames() { return [...registry.keys()]; }

export const targets = Object.freeze({ register: registerTarget, get: getTarget, names: targetNames });

/**
 * keychain: stored as a manual keychain entry under the request's label (default
 * "<bot>: password"). It never creates a keychain key: with no key (or a damaged one) the save
 * is refused with a fixed note, so a bot can never set up the operator's keychain by asking.
 * ctx: { db (required), crowHome, audit(db, event, { details }), env (for the masking hashes) }.
 */
registerTarget("keychain", {
  validate(req) {
    return !!req && req.kind === "password";
  },
  async deliver(req, value, ctx = {}) {
    const st = keychainKeyState({ crowHome: ctx.crowHome });
    if (st.state !== "ok") return { ok: false, note: KEYCHAIN_NOTES.notSetUp };
    const label = req.label || `${req.botId}: password`;
    const { id } = await addManualSecret(ctx.db, st.key, { label, secret: value });
    // As the Passwords page does: the hash (never the value) masks it on approval cards.
    try { recordCardSecret(value, ctx.env || (ctx.crowHome ? { ...process.env, CROW_HOME: ctx.crowHome } : process.env)); } catch { /* masking falls back to display paths */ }
    if (typeof ctx.audit === "function") {
      try { await ctx.audit(ctx.db, "keychain_add", { details: { entry_id: id, label, source: "secret_request", bot_id: req.botId } }); } catch { /* an audit miss never undoes a save */ }
    }
    return { ok: true, note: keychainSavedNote(label, id), entryId: id };
  },
});
