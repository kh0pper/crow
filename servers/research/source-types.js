// The research_sources.source_type values: the CHECK constraint in scripts/init-db.js, the zod
// enums in servers/research/server.js, and the share-import whitelist in
// servers/sharing/shared-source-insert.js all name this one list.
export const SOURCE_TYPES = Object.freeze([
  "web_article", "academic_paper", "book", "interview",
  "web_search", "web_scrape", "api_data", "document",
  "video", "podcast", "social_media", "government_doc",
  "dataset", "other",
]);
