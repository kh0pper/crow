/**
 * Fixture builders for tests/grackle-d3-import.test.js.
 *
 * Both DBs are generated from the repo's own schema (scripts/init-db.js run
 * into a scratch CROW_DATA_DIR, then the bundles' own init-tables), so no
 * binary fixtures live in the repo. The seed rows model the shapes recorded
 * in the D3 map (Gitea backlog/2026-09-24-grackle-d3-data-migration-map.md),
 * the spec §4.2 and the real crow DB (2026-10-02 backup):
 *   - BOTH sides hold a local-owner project_members row (contact_id NULL)
 *     for every project, created independently (different uuids);
 *   - crow_instances on crow lists self, grackle ("Primary"), black-swan,
 *     raven ("unknown") and MPA;
 *   - memory id collisions, one replicated-then-edited memory (same id and
 *     created_at, different content);
 *   - the grackle-6 = crow-6 project, a source-only research_sources.s3_key,
 *     a reordered chat_messages, natural-key Ramble rows (incl. synced rows
 *     only grackle has), unowned tables, bot history, an unmapped table,
 *     and bundle tables crow does not have (media, data-dashboard).
 */
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { libsqlAdapter } from "../../../scripts/ops/grackle-d3-import.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const GRACKLE_ID = "49cf71ca878643ba7717f344329266fd";
export const CROW_ID = "0867ac2809dedd885ba7769b21966f8e";
export const BLACK_SWAN_ID = "77ac9c01d04232ac21498959394a6896";
export const RAVEN_ID = "1ed44a83420076c087c6576cd179f206";
export const MPA_ID = "520a862972ac32b60e737c458b5e050c";

/** Unmapped source tables that hold rows (apply must --ack-unclassified exactly these). */
export const UNCLASSIFIED_WITH_ROWS = ["job_search_sites"];

async function bundleInit(db, mod, fn) {
  const m = await import(pathToFileURL(join(REPO, mod)).href);
  await m[fn](libsqlAdapter(db));
}

/** init-db into dir/crow.db (child process: init-db is a top-level-await script). */
function initDb(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    cwd: REPO,
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: join(dir, "crow.db") },
    stdio: "pipe",
  });
  return join(dir, "crow.db");
}

const quiet = async (f) => {
  const log = console.log;
  console.log = () => {};
  try { return await f(); } finally { console.log = log; }
};

/** The (future) lamport_origin column on the LWW ramble tables — added if this tree lacks it. */
function ensureLamportOrigin(db) {
  const cols = db.prepare("PRAGMA table_info(ramble_eggs)").all().map((c) => c.name);
  if (!cols.includes("lamport_origin")) db.exec("ALTER TABLE ramble_eggs ADD COLUMN lamport_origin TEXT");
}

/** crow main as it looks before W3. */
export async function buildTarget(dir, { media = false, dashboard = false, grackleStatus = "revoked" } = {}) {
  const path = initDb(dir);
  writeFileSync(join(dir, "instance-id"), CROW_ID);
  const db = new Database(path);
  await quiet(async () => {
    await bundleInit(db, "bundles/ramble/server/init-tables.js", "initRambleTables");
    await bundleInit(db, "bundles/knowledge-base/server/init-tables.js", "initKbTables");
    if (media) await bundleInit(db, "bundles/media/server/init-tables.js", "initMediaTables");
    if (dashboard) await bundleInit(db, "bundles/data-dashboard/server/init-tables.js", "initDataDashboardTables");
  });
  ensureLamportOrigin(db);
  db.exec(`
    INSERT INTO crow_instances (id, name, crow_id, status) VALUES ('${CROW_ID}', 'crow:/home/kh0pp/crow', 'crow:kdq7zskhat', 'active');
    INSERT INTO crow_instances (id, name, crow_id, status) VALUES ('${GRACKLE_ID}', 'Primary', 'crow:kdq7zskhat', '${grackleStatus}');
    INSERT INTO crow_instances (id, name, crow_id, status) VALUES ('${BLACK_SWAN_ID}', 'Cloud (black-swan)', 'crow:kdq7zskhat', 'active');
    INSERT INTO crow_instances (id, name, crow_id, status) VALUES ('${RAVEN_ID}', 'unknown', 'crow:kdq7zskhat', 'active');
    INSERT INTO crow_instances (id, name, crow_id, status) VALUES ('${MPA_ID}', 'MPA', 'crow:kdq7zskhat', 'active');

    INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (3, 'crow:dayane', 'Dayane', 'ed', 'secp');
    INSERT INTO project_spaces (id, uuid, slug, name, workspace_dir) VALUES (6, 'crow-uuid-6', 'tea-data', 'TEA data', '/home/kh0pp/.crow/data/projects/6');
    INSERT INTO project_spaces (id, uuid, slug, name, workspace_dir) VALUES (2, 'crow-uuid-2', 'clash', 'Crow clash', '/home/kh0pp/.crow/data/projects/2');
    -- real shape: a local-owner row (contact_id NULL) per project
    INSERT INTO project_members (uuid, project_id, contact_id, role) VALUES ('crow-own-6', 6, NULL, 'owner');
    INSERT INTO project_members (uuid, project_id, contact_id, role) VALUES ('crow-own-2', 2, NULL, 'owner');
    INSERT INTO project_members (uuid, project_id, contact_id, role) VALUES ('crow-pm-1', 6, 3, 'viewer');

    INSERT INTO memories (id, content, category, created_at) VALUES (1, 'shared memory', 'general', '2026-01-01 00:00:01');
    INSERT INTO memories (id, content, category, created_at) VALUES (2, 'crow memory two', 'general', '2026-01-01 00:00:02');
    INSERT INTO memories (id, content, category, created_at) VALUES (3, 'crow memory three', 'general', '2026-01-01 00:00:03');
    INSERT INTO memories (id, content, category, created_at, updated_at) VALUES (4, 'replicated memory, crow edit', 'general', '2026-01-01 00:00:04', '2026-03-01 00:00:00');
    INSERT INTO memory_embeddings_blob (memory_id, model, dim, vec) VALUES (1, 'qwen3-embedding-0.6b', 4, x'00000000');

    INSERT INTO messages (contact_id, nostr_event_id, content, direction, created_at) VALUES (3, 'ev-shared', 'hello both', 'received', '2026-02-01 00:00:00');

    INSERT INTO ramble_cells (cell, first_unlocked_at) VALUES ('9vg4zzz', 100);
    INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('earn', 'visit:9vg4zzz', 5, 100);
    INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('spend', 'egg:1', -2, 110);
    INSERT INTO ramble_credits (kind, key, credited_at) VALUES ('visit_place', '9vg4zzz:w1', 100);
    INSERT INTO ramble_settings (key, value) VALUES ('shared', 'crow-value');
    INSERT INTO ramble_pet (owner, mood) VALUES ('self', 'crow-mood');
    INSERT INTO dashboard_settings (key, value) VALUES ('blog_title', 'Crow blog');
    INSERT INTO dashboard_settings (key, value) VALUES ('tts_voice', 'crow-voice');
    INSERT INTO dashboard_settings (key, value) VALUES ('theme', 'crow-theme');
  `);
  db.close();
  return path;
}

/** grackle's crow.db as the W3 API backup would hold it. */
export async function buildSource(dir) {
  const path = initDb(dir);
  const db = new Database(path);
  await quiet(async () => {
    await bundleInit(db, "bundles/ramble/server/init-tables.js", "initRambleTables");
    await bundleInit(db, "bundles/knowledge-base/server/init-tables.js", "initKbTables");
    await bundleInit(db, "bundles/media/server/init-tables.js", "initMediaTables");
    await bundleInit(db, "bundles/data-dashboard/server/init-tables.js", "initDataDashboardTables");
  });
  ensureLamportOrigin(db);
  // grackle's research_sources carries two columns crow lacks (map: 16 rows filled)
  db.exec(`ALTER TABLE research_sources ADD COLUMN file_path TEXT; ALTER TABLE research_sources ADD COLUMN s3_key TEXT;`);
  // grackle's chat_messages has a different column ORDER (map) — rebuild it so
  // SELECT * order != the target's.
  db.exec(`
    DROP TABLE chat_messages;
    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      conversation_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      model_id TEXT, thread_id INTEGER, attachments TEXT,
      tool_calls TEXT, tool_call_id TEXT, tool_name TEXT, input_tokens INTEGER, output_tokens INTEGER
    );
  `);
  // unowned / archive-only tables (no repo owner; spec §4.2)
  db.exec(`
    CREATE TABLE pir_requests (id INTEGER PRIMARY KEY, request_no TEXT, status TEXT);
    CREATE TABLE capstone_pir_files (id INTEGER PRIMARY KEY, pir_id INTEGER, path TEXT);
    CREATE TABLE pipeline_runs (id INTEGER PRIMARY KEY, started_at TEXT);
    CREATE TABLE tax_returns (id INTEGER PRIMARY KEY, year INTEGER);
    CREATE TABLE crowclaw_bots (id INTEGER PRIMARY KEY, name TEXT);
  `);
  db.exec(`
    INSERT INTO crow_instances (id, name, crow_id, is_home) VALUES ('${GRACKLE_ID}', 'Grackle', 'crow:kdq7zskhat', 1);
    INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (9, 'crow:dayane', 'Dayane', 'ed', 'secp');
    INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, verified) VALUES (10, 'crow:nobody', 'Nobody', 'ed2', 'secp2', 1);
    INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, origin) VALUES (11, 'crow:gbot', 'Grackle bot', 'ed3', 'secp3', 'local-bot');

    -- projects: 1 and 5 are new; 6 is the same project as crow 6; 7 clashes on slug only
    INSERT INTO project_spaces (id, uuid, slug, name, workspace_dir) VALUES (1, 'g-uuid-1', 'proj-one', 'One', '/home/kh0pp/.crow/data/projects/1');
    INSERT INTO project_spaces (id, uuid, slug, name, workspace_dir) VALUES (5, 'g-uuid-5', 'proj-five', 'Five', '/home/kh0pp/.crow/data/projects/5');
    INSERT INTO project_spaces (id, uuid, slug, name, workspace_dir) VALUES (6, 'g-uuid-6', 'tea-data', 'TEA data', '/home/kh0pp/.crow/data/projects/6');
    INSERT INTO project_spaces (id, uuid, slug, name, workspace_dir) VALUES (7, 'g-uuid-7', 'clash', 'Grackle clash', '/elsewhere/7');
    -- real shape: grackle's OWN local-owner rows, with their own uuids
    INSERT INTO project_members (uuid, project_id, contact_id, role) VALUES ('g-own-1', 1, NULL, 'owner');
    INSERT INTO project_members (uuid, project_id, contact_id, role) VALUES ('g-own-5', 5, NULL, 'owner');
    INSERT INTO project_members (uuid, project_id, contact_id, role) VALUES ('g-own-6', 6, NULL, 'owner');
    INSERT INTO project_members (uuid, project_id, contact_id, role) VALUES ('g-own-7', 7, NULL, 'owner');
    -- same contact as crow's member on 6, different role → matches (crow's kept)
    INSERT INTO project_members (uuid, project_id, contact_id, role) VALUES ('g-pm-1', 6, 9, 'editor');
    -- a contact crow lacks but would sync → the contact is imported, the grant follows it
    INSERT INTO project_members (uuid, project_id, contact_id, role) VALUES ('g-pm-2', 1, 10, 'viewer');
    -- a local-bot contact (never synced) → the grant goes to the extract, NEVER becomes "local user"
    INSERT INTO project_members (uuid, project_id, contact_id, role) VALUES ('g-pm-3', 5, 11, 'editor');
    INSERT INTO project_audit_log (project_id, actor_type, action, created_at) VALUES (5, 'local', 'create', '2026-05-01 00:00:00');

    -- memories: 1 matches crow's content (different created_at); 2 and 3 collide on id only;
    -- 4 is crow's 4 (same id + created_at) edited on grackle; 6..8 are new
    INSERT INTO memories (id, content, category, created_at) VALUES (1, 'shared memory', 'general', '2026-01-02 00:00:01');
    INSERT INTO memories (id, content, category, project_id, created_at) VALUES (2, 'grackle memory two', 'general', 6, '2026-01-02 00:00:02');
    INSERT INTO memories (id, content, category, project_id, created_at) VALUES (3, 'grackle memory three', 'project', 5, '2026-01-02 00:00:03');
    INSERT INTO memories (id, content, category, created_at, updated_at) VALUES (4, 'replicated memory, grackle edit', 'general', '2026-01-01 00:00:04', '2026-04-01 00:00:00');
    INSERT INTO memories (id, content, category, created_at) VALUES (6, 'grackle memory six', 'general', '2026-01-02 00:00:06');
    INSERT INTO memories (id, content, category, created_at) VALUES (7, 'grackle memory seven', 'general', '2026-01-02 00:00:07');
    INSERT INTO memories (id, content, category, created_at) VALUES (8, 'grackle memory eight', 'general', '2026-01-02 00:00:08');
    INSERT INTO memory_embeddings_blob (memory_id, model, dim, vec) VALUES (2, 'qwen3-embedding-0.6b', 4, x'02020202');
    INSERT INTO memory_embeddings_blob (memory_id, model, dim, vec) VALUES (7, 'qwen3-embedding-0.6b', 4, x'07070707');

    INSERT INTO research_sources (id, project_id, title, source_type, citation_apa, url, s3_key, file_path)
      VALUES (1, 6, 'TEA report', 'government_doc', 'TEA (2026).', 'https://tea.example/r', 'capstone/r1.pdf', '/home/kh0pp/pdfs/r1.pdf');
    INSERT INTO research_sources (id, project_id, title, source_type, citation_apa, url)
      VALUES (2, 1, 'Other', 'web_article', 'Other (2026).', 'https://ex.example/o');
    INSERT INTO source_embeddings (source_id, model, dim, vec) VALUES (1, 'qwen3-embedding-0.6b', 4, x'01010101');
    INSERT INTO research_notes (id, project_id, source_id, title, content, uuid) VALUES (1, 1, 2, 'n1', 'note one', 'g-note-1');
    INSERT INTO research_notes (id, project_id, title, content, uuid) VALUES (2, 5, 'n2', 'note two', 'g-note-2');
    INSERT INTO note_embeddings (note_id, model, dim, vec) VALUES (1, 'qwen3-embedding-0.6b', 4, x'0a0a0a0a');
    INSERT INTO glasses_note_sessions (id, device_id, mode, started_at, project_id, note_id) VALUES (1, 'glasses-1', 'session', '2026-06-01 10:00:00', 5, 2);

    -- already-synced tables: one row crow has, one only grackle has
    INSERT INTO messages (contact_id, nostr_event_id, content, direction, created_at) VALUES (9, 'ev-shared', 'hello both', 'received', '2026-02-01 00:00:00');
    INSERT INTO messages (contact_id, nostr_event_id, content, direction, created_at) VALUES (9, 'ev-grackle', 'only on grackle', 'sent', '2026-02-02 00:00:00');
    INSERT INTO messages (contact_id, nostr_event_id, content, direction, created_at) VALUES (11, 'ev-bot', 'bot chatter', 'received', '2026-02-03 00:00:00');
    INSERT INTO crow_context (section_key, section_title, content) VALUES ('grackle_notes', 'Grackle notes', 'only on grackle');

    INSERT INTO blog_posts (id, slug, title, content, status) VALUES (8, 'post-eight', 'Eight', 'body eight', 'draft');
    INSERT INTO blog_posts (id, slug, title, content, status) VALUES (9, 'post-nine', 'Nine', 'body nine', 'draft');
    INSERT INTO blog_post_embeddings (post_id, model, dim, vec) VALUES (8, 'qwen3-embedding-0.6b', 4, x'08080808');
    INSERT INTO blog_comments (post_id, contact_id, author_name, content, status, created_at) VALUES (8, 9, 'Dayane', 'nice', 'approved', '2026-05-05 00:00:00');
    INSERT INTO songbook_setlists (id, name, created_at) VALUES (1, 'Sunday', '2026-05-01 00:00:00');
    INSERT INTO songbook_setlist_items (setlist_id, post_id, position) VALUES (1, 9, 1);
    INSERT INTO crosspost_rules (source_app, source_trigger, target_app, created_at, updated_at) VALUES ('blog', 'publish', 'mastodon', 1, 1);
    INSERT INTO schedules (task, cron_expression, description) VALUES ('blog-digest', '0 9 * * 1', 'weekly digest');

    INSERT INTO chat_conversations (id, title, provider, model, created_at) VALUES (1, 'chat', 'crow-chat', 'qwen', '2026-05-02 00:00:00');
    INSERT INTO chat_messages (id, content, role, conversation_id, created_at) VALUES (1, 'hello', 'user', 1, '2026-05-02 00:00:01');
    INSERT INTO chat_messages (id, content, role, conversation_id, created_at) VALUES (2, 'hi there', 'assistant', 1, '2026-05-02 00:00:02');

    INSERT INTO glasses_photos (id, device_id, captured_at, minio_key, mime, size_bytes) VALUES (1, 'glasses-1', '2026-06-01 10:01:00', 'glasses/p1.jpg', 'image/jpeg', 10);
    INSERT INTO storage_files (id, s3_key, original_name, project_id, reference_type, reference_id) VALUES (1, 'files/a.pdf', 'a.pdf', 6, 'blog_post', 8);
    INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES ('grackle-assistant', 'Grackle Assistant', '{}', 1, 5);
    INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES ('home-search', 'Home search', '{}', 1);
    INSERT INTO bot_runs (run_id, bot_id, status) VALUES ('run-1', 'grackle-assistant', 'done');
    INSERT INTO job_search_sites (id, name, source_type, url, scrape_strategy, tier) VALUES ('edjoin', 'EdJoin', 'board', 'https://edjoin.example', 'html', 1);

    -- ramble: one cell + one wallet row crow already has (crow wins), the rest grackle-only
    INSERT INTO ramble_cells (cell, first_unlocked_at) VALUES ('9vg4zzz', 50);
    INSERT INTO ramble_cells (cell, first_unlocked_at) VALUES ('9vg4yyy', 60);
    INSERT INTO ramble_cells (cell, first_unlocked_at) VALUES ('9vg4xxx', 70);
    INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('earn', 'visit:9vg4zzz', 99, 50);
    INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('earn', 'visit:9vg4yyy', 5, 60);
    INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('earn', 'visit:9vg4xxx', 7, 70);
    INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('spend', 'egg:2', -3, 80);
    INSERT INTO ramble_credits (kind, key, credited_at) VALUES ('visit_place', '9vg4zzz:w1', 50);
    INSERT INTO ramble_credits (kind, key, credited_at) VALUES ('visit_place', '9vg4yyy:w1', 60);
    INSERT INTO ramble_nest_claims (cell, week, egg_id, claimed_at) VALUES ('9vg4yyy', '2026-W30', 'egg-g1', 60);
    -- synced ramble rows that never reached crow (I7)
    INSERT INTO ramble_eggs (egg_id, status, species, created_at, lamport_ts, lamport_origin) VALUES ('egg-g1', 'shelf', 'robin', 60, 41, '${GRACKLE_ID}');
    INSERT INTO ramble_settings (key, value) VALUES ('shared', 'grackle-value');
    INSERT INTO ramble_settings (key, value) VALUES ('only_grackle', 'g');
    INSERT INTO ramble_pet (owner, mood) VALUES ('self', 'grackle-mood');
    INSERT INTO ramble_marks (mark_id, author, kind, anchor_kind, content_text, created_at) VALUES ('mark-g1', 'me', 'note', 'geo', 'a grackle mark', 60);

    INSERT INTO kb_collections (id, slug, name) VALUES (1, 'guide', 'Guide');
    INSERT INTO kb_categories (id, collection_id, slug) VALUES (1, 1, 'housing');
    INSERT INTO kb_category_names (category_id, language, name) VALUES (1, 'en', 'Housing');
    INSERT INTO kb_articles (id, collection_id, category_id, pair_id, language, slug, title, content) VALUES (1, 1, 1, 'pair-1', 'en', 'rent', 'Rent', 'rent help');

    INSERT INTO media_sources (id, name, url) VALUES (1, 'Feed', 'https://feed.example/rss');
    INSERT INTO media_articles (id, source_id, guid, title) VALUES (1, 1, 'g1', 'A1');
    INSERT INTO media_articles (id, source_id, guid, title) VALUES (2, 1, 'g2', 'A2');
    INSERT INTO media_briefings (id, title, created_at) VALUES (1, 'Morning', '2026-06-01 06:00:00');
    INSERT INTO media_playlists (id, name, auto_generated, created_at) VALUES (1, 'Manual', 0, '2026-06-01 00:00:00');
    INSERT INTO media_playlists (id, name, auto_generated, created_at) VALUES (2, 'Auto', 1, '2026-06-01 00:00:00');
    INSERT INTO media_playlist_items (playlist_id, item_type, item_id, position) VALUES (1, 'briefing', 1, 1);
    INSERT INTO media_playlist_items (playlist_id, item_type, item_id, position) VALUES (1, 'article', 2, 2);
    INSERT INTO media_playlist_items (playlist_id, item_type, item_id, position) VALUES (2, 'article', 1, 1);
    INSERT INTO media_digest_preferences (id, schedule, created_at) VALUES (1, 'daily_morning', '2026-06-01 00:00:00');

    INSERT INTO data_case_studies (id, project_id, title, created_at) VALUES (3, 6, 'Case', '2026-06-01 00:00:00');
    INSERT INTO data_case_study_sections (id, case_study_id, section_type, sort_order, title, created_at) VALUES (40, 3, 'chart', 1, 'Fig', '2026-06-01 00:00:00');

    INSERT INTO pir_requests (id, request_no, status) VALUES (1, 'R-1', 'open'), (2, 'R-2', 'closed');
    INSERT INTO capstone_pir_files (id, pir_id, path) VALUES (1, 1, 'x.pdf');
    INSERT INTO pipeline_runs (id, started_at) VALUES (1, '2026-06-01');
    INSERT INTO tax_returns (id, year) VALUES (1, 2025);
    INSERT INTO crowclaw_bots (id, name) VALUES (1, 'claw');

    INSERT INTO notifications (title) VALUES ('n1'), ('n2'), ('n3');
    INSERT INTO oauth_clients (client_id, metadata) VALUES ('c1', '{}');

    INSERT INTO dashboard_settings (key, value) VALUES ('blog_title', 'Maestro Press');
    INSERT INTO dashboard_settings (key, value) VALUES ('blog_custom_css', 'body{}');
    INSERT INTO dashboard_settings (key, value) VALUES ('tts_voice', 'grackle-voice');
    INSERT INTO dashboard_settings (key, value) VALUES ('meta_glasses_devices', '[]');
    INSERT INTO dashboard_settings (key, value) VALUES ('theme', 'grackle-theme');
    INSERT INTO dashboard_settings (key, value) VALUES ('integration_api_key', 'sekrit');
    INSERT INTO dashboard_settings_overrides (key, instance_id, value) VALUES ('meta_glasses_default_project_id', '${GRACKLE_ID}', '5');
  `);
  db.close();
  return path;
}

/** Both DBs + a crow data dir (instance-id) under root. */
export async function buildPair(root, opts = {}) {
  const source = await buildSource(join(root, "grackle"));
  const target = await buildTarget(join(root, "crow"), opts);
  return { source, target, crowDataDir: join(root, "crow") };
}

/** Peer flags covering every live peer of the fixture target (black-swan, raven; MPA excluded). */
export function fixturePeerFlags({ blackSwan = 1, raven = 0 } = {}) {
  const peerMaxId = [];
  for (const t of ["memories", "research_notes", "glasses_note_sessions"]) {
    peerMaxId.push(`${t}:${BLACK_SWAN_ID}=${blackSwan}`, `${t}:${RAVEN_ID}=${raven}`);
  }
  return { peerMaxId, peerMaxMemoryId: [], peerExclude: [MPA_ID] };
}
