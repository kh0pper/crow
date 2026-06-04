# PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data

**Recipient:** Texas Education Agency (PIR@tea.texas.gov)  
**Contact:** Jenny Eaton (pir@tea.texas.gov)  
**PIR Number:** 2502592  
**Filed:** 2026-01-29  
**Response Received:** 2026-06-04  
**Status:** Delivery — 5 CSV files, 4,742 total rows

## Requested Items vs Delivered

| Item | Status |
|------|--------|
| PREGNANT_CTE_STUDENTS (2020-25) | **Delivered** |
| SINGLEPAR_CTE_STUDENTS (2020-25) | **Delivered** |
| ELIG_PREG_REL_SVCS_DAYS (2020-25) | **Delivered** |
| E1012 PEP-INDICATOR-CODE (2020-25) | **No responsive records** — TEA notes PEP_ATTEND deleted in 2012 |

## Dataset Inventory

| CSV File | Table | Year | Rows |
|----------|-------|------|------|
| PRU_11507_21.csv | research_pir2502592_2020_2021 | 2020-2021 | 1,043 |
| PRU_11507_22.csv | research_pir2502592_2021_2022 | 2021-2022 | 1,070 |
| PRU_11507_23.csv | research_pir2502592_2022_2023 | 2022-2023 | 1,069 |
| PRU_11507_24.csv | research_pir2502592_2023_2024 | 2023-2024 | 1,063 |
| PRU_11507_25.csv | research_pir2502592_2024_2025 | 2024-2025 | 497 |
| **Total** | | | **4,742** |

## Data Quality Notes

- **FERPA Masking:** Counts below 10 are replaced with -999 in the raw data. The loader converts these to NULL on import.
- **Columns per table:** YEAR, DISTRICT, DISTNAME, PREGNANT_CTE_STUDENTS, SINGLEPAR_CTE_STUDENTS, ELIG_PREG_REL_SVCS_DAYS (all TEXT)
- **2024-2025** row count (497) is notably lower than prior years (~1,050-1,070) — possibly reflects partial year reporting or districts added later.
- All 5 CSV files delivered at no charge by TEA.
- Corresponding extended request (PIR #2502803) covers years 2016-17 through 2019-20.

## Loader

`loader.py` supports `--dry-run` (print counts) and `--commit` (insert into tea_data.db).
Duplicate guard prevents re-loading if tables already contain rows.

## Cross-reference: PIR #2502803

PIR #2502803 (filed 2026-02-11) requests the same fields for years 2016-17 through 2019-20, completing the 2016-17 through 2024-25 coverage. When both datasets load, the combined table `research_pregnancy_services` will contain data from 9 school years.
