/**
 * AI Article Analyzer
 *
 * Uses Crow's BYOAI system to analyze articles: generates summaries,
 * extracts topics, categories, entities, and sentiment scores.
 * Only runs in gateway mode (background tasks). Skips gracefully if
 * no AI provider is configured.
 */

const CATEGORIES = [
  "politics", "technology", "business", "science", "health",
  "sports", "entertainment", "world", "opinion", "environment",
  "education", "culture", "other"
];

const ANALYSIS_PROMPT = `Analyze this article and respond with ONLY valid JSON (no markdown, no explanation):
{
  "summary": "2-3 sentence summary",
  "topics": ["3-5 topic strings"],
  "categories": ["1-3 categories from: ${CATEGORIES.join(", ")}"],
  "sentiment_score": 0.0,
  "key_entities": [{"name": "entity name", "type": "person|org|place|event"}]
}

sentiment_score: -1.0 (very negative) to 1.0 (very positive), 0.0 is neutral.`;

/**
 * Analyze a single article using the AI adapter.
 */
async function analyzeArticle(adapter, title, content) {
  const truncated = content.length > 3000 ? content.slice(0, 3000) + "..." : content;
  const messages = [
    { role: "user", content: `${ANALYSIS_PROMPT}\n\nTitle: ${title}\n\nContent:\n${truncated}` },
  ];

  let result = "";
  for await (const event of adapter.chatStream(messages, [], {})) {
    if (event.type === "content_delta") {
      result += event.content;
    }
    if (event.type === "done") break;
  }

  // Strip markdown code fences if present
  result = result.trim();
  if (result.startsWith("```")) {
    result = result.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  const parsed = JSON.parse(result);

  // Validate and sanitize
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 2000) : null,
    topics: Array.isArray(parsed.topics) ? parsed.topics.slice(0, 10).map(String) : [],
    categories: Array.isArray(parsed.categories)
      ? parsed.categories.filter(c => CATEGORIES.includes(c)).slice(0, 5)
      : [],
    sentiment_score: typeof parsed.sentiment_score === "number"
      ? Math.max(-1, Math.min(1, parsed.sentiment_score))
      : 0,
    key_entities: Array.isArray(parsed.key_entities)
      ? parsed.key_entities.slice(0, 20).map(e => ({
          name: String(e.name || "").slice(0, 200),
          type: ["person", "org", "place", "event"].includes(e.type) ? e.type : "other",
        }))
      : [],
  };
}

/**
 * Process a batch of articles for AI analysis.
 * Skips if no AI provider configured or CROW_MEDIA_LITE is set.
 */
export async function analyzeArticleBatch(db, limit = 5) {
  if (process.env.CROW_MEDIA_LITE === "1") {
    return { processed: 0, skipped: 0, errors: 0 };
  }

  // Dynamic import — only works in gateway mode
  let getProviderConfig, createProviderAdapter;
  try {
    const provider = await import("../../gateway/ai/provider.js");
    getProviderConfig = provider.getProviderConfig;
    createProviderAdapter = provider.createProviderAdapter;
  } catch {
    // Not in gateway mode (stdio) — skip silently
    return { processed: 0, skipped: 0, errors: 0 };
  }

  const config = getProviderConfig();
  if (!config) {
    // No AI provider configured — mark pending as skipped
    await db.execute({
      sql: "UPDATE media_articles SET ai_analysis_status = 'skipped' WHERE ai_analysis_status = 'pending'",
      args: [],
    });
    return { processed: 0, skipped: 0, errors: 0 };
  }

  const { rows } = await db.execute({
    sql: `SELECT id, title, content_full, content_raw, summary FROM media_articles
          WHERE ai_analysis_status = 'pending'
          AND (content_full IS NOT NULL OR content_raw IS NOT NULL OR summary IS NOT NULL)
          LIMIT ?`,
    args: [limit],
  });

  if (rows.length === 0) return { processed: 0, skipped: 0, errors: 0 };

  let adapter;
  try {
    const result = await createProviderAdapter();
    adapter = result.adapter;
  } catch (err) {
    console.error("[ai-analyzer] Failed to create adapter:", err.message);
    return { processed: 0, skipped: 0, errors: rows.length };
  }

  let processed = 0, errors = 0;

  for (const article of rows) {
    const content = article.content_full || article.content_raw || article.summary || "";
    if (!content) {
      await db.execute({ sql: "UPDATE media_articles SET ai_analysis_status = 'skipped' WHERE id = ?", args: [article.id] });
      continue;
    }

    try {
      const analysis = await analyzeArticle(adapter, article.title, content);

      await db.execute({
        sql: `UPDATE media_articles SET
                summary = COALESCE(?, summary),
                topics = ?,
                categories = ?,
                sentiment_score = ?,
                key_entities = ?,
                ai_analysis_status = 'done'
              WHERE id = ?`,
        args: [
          analysis.summary,
          JSON.stringify(analysis.topics),
          JSON.stringify(analysis.categories),
          analysis.sentiment_score,
          JSON.stringify(analysis.key_entities),
          article.id,
        ],
      });
      processed++;
    } catch (err) {
      console.error(`[ai-analyzer] Article ${article.id} failed:`, err.message);
      await db.execute({
        sql: "UPDATE media_articles SET ai_analysis_status = 'failed' WHERE id = ?",
        args: [article.id],
      }).catch(() => {});
      errors++;
    }
  }

  return { processed, skipped: 0, errors };
}
