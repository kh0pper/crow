/**
 * Project home client: the shared "Start a session" control's script
 * (shared/session-cards.js startControlJs). Its button sits in the
 * server-rendered start section, which names the project (data-project-id,
 * data-project-slug), so the new session is filed here and opens at
 * /dashboard/perch?project=<slug>#<sessionId>.
 */
import { startControlJs } from "../../shared/session-cards.js";

export function projectHomeClientJs(lang) {
  return startControlJs(lang);
}
