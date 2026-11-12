/**
 * An in-memory mail adapter: one of the two implementations of the adapter contract
 * (`servers/gateway/mail/adapter/interface.js`) and the one the tests drive. Mailboxes are plain
 * arrays, so a test can seed without a socket, a fake server or a clock.
 *
 * Seeding hooks live on the same object as the adapter methods, so the contract's factory can hand
 * back `{ adapter: fake, ...fake }` and the sync engine and supervisor tests can pass the object
 * itself as an adapter:
 *
 *   deliver(mailbox, raw, {flags?, internalDate?}) -> uid   append, and wake watchers
 *   expunge(mailbox, uid?) -> removed                      remove one uid (or every \Deleted one)
 *   moveIn(mailbox, raw, {internalDate}) -> uid            append with the caller's old date
 *   bumpUidValidity(mailbox) -> uidValidity                the next listing shows a new value
 *   failNext(method, MailError)                            reject the next call to a method
 *   hangNext(method)                                       never settle the call at all
 *   emit(folderPath, reason?)                              report a change without a delivery
 *   dropWatch(err?)                                        the watch connection is lost
 *
 * `sent`, `drafts` and `calls` record what an implementation would have done on the wire. Two real
 * server quirks are modelled on purpose, because the adapter contract exists to hide them: a UID
 * search from above the mailbox's range still answers with the last message (so `afterUid` must be
 * filtered here, not by the server), and `opts.omitUidNext` drops `uidNext` from a listing, so the
 * adapter answers with the highest listed UID + 1 — the contract's last-resort rule.
 *
 * `send` validates its message with the same `validateOutgoing` a real adapter uses, so a caller that
 * skipped validation fails here too, and the fake never records a message a real implementation would
 * have refused.
 */
import { MailError } from "../../servers/gateway/mail/errors.js";
import { validateOutgoing } from "../../servers/gateway/mail/adapter/interface.js";

/** The folders every fake account has: an inbox, a sent folder, drafts and an archive. */
const DEFAULT_FOLDERS = Object.freeze([
  { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", delimiter: "/", selectable: true },
  { path: "Sent", name: "Sent", specialUse: "\\Sent", delimiter: "/", selectable: true },
  { path: "Drafts", name: "Drafts", specialUse: "\\Drafts", delimiter: "/", selectable: true },
  { path: "Archive", name: "Archive", specialUse: "\\Archive", delimiter: "/", selectable: true },
]);

function toBuffer(raw) {
  if (Buffer.isBuffer(raw)) return Buffer.from(raw);
  if (typeof raw === "string") return Buffer.from(raw, "utf8");
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  throw new MailError("BAD_INPUT", "raw");
}

function normaliseFlags(flags) {
  if (flags == null) return [];
  if (!Array.isArray(flags)) throw new MailError("BAD_INPUT", "flags");
  return flags.map(String);
}

/**
 * @param {{omitUidNext?: boolean, uidValidity?: number, now?: () => number}} [opts]
 * @returns {object} the adapter (all ADAPTER_METHODS) with the seeding hooks attached
 */
export function createFakeMailAdapter(opts = {}) {
  const omitUidNext = opts.omitUidNext === true;
  const nowFn = typeof opts.now === "function" ? opts.now : () => Date.now();
  const baseUidValidity = Number.isInteger(opts.uidValidity) ? opts.uidValidity : 71;

  const folders = new Map();
  DEFAULT_FOLDERS.forEach((folder, index) => {
    folders.set(folder.path, {
      ...folder,
      uidValidity: baseUidValidity + index,
      uidNext: 1,
      messages: [],
    });
  });

  const calls = [];
  const sent = [];
  const drafts = [];
  const watchers = new Set();
  const failures = new Map();
  const hangs = new Map();
  let closed = false;

  function folderFor(path) {
    const folder = folders.get(path);
    if (!folder) throw new MailError("NOT_FOUND", "folder");
    return folder;
  }

  /** Every adapter call is recorded, then obeys an injected hang, then an injected failure. */
  async function gate(method, args) {
    calls.push({ method, args });
    if (closed) throw new MailError("PROTOCOL", "closed");
    const pendingHangs = hangs.get(method) ?? 0;
    if (pendingHangs > 0) {
      hangs.set(method, pendingHangs - 1);
      await new Promise(() => {});
    }
    const queue = failures.get(method);
    if (queue && queue.length) throw queue.shift();
  }

  function emit(folderPath, reason = "change") {
    for (const watcher of [...watchers]) {
      if (watcher.stopped || !watcher.folderPaths.has(folderPath)) continue;
      watcher.onChange({ folderPath, reason });
    }
  }

  function deliver(mailbox, raw, options = {}) {
    const folder = folderFor(mailbox);
    const buffer = toBuffer(raw);
    const uid = folder.uidNext;
    folder.uidNext = uid + 1;
    folder.messages.push({
      uid,
      flags: normaliseFlags(options.flags),
      internalDate: options.internalDate ?? nowFn(),
      size: buffer.length,
      raw: buffer,
    });
    emit(folder.path, "exists");
    return uid;
  }

  function moveIn(mailbox, raw, options = {}) {
    if (options.internalDate == null) throw new MailError("BAD_INPUT", "internalDate");
    return deliver(mailbox, raw, { internalDate: options.internalDate });
  }

  function expunge(mailbox, uid = null) {
    const folder = folderFor(mailbox);
    const before = folder.messages.length;
    folder.messages = folder.messages.filter((message) => (
      uid == null ? !message.flags.includes("\\Deleted") : message.uid !== uid
    ));
    const removed = before - folder.messages.length;
    if (removed > 0) emit(folder.path, "expunge");
    return removed;
  }

  function bumpUidValidity(mailbox) {
    const folder = folderFor(mailbox);
    folder.uidValidity += 1;
    return folder.uidValidity;
  }

  function failNext(method, error) {
    if (typeof method !== "string" || !method) throw new TypeError("failNext needs a method name");
    const err = error ?? new MailError("NETWORK", "ECONNRESET");
    if (!(err instanceof MailError)) throw new TypeError("failNext needs a MailError");
    const queue = failures.get(method) ?? [];
    queue.push(err);
    failures.set(method, queue);
    return err;
  }

  function hangNext(method) {
    if (typeof method !== "string" || !method) throw new TypeError("hangNext needs a method name");
    hangs.set(method, (hangs.get(method) ?? 0) + 1);
    return method;
  }

  /** The watch connection dies: every live watcher hears one error and is ended. */
  function dropWatch(error = null) {
    const err = error instanceof MailError ? error : new MailError("NETWORK", "ECONNRESET");
    let dropped = 0;
    for (const watcher of [...watchers]) {
      if (watcher.stopped) continue;
      watcher.stopped = true;
      watchers.delete(watcher);
      dropped += 1;
      watcher.onError(err);
    }
    return dropped;
  }

  const adapter = {
    async connect() {
      await gate("connect", []);
      return undefined;
    },

    async close() {
      // Idempotent, and it never reports an error: a close the caller asked for is not a lost
      // connection, so no watcher's onError fires here.
      calls.push({ method: "close", args: [] });
      closed = true;
      for (const watcher of watchers) watcher.stopped = true;
      watchers.clear();
    },

    async listFolders() {
      await gate("listFolders", []);
      return [...folders.values()].map((folder) => ({
        path: folder.path,
        name: folder.name,
        specialUse: folder.specialUse,
        delimiter: folder.delimiter,
        selectable: folder.selectable,
      }));
    },

    async list(folderPath, options = {}) {
      await gate("list", [folderPath, options]);
      const folder = folderFor(folderPath);
      const { sinceDate, afterUid, beforeUid, fromUid, limit, newestFirst } = options ?? {};

      let items = folder.messages;
      if (sinceDate != null) items = items.filter((message) => message.internalDate >= sinceDate);
      // The server-side `n:*` search would answer with the last message for any n past the end, so
      // the adapter filters `afterUid` itself.  Here it filters here for the same reason.
      if (afterUid != null) items = items.filter((message) => message.uid > afterUid);
      if (fromUid != null) items = items.filter((message) => message.uid >= fromUid);
      if (beforeUid != null) items = items.filter((message) => message.uid < beforeUid);

      const ordered = [...items].sort((a, b) => (newestFirst ? b.uid - a.uid : a.uid - b.uid));
      const page = limit == null ? ordered : ordered.slice(0, limit);
      const uidNext = omitUidNext
        ? (page.length ? Math.max(...page.map((message) => message.uid)) + 1 : 1)
        : folder.uidNext;

      return {
        uidValidity: folder.uidValidity,
        uidNext,
        items: page.map(({ uid, flags, internalDate, size }) => ({
          uid, flags: [...flags], internalDate, size,
        })),
      };
    },

    async get(folderPath, uids) {
      await gate("get", [folderPath, uids]);
      const folder = folderFor(folderPath);
      const out = [];
      for (const uid of Array.isArray(uids) ? uids : []) {
        const message = folder.messages.find((candidate) => candidate.uid === uid);
        if (!message) continue;
        out.push({
          uid: message.uid,
          flags: [...message.flags],
          internalDate: message.internalDate,
          raw: Buffer.from(message.raw),
        });
      }
      return out;
    },

    async search(query, options = {}) {
      await gate("search", [query, options]);
      if (typeof query !== "string" || !query.trim()) throw new MailError("BAD_INPUT", "query");
      const { folderPath, limit } = options ?? {};
      const needle = query.toLowerCase();
      const paths = folderPath == null ? [...folders.keys()] : [folderFor(folderPath).path];
      const found = [];
      for (const path of paths) {
        for (const message of folders.get(path).messages) {
          if (message.raw.toString("utf8").toLowerCase().includes(needle)) {
            found.push({ folderPath: path, uid: message.uid });
          }
        }
      }
      found.sort((a, b) => (a.folderPath === b.folderPath
        ? a.uid - b.uid
        : a.folderPath.localeCompare(b.folderPath)));
      return limit == null ? found : found.slice(0, limit);
    },

    async saveDraft(raw) {
      await gate("saveDraft", [raw]);
      const folder = [...folders.values()].find((candidate) => candidate.specialUse === "\\Drafts");
      if (!folder) throw new MailError("NOT_FOUND", "drafts");
      const buffer = toBuffer(raw);
      const uid = deliver(folder.path, buffer, { flags: ["\\Draft", "\\Seen"] });
      drafts.push({ folderPath: folder.path, raw: buffer });
      return { folderPath: folder.path, uid };
    },

    async send(message) {
      await gate("send", [message]);
      const validated = validateOutgoing(message);
      const messageId = `<fake-sent-${sent.length + 1}@mail.example.test>`;
      sent.push({ ...validated, messageId });
      const accepted = [...validated.to, ...validated.cc, ...validated.bcc]
        .map((recipient) => recipient.address);
      return { messageId, accepted, rejected: [] };
    },

    async watch(folderPaths, handlers = {}) {
      await gate("watch", [folderPaths, handlers]);
      const paths = Array.isArray(folderPaths) ? folderPaths : [folderPaths];
      if (!paths.length) throw new MailError("BAD_INPUT", "folders");
      for (const path of paths) folderFor(path);
      const { onChange, onError } = handlers ?? {};
      const watcher = {
        folderPaths: new Set(paths),
        onChange: typeof onChange === "function" ? onChange : () => {},
        onError: typeof onError === "function" ? onError : () => {},
        stopped: false,
      };
      watchers.add(watcher);
      return {
        stop() {
          if (watcher.stopped) return;
          watcher.stopped = true;
          watchers.delete(watcher);
        },
      };
    },
  };

  return Object.assign(adapter, {
    deliver,
    expunge,
    moveIn,
    bumpUidValidity,
    failNext,
    hangNext,
    emit,
    dropWatch,
    sent,
    drafts,
    calls,
  });
}