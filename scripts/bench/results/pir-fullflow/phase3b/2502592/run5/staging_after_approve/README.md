# PIR #2502592 — TEA Pregnancy Related Services PEIMS Data

## Summary

Texas Education Agency delivered district-level PEIMS data for Pregnancy Related Services, covering 5 school years (2020-21 through 2024-25). The data contains aggregated counts for 3 data elements across all Texas school districts, totaling 4,742 district-year records.

## Data Elements Delivered

The following elements were provided:

| PEIMS Element | Name | Description |
|---|---|---|
| E0829 | SGL-PARENT-PREG-TEEN-CODE | Single Parent / Pregnant Teen indicator for CTE students |
| E0939 | TOTAL-ELIG-PREG-REL-SVCS-DAYS-PRESENT | Total days present while eligible for pregnancy related services |
| E1012 | PEP-INDICATOR-CODE | Pregnancy, Education, and Parenting program participation indicator |

**Note:** TEA confirmed E1012 (PEP_ATTEND) was deleted from PEIMS in 2012. No responsive records exist for this element. The delivered data contains E0829 and E0939.

## Dataset Inventory

| File | School Year | Rows | Size |
|---|---|---|---|
| PRU_11507_21.csv | 2020-2021 | 1,043 | 44.1 KB |
| PRU_11507_22.csv | 2021-2022 | 1,070 | 45.4 KB |
| PRU_11507_23.csv | 2022-2023 | 1,069 | 45.2 KB |
| PRU_11507_24.csv | 2023-2024 | 1,063 | 44.8 KB |
| PRU_11507_25.csv | 2024-2025 | 497 | 21.5 KB |
| **TOTAL** | | **4,742** | |

The 2024-2025 file has fewer records (497 vs 1,043-1,070) because it is a partial school year (data as of file date, not full year).

## Quality Flags

- **FERPA masking:** Counts below 10 are replaced with -999 in the delivered data. The loader converts -999 to NULL.
- **Partial year data:** The 2024-2025 file (497 rows) represents a partial year snapshot, not a full school year. This is expected for the most recent year.
- **All files consistent:** Column structure is identical across all 5 CSVs: YEAR, DISTRICT, DISTNAME, PREGNANT_CTE_STUDENTS, SINGLEPAR_CTE_STUDENTS, ELIG_PREG_REL_SVCS_DAYS.
- **No missing districts:** Each year covers a large number of districts. Year counts (1,043–1,070) are consistent with the total number of Texas school districts.

## Cross-Reference Against Requested Items

| Requested Item | Status |
|---|---|
| E1012 PEP-INDICATOR-CODE | **No Docs** — TEA confirmed element deleted in 2012 |
| E0829 SGL-PARENT-PREG-TEEN-CODE | **Delivered** — Present in all 5 CSVs as PREGNANT_CTE_STUDENTS |
| E0939 TOTAL-ELIG-PREG-REL-SVCS-DAYS-PRESENT | **Delivered** — Present in all 5 CSVs as ELIG_PREG_REL_SVCS_DAYS |
| Scope: All Texas districts | **Delivered** — District-level aggregated data |
| Scope: 2020-21 through 2024-25 | **Delivered** — 5 CSV files, one per school year |
| Format: CSV or Excel | **Delivered** — CSV format |

## DB Table

Table name: `research_pir2502592_pregnancy_services`

Schema:
- `YEAR` TEXT
- `DISTRICT` TEXT
- `DISTNAME` TEXT
- `PREGNANT_CTE_STUDENTS` INTEGER (NULL for -999 masked)
- `SINGLEPAR_CTE_STUDENTS` INTEGER (NULL for -999 masked)
- `ELIG_PREG_REL_SVCS_DAYS` REAL (NULL for -999 masked)

## Loading

Run `python3 loader.py --commit` to load into tea_data.db. Use `--dry-run` to preview counts.
