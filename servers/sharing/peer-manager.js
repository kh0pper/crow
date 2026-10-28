/**
 * Peer Discovery & Connection Manager
 *
 * Uses Hyperswarm DHT for peer-to-peer discovery:
 * - Topic = hash(sorted pubkey pair) — unique per contact
 * - Challenge-response auth on connect: a contact proves the key pinned in its
 *   contact row, a sibling proves our own key (PT-3, private engineering notes)
 * - Connection state tracking and reconnection
 */

import Hyperswarm from "hyperswarm";
import { shouldInitInstanceSync } from "./instance-sync.js";
import { createHash, randomBytes } from "node:crypto";
import { sign, verify, crowIdMatchesKey } from "./identity.js";
import { contactCbMessage, decideContactProof, RefusalLog } from "./contact-binding.js";
import { ENROLL_ID_RE } from "../shared/enroll-guard.js";

// 2c follow-up (spec §F2 C2c): hard cap on awaiting the DHT announce
// confirmation (`discovery.flushed()`) in joinContact. An unresponsive DHT
// must not wedge the boot per-contact join loop (boot.js) or the inbound
// sync apply chain (wireFullContact → joinContact). Overridable per-call via
// opts.flushedCapMs (tests).
const FLUSHED_CAP_MS = 10_000;

/**
 * PT-2.0 off switch for the Hyperswarm instance-sync path (instance topic
 * join, feed-key piggyback, instance replication). On by default; only
 * CROW_INSTANCE_SYNC_HYPERSWARM=0 turns it off. Contacts on Hyperswarm and
 * the tailnet instance-sync transport are not affected.
 */
export function hyperswarmInstanceSyncEnabled(env = process.env) {
  return env?.CROW_INSTANCE_SYNC_HYPERSWARM !== "0";
}

const REFUSE_LOG_EVERY_MS = 60_000;

// "contact <id> is on older Crow" is logged once per Crow ID per process.
// Bounded by the contact list: only a peer that proved a pinned key gets here.
const legacyLogged = new Set();

/** This connection's Noise handshake hash, hex, or null before it opens. */
function hashHexOf(conn) {
  const h = conn?.handshakeHash;
  if (!h?.length) return null;
  return Buffer.from(h).toString("hex");
}

/** Our end of the Noise stream, as signed into a cb_sig; null when unknown. */
function roleOf(conn) {
  if (typeof conn?.isInitiator !== "boolean") return null;
  return conn.isInitiator ? "init" : "resp";
}
/** The other end's role: what a peer's cb_sig on this connection must name. */
function peerRoleOf(conn) {
  const r = roleOf(conn);
  return r === "init" ? "resp" : r === "resp" ? "init" : null;
}

/** A verify() that throws is a refusal, never a pass. */
function verifies(fn) {
  try { return fn() === true; } catch { return false; }
}

/** Call a callback without awaiting it; a throw or rejection is contained. */
function fire(fn) {
  try { Promise.resolve(fn()).catch(() => {}); } catch {}
}

/** A plausible Crow ID (checked before any lookup): a short printable token. */
const CROW_ID_SHAPE = /^[A-Za-z0-9:._-]{1,64}$/;

/** A peer-supplied id, safe for one log line. */
function logSafe(v) {
  return String(v ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, 100);
}

/**
 * Create a deterministic topic for a contact pair.
 * topic = sha256(sorted(myPubkey, theirPubkey))
 */
function computeTopic(myEd25519Pub, theirEd25519Pub) {
  const keys = [myEd25519Pub, theirEd25519Pub].sort();
  return createHash("sha256")
    .update(keys[0])
    .update(keys[1])
    .digest();
}

export class PeerManager {
  /**
   * @param {object} identity
   * @param {object} [opts]
   * @param {object} [opts.env]            switch source (CROW_INSTANCE_SYNC_HYPERSWARM)
   * @param {object} [opts.swarmOptions]   passed to `new Hyperswarm()` (e.g. a local bootstrap)
   * @param {number} [opts.preAuthMaxLines] lines an unadmitted peer may send
   * @param {number} [opts.preAuthMaxBytes] bytes an unadmitted peer may send
   * @param {number} [opts.preAuthMs]       time an unadmitted peer may take
   */
  constructor(identity, {
    env = process.env,
    swarmOptions = undefined,
    preAuthMaxLines = 64,
    preAuthMaxBytes = 65_536,
    preAuthMs = 15_000,
    pairBindingWaitMs = 10_000,
  } = {}) {
    this.identity = identity;
    this.instanceSyncEnabled = hyperswarmInstanceSyncEnabled(env);
    this.swarmOptions = swarmOptions;
    this.preAuthMaxLines = preAuthMaxLines;
    this.preAuthMaxBytes = preAuthMaxBytes;
    this.preAuthMs = preAuthMs;
    // PT-2a: how long a sibling that offered pair binding may take to send
    // its `pair-binding` frame once we have proven ourselves to it.
    this.pairBindingWaitMs = pairBindingWaitMs;
    // Async hooks run first in _admit: ({ conn, msg, state, remoteInstanceId }) => { ok, reason }.
    // `instance` is the PT-2a pair-binding guard, set by wireInstanceSync
    // (instance-connect.js). Unset, every sibling is refused (guard:unwired).
    this.admitGuards = { instance: null, contact: null };
    // { macFor({ peerInstanceId, challengeHex, handshakeHashHex }) → hex|null },
    // set by wireInstanceSync: the pair MAC our `pair-binding` frame carries.
    this.instanceBinding = null;
    this._unwiredLogged = false;
    // { lookupKey, isCbPinned, markCbPinned }, set by wireContactBinding (boot.js).
    // Unset, every foreign Crow ID is refused (no_binding).
    this.contactBinding = null;
    this._refusalLog = new RefusalLog({ max: 256, intervalMs: REFUSE_LOG_EVERY_MS });
    this._noBindingLogged = false;
    this._lastRefuseLog = 0;
    this.swarm = null;
    this.connections = new Map(); // crowId -> { conn, authenticated }
    this.topics = new Map(); // crowId -> topic buffer
    this.instanceSyncTopic = null; // Buffer — the instance sync DHT topic
    this.onPeerConnected = null; // callback(crowId, conn)
    this.onPeerData = null; // callback(crowId, data)
    this.onPeerDisconnected = null; // callback(crowId)
    this.onInstanceConnected = null; // callback(crowId, conn, remoteInstanceId|null) — instance-to-instance connections
    this.onInstanceKeyReceived = null; // callback(remoteInstanceId, feedKeyHex) — a proven sibling advertised its outgoing Hypercore feed key
    this.getFeedKeyForInstance = null; // async (remoteInstanceId) => hex — our outgoing feed key to this specific peer instance
    this.localInstanceId = null; // wired by server.js — the local Crow instance id we advertise to peers

    // A --no-auth companion gateway (e.g. grackle's loopback crow-mcp-bridge) is
    // never a peer — it must NOT run the Hyperswarm P2P layer, or it steals the
    // DHT-topic connection (and per-contact feed locks) from the PRIMARY gateway,
    // starving the primary's cross-instance replication. Same signal as the
    // instance-sync feed gate. See shouldInitInstanceSync().
    this.p2pDisabled = !shouldInitInstanceSync({ argv: process.argv, env: process.env });
  }

  /**
   * Initialize Hyperswarm and start listening.
   */
  async start() {
    if (this.p2pDisabled) return this; // --no-auth companion: no swarm
    this.swarm = new Hyperswarm(this.swarmOptions);

    this.swarm.on("connection", (conn, info) => {
      this._handleConnection(conn, info);
    });

    return this;
  }

  /**
   * Join the DHT topic for a specific contact.
   * @param {{crowId?:string, crow_id?:string, ed25519Pubkey:string}} contact
   * @param {{flushedCapMs?:number}} [opts] override the flushed() cap (tests)
   */
  async joinContact(contact, opts = {}) {
    if (this.p2pDisabled) return null; // --no-auth companion: no DHT topics
    if (!this.swarm) throw new Error("PeerManager not started");
    const cap = Number(opts.flushedCapMs) > 0 ? Number(opts.flushedCapMs) : FLUSHED_CAP_MS;

    const topic = computeTopic(
      this.identity.ed25519Pubkey,
      contact.ed25519Pubkey
    );

    this.topics.set(contact.crow_id || contact.crowId, topic);

    const discovery = this.swarm.join(topic, { server: true, client: true });
    // Cap ONLY the announce-confirmation await (C2c). The topic registration
    // (topics.set above) and the announce (swarm.join above) have already
    // fired — flushed() merely confirms the announce reached the DHT. On cap
    // we proceed: only the confirmation is abandoned, never the announce.
    // Timer is cleared when flushed() wins (no dangling timer).
    let timer;
    const guard = new Promise((resolve) => {
      timer = setTimeout(() => resolve("__flushed_cap__"), cap);
    });
    try {
      const r = await Promise.race([discovery.flushed(), guard]);
      if (r === "__flushed_cap__") {
        console.warn(`[peer-manager] joinContact: discovery.flushed() exceeded ${cap}ms — proceeding without DHT announce confirmation`);
      }
    } finally {
      clearTimeout(timer);
    }

    return topic;
  }

  /**
   * Leave a contact's topic (disconnect).
   */
  async leaveContact(crowId) {
    const topic = this.topics.get(crowId);
    if (topic) {
      await this.swarm.leave(topic);
      this.topics.delete(crowId);
    }
    const conn = this.connections.get(crowId);
    if (conn) {
      conn.conn.destroy();
      this.connections.delete(crowId);
    }
  }

  /**
   * Join the instance sync DHT topic.
   * All instances owned by the same Crow ID join this topic for P2P discovery.
   * topic = sha256(crowId + "instance-sync")
   * @param {{flushedCapMs?:number}} [opts] override the flushed() cap (tests)
   */
  async joinInstanceSync(opts = {}) {
    if (this.p2pDisabled) return null; // --no-auth companion: no instance-sync topic
    if (!this.instanceSyncEnabled) {
      console.log("[peer-manager] Hyperswarm instance sync is off (CROW_INSTANCE_SYNC_HYPERSWARM=0); not joining the instance topic");
      return null;
    }
    if (!this.swarm) throw new Error("PeerManager not started");
    const cap = Number(opts.flushedCapMs) > 0 ? Number(opts.flushedCapMs) : FLUSHED_CAP_MS;

    this.instanceSyncTopic = createHash("sha256")
      .update(this.identity.crowId + "instance-sync")
      .digest();

    const discovery = this.swarm.join(this.instanceSyncTopic, { server: true, client: true });
    // Cap ONLY the announce-confirmation await (C2c, same shape as
    // joinContact). The topic registration (instanceSyncTopic above) and the
    // announce (swarm.join above) have already fired — flushed() merely
    // confirms the announce reached the DHT. On cap we proceed: only the
    // confirmation is abandoned, never the announce. Timer is cleared when
    // flushed() wins (no dangling timer).
    let timer;
    const guard = new Promise((resolve) => {
      timer = setTimeout(() => resolve("__flushed_cap__"), cap);
    });
    try {
      const r = await Promise.race([discovery.flushed(), guard]);
      if (r === "__flushed_cap__") {
        console.warn(`[peer-manager] joinInstanceSync: discovery.flushed() exceeded ${cap}ms — proceeding without DHT announce confirmation`);
      }
    } finally {
      clearTimeout(timer);
    }

    console.log(`[peer-manager] Joined instance sync topic for ${this.identity.crowId}`);
    return this.instanceSyncTopic;
  }

  /**
   * Check if a connection came from the instance sync topic.
   */
  _isInstanceConnection(info) {
    if (!this.instanceSyncTopic || !info?.topics) return false;
    return info.topics.some(t => t.equals(this.instanceSyncTopic));
  }

  /**
   * Handle an incoming connection: challenge-response auth (PT-3).
   *
   * Lines run on a per-connection promise chain, so each frame is handled
   * only after every earlier one. Before admission only `challenge` and
   * `challenge-response` are acted on; any other frame is held in order and
   * dispatched after admission (dropped on refusal). The caps bound what an
   * unadmitted peer can make us hold: preAuthMaxLines lines, preAuthMaxBytes
   * bytes received (with or without a newline), and preAuthMs from connect.
   */
  _handleConnection(conn, info) {
    const challenge = randomBytes(32);
    const state = {
      authenticated: false,
      remoteCrowId: null,
      remoteInstanceId: null,
      isInstanceConn: this._isInstanceConnection(info),
      kind: null,          // "contact" | "instance", set by _admit
      proof: null,         // "cb" | "sig"
      pinnedKey: null,
      refused: false,
      closed: false,
      deciding: false,
      peerAuthed: false,   // the peer's own `authenticated` frame was handled
      peerAuthSeen: false, // ...or has at least arrived on the stream (caps)
      mutual: false,       // we admitted it AND it admitted us: side effects run
      answered: false,
      handshakeHashHex: null,
      ourChallengeHex: challenge.toString("hex"),
      peerInstanceId: null,
      ourPb: false,        // our challenge offered pair binding (pb: 1)
      peerPb: null,        // the peer's cb challenge offered it: { challengeHex }
      pbFrame: undefined,  // the peer's `pair-binding` frame: { pb_mac } once it arrived
      pbWaiters: [],
      deferredReply: null, // a no-cb asker's challenge, answered only after admission
      held: [],
      preBytes: 0,
      preLines: 0,
      hadEntry: false,
    };

    // On instance-sync connections the instance_id lets the peer find OUR row
    // in its crow_instances table (crow_id alone is ambiguous: all instances
    // of one user share one Crow identity). Sent on contact connections too;
    // the receiver ignores it for other users. `cb: 1` asks for a reply bound
    // to this connection (a cb_sig) instead of a bare signature; `pb: 1`
    // (PT-2a, only with cb) asks a sibling to add a pair MAC (pb_mac).
    const challengePayload = {
      type: "challenge",
      challenge: challenge.toString("hex"),
      cb: 1,
      pubkey: this.identity.ed25519Pubkey,
      crowId: this.identity.crowId,
    };
    if (this.instanceSyncEnabled) { challengePayload.pb = 1; state.ourPb = true; }
    if (this.localInstanceId) {
      challengePayload.instance_id = this.localInstanceId;
    }
    conn.write(JSON.stringify(challengePayload) + "\n");

    // The Noise handshake hash binds a cb_sig to this one connection. It is
    // read from our own stream once it opens, never taken from the peer.
    let chain = (async () => {
      try {
        if (conn.opened && typeof conn.opened.then === "function") await conn.opened;
      } catch {}
      state.handshakeHashHex = hashHexOf(conn);
    })();

    // Armed at connect, re-armed at our admission: a peer that is not
    // mutually admitted within preAuthMs of either point is closed.
    let timer = null;
    state.clearTimer = () => clearTimeout(timer);
    state.armTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (!state.mutual) this._kill(conn, state); }, this.preAuthMs);
      timer.unref?.();
    };
    state.armTimer();

    // The caps count until both sides have admitted each other. Checked per
    // line on arrival: once we have decided and the peer's own
    // `authenticated` has come in on the stream, what follows is post-admission.
    const capped = () => !(state.mutual || (state.authenticated && state.peerAuthSeen));
    let buffer = "";
    conn.on("data", (data) => {
      if (state.refused || state.closed) return;
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop(); // Keep incomplete line

      for (const line of lines) {
        if (capped()) {
          state.preBytes += Buffer.byteLength(line) + 1;
          if (state.preBytes > this.preAuthMaxBytes
              || (line.trim() && ++state.preLines > this.preAuthMaxLines)) { this._kill(conn, state); return; }
        }
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // Ignore parse errors
        if (msg?.type === "authenticated") state.peerAuthSeen = true;
        // A sibling's pair-binding frame is read OUTSIDE the frame chain: our
        // admission may be waiting on it inside the chain (see _admit).
        if (msg?.type === "pair-binding") { this._onPairBindingFrame(msg, state); continue; }
        chain = chain.then(() => this._handleMessage(conn, msg, challenge, state)).catch(() => {});
      }
      if (capped() && state.preBytes + Buffer.byteLength(buffer) > this.preAuthMaxBytes) this._kill(conn, state);
    });

    // Remove only OUR entry: a refused or superseded connection closing must
    // never knock the live connection for the same Crow ID offline.
    const dropEntry = () => {
      const id = state.remoteCrowId;
      if (id && this.connections.get(id)?.conn === conn) {
        this.connections.delete(id);
        state.hadEntry = true;
      }
    };
    conn.on("close", () => {
      state.closed = true;
      for (const w of state.pbWaiters) w(null);
      state.pbWaiters = [];
      clearTimeout(timer);
      dropEntry();
      if (state.hadEntry && this.onPeerDisconnected) this.onPeerDisconnected(state.remoteCrowId);
    });

    conn.on("error", () => {
      dropEntry();
    });
  }

  /**
   * Handle one protocol frame. Async: callers await it (the connection chain
   * does). `state` is the connection's state object, mutated in place;
   * `setState`, if given, is called with it afterwards.
   */
  async _handleMessage(conn, msg, ourChallenge, state = {}, setState = null) {
    if (!msg || typeof msg !== "object" || state.refused) return;
    if (!Array.isArray(state.held)) state.held = [];
    switch (msg.type) {
      case "challenge":
        await this._onChallenge(conn, msg, state);
        break;
      case "challenge-response":
        await this._onChallengeResponse(conn, msg, ourChallenge, state);
        break;
      case "pair-binding":
        this._onPairBindingFrame(msg, state);
        break;
      case "authenticated":
        // The other side admitted us. Recorded whenever it arrives; the
        // admission side effects wait for both halves.
        state.peerAuthed = true;
        if (state.authenticated && !state.mutual) await this._completeAdmit(conn, state);
        break;
      default:
        if (state.mutual) await this._dispatchAdmitted(conn, msg, state);
        else state.held.push(msg);
    }
    if (typeof setState === "function") setState(state);

    // NOTE: a "feed-key-announce" case lived here until 2026-07. Nothing in
    // the codebase ever SENT that message type, and the handler passed
    // state.remoteCrowId where onInstanceKeyReceived requires an INSTANCE id
    // (crow_id is shared fleet-wide and can never key a crow_instances row).
    // Feed keys now ride `instance-key` (new siblings) or the deferred
    // challenge-response (old siblings), both after the peer has proven our key.
  }

  /**
   * Their challenge (we are the responder). Signs ONLY a challenge shaped like
   * ours (32 random bytes, hex), which keeps every signature disjoint from the
   * colon-delimited messages signed elsewhere (tailnet-sync hello, CR proof).
   *
   * - `cb: 1`: reply now with a cb_sig bound to this connection's handshake
   *   hash. Relayed to any other connection, it fails.
   * - no `cb` (an older asker): hold the reply. _admit releases it once the
   *   asker has proven a pinned contact key, or our own key, here. A
   *   connection that is never admitted is never signed for, so this node is
   *   no signing oracle.
   */
  async _onChallenge(conn, msg, state) {
    if (typeof msg.challenge !== "string" || !/^[0-9a-f]{64}$/.test(msg.challenge)) {
      this._kill(conn, state);
      return;
    }
    // Our own challenge sent back to us is never answered: on one connection
    // the two ends must never sign for the same nonce.
    if (state.ourChallengeHex && msg.challenge === state.ourChallengeHex) {
      this._kill(conn, state);
      if (this._refusalLog.shouldLog("challenge_reflected")) console.warn("[peer-manager] connection refused: challenge_reflected");
      return;
    }
    // One challenge per connection, and only before admission: every
    // compliant peer writes its challenge first, on connect.
    if (state.answered || state.authenticated || state.deciding) return;
    state.answered = true;
    if (typeof msg.instance_id === "string" && msg.instance_id) state.peerInstanceId = msg.instance_id;

    if (msg.cb === 1) {
      const hh = state.handshakeHashHex || hashHexOf(conn);
      const role = roleOf(conn);
      if (!hh || !role) { this._kill(conn, state); return; }
      const cbSig = sign(contactCbMessage({
        role,
        signerCrowId: this.identity.crowId,
        challengeHex: msg.challenge,
        handshakeHashHex: hh,
      }), this.identity.ed25519Priv);
      conn.write(JSON.stringify({
        type: "challenge-response",
        pubkey: this.identity.ed25519Pubkey,
        crowId: this.identity.crowId,
        cb_sig: cbSig,
      }) + "\n");
      // PT-2a: the pair MAC is NOT in this reply. The asker has proven
      // nothing yet (our Crow ID is public), so the reply is the same for
      // everyone. Its offer is remembered; the MAC goes out in a separate
      // `pair-binding` frame only after it proves the seed (_admit).
      if (msg.pb === 1) state.peerPb = { challengeHex: msg.challenge };
      return;
    }
    state.deferredReply = { challengeHex: msg.challenge, instanceId: state.peerInstanceId, sent: false };
  }

  /** Their answer to our challenge: decide, then _admit or refuse. */
  async _onChallengeResponse(conn, msg, ourChallenge, state) {
    if (state.authenticated || state.deciding) return;
    state.deciding = true;
    if (typeof msg.crowId !== "string" || !CROW_ID_SHAPE.test(msg.crowId)) {
      return this._refuseContact(conn, state, msg.crowId, "not_contact");
    }
    state.claimedCrowId = msg.crowId;
    const nonce = Buffer.isBuffer(ourChallenge) ? ourChallenge.toString("hex") : String(ourChallenge ?? "");
    const hh = state.handshakeHashHex || hashHexOf(conn);
    if (msg.crowId === this.identity.crowId) {
      await this._onSiblingResponse(conn, msg, nonce, hh, state);
    } else {
      await this._onContactResponse(conn, msg, nonce, hh, state);
    }
  }

  /**
   * A peer claiming OUR Crow ID is on the instance path (PT-2.0): siblings
   * share the seed, so it must prove OUR key, as a cb_sig or a bare
   * signature. No contact pin applies.
   */
  async _onSiblingResponse(conn, msg, nonce, hh, state) {
    if (!this.instanceSyncEnabled) return this._refuseInstance(conn, state, "off");
    const ours = this.identity.ed25519Pubkey;
    if (msg.pubkey !== ours) return this._refuseInstance(conn, state, "key");
    let ok = false;
    if (msg.cb_sig !== undefined && msg.cb_sig !== null) {
      state.proof = "cb";
      ok = verifies(() => verify(contactCbMessage({ role: peerRoleOf(conn), signerCrowId: this.identity.crowId, challengeHex: nonce, handshakeHashHex: hh }), msg.cb_sig, ours));
    } else if (msg.signature !== undefined && msg.signature !== null) {
      state.proof = "sig";
      ok = verifies(() => verify(nonce, msg.signature, ours));
    }
    if (!ok) return this._refuseInstance(conn, state, "key");
    // Once any sibling has bound, a bare-signature sibling proof is refused
    // (the sibling counterpart of the contact pin). No binding wired means no
    // pin store, as before; a read error counts as pinned.
    const binding = this.contactBinding;
    if (state.proof === "sig" && typeof binding?.isInstanceCbPinned === "function") {
      let pinned;
      try { pinned = (await binding.isInstanceCbPinned(this.identity.crowId)) !== false; } catch { pinned = true; }
      if (pinned) return this._refuseInstance(conn, state, "cb_required_pinned");
    }
    await this._admit(conn, state, msg, "instance");
  }

  /**
   * A foreign Crow ID: admitted only on the key pinned in its contact row.
   * `msg.pubkey` is checked against the pin and never used for anything else.
   * Checks in order; the first failure refuses (see the private engineering
   * notes for the table).
   */
  async _onContactResponse(conn, msg, nonce, hh, state) {
    const crowId = state.claimedCrowId;
    const binding = this.contactBinding;
    if (!binding || typeof binding.lookupKey !== "function") return this._refuseContact(conn, state, crowId, "no_binding");

    let pinned;
    try {
      pinned = await binding.lookupKey(crowId);
    } catch {
      return this._refuseContact(conn, state, crowId, "lookup_failed");
    }
    if (typeof pinned !== "string" || !pinned) return this._refuseContact(conn, state, crowId, "not_contact");
    pinned = pinned.toLowerCase();
    if (!crowIdMatchesKey(crowId, pinned)) return this._refuseContact(conn, state, crowId, "pin_crowid_mismatch");
    if (msg.pubkey !== undefined && msg.pubkey !== null
        && (typeof msg.pubkey !== "string" || msg.pubkey.toLowerCase() !== pinned)) {
      return this._refuseContact(conn, state, crowId, "key_mismatch");
    }

    const cbPresent = msg.cb_sig !== undefined && msg.cb_sig !== null;
    const sigPresent = !cbPresent && msg.signature !== undefined && msg.signature !== null;
    const cbValid = cbPresent
      && verifies(() => verify(contactCbMessage({ role: peerRoleOf(conn), signerCrowId: crowId, challengeHex: nonce, handshakeHashHex: hh }), msg.cb_sig, pinned));
    const sigValid = sigPresent && verifies(() => verify(nonce, msg.signature, pinned));
    let cbPinned = false;
    if (sigPresent && sigValid) {
      try {
        cbPinned = (await binding.isCbPinned(crowId)) !== false;
      } catch {
        cbPinned = true; // fail closed
      }
    }
    const d = decideContactProof({ cbPresent, cbValid, sigPresent, sigValid, cbPinned });
    if (!d.ok) return this._refuseContact(conn, state, crowId, d.reason);
    state.proof = d.bound ? "cb" : "sig";
    state.pinnedKey = pinned;
    await this._admit(conn, state, msg, "contact");
  }

  /**
   * The one place a connection is admitted. Every side effect of admission
   * happens here, after the decision and after admitGuards[kind]: the pin,
   * state, the `authenticated` frame, the deferred challenge-response and
   * `instance-key`; then, once the peer has admitted us too (_completeAdmit),
   * the connections entry, the callbacks and the held frames.
   */
  async _admit(conn, state, msg, kind) {
    // A sibling is admitted under ONE instance id, resolved before the guard
    // (private engineering notes, PT-2a "one id"): the id it challenged with,
    // else the one in its response. Two different ids, a malformed id, or our
    // own id never reach the guard. Every later use reads this one.
    let remoteInstanceId = null;
    if (kind === "instance") {
      const c = state.peerInstanceId || null;
      const r = (typeof msg.instance_id === "string" && msg.instance_id) || null;
      if (c && r && c !== r) { this._refuseInstance(conn, state, "instance_id_mismatch"); return false; }
      remoteInstanceId = c ?? r ?? null;
      if (remoteInstanceId !== null && !ENROLL_ID_RE.test(remoteInstanceId)) {
        this._refuseInstance(conn, state, "bad_instance_id");
        return false;
      }
      // Self-loopback: the DHT can return ourselves on the instance-sync topic.
      // Nothing to sync with ourselves; drop before the guard and any side effect.
      if (remoteInstanceId && remoteInstanceId === this.localInstanceId) {
        this._kill(conn, state);
        return false;
      }
      state.remoteInstanceId = remoteInstanceId;
    }

    const guard = this.admitGuards?.[kind];
    // PT-2a I3: a sibling is admitted only through the pair-binding guard.
    // Nothing wired (a PeerManager built without wireInstanceSync) fails closed.
    if (kind === "instance" && this.instanceSyncEnabled && typeof guard !== "function") {
      this._kill(conn, state);
      if (!this._unwiredLogged) {
        this._unwiredLogged = true;
        console.warn("[peer-manager] instance-sync connection refused: guard:unwired");
      }
      return false;
    }
    let pbMac;
    if (kind === "instance") {
      // PT-2a pair binding (private engineering notes §3.5). The peer has
      // proven the seed here, so it may now learn our MAC; each side sends
      // its frame before running its own guard (each guard needs the other's
      // frame, so gating it on admission would deadlock).
      // Only a cb_sig prover: a bare signature can be relayed from an older
      // sibling (a pre-PT-3 signing oracle), so it never learns our MAC.
      if (state.peerPb && state.proof === "cb" && this.instanceSyncEnabled && msg.crowId === this.identity.crowId) {
        let mac = null;
        try {
          mac = this.instanceBinding?.macFor?.({
            peerInstanceId: remoteInstanceId,
            challengeHex: state.peerPb.challengeHex,
            handshakeHashHex: state.handshakeHashHex || hashHexOf(conn),
          }) ?? null;
        } catch {}
        conn.write(JSON.stringify({ type: "pair-binding", pb_mac: typeof mac === "string" && mac ? mac : null }) + "\n");
      }
      // Both offered (and it proved with a cb_sig): wait (bounded) for the
      // peer's frame. A peer that did not offer (PT-3, pre-PT-3) or proved
      // with a bare signature is decided unbound at once.
      if (state.ourPb && state.peerPb && state.proof === "cb") {
        const frame = await this._awaitPairBindingFrame(state, this.pairBindingWaitMs);
        if (state.refused || state.closed || conn.destroyed) return false;
        if (!frame) { this._refuseInstance(conn, state, "guard:pb_timeout"); return false; }
        pbMac = frame.pb_mac;
      }
    }

    if (typeof guard === "function") {
      let verdict;
      try {
        verdict = await guard({ conn, msg, state, remoteInstanceId, pbMac });
      } catch {
        verdict = { ok: false, reason: "error" };
      }
      if (!verdict || verdict.ok !== true) {
        const reason = `guard:${verdict?.reason ?? "refused"}`;
        if (kind === "contact") this._refuseContact(conn, state, state.claimedCrowId, reason);
        else this._refuseInstance(conn, state, reason);
        return false;
      }
    }
    if (state.refused || state.closed || conn.destroyed) return false;

    const crowId = state.claimedCrowId;

    if (kind === "contact") {
      if (state.proof === "cb") {
        try { await this.contactBinding.markCbPinned(crowId); } catch {}
      } else if (!legacyLogged.has(crowId)) {
        legacyLogged.add(crowId);
        console.log(`[peer-manager] contact ${logSafe(crowId)} is on older Crow: no channel binding`);
      }
      if (state.refused || state.closed || conn.destroyed) return false;
    } else if (state.proof === "cb" && typeof this.contactBinding?.markInstanceCbPinned === "function") {
      try { await this.contactBinding.markInstanceCbPinned(this.identity.crowId); } catch {}
      if (state.refused || state.closed || conn.destroyed) return false;
    }

    state.armTimer?.();
    state.authenticated = true;
    state.remoteCrowId = crowId;
    state.kind = kind;
    state.admitMsg = msg;

    conn.write(JSON.stringify({ type: "authenticated" }) + "\n");

    await this._sendDeferredReply(conn, state);

    if (kind === "instance") {
      // A new sibling (cb proof) gets our feed key in its own frame; an old
      // one got it on the deferred challenge-response above.
      if (state.proof === "cb" && this.localInstanceId && remoteInstanceId && this.getFeedKeyForInstance) {
        let feedKeyHex = null;
        try { feedKeyHex = await this.getFeedKeyForInstance(remoteInstanceId); } catch {}
        if (feedKeyHex && !state.closed) {
          conn.write(JSON.stringify({ type: "instance-key", instance_id: this.localInstanceId, feed_key_hex: feedKeyHex }) + "\n");
        }
      }
    }

    if (state.peerAuthed) await this._completeAdmit(conn, state);
    return true;
  }

  /**
   * The second half of _admit, run once BOTH sides have admitted each other
   * (our decision, then the peer's `authenticated`, in either order). Only
   * now is the peer connected: a peer sends nothing but handshake frames
   * until it is told it was admitted, so its data never races our decision.
   */
  async _completeAdmit(conn, state) {
    if (state.mutual || !state.authenticated || !state.peerAuthed || state.refused || state.closed) return;
    state.mutual = true;
    state.clearTimer?.();
    const msg = state.admitMsg;
    const crowId = state.remoteCrowId;

    this.connections.set(crowId, {
      conn,
      authenticated: true,
      pubkey: state.kind === "contact" ? state.pinnedKey : this.identity.ed25519Pubkey,
    });

    if (state.kind === "instance") {
      // An old sibling piggybacks its feed key on its (now verified)
      // challenge-response. Persist it before dispatching, so the
      // onInstanceConnected handler can open the inbound feed at once.
      if (state.proof === "sig" && state.remoteInstanceId && msg.feed_key_hex && this.onInstanceKeyReceived) {
        fire(() => this.onInstanceKeyReceived(state.remoteInstanceId, msg.feed_key_hex));
      }
      if (this.onInstanceConnected) fire(() => this.onInstanceConnected(crowId, conn, state.remoteInstanceId));
    } else if (this.onPeerConnected) {
      fire(() => this.onPeerConnected(crowId, conn));
    }

    const held = state.held;
    state.held = [];
    for (const m of held) {
      if (state.refused || state.closed) break;
      await this._dispatchAdmitted(conn, m, state);
    }
  }

  /** Answer an older asker's challenge, held until _admit (see _onChallenge). */
  async _sendDeferredReply(conn, state) {
    const d = state.deferredReply;
    if (!d || d.sent || !state.authenticated || state.refused) return;
    d.sent = true;
    // Allowlist: only a peer that proved itself with a bare signature (an
    // older contact or sibling) gets one back. A cb_sig peer runs current code
    // and asks with cb:1; anything else is not signed for.
    if (state.proof !== "sig") return;
    const isInstance = state.kind === "instance" && this.instanceSyncEnabled;
    let feedKeyHex = null;
    // d.instanceId (the challenge's id) equals state.remoteInstanceId whenever
    // this fires: _admit refuses a response naming a different one.
    if (isInstance && d.instanceId && this.getFeedKeyForInstance) {
      try { feedKeyHex = await this.getFeedKeyForInstance(d.instanceId); } catch {}
    }
    if (state.closed) return;
    const payload = {
      type: "challenge-response",
      signature: sign(d.challengeHex, this.identity.ed25519Priv),
      pubkey: this.identity.ed25519Pubkey,
      crowId: this.identity.crowId,
    };
    if (isInstance && this.localInstanceId) payload.instance_id = this.localInstanceId;
    if (feedKeyHex) payload.feed_key_hex = feedKeyHex;
    conn.write(JSON.stringify(payload) + "\n");
  }

  /**
   * A sibling's `pair-binding` frame: kept on the connection state (the
   * first one only, and only before we decide), never held or dispatched.
   */
  _onPairBindingFrame(msg, state) {
    if (state.refused || state.authenticated || state.pbFrame !== undefined) return;
    const mac = msg?.pb_mac;
    state.pbFrame = { pb_mac: typeof mac === "string" && mac ? mac : null };
    const waiters = state.pbWaiters || [];
    state.pbWaiters = [];
    for (const w of waiters) w(state.pbFrame);
  }

  /** The peer's pair-binding frame, or null after `ms` or when the connection ends. */
  _awaitPairBindingFrame(state, ms) {
    if (state.pbFrame !== undefined) return Promise.resolve(state.pbFrame);
    if (state.refused || state.closed) return Promise.resolve(null);
    if (!Array.isArray(state.pbWaiters)) state.pbWaiters = [];
    return new Promise((resolve) => {
      const timer = setTimeout(() => { done(null); }, ms);
      timer.unref?.();
      const done = (v) => { clearTimeout(timer); resolve(v); };
      state.pbWaiters.push(done);
    });
  }

  /** Frames of an admitted connection, by kind. Frames of the other kind are ignored. */
  async _dispatchAdmitted(conn, msg, state) {
    if (!state.mutual || state.refused) return;
    if (state.kind === "contact" && msg.type === "data") {
      if (state.remoteCrowId && this.onPeerData) {
        try { await this.onPeerData(state.remoteCrowId, msg.payload); } catch {}
      }
      return;
    }
    if (state.kind === "instance" && msg.type === "instance-key") {
      if (typeof msg.instance_id === "string" && msg.instance_id && msg.instance_id === state.remoteInstanceId
          && typeof msg.feed_key_hex === "string" && msg.feed_key_hex && this.onInstanceKeyReceived) {
        fire(() => this.onInstanceKeyReceived(msg.instance_id, msg.feed_key_hex));
      }
    }
  }

  /** Destroy a connection that will never be admitted; drop what it queued. */
  _kill(conn, state) {
    state.refused = true;
    for (const w of state.pbWaiters || []) w(null);
    state.pbWaiters = [];
    state.held = [];
    state.deferredReply = null;
    state.clearTimer?.();
    try { conn.destroy(); } catch {}
  }

  _refuseContact(conn, state, crowId, reason) {
    this._kill(conn, state);
    const id = logSafe(crowId);
    if (reason === "no_binding") {
      if (this._noBindingLogged) return;
      this._noBindingLogged = true;
    } else if (!this._refusalLog.shouldLog(id)) {
      return;
    }
    console.warn(`[peer-manager] contact refused ${id}: ${reason}`);
  }

  _refuseInstance(conn, state, why) {
    this._kill(conn, state);
    const now = Date.now();
    if (now - this._lastRefuseLog < REFUSE_LOG_EVERY_MS) return;
    this._lastRefuseLog = now;
    if (why === "off") console.warn("[peer-manager] instance-sync connection dropped: Hyperswarm instance sync is off");
    else if (why === "key") console.warn("[peer-manager] instance-sync connection refused: peer claims our Crow ID but did not prove our key");
    else console.warn(`[peer-manager] instance-sync connection refused: ${why}`);
  }

  /**
   * Send data to a connected peer.
   */
  send(crowId, payload) {
    const peer = this.connections.get(crowId);
    if (!peer || !peer.authenticated) {
      throw new Error(`Not connected to ${crowId}`);
    }
    peer.conn.write(JSON.stringify({
      type: "data",
      payload,
    }) + "\n");
  }

  /**
   * Check if a peer is connected.
   */
  isConnected(crowId) {
    const peer = this.connections.get(crowId);
    return peer?.authenticated || false;
  }

  /**
   * Get list of connected peer IDs.
   */
  getConnectedPeers() {
    return [...this.connections.entries()]
      .filter(([, p]) => p.authenticated)
      .map(([id]) => id);
  }

  /**
   * Shut down the swarm.
   */
  async destroy() {
    if (this.swarm) {
      await this.swarm.destroy();
      this.swarm = null;
    }
    this.connections.clear();
    this.topics.clear();
  }
}
