---
title: Marca y diseño
---

# Marca y diseño

La identidad visual de Crow es el sistema de diseño **Dark Editorial** — superficies oscuras con acentos índigo iridiscentes, inspirado en el plumaje tornasolado de los córvidos.

## Filosofía de diseño

Superficies oscuras. Acentos índigo. Calidez tecnológica. La estética evoca las plumas de un cuervo atrapando la luz — oscuras en reposo, iridiscentes en movimiento. El diseño es editorial (tipografía limpia, espacio en blanco generoso) pero no estéril (tonos piedra cálidos, textura sutil).

## Paleta de colores

### Tema oscuro (predeterminado)

| Token | Hex | Uso |
|-------|-----|-------|
| `--crow-bg-deep` | `#0f0f17` | Fondo de página |
| `--crow-bg-surface` | `#1a1a2e` | Fondos de tarjetas/paneles |
| `--crow-bg-elevated` | `#2d2d3d` | Fondos de inputs, superficies elevadas |
| `--crow-border` | `#3d3d4d` | Bordes y divisores |
| `--crow-text-primary` | `#fafaf9` | Texto principal |
| `--crow-text-secondary` | `#a8a29e` | Texto secundario |
| `--crow-text-muted` | `#78716c` | Metadatos, etiquetas, pistas |
| `--crow-accent` | `#6366f1` | Índigo primario — enlaces, botones, estados activos |
| `--crow-accent-hover` | `#818cf8` | Estado hover (índigo más claro) |
| `--crow-accent-muted` | `#2d2854` | Fondos de acento (etiquetas, insignias) |
| `--crow-brand-gold` | `#fbbf24` | Indicador de navegación activa |
| `--crow-success` | `#22c55e` | Estados de éxito, conectado |
| `--crow-error` | `#ef4444` | Estados de error, acciones destructivas |
| `--crow-info` | `#38bdf8` | Resaltados informativos |

### Tema claro

| Token | Hex |
|-------|-----|
| `--crow-bg-deep` | `#fafaf9` |
| `--crow-bg-surface` | `#ffffff` |
| `--crow-bg-elevated` | `#f5f5f4` |
| `--crow-border` | `#e7e5e4` |
| `--crow-text-primary` | `#1c1917` |
| `--crow-text-secondary` | `#57534e` |
| `--crow-text-muted` | `#a8a29e` |
| `--crow-accent` | `#4f46e5` |
| `--crow-accent-hover` | `#6366f1` |
| `--crow-accent-muted` | `#e0e7ff` |

### Tema serif (lectura del blog)

Sobrescribe la fuente del cuerpo a la serif `Fraunces` para una experiencia de lectura más literaria. Todos los demás tokens se heredan del tema base activo (oscuro o claro).

## Tipografía

| Rol | Fuente | Pesos | Uso |
|------|------|---------|-------|
| **Display** | Fraunces | 400, 600, 700 | Encabezados, texto de hero, cifras de estadísticas |
| **Cuerpo** | DM Sans | 400, 500, 700 | Texto de cuerpo, etiquetas, botones |
| **Código** | JetBrains Mono | 400, 500 | Bloques de código, Crow IDs, datos monoespaciados |

Todas las fuentes se cargan desde Google Fonts.

## Espaciado y radios

**Escala de espaciado** (basada en rem):
- `0.25rem` (4px) — separaciones estrechas
- `0.5rem` (8px) — espaciado compacto
- `0.75rem` (12px) — padding estándar
- `1rem` (16px) — espaciado de secciones
- `1.5rem` (24px) — padding de tarjetas
- `2rem` (32px) — separaciones grandes

**Niveles de border radius:**
- `4px` — pequeño (insignias, elementos en línea)
- `8px` — mediano (tarjetas, inputs, paneles)
- `12px` — grande (diálogos modales, secciones hero)

**Sombras:**
- Tarjetas: `0 1px 3px rgba(0,0,0,0.2), 0 0 0 1px rgba(99,102,241,0.05)`
- Elevadas: `0 4px 12px rgba(0,0,0,0.3)`

## Temas

Crow soporta tres temas visuales:

- **Oscuro** (predeterminado) — Dark Editorial con acentos índigo. Se usa en todas partes por defecto.
- **Claro** — Paleta invertida para entornos luminosos. Fondos cálidos tono piedra.
- **Serif** — Aplica la fuente serif Fraunces para la lectura del blog. Se combina con oscuro o claro.

El tema se alterna desde el encabezado del Crow's Nest o con el ajuste `blog_theme`.

## Recursos SVG

| Recurso | Ubicación | Uso |
|-------|----------|-------|
| `crow-hero.svg` | `docs/public/` | Ilustración hero del cuervo (gradientes: cuerpo `#2d2d3d`, brillos `#6366f1`) |
| `grackle-pattern.svg` | `docs/public/` | Textura decorativa de fondo |
| `icon-*.svg` | `docs/public/` | Iconos de funcionalidades (MCP, memoria, investigación, compartir, integraciones, despliegue, plataformas) |
| Logos de complementos | `servers/gateway/dashboard/shared/logos.js` | Logos SVG para Ollama, Nextcloud, MinIO, Immich, Obsidian, Home Assistant, Podcast |

## Para desarrolladores

Todos los tokens de color están definidos en una única fuente de verdad:

```
servers/gateway/dashboard/shared/design-tokens.js
```

Tanto el dashboard del Crow's Nest (`layout.js`) como el blog público (`blog-public.js`) importan desde este archivo. Cuando agregues colores nuevos o modifiques la paleta, edita `design-tokens.js` — el cambio se propaga a ambas superficies automáticamente.

Consulta la [guía de Personalización](/es/guide/customization) para ver cómo los usuarios pueden ajustar temas y apariencia.
