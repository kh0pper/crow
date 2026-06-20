---
title: Crow Messages
---

# Crow Messages

Crow Messages lets your agents be reachable the same way people are: as contacts you message. You can share a bot so someone else can talk to it, browse the bots running across your own Crows and add them with a click, and put people and bots together in a group room. It runs on Crow's peer-to-peer messaging, so conversations are end-to-end encrypted and travel over public relays with no central server in the middle.

The guiding idea of the whole feature is one line: **a bot is a contact.** Everything below is built on that, so a bot shows up, gets messaged, and joins a group exactly the way a person does, just with a bot badge.

## Share a bot

Every agent that runs a **Crow Messages** gateway gets its own messaging identity, derived from your instance, so it can be addressed directly. From the bot's editor you can share it:

- A share **link** and a scannable **QR code** that carry a signed, single-use-or-limited invite.
- A **"Who can message"** list (the access control list). Sharing is **default-deny**: only the people you have invited or added can reach the bot. You can revoke any of them at any time.
- An **"allow paired instances"** toggle. When it is on, your own other Crows (the instances you have paired) can message the bot without a separate invite, which is what makes the directory and group rooms below work across your fleet.

Sharing never exposes the bot to the open internet. An invite authorizes one specific person's key, and the bot answers as itself, under its own persona, skills, and permission policy.

## Message a bot, or accept an invite

When someone shares a bot with you, you accept the invite and the bot appears in your **Messages** list like any other contact, with a bot badge. Two ways in, both from the Messages **"+"** menu:

- **Add a Bot**: paste an invite code you were given.
- A **deep link** from a share link opens the accept flow directly.

From then on it is an ordinary conversation. You type, the agent answers from its own identity, and the thread lives alongside your other messages.

## Browse the bots across your Crows

If you run more than one Crow, the bots you have opted into sharing are advertised to your other paired instances, so you can find and add them without copying invite codes around. The directory shows every advertised bot grouped by which Crow it runs on, each with a short tagline, and marks the ones you have already added.

You can open the directory from two places:

- **Contacts → Browse Crow bots**
- **Messages → "+" → Message a Bot**

Adding a bot from the directory materializes it as a contact and drops you straight into a conversation.

## Group rooms: people and bots together

A room is a multi-party thread that mixes people and bots. You create one, name it, and add members the same way you would add a contact, including your bots. This is the part the operator asked for in plain words: "add a bot to a chat like adding a contact."

Create a room from **Messages → "+" → New Group**: give it a name, pick members (people and bots, bots badged), choose how bots should reply, and you are in.

**How bots take a turn.** Each room has a setting for when its bots speak:

| Mode | Behavior |
|---|---|
| **Only when addressed** (default) | A bot replies only when a person @mentions it or names it. People can chat freely without the bot interjecting, and with several bots in one room only the one you address answers. |
| **To every message** | Each bot in the room answers every message a person sends. Lively with a single bot, noisier with several. |

**Bots never answer each other.** A bot only ever reacts to a message a *person* wrote, never to another bot's message. That is a structural rule, not a tuning knob, so a room full of bots can never spiral into a loop talking to itself.

**Managing a room.** From the room header you can rename it, switch the reply mode, add or remove members (people or bots), and delete the room. Removing a member stops relaying to them; deleting a room clears its history.

## Privacy and control

- **Default-deny everywhere.** A bot answers only people on its access list; a room relays only to its members. Nobody reaches a bot or a room by guessing.
- **Verified senders.** Every message is authorized by the sender's cryptographic signature, never by a name or label in the message body, so a participant cannot impersonate someone else to make a bot act.
- **You host your rooms.** A room you create is relayed by your own Crow. You decide who is in it and can remove anyone.
- **No central server.** Messages are end-to-end encrypted and move over public relays. Crow is the only thing that holds your side of the conversation.

## Related

- [Bot Builder](/guide/bot-builder): Build the agents you share and add to rooms
- [Social & Messaging](/guide/social): Crow's person-to-person messaging
- [Contacts](/guide/contacts): Manage people and bots as contacts
- [Sharing](/guide/sharing): Share memories, projects, and files with other Crows
- [Bot Builder Architecture](/architecture/bot-builder): The messaging adapter, identities, and rooms model
