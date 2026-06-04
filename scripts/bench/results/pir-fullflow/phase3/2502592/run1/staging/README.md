# PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data

**Recipient:** Texas Education Agency (PIR@tea.texas.gov)  
**Received:** 2026-02-26  
**Case Type:** Delivery  
**Cost:** No charge

## Data Summary

TEA delivered 5 CSV files containing district-level Pregnancy Related Services PEIMS data for school years 2020-21 through 2024-25. Total: **4,742 rows** across 5 year-slices.

## Files

| File | Rows | Year | Size |
|------|------|------|------|
| PRU_11507_21.csv | 1,043 | 2020-2021 | 44.1 KB |
| PRU_11507_22.csv | 1,070 | 2021-2022 | 45.4 KB |
| PRU_11507_23.csv | 1,069 | 2022-2023 | 45.2 KB |
| PRU_11507_24.csv | 1,063 | 2023-2024 | 44.8 KB |
| PRU_11507_25.csv | 497 | 2024-2025 | 21.5 KB |

## Schema

All 5 CSVs share the same columns:

| Column | Description |
|--------|-------------|
| YEAR | School year (e.g., 2020-2021) |
| DISTRICT | 6-digit TEA district ID |
| DISTNAME | District name |
| PREGNANT_CTE_STUDENTS | Count of pregnant CTE students (FERPA-masked) |
| SINGLEPAR_CTE_STUDENTS | Count of single-parent CTE students (FERPA-masked) |
| ELIG_PREG_REL_SVCS_DAYS | Eligible pregnancy-related services days present |

## Quality Flags

- **FERPA masking:** Counts below 10 are replaced with -999 in all numeric fields.
- **Partial year data:** The 2024-2025 file has 497 rows (vs ~1,000+ for prior years), consistent with partial school year data (data not yet finalized for the current academic year).
- **Field mapping:** TEA used descriptive field names rather than the PEIMS element codes requested (E0829 → SINGLEPAR_CTE_STUDENTS, E0939 → ELIG_PREG_REL_SVCS_DAYS). The E1012 PEP-INDICATOR-CODE field was previously noted by TEA as deleted in 2012.

## Origin

- **PIF Reference:** PRU_11507
- **Contact:** Jenny Eaton, PIR@tea.texas.gov
- **Original Request Filed:** 2026-01-29
