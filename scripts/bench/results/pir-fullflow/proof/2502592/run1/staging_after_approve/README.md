# PIR #2502592 - TEA Pregnancy Related Services PEIMS Data

**Recipient:** Texas Education Agency
**Response Date:** 2026-02-26
**Description:** District-level PEIMS data for Pregnancy Related Services
**SQ3:** True

## Data Summary

5 CSV files delivered, covering school years 2020-21 through 2024-25.

| School Year | File | Rows | Status |
|-------------|------|------|--------|
| 2020-21 | PRU_11507_21.csv | 1,043 | Delivered |
| 2021-22 | PRU_11507_22.csv | 1,070 | Delivered |
| 2022-23 | PRU_11507_23.csv | 1,069 | Delivered |
| 2023-24 | PRU_11507_24.csv | 1,063 | Delivered |
| 2024-25 | PRU_11507_25.csv | 497 | Delivered (partial year) |
| **Total** | | **4,742** | |

## Columns

All CSV files share the same schema:

| Column | Description |
|--------|-------------|
| YEAR | School year (e.g., 2020-21) |
| DISTRICT | TEA district identifier |
| DISTNAME | District name |
| PREGNANT_CTE_STUDENTS | Count of pregnant CTE students |
| SINGLEPAR_CTE_STUDENTS | Count of single-parent CTE students |
| ELIG_PREG_REL_SVCS_DAYS | Eligible pregnancy-related services days present |

## Data Quality Flags

- **FERPA Masking:** Values of -999 indicate suppressed counts (FERPA requires suppression for counts < 10). These will be converted to NULL during loading.
- **2024-25 Partial Year:** Only 497 districts vs ~1,070 for full years. The 2024-25 school year was likely still in progress when data was exported.
- **No Student-Level Records:** All data is aggregated at the district level as requested.

## Items from Original Request

| Requested Element | Status | Notes |
|-------------------|--------|-------|
| E1012 PEP-INDICATOR-CODE | No responsive records | TEA confirmed PEP_ATTEND deleted in 2012 |
| E0829 SGL-PARENT-PREG-TEEN-CODE | Delivered | Column name: SINGLEPAR_CTE_STUDENTS |
| E0939 TOTAL-ELIG-PREG-REL-SVCS-DAYS-PRESENT | Delivered | Column name: ELIG_PREG_REL_SVCS_DAYS |

## Loading

Use the included `loader.py`:

```bash
python3 loader.py --dry-run    # Preview row counts
python3 loader.py --commit     # Load into tea_data.db
```

Tables will be named: `research_pir2502592_2020_21` through `research_pir2502592_2024_25`.

## Related

- PIR #2502803: Follow-up requesting years 2016-17 through 2019-20 (due April 15, 2026)
