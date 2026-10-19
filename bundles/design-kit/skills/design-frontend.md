---
name: design-frontend
description: Give pages, documents and diagrams a bold, intentional look instead of a generic one. Ported from Anthropic's frontend-design skill (Apache-2.0).
triggers: ["design", "make it look good", "styled page", "landing page", "mockup", "visual design"]
license: Apache-2.0 — complete terms in third_party/anthropic-skills/frontend-design/LICENSE.txt; changes are listed in NOTICE.
---

Modified from anthropics/skills `frontend-design` (Apache-2.0); full licence text and change list ship in the Design kit bundle (LICENSES.md, NOTICE).

# Frontend Design

Approach this as the design lead at a design studio known for giving every client a distinct visual identity that is not mistaken for anyone else's. This client has already rejected proposals that felt cliché or templated, and is paying for a distinctive point of view: make deliberate, opinionated choices about palette, typography, and layout that are specific to this brief, and take aesthetic risk if justified.

## Ground your designs in the subject matter

If the brief does not identify what the product or subject matter is, identify it yourself before designing, and confirm with the client. You can come up with one concrete subject, the design's audience, and the design's primary job, as a proposal. If there's any information in your memory about the client's preferences or context about what they're building, use that as a hint. The subject's industry, subject matter, materials, and vernacular are where distinctive visual choices come from — a design for a toy for girls aged 8–11 will be very aesthetically different from a dashboard for financial analysts. Build with the brief's real content and subject matter throughout.

## Design principles

For web designs, the hero is the first thing viewers will see. Open with the most characteristic thing in the subject's world, in the form that is most appropriate: a headline, an image, an animation, a live demo, an interactive moment, or other treatments. Be deliberate with your choice: a big number with a small label, supporting stats, and a gradient accent is the default treatment, so only use it if that's truly the best option.

Typography carries the personality of the page. You don't need a different typeface for display or headline text and body content: use one family or two, and if two, make them clearly distinct.

Choose your typefaces deliberately, not the default families you would reach for on any other project, and set a clear type scale following the default guidance of The Elements of Typographic Style with intentional weights, widths, and spacing. When type is used as a headline or visual element, use the type treatment itself as an active part of the design, not a neutral delivery vehicle for the content.

Default to line lengths of less than 80 characters. Serif typefaces can have slightly longer line lengths; give serif body text slightly more line-height than a sans-serif.

Avoid these default typographic treatments; they are the commonest tells of a generated page:
- Accenting just a single word or phrase in a headline, like putting one word in italic/bold or a different color.
- Using all caps for labels.
- Adding unnecessary typographic labels above content.

Visual structure is information. Structural devices like outlines, borders, numbering, eyebrows, dividers, labels, etc., encode useful information about the content rather than decorate it. Many generic designs use numbered markers (01 / 02 / 03), but that's only appropriate if the content actually is a sequence — like a stepped process or a timeline. Before adding numbered markers, check the content really is a sequence.

Use non-user-triggered motion sparingly and deliberately, only to draw attention. A single orchestrated moment — one page-load sequence or one reveal — lands better than scattered effects; fade-and-slide-up entrances on each section and hover transitions on every card are the generic default and read as AI-generated. Motion that answers a person's action (opening, expanding, confirming) is welcome when it shows what changed.

Consider written content carefully. Often a design brief may not contain real content, and it's up to you to come up with copy and placeholder content. Copy can make a design feel as templated as the design itself. See the below section on writing for more guidance.

## Process: plan, review against the brief, build, critique

For calibration, AI-generated design right now clusters around some traits:
1. a warm cream background (near #F4F1EA) with a high-contrast serif display and a terracotta or warm-clay accent (often near #D97757 — Anthropic's own Claude-interaction accent, so on a user's brief it reads as a tell);
2. a near-black background with a single bright acid-green or vermilion accent;
3. a broadsheet-style layout with hairline rules, zero border-radius, and dense newspaper-like columns;
4. the SaaS-card kit: content chopped into identical rounded cards, one border-radius on everything regardless of hierarchy, the same soft grey shadow (rgba(0,0,0,.1)) under each, and gradient washes as decoration;
5. template chrome that appears whatever the subject: a tracked-out ALL-CAPS eyebrow label above every heading; meta strings joined with middle dots ('A · B · C'); labels built as 'WORD — fragment' with a spaced em dash; tinted near-black (#0B0B0B, #111) standing in for black; a monospace face for small data labels; a '→' appended to link and button text.

All traits are legitimate for some briefs, but they are defaults rather than choices, and they appear regardless of subject. Where the brief pins down a visual direction, follow it exactly — the brief's own words always win, including when it asks for one of these looks. Where it leaves an axis free, don't spend that freedom on one of these defaults. As with a hired human designer, there's often a careful balance between doing what you're good at and taking each project as a chance to experiment and learn.

Work in two passes. First, brainstorm a short design plan based on the client's design brief: create a compact token system with color, type, layout, and principles.
- Color: describe the core base palette as 4–6 named hex values.
- Type: the typefaces and their roles.
- Layout: a layout concept, using one-sentence prose descriptions and ASCII wireframes to ideate and compare. Include alignment guidance; should the content be left aligned, center aligned, justified?
- Principles: the high-level guidance for what makes this page unique.

Then review that plan against the brief before building: if any part of it reads like the generic default you would produce for any similar page (work through a similar prompt to see if you arrive somewhere similar) rather than a choice made for this specific brief — revise that part, say what you changed and why. Only after you've confirmed the relative uniqueness of your design plan should you start to write the code, following the revised plan.

When writing the code, be careful of structuring your CSS selector specificities. It's easy to generate CSS classes that cancel each other out (especially with a type-based selector like .section and an element-based selector like .cta). This can happen often with padding/margin between sections.

## Restraint and self-critique

Spend your boldness in one place. Let one element be the memorable thing, keep everything around it quiet and disciplined, and cut any decoration that does not serve the brief. Build to a quality floor without announcing it: responsive down to mobile, visible keyboard focus, reduced motion respected, visually accessible, harmonious color palettes. Critique your own work as you build, taking screenshots to review if your environment supports it — a picture is worth 1000 tokens. Consider Chanel's advice: before leaving the house, take a look in the mirror and remove one accessory. Human creatives have memory and always try to do something new, so if you have a space to quickly jot down notes about what you've tried, it can help you in future passes.

## More on writing in design

Words appear in a design for one reason: to make it easier to understand and use. They are design content, not decoration. Bring the same intentionality and minimalism to copywriting that you would bring to spacing and color. Before writing anything, ask what the design needs to say, and how it can best be said to help the person navigate the experience.

Write from the end user's perspective. Name things by what users will understand in simple language, not by how the system is built. A user manages notifications, not webhook config. Describe what something is or does in plain terms rather than selling it. Being specific and legible to new users is always better than being clever.

Use active voice as default. A CTA says exactly what happens when it is used: "Save changes," not "Submit." An action keeps the same name through the whole flow, so the button that says "Publish" produces a toast that says "Published." The vocabulary of an interface is the signposting for someone navigating the product. Cohesion and consistency are how people learn their way around.

Treat failure and emptiness as moments for direction, not mood. Explain what went wrong and how to fix it, in the interface's voice rather than a person's. Errors don't apologize, and they are never vague about what happened. An empty screen is an invitation to act.

Keep the tone conversational: plain verbs, sentence case, no filler, with tone matched to the brand and the audience. Let each written element do exactly one job.

## Using the Design kit in Crow

What you make runs with **no network**. Never load fonts, scripts, styles or images from another site or a CDN. Reference the kit's library **by name** in `libs` instead; Crow copies the pinned files into the version you save.

**Names you can use in `libs`**
- Fonts: `font:lora`, `font:crimson-pro`, `font:young-serif`, `font:instrument-serif`, `font:work-sans`, `font:outfit`, `font:instrument-sans`, `font:bricolage-grotesque`, `font:jetbrains-mono`, `font:ibm-plex-mono`.
- Icons: `icons:lucide/<name>` or `icons:tabler/<name>`, one entry per icon (for example `icons:lucide/coffee`).
- CSS: `css:open-props` (design tokens as CSS custom properties) and `css:pico` (classless base styles).
- Page scripts (pages only): `vega-embed` (brings Vega and Vega-Lite with it), `mermaid`, and `sunvox` (a modular synth engine — interactive or generative music).

**Where they land:** under `__lib/`. `font:lora` → link `__lib/font/lora/font.css`, then `font-family: "Lora", serif`. `icons:lucide/coffee` → `<img src="__lib/icons/lucide/coffee.svg" alt="">`. `css:open-props` → `__lib/css/open-props/open-props.min.css`. `css:pico` → `<link rel="stylesheet" href="__lib/css/pico/pico.min.css">`: always link Pico as a file, never paste it into a `<style>` block (its icons are relative paths that only work from the file). `vega-embed` → load `__lib/js/vega/vega.min.js`, `__lib/js/vega-lite/vega-lite.min.js`, `__lib/js/vega-embed/vega-embed.min.js` in that order. `mermaid` → `__lib/js/mermaid/mermaid.min.js`. `sunvox` → load `__lib/js/sunvox/sunvox.js`, then `__lib/js/sunvox/sunvox-wasm.js`, then `__lib/js/sunvox/sunvox_lib_loader.js`, in exactly that order (the middle file carries the engine's WASM and wraps its factory, so it must sit between the two). The save result lists the exact paths. In a document, CSS and font libraries apply by themselves: the first font is the body text, the second the headings.

**Interactive charts in a page:** `vegaEmbed("#chart", spec, { actions: false, ast: true })`. Pages forbid `eval`, so always pass `ast: true`: vega-embed then uses the CSP-safe expression interpreter it carries.

**Interactive music in a page (`sunvox`):** once the three scripts have run, the engine is ready at `svlib.then(Module => { … })`. Inside: `sv_init(null, 44100, 2, 0)`, `sv_open_slot(0)`, then either `sv_load_from_memory(0, bytes)` with a Uint8Array (ship a `.sunvox` track as a base64 asset and decode it in the page), or build voices live: `sv_new_module(0, "Analog generator", "lead", 512, 400, 0)` + `sv_send_event(0, track, note + 1, velocity, module + 1, 0, 0)` (note numbers: C0 = 1). Transport: `sv_play_from_beginning(0)`, `sv_pause(0)`, `sv_resume(0)`, `sv_stop(0)`, `sv_volume(0, 0..256)`, position from `sv_get_current_line(0)`. Browsers start audio only after a user gesture — wire the init to a Play button. Everything runs from the copied files; nothing is fetched at runtime.

**Charts and diagrams anywhere (Crow renders them to SVG; no scripts needed):**
- In a document, a fenced block: ```` ```vega-lite ```` (JSON), ```` ```mermaid ```` or ```` ```d2 ````.
- As a diagram artifact: source `{ "engine": "mermaid", "source": "flowchart LR\n  A --> B" }` (or `"vega-lite"`, `"d2"`). The `\n` there is JSON's way of writing a line break; the diagram text itself must not contain backslashes.

Rules. Each one is checked before rendering, and a spec that breaks one is refused with a short reason:
- **Vega-Lite:** JSON only. Data must be inline (`"data": { "values": [...] }`). No `url`, `href` or `usermeta` keys anywhere outside the data rows.
- **Mermaid:** the diagram types `flowchart`, `graph`, `sequenceDiagram`, `classDiagram`, `stateDiagram`, `stateDiagram-v2`, `erDiagram`, `gantt`, `pie`, `timeline` and `mindmap`, nothing else. Start with the type line. No front matter: no line that is just `---`, anywhere. No `%%{` directives and no `config` or `init` in the comments before the type line or on it. No links of any kind: the words `click`, `link`, `links`, `callback` and `href` are refused anywhere, even inside a label (reword it), and so are `//`, `url(`, `javascript:` and `@{` shape data. No backslashes (write a line break in a label as `<br>`). No HTML tags except `<br>` and the class annotations `<<interface>>`, `<<abstract>>`, `<<enumeration>>`, `<<service>>`, `<<fork>>`, `<<join>>` and `<<choice>>`.
- **D2:** no `icon` anywhere, not even inside a longer word such as "silicon" or "lexicon" (reword it). No imports (`import`, `@file`, `...@file`; an `@` is only accepted inside a word, as in an email address). No `link` and no `//`. No `vars` and no `d2-config`. No `|md`, `|markdown`, `|latex` or `|tex` blocks. No backslashes and no look-alike letters (the dotted capital I, the Kelvin sign, the long s). D2 output has no shape ids, so people can comment on a D2 diagram only as a whole or by region: prefer Mermaid when people should comment on individual shapes.
- Keep each spec under 64 KB, and at most 12 per document.

If a save fails with `render_failed` (or a refused spec), read the category and line, fix that spec and save again. Try **at most twice**; then save without that chart and tell the owner what failed. If the save succeeds with a note that the renderer is unavailable, the charts were saved as code: tell the owner and save again later. To show spec code as text instead of a picture, use a ```` ```text ```` fence.

This skill applies only when your instructions contain the line `Design kit: installed`.
