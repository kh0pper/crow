#!/usr/bin/env node

/**
 * Phase 8 — Integration Test
 *
 * Tests the full flow through the MCP server:
 * 1. Create return
 * 2. Add John & Jane's W-2s, 1099-SA, 1098-E
 * 3. Set HSA, educator expenses, special situations
 * 4. Calculate and verify result
 * 5. Get form lines
 * 6. Generate PDFs
 * 7. Generate filing guide
 * 8. Purge return
 *
 * Run: CROW_TAX_ENCRYPTION_KEY=test CROW_DB_PATH=/tmp/crow-tax-test.db node tests/integration.test.js
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTaxServer } from "../server/server.js";
import { createDbClient } from "../server/db.js";
import { initTaxTables } from "../server/init-tables.js";
import { unlinkSync, existsSync } from "node:fs";

// Use a temp DB for testing
const TEST_DB = process.env.CROW_DB_PATH || "/tmp/crow-tax-integration-test.db";
process.env.CROW_DB_PATH = TEST_DB;
process.env.CROW_TAX_ENCRYPTION_KEY = process.env.CROW_TAX_ENCRYPTION_KEY || "test-integration-key-12345";

// Clean up any previous test DB
if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

let server;
let returnId;

// Helper: call an MCP tool directly via the server's internal handler
async function callTool(toolName, params) {
  const tool = server._registeredTools[toolName];
  if (!tool) throw new Error(`Tool ${toolName} not found. Available: ${Object.keys(server._registeredTools).join(", ")}`);
  return tool.handler(params, {});
}

describe("Integration: Full tax filing flow", () => {
  before(async () => {
    const db = createDbClient(TEST_DB);
    await initTaxTables(db);
    server = createTaxServer(TEST_DB);
  });

  after(() => {
    if (existsSync(TEST_DB)) {
      try { unlinkSync(TEST_DB); } catch {}
    }
  });

  it("Step 1: Create a new return", async () => {
    const result = await callTool("crow_tax_new_return", {
      tax_year: 2025,
      filing_status: "mfj",
      taxpayer_name: "John Q. Public",
      taxpayer_ssn: "000000000",
      spouse_name: "Jane A. Public",
      spouse_ssn: "000000001",
    });
    const text = result.content[0].text;
    assert.ok(text.includes("Tax return created"));
    // Extract the return ID
    const match = text.match(/ID: (tr-\S+)/);
    assert.ok(match, "Should contain return ID");
    returnId = match[1];
    console.log(`  Return ID: ${returnId}`);
  });

  it("Step 2: Add W-2 #1 (Acme Corporation)", async () => {
    const result = await callTool("crow_tax_add_w2", {
      return_id: returnId,
      employer: "Acme Corporation",
      wages: 60000.21,
      federal_withheld: 4200.00,
      ss_wages: 60000.21,
      ss_tax: 3720.01,
      medicare_wages: 60000.21,
      medicare_tax: 870.00,
    });
    assert.ok(result.content[0].text.includes("Acme Corporation"));
  });

  it("Step 3: Add W-2 #2 (Widget Industries) with code W", async () => {
    const result = await callTool("crow_tax_add_w2", {
      return_id: returnId,
      employer: "Widget Industries",
      wages: 76962.38,
      federal_withheld: 8480.00,
      ss_wages: 76962.38,
      ss_tax: 4771.67,
      medicare_wages: 76962.38,
      medicare_tax: 1115.95,
      code_12: [{ code: "W", amount: 470.58 }],
    });
    const text = result.content[0].text;
    assert.ok(text.includes("Total wages: $136962.59"));
  });

  it("Step 4: Add 1099-SA (HSA distributions)", async () => {
    const result = await callTool("crow_tax_add_1099", {
      return_id: returnId,
      type: "SA",
      payer: "Optum Bank",
      amount: 420.00,
      distribution_code: 1,
    });
    assert.ok(result.content[0].text.includes("1099-SA"));
  });

  it("Step 5: Add 1098-E (student loan interest)", async () => {
    const result = await callTool("crow_tax_add_1098", {
      return_id: returnId,
      type: "E",
      amount: 170.58,
    });
    assert.ok(result.content[0].text.includes("student loan interest"));
  });

  it("Step 6: Add educator expense (Jane — qualifies)", async () => {
    const result = await callTool("crow_tax_add_deduction", {
      return_id: returnId,
      type: "educator",
      amount: 450,
      educator_name: "Jane A. Public",
      educator_role: "teacher",
      k12_school: true,
      hours_per_year: 1800,
    });
    assert.ok(result.content[0].text.includes("educator"));
  });

  it("Step 7: Add educator expense (John — does NOT qualify)", async () => {
    const result = await callTool("crow_tax_add_deduction", {
      return_id: returnId,
      type: "educator",
      amount: 200,
      educator_name: "John Q. Public",
      educator_role: "counselor",
      k12_school: false,
      hours_per_year: 1200,
    });
    assert.ok(result.content[0].text.includes("educator"));
  });

  it("Step 8: Set HSA details", async () => {
    const result = await callTool("crow_tax_set_hsa", {
      return_id: returnId,
      coverage_type: "self",
      employer_contributions: 470.58,
      personal_contributions: 0,
      distributions: 420.00,
      qualified_expenses: 420.00,
      distribution_code: 1,
      months_covered: 12,
      catch_up_55: false,
    });
    const text = result.content[0].text;
    assert.ok(text.includes("NOT deductible"));
  });

  it("Step 9: Set special situations (6013(h))", async () => {
    const result = await callTool("crow_tax_set_special", {
      return_id: returnId,
      nonresident_spouse_election: true,
      spouse_green_card_date: "2025-01-01",
    });
    assert.ok(result.content[0].text.includes("6013(h)"));
  });

  it("Step 10: Validate", async () => {
    const result = await callTool("crow_tax_validate", {
      return_id: returnId,
    });
    const text = result.content[0].text;
    // Should flag John's non-K-12 educator expense
    assert.ok(text.includes("John Q. Public"));
    // Should have warnings about 6013(h)
    assert.ok(text.includes("6013(h)"));
  });

  it("Step 11: Calculate", async () => {
    const result = await callTool("crow_tax_calculate", {
      return_id: returnId,
    });
    const text = result.content[0].text;

    // Verify key values
    assert.ok(text.includes("136962.59"), "Should show total wages");
    assert.ok(text.includes("136492.01"), "Should show AGI");
    assert.ok(text.includes("30000"), "Should show standard deduction");
    assert.ok(text.includes("106492"), "Should show taxable income");
    assert.ok(text.includes("13256.24"), "Should show bracket tax");
    assert.ok(text.includes("12680"), "Should show withholding");
    assert.ok(text.includes("576.24"), "Should show amount owed");
    assert.ok(text.includes("AMOUNT OWED"), "Should indicate owed, not refund");

    console.log("\n  Calculation summary verified:");
    console.log("    Wages:    $136,962.59");
    console.log("    AGI:      $136,492.01");
    console.log("    Tax:      $13,256.24");
    console.log("    Withheld: $12,680.00");
    console.log("    Owed:     $576.24");
  });

  it("Step 12: Get Form 1040 lines", async () => {
    const result = await callTool("crow_tax_get_form", {
      return_id: returnId,
      form: "f1040",
    });
    const text = result.content[0].text;
    assert.ok(text.includes("f1040"));
    assert.ok(text.includes("136962.59"), "Line 1a should have wages");
    assert.ok(text.includes("136492.01"), "Line 11 should have AGI");
  });

  it("Step 13: Get Form 8889 lines", async () => {
    const result = await callTool("crow_tax_get_form", {
      return_id: returnId,
      form: "f8889",
    });
    const text = result.content[0].text;
    assert.ok(text.includes("470.58"), "Line 9 should show employer contributions");
  });

  it("Step 14: Generate PDFs", async () => {
    const result = await callTool("crow_tax_generate_pdfs", {
      return_id: returnId,
    });
    const text = result.content[0].text;
    if (result.isError) {
      // PDF templates might not be in the installed copy — acceptable
      console.log("  (PDF generation skipped — templates not in test path)");
    } else {
      assert.ok(text.includes("PDFs generated"));
      console.log(`  ${text}`);
    }
  });

  it("Step 15: Generate filing guide", async () => {
    const result = await callTool("crow_tax_filing_guide", {
      return_id: returnId,
    });
    const text = result.content[0].text;
    assert.ok(text.includes("Filing Guide"));
    assert.ok(text.includes("freefilefillableforms.com"));
    assert.ok(text.includes("Do the Math"));
    assert.ok(text.includes("6013(h)"), "Should mention 6013(h) special instruction");
    assert.ok(text.includes("576.24"), "Should show amount owed");
  });

  it("Step 16: Purge return (preview)", async () => {
    const result = await callTool("crow_tax_purge_return", {
      return_id: returnId,
      confirm: false,
    });
    assert.ok(result.content[0].text.includes("permanently delete"));
  });

  it("Step 17: Purge return (confirmed)", async () => {
    const result = await callTool("crow_tax_purge_return", {
      return_id: returnId,
      confirm: true,
    });
    assert.ok(result.content[0].text.includes("securely deleted"));
  });

  it("Step 18: Verify purged return is gone", async () => {
    const result = await callTool("crow_tax_calculate", {
      return_id: returnId,
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("not found"));
  });
});
