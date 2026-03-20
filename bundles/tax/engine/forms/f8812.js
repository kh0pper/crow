/**
 * Schedule 8812 — Credits for Qualifying Children and Other Dependents
 */

export function mapForm8812(result, taxReturn) {
  if (result.credits.childTaxCredit === 0 && result.credits.childTaxCreditRefundable === 0) {
    return {};
  }

  const ctcDeps = taxReturn.dependents.filter(d => d.qualifiesForChildTaxCredit);
  const lines = {};

  lines["4"] = ctcDeps.length;                     // Number of qualifying children
  lines["5"] = ctcDeps.length * 2000;              // Line 4 × $2,000
  lines["6"] = 0;                                  // Other dependents × $500
  lines["7"] = lines["5"] + lines["6"];            // Total
  lines["8"] = result.agi;                         // AGI
  lines["9"] = (() => {
    const threshold = result.filingStatus === "mfj" ? 400000 : 200000;
    return Math.max(0, Math.ceil((result.agi - threshold) / 1000) * 1000);
  })();                                            // Excess over threshold (rounded up to nearest $1000)
  lines["10"] = Math.round(lines["9"] * 0.05);    // Line 9 × 5%
  lines["11"] = Math.max(0, lines["7"] - lines["10"]); // Line 7 - line 10
  lines["12"] = result.tax.bracketTax;             // Tax liability
  lines["13"] = 0;                                 // Credits from Schedule 3
  lines["14"] = Math.max(0, lines["12"] - lines["13"]); // Net tax

  // Nonrefundable portion
  lines["15"] = Math.min(lines["11"], lines["14"]); // Nonrefundable CTC
  // Refundable portion (Additional Child Tax Credit)
  lines["16"] = Math.max(0, lines["11"] - lines["15"]); // Remaining credit
  lines["17"] = Math.min(lines["16"], ctcDeps.length * 1700); // Max refundable per child ($1,700 for 2025)
  lines["18"] = result.income.totalWages + Math.max(0, result.income.schedCNetProfit); // Earned income
  lines["19"] = Math.max(0, lines["18"] - 2500);  // Earned income minus $2,500
  lines["20"] = Math.round(lines["19"] * 0.15);   // 15% of line 19
  lines["27"] = Math.min(lines["17"], lines["20"]); // Refundable CTC amount

  return lines;
}
