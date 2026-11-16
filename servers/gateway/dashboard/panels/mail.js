/**
 * Crow Mail, the reader panel: /dashboard/mail, a hidden page beside For You, reached from the
 * shell's drawer ("More of Crow"). One page draws every view, chosen by the query string
 * (`view`, `acct`, `folder`, `a`, `mid`, `row`, `q`, `cursor`); this module is the gate and the
 * request's reads, `panels/mail/html.js` is the markup and `panels/mail/css.js` the styles.
 *
 * Gates, in this order, on every method:
 *   - CROW_MAIL must be "1" (mailEnabled), else 404;
 *   - the request must be the owner's own local password session (isLocalPasswordSessionOn), else
 *     404: a shared-project member's or a paired instance's SSO session never sees this page;
 *   - any method but GET and HEAD is a 404. The page posts nothing: every action it offers goes to
 *     /dashboard/mail/api, which carries its own CSRF check and its own guards.
 * The GET only reads (Turbo prefetches it).
 *
 * What it reads is `accountsOverview` — the same shape `GET /dashboard/mail/api/accounts` returns,
 * which holds no host, port, username or secret — and nothing else, until the inbox view lands.
 *
 * Hidden from the classic sidebar; the shell's drawer reveals it (shell/chrome.js) only while the
 * flag is on AND the request is the owner's own local password session (the same check as the gate
 * below, made once per page in dispatchPanel).
 */
import { t } from "../shared/i18n.js";
import { isLocalPasswordSessionOn } from "../local-session.js";
import { mailEnabled } from "../../mail/flag.js";
import { accountsOverview } from "../../mail/accounts-overview.js";
import { getOrCreateLocalInstanceId } from "../../instance-registry.js";
import { renderMailPage } from "./mail/html.js";
import { mailCss } from "./mail/css.js";

export default {
  id: "mail",
  name: "Mail",
  icon: "messages",
  route: "/dashboard/mail",
  navOrder: 15.8,
  category: "ai",
  hidden: true, // reached from the shell's drawer ("More of Crow")

  async handler(req, res, { db, layout, lang, enabled = mailEnabled }) {
    if (!enabled() || !(await isLocalPasswordSessionOn(db, req))) {
      res.status(404).type("text").send("Not found");
      return null;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(404).type("text").send("Not found");
      return null;
    }
    const view = typeof req.query.view === "string" && req.query.view ? req.query.view : "inbox";
    // This instance's own id: the claim rules compare every held address against it.
    const localInstanceId = getOrCreateLocalInstanceId();
    const { accounts, elsewhere } = await accountsOverview(db, { localInstanceId });
    return layout({
      title: t("mail.title", lang),
      content: mailCss() + renderMailPage({ view, accounts, elsewhere, lang }),
    });
  },
};