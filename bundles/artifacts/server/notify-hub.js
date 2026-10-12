// Crow Artifacts — the chat-first hub fan-out (spec v1.6 D25; plan PR-1 Task 1.2).
//
// After every successful MCP write, the artifact's linked chats get a POINTER
// frame ({type:"artifact", artifactId, n, event}) through the gateway engine's
// emitExternal hook. The frame carries no bot-authored text — titles, notes
// and states ride the store row, which the hub card refetches (the phone-card
// I2/I6 pattern). The engine enforces the allow-list, the frozen event enum
// and the bot match; this module only decides WHERE a write fans out.
//
// A fan-out failure never breaks the MCP result: the store is the system of
// record, and a missed live card replays from the by-thread history route the
// next time the chat is opened.
import { linkedThreads } from "./links.js";

let warned = new Set();

/** Fire-and-forget card fan-out. `emitExternal` is the thunk the MCP mount
 *  injects (servers/gateway/boot/mcp-mounts.js → the engine's resident-only
 *  hook); null in model tests and on installs without a Perch engine. */
export async function notifyHub({ db, artifactId, n = null, event, emitExternal }) {
  if (typeof emitExternal !== "function") return { fanned: 0 };
  try {
    const links = await linkedThreads(db, artifactId);
    let fanned = 0;
    for (const l of links) {
      const r = await emitExternal(l.threadId, { type: "artifact", artifactId: String(artifactId), n, event }, { botId: l.botId });
      if (r && r.delivered) fanned++;
    }
    return { fanned };
  } catch (e) {
    // L2 (plan review): keyed by error class, not one global flag — a DB error
    // after an engine error still gets its single warning. Bounded: classes
    // are few; a flood of distinct messages falls back to one memo each.
    const key = String((e && (e.code || e.name)) || "error").slice(0, 64);
    if (!warned.has(key)) { warned.add(key); console.warn(`[artifacts] hub fan-out failed (non-fatal): ${(e && e.message) || e}`); }
    return { fanned: 0 };
  }
}
