/**
 * A scripted, non-conforming Hyperswarm test peer for the contact-binding
 * conformance tests (tests/contact-binding-two-nodes.test.js).
 *
 * It joins one contact-pair topic on the LOCAL hyperdht testnet the test
 * started (127.0.0.1 only) and answers the node under test's challenge in one
 * enumerated way, so a test can check that the node admits the conforming
 * answer and refuses each non-conforming one. Each answer reuses the message
 * construction of the in-process tests in tests/hyperswarm-contact-auth.test.js.
 *
 * startImpostor({ bootstrap, topicKeys, identity, claimCrowId, claimPubkey, mode, ... })
 *   bootstrap     the test testnet's bootstrap list (every host must be 127.0.0.1)
 *   topicKeys     the two Ed25519 public keys (hex) of the contact pair; the
 *                 topic is sha256(sorted(keys)), as PeerManager computes it
 *   identity      { seedHex } for `honest`; otherwise ignored (own keys are random)
 *   claimCrowId   the Crow ID this peer claims in its challenge-response
 *   claimPubkey   that Crow ID's real Ed25519 public key (pinned-pubkey-own-sig, replay)
 *   mode
 *     honest                 the claimed identity's real seed: cb_sig when asked
 *                            with cb:1 (unless asOld), else a bare signature.
 *                            The positive control.
 *     own-key                a fresh key: pubkey and signature are its own
 *     pinned-pubkey-own-sig  pubkey = the claimed (pinned) key, signature by a fresh key
 *     replay                 pubkey = the claimed key, and a proof recorded on an
 *                            earlier connection (`replay`: { signature } or { cb_sig })
 *     oracle                 (a relayed proof) forwards the node's challenge nonce, as its own
 *                            challenge, to `oracleTarget` on a second link (with
 *                            cb:1 when oracleCb, the default), and returns that
 *                            target's answer to the node with any cb_sig removed
 *   oracleTarget  { crowId } or a Crow ID: the real holder of claimCrowId to relay through
 *   plant         texts sent as memory shares in the same write as the proof,
 *                 on every link (also pre-admission, which must never land)
 *
 * Links are told apart by the Crow ID in each peer's own challenge: a link whose
 * challenger is oracleTarget is the relay link; any other challenger that is
 * not claimCrowId is the node under test (the "target" link); a link to the
 * claimed identity itself is left idle.
 *
 * Returns { received, links, proofs, oracleAnswers, admitted(), targetLinks(),
 *   sendShare(text), waitTarget(ms), waitAdmitted(ms), waitOutcome(ms), stop() }.
 * stopAllImpostors() stops every scripted peer still running.
 */
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { deriveInstanceIdentity, sign } from "../../servers/sharing/identity.js";
import { contactCbMessage } from "../../servers/sharing/contact-binding.js";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const require = createRequire(join(REPO, "package.json"));
const Hyperswarm = require("hyperswarm");
const HyperDHT = require("hyperdht");

const MODES = new Set(["honest", "own-key", "pinned-pubkey-own-sig", "replay", "oracle"]);
const running = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(step);
  }
  return !!(await fn());
}

function topicOf(keys) {
  const [k0, k1] = [...keys].sort();
  return createHash("sha256").update(k0).update(k1).digest();
}

const memoryShare = (text, sender) => ({
  type: "data",
  payload: { type: "share", share_type: "memory", payload: { content: text, category: "general" }, sender, timestamp: new Date().toISOString() },
});

export async function startImpostor({
  bootstrap, topicKeys, identity = null, claimCrowId, claimPubkey = null, mode,
  oracleTarget = null, oracleCb = true, oracleWaitMs = 5_000, asOld = false, replay = null, plant = [],
} = {}) {
  if (!MODES.has(mode)) throw new Error(`startImpostor: unknown mode ${mode}`);
  if (!Array.isArray(bootstrap) || bootstrap.length === 0) throw new Error("startImpostor: the local testnet bootstrap is required");
  for (const n of bootstrap) {
    if (n?.host !== "127.0.0.1") throw new Error("startImpostor: every bootstrap node must be on 127.0.0.1");
  }
  if (!Array.isArray(topicKeys) || topicKeys.length !== 2) throw new Error("startImpostor: topicKeys must be the two contact keys");
  if (typeof claimCrowId !== "string" || !claimCrowId) throw new Error("startImpostor: claimCrowId is required");
  if ((mode === "pinned-pubkey-own-sig" || mode === "replay") && !claimPubkey) throw new Error(`startImpostor: ${mode} needs claimPubkey`);
  if (mode === "replay" && !(replay?.signature || replay?.cb_sig)) throw new Error("startImpostor: replay needs { signature } or { cb_sig }");
  const oracleId = typeof oracleTarget === "string" ? oracleTarget : oracleTarget?.crowId ?? null;
  if (mode === "oracle" && !oracleId) throw new Error("startImpostor: oracle needs oracleTarget");

  let real = null;
  if (mode === "honest") {
    if (!identity?.seedHex) throw new Error("startImpostor: honest needs identity.seedHex");
    real = deriveInstanceIdentity(Buffer.from(identity.seedHex, "hex"));
    if (real.crowId !== claimCrowId) throw new Error("startImpostor: honest seed does not derive claimCrowId");
  }
  const own = deriveInstanceIdentity(randomBytes(32)); // this peer's own key

  const dht = new HyperDHT({ bootstrap, host: "127.0.0.1", port: [0, 0] });
  const nodes = dht.bootstrapNodes || [];
  if (nodes.length === 0 || nodes.some((n) => n.host !== "127.0.0.1") || dht.io?._host !== "127.0.0.1") {
    await dht.destroy();
    throw new Error("startImpostor: the DHT must use the local testnet on 127.0.0.1");
  }
  const swarm = new Hyperswarm({ dht });

  const received = []; // data payloads the node under test sent on a target link
  const links = [];
  const proofs = [];   // honest: { nonce, signature, cb_sig } per target link, for a later replay leg
  const oracleAnswers = [];
  const plants = [...plant];

  const write = (link, ...frames) => {
    if (link.closed) return false;
    try { link.conn.write(frames.map((f) => JSON.stringify(f) + "\n").join("")); return true; } catch { return false; }
  };

  async function relay(nonce) {
    // Wait for a relay link to the oracle target, then ask it to sign the nonce.
    let via = null;
    await until(() => (via = links.find((l) => l.role === "oracle" && !l.closed)), oracleWaitMs);
    if (!via) return null;
    const mark = via.frames.length;
    const ask = { type: "challenge", challenge: nonce, crowId: own.crowId, pubkey: own.ed25519Pubkey };
    if (oracleCb) ask.cb = 1;
    write(via, ask);
    let got = null;
    await until(() => (got = via.frames.slice(mark).find((f) => f.type === "challenge-response")), oracleWaitMs);
    oracleAnswers.push({ cb: !!oracleCb, answer: got ? { ...got } : null });
    return got;
  }

  async function answerTarget(link, ch) {
    const nonce = ch.challenge;
    let resp = null;
    if (mode === "honest") {
      resp = { type: "challenge-response", crowId: claimCrowId, pubkey: real.ed25519Pubkey };
      const signature = sign(nonce, real.ed25519Priv);
      const cb_sig = sign(contactCbMessage({
        role: link.conn.isInitiator ? "init" : "resp", signerCrowId: claimCrowId, challengeHex: nonce, handshakeHashHex: link.hashHex,
      }), real.ed25519Priv);
      proofs.push({ nonce, signature, cb_sig });
      if (ch.cb === 1 && !asOld) resp.cb_sig = cb_sig;
      else resp.signature = signature;
    } else if (mode === "own-key") {
      resp = { type: "challenge-response", crowId: claimCrowId, pubkey: own.ed25519Pubkey, signature: sign(nonce, own.ed25519Priv) };
    } else if (mode === "pinned-pubkey-own-sig") {
      resp = { type: "challenge-response", crowId: claimCrowId, pubkey: claimPubkey, signature: sign(nonce, own.ed25519Priv) };
    } else if (mode === "replay") {
      resp = { type: "challenge-response", crowId: claimCrowId, pubkey: claimPubkey, ...replay };
    } else if (mode === "oracle") {
      const got = await relay(nonce);
      if (got) {
        resp = { ...got };
        delete resp.cb_sig;
      }
    }
    if (!resp) return; // nothing to forward: the node's own timer decides
    link.proofSent = true;
    write(link, resp, { type: "authenticated" }, ...plants.map((t) => memoryShare(t, claimCrowId)));
  }

  swarm.on("connection", (conn) => {
    const link = { conn, frames: [], role: null, peerCrowId: null, authenticated: false, closed: false, proofSent: false, hashHex: null };
    links.push(link);
    conn.on("error", () => {});
    conn.on("close", () => { link.closed = true; });
    const opened = (async () => {
      try { await conn.opened; } catch {}
      const h = conn.handshakeHash;
      link.hashHex = h?.length ? Buffer.from(h).toString("hex") : null;
    })();
    let buf = "";
    let chain = opened;
    conn.on("data", (d) => {
      buf += d.toString();
      const ls = buf.split("\n");
      buf = ls.pop();
      for (const l of ls) {
        if (!l.trim()) continue;
        let f;
        try { f = JSON.parse(l); } catch { continue; }
        link.frames.push(f);
        chain = chain.then(async () => {
          if (f.type === "challenge" && !link.role) {
            link.peerCrowId = typeof f.crowId === "string" ? f.crowId : null;
            if (oracleId && link.peerCrowId === oracleId) link.role = "oracle";
            else if (link.peerCrowId === claimCrowId) link.role = "idle";
            else {
              link.role = "target";
              await answerTarget(link, f);
            }
          } else if (link.role === "target" && f.type === "authenticated") {
            link.authenticated = true;
          } else if (link.role === "target" && f.type === "data") {
            received.push(f.payload);
          }
        }).catch(() => {});
      }
    });
  });

  const topic = topicOf(topicKeys);
  const discovery = swarm.join(topic, { server: true, client: true });
  await Promise.race([discovery.flushed(), sleep(10_000)]);

  const targetLinks = () => links.filter((l) => l.role === "target");
  const admitted = () => targetLinks().some((l) => l.authenticated);
  const imp = {
    mode, received, links, proofs, oracleAnswers,
    targetLinks, admitted,
    /** Contents of every memory share the node sent this peer. */
    receivedTexts: () => received.filter((p) => p?.type === "share" && p.share_type === "memory").map((p) => p.payload?.content),
    /** Sends a memory share on every open, admitted target link; returns how many links it was written on. */
    sendShare(text) {
      let n = 0;
      for (const l of targetLinks()) if (l.authenticated && !l.closed && write(l, memoryShare(text, claimCrowId))) n++;
      return n;
    },
    /** A target link exists and has seen the node's challenge. */
    waitTarget: (ms = 30_000) => until(() => targetLinks().length > 0, ms),
    waitAdmitted: (ms = 30_000) => until(admitted, ms),
    /**
     * Wait for an outcome: "admitted" (the node sent `authenticated` on a target
     * link), "refused" (a target link closed with no `authenticated`), or
     * "silent" (neither within `ms`). Never "refused" without a target link.
     */
    async waitOutcome(ms = 20_000) {
      await until(() => admitted() || targetLinks().some((l) => l.closed), ms);
      if (admitted()) return "admitted";
      return targetLinks().some((l) => l.closed) ? "refused" : "silent";
    },
    async stop() {
      if (!running.has(imp)) return;
      running.delete(imp);
      for (const l of links) { try { l.conn.destroy(); } catch {} }
      try { await swarm.destroy(); } catch {}
    },
  };
  running.add(imp);
  return imp;
}

export async function stopAllImpostors() {
  await Promise.all([...running].map((i) => i.stop().catch(() => {})));
}
