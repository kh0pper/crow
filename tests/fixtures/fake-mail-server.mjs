/**
 * In-process mail servers for the Crow Mail tests, one exported factory per protocol. The IMAP
 * state machine and the SMTP state machine are separate factories so neither has to know about the
 * other.
 *
 * The IMAP server speaks plain TCP on 127.0.0.1 and is told to bind port 0, so a test never picks
 * a fixed port. It answers what imapflow 2.11 asks for on the read side: greeting capabilities,
 * CAPABILITY/ID/ENABLE/NAMESPACE, LOGIN and AUTHENTICATE PLAIN|XOAUTH2, LIST/LSUB/STATUS,
 * SELECT/EXAMINE, SEARCH/UID SEARCH, FETCH/UID FETCH, STORE/UID STORE, IDLE with DONE, CLOSE and
 * LOGOUT, plus APPEND for the draft-save path. The advertised capability list is IMAP4rev1 only - no
 * IMAP4rev2, LIST-EXTENDED, LIST-STATUS, CONDSTORE, BINARY or COMPRESS - so imapflow takes its
 * plainest paths: no RETURN options on LIST, no ENABLE, no MODSEQ fetch items, a `* SEARCH 1 2 3`
 * answer and an LSUB for the subscription state that rev1 does not carry inline. `omitUidNext`
 * models the servers that leave UIDNEXT out of a SELECT and answer it only in a STATUS. EXAMINE
 * opens a mailbox read-only, so a flag change inside it is refused; mailbox names go out as
 * escaped IMAP quoted strings; a BODY fetch item that is not a section fetch (BODYSTRUCTURE and
 * friends) is left out of the answer; a section fetch with a partial specifier (`BODY[]<0.N>`, the
 * form imapflow sends when a caller caps the bytes it wants) answers with at most the requested N
 * bytes under the `<0>` origin the client places them by; and IDLE ends only on DONE, any other line
 * while idling failing the IDLE tag instead of being run as a command.
 *
 * The SMTP server speaks plain TCP on 127.0.0.1 port 0 as well, with no STARTTLS and no AUTH
 * required: greeting, EHLO with the AUTH mechanism list, AUTH PLAIN/LOGIN/XOAUTH2, MAIL FROM,
 * RCPT TO, DATA with dot-unstuffing, RSET and QUIT. nodemailer talks to it the way it talks to a
 * real relay.
 *
 * One deliberate quirk of real servers is reproduced: `UID SEARCH UID n:*` with `n` above the
 * highest UID still matches the highest UID, because `*` means "the largest number in use" and the
 * range collapses onto it.
 */

import net from "node:net";
import { StringDecoder } from "node:string_decoder";

const CRLF = "\r\n";
/** The one address every fake binds: a test never reaches the network. */
const FAKE_HOST = "127.0.0.1";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const FAKE_USER = "alex@example.com";
export const FAKE_PASSWORD = "fake-app-pass";

const DEFAULT_MAILBOXES = ["INBOX", "Sent", "Drafts", "Trash"];
const DEFAULT_SPECIAL_USE = {
  Sent: "\\Sent",
  Drafts: "\\Drafts",
  Trash: "\\Trash",
  Junk: "\\Junk",
  Archive: "\\Archive",
};

/**
 * The capabilities this server advertises. Kept in one place because several client code paths
 * branch on them, and each addition changes which imapflow path runs.
 */
const CAPABILITIES = [
  "IMAP4rev1",
  "SPECIAL-USE",
  "IDLE",
  "NAMESPACE",
  "AUTH=PLAIN",
  "AUTH=XOAUTH2",
];

const pad2 = (value) => String(value).padStart(2, "0");

/** A Date as `DD-Mon-YYYY HH:MM:SS +0000`, the INTERNALDATE form. */
function imapDateTime(value) {
  const date = new Date(value);
  return `${pad2(date.getUTCDate())}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()} ` +
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())} +0000`;
}

/** A Date as an RFC 5322 `Date:` header value. */
function rfc5322Date(value) {
  const date = new Date(value);
  return `${WEEKDAYS[date.getUTCDay()]}, ${pad2(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:` +
    `${pad2(date.getUTCSeconds())} +0000`;
}

let rawCounter = 0;

function bracket(value) {
  const text = String(value).trim();
  return text.startsWith("<") ? text : `<${text}>`;
}

/**
 * Builds a small RFC 5322 message with CRLF line endings, for `deliver`/`moveIn`.
 * `html` turns the body into multipart/alternative; `messageId: null` leaves the header out.
 */
export function makeRaw(options = {}) {
  const {
    from = FAKE_USER,
    to = "sam@example.com",
    subject = "Fake message",
    body = "Hello from the fake server.",
    html = null,
    date = new Date(Date.UTC(2024, 0, 15, 12, 0, 0)),
    messageId,
    inReplyTo,
    references,
    extraHeaders = {},
  } = options;

  rawCounter += 1;
  const id = messageId === undefined ? `fake-${rawCounter}@example.com` : messageId;
  const boundary = `fake-boundary-${rawCounter}`;

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${rfc5322Date(date)}`,
  ];
  if (id) headers.push(`Message-ID: ${bracket(id)}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${bracket(inReplyTo)}`);
  if (references) {
    const list = Array.isArray(references) ? references : [references];
    headers.push(`References: ${list.map(bracket).join(" ")}`);
  }
  headers.push("MIME-Version: 1.0");
  if (html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  } else {
    headers.push("Content-Type: text/plain; charset=utf-8");
  }
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.push(`${name}: ${value}`);
  }

  let payload;
  if (html) {
    payload = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
      `--${boundary}--`,
      "",
    ].join(CRLF);
  } else {
    payload = `${body}${CRLF}`;
  }
  return `${headers.join(CRLF)}${CRLF}${CRLF}${payload}`;
}

function newMailbox(path, specialUse) {
  return {
    path,
    specialUse: specialUse ?? null,
    uidValidity: 1,
    uidNext: 1,
    messages: [],
  };
}

function hasFlag(message, flag) {
  for (const value of message.flags) {
    if (value.toLowerCase() === flag.toLowerCase()) return true;
  }
  return false;
}

function dayNumber(value) {
  const date = new Date(value);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000);
}

const IMAP_DATE_RE = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/;

function imapDayNumber(text) {
  const match = IMAP_DATE_RE.exec(String(text).trim());
  if (!match) throw new Error(`unsupported IMAP date ${JSON.stringify(text)}`);
  const month = MONTHS.indexOf(match[2][0].toUpperCase() + match[2].slice(1).toLowerCase());
  if (month < 0) throw new Error(`unsupported IMAP month in ${JSON.stringify(text)}`);
  return Math.floor(Date.UTC(Number(match[3]), month, Number(match[1])) / 86_400_000);
}

/**
 * Parses a UID or sequence set into inclusive ranges. `*` is the highest value in use, so a set
 * whose lower bound is above it collapses onto the highest value: the real `n:*` behaviour.
 */
function parseSet(text, highest) {
  const ranges = [];
  for (const part of String(text).split(",")) {
    if (!part) continue;
    const colon = part.indexOf(":");
    const first = colon < 0 ? part : part.slice(0, colon);
    const second = colon < 0 ? part : part.slice(colon + 1);
    const from = first === "*" ? highest : Number(first);
    const to = colon < 0 ? from : second === "*" ? highest : Number(second);
    if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
    ranges.push([Math.min(from, to), Math.max(from, to)]);
  }
  return ranges;
}

function inRanges(value, ranges) {
  return ranges.some(([from, to]) => value >= from && value <= to);
}

/**
 * Splits one command line into flat tokens: atoms, quoted strings, parenthesised lists (as
 * separate open/close tokens) and literal placeholders. Brackets stay inside an atom, so
 * `BODY.PEEK[]` and `BODY.PEEK[HEADER]` arrive whole.
 */
function tokenize(line) {
  const tokens = [];
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === " " || char === "\t") {
      index += 1;
    } else if (char === "(") {
      tokens.push({ type: "open" });
      index += 1;
    } else if (char === ")") {
      tokens.push({ type: "close" });
      index += 1;
    } else if (char === '"') {
      let value = "";
      index += 1;
      while (index < line.length && line[index] !== '"') {
        if (line[index] === "\\" && index + 1 < line.length) {
          value += line[index + 1];
          index += 2;
        } else {
          value += line[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ type: "string", value });
    } else {
      let value = "";
      while (index < line.length && line[index] !== " " && line[index] !== "\t" &&
        line[index] !== "(" && line[index] !== ")") {
        value += line[index];
        index += 1;
      }
      tokens.push({ type: "atom", value });
    }
  }
  return tokens;
}

const tokenText = (token) => (token && token.value !== undefined && token.value !== null
  ? String(token.value)
  : "");

function flagList(flags) {
  return `(${[...flags].join(" ")})`;
}

/** An IMAP quoted string: backslash and double quote are the only two characters it escapes. */
function quoteString(value) {
  return `"${String(value).replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

/**
 * The header block of a raw message, folded and keyed by lower-cased field name, so a search can
 * look at one header instead of at the whole message. A repeated field keeps one entry per
 * occurrence, in order.
 */
function headerFields(raw) {
  const end = raw.indexOf("\r\n\r\n");
  const block = end < 0 ? raw : raw.subarray(0, end);
  const fields = new Map();
  let current = null;
  for (const line of block.toString("utf8").split("\r\n")) {
    if (current && (line.startsWith(" ") || line.startsWith("\t"))) {
      const values = fields.get(current);
      values[values.length - 1] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      current = null;
      continue;
    }
    current = line.slice(0, colon).trim().toLowerCase();
    if (!fields.has(current)) fields.set(current, []);
    fields.get(current).push(line.slice(colon + 1).trim());
  }
  return fields;
}

/** True when one of the message's values for `name` contains `needle`, both lower-cased. */
function headerContains(fields, name, needle) {
  const values = fields.get(name) || [];
  return values.some((value) => value.toLowerCase().includes(needle));
}

/**
 * The search keys that look at one header: the field name to read for each. FROM/TO/CC/SUBJECT
 * must not match text that only appears elsewhere in the message.
 */
const HEADER_SEARCH_FIELD = { FROM: "from", TO: "to", CC: "cc", SUBJECT: "subject" };

/**
 * `BODY[]`, `BODY.PEEK[]`, `BODY[HEADER]`, with an optional `<origin.length>` partial range after the
 * brackets: the origin is the first byte the client wants, the length how many bytes it will take.
 */
const BODY_SECTION_RE = /^BODY(?:\.PEEK)?\[([^\]]*)\](?:<(\d+)(?:\.(\d+))?>)?$/;

/**
 * Starts the fake IMAP server. Resolves once it is listening, with the bound port.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.users] user -> password
 * @param {string[]} [options.mailboxes] mailbox paths, INBOX included
 * @param {Record<string, string>} [options.specialUse] path -> special-use flag
 * @param {boolean} [options.omitUidNext] leave UIDNEXT out of SELECT/EXAMINE, answering it in STATUS only
 */
export async function createFakeImapServer(options = {}) {
  const users = new Map(Object.entries(options.users ?? { [FAKE_USER]: FAKE_PASSWORD }));
  const omitUidNext = options.omitUidNext === true;
  const mailboxes = new Map();
  const specialUseFlags = { ...DEFAULT_SPECIAL_USE, ...(options.specialUse ?? {}) };
  for (const path of options.mailboxes ?? DEFAULT_MAILBOXES) {
    mailboxes.set(path, newMailbox(path, specialUseFlags[path]));
  }

  const state = {
    users,
    mailboxes,
    connections: new Set(),
    commands: [],
    logins: [],
    appended: [],
    accepted: 0,
    silenceRemaining: 0,
    failLoginRemaining: 0,
    closed: false,
  };

  const server = net.createServer((socket) => {
    state.accepted += 1;
    const conn = {
      socket,
      buffer: Buffer.alloc(0),
      tokens: [],
      pendingLiteral: null,
      literalWaiting: 0,
      authed: false,
      user: null,
      selected: null,
      readOnly: false,
      idleTag: null,
      authTag: null,
      authMechanism: null,
    };
    state.connections.add(conn);
    socket.setNoDelay(true);
    socket.on("data", (chunk) => feed(state, conn, chunk));
    socket.on("error", () => {});
    socket.on("close", () => state.connections.delete(conn));
    write(conn, `* OK [CAPABILITY ${CAPABILITIES.join(" ")}] fake IMAP ready`);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();

  function requireMailbox(path) {
    const box = mailboxes.get(String(path));
    if (!box) throw new Error(`no such mailbox ${JSON.stringify(path)}`);
    return box;
  }

  function notify(box, line) {
    for (const conn of state.connections) {
      if (conn.selected === box) write(conn, line);
    }
  }

  const fake = {
    host: "127.0.0.1",
    port: address.port,
    commands: state.commands,
    logins: state.logins,
    appended: state.appended,

    /** Adds a message to a mailbox, as an arrival does. Returns its UID. */
    deliver(mailbox, raw, { flags = [], internalDate = new Date() } = {}) {
      const box = requireMailbox(mailbox);
      const uid = box.uidNext;
      box.uidNext += 1;
      box.messages.push({
        uid,
        raw: Buffer.from(raw),
        flags: new Set(flags),
        internalDate: new Date(internalDate),
      });
      notify(box, `* ${box.messages.length} EXISTS`);
      return uid;
    },

    /** Removes one message and reports the sequence number it occupied. */
    expunge(mailbox, uid) {
      const box = requireMailbox(mailbox);
      const index = box.messages.findIndex((message) => message.uid === uid);
      if (index < 0) return false;
      box.messages.splice(index, 1);
      notify(box, `* ${index + 1} EXPUNGE`);
      return true;
    },

    /** A message moved in from another mailbox: a new high UID with an old internal date. */
    moveIn(mailbox, raw, { internalDate = new Date(), flags = [] } = {}) {
      return fake.deliver(mailbox, raw, { flags, internalDate });
    },

    setFlags(mailbox, uid, flags) {
      const box = requireMailbox(mailbox);
      const index = box.messages.findIndex((message) => message.uid === uid);
      if (index < 0) return false;
      box.messages[index].flags = new Set(flags);
      notify(box, `* ${index + 1} FETCH (UID ${uid} FLAGS ${flagList(box.messages[index].flags)})`);
      return true;
    },

    bumpUidValidity(mailbox) {
      const box = requireMailbox(mailbox);
      box.uidValidity += 1;
      return box.uidValidity;
    },

    addMailbox(path, { specialUse: flag = specialUseFlags[path] } = {}) {
      mailboxes.set(path, newMailbox(path, flag));
      return path;
    },

    removeMailbox(path) {
      for (const conn of state.connections) {
        if (conn.selected && conn.selected.path === path) conn.selected = null;
      }
      return mailboxes.delete(path);
    },

    /** Drops every connection abruptly, the way a network failure does. */
    dropConnections() {
      for (const conn of state.connections) {
        try {
          if (typeof conn.socket.resetAndDestroy === "function") conn.socket.resetAndDestroy();
          else conn.socket.destroy();
        } catch {
          conn.socket.destroy();
        }
      }
    },

    /** The next command is read and logged, and never answered. */
    silenceNext() {
      state.silenceRemaining += 1;
    },

    /** The next authentication attempt is refused, whatever the credentials. */
    failNextLogin() {
      state.failLoginRemaining += 1;
    },

    connectionCount() {
      return state.accepted;
    },

    openConnections() {
      return state.connections.size;
    },

    async close() {
      if (state.closed) return;
      state.closed = true;
      for (const conn of state.connections) conn.socket.destroy();
      state.connections.clear();
      await new Promise((resolve) => {
        // A socket the OS has not torn down yet must not keep the test run alive: the fallback
        // timer is unref-ed, and cleared as soon as the server reports itself closed.
        const timer = setTimeout(resolve, 1000);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };

  return fake;

  // ---------------------------------------------------------------------------------------------

  function write(conn, line) {
    if (conn.socket.destroyed) return;
    conn.socket.write(`${line}${CRLF}`);
  }

  function writeFetch(conn, seq, parts) {
    if (conn.socket.destroyed) return;
    const chunks = [];
    let text = `* ${seq} FETCH (`;
    let first = true;
    for (const part of parts) {
      text += first ? "" : " ";
      first = false;
      if (typeof part === "string") {
        text += part;
        continue;
      }
      // A literal ends at its declared length, so the bytes go out as they are.
      chunks.push(Buffer.from(`${text}${part.header}`, "utf8"));
      chunks.push(part.data);
      text = "";
    }
    chunks.push(Buffer.from(`${text})${CRLF}`, "utf8"));
    conn.socket.write(Buffer.concat(chunks));
  }

  function feed(state_, conn, chunk) {
    conn.buffer = conn.buffer.length ? Buffer.concat([conn.buffer, chunk]) : chunk;
    for (;;) {
      if (conn.literalWaiting > 0) {
        if (conn.buffer.length < conn.literalWaiting) return;
        const data = conn.buffer.subarray(0, conn.literalWaiting);
        conn.buffer = conn.buffer.subarray(conn.literalWaiting);
        conn.literalWaiting = 0;
        if (conn.pendingLiteral) {
          conn.pendingLiteral.value = data;
          conn.pendingLiteral = null;
        }
        continue;
      }
      const end = conn.buffer.indexOf(CRLF);
      if (end < 0) return;
      const line = conn.buffer.subarray(0, end).toString("utf8");
      conn.buffer = conn.buffer.subarray(end + 2);
      const marker = /\{(\d+)(\+)?\}$/.exec(line);
      if (marker) {
        conn.tokens.push(...tokenize(line.slice(0, marker.index)));
        const token = { type: "literal", value: null };
        conn.tokens.push(token);
        conn.pendingLiteral = token;
        conn.literalWaiting = Number(marker[1]);
        if (!marker[2]) write(conn, "+ Ready for literal data");
        continue;
      }
      conn.tokens.push(...tokenize(line));
      if (!conn.tokens.length) continue;
      const tokens = conn.tokens;
      conn.tokens = [];
      dispatch(state_, conn, tokens);
    }
  }

  function dispatch(state_, conn, tokens) {
    const firstToken = tokenText(tokens[0]);
    const first = firstToken.toUpperCase();

    // The answer to an AUTHENTICATE continuation is one unframed line, tagged by nothing.
    if (conn.authTag) {
      const expected = conn.authTag;
      const mechanism = conn.authMechanism;
      conn.authTag = null;
      conn.authMechanism = null;
      finishAuthenticate(conn, expected, mechanism, firstToken);
      return;
    }

    // DONE ends IDLE and carries no tag (RFC 3501 6.4.2). Any other line while idling is a client
    // error: the IDLE ends with a tagged BAD for the IDLE tag, and the line is not run as a command.
    if (conn.idleTag) {
      const idleTag = conn.idleTag;
      conn.idleTag = null;
      if (first === "DONE") write(conn, `${idleTag} OK IDLE terminated`);
      else write(conn, `${idleTag} BAD only DONE can end an IDLE`);
      return;
    }

    const tag = firstToken;
    const command = tokenText(tokens[1]).toUpperCase();
    const isUid = command === "UID";
    const name = isUid ? `UID ${tokenText(tokens[2]).toUpperCase()}` : command;
    state_.commands.push(name);

    if (state_.silenceRemaining > 0) {
      state_.silenceRemaining -= 1;
      return;
    }

    switch (name) {
      case "CAPABILITY":
        write(conn, `* CAPABILITY ${CAPABILITIES.join(" ")}`);
        write(conn, `${tag} OK CAPABILITY completed`);
        return;

      case "NOOP":
        write(conn, `${tag} OK NOOP completed`);
        return;

      case "ID":
        write(conn, '* ID ("name" "fake-imap" "version" "1")');
        write(conn, `${tag} OK ID completed`);
        return;

      case "ENABLE":
        write(conn, "* ENABLED");
        write(conn, `${tag} OK ENABLE completed`);
        return;

      case "NAMESPACE":
        if (!requireAuth(conn, tag)) return;
        write(conn, '* NAMESPACE (("" "/")) NIL NIL');
        write(conn, `${tag} OK NAMESPACE completed`);
        return;

      case "LOGIN": {
        const user = tokenText(tokens[2]);
        const password = tokenText(tokens[3]);
        authenticate(state_, conn, tag, "LOGIN", user, password);
        return;
      }

      case "AUTHENTICATE": {
        const mechanism = tokenText(tokens[2]).toUpperCase();
        if (mechanism !== "PLAIN" && mechanism !== "XOAUTH2") {
          write(conn, `${tag} BAD unsupported authentication mechanism`);
          return;
        }
        conn.authTag = tag;
        conn.authMechanism = mechanism;
        write(conn, "+ Ready for authentication");
        return;
      }

      case "LIST":
      case "LSUB": {
        if (!requireAuth(conn, tag)) return;
        const reference = tokenText(tokens[2]);
        const pattern = tokenText(tokens[3]);
        for (const box of mailboxes.values()) {
          if (!matchesListPattern(box.path, reference, pattern)) continue;
          const flags = box.specialUse ? `(\\HasNoChildren ${box.specialUse})` : "(\\HasNoChildren)";
          write(conn, `* ${name} ${flags} "/" ${quoteString(box.path)}`);
        }
        write(conn, `${tag} OK ${name} completed`);
        return;
      }

      case "STATUS": {
        if (!requireAuth(conn, tag)) return;
        const box = mailboxes.get(tokenText(tokens[2]));
        if (!box) {
          write(conn, `${tag} NO no such mailbox`);
          return;
        }
        const items = [];
        for (const token of tokens.slice(3)) {
          if (token.type !== "atom") continue;
          const item = token.value.toUpperCase();
          if (item === "MESSAGES") items.push(`MESSAGES ${box.messages.length}`);
          else if (item === "UIDNEXT") items.push(`UIDNEXT ${box.uidNext}`);
          else if (item === "UIDVALIDITY") items.push(`UIDVALIDITY ${box.uidValidity}`);
          else if (item === "UNSEEN") {
            items.push(`UNSEEN ${box.messages.filter((message) => !hasFlag(message, "\\Seen")).length}`);
          } else if (item === "RECENT") items.push("RECENT 0");
        }
        write(conn, `* STATUS ${quoteString(box.path)} (${items.join(" ")})`);
        write(conn, `${tag} OK STATUS completed`);
        return;
      }

      case "SELECT":
      case "EXAMINE": {
        if (!requireAuth(conn, tag)) return;
        const box = mailboxes.get(tokenText(tokens[2]));
        if (!box) {
          write(conn, `${tag} NO no such mailbox`);
          return;
        }
        conn.selected = box;
        conn.readOnly = name === "EXAMINE";
        write(conn, "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)");
        write(conn, `* ${box.messages.length} EXISTS`);
        write(conn, "* 0 RECENT");
        write(conn, `* OK [UIDVALIDITY ${box.uidValidity}] UIDs valid`);
        // A server may leave UIDNEXT out of the SELECT answer; STATUS still carries it.
        if (!omitUidNext) write(conn, `* OK [UIDNEXT ${box.uidNext}] Predicted next UID`);
        write(conn, "* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Limited");
        const mode = name === "EXAMINE" ? "READ-ONLY" : "READ-WRITE";
        write(conn, `${tag} OK [${mode}] ${name} completed`);
        return;
      }

      case "APPEND": {
        if (!requireAuth(conn, tag)) return;
        const box = mailboxes.get(tokenText(tokens[2]));
        if (!box) {
          write(conn, `${tag} NO [TRYCREATE] no such mailbox`);
          return;
        }
        const literal = tokens.find((token) => token.type === "literal");
        if (!literal) {
          write(conn, `${tag} BAD a literal message is required`);
          return;
        }
        // Flags arrive as backslash atoms ahead of the literal; the optional date-time is a
        // quoted string, so it is not mistaken for one.
        const flags = tokens
          .slice(3)
          .filter((token) => token.type === "atom" && tokenText(token).startsWith("\\"))
          .map(tokenText);
        const raw = Buffer.from(literal.value ?? Buffer.alloc(0));
        const uid = box.uidNext;
        box.uidNext += 1;
        box.messages.push({ uid, raw, flags: new Set(flags), internalDate: new Date() });
        state.appended.push({ mailbox: box.path, flags: [...flags], raw: Buffer.from(raw) });
        notify(box, `* ${box.messages.length} EXISTS`);
        write(conn, `${tag} OK APPEND completed`);
        return;
      }

      case "CLOSE": {
        if (!requireAuth(conn, tag)) return;
        conn.selected = null;
        conn.readOnly = false;
        write(conn, `${tag} OK CLOSE completed`);
        return;
      }

      case "EXPUNGE": {
        if (!conn.selected) {
          write(conn, `${tag} BAD no mailbox selected`);
          return;
        }
        if (conn.readOnly) {
          write(conn, `${tag} NO [READ-ONLY] mailbox is open read-only`);
          return;
        }
        const box = conn.selected;
        for (let index = box.messages.length - 1; index >= 0; index -= 1) {
          if (!hasFlag(box.messages[index], "\\Deleted")) continue;
          box.messages.splice(index, 1);
          notify(box, `* ${index + 1} EXPUNGE`);
        }
        write(conn, `${tag} OK EXPUNGE completed`);
        return;
      }

      case "SEARCH":
      case "UID SEARCH": {
        if (!requireAuth(conn, tag)) return;
        const box = conn.selected;
        if (!box) {
          write(conn, `${tag} BAD no mailbox selected`);
          return;
        }
        let start = isUid ? 3 : 2;
        // imapflow prefixes CHARSET UTF-8 when the query carries a literal.
        if (tokenText(tokens[start]).toUpperCase() === "CHARSET") start += 2;
        let test;
        try {
          test = buildSearchTest(tokens.slice(start), box);
        } catch (err) {
          write(conn, `${tag} BAD ${err.message.replace(/[\r\n]+/g, " ")}`);
          return;
        }
        const matches = [];
        box.messages.forEach((message, index) => {
          if (!test(message)) return;
          matches.push(isUid ? message.uid : index + 1);
        });
        write(conn, `* SEARCH ${matches.join(" ")}`.trimEnd());
        write(conn, `${tag} OK SEARCH completed`);
        return;
      }

      case "FETCH":
      case "UID FETCH": {
        if (!requireAuth(conn, tag)) return;
        const box = conn.selected;
        if (!box) {
          write(conn, `${tag} BAD no mailbox selected`);
          return;
        }
        const start = isUid ? 3 : 2;
        const items = tokens.slice(start + 1)
          .filter((token) => token.type === "atom" || token.type === "string")
          .map((token) => String(token.value).toUpperCase());
        const ranges = parseSet(tokenText(tokens[start]), isUid ? highestUid(box) : box.messages.length);
        box.messages.forEach((message, index) => {
          const seq = index + 1;
          const key = isUid ? message.uid : seq;
          if (!inRanges(key, ranges)) return;
          writeFetch(conn, seq, fetchParts(message, items));
        });
        write(conn, `${tag} OK FETCH completed`);
        return;
      }

      case "STORE":
      case "UID STORE": {
        if (!requireAuth(conn, tag)) return;
        const box = conn.selected;
        if (!box) {
          write(conn, `${tag} BAD no mailbox selected`);
          return;
        }
        if (conn.readOnly) {
          write(conn, `${tag} NO [READ-ONLY] mailbox is open read-only`);
          return;
        }
        const start = isUid ? 3 : 2;
        const ranges = parseSet(tokenText(tokens[start]), isUid ? highestUid(box) : box.messages.length);
        const operation = tokenText(tokens[start + 1]).toUpperCase();
        const silent = operation.endsWith(".SILENT");
        const mode = operation.replace(".SILENT", "");
        const requested = tokens.slice(start + 2)
          .filter((token) => token.type === "atom" || token.type === "string")
          .map((token) => String(token.value));
        box.messages.forEach((message, index) => {
          const seq = index + 1;
          const key = isUid ? message.uid : seq;
          if (!inRanges(key, ranges)) return;
          if (mode === "+FLAGS") for (const flag of requested) message.flags.add(flag);
          else if (mode === "-FLAGS") for (const flag of requested) message.flags.delete(flag);
          else message.flags = new Set(requested);
          if (!silent) {
            write(conn, `* ${seq} FETCH (UID ${message.uid} FLAGS ${flagList(message.flags)})`);
          }
        });
        write(conn, `${tag} OK STORE completed`);
        return;
      }

      case "IDLE": {
        if (!requireAuth(conn, tag)) return;
        if (!conn.selected) {
          write(conn, `${tag} BAD no mailbox selected`);
          return;
        }
        conn.idleTag = tag;
        write(conn, "+ idling");
        return;
      }

      case "LOGOUT":
        write(conn, "* BYE fake server logging out");
        write(conn, `${tag} OK LOGOUT completed`);
        conn.socket.end();
        return;

      default:
        write(conn, `${tag} BAD unsupported command`);
    }
  }

  function requireAuth(conn, tag) {
    if (conn.authed) return true;
    write(conn, `${tag} NO not authenticated`);
    return false;
  }

  function highestUid(box) {
    return box.messages.length ? box.messages[box.messages.length - 1].uid : 0;
  }

  function matchesListPattern(path, reference, pattern) {
    const full = `${reference ?? ""}${pattern ?? ""}`;
    if (!full) return path === "";
    if (full === "*") return true;
    if (full === "%") return path.indexOf("/") < 0;
    return path === full;
  }

  function headerBlock(raw) {
    const end = raw.indexOf("\r\n\r\n");
    return end < 0 ? raw : raw.subarray(0, end + 4);
  }

  function fetchParts(message, items) {
    const parts = [];
    let uidAdded = false;
    for (const item of items) {
      if (item === "UID") {
        parts.push(`UID ${message.uid}`);
        uidAdded = true;
      } else if (item === "FLAGS") {
        parts.push(`FLAGS ${flagList(message.flags)}`);
      } else if (item === "INTERNALDATE") {
        parts.push(`INTERNALDATE "${imapDateTime(message.internalDate)}"`);
      } else if (item === "RFC822.SIZE" || item === "RFC822SIZE") {
        parts.push(`RFC822.SIZE ${message.raw.length}`);
      } else if (item.startsWith("BODY")) {
        // Only a section fetch (BODY[], BODY.PEEK[], BODY[HEADER]) can be answered from the raw
        // message. BODYSTRUCTURE and the other BODY items describe the message rather than being
        // the message, so they are left out of the answer instead of being reported as BODY[].
        const match = BODY_SECTION_RE.exec(item);
        if (!match) continue;
        const section = match[1].toUpperCase();
        let content;
        if (section === "") content = message.raw;
        else if (section === "HEADER") content = headerBlock(message.raw);
        else content = Buffer.alloc(0);
        // A partial specifier caps the answer, and the answer says where it starts: the client reads
        // the origin out of `<0>` to place the bytes, so echoing it is what makes the range real.
        const start = match[2] === undefined ? 0 : Number(match[2]);
        const length = match[3] === undefined ? null : Number(match[3]);
        let origin = "";
        if (match[2] !== undefined) {
          origin = `<${start}>`;
          content = content.subarray(start, length === null ? undefined : start + length);
        }
        parts.push({ header: `BODY[${section}]${origin} {${content.length}}${CRLF}`, data: content });
      }
    }
    // imapflow keys a fetch row on the UID, so every answer carries one.
    if (!uidAdded) parts.unshift(`UID ${message.uid}`);
    return parts;
  }

  function authenticate(state_, conn, tag, method, user, password) {
    const refuse = () => {
      if (state_.failLoginRemaining > 0) state_.failLoginRemaining -= 1;
      write(conn, `${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
    };
    if (state_.failLoginRemaining > 0) {
      refuse();
      return;
    }
    const expected = state_.users.get(user);
    if (expected === undefined || expected !== password) {
      refuse();
      return;
    }
    conn.authed = true;
    conn.user = user;
    state_.logins.push({ user, method });
    write(conn, `${tag} OK ${method} completed`);
  }

  function finishAuthenticate(conn, tag, mechanism, payload) {
    if (String(payload).trim() === "*") {
      write(conn, `${tag} BAD authentication cancelled`);
      return;
    }
    const decoded = Buffer.from(payload, "base64").toString("utf8");
    if (mechanism === "PLAIN") {
      const parts = decoded.split("\u0000");
      const user = parts[1] ?? "";
      const password = parts[2] ?? "";
      authenticate(state, conn, tag, "AUTHENTICATE PLAIN", user, password);
      return;
    }
    // XOAUTH2: `user=<address>\x01auth=Bearer <token>\x01\x01`.
    const fields = decoded.split("\u0001");
    const userField = fields.find((field) => field.startsWith("user=")) ?? "";
    const authField = fields.find((field) => field.startsWith("auth=")) ?? "";
    const user = userField.slice("user=".length);
    const token = authField.replace(/^auth=Bearer\s*/i, "").trim();
    if (state.failLoginRemaining > 0) {
      state.failLoginRemaining -= 1;
      write(conn, `${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
      return;
    }
    if (!state.users.has(user) || !token) {
      write(conn, `${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
      return;
    }
    conn.authed = true;
    conn.user = user;
    state.logins.push({ user, method: "AUTHENTICATE XOAUTH2" });
    write(conn, `${tag} OK AUTHENTICATE XOAUTH2 completed`);
  }

  function buildSearchTest(tokens, box) {
    let index = 0;
    const uidMaximum = highestUid(box);
    // Parsed per message on first use, so one search parses each header block once.
    const headerCache = new Map();

    function fieldsFor(message) {
      let fields = headerCache.get(message);
      if (!fields) {
        fields = headerFields(message.raw);
        headerCache.set(message, fields);
      }
      return fields;
    }

    function parseOne() {
      const token = tokens[index];
      index += 1;
      if (!token) return () => true;
      if (token.type === "open") {
        const tests = [];
        while (index < tokens.length && tokens[index].type !== "close") tests.push(parseOne());
        index += 1;
        return (message) => tests.every((test) => test(message));
      }
      const key = tokenText(token).toUpperCase();
      if (key === "ALL") return () => true;
      if (key === "CHARSET") {
        index += 1;
        return () => true;
      }
      if (key === "OR") {
        const left = parseOne();
        const right = parseOne();
        return (message) => left(message) || right(message);
      }
      if (key === "NOT") {
        const operand = parseOne();
        return (message) => !operand(message);
      }
      if (key === "UID") {
        const ranges = parseSet(tokenText(tokens[index]), uidMaximum);
        index += 1;
        return (message) => inRanges(message.uid, ranges);
      }
      if (key === "SEQUENCE") {
        const ranges = parseSet(tokenText(tokens[index]), box.messages.length);
        index += 1;
        return (message) => inRanges(box.messages.indexOf(message) + 1, ranges);
      }
      if (key === "SINCE" || key === "BEFORE" || key === "ON") {
        const day = imapDayNumber(tokenText(tokens[index]));
        index += 1;
        return (message) => {
          const value = dayNumber(message.internalDate);
          if (key === "SINCE") return value >= day;
          if (key === "BEFORE") return value < day;
          return value === day;
        };
      }
      const headerField = HEADER_SEARCH_FIELD[key];
      if (headerField) {
        const needle = tokenText(tokens[index]).toLowerCase();
        index += 1;
        return (message) => headerContains(fieldsFor(message), headerField, needle);
      }
      if (key === "HEADER") {
        // HEADER <field name> <value>: the field name is the first token, the value the second.
        const field = tokenText(tokens[index]).toLowerCase();
        const needle = tokenText(tokens[index + 1]).toLowerCase();
        index += 2;
        return (message) => headerContains(fieldsFor(message), field, needle);
      }
      if (["TEXT", "BODY"].includes(key)) {
        // The whole raw message, headers included. Neither key is header-specific.
        const needle = tokenText(tokens[index]).toLowerCase();
        index += 1;
        return (message) => message.raw.toString("utf8").toLowerCase().includes(needle);
      }
      if (["SEEN", "UNSEEN", "FLAGGED", "UNFLAGGED", "DELETED", "UNDELETED", "DRAFT", "ANSWERED"].includes(key)) {
        const positive = !key.startsWith("UN");
        const flag = `\\${positive ? key : key.slice(2)}`;
        return (message) => hasFlag(message, flag) === positive;
      }
      throw new Error(`unsupported search criterion ${key}`);
    }

    const tests = [];
    while (index < tokens.length) tests.push(parseOne());
    return (message) => tests.every((test) => test(message));
  }
}

// -----------------------------------------------------------------------------------------------
// SMTP
// -----------------------------------------------------------------------------------------------

/** The EHLO extension lines after the greeting line. */
const SMTP_EXTENSIONS = [
  "PIPELINING",
  "SIZE 35882577",
  "8BITMIME",
  "AUTH PLAIN LOGIN XOAUTH2",
];

/** `MAIL FROM:<address>` / `RCPT TO:<address>`, with an optional trailing parameter list. */
const SMTP_PATH_RE = /^(?:FROM|TO):\s*<([^>]*)>/i;

/**
 * Starts the fake SMTP server. Resolves once it is listening, with the bound port.
 *
 * `raw` on each recorded message is the unframed DATA content, dot-unstuffing already undone.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.users] user -> password; when omitted any non-empty credentials are accepted
 * @param {(address: string) => boolean} [options.rejectRcpt] refuse this recipient with a 550
 */
export async function createFakeSmtpServer(options = {}) {
  const users = options.users ? new Map(Object.entries(options.users)) : null;
  const rejectRcpt = typeof options.rejectRcpt === "function" ? options.rejectRcpt : null;

  const state = {
    messages: [],
    connections: new Set(),
    accepted: 0,
    failDataRemaining: 0,
    queued: 0,
    closed: false,
  };

  const server = net.createServer((socket) => {
    state.accepted += 1;
    const conn = {
      socket,
      decoder: new StringDecoder("utf8"),
      buffer: "",
      // null while a command is expected; otherwise the continuation being collected.
      expect: null,
      auth: null,
      from: null,
      rcpt: [],
      data: [],
      pendingUser: null,
    };
    state.connections.add(conn);
    socket.setNoDelay(true);
    socket.on("data", (chunk) => smtpFeed(conn, chunk));
    socket.on("error", () => {});
    socket.on("close", () => state.connections.delete(conn));
    smtpWrite(conn, `220 ${FAKE_HOST} fake SMTP ready`);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();

  const fake = {
    host: FAKE_HOST,
    port: address.port,
    messages: state.messages,

    /** The next DATA command is refused with a transient failure. */
    failNextData() {
      state.failDataRemaining += 1;
    },

    connectionCount() {
      return state.accepted;
    },

    openConnections() {
      return state.connections.size;
    },

    async close() {
      if (state.closed) return;
      state.closed = true;
      for (const conn of state.connections) conn.socket.destroy();
      state.connections.clear();
      await new Promise((resolve) => {
        // A socket the OS has not torn down yet must not keep the test run alive: the fallback
        // timer is unref-ed, and cleared as soon as the server reports itself closed.
        const timer = setTimeout(resolve, 1000);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };

  return fake;

  // ---------------------------------------------------------------------------------------------

  function smtpWrite(conn, line) {
    if (conn.socket.destroyed) return;
    conn.socket.write(`${line}${CRLF}`);
  }

  function smtpFeed(conn, chunk) {
    conn.buffer += conn.decoder.write(chunk);
    for (;;) {
      const end = conn.buffer.indexOf(CRLF);
      if (end < 0) return;
      const line = conn.buffer.slice(0, end);
      conn.buffer = conn.buffer.slice(end + 2);
      smtpLine(conn, line);
      if (conn.socket.destroyed) return;
    }
  }

  function smtpLine(conn, line) {
    if (conn.expect === "data") {
      // RFC 5321 4.5.2: a leading dot is the transparency escape, and a lone dot ends the data.
      if (line === ".") {
        smtpFinishData(conn);
        return;
      }
      conn.data.push(line.startsWith(".") ? line.slice(1) : line);
      return;
    }

    if (conn.expect === "plain" || conn.expect === "xoauth2") {
      const mechanism = conn.expect;
      conn.expect = null;
      if (line === "*") {
        smtpWrite(conn, "501 5.7.0 Authentication cancelled");
        return;
      }
      if (mechanism === "plain") smtpAuthenticatePlain(conn, line);
      else smtpAuthenticateXoauth2(conn, line);
      return;
    }

    if (conn.expect === "username") {
      conn.pendingUser = Buffer.from(line, "base64").toString("utf8");
      conn.expect = "password";
      smtpWrite(conn, `334 ${Buffer.from("Password:").toString("base64")}`);
      return;
    }

    if (conn.expect === "password") {
      conn.expect = null;
      const password = Buffer.from(line, "base64").toString("utf8");
      const user = conn.pendingUser;
      conn.pendingUser = null;
      smtpAcceptPassword(conn, user, password, "LOGIN");
      return;
    }

    const space = line.indexOf(" ");
    const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase();
    const rest = space < 0 ? "" : line.slice(space + 1);

    switch (verb) {
      case "EHLO": {
        const lines = [`${FAKE_HOST} fake SMTP`, ...SMTP_EXTENSIONS];
        lines.forEach((text, index) => {
          smtpWrite(conn, `${index === lines.length - 1 ? "250 " : "250-"}${text}`);
        });
        return;
      }

      case "HELO":
        smtpWrite(conn, `250 ${FAKE_HOST}`);
        return;

      case "AUTH": {
        const split = rest.indexOf(" ");
        const mechanism = (split < 0 ? rest : rest.slice(0, split)).toUpperCase();
        const inline = split < 0 ? "" : rest.slice(split + 1).trim();
        if (mechanism === "PLAIN") {
          if (inline) smtpAuthenticatePlain(conn, inline);
          else {
            conn.expect = "plain";
            smtpWrite(conn, "334 ");
          }
          return;
        }
        if (mechanism === "LOGIN") {
          conn.expect = "username";
          smtpWrite(conn, `334 ${Buffer.from("Username:").toString("base64")}`);
          return;
        }
        if (mechanism === "XOAUTH2") {
          if (inline) smtpAuthenticateXoauth2(conn, inline);
          else {
            conn.expect = "xoauth2";
            smtpWrite(conn, "334 ");
          }
          return;
        }
        smtpWrite(conn, "504 5.5.4 Unrecognised authentication mechanism");
        return;
      }

      case "MAIL": {
        const match = SMTP_PATH_RE.exec(rest);
        if (!match) {
          smtpWrite(conn, "501 5.5.4 Syntax: MAIL FROM:<address>");
          return;
        }
        conn.from = match[1].trim();
        conn.rcpt = [];
        smtpWrite(conn, "250 2.1.0 Ok");
        return;
      }

      case "RCPT": {
        if (conn.from === null) {
          smtpWrite(conn, "503 5.5.1 Need MAIL before RCPT");
          return;
        }
        const match = SMTP_PATH_RE.exec(rest);
        if (!match) {
          smtpWrite(conn, "501 5.5.4 Syntax: RCPT TO:<address>");
          return;
        }
        const address = match[1].trim();
        if (rejectRcpt && rejectRcpt(address)) {
          smtpWrite(conn, `550 5.1.1 <${address}>: no such recipient here`);
          return;
        }
        conn.rcpt.push(address);
        smtpWrite(conn, "250 2.1.5 Ok");
        return;
      }

      case "DATA": {
        if (conn.from === null || !conn.rcpt.length) {
          smtpWrite(conn, "503 5.5.1 Need MAIL and RCPT before DATA");
          return;
        }
        if (state.failDataRemaining > 0) {
          state.failDataRemaining -= 1;
          conn.from = null;
          conn.rcpt = [];
          smtpWrite(conn, "451 4.3.0 temporary failure, try again later");
          return;
        }
        conn.data = [];
        conn.expect = "data";
        smtpWrite(conn, "354 End data with <CR><LF>.<CR><LF>");
        return;
      }

      case "RSET":
        conn.from = null;
        conn.rcpt = [];
        smtpWrite(conn, "250 2.0.0 Ok");
        return;

      case "NOOP":
        smtpWrite(conn, "250 2.0.0 Ok");
        return;

      case "QUIT":
        smtpWrite(conn, "221 2.0.0 Bye");
        conn.socket.end();
        return;

      default:
        smtpWrite(conn, "502 5.5.2 Command not recognised");
    }
  }

  function smtpFinishData(conn) {
    const raw = conn.data.join(CRLF);
    state.messages.push({
      from: conn.from,
      rcpt: [...conn.rcpt],
      raw,
      auth: conn.auth ? { ...conn.auth } : null,
    });
    state.queued += 1;
    conn.data = [];
    conn.from = null;
    conn.rcpt = [];
    conn.expect = null;
    smtpWrite(conn, `250 2.0.0 Ok: queued as fake-${state.queued}`);
  }

  function smtpAcceptPassword(conn, user, password, method) {
    if (!user || (users && users.get(user) !== password)) {
      smtpWrite(conn, "535 5.7.8 Authentication credentials invalid");
      return;
    }
    conn.auth = { user, method };
    smtpWrite(conn, "235 2.7.0 Authentication successful");
  }

  function smtpAuthenticatePlain(conn, payload) {
    // PLAIN carries [authorization identity] NUL user NUL password; nodemailer sends no authzid.
    const parts = Buffer.from(String(payload).trim(), "base64").toString("utf8").split("\u0000");
    const user = parts.length >= 3 ? parts[1] : "";
    const password = parts.length >= 3 ? parts[2] : "";
    smtpAcceptPassword(conn, user, password, "PLAIN");
  }

  function smtpAuthenticateXoauth2(conn, payload) {
    // `user=<address>\x01auth=Bearer <token>\x01\x01`, all base64-encoded as one blob.
    const decoded = Buffer.from(String(payload).trim(), "base64").toString("utf8");
    const fields = decoded.split("\u0001");
    const userField = fields.find((field) => field.startsWith("user=")) ?? "";
    const authField = fields.find((field) => field.startsWith("auth=")) ?? "";
    const user = userField.slice("user=".length);
    const token = authField.replace(/^auth=Bearer\s*/i, "").trim();
    if (!user || !token || (users && !users.has(user))) {
      smtpWrite(conn, "535 5.7.8 Authentication credentials invalid");
      return;
    }
    conn.auth = { user, method: "XOAUTH2" };
    smtpWrite(conn, "235 2.7.0 Authentication successful");
  }
}