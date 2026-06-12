---
title: Servidor de Blog
---

# Servidor de Blog

El servidor de blog (`servers/blog/`) ofrece una plataforma de publicación a través de herramientas MCP y rutas HTTP públicas. Las entradas se escriben en Markdown, se renderizan a HTML y se sirven con feeds RSS/Atom.

> Recorrido para el usuario (escribir, publicar, hacerlo público): [guía del Blog](/es/guide/blog). Esta página cubre los internos.

## Arquitectura

```
┌──────────────────────────────────────┐
│       Capa de herramientas MCP       │
│  crow_create_post   crow_list_posts  │
│  crow_edit_post     crow_get_post    │
│  crow_publish_post  crow_unpublish   │
│  crow_delete_post   crow_share_post  │
│  crow_export_blog   crow_blog_stats  │
│  crow_blog_settings                  │
│  crow_blog_customize_theme           │
├──────────────────────────────────────┤
│         Rutas HTTP públicas          │
│  GET /blog        (lista de entradas)│
│  GET /blog/:slug      (una entrada)  │
│  GET /blog/feed.xml     (RSS 2.0)    │
│  GET /blog/feed.atom    (Atom)       │
├──────────────────────────────────────┤
│  renderer.js         │  rss.js       │
│  Markdown → HTML     │  Gen. de feeds│
├──────────────────────────────────────┤
│         SQLite (blog_posts)          │
│    Índice FTS5 (blog_posts_fts)      │
└──────────────────────────────────────┘
```

## Patrón de fábrica

```js
// servers/blog/server.js
export function createBlogServer(dbPath) {
  const server = new McpServer({ name: "crow-blog", version: "1.0.0" });
  // ... registros de herramientas
  return server;
}
```

- `server.js` — Función de fábrica y definiciones de herramientas
- `index.js` — Enlace al transporte stdio
- `renderer.js` — Renderizado de Markdown y sanitización de HTML
- `rss.js` — Generación de feeds RSS 2.0 y Atom

## renderer.js

Convierte el contenido Markdown de una entrada en HTML seguro:

```js
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

export function renderPost(markdown) {
  const rawHtml = marked.parse(markdown);
  return sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'h3']),
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, img: ['src', 'alt'] }
  });
}
```

El sanitizador elimina scripts, iframes y manejadores de eventos, mientras preserva el formato estándar, las imágenes y los bloques de código.

## rss.js

Genera feeds RSS 2.0 y Atom a partir de las entradas publicadas:

```js
export function generateRssFeed(posts, blogConfig) { }
export function generateAtomFeed(posts, blogConfig) { }
```

Los feeds incluyen las 20 entradas publicadas más recientes con su contenido HTML completo ya renderizado. Los metadatos del blog (título, descripción, autor) provienen de variables de entorno.

## Base de datos

### Tabla blog_posts

```sql
CREATE TABLE blog_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,            -- Markdown sin procesar
  excerpt TEXT,                     -- Extracto corto (autogenerado o manual)
  author TEXT,                      -- Nombre del autor
  status TEXT DEFAULT 'draft',      -- 'draft', 'published' o 'archived'
  visibility TEXT DEFAULT 'private', -- 'private', 'public' o 'peers'
  cover_image_key TEXT,             -- Clave S3 de la imagen de portada
  tags TEXT,                        -- Etiquetas separadas por comas
  nostr_event_id TEXT,              -- Para compartición P2P
  published_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### Índice FTS5

```sql
CREATE VIRTUAL TABLE blog_posts_fts USING fts5(
  title, content, excerpt, tags,
  content=blog_posts,
  content_rowid=id
);
```

Unos triggers mantienen el índice FTS sincronizado en cada inserción, actualización y eliminación — el mismo patrón que usan los servidores de memoria y de proyectos.

## Generación de slugs

Los slugs se generan a partir de los títulos:

1. Convertir a minúsculas
2. Reemplazar espacios y caracteres especiales por guiones
3. Eliminar guiones consecutivos
4. Recortar a 80 caracteres
5. Si el slug ya existe, añadir un sufijo numérico (`-2`, `-3`, etc.)

## Rutas públicas

Estas rutas las sirve el gateway sin autenticación:

### GET /blog

Renderiza una página HTML que lista todas las entradas publicadas, las más nuevas primero. Usa la plantilla del tema Dark Editorial.

### GET /blog/:slug

Renderiza una sola entrada como página HTML completa con:

- Título de la entrada y fecha de publicación
- Contenido Markdown renderizado
- Metaetiquetas Open Graph para compartir en redes sociales
- Datos estructurados (JSON-LD) para los motores de búsqueda
- Enlaces de navegación a la entrada anterior y la siguiente

### GET /blog/tag/:tag

Entradas filtradas por una etiqueta concreta.

### GET /blog/feed.xml

Feed RSS 2.0 de las entradas públicas publicadas.

### GET /blog/feed.atom

Feed Atom de las entradas públicas publicadas.

## Tema Dark Editorial

El diseño visual del blog usa plantillas HTML del lado del servidor (sin framework de JavaScript en el cliente). Características clave:

- Tipografía serif para el cuerpo del texto, sans-serif para los encabezados
- Espacios en blanco generosos y longitudes de línea legibles
- Modo oscuro por defecto, modo claro vía CSS `prefers-color-scheme`
- Resaltado de sintaxis para los bloques de código
- Diseño responsivo para móvil y escritorio

Las plantillas van embebidas en el código del servidor — sin archivos de plantilla externos ni paso de build.

## Metaetiquetas Open Graph

Cada entrada publicada incluye etiquetas Open Graph:

```html
<meta property="og:title" content="Post Title" />
<meta property="og:description" content="First 200 characters..." />
<meta property="og:type" content="article" />
<meta property="og:url" content="https://your-server/blog/post-slug" />
```

Esto garantiza vistas previas correctas cuando las entradas se comparten en redes sociales o apps de mensajería.

## Exportación

La herramienta de exportación genera archivos Markdown con frontmatter específico de cada plataforma:

**Formato Hugo:**
```yaml
---
title: "Post Title"
date: 2026-03-01T12:00:00Z
tags: ["tag1", "tag2"]
draft: false
---
```

**Formato Jekyll:**
```yaml
---
layout: post
title: "Post Title"
date: 2026-03-01
categories: [tag1, tag2]
---
```
