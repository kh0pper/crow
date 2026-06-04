# PIR #2502592 — Gateway Review

**TEA Pregnancy/Parenting PEIMS Data (2020-25)**

---

## Cross-Reference Table

| Requested Item | Status |
|----------------|--------|
| PREGNANT_CTE_STUDENTS (2020-25) | ✅ Delivered — all 5 years, 4742 total rows |
| SINGLEPAR_CTE_STUDENTS (2020-25) | ✅ Delivered — all 5 years, 4742 total rows |
| ELIG_PREG_REL_SVCS_DAYS (2020-25) | ✅ Delivered — all 5 years, 4742 total rows |
| E1012 PEP-INDICATOR-CODE (2020-25) | ❌ No responsive — TEA noted deleted in 2012 |

---

## Dataset Inventory

| Table | Source File | Rows |
|-------|-------------|------|
| research_pir2502592_2020_2021 | PRU_11507_21.csv | 1043 |
| research_pir2502592_2021_2022 | PRU_11507_22.csv | 1070 |
| research_pir2502592_2022_2023 | PRU_11507_23.csv | 1069 |
| research_pir2502592_2023_2024 | PRU_11507_24.csv | 1063 |
| research_pir2502592_2024_2025 | PRU_11507_25.csv | 497 |
| **Total** | | **4742** |

---

## Quality Notes

- **FERPA masking:** Counts under 10 replaced with -999 in source data. Loader converts to NULL on import.
- **2024-2025 partial:** Only 497 rows (vs. ~1050 in other years) — most recent school year, likely incomplete district reporting.
- **Consistent schema** across all 5 CSVs. Six columns: YEAR, DISTRICT, DISTNAME, PREGNANT_CTE_STUDENTS, SINGLEPAR_CTE_STUDENTS, ELIG_PREG_REL_SVCS_DAYS.

---

## Draft Acknowledgment to TEA (Jenny Eaton)

Dear Ms. Eaton,

Thank you for releasing the five CSV files with district-level pregnancy and parenting PEIMS data (2020-21 through 2024-25) in response to my Public Information Request #2502592. I confirm receipt of PRU_11507_21.csv through PRU_11507_25.csv, totaling 4,742 rows of data. I also note that the E1012 PEP_ATTEND item was not responsive, having been deleted from PEIMS in 2012.

Thank you for providing this data at no charge.

Sincerely,
Kevin Hopper
kevin.hopper1@gmail.com

---

## Staging Files

- [README.md](http://100.118.41.122:8080/api/pir/staging/2502592/README.md)
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502592/loader.py)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502592/source_inventory.json)

---

**Reply APPROVE to commit the data load and create the draft reply.**
**Reply REVISE <your feedback> to adjust.**
**Reply REJECT to cancel processing.**
