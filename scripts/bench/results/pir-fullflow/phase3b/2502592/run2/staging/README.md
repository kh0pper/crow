# PIR #2502592 — Texas Education Agency, Pregnancy/Parenting PEIMS Data

**Received:** 2026-02-26
**Source:** Texas Education Agency (PIR@tea.texas.gov)
**Contact:** Jenny Eaton
**Requested:** District-level PEIMS data for PREGNANT_CTE_STUDENTS, SINGLEPAR_CTE_STUDENTS, ELIG_PREG_REL_SVCS_DAYS for years 2020-21 through 2024-25. Also requested E1012 PEP-INDICATOR-CODE (deleted in 2012, no responsive records).

## Delivery Summary

TEA released 5 CSV files covering all 5 requested years at no charge. The E1012 PEP-INDICATOR-CODE item was noted as deleted in 2012 with no responsive records.

## Dataset Inventory

| File | Year | Rows |
|------|------|------|
| PRU_11507_21.csv | 2020-2021 | 1,043 |
| PRU_11507_22.csv | 2021-2022 | 1,070 |
| PRU_11507_23.csv | 2022-2023 | 1,069 |
| PRU_11507_24.csv | 2023-2024 | 1,063 |
| PRU_11507_25.csv | 2024-2025 | 497 |
| **Total** | | **4,742** |

## Columns

All CSVs share the same schema:
- `YEAR` — School year
- `DISTRICT` — TEA district ID
- `DISTNAME` — District name
- `PREGNANT_CTE_STUDENTS` — Count of CTE students who are pregnant
- `SINGLEPAR_CTE_STUDENTS` — Count of CTE students who are single parents
- `ELIG_PREG_REL_SVCS_DAYS` — Eligible pregnancy-related services days (REAL)

## Data Quality Notes

- **FERPA masking:** Values of -999 in the source CSVs represent counts below the FERPA threshold of 10. These were converted to NULL during loading.
- **Total masked cells:** 3,020 NULL values across the 3 numeric columns (pregnant_cte_students, singlepar_cte_students, elig_preg_rel_svcs_days) in the combined dataset of 9,116 rows.
- **District count:** Each year covers all Texas public school districts (~1,043-1,100 districts per year).
- **2024-2025 partial:** Only 497 districts reported for 2024-2025 (earlier years have 1,043-1,100 districts), consistent with mid-year PEIMS reporting.
- **E1012 PEP-INDICATOR-CODE:** No responsive records — TEA confirmed this element was deleted from PEIMS in 2012.

## Cross-Reference to Requested Items

| Item | Status |
|------|--------|
| PREGNANT_CTE_STUDENTS (2020-25) | Delivered — 4,742 rows |
| SINGLEPAR_CTE_STUDENTS (2020-25) | Delivered — 4,742 rows |
| ELIG_PREG_REL_SVCS_DAYS (2020-25) | Delivered — 4,742 rows |
| E1012 PEP-INDICATOR-CODE (2020-25) | No Responsive — deleted in 2012 |

## DB Table

`research_pregnancy_services` — rows from this PIR (2020-25): 4,742
Combined with PIR #2502803 (2016-17 through 2019-20): 4,374 additional rows
Grand total in table: 9,116 rows

## Correspondence

- **Jan 29, 2026:** Original PIR filed
- **Feb 2, 2026:** TEA extended fulfillment to 2026-04-02
- **Feb 26, 2026:** TEA released PIR #2502592, 5 CSV files, at no charge
