/**
 * Crow Tax Engine — Public API
 *
 * Standalone module with zero Crow dependencies.
 * Import this to calculate taxes, get form lines, and validate returns.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TaxReturn } from "./schema.js";
import { calculate } from "./calculator.js";
import { getFormLines, getAllFormLines, requiredForms, detectUnsupportedSituations } from "./forms/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load tax tables for a given year.
 */
export function loadTables(year) {
  const path = resolve(__dirname, "tables", `${year}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new Error(`Tax tables for year ${year} not found. Available: 2024, 2025`);
  }
}

/**
 * Validate and calculate a complete tax return.
 *
 * @param {object} rawReturn - Unvalidated tax return data
 * @returns {{ result: object, forms: object, warnings: string[], errors: string[] }}
 */
export function processReturn(rawReturn) {
  // Validate schema
  const parsed = TaxReturn.safeParse(rawReturn);
  if (!parsed.success) {
    return {
      result: null,
      forms: null,
      warnings: [],
      errors: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`),
    };
  }

  const taxReturn = parsed.data;
  const tables = loadTables(taxReturn.taxYear);

  // Calculate
  const result = calculate(taxReturn, tables);

  // Get all form lines
  const forms = getAllFormLines(result, taxReturn);

  // Detect unsupported situations
  const warnings = detectUnsupportedSituations(taxReturn, tables);

  // Run validation checks
  const errors = validate(result, taxReturn, tables);

  return { result, forms, warnings, errors };
}

/**
 * Validate a calculated return for common errors.
 */
export function validate(result, taxReturn, tables) {
  const errors = [];

  // SSN format
  if (taxReturn.taxpayer.ssn && !/^\d{9}$/.test(taxReturn.taxpayer.ssn)) {
    errors.push("Taxpayer SSN must be exactly 9 digits");
  }
  if (taxReturn.spouse?.ssn && !/^\d{9}$/.test(taxReturn.spouse.ssn)) {
    errors.push("Spouse SSN must be exactly 9 digits");
  }

  // Filing status consistency
  if ((taxReturn.filingStatus === "mfj" || taxReturn.filingStatus === "mfs") && !taxReturn.spouse) {
    errors.push(`Filing status ${taxReturn.filingStatus} requires spouse information`);
  }
  if (taxReturn.filingStatus === "hoh" && taxReturn.dependents.length === 0) {
    errors.push("Head of Household filing status generally requires a qualifying dependent");
  }

  // Income cross-check
  const w2Total = taxReturn.w2s.reduce((s, w) => s + w.wages, 0);
  if (Math.abs(w2Total - result.income.totalWages) > 0.01) {
    errors.push(`W-2 wage total mismatch: sum is $${w2Total}, calculated $${result.income.totalWages}`);
  }

  // HSA validation
  if (taxReturn.hsa) {
    const maxContrib = tables.hsaLimits[taxReturn.hsa.coverageType];
    const catchUp = taxReturn.hsa.catchUp55 ? tables.hsaLimits.catchUp55 : 0;
    const totalLimit = maxContrib + catchUp;
    const employerContrib = taxReturn.w2s.reduce((s, w) => {
      return s + (w.code12?.filter(c => c.code === "W").reduce((ss, c) => ss + c.amount, 0) || 0);
    }, 0);
    const totalContrib = employerContrib + taxReturn.hsa.personalContributions;

    if (totalContrib > totalLimit) {
      errors.push(`HSA total contributions ($${totalContrib}) exceed ${taxReturn.hsa.coverageType} limit ($${totalLimit}). Excess contributions may be subject to 6% excise tax.`);
    }

    // CRITICAL: ensure employer contributions are not double-deducted
    if (result.hsa && result.hsa.deduction > taxReturn.hsa.personalContributions) {
      errors.push("HSA DEDUCTION ERROR: Deduction exceeds personal contributions. Employer W-2 code W contributions must NOT be deducted.");
    }
  }

  // Educator expense eligibility
  for (const ed of taxReturn.deductions.educatorExpenses) {
    if (!ed.k12School) {
      errors.push(`Educator expense for ${ed.name}: not a K-12 school — does not qualify`);
    }
    if (ed.hoursPerYear < 900) {
      errors.push(`Educator expense for ${ed.name}: ${ed.hoursPerYear} hours (need 900+) — does not qualify`);
    }
  }

  // Bracket sanity check
  if (result.taxableIncome > 0 && result.tax.bracketTax === 0) {
    errors.push("Warning: taxable income > 0 but computed tax is $0 — review calculation");
  }

  // SE tax when SE income exists
  if ((result.income.schedCNetProfit > 0 || result.income.nec1099Total > 0) && result.tax.seTax === 0) {
    errors.push("Warning: self-employment income present but SE tax is $0 — review calculation");
  }

  // Child tax credit requires qualifying children
  if (result.credits.childTaxCredit > 0 && !taxReturn.dependents.some(d => d.qualifiesForChildTaxCredit)) {
    errors.push("Child tax credit claimed but no qualifying children flagged");
  }

  return errors;
}

// Re-export for direct use
export { TaxReturn } from "./schema.js";
export { calculate } from "./calculator.js";
export { getFormLines, getAllFormLines, requiredForms, FORM_REGISTRY } from "./forms/index.js";
