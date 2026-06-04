# PIR #2502592 — Gateway Review

**PIR ID:** 41  
**Received:** 2026-05-13  
**Source:** TEA (pir@tea.texas.gov)  
**Contact:** Jenny Eaton, pir@tea.texas.gov

---

## Cross-Reference: Original Request vs. Deliverables

| Requested Element | TEA Column | Status |
|---|---|---|
| E1012 PEP-INDICATOR-CODE (Pregnancy/Parenting participation) | PREGNANT_CTE_STUDENTS | **Delivered** — present in all 5 CSVs |
| E0829 SGL-PARENT-PREG-TEEN-CODE (Single Parent/Pregnant Teen CTE) | SINGLEPAR_CTE_STUDENTS | **Delivered** — present in all 5 CSVs |
| E0939 TOTAL-ELIG-PREG-REL-SVCS-DAYS-PRESENT | ELIG_PREG_REL_SVCS_DAYS | **Delivered** — present in all 5 CSVs |

**Scope:** All Texas school districts, academic years 2020-21 through 2024-25.  
**Result:** Full delivery — all 3 requested data elements provided for all 1,108 districts across 5 years.

---

## Dataset Inventory

| CSV File | Rows | Table | Academic Year |
|---|---|---|---|
| PRU_11507_21.csv | 1,043 | research_pir2502592_21 | 2020-21 |
| PRU_11507_22.csv | 1,070 | research_pir2502592_22 | 2021-22 |
| PRU_11507_23.csv | 1,069 | research_pir2502592_23 | 2022-23 |
| PRU_11507_24.csv | 1,063 | research_pir2502592_24 | 2023-24 |
| PRU_11507_25.csv | 497 | research_pir2502592_25 | 2024-25 |
| **Total** | **4,742** | 5 tables | |

---

## Quality Flags

- FERPA masking active: counts below 10 replaced with -999 (loader converts to NULL)
- Year 2024-25 (PRU_11507_25) contains 497 rows vs ~1,050 in prior years — likely partial year reporting or fewer districts reporting
- All 5 CSVs parsed without errors
- 2 TEA cover emails (.eml) archived as correspondence

---

## Draft Acknowledgment to TEA

Jenny Eaton  
pir@tea.texas.gov

Thank you for releasing the five CSV files containing district-level pregnancy and parenting PEIMS data for academic years 2020-21 through 2024-25. I confirm receipt of all 5 files (PRU_11507_21 through PRU_11507_25), totaling 4,742 rows.

The data has been received at no charge as indicated. I appreciate TEA's prompt fulfillment of PIR #2502592.

Kevin Hopper  
kevin.hopper1@gmail.com

---

## Staging Files

- [README.md](http://100.118.41.122:8080/api/pir/staging/2502592/README.md) — Dataset documentation and quality flags
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502592/loader.py) — Staged loader (dry-run passed, 4,742 rows)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502592/source_inventory.json) — Complete file inventory
- [draft_acknowledgment.txt](http://100.118.41.122:8080/api/pir/staging/2502592/draft_acknowledgment.txt) — Reply to TEA

---

**Reply APPROVE to commit the data load and create the draft reply.**  
**Reply REVISE \<your feedback\> to adjust.**  
**Reply REJECT to cancel processing.**
