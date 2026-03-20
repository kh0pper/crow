/**
 * Form 1040 — U.S. Individual Income Tax Return
 *
 * Maps TaxResult values to 1040 line numbers.
 * Comprehensive: covers all lines for supported scenarios.
 */

export function mapForm1040(result, taxReturn) {
  const lines = {};
  const inc = result.income;
  const adj = result.adjustments;
  const ded = result.deduction;
  const tx = result.tax;
  const cr = result.credits;
  const pay = result.payments;
  const res = result.result;

  // --- Filing status ---
  lines["filing_status"] = result.filingStatus;

  // --- Name, SSN (will be filled from taxReturn directly) ---
  lines["taxpayer_name"] = taxReturn.taxpayer.name;
  lines["taxpayer_ssn"] = taxReturn.taxpayer.ssn;
  if (taxReturn.spouse) {
    lines["spouse_name"] = taxReturn.spouse.name;
    lines["spouse_ssn"] = taxReturn.spouse.ssn;
  }

  // --- Dependents ---
  taxReturn.dependents.forEach((dep, i) => {
    lines[`dependent_${i + 1}_name`] = dep.name;
    lines[`dependent_${i + 1}_ssn`] = dep.ssn;
    lines[`dependent_${i + 1}_relationship`] = dep.relationship;
    lines[`dependent_${i + 1}_ctc`] = dep.qualifiesForChildTaxCredit ? "X" : "";
  });

  // --- Income ---
  lines["1a"] = inc.totalWages;                              // Wages, salaries, tips
  lines["1z"] = inc.totalWages;                              // Add lines 1a through 1h (simplified)
  lines["2a"] = inc.taxExemptInterest;                       // Tax-exempt interest
  lines["2b"] = inc.taxableInterest;                         // Taxable interest
  lines["3a"] = inc.qualifiedDividends;                      // Qualified dividends
  lines["3b"] = inc.ordinaryDividends;                       // Ordinary dividends
  lines["4a"] = 0;                                           // IRA distributions (not implemented)
  lines["4b"] = 0;                                           // IRA taxable amount
  lines["5a"] = 0;                                           // Pensions and annuities
  lines["5b"] = 0;                                           // Pensions taxable amount
  lines["6a"] = 0;                                           // Social security benefits
  lines["6b"] = 0;                                           // SS taxable amount
  lines["6c"] = 0;                                           // Election to exclude lump-sum

  if (inc.netCapitalGain !== 0) {
    lines["7"] = inc.netCapitalGain;                         // Capital gain or loss
  } else {
    lines["7"] = 0;
  }

  lines["8"] = inc.otherIncomeSchedule1;                     // Other income from Schedule 1
  lines["9"] = inc.totalIncome;                              // Total income

  // --- Adjustments ---
  lines["10"] = adj.totalAdjustments;                        // Adjustments from Schedule 1
  lines["11"] = result.agi;                                  // AGI

  // --- Deductions ---
  lines["12"] = ded.chosen;                                  // Standard or itemized deduction
  lines["13"] = ded.qbiDeduction;                            // QBI deduction
  lines["14"] = ded.chosen + ded.qbiDeduction;               // Total deductions
  lines["15"] = result.taxableIncome;                        // Taxable income

  // --- Tax ---
  lines["16"] = tx.bracketTax;                               // Tax (from Tax Table or Qualified Dividends worksheet)
  lines["17"] = 0;                                           // Amount from Schedule 2, Part I, line 4
  lines["18"] = tx.bracketTax;                               // Line 16 + 17
  lines["19"] = cr.childTaxCredit + (cr.lifetimeLearningCredit || 0) + (cr.americanOpportunityCredit || 0) - (cr.aotcRefundable || 0); // Nonrefundable credits (CTC + education)
  lines["20"] = 0;                                           // Amount from Schedule 3, line 8
  lines["21"] = cr.totalCredits;                             // Total credits (19 + 20)
  lines["22"] = Math.max(0, tx.bracketTax - cr.totalCredits); // Line 18 - 21
  lines["23"] = tx.seTax + tx.additionalMedicareTax;         // Other taxes from Schedule 2
  lines["24"] = res.totalTax;                                // Total tax

  // --- Payments ---
  lines["25a"] = pay.federalWithheld;                        // Federal tax withheld from W-2s
  lines["25b"] = 0;                                          // Tax withheld from 1099s
  lines["25c"] = 0;                                          // Other forms
  lines["25d"] = pay.federalWithheld;                        // Total (25a + 25b + 25c)
  lines["26"] = 0;                                           // Estimated tax payments
  lines["27a"] = cr.eitc;                                    // Earned income credit
  lines["27b"] = 0;                                          // Nontaxable combat pay election
  lines["28"] = cr.childTaxCreditRefundable;                 // Additional child tax credit (refundable)
  lines["29"] = cr.aotcRefundable || 0;                       // American opportunity credit (refundable 40%)
  lines["30"] = 0;                                           // Reserved
  lines["31"] = 0;                                           // Amount from Schedule 3, line 15
  lines["32"] = cr.totalRefundableCredits;                   // Total other payments
  lines["33"] = pay.totalPayments;                           // Total payments

  // --- Refund or Amount Owed ---
  if (res.refundOrOwed >= 0) {
    lines["34"] = res.refundOrOwed;                          // Overpaid
    lines["35a"] = res.refundOrOwed;                         // Refunded to you
    lines["37"] = 0;
  } else {
    lines["34"] = 0;
    lines["35a"] = 0;
    lines["37"] = Math.abs(res.refundOrOwed);                // Amount you owe
  }

  return lines;
}

/**
 * List of required schedules/forms based on the return data.
 */
export function requiredForms(result, taxReturn) {
  const forms = ["f1040"];

  const needsSchedule1 = result.adjustments.totalAdjustments > 0 ||
    result.income.otherIncomeSchedule1 > 0;
  if (needsSchedule1) forms.push("schedule1");

  const needsSchedule2 = result.tax.seTax > 0 || result.tax.additionalMedicareTax > 0;
  if (needsSchedule2) forms.push("schedule2");

  if (taxReturn.selfEmployment) forms.push("scheduleC");

  if ((taxReturn.capitalGains?.length > 0) ||
    taxReturn.income1099?.div?.some(d => d.capitalGainDistributions > 0)) {
    forms.push("scheduleD");
  }

  if (result.selfEmployment) forms.push("scheduleSE");

  if (taxReturn.hsa) forms.push("f8889");

  if (result.credits.childTaxCredit > 0 || result.credits.childTaxCreditRefundable > 0) {
    forms.push("f8812");
  }

  if (result.credits.lifetimeLearningCredit > 0 || result.credits.americanOpportunityCredit > 0) {
    forms.push("f8863");
  }

  if (result.deduction.usesItemized) forms.push("scheduleA");

  return forms;
}
