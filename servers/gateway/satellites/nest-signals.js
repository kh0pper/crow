/**
 * The Nest's satellite signal (SAT-5, spec §14), registered by ONE line in
 * dashboard/panels/nest/health-signals.js. No satellites (or tables not migrated) → null (no card).
 * Otherwise one card plus one issue per problem: unreachable, cert under 14 days, tools changed.
 *
 * Severity is "info" for every issue: the status poller and the cert renewer already send each
 * problem's notification (satellites/poller.js, renewal.js); the health monitor pushes only
 * "warn" issues, so this keeps it to one notification per problem. ack: null (nothing to ack).
 */
import { t, fill } from "../dashboard/shared/i18n.js";
import { listSatellites, getToolPin } from "./store.js";
import { lastRecord, toolsState } from "./tools-pin.js";
import { certDaysLeft, EXPIRY_WARN_DAYS } from "./renewal.js";
import { SERVERS_URL } from "./poller.js";

export async function satellitesSignal(db, lang = "en", nowFn = () => Date.now()) {
  let sats;
  try { sats = (await listSatellites(db)).filter((s) => s.status !== "revoked"); } catch { return null; }
  if (!sats.length) return null;
  const now = nowFn();
  const issues = [];
  const label = t("signals.satellites.label", lang);
  const issue = (id, text) => issues.push({
    id, severity: "info", state: "info", issueOnly: true, label, issueLabel: text,
    actionLabel: t("signals.satellites.action", lang), actionHref: SERVERS_URL, ack: null,
  });
  for (const s of sats) {
    if (s.status === "unreachable") {
      const since = s.unreachable_since ? new Date(s.unreachable_since).toISOString().slice(11, 16) + " UTC" : "?";
      issue(`satellites:${s.id}:unreachable`, fill(t("signals.satellites.unreachable", lang), { name: s.name, since }));
    }
    const days = certDaysLeft(s, now);
    if (days !== null && days < EXPIRY_WARN_DAYS) {
      issue(`satellites:${s.id}:cert`, fill(t(days < 0 ? "signals.satellites.certExpired" : "signals.satellites.certExpiring", lang), { name: s.name, days: Math.max(days, 0) }));
    }
    for (const bundle of Object.keys(lastRecord(s)?.status?.tools || {})) {
      let pin = null;
      try { pin = await getToolPin(db, s.id, bundle); } catch { pin = null; }
      if (pin && toolsState(s, bundle, pin).state === "changed") {
        issue(`satellites:${s.id}:tools:${bundle}`, fill(t("signals.satellites.toolsChanged", lang), { name: s.name, bundle }));
      }
    }
  }
  const card = {
    id: "satellites", label, severity: issues.length ? "info" : null, state: issues.length ? "info" : "ok", cardOnly: issues.length > 0,
    value: issues.length ? fill(t("signals.satellites.problems", lang), { n: issues.length }) : fill(t("signals.satellites.ok", lang), { n: sats.length }),
  };
  return issues.length ? [card, ...issues] : card;
}
