---
layout: home

hero:
  name: Crow
  text: A modular, agentic framework that runs on your hardware and answers to you
  tagline: Build and run your own AI agents for assistance, research, projects, and home. Works with Claude, ChatGPT, Gemini, Cursor, and more. Your AI, your devices, your data.
  image:
    src: /crow-hero.svg
    alt: Crow
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/
    - theme: alt
      text: Build an Agent
      link: /guide/bot-builder
    - theme: alt
      text: P2P Sharing Guide
      link: /guide/sharing
    - theme: alt
      text: View on GitHub
      link: https://github.com/kh0pper/crow

features:
  - icon:
      src: /icon-platforms.svg
    title: What is Crow?
    details: A server you run on your own hardware that gives your AI assistant persistent memory, project management, agents, a blog, and file storage. It speaks the open Model Context Protocol, so every major AI platform understands it and you are never locked in.
  - icon:
      src: /icon-mcp.svg
    title: Build Your Own Agents
    details: The Bot Builder lets you compose an agent from a persona, skills, tools, and permissions, then run it over Gmail, Discord, or Meta glasses. Each agent is scoped to the tools you grant it, and opt-in self-authoring stays behind an operator-approval gate.
  - icon:
      src: /icon-platforms.svg
    title: Hop Between Platforms
    details: Use Claude for research, ChatGPT for writing, Cursor for code. Crow keeps your context synchronized across all of them. No more starting over.
  - icon:
      src: /icon-memory.svg
    title: Persistent Memory
    details: Store and search memories across sessions and platforms. Full-text search, categories, importance scoring, and automatic context recall.
  - icon:
      src: /icon-research.svg
    title: Project Management & Research
    details: Organize work with typed project workflows. Research projects carry multi-format citations (APA, MLA, Chicago), bibliographies, and source verification, and data-connector projects bridge external databases and APIs. Every claim links to a stored, verified source.
  - icon:
      src: /icon-sharing.svg
    title: Encrypted P2P Sharing
    details: Share memories, projects, and messages directly with other Crow users. End-to-end encrypted via Hypercore and Nostr, with no central server, no accounts, and no metadata leaks.
  - icon:
      src: /icon-integrations.svg
    title: Extensible with Add-ons
    details: 20+ integrations out of the box (Gmail, GitHub, Slack, and more) plus self-hosting add-ons (Obsidian, Home Assistant, Ollama, Nextcloud, Immich). Install by asking your AI, and any add-on's tools become available to your agents.
  - icon:
      src: /icon-deploy.svg
    title: Your Data Stays Yours
    details: Crow stores your data on infrastructure you control. Pair it with a local model and nothing ever leaves your network. Connect a cloud assistant and only what you send that provider goes out, on your terms.
  - icon:
      src: /icon-deploy.svg
    title: Managed, Cloud, or Self-Host
    details: Self-host on Oracle Cloud for free, run on a Raspberry Pi, or use managed hosting. Multi-instance sync pulls all of your devices into one interface.
---
