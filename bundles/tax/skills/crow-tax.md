---
name: crow-tax
description: "Tax preparation — document collection, calculation, PDF generation, filing guidance. Activates for tax, 1040, W-2, refund, filing, IRS, deduction topics."
allowed-tools: ["crow_tax_new_return", "crow_tax_add_w2", "crow_tax_add_1099", "crow_tax_add_1098", "crow_tax_add_deduction", "crow_tax_add_dependent", "crow_tax_set_hsa", "crow_tax_set_self_employment", "crow_tax_set_capital_gains", "crow_tax_add_education_credit", "crow_tax_set_special", "crow_tax_calculate", "crow_tax_get_form", "crow_tax_generate_pdfs", "crow_tax_filing_guide", "crow_tax_validate", "crow_tax_purge_return"]
---

# Crow Tax Filing Assistant

Federal income tax preparation — from document collection to filled IRS PDF forms.

## Workflow

### Phase 1: Document Collection
Gather all tax documents before starting data entry:
- **W-2s** — one per employer (wages, withholding, SS/Medicare)
- **1099-SA** — HSA distributions
- **1099-INT** — interest income
- **1099-DIV** — dividends
- **1099-NEC** — freelance/contract income
- **1099-G** — unemployment, state refunds
- **1098-E** — student loan interest
- **1098** — mortgage interest

### Phase 2: Data Entry
Use MCP tools to enter all documents:
1. `crow_tax_new_return` — create return with year, filing status, names, SSNs
2. `crow_tax_add_w2` — add each W-2
3. `crow_tax_add_1099` — add each 1099 (specify type: SA, INT, DIV, NEC, G, MISC)
4. `crow_tax_add_1098` — add student loan (E) or mortgage (main) interest
5. `crow_tax_add_deduction` — educator expenses, charitable, medical, SALT, IRA
6. `crow_tax_add_dependent` — if applicable
7. `crow_tax_set_hsa` — if HSA account exists
8. `crow_tax_set_self_employment` — if Schedule C income
9. `crow_tax_set_capital_gains` — if investment sales
10. `crow_tax_add_education_credit` — 1098-T for AOTC or Lifetime Learning Credit
11. `crow_tax_set_special` — 6013(h) election, age 65+, blindness

### Phase 3: Calculate & Review
1. `crow_tax_validate` — check for errors before calculating
2. `crow_tax_calculate` — run full computation, review summary
3. `crow_tax_get_form` — inspect individual form line values
4. Verify against source documents

### Phase 4: Generate Output
1. `crow_tax_generate_pdfs` — fill official IRS PDF forms
2. `crow_tax_filing_guide` — step-by-step Free File Fillable Forms instructions

### Phase 5: Post-Filing
1. `crow_tax_purge_return` — securely delete PII after filing confirmation

## Critical Rules

### HSA (Form 8889)
- Employer contributions from **W-2 code W are NOT deductible** — already excluded from Box 1
- Only **personal after-tax contributions** are deductible on Form 8889 line 13
- Form 8889 line 15 (qualified expenses) is entered manually, not auto-calculated
- Form 8889 must be filled BEFORE Schedule 1 and Form 1040

### Educator Expenses
- Must be K-12 school (not higher ed)
- Must work 900+ hours per year
- Roles: teacher, instructor, counselor, principal, aide
- Maximum $300 per qualifying educator

### Student Loan Interest
- Maximum deduction: $2,500
- Phases out above AGI threshold (MFJ: $165K-$195K)
- Not available for MFS filing status

### Form Fill Order (Free File Fillable Forms)
Fill forms bottom-up — supporting forms FIRST:
1. Form 8889 (HSA)
2. Schedule C (self-employment)
3. Schedule D (capital gains)
4. Schedule SE (self-employment tax)
5. Schedule 8812 (child tax credit)
6. Schedule 1 (adjustments + other income)
7. Form 1040 (LAST)

Always click **"Do the Math"** after entering each form.

### Section 6013(h) Election
For dual-status alien spouse (nonresident → resident mid-year):
- Both spouses' worldwide income reported
- Requires signed statement attached to return
- FFFF doesn't support attachments — may need to mail

## 2025 Tax Year Reference

| Item | Value |
|------|-------|
| Standard deduction (MFJ) | $30,000 |
| Standard deduction (Single) | $15,000 |
| HSA limit (self) | $4,300 |
| HSA limit (family) | $8,750 |
| SS wage base | $176,100 |
| Student loan interest max | $2,500 |
| Educator expense max | $300/educator |
| Child tax credit | $2,000/child |
| Additional CTC (refundable) | $1,700/child |

## Supported Forms
- Form 1040 (comprehensive)
- Schedule 1 (adjustments + other income)
- Schedule C (self-employment)
- Schedule D (capital gains/losses)
- Schedule SE (self-employment tax)
- Form 8889 (HSA)
- Schedule 8812 (child tax credit)
- Form 8863 (education credits — AOTC + Lifetime Learning)

## Not Supported (consult a professional)
- State income tax returns
- Form 1040-X (amendments)
- Form 6251 (AMT)
- Foreign income/credits
- Rental income (Schedule E)
- Farm income (Schedule F)

## Common Mistakes to Avoid
1. Double-deducting HSA employer contributions (W-2 code W)
2. Claiming educator expense for non-K-12 or <900 hours
3. Filling Form 1040 before supporting schedules
4. Forgetting "Do the Math" button in FFFF
5. Using wrong form fill order
6. Not attaching 6013(h) statement for dual-status spouse
