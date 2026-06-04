# PIR #2502592 - Gateway Review

**Recipient:** Texas Education Agency (PIR@tea.texas.gov)
**Description:** District-level PEIMS data: PREGNANT_CTE_STUDENTS, SINGLEPAR_CTE_STUDENTS, ELIG_PREG_REL_SVCS_DAYS
**Years:** 2020-21 through 2024-25
**Status:** Data received and staged

## Cross-Reference Table

| Requested Item | Status | Notes |
|---------------|--------|-------|
| E1012 PEP-INDICATOR-CODE | No responsive records | TEA confirmed PEP_ATTEND deleted in 2012 |
| E0829 SGL-PARENT-PREG-TEEN-CODE (SINGLEPAR_CTE_STUDENTS) | Delivered | Included in all 5 CSV files |
| E0939 TOTAL-ELIG-PREG-REL-SVCS-DAYS-PRESENT | Delivered | Included in all 5 CSV files |

## Dataset Inventory

| Table | Source File | Rows | School Year |
|-------|-------------|------|-------------|
| research_pir2502592_2020_21 | PRU_11507_21.csv | 1,043 | 2020-21 |
| research_pir2502592_2021_22 | PRU_11507_22.csv | 1,070 | 2021-22 |
| research_pir2502592_2022_23 | PRU_11507_23.csv | 1,069 | 2022-23 |
| research_pir2502592_2023_24 | PRU_11507_24.csv | 1,063 | 2023-24 |
| research_pir2502592_2024_25 | PRU_11507_25.csv | 497 | 2024-25 (partial) |
| **Total** | | **4,742** | |

## Quality Notes

- FERPA masking applied: counts less than 10 replaced with -999, converted to NULL during load
- 2024-25 partial year (497 rows vs ~1,070 for full years)
- Data aggregated at district level, no student-level records
- All 5 years delivered at no charge

## Draft Acknowledgment to TEA

```
Dear Texas Education Agency Public Information Office,

I acknowledge receipt of your response to PIR #2502592, including the five CSV files containing district-level PEIMS data for Pregnancy Related Services covering school years 2020-21 through 2024-25. Thank you for providing the data at no charge.

I note that E1012 PEP-INDICATOR-CODE is not responsive as the field was deleted in 2012. The data delivered covers the two remaining requested elements: SINGLEPAR_CTE_STUDENTS and ELIG_PREG_REL_SVCS_DAYS.

I have a follow-up request filed separately (PIR #2502803) for years 2016-17 through 2019-20, which is due April 15, 2026.

Thank you for your assistance.

Sincerely,
Kevin Hopper
kevin.hopper1@gmail.com
```

## Staging Files

- [README.md](http://100.118.41.122:8080/api/pir/staging/2502592/README.md)
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502592/loader.py)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502592/source_inventory.json)
- [draft_acknowledgment.txt](http://100.118.41.122:8080/api/pir/staging/2502592/draft_acknowledgment.txt)
- [row_counts.json](http://100.118.41.122:8080/api/pir/staging/2502592/row_counts.json)

## Instructions

Reply **APPROVE** to commit the data load and create the draft reply.
Reply **REVISE** <your feedback> to adjust.
Reply **REJECT** to cancel processing.
