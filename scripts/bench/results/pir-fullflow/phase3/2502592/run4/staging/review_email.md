# PIR #2502592 — Review

**Recipient:** Texas Education Agency (PIR@tea.texas.gov)  
**Request:** District-level PEIMS data for Pregnancy Related Services (E1012, E0829, E0939)  
**Scope:** All Texas school districts, 2020-21 through 2024-25  

## Cross-Reference: Requested Items vs. Delivery

| Requested Element | Status | Notes |
|---|---|---|
| E1012 (PEP-INDICATOR-CODE) | **Delivered** | Column PREGNANT_CTE_STUDENTS in CSV. Note: TEA previously noted E1012 PEP_ATTEND was deleted in 2012, but the current delivery includes PREGNANT_CTE_STUDENTS which maps to the broader E1012 category. |
| E0829 (SGL-PARENT-PREG-TEEN-CODE) | **Delivered** | Column SINGLEPAR_CTE_STUDENTS in CSV. |
| E0939 (TOTAL-ELIG-PREG-REL-SVCS-DAYS-PRESENT) | **Delivered** | Column ELIG_PREG_REL_SVCS_DAYS in CSV. |
| Years 2020-21 through 2024-25 | **Delivered** | All 5 school years provided. |
| All Texas school districts | **Delivered** | District-level aggregated counts only, no student-level records. |

## Dataset Inventory

| Table | CSV File | Rows | School Year |
|---|---|---|---|
| research_pir2502592_2020_2021 | PRU_11507_21.csv | 1,043 | 2020-2021 |
| research_pir2502592_2021_2022 | PRU_11507_22.csv | 1,070 | 2021-2022 |
| research_pir2502592_2022_2023 | PRU_11507_23.csv | 1,069 | 2022-2023 |
| research_pir2502592_2023_2024 | PRU_11507_24.csv | 1,063 | 2023-2024 |
| research_pir2502592_2024_2025 | PRU_11507_25.csv | 497 | 2024-2025 |
| **Total** | | **4,742** | |

## Quality Notes

- **FERPA masking:** -999 values replaced with NULL by loader. Counts <10 suppressed.
- **2024-25 anomaly:** Only 497 rows vs 1,043–1,070 in prior years. May indicate partial data or reporting only districts with non-zero values in at least one category. Flag for verification before analysis.
- **No structural issues:** Consistent 6-column schema across all 5 files.
- **Previously loaded:** This data was committed in an earlier session. The loader includes a duplicate guard and will skip tables that already contain data.

## Draft Acknowledgment to TEA

[Preview the draft acknowledgment](http://100.118.41.122:8080/api/pir/staging/2502592/draft_acknowledgment.txt)

## Staging Files

- [README.md](http://100.118.41.122:8080/api/pir/staging/2502592/README.md)
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502592/loader.py)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502592/source_inventory.json)

---

**Reply APPROVE** to commit the data load and create the draft reply.  
**Reply REVISE \<your feedback\>** to adjust.  
**Reply REJECT** to cancel processing.
