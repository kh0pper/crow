/**
 * Maker Lab — hint pipeline.
 *
 * Handles the full `maker_hint` request lifecycle:
 *   state machine → rate limit → LLM call (OpenAI-compat) → filter → fallback → transcript.
 *
 * Used by:
 *   - server.js (MCP tool handler)
 *   - panel/routes.js POST /kiosk/api/hint (HTTP from tutor-bridge.js)
 *
 * The LLM endpoint is any OpenAI-compatible chat-completions surface
 * (Ollama `/v1/chat/completions`, vLLM, LocalAI, etc.). Configured via
 * MAKER_LAB_LLM_ENDPOINT + MAKER_LAB_LLM_MODEL env vars. On failure or
 * filter rejection, returns a canned hint — kids never see raw errors.
 */

import {
  filterHint,
  rateLimitCheck,
  pickCannedHint,
  resolvePersonaForSession,
} from "./filters.js";
import { resolveLlmEndpoint } from "./resolve-llm-endpoint.js";

const LLM_TIMEOUT_MS = 15_000;

const PERSONA_PROMPT = {
  "kid-tutor":
    "You are a patient, warm coding tutor for a child age 5 to 9. Reply in ONE short hint. " +
    "Use 1st-3rd grade words. Short sentences. At most 40 words. Never say the answer — guide them with a question or a nudge. " +
    "No scary, violent, or adult words. If you can't help with this, offer a friendly simple suggestion about blocks.",
  "tween-tutor":
    "You are a scaffolding tutor for a tween age 10 to 13. Reply with ONE short hint, at most 80 words. " +
    "Use middle-grade vocabulary. Prefer guiding questions over direct answers, but you may explain a concept briefly if asked.",
  "adult-tutor":
    "You are a concise technical tutor for a self-learner age 14 or older. Reply with ONE focused explanation, at most 200 words. " +
    "Plain language, precise terminology. Direct Q&A is fine; no hint ladder required.",
};

function resolveApiKey() {
  return process.env.MAKER_LAB_LLM_API_KEY || "not-needed";
}

async function callLLM({ persona, question, lesson }) {
  // Phase 4b — auto-detect vLLM / Ollama on first call, cache the
  // resolution for the life of the process. Explicit
  // MAKER_LAB_LLM_ENDPOINT still wins.
  const resolved = await resolveLlmEndpoint();
  const endpoint = resolved.endpoint;
  const model = resolved.model;
  const url = `${endpoint}/chat/completions`;

  const systemPrompt = PERSONA_PROMPT[persona] || PERSONA_PROMPT["kid-tutor"];
  const lessonContext = lesson ? `\n\nCurrent lesson: ${lesson.title || lesson.id || ""}. Goal: ${lesson.goal || lesson.prompt || ""}.` : "";

  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: systemPrompt + lessonContext },
      { role: "user", content: question },
    ],
    temperature: 0.6,
    max_tokens: 220,
    stream: false,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${resolveApiKey()}`,
      },
      body,
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      return { ok: false, reason: `llm_http_${resp.status}` };
    }
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return { ok: false, reason: "llm_empty_response" };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, reason: `llm_${err.name || "error"}:${err.message?.slice(0, 80)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function maybeWriteTranscript(db, session, sessionToken, kidText, tutorText) {
  if (!session.transcripts_enabled_snapshot || session.is_guest || !session.learner_id) return;
  try {
    const t = await db.execute({
      sql: `SELECT COALESCE(MAX(turn_no), 0) AS n FROM maker_transcripts WHERE session_token=?`,
      args: [sessionToken],
    });
    const n = Number(t.rows[0].n) + 1;
    await db.execute({
      sql: `INSERT INTO maker_transcripts (learner_id, session_token, turn_no, role, content)
            VALUES (?, ?, ?, 'kid', ?)`,
      args: [session.learner_id, sessionToken, n, kidText],
    });
    await db.execute({
      sql: `INSERT INTO maker_transcripts (learner_id, session_token, turn_no, role, content)
            VALUES (?, ?, ?, 'tutor', ?)`,
      args: [session.learner_id, sessionToken, n + 1, tutorText],
    });
  } catch {
    // transcript failures must not break the hint
  }
}

/**
 * Core hint handler.
 * @param {object} db libsql client
 * @param {object} args { sessionToken, session, surface, question, level, lessonId, cannedHints, lesson }
 * @returns {Promise<{level:number, persona:string, surface?:string, lesson_id?:string|null, text:string, source:string, filtered_reason?:string}>}
 */
export async function handleHintRequest(db, args) {
  const {
    sessionToken,
    session,
    surface = "",
    question,
    level = 1,
    lessonId = null,
    cannedHints = null,
    lesson = null,
  } = args;

  const persona = await resolvePersonaForSession(db, session);

  // ending state: wrap-up, bypass queue + LLM + rate limiter.
  if (session.state === "ending") {
    return {
      level, persona, surface, lesson_id: lessonId,
      text: "Great work! Let's get ready to wrap up.",
      source: "canned_ending",
    };
  }

  // rate limit
  if (!rateLimitCheck(sessionToken)) {
    return {
      level, persona, surface, lesson_id: lessonId,
      text: "Let's think for a minute before asking again!",
      source: "rate_limited",
    };
  }

  // Call the LLM. On any failure or filter rejection, fall back to canned.
  let text;
  let source = "llm";
  let filteredReason = null;

  const llm = await callLLM({ persona, question, lesson });
  if (llm.ok) {
    const filtered = filterHint(llm.text, persona);
    if (filtered.ok) {
      text = filtered.text;
    } else {
      filteredReason = filtered.reason;
      // Try one retry with a canned lesson hint (no LLM).
      const retry = filterHint(pickCannedHint(persona, { cannedHints, level }), persona);
      text = retry.ok ? retry.text : pickCannedHint(persona, { level });
      source = "canned_filtered";
    }
  } else {
    text = pickCannedHint(persona, { cannedHints, level });
    source = `canned_${llm.reason}`;
  }

  // Update session stats + activity
  await db.execute({
    sql: `UPDATE maker_sessions
          SET hints_used = hints_used + 1,
              last_activity_at = datetime('now'),
              idle_locked_at = NULL
          WHERE token = ?`,
    args: [sessionToken],
  });

  await maybeWriteTranscript(db, session, sessionToken, question, text);

  return {
    level, persona, surface, lesson_id: lessonId,
    text, source,
    ...(filteredReason ? { filtered_reason: filteredReason } : {}),
  };
}
