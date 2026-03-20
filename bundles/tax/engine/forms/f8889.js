/**
 * Form 8889 — Health Savings Accounts (HSAs)
 *
 * CRITICAL: Employer contributions (W-2 code W) are NOT deductible.
 * They are already excluded from W-2 Box 1.
 * Line 9 = employer contributions (from W-2 code W)
 * Line 13 = additional deduction = personal contributions ONLY
 */

export function mapForm8889(result, taxReturn) {
  if (!result.hsa || !taxReturn.hsa) return {};

  const hsa = result.hsa;
  const tables = {}; // Will be passed from caller if needed
  const lines = {};

  // --- Part I: HSA Contributions and Deduction ---
  lines["1"] = taxReturn.hsa.coverageType === "self" ? "self-only" : "family";
  lines["2"] = taxReturn.hsa.coverageType === "self" ? 4300 : 8750; // 2025 limits
  lines["3"] = 0;                                   // Additional contribution (age 55-65)
  if (taxReturn.hsa.catchUp55) {
    lines["3"] = 1000;
  }
  lines["4"] = lines["2"] + lines["3"];             // Total contribution limit
  lines["5"] = 0;                                   // Archer MSA (not applicable)
  lines["6"] = lines["4"] - lines["5"];             // Subtract line 5 from line 4

  // Line 7: months of coverage proration
  if (taxReturn.hsa.monthsCovered < 12) {
    lines["7"] = Math.round(lines["6"] * taxReturn.hsa.monthsCovered / 12);
  } else {
    lines["7"] = lines["6"];
  }

  lines["8"] = 0;                                   // Employer contributions remaining from prior year
  lines["9"] = hsa.employerContributions;            // Employer contributions THIS year (W-2 code W)
  lines["10"] = 0;                                   // Qualified HSA funding distribution
  lines["11"] = lines["9"] + lines["10"];            // Total employer + other (NOT deductible)
  lines["12"] = Math.max(0, lines["7"] - lines["11"]); // Room for personal deduction

  // Line 13: YOUR contributions (deductible amount)
  // This is ONLY personal contributions, capped by remaining room
  lines["13"] = Math.min(hsa.personalContributions, lines["12"]);

  // --- Part II: HSA Distributions ---
  lines["14a"] = hsa.distributions;                  // Total distributions
  lines["14b"] = 0;                                  // Rollover distributions
  lines["14c"] = lines["14a"] - lines["14b"];        // Subtract rollovers
  lines["15"] = hsa.qualifiedExpenses;               // Qualified medical expenses (MANUAL ENTRY)
  lines["16"] = Math.max(0, lines["14c"] - lines["15"]); // Taxable HSA distributions
  lines["17a"] = "no";                               // HSA used for non-qualified? (if dist code 1 and taxable > 0)
  if (lines["16"] > 0 && taxReturn.hsa.distributionCode === 1) {
    lines["17a"] = "yes";
    lines["17b"] = Math.round(lines["16"] * 0.20);  // 20% additional tax
  } else {
    lines["17b"] = 0;
  }

  // --- Part III: Income and Additional Tax for Failure to Maintain HDHP ---
  lines["18"] = 0;                                   // Last-month rule income inclusion
  lines["19"] = 0;                                   // Additional 10% tax
  lines["20"] = 0;                                   // Not used
  lines["21"] = lines["17b"] + (lines["19"] || 0);  // Total additional tax → Schedule 2

  return lines;
}
