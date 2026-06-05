# PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data

## Summary
Texas Education Agency response to PIR #2502592, requesting district-level PEIMS data on pregnancy-related CTE services. TEA released 5 CSV files covering school years 2020-21 through 2024-25 at no charge.

## Data Fields
- **YEAR** — School year (e.g., 2020-2021)
- **DISTRICT** — TEA district ID (6 digits)
- **DISTNAME** — District name
- **PREGNANT_CTE_STUDENTS** — Count of pregnant CTE students
- **SINGLEPAR_CTE_STUDENTS** — Count of single-parent CTE students
- **ELIG_PREG_REL_SVCS_DAYS** — Eligible pregnancy-related services days

## Files Delivered

| File | Year | Rows | Size |
|------|------|------|------|
| PRU_11507_21.csv | 2020-2021 | 1043 | 44.1 KB |
| PRU_11507_22.csv | 2021-2022 | 1070 | 45.4 KB |
| PRU_11507_23.csv | 2022-2023 | 1069 | 45.2 KB |
| PRU_11507_24.csv | 2023-2024 | 1063 | 44.8 KB |
| PRU_11507_25.csv | 2024-2025 | 497 | 21.5 KB |
| **Total** | | **4742** | |

## Quality Notes
- **FERPA masking**: Counts under 10 are replaced with `-999` per TEA policy.
- **Year 2024-2025**: Only 497 rows (vs ~1050-1070 for prior years), suggesting partial data or fewer districts reporting.
- **E1012 PEP_INDICATOR_CODE**: Not delivered — TEA confirmed this field was deleted in 2012 (no responsive records).
- **Cover emails**: 2 .eml files received (PRU cover letter + transmittal email).

## Cross-Reference
- **PIR #2502803** (filed 2026-02-11): Follow-up request for years 2016-17 through 2019-20. Due April 15, 2026.
- **Previous load**: 4742 rows committed to `research_pregnancy_services` on 2026-02-26 via `scripts/load_tea_pir_pregnancy.py`.
- This re-run loads the same dataset under table naming convention `research_pir<pir_number>_<dataset>` for audit traceability.
