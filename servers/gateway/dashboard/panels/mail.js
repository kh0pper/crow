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
 * which holds no host, port, username or secret — plus, for the inbox view, plan 1's folder and
 * message stores: `listFolders` for the drawer, `getFolder` to resolve a folder link, and
 * `listMessages` for one page of rows (the `inbox` role across accounts on the All view, one folder
 * when a folder link was followed). The times are drawn in the instance's zone (`instanceZone`).
 *
 * The `message` view reads the row a link names (`resolveMessageRef`: the row id is only a hint, and
 * is used only when it belongs to the account and its Message-ID is the link's) and then the whole
 * conversation (`listThreadMessages`, each entry looked up so its section knows whether it has a
 * body and which attachments it has). A link that resolves to nothing gets the not-here page.
 * Neither view writes anything: the body comes from the frame route, never from this page.
 *
 * Hidden from the classic sidebar; the shell's drawer reveals it (shell/chrome.js) only while the
 * flag is on AND the request is the owner's own local password session (the same check as the gate
 * below, made once per page in dispatchPanel).
 */
import { t } from "../shared/i18n.js";
import { isLocalPasswordSessionOn } from "../local-session.js";
import { mailEnabled } from "../../mail/flag.js";
import { accountsOverview } from "../../mail/accounts-overview.js";
import { MailError } from "../../mail/errors.js";
import { getFolder, getMessage, listFolders, listMessages } from "../../mail/store/messages.js";
import { listThreadMessages, resolveMessageRef } from "../../mail/store/reader-queries.js";
import { getOrCreateLocalInstanceId } from "../../instance-registry.js";
import { instanceZone } from "../../../shared/schedule-store.js";
import { renderMailPage } from "./mail/html.js";
import { mailCss } from "./mail/css.js";

/** Rows per page. The cursor is the only way to the next one. */
const INBOX_PAGE_SIZE = 30;

/** The list a message view goes back to when its `back` says nothing usable. */
const INBOX_HREF = "/dashboard/mail";

/**
 * One page of summaries. A cursor is opaque and comes back from a link a person may have edited, so
 * one that does not decode starts again at the first page instead of failing the whole view.
 */
async function readPage(db, { accountId = null, folderId = null, cursor } = {}) {
  const optionsFor = (want) => (folderId === null
    ? { accountId, role: "inbox", limit: INBOX_PAGE_SIZE, cursor: want }
    : { folderId, limit: INBOX_PAGE_SIZE, cursor: want });
  const wanted = typeof cursor === "string" && cursor !== "" ? cursor : undefined;
  try {
    return await listMessages(db, optionsFor(wanted));
  } catch (err) {
    if (wanted === undefined || !(err instanceof MailError) || err.code !== "BAD_INPUT") throw err;
    return listMessages(db, optionsFor(undefined));
  }
}

/**
 * The list a message view's back link may name: a link back into this panel's own list view, or the
 * inbox. A query value is never followed anywhere else.
 */
function readBack(value) {
  if (typeof value !== "string" || value.length > 512) return INBOX_HREF;
  return /^\/dashboard\/mail\?/.test(value) ? value : INBOX_HREF;
}

/**
 * One conversation as full rows, in Task 1's order: the thread listing answers summaries, and a
 * section needs its own body state (has it anything to show?) and its own attachment list, so each
 * summary is looked up. Nothing here writes; the bodies never reach the page.
 */
async function readThread(db, message) {
  if (message.threadId == null) return [message];
  const entries = await listThreadMessages(db, message.accountId, message.threadId);
  const rows = [];
  for (const entry of entries) {
    const row = await getMessage(db, entry.id);
    if (row) rows.push(row);
  }
  return rows;
}

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
    const query = req.query || {};
    const view = typeof query.view === "string" && query.view ? query.view : "inbox";
    // This instance's own id: the claim rules compare every held address against it.
    const localInstanceId = getOrCreateLocalInstanceId();
    const { accounts, elsewhere } = await accountsOverview(db, { localInstanceId });
    const usable = accounts.filter((account) => account.status !== "claimed_elsewhere");

    let folders = [];
    let page = null;
    let acct = "all";
    let folderId = null;
    let message = null;
    let thread = [];
    let account = null;
    let back = INBOX_HREF;
    let missing = false;
    let tz;
    try { tz = await instanceZone(db); } catch { tz = undefined; }

    if (usable.length && view === "inbox") {
      const ids = new Set(usable.map((entry) => entry.id));
      for (const entry of usable) folders.push(...await listFolders(db, entry.id));

      const askedAcct = typeof query.acct === "string" ? query.acct : "";
      const askedFolder = typeof query.folder === "string" && query.folder !== "" ? query.folder : null;

      if (askedFolder !== null) {
        const folder = await getFolder(db, askedFolder);
        if (folder && ids.has(folder.accountId)) {
          folderId = folder.id;
          acct = folder.accountId;
          page = await readPage(db, { folderId, cursor: query.cursor });
        } else {
          // A folder the server no longer has: the page says so, and nothing is read.
          acct = ids.has(askedAcct) ? askedAcct : "all";
          page = { items: [], nextCursor: null, missing: true };
        }
      } else {
        acct = ids.has(askedAcct) ? askedAcct : "all";
        page = await readPage(db, {
          accountId: acct === "all" ? null : acct,
          cursor: query.cursor,
        });
        // The All view is every usable account's inbox, never a claimed account's stored mail.
        if (acct === "all") page.items = page.items.filter((item) => ids.has(item.accountId));
      }
    }

    // Opening a message: the link names the account and the Message-ID, with the row id as a hint
    // resolved against that id (Decision 9). A link that means nothing gets the not-here page.
    if (usable.length && view === "message") {
      const ids = new Set(usable.map((entry) => entry.id));
      const askedAcct = typeof query.a === "string" ? query.a : "";
      const mid = typeof query.mid === "string" && query.mid !== "" ? query.mid : null;
      const row = typeof query.row === "string" && query.row !== "" ? query.row : null;
      back = readBack(query.back);
      const found = ids.has(askedAcct)
        ? await resolveMessageRef(db, { accountId: askedAcct, mid, row })
        : null;
      if (!found) {
        missing = true;
        res.status(404);
      } else {
        message = found;
        account = usable.find((entry) => entry.id === found.accountId) ?? null;
        thread = await readThread(db, found);
      }
    }

    return layout({
      title: t("mail.title", lang),
      content: mailCss({ inbox: page !== null, message: message !== null }) + renderMailPage({
        view, accounts, elsewhere, lang, folders, page, acct, folderId, now: Date.now(), tz,
        message, thread, account, back, missing,
      }),
    });
  },
};