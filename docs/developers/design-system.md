# Design System

The dashboard's design system: CSS custom-property **tokens** + shared HTML **primitives**. Live reference: the **Design System** panel at `/dashboard/design-system`.

## Where things live

- Tokens: `servers/gateway/dashboard/shared/design-tokens.js` (`designTokensCss()`).
- Primitive HTML: `servers/gateway/dashboard/shared/components.js`.
- Primitive CSS + client JS: `servers/gateway/dashboard/shared/components-css.js` (injected once by `layout.js`).
- Gallery panel: `servers/gateway/dashboard/panels/design-system.js`.

## Tokens

**Color** (per theme — dark/light/glass): `--crow-bg-deep|bg-surface|bg-elevated|border`, `--crow-text-primary|secondary|tertiary|muted`, `--crow-accent|accent-hover|accent-muted`, `--crow-brand-gold`, `--crow-success|error|warning|info`.

**Spacing** (4px base): `--crow-space-1`(4px) `-2`(8) `-3`(12) `-4`(16) `-5`(24) `-6`(32) `-8`(48) `-10`(64).

**Type**: `--crow-text-xs`(.75rem) `-sm`(.8125) `-base`(.875) `-md`(1) `-lg`(1.125) `-xl`(1.25) `-2xl`(1.5) `-3xl`(2).

**Line-height**: `--crow-leading-tight`(1.2) `-normal`(1.5) `-relaxed`(1.7).

**Radius**: `--crow-radius-card`, `--crow-radius-pill`.

**Compatibility aliases** (legacy names; prefer the canonical token on the right in new code): `--crow-bg`→`bg-deep`, `--crow-background`→`bg-deep`, `--crow-surface`→`bg-surface`, `--crow-bg-card`→`bg-surface`, `--crow-text`→`text-primary`, `--crow-border-subtle`→`border`, `--crow-accent-bg`→`accent-muted`.

## Primitives

| Function | Use |
|---|---|
| `button(label, {variant,size,href,type,name,value,attrs})` | Buttons/links. variant: primary\|secondary\|danger\|ghost; size: sm\|md. `href` → `<a>`. |
| `codeBlock(text, {lang})` | Monospace block with a copy-to-clipboard button. Text is escaped. |
| `callout(content, type)` | info\|success\|warning\|error notice. `content` is caller-supplied HTML (escape user data). |
| `stepper(steps, current)` | Display-only numbered progress. `steps`=`[{label}]`, `current` 0-based. |
| `tabs(items, {active})` | `items`=`[{id,label,content}]`. Client-side switching. |
| `statCard`/`statGrid`/`dataTable`/`formField`/`badge`/`actionBar`/`section` | Pre-existing helpers. |

Example:
```js
import { button, callout, codeBlock } from "../shared/components.js";
callout(`Run ${button("Connect", { href: "/dashboard/connect" })}`, "info");
codeBlock(JSON.stringify(cfg, null, 2), { lang: "json" });
```

## Convention

New dashboard UI **uses tokens** (`var(--crow-space-*)`, `var(--crow-text-*)`, color tokens) and the shared **primitives** — not hardcoded px or bespoke buttons. A test (`tests/design-system.test.js`) fails if any `var(--crow-*)` token is used but undefined. Full migration of every legacy panel's inline styles is out of scope (done opportunistically when touching a panel).
