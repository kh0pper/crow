/**
 * Crow Tax MCP Server
 *
 * Factory function: createTaxServer(dbPath?, options?)
 * Provides 16 tools for tax return management.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { createDbClient } from "./db.js";
import { initTaxTables } from "./init-tables.js";
import { encrypt, decrypt } from "./crypto.js";
import { processReturn, loadTables, getFormLines, requiredForms, validate } from "../engine/index.js";

function genReturnId() {
  const ts = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
  const rand = randomBytes(3).toString("hex");
  return `tr-${ts}-${rand}`;
}

function getEncryptionKey() {
  const key = process.env.CROW_TAX_ENCRYPTION_KEY;
  if (!key) throw new Error("CROW_TAX_ENCRYPTION_KEY not set. Required for PII encryption.");
  return key;
}

export function createTaxServer(dbPath, options = {}) {
  const server = new McpServer(
    { name: "crow-tax", version: "1.0.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  const db = createDbClient(dbPath);

  // Helper: load return from DB
  async function loadReturn(id) {
    const row = await db.execute({ sql: "SELECT * FROM tax_returns WHERE id = ?", args: [id] });
    if (row.rows.length === 0) return null;
    const r = row.rows[0];
    try {
      const decrypted = decrypt(r.data, getEncryptionKey());
      return { ...r, data: JSON.parse(decrypted), result: r.result ? JSON.parse(r.result) : null };
    } catch {
      return { ...r, data: JSON.parse(r.data), result: r.result ? JSON.parse(r.result) : null };
    }
  }

  // Helper: save return to DB
  async function saveReturn(id, taxReturn, result, status) {
    const encryptedData = encrypt(JSON.stringify(taxReturn), getEncryptionKey());
    const resultJson = result ? JSON.stringify(result) : null;
    await db.execute({
      sql: `INSERT INTO tax_returns (id, tax_year, filing_status, data, result, status, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET data = ?, result = ?, status = ?, updated_at = datetime('now')`,
      args: [id, taxReturn.taxYear, taxReturn.filingStatus, encryptedData, resultJson, status,
             encryptedData, resultJson, status],
    });
  }

  // Helper: list active returns
  async function getActiveReturn() {
    const rows = await db.execute({
      sql: "SELECT id, tax_year, filing_status, status, updated_at FROM tax_returns WHERE status != 'purged' ORDER BY updated_at DESC LIMIT 1",
      args: [],
    });
    return rows.rows[0] || null;
  }

  // --- crow_tax_prepare_from_documents ---
  server.tool(
    "crow_tax_prepare_from_documents",
    "One-step tax return preparation: creates a return from ALL confirmed documents uploaded through the Tax Filing panel. Automatically adds W-2s, 1099s, 1098s, and calculates. SSNs and names are auto-filled from W-2 documents when available — only ask the user for filing_status and tax_year.",
    {
      tax_year: z.number().describe("Tax year (e.g. 2025)"),
      filing_status: z.enum(["single", "mfj", "mfs", "hoh", "qw"]).describe("Filing status"),
      taxpayer_name: z.string().optional().describe("Auto-filled from first W-2 if not provided"),
      taxpayer_ssn: z.string().optional().describe("Auto-filled from first W-2 if not provided"),
      taxpayer_dob: z.string().optional().describe("Taxpayer date of birth"),
      spouse_name: z.string().optional().describe("Auto-filled from second W-2 if MFJ"),
      spouse_ssn: z.string().optional().describe("Auto-filled from second W-2 if MFJ"),
      spouse_dob: z.string().optional().describe("Spouse date of birth"),
    },
    async (params) => {
      try {
        // 1. Get confirmed documents
        const docs = await db.execute({
          sql: "SELECT * FROM tax_documents WHERE status = 'confirmed' ORDER BY uploaded_at",
          args: [],
        });
        if (docs.rows.length === 0) {
          return { content: [{ type: "text", text: "No confirmed documents found. Upload and confirm documents in the Tax Filing panel first." }], isError: true };
        }

        // 1b. Auto-fill SSN and names from W-2 documents, using owner tags
        const parsedDocs = docs.rows.map(d => ({
          ...d,
          data: d.extracted_data ? JSON.parse(d.extracted_data) : null,
          owner: d.owner || "taxpayer",
        }));
        const taxpayerW2 = parsedDocs.find(d => d.doc_type === "w2" && d.owner === "taxpayer")?.data || {};
        const spouseW2 = parsedDocs.find(d => d.doc_type === "w2" && d.owner === "spouse")?.data || {};
        // Fallback: if no owner tags, use first/second W-2
        const w2Docs = parsedDocs.filter(d => d.doc_type === "w2" && d.data);
        const w2_1 = taxpayerW2.employeeName ? taxpayerW2 : (w2Docs[0]?.data || {});
        const w2_2 = spouseW2.employeeName ? spouseW2 : (w2Docs[1]?.data || {});

        const taxpayerName = params.taxpayer_name || w2_1.employeeName || "Unknown";
        const taxpayerSsn = params.taxpayer_ssn || (w2_1.employeeSsn || "").replace(/-/g, "") || "000000000";
        const spouseName = params.spouse_name || (params.filing_status === "mfj" ? (w2_2.employeeName || "") : "");
        const spouseSsn = params.spouse_ssn || (params.filing_status === "mfj" ? (w2_2.employeeSsn || "").replace(/-/g, "") : "");

        // 2. Create the return
        const id = genReturnId();
        const taxReturn = {
          taxYear: params.tax_year,
          filingStatus: params.filing_status,
          taxpayer: { name: taxpayerName, ssn: taxpayerSsn, dateOfBirth: params.taxpayer_dob },
          dependents: [],
          w2s: [],
          income1099: { sa: [], int: [], div: [], nec: [], g: [], misc: [] },
          deductions: { educatorExpenses: [] },
          educationCredits: [],
          capitalGains: [],
          specialSituations: {},
        };
        if (spouseName) {
          taxReturn.spouse = { name: spouseName, ssn: spouseSsn, dateOfBirth: params.spouse_dob };
        }

        const log = [`Created return ${id} (${params.tax_year} ${params.filing_status.toUpperCase()})`];

        // 3. Add each confirmed document
        for (const doc of docs.rows) {
          const data = doc.extracted_data ? JSON.parse(doc.extracted_data) : null;
          if (!data) continue;

          if (doc.doc_type === "w2") {
            taxReturn.w2s.push({
              employer: data.employer || "Unknown",
              wages: data.wages || 0,
              federalWithheld: data.federalWithheld || 0,
              ssWages: data.ssWages || 0,
              ssTaxWithheld: data.ssTaxWithheld || 0,
              medicareWages: data.medicareWages || 0,
              medicareTaxWithheld: data.medicareTaxWithheld || 0,
              stateWages: data.stateWages || 0,
              stateWithheld: data.stateWithheld || 0,
              code12: data.code12 || [],
              isStatutoryEmployee: false,
            });
            log.push(`  Added W-2: ${data.employer} ($${(data.wages || 0).toFixed(2)})`);
          } else if (doc.doc_type === "1099-sa") {
            taxReturn.income1099.sa.push({
              payer: data.payer || "Unknown",
              grossDistribution: data.grossDistribution || 0,
              distributionCode: data.distributionCode || 1,
              hsaOrMsa: "hsa",
            });
            log.push(`  Added 1099-SA: $${(data.grossDistribution || 0).toFixed(2)}`);
          } else if (doc.doc_type === "1098-t") {
            taxReturn.educationCredits.push({
              studentName: data.studentName || params.taxpayer_name,
              institution: data.institution || "Unknown",
              tuitionPaid: data.tuitionPaid || 0,
              scholarships: data.scholarships || 0,
              isGraduate: data.isGraduate || false,
              isHalfTime: data.isHalfTime !== false,
              yearsClaimedAotc: data.yearsClaimedAotc || 0,
              felonyDrugConviction: false,
            });
            const creditType = data.isGraduate ? "LLC (graduate)" : "AOTC (undergraduate)";
            log.push(`  Added 1098-T: ${data.institution} ($${(data.tuitionPaid || 0).toFixed(2)}) → ${creditType}`);
          } else if (doc.doc_type === "1098-e") {
            taxReturn.deductions.studentLoanInterest = (taxReturn.deductions.studentLoanInterest || 0) + (data.interest || 0);
            log.push(`  Added 1098-E: $${(data.interest || 0).toFixed(2)} student loan interest`);
          }
        }

        // 3b. Auto-configure HSA if 1099-SA was added
        const hsaDist = taxReturn.income1099.sa.reduce((s, sa) => s + (sa.grossDistribution || 0), 0);
        if (hsaDist > 0) {
          // Find employer HSA contributions from W-2 code W
          let employerHsa = 0;
          for (const w2 of taxReturn.w2s) {
            for (const c of w2.code12 || []) {
              if (c.code === "W") employerHsa += c.amount;
            }
          }
          taxReturn.hsa = {
            coverageType: "self", // Default — user can change to "family" later
            employerContributions: employerHsa,
            personalContributions: 0,
            distributions: hsaDist,
            qualifiedExpenses: hsaDist, // Assume all qualified — user confirmed via documents
            distributionCode: 1,
            monthsCovered: 12,
            hadHdhpFullYear: true,
            catchUp55: false,
          };
          log.push(`  Auto-configured HSA: employer $${employerHsa.toFixed(2)}, distributions $${hsaDist.toFixed(2)} (all qualified)`);
        }

        // 4. Calculate
        await saveReturn(id, taxReturn, null, "draft");
        const { result, forms, warnings, errors } = processReturn(taxReturn);

        if (result) {
          await saveReturn(id, taxReturn, result, errors.length > 0 ? "draft" : "calculated");

          log.push("", "=== Calculation Result ===",
            `Total income:    $${result.income.totalIncome.toFixed(2)}`,
            `AGI:             $${result.agi.toFixed(2)}`,
            `Deduction:       $${result.deduction.chosen.toFixed(2)} (${result.deduction.usesItemized ? "itemized" : "standard"})`,
            `Taxable income:  $${result.taxableIncome.toFixed(2)}`,
            `Tax:             $${result.tax.bracketTax.toFixed(2)}`,
            `Credits:         $${result.credits.totalCredits.toFixed(2)}`,
            `Total tax:       $${result.result.totalTax.toFixed(2)}`,
            `Payments:        $${result.payments.totalPayments.toFixed(2)}`,
            result.result.refundOrOwed >= 0
              ? `REFUND:          $${result.result.refundOrOwed.toFixed(2)}`
              : `AMOUNT OWED:     $${Math.abs(result.result.refundOrOwed).toFixed(2)}`,
            `Required forms:  ${Object.keys(forms).join(", ")}`,
          );

          if (warnings.length > 0) {
            log.push("", "Warnings:", ...warnings.map(w => `  - ${w}`));
          }

          log.push("", "IMPORTANT — verify with the user before generating PDFs:",
            "  1. Education credit: Ask 'What type of program are you enrolled in?' (undergraduate degree, graduate degree, professional certificate, trade/vocational program). Undergraduate = AOTC eligible. Graduate/professional/trade = LLC only.",
            "     To fix: crow_tax_add_education_credit with is_graduate=true for non-undergraduate (replaces existing)",
            "  2. Educator expenses: ask who is an educator (NOT assumed from employer name)",
            "     To add: crow_tax_add_deduction with type='educator'",
            "  3. HSA coverage: self or family? (currently set to self)",
            "     To fix: crow_tax_set_hsa",
            "  4. Special situations: 6013(h) election for nonresident spouse?",
            "     To add: crow_tax_set_special",
            "  Do NOT re-add W-2s, 1099s, or 1098-E — already included.",
          );
        } else {
          log.push("", "Calculation failed:", ...errors.map(e => `  - ${e}`));
        }

        return { content: [{ type: "text", text: log.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Preparation failed: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_tax_get_documents ---
  server.tool(
    "crow_tax_get_documents",
    "List all uploaded and confirmed tax documents. Returns extracted data from W-2s, 1099s, 1098s that have been uploaded through the Tax Filing panel. Use this to find documents before creating a return.",
    {},
    async () => {
      try {
        const docs = await db.execute({
          sql: "SELECT id, filename, doc_type, status, extracted_data, warnings, uploaded_at FROM tax_documents ORDER BY uploaded_at DESC",
          args: [],
        });

        if (docs.rows.length === 0) {
          return { content: [{ type: "text", text: "No tax documents found. Upload documents through the Tax Filing panel (Documents tab) first." }] };
        }

        const results = docs.rows.map((d) => {
          const data = d.extracted_data ? JSON.parse(d.extracted_data) : null;
          return {
            id: d.id,
            filename: d.filename,
            type: d.doc_type,
            status: d.status,
            data,
          };
        });

        const confirmed = results.filter((d) => d.status === "confirmed");
        const pending = results.filter((d) => d.status !== "confirmed");

        const lines = [
          `Found ${results.length} document(s): ${confirmed.length} confirmed, ${pending.length} pending`,
          "",
        ];

        for (const doc of results) {
          lines.push(`--- ${doc.filename} (${doc.type}) [${doc.status}] ---`);
          if (doc.data) {
            for (const [k, v] of Object.entries(doc.data)) {
              if (v === 0 || v === "" || v === null || v === false) continue;
              if (Array.isArray(v) && v.length === 0) continue;
              const display = typeof v === "number" ? `$${v.toFixed(2)}` : (Array.isArray(v) ? v.map(x => `${x.code}:$${x.amount}`).join(", ") : String(v));
              lines.push(`  ${k}: ${display}`);
            }
          }
          lines.push("");
        }

        if (confirmed.length > 0) {
          lines.push("To create a return from these documents, use crow_tax_new_return, then add each document with crow_tax_add_w2, crow_tax_add_1099, etc.");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_tax_new_return ---
  server.tool(
    "crow_tax_new_return",
    "Create a new tax return for a given year and filing status.",
    {
      tax_year: z.number().describe("Tax year (e.g. 2025)"),
      filing_status: z.enum(["single", "mfj", "mfs", "hoh", "qw"]).describe("Filing status"),
      taxpayer_name: z.string().describe("Taxpayer full name"),
      taxpayer_ssn: z.string().describe("Taxpayer SSN (9 digits)"),
      taxpayer_dob: z.string().optional().describe("Taxpayer date of birth"),
      spouse_name: z.string().optional().describe("Spouse name (required for MFJ/MFS)"),
      spouse_ssn: z.string().optional().describe("Spouse SSN"),
      spouse_dob: z.string().optional().describe("Spouse date of birth"),
    },
    async (params) => {
      const id = genReturnId();
      const taxReturn = {
        taxYear: params.tax_year,
        filingStatus: params.filing_status,
        taxpayer: { name: params.taxpayer_name, ssn: params.taxpayer_ssn, dateOfBirth: params.taxpayer_dob },
        dependents: [],
        w2s: [],
        income1099: { sa: [], int: [], div: [], nec: [], g: [], misc: [] },
        deductions: { educatorExpenses: [] },
        capitalGains: [],
        specialSituations: {},
      };
      if (params.spouse_name) {
        taxReturn.spouse = { name: params.spouse_name, ssn: params.spouse_ssn, dateOfBirth: params.spouse_dob };
      }
      await saveReturn(id, taxReturn, null, "draft");
      return { content: [{ type: "text", text: `Tax return created.\nID: ${id}\nYear: ${params.tax_year}\nFiling status: ${params.filing_status}\nStatus: draft\n\nUse crow_tax_add_w2, crow_tax_add_1099, etc. to add documents.` }] };
    }
  );

  // --- crow_tax_add_w2 ---
  server.tool(
    "crow_tax_add_w2",
    "Add a W-2 wage statement to the return.",
    {
      return_id: z.string().describe("Tax return ID"),
      employer: z.string(),
      wages: z.number().describe("Box 1: Wages"),
      federal_withheld: z.number().describe("Box 2: Federal tax withheld"),
      ss_wages: z.number().describe("Box 3: SS wages"),
      ss_tax: z.number().describe("Box 4: SS tax withheld"),
      medicare_wages: z.number().describe("Box 5: Medicare wages"),
      medicare_tax: z.number().describe("Box 6: Medicare tax withheld"),
      state_wages: z.number().optional(),
      state_withheld: z.number().optional(),
      code_12: z.array(z.object({ code: z.string(), amount: z.number() })).optional().describe("Box 12 entries (e.g. [{code:'W',amount:470.58}])"),
    },
    async (params) => {
      const ret = await loadReturn(params.return_id);
      if (!ret) return { content: [{ type: "text", text: `Return ${params.return_id} not found.` }], isError: true };

      const data = ret.data;
      data.w2s.push({
        employer: params.employer,
        wages: params.wages,
        federalWithheld: params.federal_withheld,
        ssWages: params.ss_wages,
        ssTaxWithheld: params.ss_tax,
        medicareWages: params.medicare_wages,
        medicareTaxWithheld: params.medicare_tax,
        stateWages: params.state_wages || 0,
        stateWithheld: params.state_withheld || 0,
        code12: params.code_12 || [],
        isStatutoryEmployee: false,
      });
      await saveReturn(params.return_id, data, null, "draft");

      const totalWages = data.w2s.reduce((s, w) => s + w.wages, 0);
      return { content: [{ type: "text", text: `W-2 added: ${params.employer} ($${params.wages.toFixed(2)})\nTotal W-2s: ${data.w2s.length}\nTotal wages: $${totalWages.toFixed(2)}` }] };
    }
  );

  // --- crow_tax_add_1099 ---
  server.tool(
    "crow_tax_add_1099",
    "Add a 1099 form (SA, INT, DIV, NEC, G, MISC).",
    {
      return_id: z.string(),
      type: z.enum(["SA", "INT", "DIV", "NEC", "G", "MISC"]).describe("1099 type"),
      payer: z.string(),
      // Fields vary by type — all optional, use what applies
      amount: z.number().optional().describe("Primary amount (interest, compensation, distribution, etc.)"),
      qualified_dividends: z.number().optional(),
      capital_gain_distributions: z.number().optional(),
      distribution_code: z.number().optional().describe("For 1099-SA: distribution code"),
      federal_withheld: z.number().optional(),
      unemployment: z.number().optional().describe("For 1099-G: unemployment compensation"),
    },
    async (params) => {
      const ret = await loadReturn(params.return_id);
      if (!ret) return { content: [{ type: "text", text: `Return ${params.return_id} not found.` }], isError: true };

      const data = ret.data;
      const typeKey = params.type.toLowerCase();
      const formMap = { sa: "sa", int: "int", div: "div", nec: "nec", g: "g", misc: "misc" };
      const key = formMap[typeKey];

      let entry;
      switch (typeKey) {
        case "sa":
          entry = { payer: params.payer, grossDistribution: params.amount || 0, distributionCode: params.distribution_code || 1, hsaOrMsa: "hsa" };
          break;
        case "int":
          entry = { payer: params.payer, interest: params.amount || 0, federalWithheld: params.federal_withheld || 0 };
          break;
        case "div":
          entry = { payer: params.payer, ordinaryDividends: params.amount || 0, qualifiedDividends: params.qualified_dividends || 0, capitalGainDistributions: params.capital_gain_distributions || 0, federalWithheld: params.federal_withheld || 0 };
          break;
        case "nec":
          entry = { payer: params.payer, nonemployeeCompensation: params.amount || 0, federalWithheld: params.federal_withheld || 0 };
          break;
        case "g":
          entry = { payer: params.payer, unemploymentCompensation: params.unemployment || 0, stateRefund: params.amount || 0, federalWithheld: params.federal_withheld || 0 };
          break;
        case "misc":
          entry = { payer: params.payer, otherIncome: params.amount || 0, federalWithheld: params.federal_withheld || 0 };
          break;
      }

      if (!data.income1099) data.income1099 = { sa: [], int: [], div: [], nec: [], g: [], misc: [] };
      if (!data.income1099[key]) data.income1099[key] = [];
      data.income1099[key].push(entry);
      await saveReturn(params.return_id, data, null, "draft");

      return { content: [{ type: "text", text: `1099-${params.type} added from ${params.payer}.\nAmount: $${(params.amount || 0).toFixed(2)}` }] };
    }
  );

  // --- crow_tax_add_1098 ---
  server.tool(
    "crow_tax_add_1098",
    "Add a 1098 form (E for student loan, main for mortgage).",
    {
      return_id: z.string(),
      type: z.enum(["E", "main"]).describe("1098 type: E = student loan interest, main = mortgage"),
      amount: z.number().describe("Interest amount"),
    },
    async (params) => {
      const ret = await loadReturn(params.return_id);
      if (!ret) return { content: [{ type: "text", text: `Return ${params.return_id} not found.` }], isError: true };

      const data = ret.data;
      if (!data.deductions) data.deductions = {};

      if (params.type === "E") {
        data.deductions.studentLoanInterest = (data.deductions.studentLoanInterest || 0) + params.amount;
      } else {
        data.deductions.mortgageInterest = (data.deductions.mortgageInterest || 0) + params.amount;
      }
      await saveReturn(params.return_id, data, null, "draft");

      return { content: [{ type: "text", text: `1098${params.type === "E" ? "-E" : ""} added: $${params.amount.toFixed(2)} ${params.type === "E" ? "student loan interest" : "mortgage interest"}` }] };
    }
  );

  // --- crow_tax_add_deduction ---
  server.tool(
    "crow_tax_add_deduction",
    "Add a deduction (educator expense, charitable, medical, SALT, etc.).",
    {
      return_id: z.string(),
      type: z.enum(["educator", "charitable", "medical", "salt", "ira", "other_itemized"]),
      amount: z.number(),
      // Educator-specific fields
      educator_name: z.string().optional(),
      educator_role: z.enum(["teacher", "instructor", "counselor", "principal", "aide"]).optional(),
      k12_school: z.boolean().optional(),
      hours_per_year: z.number().optional(),
    },
    async (params) => {
      const ret = await loadReturn(params.return_id);
      if (!ret) return { content: [{ type: "text", text: `Return ${params.return_id} not found.` }], isError: true };

      const data = ret.data;
      if (!data.deductions) data.deductions = {};

      switch (params.type) {
        case "educator":
          if (!data.deductions.educatorExpenses) data.deductions.educatorExpenses = [];
          data.deductions.educatorExpenses.push({
            name: params.educator_name || "Unknown",
            role: params.educator_role || "teacher",
            k12School: params.k12_school !== false,
            hoursPerYear: params.hours_per_year || 1800,
            amount: params.amount,
          });
          break;
        case "charitable":
          data.deductions.charitableDonations = (data.deductions.charitableDonations || 0) + params.amount;
          break;
        case "medical":
          data.deductions.medicalExpenses = (data.deductions.medicalExpenses || 0) + params.amount;
          break;
        case "salt":
          data.deductions.saltTaxes = (data.deductions.saltTaxes || 0) + params.amount;
          break;
        case "ira":
          data.deductions.iraContributions = (data.deductions.iraContributions || 0) + params.amount;
          break;
        case "other_itemized":
          data.deductions.otherItemized = (data.deductions.otherItemized || 0) + params.amount;
          break;
      }
      await saveReturn(params.return_id, data, null, "draft");

      return { content: [{ type: "text", text: `Deduction added: ${params.type} — $${params.amount.toFixed(2)}` }] };
    }
  );

  // --- crow_tax_add_dependent ---
  server.tool(
    "crow_tax_add_dependent",
    "Add a dependent to the return.",
    {
      return_id: z.string(),
      name: z.string(),
      ssn: z.string(),
      date_of_birth: z.string(),
      relationship: z.string(),
      months_lived: z.number().optional(),
      qualifies_ctc: z.boolean().optional().describe("Qualifies for child tax credit"),
      qualifies_eitc: z.boolean().optional().describe("Qualifies for EITC"),
    },
    async (params) => {
      const ret = await loadReturn(params.return_id);
      if (!ret) return { content: [{ type: "text", text: `Return ${params.return_id} not found.` }], isError: true };

      const data = ret.data;
      data.dependents.push({
        name: params.name,
        ssn: params.ssn,
        dateOfBirth: params.date_of_birth,
        relationship: params.relationship,
        monthsLived: params.months_lived,
        qualifiesForChildTaxCredit: params.qualifies_ctc || false,
        qualifiesForEitc: params.qualifies_eitc || false,
      });
      await saveReturn(params.return_id, data, null, "draft");

      return { content: [{ type: "text", text: `Dependent added: ${params.name} (${params.relationship})\nTotal dependents: ${data.dependents.length}` }] };
    }
  );

  // --- crow_tax_set_hsa ---
  server.tool(
    "crow_tax_set_hsa",
    "Set HSA details (coverage type, contributions, distributions).",
    {
      return_id: z.string(),
      coverage_type: z.enum(["self", "family"]),
      employer_contributions: z.number().describe("From W-2 code W (NOT deductible)"),
      personal_contributions: z.number().describe("Personal after-tax contributions (deductible)"),
      distributions: z.number().describe("From 1099-SA"),
      qualified_expenses: z.number().describe("Qualified medical expenses paid from HSA"),
      distribution_code: z.number().default(1),
      months_covered: z.number().min(1).max(12).default(12),
      catch_up_55: z.boolean().default(false),
    },
    async (params) => {
      const ret = await loadReturn(params.return_id);
      if (!ret) return { content: [{ type: "text", text: `Return ${params.return_id} not found.` }], isError: true };

      const data = ret.data;
      data.hsa = {
        coverageType: params.coverage_type,
        employerContributions: params.employer_contributions,
        personalContributions: params.personal_contributions,
        distributions: params.distributions,
        qualifiedExpenses: params.qualified_expenses,
        distributionCode: params.distribution_code,
        monthsCovered: params.months_covered,
        hadHdhpFullYear: params.months_covered === 12,
        catchUp55: params.catch_up_55,
      };
      await saveReturn(params.return_id, data, null, "draft");

      return { content: [{ type: "text", text: `HSA set: ${params.coverage_type} coverage\nEmployer (W-2 code W, NOT deductible): $${params.employer_contributions}\nPersonal (deductible): $${params.personal_contributions}\nDistributions: $${params.distributions}\nQualified expenses: $${params.qualified_expenses}` }] };
    }
  );

  // --- crow_tax_set_self_employment ---
  server.tool(
    "crow_tax_set_self_employment",
    "Add Schedule C self-employment income and expenses.",
    {
      return_id: z.string(),
      business_name: z.string().optional(),
      gross_receipts: z.number(),
      cost_of_goods_sold: z.number().default(0),
      expenses: z.object({
        advertising: z.number().default(0),
        carAndTruck: z.number().default(0),
        commissions: z.number().default(0),
        insurance: z.number().default(0),
        legalAndProfessional: z.number().default(0),
        officeExpense: z.number().default(0),
        rentOrLease: z.number().default(0),
        supplies: z.number().default(0),
        utilities: z.number().default(0),
        other: z.number().default(0),
      }).default({}),
      home_office_deduction: z.number().default(0),
    },
    async (params) => {
      const ret = await loadReturn(params.return_id);
      if (!ret) return { content: [{ type: "text", text: `Return ${params.return_id} not found.` }], isError: true };

      const data = ret.data;
      data.selfEmployment = {
        businessName: params.business_name,
        grossReceipts: params.gross_receipts,
        costOfGoodsSold: params.cost_of_goods_sold,
        expenses: params.expenses,
        homeOfficeDeduction: params.home_office_deduction,
      };
      await saveReturn(params.return_id, data, null, "draft");

      const totalExp = Object.values(params.expenses).reduce((s, v) => s + v, 0);
      const net = params.gross_receipts - params.cost_of_goods_sold - totalExp - params.home_office_deduction;
      return { content: [{ type: "text", text: `Schedule C set: ${params.business_name || "Self-employment"}\nGross receipts: $${params.gross_receipts}\nExpenses: $${totalExp}\nNet profit: $${net.toFixed(2)}` }] };
    }
  );

  // --- crow_tax_set_capital_gains ---
  server.tool(
    "crow_tax_set_capital_gains",
    "Add Schedule D capital gain/loss transactions.",
    {
      return_id: z.string(),
      transactions: z.array(z.object({
        description: z.string(),
        date_acquired: z.string().optional(),
        date_sold: z.string(),
        proceeds: z.number(),
        cost_basis: z.number(),
        is_long_term: z.boolean(),
      })),
    },
    async (params) => {
      const ret = await loadReturn(params.return_id);
      if (!ret) return { content: [{ type: "text", text: `Return ${params.return_id} not found.` }], isError: true };

      const data = ret.data;
      data.capitalGains = params.transactions.map(t => ({
        description: t.description,
        dateAcquired: t.date_acquired,
        dateSold: t.date_sold,
        proceeds: t.proceeds,
        costBasis: t.cost_basis,
        isLongTerm: t.is_long_term,
      }));
      await saveReturn(params.return_id, data, null, "draft");

      const total = params.transactions.reduce((s, t) => s + (t.proceeds - t.cost_basis), 0);
      return { content: [{ type: "text", text: `Capital gains set: ${params.transactions.length} transaction(s)\nNet gain/loss: $${total.toFixed(2)}` }] };
    }
  );

  // --- crow_tax_add_education_credit ---
  server.tool(
    "crow_tax_add_education_credit",
    "Add a 1098-T education credit (AOTC or Lifetime Learning Credit).",
    {
      return_id: z.string(),
      student_name: z.string(),
      institution: z.string(),
      tuition_paid: z.number().describe("1098-T Box 1: Qualified tuition and expenses"),
      scholarships: z.number().default(0).describe("1098-T Box 5: Scholarships or grants"),
      is_graduate: z.boolean().default(false).describe("1098-T Box 9: Graduate student"),
      is_half_time: z.boolean().default(true).describe("1098-T Box 8: At least half-time"),
      years_claimed_aotc: z.number().default(0).describe("Prior years AOTC claimed (max 4 total)"),
    },
    async (params) => {
      const ret = await loadReturn(params.return_id);
      if (!ret) return { content: [{ type: "text", text: `Return ${params.return_id} not found.` }], isError: true };

      const data = ret.data;
      if (!data.educationCredits) data.educationCredits = [];

      // Check for existing credit for same student — update instead of duplicate
      const existingIdx = data.educationCredits.findIndex(c =>
        c.studentName?.toLowerCase() === params.student_name.toLowerCase() ||
        c.institution?.toLowerCase() === params.institution.toLowerCase()
      );
      if (existingIdx >= 0) {
        data.educationCredits.splice(existingIdx, 1);
      }

      data.educationCredits.push({
        studentName: params.student_name,
        institution: params.institution,
        tuitionPaid: params.tuition_paid,
        scholarships: params.scholarships,
        isGraduate: params.is_graduate,
        isHalfTime: params.is_half_time,
        yearsClaimedAotc: params.years_claimed_aotc,
        felonyDrugConviction: false,
      });
      await saveReturn(params.return_id, data, null, "draft");

      const qualified = Math.max(0, params.tuition_paid - params.scholarships);
      const creditType = params.is_graduate ? "Lifetime Learning Credit" : "American Opportunity Credit";
      return { content: [{ type: "text", text: `Education credit added: ${params.student_name} at ${params.institution}\nQualified expenses: $${qualified.toFixed(2)} ($${params.tuition_paid} tuition - $${params.scholarships} scholarships)\nCredit type: ${creditType}` }] };
    }
  );

  // --- crow_tax_set_special ---
  server.tool(
    "crow_tax_set_special",
    "Set special situations (6013(h) election, age, blindness).",
    {
      return_id: z.string(),
      nonresident_spouse_election: z.boolean().optional(),
      spouse_green_card_date: z.string().optional(),
      blind_taxpayer: z.boolean().optional(),
      blind_spouse: z.boolean().optional(),
      over_65_taxpayer: z.boolean().optional(),
      over_65_spouse: z.boolean().optional(),
    },
    async (params) => {
      const ret = await loadReturn(params.return_id);
      if (!ret) return { content: [{ type: "text", text: `Return ${params.return_id} not found.` }], isError: true };

      const data = ret.data;
      data.specialSituations = {
        nonresidentSpouseElection: params.nonresident_spouse_election || false,
        spouseGreenCardDate: params.spouse_green_card_date,
        blindTaxpayer: params.blind_taxpayer || false,
        blindSpouse: params.blind_spouse || false,
        over65Taxpayer: params.over_65_taxpayer || false,
        over65Spouse: params.over_65_spouse || false,
      };
      await saveReturn(params.return_id, data, null, "draft");

      const flags = [];
      if (params.nonresident_spouse_election) flags.push("6013(h) election");
      if (params.over_65_taxpayer) flags.push("taxpayer 65+");
      if (params.over_65_spouse) flags.push("spouse 65+");
      return { content: [{ type: "text", text: `Special situations updated: ${flags.join(", ") || "none"}` }] };
    }
  );

  // --- crow_tax_calculate ---
  server.tool(
    "crow_tax_calculate",
    "Run the full tax calculation and return a summary with audit trail.",
    {
      return_id: z.string(),
    },
    async (params) => {
      const ret = await loadReturn(params.return_id);
      if (!ret) return { content: [{ type: "text", text: `Return ${params.return_id} not found.` }], isError: true };

      const { result, forms, warnings, errors } = processReturn(ret.data);

      if (!result) {
        return { content: [{ type: "text", text: `Calculation failed:\n${errors.join("\n")}` }], isError: true };
      }

      await saveReturn(params.return_id, ret.data, result, errors.length > 0 ? "draft" : "calculated");

      const lines = [
        `=== Tax Return Summary (${result.taxYear} ${result.filingStatus.toUpperCase()}) ===`,
        ``,
        `Income:`,
        `  Wages:              $${result.income.totalWages.toFixed(2)}`,
        `  Interest:           $${result.income.taxableInterest.toFixed(2)}`,
        `  Dividends:          $${result.income.ordinaryDividends.toFixed(2)}`,
        `  Capital gains:      $${result.income.netCapitalGain.toFixed(2)}`,
        `  Other:              $${result.income.otherIncomeSchedule1.toFixed(2)}`,
        `  Total income:       $${result.income.totalIncome.toFixed(2)}`,
        ``,
        `Adjustments:          $${result.adjustments.totalAdjustments.toFixed(2)}`,
        `AGI:                  $${result.agi.toFixed(2)}`,
        `Deduction:            $${result.deduction.chosen.toFixed(2)} (${result.deduction.usesItemized ? "itemized" : "standard"})`,
        `Taxable income:       $${result.taxableIncome.toFixed(2)}`,
        ``,
        `Tax:                  $${result.tax.bracketTax.toFixed(2)}`,
        result.tax.seTax > 0 ? `  SE tax:             $${result.tax.seTax.toFixed(2)}` : null,
        `Credits:              $${result.credits.totalCredits.toFixed(2)}`,
        `Total tax:            $${result.result.totalTax.toFixed(2)}`,
        ``,
        `Payments:             $${result.payments.totalPayments.toFixed(2)}`,
        result.result.refundOrOwed >= 0
          ? `REFUND:               $${result.result.refundOrOwed.toFixed(2)}`
          : `AMOUNT OWED:          $${Math.abs(result.result.refundOrOwed).toFixed(2)}`,
        ``,
        `Required forms: ${Object.keys(forms).join(", ")}`,
      ].filter(Boolean);

      if (warnings.length > 0) {
        lines.push(``, `Warnings:`, ...warnings.map(w => `  - ${w}`));
      }
      if (errors.length > 0) {
        lines.push(``, `Errors:`, ...errors.map(e => `  - ${e}`));
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // --- crow_tax_get_form ---
  server.tool(
    "crow_tax_get_form",
    "Get line-by-line values for a specific form.",
    {
      return_id: z.string(),
      form: z.string().describe("Form ID: f1040, schedule1, scheduleC, scheduleD, scheduleSE, f8889, f8812"),
    },
    async (params) => {
      const ret = await loadReturn(params.return_id);
      if (!ret) return { content: [{ type: "text", text: `Return ${params.return_id} not found.` }], isError: true };
      if (!ret.result) return { content: [{ type: "text", text: "Return not yet calculated. Run crow_tax_calculate first." }], isError: true };

      const lines = getFormLines(params.form, ret.result, ret.data);
      if (lines.error) return { content: [{ type: "text", text: lines.error }], isError: true };

      const formatted = Object.entries(lines)
        .filter(([_, v]) => v !== 0 && v !== "" && v != null)
        .map(([k, v]) => `  Line ${k}: ${typeof v === "number" ? `$${v.toFixed(2)}` : v}`)
        .join("\n");

      return { content: [{ type: "text", text: `${params.form} — Line Values:\n\n${formatted || "(all lines are $0)"}` }] };
    }
  );

  // --- crow_tax_validate ---
  server.tool(
    "crow_tax_validate",
    "Check the return for errors and warnings.",
    {
      return_id: z.string(),
    },
    async (params) => {
      const ret = await loadReturn(params.return_id);
      if (!ret) return { content: [{ type: "text", text: `Return ${params.return_id} not found.` }], isError: true };

      const { result, warnings, errors } = processReturn(ret.data);
      const lines = [];

      if (errors.length > 0) {
        lines.push(`Errors (${errors.length}):`, ...errors.map(e => `  - ${e}`));
      } else {
        lines.push("No errors found.");
      }

      if (warnings.length > 0) {
        lines.push(``, `Warnings (${warnings.length}):`, ...warnings.map(w => `  - ${w}`));
      }

      if (result) {
        lines.push(``, `Audit trail (${result.workPapers.length} entries):`);
        for (const wp of result.workPapers.slice(0, 10)) {
          lines.push(`  ${wp.line}: $${typeof wp.value === "number" ? wp.value.toFixed(2) : wp.value} — ${wp.explanation}`);
        }
        if (result.workPapers.length > 10) {
          lines.push(`  ... and ${result.workPapers.length - 10} more`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // --- crow_tax_generate_pdfs ---
  server.tool(
    "crow_tax_generate_pdfs",
    "Fill IRS PDF forms and generate a summary document.",
    {
      return_id: z.string(),
      output_dir: z.string().optional().describe("Output directory (defaults to pdf/output/)"),
    },
    async (params) => {
      const ret = await loadReturn(params.return_id);
      if (!ret) return { content: [{ type: "text", text: `Return ${params.return_id} not found.` }], isError: true };
      if (!ret.result) return { content: [{ type: "text", text: "Return not yet calculated. Run crow_tax_calculate first." }], isError: true };

      try {
        const { fillForms } = await import("../pdf/fill-forms.js");
        const { generateSummary } = await import("../pdf/generate-summary.js");
        const { resolve, dirname } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const thisDir = dirname(fileURLToPath(import.meta.url));
        const outputDir = params.output_dir || resolve(thisDir, "../pdf/output");

        const filled = await fillForms(ret.result, ret.data, outputDir);
        const summaryPath = await generateSummary(ret.result, ret.data, outputDir);

        const files = [...filled, summaryPath].filter(Boolean);
        return { content: [{ type: "text", text: `PDFs generated in ${outputDir}:\n${files.map(f => `  - ${f}`).join("\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `PDF generation failed: ${err.message}\n\nMake sure IRS PDF templates are in pdf/templates/. Run pdf/discover-fields.js to inspect field names.` }], isError: true };
      }
    }
  );

  // --- crow_tax_filing_guide ---
  server.tool(
    "crow_tax_filing_guide",
    "Generate step-by-step filing instructions for IRS Free File Fillable Forms.",
    {
      return_id: z.string(),
    },
    async (params) => {
      const ret = await loadReturn(params.return_id);
      if (!ret) return { content: [{ type: "text", text: `Return ${params.return_id} not found.` }], isError: true };
      if (!ret.result) return { content: [{ type: "text", text: "Return not yet calculated. Run crow_tax_calculate first." }], isError: true };

      const result = ret.result;
      const needed = requiredForms(result, ret.data);

      const guide = [
        "=== Filing Guide: IRS Free File Fillable Forms ===",
        "",
        "Go to: https://www.freefilefillableforms.com",
        "",
        "IMPORTANT: Fill forms in dependency order (bottom-up):",
        "  Supporting forms FIRST, then Form 1040 LAST.",
        "",
        "Form fill order:",
      ];

      // Dependency order: supporting forms first, 1040 last
      const order = needed.filter(f => f !== "f1040").concat(["f1040"]);
      order.forEach((formId, i) => {
        guide.push(`  ${i + 1}. ${formId}`);
      });

      guide.push(
        "",
        "For each form:",
        "  1. Select the form from the left panel",
        "  2. Enter values from crow_tax_get_form output",
        "  3. Click 'Do the Math' button (CRITICAL — validates calculations)",
        "  4. Review for any error messages",
        "",
        "After all forms are filled:",
        "  1. Review the complete return",
        "  2. Sign electronically",
        "  3. Submit",
        "",
        `Expected result: ${result.result.refundOrOwed >= 0 ? `REFUND of $${result.result.refundOrOwed.toFixed(2)}` : `OWE $${Math.abs(result.result.refundOrOwed).toFixed(2)}`}`,
      );

      if (ret.data.specialSituations?.nonresidentSpouseElection) {
        guide.push(
          "",
          "SPECIAL: Section 6013(h) Election",
          "  Attach a signed statement choosing to be treated as resident.",
          "  FFFF does not support attachments — you may need to mail this.",
        );
      }

      return { content: [{ type: "text", text: guide.join("\n") }] };
    }
  );

  // --- crow_tax_ingest_document ---
  server.tool(
    "crow_tax_ingest_document",
    "Read a tax document PDF (W-2, 1099, 1098-T) and extract data. Returns extracted values with confidence scores. Low-confidence fields MUST be confirmed with the user before adding to the return.",
    {
      file_path: z.string().describe("Absolute path to the PDF file"),
      document_type: z.enum(["w2", "1099-sa", "1099-int", "1099-div", "1099-nec", "1099-g", "1099-misc", "1098-t"])
        .describe("Type of tax document"),
      return_id: z.string().optional().describe("If provided, auto-add to this return after user confirms"),
    },
    async (params) => {
      try {
        const { ingestDocument } = await import("../engine/ingest/index.js");
        const result = await ingestDocument(params.file_path, params.document_type);

        const lines = [
          `=== Document Ingested: ${params.document_type.toUpperCase()} ===`,
          `File: ${params.file_path}`,
          `Method: ${result.method}`,
          ``,
          `Extracted Data:`,
          ...Object.entries(result.data)
            .filter(([_, v]) => v !== "" && v !== 0 && v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
            .map(([k, v]) => {
              const conf = result.confidence[k];
              const confStr = conf ? ` (confidence: ${Math.round(conf * 100)}%)` : "";
              const val = typeof v === "number" ? `$${v.toFixed(2)}` : JSON.stringify(v);
              return `  ${k}: ${val}${confStr}`;
            }),
        ];

        if (result.low_confidence_fields.length > 0) {
          lines.push(
            ``,
            `LOW CONFIDENCE — Please verify these fields with the user:`,
            ...result.low_confidence_fields.map(f => `  ${f.field}: ${f.score}% confidence`),
          );
        }

        if (result.warnings.length > 0) {
          lines.push(``, `Warnings:`, ...result.warnings.map(w => `  - ${w}`));
        }

        if (params.return_id) {
          lines.push(
            ``,
            `Return ID: ${params.return_id}`,
            `To add this data, confirm the values above then use the appropriate crow_tax_add_* tool.`,
            `DO NOT auto-add without user confirmation of low-confidence fields.`,
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Ingestion failed: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_tax_purge_return ---
  server.tool(
    "crow_tax_purge_return",
    "Securely delete tax return data after filing. This is irreversible.",
    {
      return_id: z.string(),
      confirm: z.boolean().describe("Set to true to confirm deletion"),
    },
    async (params) => {
      if (!params.confirm) {
        return { content: [{ type: "text", text: `This will permanently delete all data for return ${params.return_id}. Call again with confirm: true to proceed.` }] };
      }

      const ret = await loadReturn(params.return_id);
      if (!ret) return { content: [{ type: "text", text: `Return ${params.return_id} not found.` }], isError: true };

      // Overwrite with zeros before deleting
      const zeros = "0".repeat(1000);
      await db.execute({
        sql: "UPDATE tax_returns SET data = ?, result = ?, status = 'purged', updated_at = datetime('now') WHERE id = ?",
        args: [zeros, zeros, params.return_id],
      });
      await db.execute({
        sql: "DELETE FROM tax_returns WHERE id = ?",
        args: [params.return_id],
      });

      return { content: [{ type: "text", text: `Return ${params.return_id} securely deleted.` }] };
    }
  );

  // --- Prompt ---
  server.prompt(
    "tax-guide",
    "Tax filing workflow guide",
    async () => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Crow Tax Filing Guide

1. Create return — crow_tax_new_return (year, filing status, names, SSNs)
2. Add W-2s — crow_tax_add_w2 (one per employer)
3. Add 1099s — crow_tax_add_1099 (SA for HSA, INT, DIV, NEC, G, MISC)
4. Add 1098s — crow_tax_add_1098 (E for student loans, main for mortgage)
5. Add deductions — crow_tax_add_deduction (educator, charitable, medical, SALT)
6. Add dependents — crow_tax_add_dependent (if applicable)
7. Set HSA — crow_tax_set_hsa (coverage type, contributions, distributions)
8. Set SE income — crow_tax_set_self_employment (if applicable)
9. Set capital gains — crow_tax_set_capital_gains (if applicable)
10. Set special — crow_tax_set_special (6013(h), age 65+, blind)
11. Validate — crow_tax_validate (check for errors)
12. Calculate — crow_tax_calculate (run full computation)
13. Get forms — crow_tax_get_form (line-by-line values per form)
14. Generate PDFs — crow_tax_generate_pdfs (fill IRS forms)
15. Filing guide — crow_tax_filing_guide (step-by-step FFFF instructions)
16. Purge — crow_tax_purge_return (after filing, securely delete data)

CRITICAL RULES:
- HSA employer contributions (W-2 code W) are NOT deductible
- Educator expense requires K-12, 900+ hours
- Fill forms in dependency order (supporting forms first, 1040 last)
- Always click "Do the Math" in Fillable Forms`,
        },
      }],
    })
  );

  return server;
}
