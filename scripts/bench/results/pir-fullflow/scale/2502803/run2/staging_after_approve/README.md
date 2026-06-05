# PIR #2502803 — TEA Pregnancy/Parenting CTE PEIMS Data (2016-17 to 2019-20)

**PIR ID:** 42
**Recipient:** Texas Education Agency
**Description:** Follow-up to PIR #2502592. District-level PEIMS data for PREGNANT_CTE_STUDENTS, SINGLEPAR_CTE_STUDENTS, ELIG_PREG_REL_SVCS_DAYS across school years 2016-17 through 2019-20.

## Dataset Inventory

| File | School Year | Table | Rows |
|------|-------------|-------|------|
| PRU_11576_17.csv | 2016-2017 | research_pir2502803_pregnant_cte_20162017 | 1,087 |
| PRU_11576_18.csv | 2017-2018 | research_pir2502803_pregnant_cte_20172018 | 1,092 |
| PRU_11576_19.csv | 2018-2019 | research_pir2502803_pregnant_cte_20182019 | 1,095 |
| PRU_11576_20.csv | 2019-2020 | research_pir2502803_pregnant_cte_20192020 | 1,100 |
| **Total** | | | **4,374** |

## Columns

All CSV files share identical schema:
- `YEAR` — School year (e.g., "2016-2017")
- `DISTRICT` — TEA district ID (6-digit)
- `DISTNAME` — District name
- `PREGNANT_CTE_STUDENTS` — Count of pregnant students in CTE programs
- `SINGLEPAR_CTE_STUDENTS` — Count of single-parent students in CTE programs
- `ELIG_PREG_REL_SVCS_DAYS` — Eligible pregnancy-related services days

## Quality Flags

- **FERPA Masking:** Values of -999 indicate counts below FERPA threshold (typically <10).
  - PREGNANT_CTE_STUDENTS: 953 of 4,374 rows masked (21.8%)
  - SINGLEPAR_CTE_STUDENTS: 1,071 of 4,374 rows masked (24.5%)
  - ELIG_PREG_REL_SVCS_DAYS: 0 masked (100% unmasked)
- **Data Completeness:** No null or empty values found in any column.
- **Consistency:** All 4 files share identical column structure and row counts.

## Notes

- Data source: TEA PEIMS (Public Education Information Management System)
- This PIR is a follow-up to PIR #2502592, covering the earlier period (2016-17 through 2019-20).
- The 2020-21 through 2024-25 data is handled under PIR #2502592.
- Note: data source changed in 2020-21 (Fall to Summer submission).
- All -999 values are converted to NULL during loading.

## Files

- `source_inventory.json` — Full file inventory with metadata
- `loader.py` — Python loader with `--dry-run` and `--commit` modes
- `row_counts.json` — Row counts per table (from dry run)
- `claims.json` — Verified row tallies
