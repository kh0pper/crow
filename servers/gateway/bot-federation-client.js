/**
 * F4a Layer 3 — caller-side client. The editing instance uses these to drive a
 * peer's bot over the HMAC-signed, trust-gated federation channel. The peer's
 * gate (botPeerManageable) is the security boundary; these are a dumb pipe.
 */
import { forwardSignedRequest as realForward } from "../shared/peer-forward.js";

const enc = (s) => encodeURIComponent(String(s));

export async function fetchPeerBotDef({ db, sourceInstanceId, instanceId, botId, actor }, forward = realForward) {
  return forward({
    db, sourceInstanceId, targetInstanceId: instanceId,
    method: "GET", path: `/dashboard/bot-federation/def/${enc(botId)}`,
    auditAction: "federation.bot.def", actor, maxResponseBytes: 65_536,
  });
}

export async function patchPeerBot({ db, sourceInstanceId, instanceId, botId, patch, actor }, forward = realForward) {
  return forward({
    db, sourceInstanceId, targetInstanceId: instanceId,
    method: "POST", path: `/dashboard/bot-federation/patch/${enc(botId)}`,
    body: { patch }, auditAction: "federation.bot.patch", actor, maxResponseBytes: 65_536,
  });
}

export async function setPeerBotEnabled({ db, sourceInstanceId, instanceId, botId, enabled, actor }, forward = realForward) {
  return forward({
    db, sourceInstanceId, targetInstanceId: instanceId,
    method: "POST", path: `/dashboard/bot-federation/enabled/${enc(botId)}`,
    body: { enabled: enabled ? 1 : 0 }, auditAction: "federation.bot.enabled", actor, maxResponseBytes: 65_536,
  });
}
