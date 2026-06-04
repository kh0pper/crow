# PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data

**Recipient:** Texas Education Agency (PIR@tea.texas.gov)
**Filed:** 2026-01-29 | **Received:** 2026-02-26 | **Response Due:** 2026-02-13
**SQ3:** Yes | **Priority:** HIGH

## Summary

TEA released 5 CSV files containing district-level PEIMS data for pregnancy/parenting CTE students and related services, covering school years 2020-21 through 2024-25. Delivered at no charge.

## Dataset Inventory

| File | School Year | Data Rows | Size |
|------|-------------|-----------|------|
| PRU_11507_21.csv | 2020-2021 | 1,043 | 45,200 B |
| PRU_11507_22.csv | 2021-2022 | 1,070 | 46,488 B |
| PRU_11507_23.csv | 2022-2023 | 1,069 | 46,234 B |
| PRU_11507_24.csv | 2023-2024 | 1,063 | 45,916 B |
| PRU_11507_25.csv | 2024-2025 | 497 | 22,048 B |
| **Total** | | **4,742** | |

## Columns (all CSVs share identical structure)

| Column | Description |
|--------|-------------|
| YEAR | School year (e.g., 2020-2021) |
| DISTRICT | 6-digit TEA district ID |
| DISTNAME | District name |
| PREGNANT_CTE_STUDENTS | Count of pregnant CTE students |
| SINGLEPAR_CTE_STUDENTS | Count of single-parent CTE students |
| ELIG_PREG_REL_SVCS_DAYS | Eligible pregnancy-related services days |

## Cross-Reference with Requested Items

| Requested Item | Status | Notes |
|----------------|--------|-------|
| PREGNANT_CTE_STUDENTS (2020-25) | **Delivered** | All 5 years |
| SINGLEPAR_CTE_STUDENTS (2020-25) | **Delivered** | All 5 years |
| ELIG_PREG_REL_SVCS_DAYS (2020-25) | **Delivered** | All 5 years |
| E1012 PEP-INDICATOR-CODE | **No responsive** | Deleted in 2012 (TEA noted) |

## Quality Flags

- **FERPA Masking:** Counts below 10 are replaced with -999. Convert to NULL on load.
- **PRU_11507_25.csv (2024-25):** Only 497 districts vs ~1,070 for other years. Likely interim or partial data — 2024-25 may not be finalized.
- **Consistent schema:** All 5 CSVs share identical 6-column structure.
- **No gaps:** All 5 requested school years are covered.

## Correspondence

- **2026-01-29:** Original PIR filed.
- **2026-02-02:** TEA extended fulfillment to 2026-04-02.
- **2026-02-11:** Follow-up filed as PIR #2502803 (years 2016-17 through 2019-20).
- **2026-02-26:** TEA released 5 CSVs at no charge. PIR closed.
- **Contact:** Jenny Eaton, pir@tea.texas.gov

## Staging Files

- `source_inventory.json` — Full file inventory with cross-references
- `loader.py` — Python loader with --dry-run and --commit modes
- `row_counts.json` — Verified row counts per table (from dry-run)
- `claims.json` — Verified entity/record tallies
