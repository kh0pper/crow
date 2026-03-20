/**
 * Form 8863 — Education Credits
 *
 * Part I: Refundable American Opportunity Credit
 * Part II: Nonrefundable Education Credits
 * Part III: Student and Education Information (per student)
 *
 * Supports both AOTC (undergrad, up to 4 years) and
 * Lifetime Learning Credit (any level, no year limit).
 */

export function mapForm8863(result, taxReturn) {
  if (!taxReturn.educationCredits || taxReturn.educationCredits.length === 0) return {};
  if (!result.credits) return {};

  const cr = result.credits;
  const lines = {};

  // --- Part I: Refundable American Opportunity Credit ---
  // Line 1: tentative AOTC from Part III (per student, summed)
  lines["1"] = cr.americanOpportunityCredit || 0;
  // Line 2: from 1040 line 18 (total tax before credits)
  lines["2"] = result.tax.totalTaxBeforeCredits;
  // Line 3: nonrefundable credits from line 19 (not including education)
  lines["3"] = cr.childTaxCredit || 0;
  // Line 4: line 2 - line 3
  lines["4"] = Math.max(0, lines["2"] - lines["3"]);
  // Line 5-6: education credits calculation
  // Line 7: nonrefundable portion of AOTC
  const aotcNonrefundable = Math.min(cr.americanOpportunityCredit - (cr.aotcRefundable || 0), lines["4"]);
  lines["7"] = aotcNonrefundable;
  // Line 8: refundable AOTC (40% of line 1)
  lines["8"] = cr.aotcRefundable || 0;

  // --- Part II: Nonrefundable Education Credits ---
  // Line 9: adjusted qualified expenses for LLC (all students combined)
  const llcExpenses = taxReturn.educationCredits
    .filter(s => s.isGraduate || s.yearsClaimedAotc >= 4)
    .reduce((sum, s) => sum + Math.max(0, s.tuitionPaid - s.scholarships), 0);
  lines["9"] = Math.min(llcExpenses, 10000);
  // Line 10: LLC (20% of line 9)
  lines["10"] = cr.lifetimeLearningCredit || 0;

  // Line 11: line 10 after phaseout (already applied in calculator)
  lines["11"] = cr.lifetimeLearningCredit || 0;

  // Lines 12-18: phaseout calculation
  lines["12"] = result.agi;
  // Phaseout thresholds depend on filing status
  const isMfj = result.filingStatus === "mfj";
  lines["13"] = isMfj ? 160000 : 80000;
  lines["14"] = Math.max(0, lines["12"] - lines["13"]);
  lines["15"] = isMfj ? 20000 : 10000;
  lines["16"] = lines["15"] > 0 ? Math.min(1, lines["14"] / lines["15"]) : 0;
  lines["17"] = Math.round(lines["10"] * lines["16"] * 100) / 100;
  lines["18"] = Math.max(0, lines["10"] - lines["17"]);

  // Line 19: nonrefundable education credit (LLC + nonrefundable AOTC)
  lines["19"] = Math.round(((cr.lifetimeLearningCredit || 0) + aotcNonrefundable) * 100) / 100;

  // --- Part III: Student and Education Information (per student) ---
  taxReturn.educationCredits.forEach((student, i) => {
    const prefix = `student_${i + 1}`;
    lines[`${prefix}_name`] = student.studentName;
    lines[`${prefix}_ssn`] = ""; // SSN filled separately
    lines[`${prefix}_institution`] = student.institution;
    lines[`${prefix}_tuition`] = student.tuitionPaid;
    lines[`${prefix}_scholarships`] = student.scholarships;
    lines[`${prefix}_qualified`] = Math.max(0, student.tuitionPaid - student.scholarships);
    lines[`${prefix}_graduate`] = student.isGraduate ? "Yes" : "No";
    lines[`${prefix}_aotc_or_llc`] = (!student.isGraduate && student.yearsClaimedAotc < 4) ? "AOTC" : "LLC";
  });

  return lines;
}
