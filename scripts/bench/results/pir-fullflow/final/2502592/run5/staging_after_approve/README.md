# PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data (2020-25)

**Recipient:** Texas Education Agency (PIR@tea.texas.gov)
**Filed:** 2026-01-30 | **Due:** 2026-02-13 | **Received:** 2026-06-05
**SQ3:** Yes | **Priority:** HIGH

## Requested Items

| Item | Status |
|------|--------|
| PREGNANT_CTE_STUDENTS (2020-25) | Delivered — 5 CSV files, 4742 rows total |
| SINGLEPAR_CTE_STUDENTS (2020-25) | Delivered — included in all CSVs |
| ELIG_PREG_REL_SVCS_DAYS (2020-25) | Delivered — included in all CSVs |
| E1012 PEP-INDICATOR-CODE (2020-25) | No responsive — TEA previously confirmed field deleted in 2012 |

## Dataset Inventory

| Table | Source File | Year | Rows |
|-------|-------------|------|------|
| research_pir2502592_PRU_11507_21 | PRU_11507_21.csv | 2020-2021 | 1043 |
| research_pir2502592_PRU_11507_22 | PRU_11507_22.csv | 2021-2022 | 1070 |
| research_pir2502592_PRU_11507_23 | PRU_11507_23.csv | 2022-2023 | 1069 |
| research_pir2502592_PRU_11507_24 | PRU_11507_24.csv | 2023-2024 | 1063 |
| research_pir2502592_PRU_11507_25 | PRU_11507_25.csv | 2024-2025 | 497 |
| **Total** | | | **4742** |

## Column Schema (all 5 tables)

YEAR, DISTRICT, DISTNAME, PREGNANT_CTE_STUDENTS, SINGLEPAR_CTE_STUDENTS, ELIG_PREG_REL_SVCS_DAYS

## Quality Flags

- **FERPA masking:** Counts below 10 are replaced with `-999` across PREGNANT_CTE_STUDENTS and SINGLEPAR_CTE_STUDENTS columns.
- **Partial release for 2024-25:** Only 497 rows (vs ~1000+ in prior years), suggesting a partial or incomplete dataset for the most recent year.
- **Consistent structure:** All 5 CSVs share identical column schemas.

## Data Notes

- This data was previously loaded to tea_data.db under table `research_pregnancy_services` (4742 rows) on 2026-02-26 via `scripts/load_tea_pir_pregnancy.py`. The current load creates new tables named `research_pir2502592_PRU_11507_21` through `25` using the PIR number in the table name per staging convention.
- TEA originally released this data at no charge on 2026-02-26. The PIR was marked closed at that time. This re-ingest appears to be a re-processing of the same attachments.
