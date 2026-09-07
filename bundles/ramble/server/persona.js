/** 66-hex compressed secp256k1 pubkey -> 64-hex x-only (what Nostr `event.pubkey` carries). */
export function xOnly(pubkeyHex) {
  return pubkeyHex.length === 66 ? pubkeyHex.slice(2) : pubkeyHex;
}

export function resolvePersona(identity, seed, { level = "rotating", kind = "mark", sessionId = "0", _derive } = {}) {
  const derive = _derive; // production callers pass deriveBotIdentity from identity.js
  if (level === "real") {
    return { author: xOnly(identity.secp256k1Pubkey), author_level: "real", crowId: identity.crowId, secp256k1Priv: identity.secp256k1Priv };
  }
  // pseudonym: always the stable world pseudonym. rotating: marks use the stable pseudonym (attributable),
  // only caws (presence) use a fresh per-session key.
  const rotatesThisKind = level === "rotating" && kind === "caw";
  const botId = rotatesThisKind ? "ramble-session:" + sessionId : "ramble-world";
  const k = derive(seed, botId);
  return { author: xOnly(k.secp256k1Pubkey), author_level: level, crowId: null, secp256k1Priv: k.secp256k1Priv };
}
