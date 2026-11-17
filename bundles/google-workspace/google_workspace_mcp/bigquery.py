"""
BigQuery API v2 tools — run SQL and sync Sheets data into BigQuery tables.

A common use is backing a Looker Studio data source: Looker Studio's fail-closed
row-level security is configured on a BigQuery data source, so a feed is synced
from Sheets into a native BQ table and Looker filters rows per signed-in viewer.

Surface (deliberately small + generic — every tool takes a project_id, defaulting
to the GOOGLE_BIGQUERY_PROJECT env var):
  - bigquery_query              run any SQL (SELECT / DDL / DML) — the workhorse:
                                CREATE SCHEMA, CREATE OR REPLACE TABLE AS SELECT,
                                and SELECT count(*) for verification.
  - bigquery_sync_sheet_to_table  convenience full-refresh of a native table from
                                a Sheet range (headers -> STRING columns).
  - bigquery_list_datasets      list datasets in the project.
  - bigquery_list_tables        list tables in a dataset.

Requirements (see auth.SCOPES / get_bigquery_service):
  - the `bigquery` scope granted (re-auth after adding the scope);
  - the BigQuery API enabled in the OAuth client's GCP project;
  - billing (or a BigQuery sandbox) available on that project.
"""

import asyncio
import logging
import os
import re

from .auth import get_bigquery_service, get_sheets_service
from .guardrails import handle_google_errors

logger = logging.getLogger(__name__)


def _project(project_id: str | None) -> str:
    """Resolve the GCP project id: explicit arg wins, else GOOGLE_BIGQUERY_PROJECT."""
    pid = (project_id or os.environ.get("GOOGLE_BIGQUERY_PROJECT", "")).strip()
    if not pid:
        raise ValueError(
            "No BigQuery project id. Pass project_id, or set the "
            "GOOGLE_BIGQUERY_PROJECT env var."
        )
    return pid


def _safe_column(name: str, used: set) -> str:
    """Sanitize a header into a valid, unique BigQuery column name.

    BQ columns must match [A-Za-z_][A-Za-z0-9_]* (<=300 chars). Non-matching
    chars -> '_'; a leading digit gets a '_' prefix; blanks/dupes are de-collided."""
    base = re.sub(r"[^0-9A-Za-z_]", "_", str(name).strip())
    if not base:
        base = "col"
    if re.match(r"^[0-9]", base):
        base = "_" + base
    base = base[:300]
    candidate = base
    i = 2
    while candidate.lower() in used:
        candidate = f"{base}_{i}"
        i += 1
    used.add(candidate.lower())
    return candidate


def _rows_from_query_result(res: dict) -> tuple[list, list]:
    """Parse a jobs.query / getQueryResults payload into (columns, list-of-dicts)."""
    fields = res.get("schema", {}).get("fields", [])
    columns = [f.get("name") for f in fields]
    out = []
    for row in res.get("rows", []):
        cells = row.get("f", [])
        rec = {}
        for i, col in enumerate(columns):
            rec[col] = cells[i].get("v") if i < len(cells) else None
        out.append(rec)
    return columns, out


@handle_google_errors
async def bigquery_query(
    sql: str,
    project_id: str | None = None,
    max_rows: int = 1000,
    use_legacy_sql: bool = False,
    location: str | None = None,
) -> dict:
    """Run a BigQuery SQL statement and return the result.

    The workhorse: use for SELECT (e.g. `SELECT k, COUNT(*) FROM ds.tbl GROUP BY
    k`), DDL (`CREATE SCHEMA`, `CREATE OR REPLACE TABLE ... AS SELECT ...`), and
    DML. Standard SQL by default.

    `max_rows` caps returned rows (DDL/DML return 0). If the job does not complete
    synchronously, returns the jobReference + job_complete=False to poll later."""
    svc = get_bigquery_service()
    project = _project(project_id)
    body = {
        "query": sql,
        "useLegacySql": bool(use_legacy_sql),
        "maxResults": int(max_rows),
    }
    if location:
        body["location"] = location
    res = await asyncio.to_thread(
        lambda: svc.jobs().query(projectId=project, body=body).execute()
    )
    columns, rows = _rows_from_query_result(res)
    return {
        "success": True,
        "data": {
            "project_id": project,
            "job_complete": res.get("jobComplete", True),
            "job_reference": res.get("jobReference"),
            "total_rows": res.get("totalRows"),
            "total_bytes_processed": res.get("totalBytesProcessed"),
            "columns": columns,
            "row_count": len(rows),
            "rows": rows,
            "truncated": str(res.get("totalRows", "0")).isdigit()
            and int(res.get("totalRows", "0")) > len(rows),
        },
    }


@handle_google_errors
async def bigquery_list_datasets(project_id: str | None = None) -> dict:
    """List datasets (schemas) in a BigQuery project."""
    svc = get_bigquery_service()
    project = _project(project_id)
    res = await asyncio.to_thread(
        lambda: svc.datasets().list(projectId=project, all=False).execute()
    )
    datasets = [
        {
            "dataset_id": d.get("datasetReference", {}).get("datasetId"),
            "location": d.get("location"),
        }
        for d in res.get("datasets", [])
    ]
    return {"success": True, "data": {"project_id": project, "datasets": datasets}}


@handle_google_errors
async def bigquery_list_tables(dataset: str, project_id: str | None = None) -> dict:
    """List tables in a BigQuery dataset, with row counts and types."""
    svc = get_bigquery_service()
    project = _project(project_id)
    res = await asyncio.to_thread(
        lambda: svc.tables().list(projectId=project, datasetId=dataset).execute()
    )
    tables = [
        {
            "table_id": t.get("tableReference", {}).get("tableId"),
            "type": t.get("type"),
            "rows": t.get("numRows"),
        }
        for t in res.get("tables", [])
    ]
    return {
        "success": True,
        "data": {"project_id": project, "dataset": dataset, "tables": tables},
    }


@handle_google_errors
async def bigquery_sync_sheet_to_table(
    spreadsheet_id: str,
    sheet_range: str,
    dataset: str,
    table: str,
    project_id: str | None = None,
    location: str = "US",
    header_row: bool = True,
) -> dict:
    """Full-refresh a native BigQuery table from a Sheet range.

    Reads `sheet_range` (e.g. 'Sheet1!A1:Z'), treats the first row as headers
    (-> sanitized STRING columns), creates the dataset/table if needed, REPLACES
    the table's rows, and streams the data in via insertAll. All columns are
    typed STRING (safest for mixed data; cast in the Looker / SQL layer). Returns
    the column mapping + row count loaded.

    Caveat (BigQuery streaming): rows inserted via insertAll land in a streaming
    buffer and are usually queryable within seconds, but a query issued in the
    same instant may briefly see fewer rows. Re-run the count a few seconds later.
    For a strict atomic swap, use bigquery_query with `CREATE OR REPLACE TABLE ...
    AS SELECT ...` over an external Sheets table instead."""
    svc = get_bigquery_service()
    sheets_svc = get_sheets_service()
    project = _project(project_id)

    # 1) Read the sheet.
    sheet = await asyncio.to_thread(
        lambda: sheets_svc.spreadsheets()
        .values()
        .get(spreadsheetId=spreadsheet_id, range=sheet_range)
        .execute()
    )
    values = sheet.get("values", [])
    if not values:
        return {
            "success": False,
            "error": f"Sheet range '{sheet_range}' is empty — nothing to sync.",
            "data": {"spreadsheet_id": spreadsheet_id},
        }

    if header_row:
        raw_headers, data_rows = values[0], values[1:]
    else:
        raw_headers = [f"col_{i+1}" for i in range(len(values[0]))]
        data_rows = values

    used: set = set()
    columns = [_safe_column(h, used) for h in raw_headers]
    ncols = len(columns)

    # 2) Ensure the dataset exists (idempotent — ignore 409 already-exists).
    def _ensure_dataset():
        from googleapiclient.errors import HttpError

        try:
            svc.datasets().insert(
                projectId=project,
                body={
                    "datasetReference": {"datasetId": dataset, "projectId": project},
                    "location": location,
                },
            ).execute()
        except HttpError as e:
            if getattr(e, "resp", None) is None or e.resp.status != 409:
                raise

    await asyncio.to_thread(_ensure_dataset)

    # 3) Replace the table: delete-if-exists, then create with a STRING schema.
    def _recreate_table():
        from googleapiclient.errors import HttpError

        try:
            svc.tables().delete(
                projectId=project, datasetId=dataset, tableId=table
            ).execute()
        except HttpError as e:
            if getattr(e, "resp", None) is None or e.resp.status != 404:
                raise
        svc.tables().insert(
            projectId=project,
            datasetId=dataset,
            body={
                "tableReference": {
                    "projectId": project,
                    "datasetId": dataset,
                    "tableId": table,
                },
                "schema": {
                    "fields": [{"name": c, "type": "STRING"} for c in columns]
                },
            },
        ).execute()

    await asyncio.to_thread(_recreate_table)

    # 4) Stream rows in batches of 500 (pad/truncate each row to the column count).
    def _norm_row(r):
        rec = {}
        for i, c in enumerate(columns):
            rec[c] = str(r[i]) if i < len(r) and r[i] is not None else ""
        return {"json": rec}

    inserted, errors = 0, []

    def _insert_batch(batch):
        return (
            svc.tabledata()
            .insertAll(
                projectId=project,
                datasetId=dataset,
                tableId=table,
                body={"rows": batch},
            )
            .execute()
        )

    for start in range(0, len(data_rows), 500):
        batch = [_norm_row(r) for r in data_rows[start : start + 500]]
        resp = await asyncio.to_thread(lambda b=batch: _insert_batch(b))
        if resp.get("insertErrors"):
            errors.extend(resp["insertErrors"][:5])  # cap the echoed errors
        else:
            inserted += len(batch)

    ok = not errors
    return {
        "success": ok,
        "error": None if ok else f"{len(errors)} batch(es) had insert errors (first few echoed).",
        "data": {
            "project_id": project,
            "dataset": dataset,
            "table": table,
            "columns": list(zip(raw_headers, columns)),
            "column_count": ncols,
            "rows_loaded": inserted,
            "rows_in_source": len(data_rows),
            "insert_errors": errors,
            "note": "Streamed via insertAll; allow a few seconds before counting rows.",
        },
    }
