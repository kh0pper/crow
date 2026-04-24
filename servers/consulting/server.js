/**
 * Consulting Pipeline — MCP server factory for Maestro Press's
 * consulting prospect tracker.
 *
 * Stores one row per Texas education organization (ISDs, charters, ESCs,
 * nonprofits, state agencies, etc.) in the `consulting_pipeline` table
 * in crow.db. Kevin promotes rows from stage='unqualified' to 'prospect',
 * the prospectus-generator pipeline picks up pending prospects, drops a
 * markdown file into the inbox watched by the render-prospectus systemd
 * path unit, and marks the row generated.
 *
 * All tool handlers use idempotent table creation so the server can be
 * loaded on any Crow instance; the table is only populated on the MPA
 * instance via `seed_consulting_pipeline.py`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createDbClient } from "../db.js";

const PROSPECTUS_INBOX_DIR = process.env.MPA_PROSPECTUS_INBOX
  || join(homedir(), "maestro-press-assistant", "prospectuses", "inbox");
const PROSPECTUS_OUT_DIR = process.env.MPA_PROSPECTUS_OUT
  || join(homedir(), "maestro-press-assistant", "prospectuses");

const VALID_STAGES = [
  "unqualified", "prospect", "contacted", "proposal_sent",
  "engaged", "dormant", "declined",
];

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS consulting_pipeline (
  tea_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  org_type TEXT,
  esc_region INTEGER,
  county TEXT,
  total_students INTEGER,
  charter_status TEXT,
  has_capstone_analysis INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'unqualified',
  last_pipeline_action TEXT,
  last_action_at TEXT,
  prospectus_path TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`;

const CREATE_INDEX_STAGE = `CREATE INDEX IF NOT EXISTS idx_cp_stage ON consulting_pipeline(stage)`;
const CREATE_INDEX_REGION = `CREATE INDEX IF NOT EXISTS idx_cp_region ON consulting_pipeline(esc_region)`;
const CREATE_INDEX_PENDING = `
CREATE INDEX IF NOT EXISTS idx_cp_pending_prospect ON consulting_pipeline(stage, last_pipeline_action)
WHERE stage='prospect' AND last_pipeline_action IS NULL`;

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "unknown";
}

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export function createConsultingServer(dbPath) {
  const db = createDbClient(dbPath);

  let _schemaReady = false;
  async function ensureSchema() {
    if (_schemaReady) return;
    await db.execute(CREATE_TABLE_SQL);
    await db.execute(CREATE_INDEX_STAGE);
    await db.execute(CREATE_INDEX_REGION);
    await db.execute(CREATE_INDEX_PENDING);
    _schemaReady = true;
  }

  const server = new McpServer({ name: "consulting", version: "0.1.0" });

  server.tool(
    "crow_consulting_promote",
    "Promote an organization to a consulting pipeline stage. Upserts the row if the tea_id is not already in the table (useful for orgs added to TEA after the initial seed).",
    {
      tea_id: z.string().min(1).max(16).describe("6-digit TEA district ID (or ESC/nonprofit pseudo-id)"),
      stage: z.enum(VALID_STAGES).default("prospect").describe("Pipeline stage"),
      notes: z.string().max(2000).optional().describe("Free-form notes for the row"),
      name: z.string().max(255).optional().describe("Org name (required on insert)"),
      org_type: z.string().max(32).optional().describe("isd/charter/esc/nonprofit/state_agency/association/for_profit/higher_ed"),
      esc_region: z.number().int().min(1).max(20).optional(),
      county: z.string().max(100).optional(),
    },
    async ({ tea_id, stage, notes, name, org_type, esc_region, county }) => {
      await ensureSchema();
      const { rows } = await db.execute({
        sql: "SELECT tea_id FROM consulting_pipeline WHERE tea_id = ?",
        args: [tea_id],
      });
      if (rows.length === 0) {
        if (!name) {
          return {
            content: [{ type: "text", text: `Error: tea_id ${tea_id} not in table — pass name (and ideally org_type/esc_region/county) to insert.` }],
            isError: true,
          };
        }
        await db.execute({
          sql: `INSERT INTO consulting_pipeline
                (tea_id, name, org_type, esc_region, county, stage, notes, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
          args: [tea_id, name, org_type ?? null, esc_region ?? null, county ?? null, stage, notes ?? null],
        });
        return { content: [{ type: "text", text: `Inserted ${tea_id} (${name}) at stage=${stage}` }] };
      }
      await db.execute({
        sql: `UPDATE consulting_pipeline
              SET stage = ?, notes = COALESCE(?, notes), updated_at = datetime('now')
              WHERE tea_id = ?`,
        args: [stage, notes ?? null, tea_id],
      });
      return { content: [{ type: "text", text: `Promoted ${tea_id} to stage=${stage}` }] };
    }
  );

  server.tool(
    "crow_consulting_list_pending",
    "List organizations at stage='prospect' with no pipeline action yet — these are the queue for the prospectus generator.",
    {
      limit: z.number().int().min(1).max(50).default(10),
    },
    async ({ limit }) => {
      await ensureSchema();
      const { rows } = await db.execute({
        sql: `SELECT tea_id, name, org_type, esc_region, county, total_students,
                     charter_status, has_capstone_analysis, notes
              FROM consulting_pipeline
              WHERE stage = 'prospect' AND last_pipeline_action IS NULL
              ORDER BY has_capstone_analysis DESC, created_at ASC
              LIMIT ?`,
        args: [limit],
      });
      return { content: [{ type: "text", text: JSON.stringify({ count: rows.length, items: rows }, null, 2) }] };
    }
  );

  server.tool(
    "crow_consulting_write_prospectus",
    "Write a finished prospectus markdown to the MPA prospectus inbox and mark the pipeline row as generated. The markdown will be auto-rendered to PDF by the systemd path watcher. Returns the markdown path and the expected PDF path.",
    {
      tea_id: z.string().min(1).max(16),
      markdown: z.string().min(200).max(200000).describe("Full prospectus markdown (2-3 pages typical)"),
    },
    async ({ tea_id, markdown }) => {
      await ensureSchema();
      const { rows } = await db.execute({
        sql: "SELECT tea_id, name FROM consulting_pipeline WHERE tea_id = ?",
        args: [tea_id],
      });
      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: `Error: tea_id ${tea_id} not in consulting_pipeline — call crow_consulting_promote first.` }],
          isError: true,
        };
      }
      const name = rows[0].name;
      const slug = slugify(name);
      const datestr = today();
      const filename = `${tea_id}-${slug}-${datestr}`;
      mkdirSync(PROSPECTUS_INBOX_DIR, { recursive: true });
      const mdPath = resolve(PROSPECTUS_INBOX_DIR, `${filename}.md`);
      const pdfPath = resolve(PROSPECTUS_OUT_DIR, `${filename}.pdf`);
      writeFileSync(mdPath, markdown, { mode: 0o644 });
      await db.execute({
        sql: `UPDATE consulting_pipeline
              SET last_pipeline_action = 'prospectus_generated',
                  last_action_at = datetime('now'),
                  prospectus_path = ?,
                  updated_at = datetime('now')
              WHERE tea_id = ?`,
        args: [pdfPath, tea_id],
      });
      return {
        content: [{ type: "text", text: JSON.stringify({
          tea_id, name, md_path: mdPath, expected_pdf_path: pdfPath, bytes: Buffer.byteLength(markdown),
        }, null, 2) }],
      };
    }
  );

  server.tool(
    "crow_consulting_list_by_stage",
    "List consulting pipeline rows at a given stage.",
    {
      stage: z.enum(VALID_STAGES),
      limit: z.number().int().min(1).max(200).default(50),
    },
    async ({ stage, limit }) => {
      await ensureSchema();
      const { rows } = await db.execute({
        sql: `SELECT tea_id, name, org_type, esc_region, county, total_students,
                     has_capstone_analysis, stage, last_pipeline_action, last_action_at
              FROM consulting_pipeline
              WHERE stage = ?
              ORDER BY updated_at DESC
              LIMIT ?`,
        args: [stage, limit],
      });
      return { content: [{ type: "text", text: JSON.stringify({ stage, count: rows.length, items: rows }, null, 2) }] };
    }
  );

  server.tool(
    "crow_consulting_get",
    "Get a single consulting pipeline row by tea_id.",
    { tea_id: z.string().min(1).max(16) },
    async ({ tea_id }) => {
      await ensureSchema();
      const { rows } = await db.execute({
        sql: "SELECT * FROM consulting_pipeline WHERE tea_id = ?",
        args: [tea_id],
      });
      if (rows.length === 0) {
        return { content: [{ type: "text", text: `Not found: ${tea_id}` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(rows[0], null, 2) }] };
    }
  );

  server.tool(
    "crow_consulting_stats",
    "Count consulting pipeline rows per stage.",
    {},
    async () => {
      await ensureSchema();
      const { rows } = await db.execute({
        sql: `SELECT stage, COUNT(*) as count FROM consulting_pipeline GROUP BY stage ORDER BY count DESC`,
      });
      const { rows: pending } = await db.execute({
        sql: `SELECT COUNT(*) as count FROM consulting_pipeline
              WHERE stage='prospect' AND last_pipeline_action IS NULL`,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({
          by_stage: rows,
          pending_generation: pending[0]?.count ?? 0,
        }, null, 2) }],
      };
    }
  );

  return server;
}
