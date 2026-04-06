/**
 * Crow Tax Engine — Unit Tests
 *
 * Run: node --test tests/engine.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { processReturn, loadTables, calculate, validate } from "../engine/index.js";
import { TaxReturn } from "../engine/schema.js";

// Load test fixture
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/2025-sample.json"), "utf-8")
);

describe("Schema validation", () => {
  it("should validate the 2025 sample fixture", () => {
    const result = TaxReturn.safeParse(fixture);
    assert.equal(result.success, true, `Validation errors: ${JSON.stringify(result.error?.issues)}`);
  });

  it("should reject invalid filing status", () => {
    const bad = { ...fixture, filingStatus: "invalid" };
    const result = TaxReturn.safeParse(bad);
    assert.equal(result.success, false);
  });

  it("should reject invalid SSN", () => {
    const bad = { ...fixture, taxpayer: { ...fixture.taxpayer, ssn: "12345" } };
    const result = TaxReturn.safeParse(bad);
    assert.equal(result.success, false);
  });
});

describe("Tax tables", () => {
  it("should load 2025 tables", () => {
    const tables = loadTables(2025);
    assert.equal(tables.year, 2025);
    assert.equal(tables.standardDeduction.mfj, 31500);
    assert.equal(tables.saltCap.default, 40000);
    assert.equal(tables.hsaLimits.self, 4300);
  });

  it("should throw for unsupported year", () => {
    assert.throws(() => loadTables(2020), /not found/);
  });
});

describe("Calculator — John & Jane 2025", () => {
  const { result, forms, warnings, errors } = processReturn(fixture);

  it("should calculate without errors", () => {
    assert.equal(errors.length, 0);
    assert.ok(result !== null);
  });

  it("should compute total wages correctly", () => {
    // W-2 #1: $55,000 + W-2 #2: $72,000 = $127,000
    assert.equal(result.income.totalWages, 127000);
  });

  it("should NOT deduct HSA employer contributions", () => {
    // Employer contributed $1,200 via W-2 code W
    // Personal contributions are $0
    // HSA deduction should be $0
    assert.equal(result.adjustments.hsaDeduction, 0);
  });

  it("should only allow qualified educator expenses", () => {
    // Jane: teacher, K-12, 1800hrs → qualifies, $300
    assert.equal(result.adjustments.educatorExpenseDeduction, 300);
  });

  it("should compute student loan interest deduction", () => {
    // $1,250 paid, under $2,500 cap, AGI under phaseout
    assert.equal(result.adjustments.studentLoanDeduction, 1250);
  });

  it("should compute total adjustments", () => {
    // educator $300 + HSA $0 + student loan $1,250 = $1,550
    assert.equal(result.adjustments.totalAdjustments, 1550);
  });

  it("should compute AGI correctly", () => {
    // $127,000 - $1,550 = $125,450
    assert.equal(result.agi, 125450);
  });

  it("should use standard deduction for MFJ", () => {
    assert.equal(result.deduction.chosen, 31500);
    assert.equal(result.deduction.usesItemized, false);
  });

  it("should compute taxable income", () => {
    // $125,450 - $31,500 = $93,950
    assert.equal(result.taxableIncome, 93950);
  });

  it("should compute bracket tax correctly", () => {
    // MFJ brackets on $93,950:
    // 10% on first $23,850 = $2,385.00
    // 12% on $23,850-$93,950 = $8,412.00
    // Total = $10,797
    assert.equal(result.tax.bracketTax, 10797);
  });

  it("should compute total tax", () => {
    assert.equal(result.result.totalTax, 10797);
  });

  it("should compute federal withholding", () => {
    // W-2 #1: $4,400 + W-2 #2: $7,200 = $11,600
    assert.equal(result.payments.federalWithheld, 11600);
  });

  it("should compute refund", () => {
    // $11,600 payments - $10,797 tax = $803 refund
    assert.ok(result.result.refundOrOwed > 0);
    assert.equal(result.result.refundOrOwed, 803);
  });

  it("should have HSA taxable distributions = $0 (all qualified)", () => {
    // $850 distributions, $850 qualified expenses → $0 taxable
    assert.equal(result.income.hsaTaxableDistributions, 0);
  });

  it("should generate workPapers audit trail", () => {
    assert.ok(result.workPapers.length > 0);
    const agiPaper = result.workPapers.find(w => w.line === "1040.11");
    assert.ok(agiPaper);
    assert.equal(agiPaper.value, 125450);
  });

  it("should generate required forms", () => {
    assert.ok("f1040" in forms);
    assert.ok("schedule1" in forms);
    assert.ok("f8889" in forms);
  });
});

describe("Form 8889 — HSA", () => {
  const { result, forms } = processReturn(fixture);
  const f8889 = forms.f8889?.lines;

  it("should map Form 8889 lines", () => {
    assert.ok(f8889);
  });

  it("should show employer contributions on line 9", () => {
    assert.equal(f8889["9"], 1200);
  });

  it("should have $0 personal deduction on line 13", () => {
    // Personal contributions are $0
    assert.equal(f8889["13"], 0);
  });

  it("should have $0 taxable distributions on line 16", () => {
    // $850 distributions - $850 qualified expenses = $0
    assert.equal(f8889["16"], 0);
  });
});

describe("Validation rules", () => {
  it("should flag HSA over-contribution", () => {
    const overContrib = {
      ...fixture,
      hsa: {
        ...fixture.hsa,
        personalContributions: 5000, // $1,200 employer + $5,000 = exceeds $4,300 self limit
      },
    };
    const { errors } = processReturn(overContrib);
    assert.ok(errors.some(e => e.includes("HSA total contributions")));
  });

  it("should flag MFJ without spouse", () => {
    const noSpouse = { ...fixture, spouse: undefined };
    const { errors } = processReturn(noSpouse);
    assert.ok(errors.some(e => e.includes("requires spouse")));
  });
});
