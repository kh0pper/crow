---
title: Mail
---

# Mail

Crow can hold your IMAP mailboxes in its own database and give you one reader for all of them in
Crow's Nest: one inbox across accounts, folders and labels, an open message with its whole
conversation, search, older mail fetched on demand, attachments, and remote images on your terms. It
is built for a phone first — one column, every tap target big enough for a thumb — and it works the
same on a desktop.

Your mail stays on your instance. The mail tables are local-only: they are never replicated to a
paired Crow, never put in a peer's outbox and never shared with a project. Each address is connected
on **one** instance; another Crow that sees the same address connected says "Mail is set up on
&lt;instance&gt;" instead of connecting it a second time.

## Turn it on

Mail is behind a flag:

```bash
CROW_MAIL=1
```

With it set, **Mail** appears in Crow's Nest under **More of Crow**. Nothing dials out until you
connect an account. With it unset, every Mail page and route answers "not found".

## Connect an account

The first time you open **Mail** with no account connected, the page offers **Connect your mail**. That
opens the settings page (`/dashboard/mail?view=settings`), where the add-account form lives. Fill in:

- a **label** you will recognise in the account chips (anything you like);
- the **address**;
- the **password** — for a provider that wants an app password, create one and paste that;
- the **IMAP** host, port and security (`ssl` or `starttls`), and the same for **SMTP**.

Only one Crow holds an address: if another of your instances already has it, the settings page names
that instance, and connecting the same address here is refused. A different address connects normally.

An account that cannot sign in shows "Sign-in failed. Update the password." with an **Update
password** button. The rest of the accounts keep working.

## The inbox

The inbox opens on **All**: the newest mail from every account in one list. The chips above the list
narrow it to a single account, and each row shows:

- an unread dot, or none for a message you have read;
- the sender's name (or their address, or "Unknown sender");
- the subject, or "(no subject)";
- the first line of the message;
- the time — the clock time if it arrived today, otherwise the day, and the year once it is a
  different year.

A page holds thirty messages; **Load more** brings the next thirty. **Refresh** asks each account's
server for new mail, and pulling the list down from its top does the same thing.

## Folders and labels

**Folders** opens a drawer per account, with the unread count beside each folder. Gmail labels are
folders here too, so your labels are as reachable as your inbox. The provider's own virtual views
(Gmail's "All Mail", "Flagged" and "Important") are not listed, because Crow does not keep a copy of
them.

A message that Gmail files in the inbox and in a label is one message here: it shows once, as the
inbox copy, however many labels it carries.

## Reading a message

Tap any row to open the message: subject, sender, a **to** line you can expand for the To and Cc
recipients, and the full date. Under the header is the whole conversation, oldest first; the newest
message and the one you tapped are open, the rest are collapsed until you open them. A collapsed
message loads nothing, so a thread of two hundred messages stays quick.

The message text renders in its own frame, with Crow's styling around it and no scripts from the mail
running anywhere.

## Images

Remote images in mail are **blocked** by default, so a sender learns nothing about when you opened
their message. When a message holds blocked images you get a banner with two choices:

- **Show images** — for this view only. Nothing is stored, and the next time you open the message the
  images are blocked again.
- **Always show from &lt;sender&gt;** — remembered for that sender on that account, until you remove it
  on the settings page, where every allowed sender has its own **Remove** button.

Two limits are worth knowing:

- **"Always show from &lt;sender&gt;" keys on the From address, which anyone can forge.** A sender can
  claim to be someone you have allowed, so only allow senders you would trust to be who they say they
  are.
- **Images declared 2 px or smaller on either side are removed** as tracking pixels, even when images
  are shown. A tracking pixel that declares no size at all is not recognised by that rule, so it can
  still load when you show images — blocking images, the default, is what stops every one of them.

## Search

The box at the top of the list searches the mail Crow has stored. Hits look like the inbox rows and
open the same way.

Crow keeps the last 90 days of each folder, plus whatever you have brought back by asking for older
mail. For everything else, **Search older mail on the server** asks each account's mail server and
tells you how many more it found; those messages are stored and searchable from then on.

## Older mail

At the end of a list, **Look further back** asks the server for mail older than anything Crow holds in
those folders, and adds what it finds. When there is nothing older left, it says so.

## Attachments

A message with attachments lists each one with its name and size and a **Download** link. The file is
fetched from the mail server at the moment you ask for it, not kept in Crow. That link is a plain
download, so anything over about 18 MB comes back as a failed download carrying the message "This
attachment is over about 18 MB, too large to download here."

## Acting on a message

This release has no message actions yet. **Mark unread**, **Archive**, **Delete**, **Move…** and
marking an unread message read when you open it arrive with the next release (message actions).

## Settings

The settings page (`/dashboard/mail?view=settings`) lists every account with its status ("Working",
"Sign-in failed. Update the password.", or "Connected on &lt;instance&gt;") and the time of its last
sync, and offers:

- **Sync now**;
- a **label** you can rename, and **Local models only** ("Applies when Crow drafts or summarises with a
  model." — the switch is stored with the account and matters when Crow drafts or summarises mail);
- **Update password** for an account that cannot sign in;
- the senders you have allowed to show images, each with **Remove**;
- **Remove this account**: "This deletes the mail Crow stored for it. Mail on the server is not
  touched."

Removing an account also removes the password Crow sealed for it. Mail passwords are not deletable
from the Passwords settings page — that page points you here instead.

## Related

- [Crow's Nest](/guide/crows-nest): Where Mail lives, and how the drawer works
- [Multi-Instance Chaining](/guide/instances): Why one address is connected on one Crow
- [Mail store and sync](/developers/mail-store-and-sync): The tables, the sync engine and the reader's
  design