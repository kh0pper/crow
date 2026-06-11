# Crow — Vision & Principles

**Date:** 2026-06-10
**Source:** Operator interview (brainstorming-style, one question at a time), conducted as Phase 0 of the top-to-bottom overhaul. Confirmed by the operator.
**Role of this document:** This is the rubric every overhaul finding and change is judged against. If a "fix" would violate this document, it is not a fix. Re-open the interview whenever a decision hinges on intent not captured here.

---

## 1. North-star

**The two-year goal is accessibility: a non-technical user gets the full benefit of agentic AI tools without ever working in a terminal.**

- Sovereignty and privacy are foundational properties, not the headline. They are what make the beachhead market possible.
- **Beachhead: public-education administration.** Privacy is non-negotiable there (FERPA-sensitive settings), and one incident kills adoption. After education: business, home, and personal use cases.
- Long arc, in order of nearness: (1) personal sovereignty engine — individual operators running their own memory/agents/data on their own hardware; (2) the household AI server — what Plex/Home Assistant are for media/smart-home, Crow is for AI; (3) a real developer ecosystem — third parties building bundles, panels, skills, integrations.
- The destination is an adaptable **"Everything platform for the age of AI"** — the same framework pointing at very different fields (education, law, business, home) without forking.

## 2. Identity rubric

The F7 dual-use spine, **extended with accessibility as a first-class element**:

> Crow is an agentic framework + first-class MCP connector (the supported extension point, not a third-party harness you run instead of your client), self-hosted on hardware you own, with local or cloud models, P2P + multi-instance + the open-source Android app — **usable by someone who never opens a terminal.**

- Every public doc page and every change is measured against that sentence.
- The overhaul may refine wording but not the spine itself; the accessibility clause is the one deliberate evolution from F7.
- A bundle remains the unit of capability: service + MCP tools + skills. One system of record, two modes of access (your agents; your AI client).

## 3. State of the gap (operator's own assessment)

All four are real and acknowledged:

1. **Accumulated sprawl** — legacy layers, duplicated mechanisms, oversized modules, drifted docs; the system feels patched-together rather than coherent.
2. **Fragile day-2 operations** — updates, fleet drift, DB locks, silent breakage; fine for the operator, fatal for a school administrator.
3. **Setup is still technical** — zero-to-working still assumes a terminal-comfortable operator despite the wizards.
4. **Capability ahead of polish** — the features exist (agents, P2P, bundles) but UX/dashboard/docs don't yet let a normal person discover and use them confidently.

**Priority decision: unification leads.** Coherence first, because every other dimension — onboarding, polish, day-2 reliability, even security — gets cheaper once the system is coherent. The remaining order: security close behind (the beachhead demands it), then onboarding/day-2, then polish.

## 4. Design principles

1. **Layered disclosure** (the confirmed tiebreaker between "invisible machinery" and "legible & honest" — both, layered):
   - The default surface is invisible-machinery: plain-language notices, one-click fixes, opinionated defaults, few knobs. The user never *needs* to think about the system.
   - Full legibility — logs, state, what-ran-when, diagnostics — lives one layer down, opt-in, for those who want it. Complexity is opt-in, never required.
   - Canonical example (operator-confirmed): an integration token expires and an agent's email turn fails → the administrator sees a plain-language notice with a one-click fix; the curious can open a layer down and see exactly what ran and why it failed.
2. **Composable & minimal** — small, orthogonal pieces with clean seams. Each part does one thing; power comes from combination; nothing exists that doesn't earn its place. YAGNI applies to the platform itself.
3. **Resilient & forgiving** — hard to break, easy to recover. Degraded modes instead of failures; every action recoverable where possible; errors that teach instead of punish.
4. **Invisible machinery as the product feel** — when the overhaul is done, Crow should *feel* like it anticipates, recovers, and explains itself.

## 5. Appetite for change & the one absolute

- **Nothing is architecturally sacred.** The operator's words: "nothing is sacred. I am truly looking for opportunities to improve." Every layer — the live agents, the MCP surface, the dashboard, the P2P stack, the schema — is open to redesign if the redesign genuinely improves the system against this document.
- **The one absolute: user data is substrate.** Memories, projects, files, blog posts, identity keys — zero loss, ever. Schema may change; data must survive the change.
- Hard operational guardrails (from the overhaul charter, unchanged by the above): the funnel/network-exposure invariant is sacrosanct; prod downtime must be intentional, bounded, and self-restoring; fleet + pull-only-deploy compatibility.

## 6. Operational decisions captured in the interview

1. **Android WIP:** the uncommitted `CrowWebViewClient.java` per-tailnet hardening is to be reviewed and committed to main before any overhaul branching (don't orphan it).
2. **Stale branches:** the ~8 local + ~24 remote unmerged branches get a Wave-0 housekeeping audit — prune what's merged/superseded; anything holding unmerged value is surfaced to the operator before deciding.

## 7. How to use this document

When evaluating a finding or a proposed change, ask in order:

1. Does it move a non-technical user closer to full value without a terminal? (§1)
2. Is it consistent with the spine? (§2)
3. Does it reduce sprawl / increase coherence? (§3 — the leading dimension)
4. Does it follow layered disclosure, composability, and forgiveness? (§4)
5. Does it preserve user data absolutely, and respect the operational guardrails? (§5)

A change that scores well on 3–4 but regresses 1–2 is not an improvement. A "fix" that violates the spine is not a fix.
