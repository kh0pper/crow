# PIR #2502592 — District-Level Pregnancy Related Services Data (PEIMS)

**Entity:** Texas Education Agency (TEA)  
**Contact:** pir@tea.texas.gov (Jenny Eaton)  
**Received:** 2026-05-13  
**Staged:** 2026-06-05

## Summary

TEA released 5 CSV files containing district-level PEIMS data on pregnancy-related CTE (Career and Technical Education) students and eligible pregnancy-related services days, covering school years 2020-21 through 2024-25. All 5 CSV files were delivered at no charge.

## Dataset Inventory

| File | Table | Year | Rows |
|------|-------|------|------|
| PRU_11507_21.csv | research_pir2502592_PRU_11507_21 | 2020-2021 | 1043 |
| PRU_11507_22.csv | research_pir2502592_PRU_11507_22 | 2021-2022 | 1070 |
| PRU_11507_23.csv | research_pir2502592_PRU_11507_23 | 2022-2023 | 1069 |
| PRU_11507_24.csv | research_pir2502592_PRU_11507_24 | 2023-2024 | 1063 |
| PRU_11507_25.csv | research_pir2502592_PRU_11507_25 | 2024-2025 | 497 |
| **Total** | | | **4742** |

## Columns (all files identical schema)

- `YEAR` — School year (e.g., "2020-2021")
- `DISTRICT` — 5-digit TEA district ID
- `DISTNAME` — District name
- `PREGNANT_CTE_STUDENTS` — Count of pregnant CTE students
- `SINGLEPAR_CTE_STUDENTS` — Count of single-parent CTE students
- `ELIG_PREG_REL_SVCS_DAYS` — Eligible pregnancy-related services days (decimal)

## Data Quality Flags

### FERPA Masking
Counts below 10 are replaced with -999 per FERPA masking rules.

| Column | Total Masked | Mask % |
|--------|-------------|--------|
| PREGNANT_CTE_STUDENTS | 978 | 20.6% |
| SINGLEPAR_CTE_STUDENTS | 1059 | 22.3% |
| ELIG_PREG_REL_SVCS_DAYS | 0 | 0.0% |

### Year Coverage
- 2020-21: 1043 rows (all districts)
- 2021-22: 1070 rows (all districts)
- 2022-23: 1069 rows (all districts)
- 2023-24: 1063 rows (all districts)
- 2024-25: 497 rows (partial — school year not yet complete)

### Unique Districts
1108 unique districts across all 5 files.

## Notes

- This PIR was previously processed and committed (Feb 2026). Re-staged on 2026-06-05 for verification.
- The original request also had a follow-up (PIR #2502803) for years 2016-17 through 2019-20, due April 15, 2026.
- E1012 PEP_ATTEND was noted as deleted in 2012 — partial no-docs for that item.
