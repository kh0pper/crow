# PIR #2502592 — Review: TEA Pregnancy/Parenting PEIMS Data

**Recipient:** Texas Education Agency (PIR@tea.texas.gov)  
**Status:** Processing — 5 CSV files, 4,742 rows  
**SQ3 follow-up:** PIR #2502803 requests 2016-17 through 2019-20 data (due extended to 2026-06-02)

---

## Cross-Reference: Requested vs. Received

| Requested Element | Status |
|---|---|
| PREGNANT_CTE_STUDENTS | Delivered (all 5 years) |
| SINGLEPAR_CTE_STUDENTS | Delivered (all 5 years) |
| ELIG_PREG_REL_SVCS_DAYS | Delivered (all 5 years) |
| E1012 PEP-INDICATOR-CODE / PEP_ATTEND | No responsive records (deleted in 2012) |

## Dataset Inventory (row counts from dry-run)

| File | Table | Year | Rows |
|---|---|---|---|
| PRU_11507_21.csv | research_pir2502592_21 | 2020-21 | 1,043 |
| PRU_11507_22.csv | research_pir2502592_22 | 2021-22 | 1,070 |
| PRU_11507_23.csv | research_pir2502592_23 | 2022-23 | 1,069 |
| PRU_11507_24.csv | research_pir2502592_24 | 2023-24 | 1,063 |
| PRU_11507_25.csv | research_pir2502592_25 | 2024-25 | 497 |

**Total:** 4,742 data rows across 5 tables.

## Quality Flags and Data Notes

- **FERPA masking:** Values of -999 indicate district counts < 10. These are not actual values.
- **2024-25 coverage:** Only 497 districts reported vs ~1,050+ for prior years. This reflects incomplete PEIMS reporting for the most recent school year, not missing data.
- **All CSVs** share identical column structure. District TEA IDs and names are consistent across years.
- **No TEA cover letter** was included with the response — the 5 CSV files were released directly with no accompanying correspondence text.

## Draft Acknowledgment to TEA

> Thank you for releasing the PEIMS data in response to my Public Information Request #2502592. I have received the five CSV files (PRU_11507_21 through PRU_11507_25) containing district-level pregnancy related services data for school years 2020-21 through 2024-25. I appreciate the data being provided at no charge.
>
> Thank you for your assistance.
>
> Sincerely,
> Kevin Hopper
> kevin.hopper1@gmail.com

## Staging Files

- [README.md](http://100.118.41.122:8080/api/pir/staging/2502592/README.md)
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502592/loader.py)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502592/source_inventory.json)

## Instructions

Reply **APPROVE** to commit the data load and create the draft reply.  
Reply **REVISE** <your feedback> to adjust.  
Reply **REJECT** to cancel processing.
