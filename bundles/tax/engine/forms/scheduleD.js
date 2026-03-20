/**
 * Schedule D — Capital Gains and Losses
 */

export function mapScheduleD(result, taxReturn) {
  const lines = {};

  // Part I: Short-Term Capital Gains and Losses
  let shortTermTotal = 0;
  const shortTermTxns = taxReturn.capitalGains.filter(t => !t.isLongTerm);
  shortTermTxns.forEach((t, i) => {
    // Individual transactions go on Form 8949, totals flow here
    shortTermTotal += (t.proceeds - t.costBasis);
  });
  lines["1a_proceeds"] = shortTermTxns.reduce((s, t) => s + t.proceeds, 0);
  lines["1a_cost"] = shortTermTxns.reduce((s, t) => s + t.costBasis, 0);
  lines["1a_gain"] = shortTermTotal;
  lines["7"] = shortTermTotal;                     // Net short-term capital gain or loss

  // Part II: Long-Term Capital Gains and Losses
  let longTermTotal = 0;
  const longTermTxns = taxReturn.capitalGains.filter(t => t.isLongTerm);
  longTermTxns.forEach((t, i) => {
    longTermTotal += (t.proceeds - t.costBasis);
  });

  // Add capital gain distributions from 1099-DIV
  const capGainDist = taxReturn.income1099.div.reduce(
    (sum, f) => sum + (f.capitalGainDistributions || 0), 0
  );

  lines["8a_proceeds"] = longTermTxns.reduce((s, t) => s + t.proceeds, 0);
  lines["8a_cost"] = longTermTxns.reduce((s, t) => s + t.costBasis, 0);
  lines["8a_gain"] = longTermTotal;
  lines["11"] = capGainDist;                       // Capital gain distributions
  lines["15"] = longTermTotal + capGainDist;       // Net long-term capital gain or loss

  // Part III: Summary
  lines["16"] = shortTermTotal + longTermTotal + capGainDist; // Total
  lines["21"] = result.income.netCapitalGain;      // Net capital gain → 1040 line 7

  return lines;
}
