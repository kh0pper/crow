# PIR #2502803 — Staging Review

## Summary

TEA has delivered 4 CSV files covering PEIMS data for school years 2016-17 through 2019-20. Total: 4,374 rows across 4 tables. Data includes counts of pregnant CTE students, single-parent CTE students, and eligible pregnancy-related services days for Texas school districts.

## Cross-Reference Table

| Request Item | Status |
|-------------|--------|
| PREGNANT_CTE_STUDENTS (2016-17 to 2019-20) | ✅ Delivered |
| SINGLEPAR_CTE_STUDENTS (2016-17 to 2019-20) | ✅ Delivered |
| ELIG_PREG_REL_SVCS_DAYS (2016-17 to 2019-20) | ✅ Delivered |

## Dataset Inventory

| File | School Year | Table | Rows |
|------|-------------|-------|------|
| PRU_11576_17.csv | 2016-2017 | research_pir2502803_pregnant_cte_20162017 | 1,087 |
| PRU_11576_18.csv | 2017-2018 | research_pir2502803_pregnant_cte_20172018 | 1,092 |
| PRU_11576_19.csv | 2018-2019 | research_pir2502803_pregnant_cte_20182019 | 1,095 |
| PRU_11576_20.csv | 2019-2020 | research_pir2502803_pregnant_cte_20192020 | 1,100 |
| **Total** | | | **4,374** |

## Quality Flags

- **FERPA Masking:** 953 of 4,374 pregnant CTE counts masked (-999 → NULL), 21.8%
- **FERPA Masking:** 1,071 of 4,374 single-parent CTE counts masked (-999 → NULL), 24.5%
- **FERPA Masking:** 0 of 4,374 services days masked (100% complete)
- **Data Completeness:** No null or empty values found in any column
- **Schema Consistency:** All 4 files share identical column structure

## Data Notes

- Data source: TEA PEIMS (Public Education Information Management System)
- This PIR covers 2016-17 through 2019-20. The later period (2020-21 to 2024-25) is handled under PIR #2502592.
- Data source changed in 2020-21 (Fall submission to Summer submission).
- Cross-reference with campus ARC factors is not applicable — this is district-level PEIMS data, not campus-level.

## Draft Reply to Entity

Jenny Eaton,

Thank you for sending the PEIMS data files for PIR #2502803. I confirm receipt of all four CSV files covering school years 2016-17 through 2019-20, along with the correspondence emails.

The records cover district-level counts for pregnant CTE students, single-parent CTE students, and eligible pregnancy-related services days across all Texas school districts in the requested years.

I appreciate your prompt response. If you need any clarification regarding this request, please do not hesitate to reach out.

Kevin Hopper
kevin.hopper1@gmail.com

## Staging Files

- [README.md](http://100.118.41.122:8080/api/pir/staging/2502803/README.md)
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502803/loader.py)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502803/source_inventory.json)
- [row_counts.json](http://100.118.41.122:8080/api/pir/staging/2502803/row_counts.json)
- [draft_acknowledgment.txt](http://100.118.41.122:8080/api/pir/staging/2502803/draft_acknowledgment.txt)

## Instructions

Reply **APPROVE** to commit the data load and create the draft reply.
Reply **REVISE** with feedback to adjust.
Reply **REJECT** to cancel processing.
