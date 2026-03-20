/**
 * Schedule SE — Self-Employment Tax
 */

export function mapScheduleSE(result, taxReturn) {
  if (!result.selfEmployment) return {};

  const se = result.selfEmployment;
  const lines = {};

  // Short Schedule SE (Section A)
  lines["1a"] = result.income.schedCNetProfit + result.income.nec1099Total;  // Net farm profit
  lines["1b"] = 0;                                 // Net farm profit (not applicable)
  lines["2"] = lines["1a"];                        // Combined
  lines["3"] = Math.round(lines["2"] * 0.9235);   // 92.35% of line 2
  lines["4a"] = 176100;                            // 2025 SS wage base
  lines["4b"] = 0;                                 // W-2 SS wages (if applicable)

  // Calculate SS portion
  const ssBase = Math.max(0, lines["4a"] - (lines["4b"] || 0));
  const ssEarnings = Math.min(lines["3"], ssBase);
  lines["5"] = ssEarnings;                         // Smaller of 3 or 4a/4c
  lines["6"] = Math.round(lines["5"] * 0.124 * 100) / 100;  // SS tax (12.4%)
  lines["7"] = Math.round(lines["3"] * 0.029 * 100) / 100;  // Medicare tax (2.9%)
  lines["8"] = 0;                                  // Additional Medicare (line 3 > threshold)
  lines["9"] = 0;                                  // Additional Medicare tax
  lines["10"] = Math.round((lines["6"] + lines["7"]) * 100) / 100; // Total SE tax
  lines["11"] = Math.round(lines["10"] / 2 * 100) / 100;    // Deductible half
  lines["12"] = lines["10"];                       // SE tax → Schedule 2

  return lines;
}
