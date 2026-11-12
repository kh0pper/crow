---
title: History, Trash and Undo
---

# History, Trash and Undo

Crow keeps the earlier versions of the things you keep in it. If you, a bot or one of your other machines changes something, you can see who changed it and when, and put the earlier version back. It is on by default on every install.

## What is kept

- Memories and context sections (every scope)
- Blog posts and drafts
- Project notes, research sources and knowledge base articles
- Bot settings and instructions. A bot's credential fields are never kept. In anything History keeps, a value that looks like a key or a token is stored with the secret blanked out.
- Board cards: title, description and plan
- Artifacts, through their own version list. A restore adds a new version made from the old one.
- Project files: everything in a project's workspace folder

Studio songs keep their own undo inside Studio. They only appear here, read-only, in the list of what a job touched, listed by name.

Messages, notifications and Settings are not kept: they are conversation and configuration, not work.

## Who changed it

Every version says who made it:

- **You**: a change from your own signed-in session
- **A named bot**: the bot that made the change
- **Another machine**: a change that arrived from one of your paired Crows
- **System**: something Crow did itself
- **Unattributed**: a change that came in with no author attached, for example a file edited outside Crow

A change is never recorded under someone else's name, and an unknown author is never shown as you.

## Looking at an item's History

Open the **History** button on a memory, a context section or a blog post and you see its versions, newest first, with the time, the author and what changed: added text and removed text for writing, before and after for settings and numbers. Saves by the same author within a couple of minutes count as one version.

Other kinds of items (notes, research sources, articles, bots, cards, artifacts) keep their versions too, but they do not all show up on the **Jobs** and **Trash** pages yet. Notes, research sources, articles and bot settings are listed there, along with memories, context sections and blog posts. Artifacts keep their own version list in the artifact view. A card's versions are kept, but there is no page to browse them yet. So far only memories, context sections and blog posts have a History link on their own screen.

## Restore

**Restore** puts an earlier version back. The restore is itself a new version at the top of the list, so restoring never loses anything, and you can restore again to go back.

- A version whose secret was blanked cannot be restored; pick another one.
- A **card** restore brings back the card's content only (title, description, plan). The card keeps its live status and its bot, so putting back old words does not move work around.
- A **deleted card** comes back unassigned, on the board's first column, waiting for your go-ahead. It does not go back to the bot that had it. The Trash page does not list cards yet.

## Undo this job

A job is one piece of work: a board card, a voice hand-off, a chat turn, a schedule, or your own sign-in. **Undo this job**, on the Jobs page, puts back the memories, context sections, blog posts, notes, research sources, articles and bot settings that job changed. Project files, board cards and artifacts are not part of an undo yet; restore them one at a time.

An undo can be partial. If something else has changed an item since (you, or another job), the undo leaves that item alone, so it never overwrites newer work, and lists what it skipped, by type and number; the job's list on the Jobs page shows each one by name. Memories, context sections and blog posts can each be restored from the History link on their own screen, and notes, research sources, articles and bot settings from the job's list on the Jobs page. An undo cannot itself be undone from that page; restore the items one by one instead.

## Trash and erase

A deleted item goes to the **Trash** with its whole history. You can restore it from there. It stays for **30 days** by default, and you can change the number of days in Settings, under History. After that it is **erased for good**, together with its history, from the live store. You can also empty the Trash earlier. Edits are never erased this way. Not every kind of item is listed in the Trash yet: notes, research sources, articles and bot settings are, cards are not.

Backups are separate. Copies in your backups disappear as those backups expire, and how long that takes depends on your backup schedule.

### Erase on paired machines

Each machine erases on its own clock. **Tell paired Crows when something is erased** (`history.erase_sync`) is off by default, and a paired Crow applies an erase only if it has this setting turned on too. Turn it on only once every paired Crow runs Crow from the version history update that added notes, articles, bots, cards and artifacts; an older machine would not understand the message. The setting belongs to this machine and is never sent to the others.

### Project files

Deleted project files wait in the file history. Erasing them on a schedule is a separate setting, `history.workspace_auto_erase`; it is off by default and has no switch in Settings yet. A page for browsing and restoring project files is not part of the dashboard yet, so until it is, the file history is the only copy of a file a bot deleted. A project that is deleted for good has its file history erased with it.

## What is skipped

File history records what a bot or you leave in a project folder, except:

- credential and key files (for example `.env`, `.mcp.json`, `*.pem`, `*.key`, SSH keys), a bot's private session files, and password stores
- caches and dependencies (for example `node_modules`, `.venv`, `__pycache__`, `dist`, `target`)
- local databases (`*.db`)
- files over 25 MB, because history is not a second copy of a video or a model

A project's own ignore file does not hide anything from the history.

A technical owner can clone a project's file history from the project's `repo_path`.

## Retention

Settings, under History, shows the retention line. Today it is **forever**: versions stay until their item is erased from the Trash, and there is no control to change it yet. When other retention choices arrive, they will apply to existing history from then on.

## The size line

History takes disk space, so Settings, under History, shows how much: the number of versions and their size for notes, posts, cards and the rest, and the size of project file history. If a part cannot be measured at that moment it says so, and the total may be higher.

When all of History is more than a tenth of the free space left on the machine, the page shows a warning. Because the warning goes by the free space, it comes sooner on a small machine such as a Raspberry Pi and stays quiet on a large disk. If you see it, free up space or shorten how long deleted items stay in the Trash.

## A caveat about bots

Bots that can write to Crow's database directly could still change this history. That gap closes when bot containment is turned on. The History pages show this notice until then.
