/**
 * Schedule 1 — Additional Income and Adjustments to Income
 */

export function mapSchedule1(result, taxReturn) {
  const lines = {};
  const inc = result.income;
  const adj = result.adjustments;

  // --- Part I: Additional Income ---
  lines["1"] = 0;                                  // Taxable refunds (state/local)
  lines["2a"] = 0;                                 // Alimony received
  lines["3"] = inc.schedCNetProfit;                // Business income (Schedule C)
  lines["4"] = 0;                                  // Other gains or losses
  lines["5"] = 0;                                  // Rental real estate, royalties, etc.
  lines["6"] = 0;                                  // Farm income
  lines["7"] = inc.unemploymentComp;               // Unemployment compensation
  lines["8a"] = inc.netCapitalGain;                // Net operating loss (using for other income)
  lines["8z"] = inc.hsaTaxableDistributions + inc.miscIncome; // Other income
  lines["9"] = inc.otherIncomeSchedule1;           // Total Part I
  lines["10"] = inc.totalIncome;                   // Total income (line 9 + 1040 line 1z)

  // --- Part II: Adjustments to Income ---
  lines["11"] = adj.educatorExpenseDeduction;      // Educator expenses
  lines["12"] = 0;                                 // Certain business expenses
  lines["13"] = adj.hsaDeduction;                  // HSA deduction
  lines["14"] = 0;                                 // Moving expenses for Armed Forces
  lines["15"] = adj.seTaxDeduction;                // Deductible part of SE tax
  lines["16"] = 0;                                 // SE SEP, SIMPLE, qualified plans
  lines["17"] = 0;                                 // SE health insurance
  lines["18"] = 0;                                 // Penalty on early withdrawal
  lines["19"] = 0;                                 // IRA deduction
  lines["20"] = adj.studentLoanDeduction;          // Student loan interest
  lines["21"] = 0;                                 // Reserved
  lines["22"] = 0;                                 // Deduction for EP contributions
  lines["23"] = 0;                                 // Additional adjustments
  lines["24z"] = 0;                                // Other adjustments
  lines["25"] = 0;                                 // Total other adjustments
  lines["26"] = adj.totalAdjustments;              // Total Part II

  return lines;
}
