/**
 * Crow Tax — Tax Calculation Engine
 *
 * Takes a validated TaxReturn + TaxTables and computes the complete
 * federal tax liability. Returns a TaxResult with line values and
 * workPapers audit trail.
 */

/**
 * Round to nearest cent.
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Round down to nearest dollar (IRS convention for most lines).
 */
function roundDown(n) {
  return Math.floor(n);
}

/**
 * Calculate tax from progressive brackets.
 */
function calcBracketTax(taxableIncome, brackets) {
  let tax = 0;
  for (const bracket of brackets) {
    const max = bracket.max ?? Infinity;
    if (taxableIncome <= bracket.min) break;
    const taxable = Math.min(taxableIncome, max) - bracket.min;
    tax += taxable * bracket.rate;
  }
  return round2(tax);
}

/**
 * Calculate phaseout reduction.
 * Returns the reduced amount after applying the phaseout.
 */
function applyPhaseout(amount, agi, start, end) {
  if (agi <= start) return amount;
  if (agi >= end) return 0;
  const ratio = (agi - start) / (end - start);
  return round2(amount * (1 - ratio));
}

/**
 * Get employer HSA contributions from W-2 code W entries.
 */
function getW2CodeWAmount(w2s) {
  let total = 0;
  for (const w2 of w2s) {
    if (w2.code12) {
      for (const entry of w2.code12) {
        if (entry.code === "W") total += entry.amount;
      }
    }
  }
  return round2(total);
}

/**
 * Main calculation function.
 *
 * @param {object} taxReturn - Validated TaxReturn object
 * @param {object} tables - Tax tables for the filing year
 * @returns {object} TaxResult with all computed values and workPapers
 */
export function calculate(taxReturn, tables) {
  const wp = []; // workPapers audit trail
  const fs = taxReturn.filingStatus;

  // --- INCOME ---

  // Wages (1040 line 1a)
  const totalWages = round2(taxReturn.w2s.reduce((sum, w) => sum + w.wages, 0));
  wp.push({
    line: "1040.1a",
    value: totalWages,
    explanation: taxReturn.w2s.length > 0
      ? `W-2 wages: ${taxReturn.w2s.map((w, i) => `#${i + 1} $${w.wages.toFixed(2)} (${w.employer})`).join(" + ")}`
      : "No W-2 income",
  });

  // Interest income (1040 line 2b)
  const taxableInterest = round2(
    taxReturn.income1099.int.reduce((sum, f) => sum + f.interest, 0)
  );
  wp.push({ line: "1040.2b", value: taxableInterest, explanation: "Taxable interest from 1099-INT forms" });

  // Tax-exempt interest (1040 line 2a)
  const taxExemptInterest = round2(
    taxReturn.income1099.int.reduce((sum, f) => sum + (f.taxExemptInterest || 0), 0)
  );

  // Ordinary dividends (1040 line 3a/3b)
  const ordinaryDividends = round2(
    taxReturn.income1099.div.reduce((sum, f) => sum + f.ordinaryDividends, 0)
  );
  const qualifiedDividends = round2(
    taxReturn.income1099.div.reduce((sum, f) => sum + (f.qualifiedDividends || 0), 0)
  );

  // Capital gains (1040 line 7) — from Schedule D or direct
  let netCapitalGain = 0;
  let netShortTermGain = 0;
  let netLongTermGain = 0;
  if (taxReturn.capitalGains.length > 0) {
    netShortTermGain = round2(
      taxReturn.capitalGains
        .filter(t => !t.isLongTerm)
        .reduce((sum, t) => sum + (t.proceeds - t.costBasis), 0)
    );
    netLongTermGain = round2(
      taxReturn.capitalGains
        .filter(t => t.isLongTerm)
        .reduce((sum, t) => sum + (t.proceeds - t.costBasis), 0)
    );
    // Add capital gain distributions from 1099-DIV
    const capGainDist = round2(
      taxReturn.income1099.div.reduce((sum, f) => sum + (f.capitalGainDistributions || 0), 0)
    );
    netLongTermGain = round2(netLongTermGain + capGainDist);
    netCapitalGain = round2(netShortTermGain + netLongTermGain);
  } else {
    // Capital gain distributions only
    netCapitalGain = round2(
      taxReturn.income1099.div.reduce((sum, f) => sum + (f.capitalGainDistributions || 0), 0)
    );
    netLongTermGain = netCapitalGain;
  }

  // Self-employment income (Schedule C net profit)
  let schedCNetProfit = 0;
  if (taxReturn.selfEmployment) {
    const se = taxReturn.selfEmployment;
    const totalExpenses = Object.values(se.expenses).reduce((sum, v) => sum + v, 0);
    const grossProfit = se.grossReceipts - se.costOfGoodsSold;
    schedCNetProfit = round2(grossProfit - totalExpenses - se.homeOfficeDeduction);
    wp.push({
      line: "schedC.31",
      value: schedCNetProfit,
      explanation: `Schedule C net profit: $${se.grossReceipts} gross - $${se.costOfGoodsSold} COGS - $${totalExpenses.toFixed(2)} expenses - $${se.homeOfficeDeduction} home office`,
    });
  }

  // 1099-NEC income (Schedule 1 line 3 if no Schedule C, otherwise flows through Schedule C)
  const nec1099Total = round2(
    taxReturn.income1099.nec.reduce((sum, f) => sum + f.nonemployeeCompensation, 0)
  );

  // Other income: unemployment, state refund, misc
  const unemploymentComp = round2(
    taxReturn.income1099.g.reduce((sum, f) => sum + (f.unemploymentCompensation || 0), 0)
  );
  const miscIncome = round2(
    taxReturn.income1099.misc.reduce((sum, f) => sum + (f.otherIncome || 0) + (f.rents || 0) + (f.royalties || 0), 0)
  );

  // HSA taxable distributions
  let hsaTaxableDistributions = 0;
  if (taxReturn.hsa && taxReturn.hsa.distributions > 0) {
    const excessDist = Math.max(0, taxReturn.hsa.distributions - taxReturn.hsa.qualifiedExpenses);
    if (taxReturn.hsa.distributionCode === 1 || taxReturn.hsa.distributionCode === 2) {
      hsaTaxableDistributions = round2(excessDist);
    }
  }

  // Total other income (Schedule 1 part I)
  const otherIncomeSchedule1 = round2(
    schedCNetProfit + nec1099Total + unemploymentComp + miscIncome +
    netCapitalGain + hsaTaxableDistributions
  );

  // Total income (1040 line 9)
  const totalIncome = round2(totalWages + taxableInterest + ordinaryDividends + otherIncomeSchedule1);
  wp.push({ line: "1040.9", value: totalIncome, explanation: "Total income: wages + interest + dividends + Schedule 1 other income" });

  // --- ADJUSTMENTS (Schedule 1 Part II) ---

  // HSA deduction (ONLY personal contributions, NOT employer W-2 code W)
  let hsaDeduction = 0;
  if (taxReturn.hsa) {
    const employerContrib = getW2CodeWAmount(taxReturn.w2s);
    const maxContrib = tables.hsaLimits[taxReturn.hsa.coverageType];
    const catchUp = taxReturn.hsa.catchUp55 ? tables.hsaLimits.catchUp55 : 0;
    const totalLimit = maxContrib + catchUp;
    const remainingRoom = Math.max(0, totalLimit - employerContrib);
    hsaDeduction = round2(Math.min(taxReturn.hsa.personalContributions, remainingRoom));
    wp.push({
      line: "schedule1.13",
      value: hsaDeduction,
      explanation: `HSA deduction: personal contributions $${taxReturn.hsa.personalContributions} ` +
        `(limit $${totalLimit}, employer already contributed $${employerContrib} via W-2 code W — NOT deductible)`,
    });
  }

  // Educator expenses
  let educatorExpenseDeduction = 0;
  if (taxReturn.deductions.educatorExpenses.length > 0) {
    for (const ed of taxReturn.deductions.educatorExpenses) {
      if (ed.k12School && ed.hoursPerYear >= 900) {
        educatorExpenseDeduction += Math.min(ed.amount, tables.educatorExpenseLimit);
        wp.push({
          line: "schedule1.11",
          value: Math.min(ed.amount, tables.educatorExpenseLimit),
          explanation: `Educator expense: ${ed.name} (${ed.role}, ${ed.hoursPerYear}hrs) — $${Math.min(ed.amount, tables.educatorExpenseLimit)} (max $${tables.educatorExpenseLimit})`,
        });
      } else {
        wp.push({
          line: "schedule1.11",
          value: 0,
          explanation: `Educator expense DISQUALIFIED: ${ed.name} — ${!ed.k12School ? "not K-12" : `only ${ed.hoursPerYear} hours (need 900+)`}`,
        });
      }
    }
    educatorExpenseDeduction = round2(educatorExpenseDeduction);
  }

  // Student loan interest deduction
  let studentLoanDeduction = 0;
  if (taxReturn.deductions.studentLoanInterest) {
    const raw = Math.min(taxReturn.deductions.studentLoanInterest, tables.studentLoanInterestMax);
    const phaseout = tables.studentLoanPhaseout[fs] || tables.studentLoanPhaseout.single;
    // Note: phaseout is based on MAGI (which equals AGI for most filers)
    // We calculate AGI first without this deduction for the phaseout check
    const prelimAgi = round2(totalIncome - hsaDeduction - educatorExpenseDeduction);
    studentLoanDeduction = round2(applyPhaseout(raw, prelimAgi, phaseout.start, phaseout.end));
    wp.push({
      line: "schedule1.21",
      value: studentLoanDeduction,
      explanation: `Student loan interest: $${taxReturn.deductions.studentLoanInterest} paid, ` +
        `capped at $${tables.studentLoanInterestMax}, ` +
        `${studentLoanDeduction < raw ? `phaseout applied (AGI ~$${prelimAgi})` : "no phaseout"}`,
    });
  }

  // Self-employment tax deduction (deductible half of SE tax)
  let seTaxDeduction = 0;
  let seTax = 0;
  if (schedCNetProfit > 0 || nec1099Total > 0) {
    const seIncome = schedCNetProfit + nec1099Total;
    const seEarnings = round2(seIncome * tables.selfEmploymentTaxRate);
    const ssSeTax = round2(Math.min(seEarnings, tables.ssWageBase) * tables.ssTaxRate * 2);
    const medicareSeTax = round2(seEarnings * tables.medicareTaxRate * 2);
    seTax = round2(ssSeTax + medicareSeTax);
    seTaxDeduction = round2(seTax / 2);
    wp.push({
      line: "schedule1.15",
      value: seTaxDeduction,
      explanation: `Deductible half of SE tax: $${seTax} / 2 = $${seTaxDeduction} (SE income: $${seIncome})`,
    });
  }

  // IRA deduction
  const iraDeduction = round2(taxReturn.deductions.iraContributions || 0);

  // Total adjustments (Schedule 1 line 26 / 1040 line 10)
  const totalAdjustments = round2(
    educatorExpenseDeduction + hsaDeduction + studentLoanDeduction + seTaxDeduction + iraDeduction
  );
  wp.push({
    line: "1040.10",
    value: totalAdjustments,
    explanation: `Total adjustments: educator $${educatorExpenseDeduction} + HSA $${hsaDeduction} + student loan $${studentLoanDeduction} + SE tax $${seTaxDeduction} + IRA $${iraDeduction}`,
  });

  // --- AGI ---
  const agi = round2(totalIncome - totalAdjustments);
  wp.push({ line: "1040.11", value: agi, explanation: `AGI = $${totalIncome} total income - $${totalAdjustments} adjustments` });

  // --- DEDUCTIONS ---

  // Standard deduction
  let standardDeduction = tables.standardDeduction[fs] || tables.standardDeduction.single;
  // Additional standard deduction for age 65+ and blind
  const ss = taxReturn.specialSituations;
  if (fs === "single" || fs === "hoh") {
    if (ss.over65Taxpayer) standardDeduction += 2000;
    if (ss.blindTaxpayer) standardDeduction += 2000;
  } else {
    if (ss.over65Taxpayer) standardDeduction += 1600;
    if (ss.blindTaxpayer) standardDeduction += 1600;
    if (ss.over65Spouse) standardDeduction += 1600;
    if (ss.blindSpouse) standardDeduction += 1600;
  }

  // Itemized deductions
  const saltCap = fs === "mfs" ? 5000 : 10000;
  const itemizedSalt = Math.min(taxReturn.deductions.saltTaxes || 0, saltCap);
  const medicalFloor = round2(agi * 0.075);
  const medicalDeduction = Math.max(0, (taxReturn.deductions.medicalExpenses || 0) - medicalFloor);
  const itemizedTotal = round2(
    medicalDeduction +
    itemizedSalt +
    (taxReturn.deductions.mortgageInterest || 0) +
    (taxReturn.deductions.charitableDonations || 0) +
    (taxReturn.deductions.otherItemized || 0)
  );

  const usesItemized = itemizedTotal > standardDeduction;
  const chosenDeduction = usesItemized ? itemizedTotal : standardDeduction;
  wp.push({
    line: "1040.12",
    value: chosenDeduction,
    explanation: usesItemized
      ? `Itemized deduction: $${itemizedTotal} (medical $${medicalDeduction}, SALT $${itemizedSalt}, mortgage $${taxReturn.deductions.mortgageInterest || 0}, charity $${taxReturn.deductions.charitableDonations || 0})`
      : `Standard deduction: $${standardDeduction} (${fs})`,
  });

  // QBI deduction (simplified — 20% of qualified business income, subject to limits)
  let qbiDeduction = 0;
  if (schedCNetProfit > 0) {
    // Simplified: 20% of QBI or 20% of taxable income before QBI, whichever is less
    const taxableBeforeQbi = Math.max(0, agi - chosenDeduction);
    qbiDeduction = roundDown(Math.min(
      schedCNetProfit * tables.qualifiedBusinessIncomeDeduction,
      taxableBeforeQbi * tables.qualifiedBusinessIncomeDeduction
    ));
    wp.push({
      line: "1040.13",
      value: qbiDeduction,
      explanation: `QBI deduction: 20% of Schedule C net profit $${schedCNetProfit}`,
    });
  }

  // Taxable income (1040 line 15)
  const taxableIncome = roundDown(Math.max(0, agi - chosenDeduction - qbiDeduction));
  wp.push({
    line: "1040.15",
    value: taxableIncome,
    explanation: `Taxable income = $${agi} AGI - $${chosenDeduction} deduction - $${qbiDeduction} QBI`,
  });

  // --- TAX COMPUTATION ---

  const brackets = tables.brackets[fs] || tables.brackets.single;

  // If there are qualified dividends or long-term capital gains, use preferential rates
  let bracketTax;
  if (qualifiedDividends > 0 || netLongTermGain > 0) {
    const prefIncome = Math.min(qualifiedDividends + Math.max(0, netLongTermGain), taxableIncome);
    const ordinaryIncome = Math.max(0, taxableIncome - prefIncome);
    const ordinaryTax = calcBracketTax(ordinaryIncome, brackets);

    // Capital gains rates on preferential income
    const cgRates = tables.capitalGainsRates;
    const rate0Max = cgRates.rate0Threshold[fs] || cgRates.rate0Threshold.single;
    const rate15Max = cgRates.rate15Threshold[fs] || cgRates.rate15Threshold.single;

    let prefTax = 0;
    let remainingPref = prefIncome;
    const rate0Room = Math.max(0, rate0Max - ordinaryIncome);
    const at0 = Math.min(remainingPref, rate0Room);
    remainingPref -= at0;
    // 0% rate — no tax added

    const rate15Room = Math.max(0, rate15Max - ordinaryIncome - at0);
    const at15 = Math.min(remainingPref, rate15Room);
    prefTax += round2(at15 * 0.15);
    remainingPref -= at15;

    prefTax += round2(remainingPref * 0.20);

    // Use the lesser of bracket tax on all income vs ordinary + preferential
    const fullBracketTax = calcBracketTax(taxableIncome, brackets);
    bracketTax = Math.min(fullBracketTax, round2(ordinaryTax + prefTax));
    wp.push({
      line: "1040.16",
      value: bracketTax,
      explanation: `Tax with preferential rates: ordinary $${ordinaryTax} + cap gains/qualified div $${round2(prefTax)} = $${bracketTax} (full bracket would be $${fullBracketTax})`,
    });
  } else {
    bracketTax = calcBracketTax(taxableIncome, brackets);
    wp.push({
      line: "1040.16",
      value: bracketTax,
      explanation: `Bracket tax on $${taxableIncome} (${fs}): $${bracketTax}`,
    });
  }

  // Self-employment tax (Schedule SE, reported on Schedule 2)
  // Already calculated above as seTax

  // Additional Medicare tax
  let additionalMedicareTax = 0;
  const medicareThreshold = tables.additionalMedicareThreshold[fs] || 200000;
  const totalMedicareWages = round2(taxReturn.w2s.reduce((sum, w) => sum + w.medicareWages, 0));
  if (totalMedicareWages > medicareThreshold) {
    additionalMedicareTax = round2((totalMedicareWages - medicareThreshold) * tables.additionalMedicareRate);
    wp.push({
      line: "schedule2.11",
      value: additionalMedicareTax,
      explanation: `Additional Medicare tax: ($${totalMedicareWages} - $${medicareThreshold}) × 0.9%`,
    });
  }

  // Total tax before credits (1040 line 18)
  const totalTaxBeforeCredits = round2(bracketTax + seTax + additionalMedicareTax);

  // --- CREDITS ---

  // Child tax credit (Schedule 8812)
  let childTaxCredit = 0;
  let childTaxCreditRefundable = 0;
  const ctcDependents = taxReturn.dependents.filter(d => d.qualifiesForChildTaxCredit);
  if (ctcDependents.length > 0) {
    const ctc = tables.childTaxCredit;
    const rawCredit = ctcDependents.length * ctc.amount;
    const phaseoutStart = ctc.phaseoutStart[fs] || ctc.phaseoutStart.single;
    const reduction = Math.max(0, Math.ceil((agi - phaseoutStart) / 1000)) * ctc.phaseoutRate;
    const allowedCredit = Math.max(0, rawCredit - reduction);

    // Split into nonrefundable and refundable portions
    const nonrefundable = Math.min(allowedCredit, bracketTax);
    const refundable = Math.min(allowedCredit - nonrefundable, ctcDependents.length * ctc.refundableMax);
    childTaxCredit = nonrefundable;
    childTaxCreditRefundable = refundable;
    wp.push({
      line: "1040.19",
      value: allowedCredit,
      explanation: `Child tax credit: ${ctcDependents.length} qualifying children × $${ctc.amount} = $${rawCredit}${reduction > 0 ? `, phaseout -$${reduction}` : ""}`,
    });
  }

  // EITC (simplified)
  let eitc = 0;
  // EITC is complex — basic implementation for common cases
  const eitcChildren = taxReturn.dependents.filter(d => d.qualifiesForEitc).length;
  if (eitcChildren <= 3) {
    const eitcTable = tables.eitc;
    const eitcFs = (fs === "mfj") ? "mfj" : "single";
    const childKey = String(Math.min(eitcChildren, 3));
    const incomeLimit = eitcTable.incomeLimit[eitcFs]?.[childKey];
    const earnedIncome = totalWages + Math.max(0, schedCNetProfit);

    if (earnedIncome > 0 && earnedIncome < incomeLimit && agi < incomeLimit) {
      // Simplified: use max amount (actual calculation involves phase-in/phase-out)
      eitc = eitcTable.amounts[childKey] || 0;
      // This is a simplified version — real EITC requires the full EIC worksheet
      wp.push({
        line: "1040.27",
        value: eitc,
        explanation: `EITC estimate: ${eitcChildren} qualifying children, earned income $${earnedIncome} (simplified — use EIC worksheet for exact amount)`,
      });
    }
  }

  // Education credits (Form 8863)
  let lifetimeLearningCredit = 0;
  let americanOpportunityCredit = 0;
  let aotcRefundable = 0;
  if (taxReturn.educationCredits && taxReturn.educationCredits.length > 0) {
    const edTables = tables.educationCredits;
    let totalLlcExpenses = 0;

    for (const student of taxReturn.educationCredits) {
      const qualifiedExpenses = Math.max(0, student.tuitionPaid - student.scholarships);

      // Determine AOTC vs LLC eligibility
      const aotcEligible = !student.isGraduate &&
        student.isHalfTime &&
        student.yearsClaimedAotc < edTables.aotc.maxYears &&
        !student.felonyDrugConviction &&
        fs !== "mfs";

      if (aotcEligible) {
        // American Opportunity Credit: 100% of first $2,000 + 25% of next $2,000
        const aotcExpenses = Math.min(qualifiedExpenses, edTables.aotc.maxExpenses);
        let rawAotc = Math.min(aotcExpenses, 2000) + Math.max(0, aotcExpenses - 2000) * 0.25;
        rawAotc = round2(rawAotc);
        const phaseout = edTables.aotc.phaseout[fs] || edTables.aotc.phaseout.single;
        const aotcAfterPhaseout = round2(applyPhaseout(rawAotc, agi, phaseout.start, phaseout.end));
        americanOpportunityCredit = round2(americanOpportunityCredit + aotcAfterPhaseout);
        aotcRefundable = round2(aotcAfterPhaseout * edTables.aotc.refundableRate);
        wp.push({
          line: "8863.aotc",
          value: aotcAfterPhaseout,
          explanation: `AOTC for ${student.studentName}: $${qualifiedExpenses} qualified expenses, credit $${rawAotc}${aotcAfterPhaseout < rawAotc ? `, phaseout applied` : ""}`,
        });
      } else {
        // Lifetime Learning Credit: accumulate expenses across all LLC-eligible students
        totalLlcExpenses += qualifiedExpenses;
      }
    }

    if (totalLlcExpenses > 0 && fs !== "mfs") {
      const llcExpensesCapped = Math.min(totalLlcExpenses, edTables.llc.maxExpenses);
      const rawLlc = round2(llcExpensesCapped * edTables.llc.rate);
      const phaseout = edTables.llc.phaseout[fs] || edTables.llc.phaseout.single;
      lifetimeLearningCredit = round2(applyPhaseout(rawLlc, agi, phaseout.start, phaseout.end));
      wp.push({
        line: "8863.llc",
        value: lifetimeLearningCredit,
        explanation: `Lifetime Learning Credit: $${totalLlcExpenses} qualified expenses (capped at $${edTables.llc.maxExpenses}), ` +
          `${edTables.llc.rate * 100}% = $${rawLlc}${lifetimeLearningCredit < rawLlc ? `, phaseout applied (AGI $${agi})` : ""}`,
      });
    }
  }

  // Education credits are nonrefundable (except 40% of AOTC)
  const educationCreditNonrefundable = round2(
    lifetimeLearningCredit + americanOpportunityCredit - aotcRefundable
  );

  const totalCredits = round2(childTaxCredit + educationCreditNonrefundable);
  const totalRefundableCredits = round2(childTaxCreditRefundable + eitc + aotcRefundable);

  // Total tax after credits (1040 line 24)
  const totalTax = round2(Math.max(0, totalTaxBeforeCredits - totalCredits));
  wp.push({
    line: "1040.24",
    value: totalTax,
    explanation: `Total tax: $${totalTaxBeforeCredits} - $${totalCredits} credits = $${totalTax}`,
  });

  // --- PAYMENTS ---

  const federalWithheld = round2(
    taxReturn.w2s.reduce((sum, w) => sum + w.federalWithheld, 0) +
    taxReturn.income1099.int.reduce((sum, f) => sum + (f.federalWithheld || 0), 0) +
    taxReturn.income1099.div.reduce((sum, f) => sum + (f.federalWithheld || 0), 0) +
    taxReturn.income1099.nec.reduce((sum, f) => sum + (f.federalWithheld || 0), 0) +
    taxReturn.income1099.g.reduce((sum, f) => sum + (f.federalWithheld || 0), 0) +
    taxReturn.income1099.misc.reduce((sum, f) => sum + (f.federalWithheld || 0), 0)
  );
  wp.push({
    line: "1040.25a",
    value: federalWithheld,
    explanation: `Federal tax withheld: ${taxReturn.w2s.map((w, i) => `W-2 #${i + 1} $${w.federalWithheld}`).join(" + ")}${taxReturn.income1099.int.length > 0 ? " + 1099 withholding" : ""}`,
  });

  const totalPayments = round2(federalWithheld + totalRefundableCredits);
  wp.push({
    line: "1040.33",
    value: totalPayments,
    explanation: `Total payments: $${federalWithheld} withheld + $${totalRefundableCredits} refundable credits`,
  });

  // --- RESULT ---

  const refundOrOwed = round2(totalPayments - totalTax);
  if (refundOrOwed >= 0) {
    wp.push({ line: "1040.34", value: refundOrOwed, explanation: `Overpaid (refund): $${totalPayments} payments - $${totalTax} tax` });
  } else {
    wp.push({ line: "1040.37", value: Math.abs(refundOrOwed), explanation: `Amount owed: $${totalTax} tax - $${totalPayments} payments` });
  }

  return {
    taxYear: taxReturn.taxYear,
    filingStatus: fs,

    income: {
      totalWages,
      taxableInterest,
      taxExemptInterest,
      ordinaryDividends,
      qualifiedDividends,
      netCapitalGain,
      netShortTermGain,
      netLongTermGain,
      schedCNetProfit,
      nec1099Total,
      unemploymentComp,
      miscIncome,
      hsaTaxableDistributions,
      otherIncomeSchedule1,
      totalIncome,
    },

    adjustments: {
      educatorExpenseDeduction,
      hsaDeduction,
      studentLoanDeduction,
      seTaxDeduction,
      iraDeduction,
      totalAdjustments,
    },

    agi,

    deduction: {
      standard: standardDeduction,
      itemized: itemizedTotal,
      usesItemized,
      chosen: chosenDeduction,
      qbiDeduction,
      medicalDeduction,
      itemizedSalt,
    },

    taxableIncome,

    tax: {
      bracketTax,
      seTax,
      additionalMedicareTax,
      totalTaxBeforeCredits,
    },

    credits: {
      childTaxCredit,
      childTaxCreditRefundable,
      lifetimeLearningCredit,
      americanOpportunityCredit,
      aotcRefundable,
      eitc,
      totalCredits,
      totalRefundableCredits,
    },

    payments: {
      federalWithheld,
      totalPayments,
    },

    result: {
      totalTax,
      totalPayments,
      refundOrOwed,
    },

    // HSA details for Form 8889
    hsa: taxReturn.hsa ? {
      coverageType: taxReturn.hsa.coverageType,
      employerContributions: getW2CodeWAmount(taxReturn.w2s),
      personalContributions: taxReturn.hsa.personalContributions,
      deduction: hsaDeduction,
      distributions: taxReturn.hsa.distributions,
      qualifiedExpenses: taxReturn.hsa.qualifiedExpenses,
      taxableDistributions: hsaTaxableDistributions,
    } : null,

    // SE details for Schedule SE
    selfEmployment: (schedCNetProfit > 0 || nec1099Total > 0) ? {
      netProfit: schedCNetProfit + nec1099Total,
      seTax,
      seTaxDeduction,
    } : null,

    workPapers: wp,
  };
}
