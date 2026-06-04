# PIR #2502592 — Review Email

**TEA Pregnancy/Parenting PEIMS Data (2020-25)**

## Summary

TEA released 5 CSV files containing district-level PEIMS data for pregnancy/parenting CTE students and related services. All 5 requested years (2020-21 through 2024-25) are covered. Delivered at no charge. The E1012 PEP indicator was not produced (deleted in 2012, as previously noted).

## Cross-Reference Table

| Requested Item | Status | Notes |
|----------------|--------|-------|
| PREGNANT_CTE_STUDENTS (2020-25) | **Delivered** | All 5 years covered |
| SINGLEPAR_CTE_STUDENTS (2020-25) | **Delivered** | All 5 years covered |
| ELIG_PREG_REL_SVCS_DAYS (2020-25) | **Delivered** | All 5 years covered |
| E1012 PEP-INDICATOR-CODE | **No responsive** | Deleted 2012 (TEA noted) |

## Dataset Inventory

| File | Table | Data Rows |
|------|-------|-----------|
| PRU_11507_21.csv | research_pir2502592_2020_21 | 1,043 |
| PRU_11507_22.csv | research_pir2502592_2021_22 | 1,070 |
| PRU_11507_23.csv | research_pir2502592_2022_23 | 1,069 |
| PRU_11507_24.csv | research_pir2502592_2023_24 | 1,063 |
| PRU_11507_25.csv | research_pir2502592_2024_25 | 497 |
| **Total** | | **4,742** |

## Quality Flags

- **FERPA masking:** Counts below 10 replaced with -999. Loader converts to NULL.
- **PRU_11507_25.csv (2024-25):** Only 497 districts vs ~1,070 for other years. Likely interim/partial data for the current school year.
- **Schema consistency:** All 5 CSVs share identical 6-column structure (YEAR, DISTRICT, DISTNAME, PREGNANT_CTE_STUDENTS, SINGLEPAR_CTE_STUDENTS, ELIG_PREG_REL_SVCS_DAYS).
- **Geographic coverage:** Sample districts confirmed as Texas ISDs (Anderson County, TX).

## Draft Reply to TEA

> Dear Jenny Eaton,
>
> Thank you for releasing the records responsive to our Public Information Request #2502592. I have received five CSV files containing district-level PEIMS data for pregnancy/parenting CTE students and related services for school years 2020-21 through 2024-25, totaling 4,742 records across all files.
>
> I note that the E1012 PEP indicator was not produced, consistent with your prior notification that this data element was deleted in 2012. Please let me know if any additional data has since become available for that field.
>
> Thank you for your prompt assistance with this request.
>
> Kevin Hopper
> kevin.hopper1@gmail.com

## Staging Files

- [README.md](http://100.118.41.122:8080/api/pir/staging/2502592/README.md)
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502592/loader.py)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502592/source_inventory.json)
- [row_counts.json](http://100.118.41.122:8080/api/pir/staging/2502592/row_counts.json)
- [draft_acknowledgment.txt](http://100.118.41.122:8080/api/pir/staging/2502592/draft_acknowledgment.txt)

---

**Reply APPROVE to commit the data load and create the draft reply.**
**Reply REVISE <your feedback> to adjust.**
**Reply REJECT to cancel processing.**
