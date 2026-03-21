---
title: Tax Filing Assistant
---

# Tax Filing Assistant

Prepare federal income taxes with document ingestion, automated calculation, PDF generation, and guided filing through IRS Free File Fillable Forms.

## What You Get

- **20 MCP tools** for tax return management
- **PDF document extraction** — upload W-2, 1099, 1098 PDFs and Crow reads the values
- **Tax calculation engine** — 2024 and 2025 federal tax tables
- **Dashboard panel** — upload, verify, and manage tax documents
- **Filled IRS PDFs** — generates completed 1040, Schedule 1, Form 8889, Form 8863
- **FFFF filing support** — step-by-step guided filing via Free File Fillable Forms

## Installation

1. Open the **Extensions** page in your Crow's Nest dashboard
2. Find **Tax Filing Assistant** and click **Install**
3. Enter an encryption key when prompted (this encrypts PII at rest)
4. The gateway restarts automatically — the Tax Filing panel appears in the sidebar

## Document Upload

Go to **Tax Filing → Documents** in the sidebar.

### Uploading

1. Select the document type (W-2, 1099-SA, 1098-T, etc.)
2. Select the owner: **Taxpayer**, **Spouse**, or **Joint**
3. Choose the PDF file and click **Upload & Extract**

Crow extracts values automatically using a dual extraction pipeline:
- **Structural parser** — for W-2s with concatenated text (e.g., Austin ISD format)
- **Positional parser** — for PDFs where values are in separate text layers (e.g., ILTexas format)

The system tries both methods and picks the one that extracts the most fields.

### Verifying

After upload, each document shows an editable form with the extracted values. Fields with low confidence are highlighted in orange.

**Always verify extracted values against your actual document before confirming.** PDF extraction is not perfect — some fields may be wrong or missing.

For W-2s, the form shows:
- Employee name and SSN (used to auto-fill the tax return)
- All box values (1-6, 16-17)
- EIN and employer name

### Managing Documents

- **Confirm Values** — saves the verified data
- **Edit** — reverts a confirmed document back to editable
- **Delete** — removes the document (with confirmation dialog)

## Supported Document Types

| Type | What It Extracts |
|------|-----------------|
| **W-2** | Wages, withholding, SS/Medicare, employer, EIN, employee name/SSN, Box 12 codes |
| **1099-SA** | HSA distributions, distribution code, payer |
| **1098-T** | Tuition paid, scholarships, institution, student name, graduate/half-time status |
| **1098-E** | Student loan interest, lender |
| **1098** | Mortgage interest |
| **1099-INT/DIV/NEC/G/MISC** | Various income types |

## Preparing a Return

### Via BYOAI Chat

The simplest way — tell your AI assistant:

> "Prepare my tax return. Filing jointly, 2025."

Crow's `crow_tax_prepare_from_documents` tool creates the return in one call:
- Adds all confirmed W-2s, 1099s, 1098s
- Auto-fills taxpayer and spouse names/SSNs from W-2 documents
- Auto-configures HSA from W-2 code W + 1099-SA data
- Calculates the return

The AI will then ask clarifying questions:
- **Program type** — undergraduate, graduate, professional, or trade (affects education credit)
- **Educator expenses** — who is the educator and how much
- **HSA coverage** — self or family
- **Special situations** — 6013(h) election for nonresident spouse

### Via MCP Tools Directly

For Claude Code or other MCP clients, use the tools in sequence:

```
crow_tax_new_return → crow_tax_add_w2 → crow_tax_add_1099 →
crow_tax_add_1098 → crow_tax_set_hsa → crow_tax_add_education_credit →
crow_tax_add_deduction → crow_tax_calculate → crow_tax_generate_pdfs
```

## MCP Tools Reference

| Tool | Description |
|------|-------------|
| `crow_tax_prepare_from_documents` | One-shot: create return from all confirmed documents |
| `crow_tax_get_documents` | List uploaded/confirmed documents |
| `crow_tax_new_return` | Create a new return |
| `crow_tax_add_w2` | Add a W-2 |
| `crow_tax_add_1099` | Add a 1099 (SA, INT, DIV, NEC, G, MISC) |
| `crow_tax_add_1098` | Add a 1098 (E for student loan, main for mortgage) |
| `crow_tax_add_deduction` | Add deductions (educator, charitable, medical, SALT, IRA) |
| `crow_tax_add_dependent` | Add a dependent |
| `crow_tax_set_hsa` | Configure HSA details |
| `crow_tax_set_self_employment` | Add Schedule C income |
| `crow_tax_set_capital_gains` | Add Schedule D transactions |
| `crow_tax_add_education_credit` | Add 1098-T education credit (AOTC or LLC) |
| `crow_tax_set_special` | Set 6013(h) election, age 65+, blindness |
| `crow_tax_calculate` | Run full calculation with audit trail |
| `crow_tax_validate` | Check for errors and warnings |
| `crow_tax_get_form` | Get line-by-line values for a specific form |
| `crow_tax_generate_pdfs` | Fill IRS PDF forms |
| `crow_tax_filing_guide` | Generate FFFF filing instructions |
| `crow_tax_ingest_document` | Read a PDF and extract data |
| `crow_tax_purge_return` | Securely delete return data |

## Education Credits

The system supports two education credits:

| Credit | Eligibility | Max Credit | Refundable |
|--------|------------|------------|------------|
| **AOTC** (American Opportunity) | Undergraduate, first 4 years | $2,500 | 40% ($1,000) |
| **LLC** (Lifetime Learning) | Any post-secondary (graduate, trade, professional) | $2,000 | No |

The credit type is determined by the program type, not just Box 9 on the 1098-T. The AI will ask what type of program you're enrolled in.

## Security

- **PII is encrypted at rest** using AES-256-GCM with a user-provided passphrase
- **SSNs are extracted from documents** and stored encrypted — never sent to the AI in plain text
- **Document PDFs** are stored locally in `~/.crow/tax-documents/` (not uploaded to cloud)
- **The AI never sees your SSN** — the compound tool auto-fills it from encrypted storage

## Limitations

- **Federal returns only** — no state income tax
- **Not a substitute for professional tax advice**
- **PDF extraction may be inaccurate** — always verify extracted values
- **2024 and 2025 tax years** supported
