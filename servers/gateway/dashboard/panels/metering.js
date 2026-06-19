/**
 * Usage & Metering Panel — read-only view of the inference meter.
 *
 * Surfaces the usage_events ledger: total spend, call/token volume, a per-
 * provider/model breakdown, the current price book, and an UNPRICED-coverage
 * warning (calls with no matching price rule — recorded but uncosted). The
 * data comes from servers/shared/metering.js (summarizeUsage / loadPricingRules).
 *
 * Read-only for now; the price book is seeded/edited out-of-band. English-only
 * copy for this operator-facing panel — i18n is a follow-up.
 */

import { escapeHtml, statCard, statGrid, dataTable, section, callout } from "../shared/components.js";
import { summarizeUsage, loadPricingRules } from "../../../shared/metering.js";

function fmtUsd(n) {
  const v = Number(n) || 0;
  return "$" + (v !== 0 && Math.abs(v) < 1 ? v.toFixed(4) : v.toFixed(2));
}
function fmtNum(n) {
  return Number(n || 0).toLocaleString("en-US");
}

/**
 * Pure render of the panel body from a summarizeUsage() result + price rules.
 * @param {object} summary  { totals, unpricedEvents, byProvider }
 * @param {Array<object>} priceRules
 */
export function renderUsageBody(summary, priceRules, lang = "en") {
  const { totals, unpricedEvents, byProvider } = summary;

  const cards = statGrid([
    statCard("Total spend", fmtUsd(totals.costUsd)),
    statCard("Inference calls", fmtNum(totals.events)),
    statCard("Input tokens", fmtNum(totals.inputTokens)),
    statCard("Output tokens", fmtNum(totals.outputTokens)),
    statCard("Unpriced calls", fmtNum(unpricedEvents)),
  ]);

  const gapWarning =
    unpricedEvents > 0
      ? callout(
          `<strong>${fmtNum(unpricedEvents)}</strong> metered calls matched no price rule, so their cost is uncounted (the tokens are still recorded). Add a price rule for the relevant provider/model to close the price-book gap.`,
          "warning",
        )
      : "";

  const providerRows = byProvider.map((r) => [
    escapeHtml(r.providerId || "—"),
    escapeHtml(r.modelId || "—"),
    fmtNum(r.events),
    fmtNum(r.inputTokens),
    fmtNum(r.outputTokens),
    fmtUsd(r.costUsd),
  ]);
  const byProviderTable = dataTable(
    ["Provider", "Model", "Calls", "Input", "Output", "Cost"],
    providerRows,
  );

  const ruleRows = (priceRules || []).map((r) => [
    escapeHtml(r.provider_id || r.provider_type || "—"),
    escapeHtml(r.model_id || "*"),
    fmtUsd(r.input_cost_per_1m) + "/1M",
    fmtUsd(r.output_cost_per_1m) + "/1M",
  ]);
  const priceBook = ruleRows.length
    ? dataTable(["Provider", "Model", "Input rate", "Output rate"], ruleRows)
    : `<div class="empty-state"><h3>No price rules yet</h3><p>Inference is recorded but uncosted until price rules are added.</p></div>`;

  return [
    cards,
    gapWarning,
    section("By provider &amp; model", byProviderTable),
    section("Price book", priceBook),
  ].join("\n");
}

export default {
  id: "metering",
  name: "Usage",
  icon: "extensions",
  route: "/dashboard/metering",
  navOrder: 36,
  category: "tools",

  async handler(req, res, { db, layout, lang }) {
    const summary = await summarizeUsage(db);
    let rules = [];
    try {
      rules = await loadPricingRules(db);
    } catch {
      rules = [];
    }
    return layout({
      title: "Usage & Metering",
      content: renderUsageBody(summary, rules, lang),
    });
  },
};
