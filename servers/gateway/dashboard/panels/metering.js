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
import { csrfInput } from "../shared/csrf.js";
import { addPriceRule, updatePriceRule, deletePriceRule, seedPriceBook } from "../../../shared/price-book.js";

function fmtUsd(n) {
  const v = Number(n) || 0;
  return "$" + (v !== 0 && Math.abs(v) < 1 ? v.toFixed(4) : v.toFixed(2));
}
function fmtNum(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function priceBookEditor(priceRules, csrf) {
  const ruleHtml = (priceRules || []).map((r) => {
    const who = escapeHtml(r.provider_id || r.provider_type || "—");
    const model = escapeHtml(r.model_id || "*");
    const inv = escapeHtml(String(r.input_cost_per_1m));
    const outv = escapeHtml(String(r.output_cost_per_1m));
    return `<div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;margin-bottom:0.5rem">
      <span style="min-width:220px"><strong>${who}</strong> / <code>${model}</code></span>
      <form method="POST" style="display:flex;gap:0.4rem;align-items:center">${csrf}
        <input type="hidden" name="action" value="update"><input type="hidden" name="id" value="${escapeHtml(String(r.id))}">
        <label>in $<input type="number" name="input" value="${inv}" step="0.0001" min="0" style="width:90px"></label>
        <label>out $<input type="number" name="output" value="${outv}" step="0.0001" min="0" style="width:90px"></label>
        <button class="btn btn-sm" type="submit">Save</button>
      </form>
      <form method="POST" style="display:inline" onsubmit="return confirm('Delete this price rule?')">${csrf}
        <input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="${escapeHtml(String(r.id))}">
        <button class="btn btn-sm btn-danger" type="submit">Delete</button>
      </form>
    </div>`;
  }).join("\n");

  const list = ruleHtml ||
    `<div class="empty-state"><h3>No price rules yet</h3><p>Add one below, or seed the starter book.</p></div>`;

  const addForm = `<form method="POST" style="display:flex;gap:0.5rem;align-items:end;flex-wrap:wrap;margin-top:1rem;padding-top:1rem;border-top:1px solid var(--border,#333)">${csrf}
    <input type="hidden" name="action" value="add">
    <label>provider_id<br><input type="text" name="provider_id" placeholder="(or type)" style="width:140px"></label>
    <label>provider_type<br><input type="text" name="provider_type" placeholder="e.g. together" style="width:140px"></label>
    <label>model_id<br><input type="text" name="model_id" placeholder="*" style="width:170px"></label>
    <label>in $/1M<br><input type="number" name="input" step="0.0001" min="0" style="width:90px"></label>
    <label>out $/1M<br><input type="number" name="output" step="0.0001" min="0" style="width:90px"></label>
    <button class="btn btn-sm btn-primary" type="submit">Add rule</button>
  </form>`;

  const seedForm = `<form method="POST" style="margin-top:1rem">${csrf}
    <input type="hidden" name="action" value="seed">
    <button class="btn btn-sm" type="submit">Seed starter price book</button>
    <span class="muted" style="margin-left:0.5rem;font-size:0.85em">Adds the default crow-voice/crow-chat $0 rules + Together reference rates; skips rules that already exist.</span>
  </form>`;

  return list + addForm + seedForm;
}

/**
 * Pure render of the panel body from a summarizeUsage() result + price rules.
 * @param {object} summary  { totals, unpricedEvents, byProvider }
 * @param {Array<object>} priceRules
 */
export function renderUsageBody(summary, priceRules, csrf = "", lang = "en", error = null) {
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

  const errorBox = error ? callout(escapeHtml(error), "warning") : "";

  return [
    errorBox,
    cards,
    gapWarning,
    section("By provider &amp; model", byProviderTable),
    section("Price book", priceBookEditor(priceRules, csrf)),
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
    let error = null;
    if (req.method === "POST") {
      const action = req.body && req.body.action;
      try {
        if (action === "add") await addPriceRule(db, req.body);
        else if (action === "update") await updatePriceRule(db, req.body.id, { input: req.body.input, output: req.body.output });
        else if (action === "delete") await deletePriceRule(db, req.body.id);
        else if (action === "seed") await seedPriceBook(db);
        res.redirectAfterPost("/dashboard/metering");
        return;
      } catch (e) {
        error = e && e.message ? e.message : String(e);
        // fall through and re-render with the error callout
      }
    }
    const summary = await summarizeUsage(db);
    let rules = [];
    try {
      rules = await loadPricingRules(db);
    } catch {
      rules = [];
    }
    return layout({
      title: "Usage & Metering",
      content: renderUsageBody(summary, rules, csrfInput(req), lang, error),
    });
  },
};
