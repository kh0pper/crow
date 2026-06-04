# PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data

**Recipient:** Texas Education Agency (PIR@tea.texas.gov)  
**Filed:** 2026-01-30 | **Received:** 2026-02-26 | **Response due:** 2026-02-13 (extended)  
**Contact:** Jenny Eaton (pir@tea.texas.gov)  
**Priority:** HIGH | **Sub-question 3:** Yes

## Summary

TEA delivered 5 CSV files covering district-level Pregnancy/Parenting CTE and PEIMS data for school years 2020-21 through 2024-25. Delivered at no charge. E1012 PEP_ATTEND was not responsive (deleted from PEIMS in 2012).

## Data Inventory

| File | Year | Rows | Source |
|------|------|------|--------|
| PRU_11507_21.csv | 2020-2021 | 1043 | TEA PIR attachment |
| PRU_11507_22.csv | 2021-2022 | 1070 | TEA PIR attachment |
| PRU_11507_23.csv | 2022-2023 | 1069 | TEA PIR attachment |
| PRU_11507_24.csv | 2023-2024 | 1063 | TEA PIR attachment |
| PRU_11507_25.csv | 2024-2025 | 497 | TEA PIR attachment |
| **Total** | **5 years** | **4742** | |

## Requested Items vs. Delivery Status

| Requested Field | Status |
|-----------------|--------|
| PREGNANT_CTE_STUDENTS | ✅ Delivered — all 5 years |
| SINGLEPAR_CTE_STUDENTS | ✅ Delivered — all 5 years |
| ELIG_PREG_REL_SVCS_DAYS | ✅ Delivered — all 5 years |
| E1012 PEP-INDICATOR-CODE | ❌ No responsive — deleted in 2012 |

## Schema (per table)

```
YEAR              TEXT    — School year (e.g. "2020-2021")
DISTRICT          TEXT    — 6-digit TEA district code
DISTNAME          TEXT    — District name
PREGNANT_CTE_STUDENTS     INTEGER  — Count of pregnant CTE students (-999 → NULL)
SINGLEPAR_CTE_STUDENTS    INTEGER  — Count of single-parent CTE students (-999 → NULL)
ELIG_PREG_REL_SVCS_DAYS   REAL     — Eligible pregnancy-related services days (-999 → NULL)
```

## Quality Flags

- **FERPA masking:** Counts < 10 are reported as -999 in source data. Loader converts -999 to NULL on import.
- **2024-2025 partial year:** Only 497 rows vs. ~1050 in other years. This reflects the most recent school year and likely has incomplete district reporting.
- **All columns present** in every CSV. Consistent schema across all 5 files.
- **No missing data** beyond FERPA masking (-999).

## Database Tables

| Table | Source File | Rows |
|-------|-------------|------|
| research_pir2502592_2020_2021 | PRU_11507_21.csv | 1043 |
| research_pir2502592_2021_2022 | PRU_11507_22.csv | 1070 |
| research_pir2502592_2022_2023 | PRU_11507_23.csv | 1069 |
| research_pir2502592_2023_2024 | PRU_11507_24.csv | 1063 |
| research_pir2502592_2024_2025 | PRU_11507_25.csv | 497 |

**Total: 4742 rows across 5 tables.**

## Notes

- This PIR was filed Jan 29, 2026. TEA extended fulfillment to April 2, 2026.
- A follow-up PIR (#2502803) was filed Feb 11, 2026 for years 2016-17 through 2019-20 (due April 15, 2026).
- Combined with PIR #2502803 data, the full dataset spans 2016-17 through 2024-25.
