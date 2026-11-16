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
 *   resetUidValidity(mailbox) -> uidValidity               a UIDVALIDITY reset: a new value, an
 *                                                          emptied mailbox and uids that start again
 *   failNext(method, MailError)                            reject the next call to a method
 *   hangNext(method)                                       never settle the call at all
 *   emit(folderPath, reason?)                              report a change without a delivery
 *   dropWatch(err?)                                        the watch connection is lost
 *
 * `sent`, `drafts`, `calls` and `wire` record what an implementation would have done on the wire.
 * `calls` is one entry per adapter method (`{method, args}`), so `failNext` and `hangNext` have
 * something to hook. `wire` is the command names a server would have seen — `SELECT`, `UID FETCH`,
 * `UID STORE`, `UID MOVE` — which is what a test reads to show that a refused action reached the
 * mailbox with nothing.
 *
 * The action methods (`setFlags`, `move`) apply the contract's own rules: only `\Seen`, at most 100
 * uids, an `expectedUidValidity` that must be a positive integer, and a `CHANGED` refusal when the
 * folder's UIDVALIDITY is not the one the caller expected — raised after the `SELECT` and before any
 * `UID STORE` or `UID MOVE`.
 *
 * Two real server behaviours are modelled on purpose, because the adapter contract exists to hide them. A UID
 * search from above the mailbox's range still answers with the last message (`n:*` matches even when
 * `n` is past the end), so `list` first lets the mailbox answer that way and then applies the
 * adapter's own `uid > afterUid` filter: drop the filter and the quirk shows through. And
 * `opts.omitUidNext` drops `uidNext` from a listing, so the adapter answers with the highest UID in
 * the folder + 1 (1 for an empty folder) — the contract's last-resort rule, counted over the whole
 * folder rather than over the page the caller asked for.
 *
 * `send` validates its message with the same `validateOutgoing` a real adapter uses, so a caller that
 * skipped validation fails here too, and the fake never records a message a real implementation would
 * have refused. `setFlags` and `move` are recorded in `wire` the way a server would see them, so a
 * test can show that a refused action sent nothing at all.
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

/** The most uids one action names, the same bound every implementation applies. */
const MAX_ACTION_UIDS = 100;

/** The one flag an action may name: `\Seen`, and nothing else. */
const SEEN_FLAG = "\\Seen";

/** The uids one action names: at least one, at most MAX_ACTION_UIDS, each a positive safe integer. */
function actionUids(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ACTION_UIDS) {
    throw new MailError("BAD_INPUT", "uids");
  }
  const uids = [];
  for (const entry of value) {
    if (!Number.isSafeInteger(entry) || entry < 1) throw new MailError("BAD_INPUT", "uids");
    if (!uids.includes(entry)) uids.push(entry);
  }
  return uids;
}

/** The UIDVALIDITY the caller expects: a positive integer, or nothing is done at all. */
function actionUidValidity(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new MailError("BAD_INPUT", "expectedUidValidity");
  return value;
}

/** A flag list for `setFlags`: `\Seen` only, refused before the mailbox is touched. */
function actionFlags(value, detail) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new MailError("BAD_INPUT", detail);
  const flags = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().toLowerCase() !== SEEN_FLAG.toLowerCase()) {
      throw new MailError("BAD_INPUT", detail);
    }
    if (!flags.includes(SEEN_FLAG)) flags.push(SEEN_FLAG);
  }
  return flags;
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
  const wire = [];
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
      try {
        watcher.onChange({ folderPath, reason });
      } catch {
        // A handler that throws is the caller's bug, not the mailbox's: it must not turn a delivery,
        // or a later watcher's report, into a failure of the delivery itself.
      }
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

  /** A UIDVALIDITY reset: the folder is emptied and its uid space starts again at 1. */
  function resetUidValidity(mailbox) {
    const folder = folderFor(mailbox);
    folder.uidValidity += 1;
    folder.messages = [];
    folder.uidNext = 1;
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
      try {
        watcher.onError(err);
      } catch {
        // As in emit(): a handler that throws is the caller's bug, and it must not turn the loss of
        // the connection, or a later watcher's report of it, into a failure here.
      }
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

      // The folder's own highest UID, counted over the whole folder and never over the page: it is the
      // message the mailbox answers a search past its range with, and the fallback a listing without
      // UIDNEXT reports.
      const highestUid = folder.messages.reduce((top, message) => Math.max(top, message.uid), 0);

      let items = folder.messages;
      if (sinceDate != null) items = items.filter((message) => message.internalDate >= sinceDate);
      if (afterUid != null) {
        // Two layers, both of them real. The mailbox answers `UID SEARCH UID n:*` with the last message
        // even when `n` is past its own range, and the adapter then keeps only `uid > afterUid`, which
        // is what takes that message back out. The server half is reproduced here so the contract's
        // filter assertions exercise the adapter half.
        items = items.filter((message) => message.uid >= afterUid
          || (highestUid > 0 && afterUid > highestUid && message.uid === highestUid));
        items = items.filter((message) => message.uid > afterUid);
      }
      if (fromUid != null) items = items.filter((message) => message.uid >= fromUid);
      if (beforeUid != null) items = items.filter((message) => message.uid < beforeUid);

      const ordered = [...items].sort((a, b) => (newestFirst ? b.uid - a.uid : a.uid - b.uid));
      const page = limit == null ? ordered : ordered.slice(0, limit);
      const uidNext = omitUidNext ? highestUid + 1 : folder.uidNext;

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

    async setFlags(folderPath, uids, options = {}) {
      const opts = options == null ? {} : options;
      if (typeof opts !== "object") throw new MailError("BAD_INPUT", "options");
      const add = actionFlags(opts.add, "add");
      const remove = actionFlags(opts.remove, "remove");
      if (!add.length && !remove.length) throw new MailError("BAD_INPUT", "flags");
      const wanted = actionUids(uids);
      const expected = actionUidValidity(opts.expectedUidValidity);
      const folder = folderFor(folderPath);
      await gate("setFlags", [folderPath, uids, options]);
      wire.push("SELECT");
      if (folder.uidValidity !== expected) throw new MailError("CHANGED");
      const existing = folder.messages.filter((message) => wanted.includes(message.uid));
      if (existing.length === 0) return { updated: 0 };
      wire.push("UID FETCH", "UID STORE");
      for (const message of existing) {
        for (const flag of add) if (!message.flags.includes(flag)) message.flags.push(flag);
        message.flags = message.flags.filter((flag) => !remove.includes(flag));
      }
      emit(folder.path, "flags");
      return { updated: existing.length };
    },

    async move(folderPath, uids, destPath, options = {}) {
      const opts = options == null ? {} : options;
      if (typeof opts !== "object") throw new MailError("BAD_INPUT", "options");
      const wanted = actionUids(uids);
      const expected = actionUidValidity(opts.expectedUidValidity);
      const folder = folderFor(folderPath);
      await gate("move", [folderPath, uids, destPath, options]);
      wire.push("SELECT");
      if (folder.uidValidity !== expected) throw new MailError("CHANGED");
      const destination = folderFor(destPath);
      const existing = folder.messages.filter((message) => wanted.includes(message.uid));
      if (existing.length === 0) return { moved: 0 };
      wire.push("UID FETCH", "UID MOVE");
      for (const message of existing) {
        const uid = destination.uidNext;
        destination.uidNext = uid + 1;
        destination.messages.push({
          uid,
          flags: [...message.flags],
          internalDate: message.internalDate,
          size: message.raw.length,
          raw: Buffer.from(message.raw),
        });
        emit(destination.path, "exists");
      }
      folder.messages = folder.messages.filter((message) => !wanted.includes(message.uid));
      emit(folder.path, "expunge");
      return { moved: existing.length };
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
    resetUidValidity,
    failNext,
    hangNext,
    emit,
    dropWatch,
    sent,
    drafts,
    calls,
    wire,
  });
}