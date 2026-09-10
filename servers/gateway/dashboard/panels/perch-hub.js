/**
 * Perch Hub Panel — bot chat surface, registered so it gets a nav entry and
 * a launcher icon like every other panel (it did not, before this file —
 * it was a bare route mounted straight onto /dashboard from index.js).
 *
 * Renders its OWN standalone document (perchHubDocument), never the
 * dashboard shell: dashboard/index.js's panel dispatcher only sends
 * `result` when `!res.headersSent` ("Handler may have already sent
 * response"), so a panel handler is free to write its own response, and
 * Perch relies on that — the panel shell is what made the old drawer
 * cramped on a phone. This handler must never call layout().
 */

import { perchHubDocument } from "../perch-hub/html.js";
import { engineStatus } from "../../bot-engine-status.js";

export default {
  id: "perch",
  name: "Perch Hub",
  icon: "messages",
  route: "/dashboard/perch",
  navOrder: 15.5,
  category: "ai",

  async handler(req, res, { lang }) {
    // engineStatus() is a LEAF module of synchronous fs stats
    // (bot-engine-status.js:84) — safe and cheap from a route. /roost cannot
    // report engine state, so without this the list looks normal and the
    // first tap fails with a raw error.
    res.type("html").send(perchHubDocument(lang, engineStatus()));
  },
};
