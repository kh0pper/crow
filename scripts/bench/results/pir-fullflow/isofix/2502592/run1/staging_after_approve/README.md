# PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data

**Recipient:** Texas Education Agency (PIR@tea.texas.gov)  
**Filed:** 2026-01-30 | **Response Due:** 2026-02-13 | **Received:** 2026-02-26  
**Sub-question:** SQ3 (pregnancy/parenting services data)  
**Priority:** HIGH

## Request Summary

District-level PEIMS data elements related to Pregnancy, Education, and Parenting (PEP) program participation:

| PEIMS Element | Description | Status |
|---|---|---|
| E0829 (SINGLEPAR_CTE_STUDENTS) | Single Parent / Pregnant Teen indicator for CTE students | **Delivered** |
| E0939 (PREGNANT_CTE_STUDENTS) | Pregnant teen CTE student count | **Delivered** |
| ELIG_PREG_REL_SVCS_DAYS | Eligible pregnancy-related services days | **Delivered** |
| E1012 (PEP-INDICATOR-CODE) | PEP participation indicator | **No responsive (deleted 2012)** |

## Dataset Inventory

| File | School Year | Rows | Size |
|---|---|---|---|
| PRU_11507_21.csv | 2020-2021 | 1,043 | 45.2 KB |
| PRU_11507_22.csv | 2021-2022 | 1,070 | 46.5 KB |
| PRU_11507_23.csv | 2022-2023 | 1,069 | 46.2 KB |
| PRU_11507_24.csv | 2023-2024 | 1,063 | 45.9 KB |
| PRU_11507_25.csv | 2024-2025 | 497 | 22.0 KB |
| **Total** | | **4,742** | |

## Schema (all CSVs share identical structure)

| Column | Type | Description |
|---|---|---|
| YEAR | text | School year (e.g., "2020-2021") |
| DISTRICT | text | 6-digit TEA district ID |
| DISTNAME | text | District name |
| PREGNANT_CTE_STUDENTS | integer | Count of pregnant CTE students |
| SINGLEPAR_CTE_STUDENTS | integer | Count of single-parent CTE students |
| ELIG_PREG_REL_SVCS_DAYS | float | Eligible pregnancy-related services days |

## Quality Flags

- **FERPA masking:** Counts below 10 are replaced with `-999`. These must be treated as NULL in analysis.
- **2024-2025 partial:** The 2024-25 file (497 rows) contains significantly fewer districts than prior years (1,063-1,070). This is consistent with PEIMS data being finalized later in the school year and may not include all districts yet.
- **Consistent columns:** All 5 files share the same 6 columns in the same order. No structural mismatches detected.
- **No missing years:** Covers the full requested range (2020-21 through 2024-25).

## Correspondence

- **2026-01-29:** Original PIR filed via email to TEA.
- **2026-02-02:** TEA extended fulfillment deadline to 2026-04-02.
- **2026-02-11:** Follow-up filed as PIR #2502803 (years 2016-17 through 2019-20).
- **2026-02-26:** TEA released 5 CSV files at no charge. PIR closed.
- **2026-05-13:** Attachments downloaded and staged.

## Related PIRs

- **PIR #2502803** (follow-up): Requests data for 2016-17 through 2019-20 school years. Due 2026-04-15.

## Loader

Run `python3 loader.py --dry-run` to preview, `--commit` to load into `tea_data.db`.
