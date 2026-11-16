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
 * `listMessages` for one page of rows. On the All view the `inbox` role is read across every account
 * and the rows of an account held elsewhere are stepped over, so a page is a full page of mail this
 * instance may read and its cursor lands on the last row it kept. A folder link lists that one folder
 * only when its account is the chip's (or no chip was asked for): another account's folder is never
 * listed. The times are drawn in the instance's zone (`instanceZone`).
 *
 * The `message` view reads the row a link names (`resolveMessageRef`: the row id is only a hint, and
 * is used only when it belongs to the account and its Message-ID is the link's) and then the whole
 * conversation (`listThreadMessages`, each entry looked up so its section knows whether it has a
 * body and which attachments it has). A link that resolves to nothing gets the not-here page.
 * Neither view writes anything: the body comes from the frame route, never from this page.
 *
 * The `search` view reads plan 1's local index (`searchLocal`, which already collapses a message's
 * label copies to one hit), scoped to one account or to every usable one; the words are trimmed and
 * cut at 200 characters, and an empty query is not a search at all, so it draws the inbox instead.
 * The list views also carry the two controls a link cannot be — refresh and, once a folder's local
 * rows are exhausted, "Look further back" — as buttons naming account and folder ids only; the
 * client script (Task 8) posts them and reloads with a `flash` this page parses back into a kind and
 * a count.
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
import { getFolder, getMessage, listFolders, listMessages, searchLocal } from "../../mail/store/messages.js";
import { listThreadMessages, resolveMessageRef } from "../../mail/store/reader-queries.js";
import { getOrCreateLocalInstanceId } from "../../instance-registry.js";
import { instanceZone } from "../../../shared/schedule-store.js";
import { renderMailPage } from "./mail/html.js";
import { mailCss } from "./mail/css.js";

/** Rows per page. The cursor is the only way to the next one. */
const INBOX_PAGE_SIZE = 30;

/** The longest query the search view runs: the same 200 characters plan 1's search route cuts at. */
const QUERY_MAX_CHARS = 200;

/** The list a message view goes back to when its `back` says nothing usable. */
const INBOX_HREF = "/dashboard/mail";

/** The search view's own words: trimmed, cut at 200 characters, empty when there is nothing to ask. */
function readQuery(value) {
  return typeof value === "string" ? value.trim().slice(0, QUERY_MAX_CHARS) : "";
}

/**
 * The reload an action leaves behind: `older:<n>` or `remote:<n>` brought that many rows back, and
 * `start` says a folder reached its own beginning. Any other value means nothing at all. The count is
 * an integer, whatever the digits looked like in the URL.
 */
function readFlash(value) {
  if (typeof value !== "string" || value === "") return null;
  if (value === "start") return { kind: "start", count: null };
  const match = /^(older|remote):(\d{1,9})$/.exec(value);
  if (!match) return null;
  return { kind: match[1], count: Number(match[2]) };
}

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
 * Plan 1's keyset cursor for one summary (`date:id`, base64url): the value `listMessages` reads back
 * as the place the next page starts after.
 */
function cursorOf(item) {
  return Buffer.from(`${Number(item.date)}:${Number(item.id)}`, "utf8").toString("base64url");
}

/**
 * One page of the unified inbox, scoped to the accounts this instance may read. Plan 1's list takes
 * one account or every account, never a set of ids, so the page is fetched across every account and
 * the rows of an account held elsewhere are stepped over as they come. The cursor is then the last
 * row the page kept, not the last row fetched: usable rows can sit below it in the same fetched page,
 * and a cursor past them would skip them (a short page, or a "Load more" that shows nothing).
 */
async function readAllPage(db, ids, cursor) {
  const wanted = typeof cursor === "string" && cursor !== "" ? cursor : undefined;
  const kept = [];
  let after = wanted;
  for (let round = 0; ; round += 1) {
    let page;
    try {
      page = await listMessages(db, { role: "inbox", limit: INBOX_PAGE_SIZE, cursor: after });
    } catch (err) {
      // An edited cursor starts again at the first page, never a 500.
      if (round > 0 || wanted === undefined || !(err instanceof MailError) || err.code !== "BAD_INPUT") throw err;
      after = undefined;
      continue;
    }
    for (const item of page.items) {
      if (ids.has(item.accountId)) kept.push(item);
    }
    if (kept.length >= INBOX_PAGE_SIZE) {
      const items = kept.slice(0, INBOX_PAGE_SIZE);
      return { items, nextCursor: cursorOf(items[items.length - 1]) };
    }
    if (!page.nextCursor) return { items: kept, nextCursor: null };
    after = page.nextCursor;
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
    const asked = typeof query.view === "string" && query.view ? query.view : "inbox";
    const q = readQuery(query.q);
    // An empty query is not a search: the inbox it falls back to carries the box that asks for one.
    const view = asked === "search" && q === "" ? "inbox" : asked;
    const flash = readFlash(query.flash);
    // This instance's own id: the claim rules compare every held address against it.
    const localInstanceId = getOrCreateLocalInstanceId();
    const { accounts, elsewhere } = await accountsOverview(db, { localInstanceId });
    const usable = accounts.filter((account) => account.status !== "claimed_elsewhere");

    let folders = [];
    let page = null;
    let hits = [];
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
        // A folder of an account this instance may read is listed when the chip agrees (a folder
        // link carries both) or when no chip was asked for at all. A folder of another account than
        // the chip names is dropped, so the page never lists that account's mail.
        const owner = folder && ids.has(folder.accountId) ? folder.accountId : null;
        if (owner !== null && (!ids.has(askedAcct) || askedAcct === owner)) {
          folderId = folder.id;
          acct = owner;
          page = await readPage(db, { folderId, cursor: query.cursor });
        } else if (owner !== null) {
          acct = askedAcct;
          page = await readPage(db, { accountId: acct, cursor: query.cursor });
        } else {
          // A folder the server no longer has: the page says so, and nothing is read.
          acct = ids.has(askedAcct) ? askedAcct : "all";
          page = { items: [], nextCursor: null, missing: true };
        }
      } else {
        acct = ids.has(askedAcct) ? askedAcct : "all";
        // The All view is every usable account's inbox, never a claimed account's stored mail.
        page = acct === "all"
          ? await readAllPage(db, ids, query.cursor)
          : await readPage(db, { accountId: acct, cursor: query.cursor });
      }
    }

    // Searching: plan 1's local index, one row per logical message, narrowed to one account when a
    // chip's id is asked for and to every usable account otherwise. A claimed account's stored mail
    // is never searched for.
    if (usable.length && view === "search") {
      const ids = new Set(usable.map((entry) => entry.id));
      const askedAcct = typeof query.acct === "string" ? query.acct : "";
      acct = ids.has(askedAcct) ? askedAcct : "all";
      const found = await searchLocal(db, {
        q,
        accountId: acct === "all" ? null : acct,
        limit: INBOX_PAGE_SIZE,
      });
      hits = acct === "all" ? found.filter((item) => ids.has(item.accountId)) : found;
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
      content: mailCss({ inbox: page !== null || view === "search", message: message !== null }) + renderMailPage({
        view, accounts, elsewhere, lang, folders, page, acct, folderId, now: Date.now(), tz,
        message, thread, account, back, missing, q, hits, flash,
      }),
    });
  },
};