/**
 * Crow Tax — Form Mapper Tests
 *
 * Run: node --test tests/forms.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { processReturn } from "../engine/index.js";
import { getFormLines, requiredForms, FORM_REGISTRY } from "../engine/forms/index.js";

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/2025-sample.json"), "utf-8")
);

describe("Form registry", () => {
  it("should have all expected forms registered", () => {
    const expected = ["f1040", "schedule1", "scheduleC", "scheduleD", "scheduleSE", "f8889", "f8812", "f8863"];
    for (const id of expected) {
      assert.ok(FORM_REGISTRY[id], `Missing form: ${id}`);
    }
  });

  it("should have f8863 as supported", () => {
    assert.ok(!FORM_REGISTRY.f8863.unsupported);
  });
});

describe("Required forms — John & Jane", () => {
  const { result } = processReturn(fixture);

  it("should require f1040", () => {
    const needed = requiredForms(result, fixture);
    assert.ok(needed.includes("f1040"));
  });

  it("should require schedule1 (adjustments > 0)", () => {
    const needed = requiredForms(result, fixture);
    assert.ok(needed.includes("schedule1"));
  });

  it("should require f8889 (HSA present)", () => {
    const needed = requiredForms(result, fixture);
    assert.ok(needed.includes("f8889"));
  });

  it("should NOT require scheduleC (no self-employment)", () => {
    const needed = requiredForms(result, fixture);
    assert.ok(!needed.includes("scheduleC"));
  });

  it("should NOT require scheduleD (no capital gains)", () => {
    const needed = requiredForms(result, fixture);
    assert.ok(!needed.includes("scheduleD"));
  });
});

describe("Form 1040 lines", () => {
  const { result } = processReturn(fixture);
  const lines = getFormLines("f1040", result, fixture);

  it("should map wages to line 1a", () => {
    assert.equal(lines["1a"], 127000);
  });

  it("should map AGI to line 11", () => {
    assert.equal(lines["11"], 125450);
  });

  it("should map standard deduction to line 12", () => {
    assert.equal(lines["12"], 30000);
  });

  it("should map taxable income to line 15", () => {
    assert.equal(lines["15"], 95450);
  });

  it("should map bracket tax to line 16", () => {
    assert.equal(lines["16"], 10977);
  });

  it("should map federal withholding to line 25a", () => {
    assert.equal(lines["25a"], 11600);
  });

  it("should show refund on line 34", () => {
    assert.equal(lines["34"], 623);
  });
});

describe("Schedule 1 lines", () => {
  const { result } = processReturn(fixture);
  const lines = getFormLines("schedule1", result, fixture);

  it("should map educator expenses to line 11", () => {
    assert.equal(lines["11"], 300);
  });

  it("should map HSA deduction to line 13", () => {
    assert.equal(lines["13"], 0); // No personal contributions
  });

  it("should map student loan interest to line 20", () => {
    assert.equal(lines["20"], 1250);
  });

  it("should map total adjustments to line 26", () => {
    assert.equal(lines["26"], 1550);
  });
});

describe("Self-employment scenario", () => {
  const seFixture = {
    ...fixture,
    selfEmployment: {
      businessName: "Freelance Dev",
      grossReceipts: 50000,
      costOfGoodsSold: 0,
      expenses: {
        advertising: 0, carAndTruck: 0, commissions: 0,
        insurance: 0, legalAndProfessional: 500,
        officeExpense: 200, rentOrLease: 0,
        supplies: 300, utilities: 100, other: 0,
      },
      homeOfficeDeduction: 1500,
    },
  };

  it("should compute Schedule C net profit", () => {
    const { result } = processReturn(seFixture);
    // $50,000 - $1,100 expenses - $1,500 home office = $47,400
    assert.equal(result.income.schedCNetProfit, 47400);
  });

  it("should require Schedule C and SE", () => {
    const { result } = processReturn(seFixture);
    const needed = requiredForms(result, seFixture);
    assert.ok(needed.includes("scheduleC"));
    assert.ok(needed.includes("scheduleSE"));
  });

  it("should compute SE tax deduction", () => {
    const { result } = processReturn(seFixture);
    assert.ok(result.adjustments.seTaxDeduction > 0);
  });
});

describe("Capital gains scenario", () => {
  const cgFixture = {
    ...fixture,
    capitalGains: [
      { description: "AAPL", dateSold: "2025-06-15", proceeds: 15000, costBasis: 10000, isLongTerm: true },
      { description: "TSLA", dateSold: "2025-03-01", proceeds: 5000, costBasis: 6000, isLongTerm: false },
    ],
  };

  it("should compute net capital gain", () => {
    const { result } = processReturn(cgFixture);
    // AAPL: +$5,000 (long-term), TSLA: -$1,000 (short-term) = $4,000 net
    assert.equal(result.income.netCapitalGain, 4000);
  });

  it("should require Schedule D", () => {
    const { result } = processReturn(cgFixture);
    const needed = requiredForms(result, cgFixture);
    assert.ok(needed.includes("scheduleD"));
  });
});

describe("getFormLines error handling", () => {
  it("should return error for unknown form", () => {
    const lines = getFormLines("unknown", {}, {});
    assert.ok(lines.error);
  });

  it("should return empty for f8863 with no education credits", () => {
    const lines = getFormLines("f8863", { credits: {} }, { educationCredits: [] });
    assert.deepEqual(lines, {});
  });
});
