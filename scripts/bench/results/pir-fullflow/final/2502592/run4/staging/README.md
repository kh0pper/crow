# PIR #2502592 — District-Level Pregnancy Related Services Data (PEIMS)

**Recipient:** Texas Education Agency (TEA)
**Received:** 2026-05-13
**Processed:** 2026-06-05

## Dataset Summary

TEA produced 5 CSV files containing district-level CTE (Career and Technical Education) student data from PEIMS, covering pregnant CTE students, single-parent CTE students, and eligible pregnancy-related services days.

| File | Rows | Columns |
|------|------|---------|
| PRU_11507_21.csv | 1,043 | YEAR, DISTRICT, DISTNAME, PREGNANT_CTE_STUDENTS, SINGLEPAR_CTE_STUDENTS, ELIG_PREG_REL_SVCS_DAYS |
| PRU_11507_22.csv | 1,070 | same as above |
| PRU_11507_23.csv | 1,069 | same as above |
| PRU_11507_24.csv | 1,063 | same as above |
| PRU_11507_25.csv | 497 | same as above |
| **Total** | **4,742** | 6 columns per file |

## Quality Flags

- **FERPA masking:** Values of -999 indicate masked data and should be treated as NULL.
- **Consistent schema:** All 5 files share identical column structure.
- **No data-file attachments:** Only CSV data files and .eml correspondence copies.

## Correspondence

Two .eml files received alongside the data — the original PIR submission and TEA's response cover email. No substantive data narrative was found in the email body.
