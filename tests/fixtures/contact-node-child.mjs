/**
 * One Crow sharing node in its own process, driven by tests/fixtures/contact-node.mjs.
 *
 * Loads ONLY modules from the tree named by CONTACT_NODE_CONFIG.repo (this
 * checkout, or an older one from tests/fixtures/old-tree.mjs). The parent sets
 * a scratch CROW_HOME / CROW_DATA_DIR / CROW_DB_PATH before spawning.
 *
 * Exactly two network-address seams are patched, the same way in every tree:
 *   1. peerManager.start builds
 *        new Hyperswarm({ dht: new HyperDHT({ bootstrap, host: "127.0.0.1", port: [0, 0] }) })
 *      and wires `connection` → _handleConnection; otherwise identical to the
 *      runtime's start().
 *   2. nostrManager.getConfiguredRelays = async () => [relayUrl].
 * Two guards make a mistake loud instead of silent: a DHT built with any
 * bootstrap other than the local testnet (or bound off loopback) throws, and a
 * WebSocket to any URL other than the local relay throws. Both print a
 * `[contact-node-guard]` line, which the parent treats as a failure.
 *
 * Control channel: JSON lines on fd 3. Request {id, op, args}; reply
 * {id, ok, result} or {id, ok:false, error}. Unsolicited {ready:true} once the
 * MCP client is connected, the swarm exists, the Nostr receive path is wired
 * and the node is announced on every full contact's DHT topic.
 *
 * Two test-only seams ride that channel for the Crow-to-Crow two-node gate:
 * `exec` also seeds a project (and its local owner row) besides a memory, and
 * `c2c` calls ONE allowlisted function of servers/sharing/c2c/{owner,visitor}.js
 * with this node's real db, local instance id and a live-peer `send` (so the
 * action's own flush runs after its commit). The send is the PRODUCTION resolver
 * (`c2cSendForContact` in servers/sharing/c2c/transport.js, the same one the
 * dashboard routes use), so the gate exercises the real `sendTo`/`send` choice.
 * `peerRouting`/`isConnected` read the manager's per-instance index, which is how
 * a test proves WHICH sibling is primary. Nothing else is reachable from the
 * channel: `sql` stays read-only and no op can send a frame directly.
 */
import net from "node:net";
import readline from "node:readline";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const GUARD = "[contact-node-guard]";
const cfg = JSON.parse(process.env.CONTACT_NODE_CONFIG || "{}");
const { repo, bootstrap, relayUrl } = cfg;
if (!repo || !Array.isArray(bootstrap) || bootstrap.length === 0 || !relayUrl) {
  console.error(`${GUARD} missing repo, bootstrap or relayUrl`);
  process.exit(2);
}

// --- guard: the local relay only (installed before any nostr-tools module loads) ---
const relay = new URL(relayUrl);
if (relay.protocol !== "ws:" || relay.hostname !== "127.0.0.1") {
  console.error(`${GUARD} relay must be ws://127.0.0.1:<port>, got ${relayUrl}`);
  process.exit(2);
}
const isLocalRelay = (u) => {
  try {
    const x = new URL(String(u));
    return x.protocol === "ws:" && x.hostname === "127.0.0.1" && x.port === relay.port;
  } catch { return false; }
};
const RealWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class GuardedWebSocket extends RealWebSocket {
  constructor(url, ...rest) {
    if (!isLocalRelay(url)) {
      console.error(`${GUARD} refused a WebSocket to ${url}`);
      throw new Error(`contact-node guard: only the local relay is allowed (${url})`);
    }
    super(url, ...rest);
  }
};

// --- guard: the local DHT testnet only ---
const treeRequire = createRequire(join(repo, "package.json"));
const Hyperswarm = treeRequire("hyperswarm");
const HyperDHT = treeRequire("hyperdht");
const DhtRpc = createRequire(treeRequire.resolve("hyperdht"))("dht-rpc");
const allowedBoot = new Set(bootstrap.map((n) => `${n.host}:${n.port}`));
for (const n of bootstrap) {
  if (n.host !== "127.0.0.1") { console.error(`${GUARD} bootstrap must be on 127.0.0.1`); process.exit(2); }
}
const realBootstrap = DhtRpc.prototype._bootstrap;
DhtRpc.prototype._bootstrap = function guardedBootstrap() {
  const nodes = this.bootstrapNodes || [];
  const ok = nodes.length > 0
    && nodes.every((n) => allowedBoot.has(`${n.host}:${n.port}`))
    && this.io?._host === "127.0.0.1";
  if (!ok) {
    console.error(`${GUARD} refused a DHT with bootstrap ${JSON.stringify(nodes)} on host ${this.io?._host}`);
    throw new Error("contact-node guard: a DHT must use the local testnet bootstrap on 127.0.0.1");
  }
  return realBootstrap.call(this);
};

const imp = (rel) => import(pathToFileURL(join(repo, rel)).href);

const { getSharedManagers } = await imp("servers/sharing/managers.js");
const managers = getSharedManagers();
const { db, identity, peerManager, nostrManager } = managers;

// Seam 1: the swarm, on the local testnet. Otherwise identical to start().
peerManager.start = async function start() {
  if (this.p2pDisabled) return this;
  this.swarm = new Hyperswarm({ dht: new HyperDHT({ bootstrap, host: "127.0.0.1", port: [0, 0] }) });
  this.swarm.on("connection", (conn, info) => {
    this._handleConnection(conn, info);
  });
  return this;
};
// Seam 2: the relay list.
nostrManager.getConfiguredRelays = async () => [relayUrl];

const { createSharingServer } = await imp("servers/sharing/server.js");
if (Number.isFinite(cfg.bindingAdvertDelayMs)) {
  // The same boot createSharingServer runs, with the advert delay helper set
  // (initSharingRuntime's own option). Older trees ignore the extra helper.
  const { createCloneBundleHelpers } = await imp("servers/sharing/clone-bundle.js");
  const { initSharingRuntime } = await imp("servers/sharing/boot.js");
  const { buildProjectCloneBundle, applyProjectCloneBundle } = createCloneBundleHelpers({ db });
  managers.initialized = true;
  initSharingRuntime(managers, { applyProjectCloneBundle, buildProjectCloneBundle, bindingAdvertDelayMs: cfg.bindingAdvertDelayMs });
}
const server = createSharingServer();

const sdk = (rel) => import(pathToFileURL(join(repo, "node_modules/@modelcontextprotocol/sdk/dist/esm", rel)).href);
const { Client } = await sdk("client/index.js");
const { InMemoryTransport } = await sdk("inMemory.js");
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "contact-node", version: "1.0.0" });
await client.connect(clientTransport);

const { getReceiveHealth } = await imp("servers/sharing/receive-health.js");

const toObjects = (res) => res.rows.map((r) => Object.fromEntries((res.columns || Object.keys(r)).map((c) => [c, r[c]])));

/** This node's own instance id (the sharing runtime's, never a frame field). */
const localInstanceIdNow = () => managers.instanceSyncManager?.localInstanceId || peerManager.localInstanceId || null;

/**
 * The test-only `c2c` allowlist: exactly the functions the two-node gate drives,
 * each with the shape its module exports. `owner` actions take this node's own
 * instance id and a `send` bound to the contact whose queue they flush; `visitor`
 * actions bind it to the OWNER contact of the visit (as the dashboard routes do).
 */
const C2C_OPS = Object.freeze({
  inviteContact: { module: "owner.js", shape: "owner" },
  setRole: { module: "owner.js", shape: "owner" },
  unshareContact: { module: "owner.js", shape: "owner" },
  listLiveMembers: { module: "owner.js", shape: "owner-list" },
  acceptVisit: { module: "visitor.js", shape: "visitor" },
  declineVisit: { module: "visitor.js", shape: "visitor" },
  leaveVisit: { module: "visitor.js", shape: "visitor" },
  listVisits: { module: "visitor.js", shape: "visitor-list" },
});
const c2cModules = new Map();

function loadC2cModule(file) {
  if (!c2cModules.has(file)) c2cModules.set(file, imp(`servers/sharing/c2c/${file}`));
  return c2cModules.get(file);
}

/**
 * The production c2c transport, loaded on demand: an old tree (tests/fixtures/
 * old-tree.mjs) has no servers/sharing/c2c yet, and this child must still start
 * against one (the `c2c` op is never used there).
 */
let transportModule = null;
async function transport() {
  if (!transportModule) transportModule = await imp("servers/sharing/c2c/transport.js");
  return transportModule;
}

/** `(frame) => c2cSend(peerManager, crowId, frame)` for one contact, or null. */
async function sendForContact(contactId) {
  const { c2cSendForContact } = await transport();
  return c2cSendForContact(db, peerManager, contactId);
}

/** The owner contact of a visit: the queue its answer flushes onto. */
async function ownerContactOfVisit(visitId) {
  if (!Number.isSafeInteger(visitId) || visitId <= 0) return null;
  const rows = toObjects(await db.execute({ sql: "SELECT owner_contact_id FROM c2c_visits WHERE id = ? LIMIT 1", args: [visitId] }));
  const id = Number(rows[0]?.owner_contact_id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const ops = {
  async tool({ name, args = {} }) {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { text, isError: !!r.isError };
  },
  async sql({ sql, args = [] }) {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error("sql is read-only (SELECT / WITH)");
    return toObjects(await db.execute({ sql, args }));
  },
  async exec({ sql, args = [] }) {
    // Seeding only: this node's own memories (the item a test then shares), and —
    // for the Crow-to-Crow two-node gate — a project with its local owner row,
    // which every owner action needs `manage_members` for.
    if (!/^\s*INSERT INTO (memories|project_spaces|project_members)\b/i.test(sql)) {
      throw new Error("exec only inserts into memories, project_spaces or project_members");
    }
    const r = await db.execute({ sql, args });
    return { lastInsertRowid: Number(r.lastInsertRowid) };
  },
  async identity() {
    return {
      crowId: identity.crowId,
      instanceId: localInstanceIdNow(),
      ed25519Pubkey: identity.ed25519Pubkey,
      secp256k1Pubkey: identity.secp256k1Pubkey,
    };
  },
  /**
   * Call one allowlisted Crow-to-Crow function with THIS node's real db, local
   * instance id and live-peer send. The module's own `flushAfterCommit` then sends
   * the frame(s) the action queued, and a frame it cannot send stays queued for the
   * boot's flush-on-connect / 60 s tick — exactly as on a real host.
   */
  async c2c({ fn, args = {} } = {}) {
    const spec = C2C_OPS[fn];
    if (!spec) throw new Error(`c2c: ${fn} is not an allowlisted Crow-to-Crow function`);
    const mod = await loadC2cModule(spec.module);
    const call = mod[fn];
    if (typeof call !== "function") throw new Error(`c2c: ${spec.module} exports no ${fn}`);
    let value;
    if (spec.shape === "owner") {
      const contactId = Number(args.contactId);
      value = await call(db, {
        ...args,
        localInstanceId: localInstanceIdNow(),
        actor: "local",
        send: await sendForContact(contactId),
      });
    } else if (spec.shape === "owner-list") {
      value = await call(db, args.projectId);
    } else if (spec.shape === "visitor") {
      value = await call(db, {
        ...args,
        localInstanceId: localInstanceIdNow(),
        send: await sendForContact(await ownerContactOfVisit(Number(args.visitId))),
      });
    } else {
      value = await call(db);
    }
    return value === undefined ? { ok: true } : value;
  },
  async seedHex() {
    // For a positive-control harness only (an "honest" second holder of this seed).
    return Buffer.from(identity.seed).toString("hex");
  },
  async isConnected({ crowId, instanceId }) {
    // No instance id: the contact-level answer (the newest live connection).
    return peerManager.isConnected(crowId, instanceId);
  },
  /**
   * The per-instance index, read-only: `primary` is the instance `send()` would use
   * (`connections.get(crowId)`, i.e. the NEWEST connection — the wrong sibling, when
   * a test wants it to be), `instances` everything `sendTo` can reach, newest first.
   */
  async peerRouting({ crowId }) {
    const primary = peerManager.connections?.get?.(crowId)?.instanceId ?? null;
    const instances = typeof peerManager.connectedInstances === "function"
      ? peerManager.connectedInstances(crowId)
      : [];
    return { primary, instances };
  },
  async stop() {
    setTimeout(async () => {
      try { await peerManager.destroy(); } catch {}
      process.exit(0);
    }, 10);
    return true;
  },
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

/**
 * Whether the boot has announced this node on every full contact's DHT topic.
 * The boot joins those topics after peerManager.start(), asynchronously. A
 * Hyperswarm join is one DHT traversal that collects peers on the way and
 * stores this node's record at the end, so a peer that joins the same topic
 * while that traversal is still running can miss this node (and this node
 * miss it) until the next refresh, ten minutes later: a restarted node and a
 * test peer started right after it never connect. Once the first announce has
 * completed, any peer that joins later finds this node on its own lookup.
 * Resolves null when announced, or the reason it is not by `deadline`.
 */
async function contactTopicsAnnounced(deadline) {
  const pause = () => new Promise((r) => setTimeout(r, 50));
  // The rows the boot joins (boot.js initSharingRuntime): full contacts only.
  const ids = toObjects(await db.execute({
    sql: "SELECT crow_id FROM contacts WHERE is_blocked = 0 AND ed25519_pubkey != '' "
      + "AND (request_status IS NULL OR request_status NOT IN ('pending', 'accepted'))",
    args: [],
  })).map((r) => r.crow_id);
  const missing = () => ids.filter((id) => !peerManager.topics?.has(id));
  while (missing().length > 0) {
    if (Date.now() > deadline) return `contact topics not joined: ${missing().join(", ")}`;
    await pause();
  }
  const flushed = Promise.all(ids.map((id) => peerManager.swarm.status(peerManager.topics.get(id))?.flushed()));
  const late = new Promise((r) => setTimeout(() => r("late"), Math.max(deadline - Date.now(), 0)));
  return (await Promise.race([flushed, late])) === "late" ? "a contact topic announce did not complete" : null;
}

// Ready: the swarm exists, the Nostr receive path is wired (a node must be
// subscribed before a peer publishes its invite acceptance), and this node is
// announced on every full contact's topic (contactTopicsAnnounced above).
const t0 = Date.now();
while (Date.now() - t0 < 30_000) {
  if (peerManager.swarm && getReceiveHealth().receiveWired === true) break;
  await new Promise((r) => setTimeout(r, 50));
}
const h = getReceiveHealth();
if (!peerManager.swarm || h.receiveWired !== true) {
  reply({ ready: false, error: `not ready: swarm=${!!peerManager.swarm} receiveWired=${h.receiveWired} ${h.lastError || ""}` });
} else {
  const notAnnounced = await contactTopicsAnnounced(t0 + 40_000); // inside the parent's 45 s ready wait
  if (notAnnounced) reply({ ready: false, error: `not ready: ${notAnnounced}` });
  else reply({ ready: true, identity: await ops.identity() });
}
