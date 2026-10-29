/**
 * One Crow sharing process for tests/fixtures/bot-relay-node.mjs: the real
 * shared managers and, on `wire`, the real Nostr receive wiring
 * (wireNostrReceive, which routes bot_relay through routeBotRelay).
 *
 * One seam: nostrManager.getConfiguredRelays = async () => [relayUrl]. A
 * guard refuses any WebSocket but that local relay. A second guard refuses to
 * start when an AI provider is configured, so a task run can only take the
 * production "no provider" path.
 *
 * Control channel: JSON lines on fd 3 ({id, op, args} → {id, ok, result|error});
 * an unsolicited {ready:true} once the managers exist (and, with cfg.wire, the
 * receive path is wired).
 */
import net from "node:net";
import readline from "node:readline";

const GUARD = "[bot-relay-node-guard]";
const cfg = JSON.parse(process.env.BOT_RELAY_NODE_CONFIG || "{}");
const relayUrl = cfg.relayUrl || null;
let relayPort = null;
if (relayUrl) {
  const u = new URL(relayUrl);
  if (u.protocol !== "ws:" || u.hostname !== "127.0.0.1") {
    console.error(`${GUARD} relay must be ws://127.0.0.1:<port>, got ${relayUrl}`);
    process.exit(2);
  }
  relayPort = u.port;
}
const RealWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class GuardedWebSocket extends RealWebSocket {
  constructor(url, ...rest) {
    let ok = false;
    try { const x = new URL(String(url)); ok = !!relayPort && x.protocol === "ws:" && x.hostname === "127.0.0.1" && x.port === relayPort; } catch {}
    if (!ok) {
      console.error(`${GUARD} refused a WebSocket to ${url}`);
      throw new Error(`bot-relay-node guard: only the local relay is allowed (${url})`);
    }
    super(url, ...rest);
  }
};

const { getProviderConfig } = await import("../../servers/gateway/ai/provider.js");
if (getProviderConfig()) {
  console.error(`${GUARD} an AI provider is configured in this home; refusing to start`);
  process.exit(2);
}

const { getSharedManagers } = await import("../../servers/sharing/managers.js");
const { wireNostrReceive } = await import("../../servers/sharing/boot.js");
const { routeBotRelay, sendBotRelay } = await import("../../servers/sharing/bot-relay.js");
const managers = getSharedManagers();
const { db, identity, nostrManager } = managers;
nostrManager.getConfiguredRelays = async () => (relayUrl ? [relayUrl] : []);
const ownXOnly = identity.secp256k1Pubkey.slice(2);

const toObjects = (res) => res.rows.map((r) => Object.fromEntries((res.columns || Object.keys(r)).map((c) => [c, r[c]])));

const ops = {
  async wire() { await wireNostrReceive(managers); return true; },
  async connect() { await nostrManager.connectRelays(); return nostrManager.relays.size; },
  async send({ target, task, timeoutMs }) { return sendBotRelay(target, task, { timeoutMs }); },
  async route({ subtype, payload, eventCreatedAt, senderPubkey = ownXOnly }) {
    return routeBotRelay({ subtype, payload, senderPubkey, db, identity, nostrManager, eventCreatedAt });
  },
  async sql({ sql, args = [] }) {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error("sql is read-only (SELECT / WITH)");
    return toObjects(await db.execute({ sql, args }));
  },
  async identity() { return { secp256k1Pubkey: identity.secp256k1Pubkey, xOnly: ownXOnly }; },
  async stop() { setTimeout(() => process.exit(0), 10); return true; },
};

const ctl = new net.Socket({ fd: 3, readable: true, writable: true });
const reply = (msg) => { try { ctl.write(JSON.stringify(msg) + "\n"); } catch {} };
readline.createInterface({ input: ctl }).on("line", async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const fn = ops[req.op];
  if (!fn) { reply({ id: req.id, ok: false, error: `unknown op ${req.op}` }); return; }
  try {
    reply({ id: req.id, ok: true, result: await fn(req.args || {}) });
  } catch (err) {
    reply({ id: req.id, ok: false, error: err?.message || String(err) });
  }
});
ctl.on("close", () => process.exit(0));

try {
  if (cfg.wire) await ops.wire();
  reply({ ready: true });
} catch (err) {
  reply({ ready: false, error: err?.message || String(err) });
}
