/**
 * Crow Mail's recipient rules: which addresses a person has never written to before, which ones a
 * revision changed, and what a reply or a forward starts from.
 *
 * The "new recipient" flag is the only unusual-recipient warning Crow Mail has, and it is deliberately
 * narrow: an address counts as known when it appears as a sender or a recipient of a message in one of
 * this account's Sent-role folders, or in the address book (`contacts`). There is no different-domain
 * rule — on a webmail account nearly every recipient would trip one, and a warning that fires on every
 * message is a warning nobody reads. A message sitting in Drafts proves nothing: Crow wrote it and may
 * never have sent it, so its recipients are still new.
 *
 * A reply follows the message's own steering: `Reply-To` is where the reply goes when the message
 * carries one (the card then says so — `replyToDiffers` — instead of silently retargeting). The
 * account's own address and its aliases are dropped from a reply-all, because a person copying
 * themselves is noise, and the case of an address never decides any of it.
 *
 * Nothing here writes and nothing here logs: an address is data, and a refusal is the caller's to
 * render from a fixed sentence.
 */
import { parseAddressListDetailed } from "../../staged/canonical.js";
import { folderRole, listFolders } from "../store/messages.js";

/** A reply's References chain keeps the last this-many ids; the tail is the part a sender controls. */
const REFERENCES_MAX = 50;

/** One Message-ID as plan 1's header rules spell it. */
const REPLY_ID = /^<[^<>\s]{1,250}>$/;

/** The address lists of one stored message, read by the Sent-history query. */
const SENT_HISTORY_SQL = `SELECT from_addr, to_json, cc_json FROM mail_messages
 WHERE account_id = ? AND folder_id IN (SELECT value FROM json_each(?))`;

const CONTACT_EMAILS_SQL = "SELECT email FROM contacts WHERE email IS NOT NULL AND email <> ''";

/** A stored string, or "": nothing here throws over a field a row happened to leave null. */
function text(value) {
  return typeof value === "string" ? value : "";
}

/** The one spelling two addresses are compared in. */
function lower(value) {
  return text(value).trim().toLowerCase();
}

/**
 * One address list as `{name, address}` entries: the revision and message shapes both hold either a
 * bare string or an object, and an entry with no address names nobody.
 */
function addressEntries(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (entry == null) continue;
    const address = lower(typeof entry === "string" ? entry : entry.address);
    if (!address) continue;
    const name = typeof entry === "object" && typeof entry.name === "string" && entry.name.trim() !== ""
      ? entry.name.trim()
      : null;
    out.push({ name, address });
  }
  return out;
}

/** The account's own addresses: the one it sends from and every alias it answers as. */
function ownAddresses(account) {
  const own = new Set();
  const primary = lower(account?.address);
  if (primary) own.add(primary);
  for (const alias of Array.isArray(account?.aliases) ? account.aliases : []) {
    const address = lower(alias);
    if (address) own.add(address);
  }
  return own;
}

/** A stored JSON address list (mail_messages.to_json and cc_json), tolerated when it is malformed. */
function storedAddresses(value) {
  let parsed = value;
  if (typeof value === "string") {
    if (!value) return [];
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed : [];
}

/** Every address one stored row put on the wire, lower-cased: its sender, its To and its Cc. */
function addRowAddresses(known, row) {
  const sender = lower(row.from_addr);
  if (sender) known.add(sender);
  for (const list of [storedAddresses(row.to_json), storedAddresses(row.cc_json)]) {
    for (const entry of addressEntries(list)) known.add(entry.address);
  }
}

/**
 * The addresses among `addrs` that this account has never written to: not a sender or a recipient of
 * any message in one of its Sent-role folders, and not in `contacts`. Lower-cased and de-duplicated,
 * in the order the caller gave them. The account's folders are listed first and the Sent-role ones
 * (`folderRole`, so a server whose Sent folder is named rather than flagged still counts) bound the
 * one message query, so the account's whole mailbox is never read for this; when the account has no
 * Sent folder the Sent half is empty and only the address book is checked.
 *
 * @param {object} db
 * @param {string} accountId
 * @param {Array<{address: string}|string>} addrs
 * @returns {Promise<string[]>}
 */
export async function newRecipients(db, accountId, addrs = []) {
  const account = typeof accountId === "string" ? accountId.trim() : "";
  const wanted = [];
  for (const entry of addressEntries(addrs)) if (!wanted.includes(entry.address)) wanted.push(entry.address);
  if (!account || !wanted.length) return [];

  const known = new Set();
  const sentFolders = (await listFolders(db, account))
    .filter((folder) => folderRole(folder) === "sent")
    .map((folder) => folder.id);
  if (sentFolders.length) {
    const { rows } = await db.execute({ sql: SENT_HISTORY_SQL, args: [account, JSON.stringify(sentFolders)] });
    for (const row of rows) addRowAddresses(known, row);
  }

  const { rows: contacts } = await db.execute({ sql: CONTACT_EMAILS_SQL, args: [] });
  for (const row of contacts) {
    // An address-book entry may be a bare address or a name with one; only the address counts.
    for (const address of parseAddressListDetailed(text(row.email)).addresses) known.add(address);
  }

  return wanted.filter((address) => !known.has(address));
}

/**
 * The addresses a revision adds: every address in its To, Cc or Bcc that the previous revision did
 * not carry. A first revision (no previous one) adds all of them, and the answer is lower-cased,
 * de-duplicated and in To → Cc → Bcc order, so the card marks the same addresses every time it is
 * drawn.
 *
 * @param {{to?: Array, cc?: Array, bcc?: Array}|null} prevRev
 * @param {{to?: Array, cc?: Array, bcc?: Array}} rev
 * @returns {string[]}
 */
export function changedRecipients(prevRev, rev) {
  const before = new Set();
  for (const key of ["to", "cc", "bcc"]) {
    for (const entry of addressEntries(prevRev?.[key])) before.add(entry.address);
  }
  const changed = [];
  for (const key of ["to", "cc", "bcc"]) {
    for (const entry of addressEntries(rev?.[key])) {
      if (before.has(entry.address) || changed.includes(entry.address)) continue;
      changed.push(entry.address);
    }
  }
  return changed;
}

/* ------------------------------------------------------------------ the subject */

/**
 * A subject with the reply prefix on it once: an existing `Re:` (in any case, with the spacing the
 * sender used) is left exactly as it was, so a thread that came back three times does not read
 * "Re: Re: Re:".
 */
function replySubject(subject) {
  const original = text(subject).trim();
  if (/^re\s*:/i.test(original)) return original;
  return original ? `Re: ${original}` : "Re:";
}

/** The same rule for a forward: `Fwd:` once. */
function forwardSubject(subject) {
  const original = text(subject).trim();
  if (/^fwd?\s*:/i.test(original)) return original;
  return original ? `Fwd: ${original}` : "Fwd:";
}

/* ---------------------------------------------------------------- reply / forward */

/** One Message-ID value, or null when the message carries none (or something that is not one). */
function messageIdOrNull(value) {
  const id = text(value).trim();
  return REPLY_ID.test(id) ? id : null;
}

/** The chain a reply carries: the parent's references plus its Message-ID, the last 50 kept. */
function replyReferences(message) {
  const ids = [];
  for (const entry of Array.isArray(message?.references) ? message.references : []) {
    const id = messageIdOrNull(entry);
    if (id) ids.push(id);
  }
  const own = messageIdOrNull(message?.messageId);
  if (own) ids.push(own);
  return ids.slice(-REFERENCES_MAX);
}

/**
 * What a reply to one stored message starts as.
 *
 * The primary recipient is the message's `Reply-To` when it carries one (a mailing list or a shared
 * mailbox says where replies belong), else its sender. `replyToDiffers` is that address when it is not
 * the sender, so the card can say "Reply goes to <address>, not the sender" instead of retargeting
 * quietly. `cc` is the message's own To and Cc with the account's addresses and aliases removed and
 * the primary recipient never repeated.
 *
 * When that primary recipient is one of the account's own addresses or aliases — the message was sent
 * by this account, or it steers replies back to it — the reply falls back to the people the message was
 * addressed to (its To list, own addresses removed), which is what a mail client does with a reply to
 * one's own message. `replyToDiffers` is null then: the reply does not go to that address at all.
 *
 * @param {object} message a stored message row (getMessage's shape)
 * @param {{address: string, aliases?: string[]}} account
 * @param {{all?: boolean}} [options] `all: true` for Reply all
 * @returns {{to: Array<{name: string|null, address: string}>,
 *   cc: Array<{name: string|null, address: string}>, subject: string,
 *   inReplyTo: string|null, references: string[], replyToDiffers: string|null}}
 */
export function deriveReply(message, account, options = {}) {
  const all = options?.all === true;
  const own = ownAddresses(account);
  const sender = lower(message?.fromAddr);
  const replyTo = addressEntries(message?.replyTo)[0]?.address ?? "";
  const primary = replyTo || sender;
  const ownSender = Boolean(primary) && own.has(primary);

  // Everyone already placed, plus the account's own addresses: neither enters To a second time nor Cc.
  const placed = new Set(own);
  const to = [];
  if (ownSender) {
    for (const entry of addressEntries(message?.to)) {
      if (placed.has(entry.address)) continue;
      placed.add(entry.address);
      to.push({ name: entry.name, address: entry.address });
    }
  } else if (primary) {
    const name = primary === sender && typeof message?.fromName === "string" && message.fromName.trim() !== ""
      ? message.fromName.trim()
      : null;
    placed.add(primary);
    to.push({ name, address: primary });
  }

  const cc = [];
  if (all) {
    for (const key of ["to", "cc"]) {
      for (const entry of addressEntries(message?.[key])) {
        if (placed.has(entry.address)) continue;
        placed.add(entry.address);
        cc.push({ name: entry.name, address: entry.address });
      }
    }
  }

  return {
    to,
    cc,
    subject: replySubject(message?.subject),
    inReplyTo: messageIdOrNull(message?.messageId),
    references: replyReferences(message),
    replyToDiffers: !ownSender && primary && sender && primary !== sender ? primary : null,
  };
}

/**
 * A forward's body: the original text quoted line by line, nothing added. A forward carries no
 * invented sentence — the person writes whatever introduction they want above it — and every
 * attachment of the message becomes an `AttachmentRef` the send can resolve later.
 *
 * @param {object} message a stored message row (getMessage's shape)
 * @returns {{subject: string, quotedBody: string, attachments: object[]}}
 */
export function deriveForward(message) {
  const body = text(message?.bodyText).replace(/\r\n?/g, "\n");
  const quotedBody = body.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
  const attachments = [];
  const list = Array.isArray(message?.attachments) ? message.attachments : [];
  for (let index = 0; index < list.length; index += 1) {
    const part = list[index];
    attachments.push({
      source: "thread",
      accountId: message?.accountId ?? null,
      mid: message?.messageId ?? null,
      index,
      filename: text(part?.filename),
      size: Number.isInteger(part?.size) ? part.size : null,
    });
  }
  return { subject: forwardSubject(message?.subject), quotedBody, attachments };
}