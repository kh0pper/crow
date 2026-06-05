# PIR #2502592 — Review Email

**TEA Pregnancy/Parenting PEIMS Data**

## Cross-Reference Table

| Original Request Item | Status |
|---|---|
| SINGLEPAR_CTE_STUDENTS (2020-25) | **Delivered** — 5 CSV files, 4,742 rows |
| PREGNANT_CTE_STUDENTS (2020-25) | **Delivered** — included in same CSV files |
| ELIG_PREG_REL_SVCS_DAYS (2020-25) | **Delivered** — included in same CSV files |
| E1012 PEP_ATTEND (years 2020-25) | **No Docs** — TEA noted E1012 PEP_ATTEND was deleted in 2012 |
| E1012 PEP_INDICATOR (years 2020-25) | **No Docs** — TEA noted E1012 PEP_ATTEND deleted in 2012 |

## Dataset Inventory

| Table | CSV File | Rows |
|---|---|---|
| research_pir2502592_PRU_11507_21 | PRU_11507_21.csv | 1,043 |
| research_pir2502592_PRU_11507_22 | PRU_11507_22.csv | 1,070 |
| research_pir2502592_PRU_11507_23 | PRU_11507_23.csv | 1,069 |
| research_pir2502592_PRU_11507_24 | PRU_11507_24.csv | 1,063 |
| research_pir2502592_PRU_11507_25 | PRU_11507_25.csv | 497 |
| **Total** | | **4,742** |

Columns: YEAR, DISTRICT, DISTNAME, PREGNANT_CTE_STUDENTS, SINGLEPAR_CTE_STUDENTS, ELIG_PREG_REL_SVCS_DAYS

## Quality Notes

- FERPA masking: -999 values indicate masked data (counts below threshold). These will be converted to NULL on load.
- All 5 files share identical schema.
- File PRU_11507_25.csv has significantly fewer rows (497) likely corresponding to a shorter or partial year.
- No data gaps or schema inconsistencies detected.

## Staging Files

- [README.md](http://100.118.41.122:8080/api/pir/staging/2502592/README.md)
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502592/loader.py)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502592/source_inventory.json)
- [draft_acknowledgment.txt](http://100.118.41.122:8080/api/pir/staging/2502592/draft_acknowledgment.txt)

## Draft Reply to TEA

I have received the five CSV files containing district-level pregnancy-related CTE student data (PEIMS) for PIR #2502592. Thank you for producing this data at no charge.

The files cover years 2020-21 through 2024-25 with 4,742 total rows across all five files. I have received:

- PRU_11507_21.csv (1,043 rows)
- PRU_11507_22.csv (1,070 rows)
- PRU_11507_23.csv (1,069 rows)
- PRU_11507_24.csv (1,063 rows)
- PRU_11507_25.csv (497 rows)

This completes my acknowledgment for PIR #2502592.

Kevin Hopper
kevin.hopper1@gmail.com

---

**Reply APPROVE to commit the data load and create the draft reply.**
**Reply REVISE <your feedback> to adjust.**
**Reply REJECT to cancel processing.**
