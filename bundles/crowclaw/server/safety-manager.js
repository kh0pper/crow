/**
 * CrowClaw — Safety Manager
 *
 * Content moderation (OpenAI Moderation API), PII detection,
 * and safety event audit logging.
 */

// PII regex patterns
const PII_PATTERNS = {
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  credit_card: /\b(?:\d{4}[- ]?){3}\d{4}\b/g,
  phone: /\b(?:\+?1[-. ]?)?\(?[2-9]\d{2}\)?[-. ]?\d{3}[-. ]?\d{4}\b/g,
};

/**
 * Check text for PII patterns.
 * @returns {{ found: boolean, matches: Record<string, string[]> }}
 */
export function detectPII(text, patterns = ["ssn", "credit_card", "phone"]) {
  const matches = {};
  let found = false;

  for (const name of patterns) {
    const regex = PII_PATTERNS[name];
    if (!regex) continue;
    const hits = text.match(regex);
    if (hits && hits.length > 0) {
      matches[name] = hits.map(h => h.slice(0, 4) + "***"); // redacted
      found = true;
    }
  }

  return { found, matches };
}

/**
 * Call OpenAI Moderation API (free, no key needed for omni-moderation-latest).
 * @param {string} text - Text to moderate
 * @param {string} [apiKey] - Optional OpenAI API key
 * @returns {{ flagged: boolean, categories: Record<string, boolean>, scores: Record<string, number> }}
 */
export async function moderateContent(text, apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  try {
    const resp = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers,
      body: JSON.stringify({ input: text }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      return { flagged: false, error: `Moderation API returned ${resp.status}` };
    }

    const data = await resp.json();
    const result = data.results?.[0];
    if (!result) return { flagged: false, error: "No results from moderation API" };

    return {
      flagged: result.flagged,
      categories: result.categories,
      scores: result.category_scores,
    };
  } catch (err) {
    return { flagged: false, error: `Moderation API error: ${err.message}` };
  }
}

/**
 * Run full safety check on text using a bot's safety policy.
 */
export async function runSafetyCheck(db, botId, text, userId) {
  const bot = await db.execute({ sql: "SELECT safety_policy_json FROM crowclaw_bots WHERE id = ?", args: [botId] });
  const policy = bot.rows[0]?.safety_policy_json ? JSON.parse(bot.rows[0].safety_policy_json) : {};

  const results = { passed: true, events: [] };

  // PII check
  if (policy.pii_redaction?.enabled) {
    const pii = detectPII(text, policy.pii_redaction.patterns);
    if (pii.found) {
      results.passed = false;
      const event = { event_type: "pii_detected", severity: "warning", details: pii.matches, userId };
      results.events.push(event);
      await logSafetyEvent(db, botId, event);
    }
  }

  // Content moderation
  if (policy.content_moderation?.enabled) {
    const modResult = await moderateContent(text);
    if (modResult.flagged) {
      // Check against thresholds
      const thresholds = policy.content_moderation.thresholds || {};
      const flaggedCategories = {};
      for (const [cat, score] of Object.entries(modResult.scores || {})) {
        const threshold = thresholds[cat] ?? 0.5;
        if (score >= threshold) flaggedCategories[cat] = score;
      }

      if (Object.keys(flaggedCategories).length > 0) {
        results.passed = false;
        const event = {
          event_type: "content_moderation",
          severity: "high",
          details: flaggedCategories,
          userId,
        };
        results.events.push(event);
        await logSafetyEvent(db, botId, event);
      }
    }
  }

  return results;
}

/**
 * Log a safety event to the audit table.
 */
export async function logSafetyEvent(db, botId, { event_type, severity, details, userId }) {
  await db.execute({
    sql: "INSERT INTO crowclaw_safety_events (bot_id, event_type, severity, details_json, user_id) VALUES (?, ?, ?, ?, ?)",
    args: [botId, event_type, severity || "info", JSON.stringify(details), userId || null],
  });
}

/**
 * Get recent safety events for a bot.
 */
export async function getSafetyEvents(db, botId, { limit = 50 } = {}) {
  const { rows } = await db.execute({
    sql: "SELECT * FROM crowclaw_safety_events WHERE bot_id = ? ORDER BY timestamp DESC LIMIT ?",
    args: [botId, limit],
  });
  return rows;
}
