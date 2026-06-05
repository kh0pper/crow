# PIR #2502803 — TEA Pregnancy/Parenting PEIMS Data (2016-20)

## Overview
District-level PEIMS data for pregnant and single-parent CTE students in Texas, years 2016-17 through 2019-20.

**Recipient:** Texas Education Agency (PIR@tea.texas.gov)  
**Filed:** 2026-02-11 | **Due:** 2026-02-26 | **Received:** 2026-03-23  
**Sub-question:** SQ3  

## Requested Items — Status
| Item | Status | Notes |
|------|--------|-------|
| PREGNANT_CTE_STUDENTS by district, 2016-20 | Delivered | 4 CSV files, 4374 total rows |
| SINGLEPAR_CTE_STUDENTS by district, 2016-20 | Delivered | Included in same files |
| ELIG_PREG_REL_SVCS_DAYS by district, 2016-20 | Delivered | Included in same files |
| Years 2016-17 through 2019-20 | Delivered | 2020-21 through 2024-25 under PIR #2502592 |

## Dataset Inventory
| File | Year | Rows | Size |
|------|------|------|------|
| PRU_11576_17.csv | 2016-2017 | 1087 | 46.1 KB |
| PRU_11576_18.csv | 2017-2018 | 1092 | 46.2 KB |
| PRU_11576_19.csv | 2018-2019 | 1095 | 46.2 KB |
| PRU_11576_20.csv | 2019-2020 | 1100 | 46.4 KB |
| **Total** | | **4374** | |

## Columns
YEAR, DISTRICT, DISTNAME, PREGNANT_CTE_STUDENTS, SINGLEPAR_CTE_STUDENTS, ELIG_PREG_REL_SVCS_DAYS

## Quality Flags
- **FERPA masking:** Counts fewer than 10 replaced with -999 in PREGNANT_CTE_STUDENTS and SINGLEPAR_CTE_STUDENTS columns. Days column shows no masking.
  - 2016-17: 268 masked pregnant, 284 masked single-parent
  - 2017-18: 240 masked pregnant, 291 masked single-parent
  - 2018-19: 223 masked pregnant, 250 masked single-parent
  - 2019-20: 222 masked pregnant, 246 masked single-parent
  - Total masked: 953 pregnant, 1071 single-parent
- **Consistency:** All files share identical column structure. District codes are 6-digit. District name count increases slightly each year (1087 → 1100), consistent with new districts entering PEIMS reporting.
- **No data gaps:** All 4 school years delivered. No partial or missing years.
- **Correspondence:** 3 EML files are duplicates of an amendment letter extending the date range from 2020-21 through 2024-25 to 2016-17 through 2024-25 under PIR #2502592. Not substantive responses.

## Notes
- Data source changed in 2020-21 from Fall to Summer submission. This PIR covers pre-change years.
- Masking rule: counts < 10 replaced with -999 per FERPA.
- This PIR (2016-17 through 2019-20) complements PIR #2502592 which covers 2020-21 through 2024-25. Together they provide a full 2016-17 through 2024-25 series.
