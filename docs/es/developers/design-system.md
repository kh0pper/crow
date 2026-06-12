# Sistema de diseño

El sistema de diseño del dashboard: **tokens** de propiedades personalizadas CSS + **primitivas** HTML compartidas. Referencia en vivo: el panel **Design System** en `/dashboard/design-system`.

## Dónde vive cada cosa

- Tokens: `servers/gateway/dashboard/shared/design-tokens.js` (`designTokensCss()`).
- HTML de las primitivas: `servers/gateway/dashboard/shared/components.js`.
- CSS de las primitivas + JS de cliente: `servers/gateway/dashboard/shared/components-css.js` (inyectado una sola vez por `layout.js`).
- Panel de galería: `servers/gateway/dashboard/panels/design-system.js`.

## Tokens

**Color** (por tema — oscuro/claro/glass): `--crow-bg-deep|bg-surface|bg-elevated|border`, `--crow-text-primary|secondary|tertiary|muted`, `--crow-accent|accent-hover|accent-muted`, `--crow-brand-gold`, `--crow-success|error|warning|info`.

**Espaciado** (base de 4px): `--crow-space-1`(4px) `-2`(8) `-3`(12) `-4`(16) `-5`(24) `-6`(32) `-8`(48) `-10`(64).

**Tipografía**: `--crow-text-xs`(.75rem) `-sm`(.8125) `-base`(.875) `-md`(1) `-lg`(1.125) `-xl`(1.25) `-2xl`(1.5) `-3xl`(2).

**Interlineado**: `--crow-leading-tight`(1.2) `-normal`(1.5) `-relaxed`(1.7).

**Radio**: `--crow-radius-card`, `--crow-radius-pill`.

**Alias de compatibilidad** (nombres legados; en código nuevo prefiere el token canónico de la derecha): `--crow-bg`→`bg-deep`, `--crow-background`→`bg-deep`, `--crow-surface`→`bg-surface`, `--crow-bg-card`→`bg-surface`, `--crow-text`→`text-primary`, `--crow-border-subtle`→`border`, `--crow-accent-bg`→`accent-muted`.

## Primitivas

| Función | Uso |
|---|---|
| `button(label, {variant,size,href,type,name,value,attrs})` | Botones/enlaces. variant: primary\|secondary\|danger\|ghost; size: sm\|md. `href` → `<a>`. |
| `codeBlock(text, {lang})` | Bloque monoespaciado con botón de copiar al portapapeles. El texto se escapa. |
| `callout(content, type)` | Aviso de tipo info\|success\|warning\|error. `content` es HTML provisto por quien la llama (escapa los datos del usuario). |
| `stepper(steps, current)` | Progreso numerado de solo visualización. `steps`=`[{label}]`, `current` con índice base 0. |
| `tabs(items, {active})` | `items`=`[{id,label,content}]`. Cambio de pestaña del lado del cliente. |
| `statCard`/`statGrid`/`dataTable`/`formField`/`badge`/`actionBar`/`section` | Helpers preexistentes. |

Ejemplo:
```js
import { button, callout, codeBlock } from "../shared/components.js";
callout(`Run ${button("Connect", { href: "/dashboard/connect" })}`, "info");
codeBlock(JSON.stringify(cfg, null, 2), { lang: "json" });
```

## Convención

La UI nueva del dashboard **usa los tokens** (`var(--crow-space-*)`, `var(--crow-text-*)`, tokens de color) y las **primitivas** compartidas — no px codificados a mano ni botones hechos a medida. Una prueba (`tests/design-system.test.js`) falla si se usa cualquier token `var(--crow-*)` que no esté definido. La migración completa de los estilos inline de cada panel legado está fuera de alcance (se hace de forma oportunista al tocar un panel).
