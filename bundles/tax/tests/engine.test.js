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
    assert.equal(tables.standardDeduction.mfj, 30000);
    assert.equal(tables.hsaLimits.self, 4300);
  });

  it("should throw for unsupported year", () => {
    assert.throws(() => loadTables(2020), /not found/);
  });
});

describe("Calculator — John & Jane 2025", () => {
  const { result, forms, warnings, errors } = processReturn(fixture);

  it("should calculate without schema errors", () => {
    // Only validation "error" is John's non-K-12 educator expense — this is expected
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("John Q. Public"));
    assert.ok(errors[0].includes("not a K-12 school"));
    assert.ok(result !== null);
  });

  it("should compute total wages correctly", () => {
    // W-2 #1: $60,000.21 + W-2 #2: $76,962.38 = $136,962.59
    assert.equal(result.income.totalWages, 136962.59);
  });

  it("should NOT deduct HSA employer contributions", () => {
    // Employer contributed $470.58 via W-2 code W
    // Personal contributions are $0
    // HSA deduction should be $0
    assert.equal(result.adjustments.hsaDeduction, 0);
  });

  it("should only allow qualified educator expenses", () => {
    // Jane: teacher, K-12, 1800hrs → qualifies, $300 (capped from $450)
    // John: counselor, NOT K-12 → disqualified, $0
    assert.equal(result.adjustments.educatorExpenseDeduction, 300);
  });

  it("should compute student loan interest deduction", () => {
    // $170.58 paid, under $2500 cap, AGI well under phaseout
    assert.equal(result.adjustments.studentLoanDeduction, 170.58);
  });

  it("should compute total adjustments", () => {
    // educator $300 + HSA $0 + student loan $170.58 = $470.58
    assert.equal(result.adjustments.totalAdjustments, 470.58);
  });

  it("should compute AGI correctly", () => {
    // $136,962.59 - $470.58 = $136,492.01
    assert.equal(result.agi, 136492.01);
  });

  it("should use standard deduction for MFJ", () => {
    assert.equal(result.deduction.chosen, 30000);
    assert.equal(result.deduction.usesItemized, false);
  });

  it("should compute taxable income", () => {
    // $136,492.01 - $30,000 = $106,492.01 → floor to $106,492
    assert.equal(result.taxableIncome, 106492);
  });

  it("should compute bracket tax correctly", () => {
    // MFJ brackets on $106,492:
    // 10% on first $23,850 = $2,385.00
    // 12% on $23,850-$96,950 = $8,772.00
    // 22% on $96,950-$106,492 = $2,099.24
    // Total = $13,256.24
    assert.equal(result.tax.bracketTax, 13256.24);
  });

  it("should compute total tax", () => {
    assert.equal(result.result.totalTax, 13256.24);
  });

  it("should compute federal withholding", () => {
    // W-2 #1: $4,200 + W-2 #2: $8,480 = $12,680
    assert.equal(result.payments.federalWithheld, 12680);
  });

  it("should compute amount owed", () => {
    // $12,680 payments - $13,256.24 tax = -$576.24 (owed)
    assert.ok(result.result.refundOrOwed < 0);
    assert.equal(Math.abs(result.result.refundOrOwed), 576.24);
  });

  it("should have HSA taxable distributions = $0 (all qualified)", () => {
    // $420 distributions, $420 qualified expenses → $0 taxable
    assert.equal(result.income.hsaTaxableDistributions, 0);
  });

  it("should generate workPapers audit trail", () => {
    assert.ok(result.workPapers.length > 0);
    const agiPaper = result.workPapers.find(w => w.line === "1040.11");
    assert.ok(agiPaper);
    assert.equal(agiPaper.value, 136492.01);
  });

  it("should detect 6013(h) warning", () => {
    assert.ok(warnings.some(w => w.includes("6013(h)")));
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
    assert.equal(f8889["9"], 470.58);
  });

  it("should have $0 personal deduction on line 13", () => {
    // Personal contributions are $0
    assert.equal(f8889["13"], 0);
  });

  it("should have $0 taxable distributions on line 16", () => {
    // $420 distributions - $420 qualified expenses = $0
    assert.equal(f8889["16"], 0);
  });
});

describe("Validation rules", () => {
  it("should flag HSA over-contribution", () => {
    const overContrib = {
      ...fixture,
      hsa: {
        ...fixture.hsa,
        personalContributions: 5000, // $470.58 employer + $5000 = exceeds $4,300 self limit
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
