# PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data (2020-25)

**Recipient:** Texas Education Agency (PIR@tea.texas.gov)
**Filed:** 2026-01-30 | **Response Due:** 2026-02-13 | **Received:** 2026-06-04
**Sub-question:** SQ3

## Summary

TEA released 5 CSV files containing district-level PEIMS data for pregnancy/parenting CTE students and eligible pregnancy-related services days, covering school years 2020-21 through 2024-25. Total: 4,742 rows across 5 tables (one per year).

## Dataset Inventory

| File | Table | Rows | Year | Masked (-999) |
|------|-------|------|------|---------------|
| PRU_11507_21.csv | research_pir2502592_21 | 1,043 | 2020-21 | 385 |
| PRU_11507_22.csv | research_pir2502592_22 | 1,070 | 2021-22 | 344 |
| PRU_11507_23.csv | research_pir2502592_23 | 1,069 | 2022-23 | 299 |
| PRU_11507_24.csv | research_pir2502592_24 | 1,063 | 2023-24 | 295 |
| PRU_11507_25.csv | research_pir2502592_25 | 497 | 2024-25 | 203 |
| **Total** | | **4,742** | | **1,526** |

## Columns

| Column | Type | Notes |
|--------|------|-------|
| YEAR | string | e.g. "2020-2021" |
| DISTRICT | string | 6-digit TEA district ID |
| DISTNAME | string | District name |
| PREGNANT_CTE_STUDENTS | int | Count; -999 = masked (<10) |
| SINGLEPAR_CTE_STUDENTS | int | Count; -999 = masked (<10) |
| ELIG_PREG_REL_SVCS_DAYS | float | Days; decimal values possible |

## Quality Flags

- **FERPA masking:** 1,526 of 4,742 rows (32.2%) contain at least one -999 value. Masking rate is highest in earlier years (2020-21: 36.9%) and lowest in 2024-25 (40.8%).
- **Year 2024-25 partial:** Only 497 rows (vs 1,000+ in prior years) because this is the current school year with partial reporting.
- **Data completeness:** All 5 files have the same 6-column schema. No structural anomalies detected.
- **Cover emails:** Two .eml attachments present (cover correspondence from TEA).

## Loading

Run `loader.py --dry-run` to preview row counts. Run `loader.py --commit` to write to tea_data.db.
