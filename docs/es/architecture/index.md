# Arquitectura

Crow es una plataforma MCP (Model Context Protocol) — no una aplicación web tradicional. No hay frontend. La "UI" es tu asistente de IA, guiado por archivos de skills y respaldado por almacenamiento persistente.

## Diagrama del sistema

```
┌───────────────────────────────────────────────────────────────────────┐
│       AI Client (Claude, ChatGPT, Gemini, Grok, Cursor, etc.)       │
└────────┬──────────────────────┬──────────────────────┬───────────────┘
         │                      │                      │
   /memory/mcp            /projects/mcp          /tools/mcp
   /memory/sse            /projects/sse          /tools/sse
   /sharing/mcp           /storage/mcp           /blog-mcp/mcp
   /sharing/sse           /storage/sse           /blog-mcp/sse
                          /relay/*
         │                      │                      │
┌────────┴──────────────────────┴──────────────────────┴───────────────┐
│  Crow Gateway (Express + OAuth 2.1)                                  │
│  ├── Streamable HTTP transport (2025-03-26)                          │
│  ├── SSE transport (2024-11-05, legacy)                              │
│  ├── crow-memory server (persistent memory + FTS5 search)            │
│  ├── crow-projects server (project management + APA citations)       │
│  ├── crow-sharing server (P2P sharing, Hyperswarm, Nostr messaging)  │
│  │    └── peer relay endpoints (/relay/store, /relay/fetch)          │
│  ├── crow-storage server (S3-compatible file storage via MinIO)      │
│  ├── crow-blog server (blogging platform, Markdown, RSS/Atom)        │
│  └── proxy server → spawns external MCP servers on demand            │
│       ├── GitHub, Brave Search, Slack, Notion, Trello                │
│       ├── Discord, Canvas LMS, Microsoft Teams                       │
│       └── Google Workspace, Zotero, arXiv, Render                    │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                        ┌──────┴───────┐
                        │    SQLite    │
                        │ (local file) │
                        │              │
                        └──────────────┘
```

## Tres capas

### 1. Servidores MCP personalizados (`servers/`)

Cinco servidores Node.js que exponen herramientas sobre MCP. Todos comparten una única base de datos SQLite.

- **[Servidor de Memoria](./memory-server)** — Memoria persistente con búsqueda de texto completo (FTS5), categorías, puntuación de importancia y etiquetas
- **[Servidor de Proyectos](./project-server)** — Gestión de proyectos con proyectos tipados (investigación, conectores de datos), fuentes (cita APA automática), notas, backends de datos y generación de bibliografía
- **[Servidor de Compartición](./sharing-server)** — Protocolo de compartición P2P con descubrimiento vía Hyperswarm, sincronización de datos con Hypercore, mensajería Nostr y soporte de peer relays
- **[Servidor de Almacenamiento](./storage-server)** — Almacenamiento de archivos compatible con S3 mediante MinIO, subidas, URLs prefirmadas, gestión de cuotas
- **[Servidor de Blog](./blog-server)** — Plataforma de blogging con renderizado de Markdown, feeds RSS/Atom, temas y exportación

### 2. Gateway HTTP (`servers/gateway/`)

Servidor Express que envuelve los cinco servidores MCP con transportes HTTP + OAuth 2.1. Soporta:

- **Streamable HTTP** — Transporte moderno para Claude, Gemini, Grok, Cursor, etc.
- **SSE** — Transporte legado para compatibilidad con ChatGPT
- **OAuth 2.1** — Registro Dinámico de Clientes para acceso seguro
- **Proxy** — Lanza y agrega servidores MCP externos
- **Crow's Nest** — UI HTML renderizada en el servidor en `/dashboard` con autenticación por contraseña, cookies de sesión y registro de paneles

Consulta [Gateway](./gateway) para más detalles.

### 3. Skills (`skills/`)

30 archivos markdown que funcionan como prompts de comportamiento. No son código — definen flujos de trabajo, patrones de activación y lógica de integración. Claude los carga bajo demanda.

Consulta [Skills](/skills/) para la lista completa.

## Patrón de fábrica de servidores

Cada servidor personalizado tiene una **función de fábrica** en `server.js` que devuelve una instancia configurada de `McpServer`. Los archivos `index.js` las conectan al transporte stdio. El gateway importa las mismas fábricas y las conecta al transporte HTTP.

```
servers/memory/server.js   → createMemoryServer()   → McpServer
servers/memory/index.js    → stdio transport
servers/research/server.js → createProjectServer()   → McpServer
servers/research/index.js  → stdio transport
servers/sharing/server.js  → createSharingServer()   → McpServer
servers/sharing/index.js   → stdio transport
servers/storage/server.js  → createStorageServer()   → McpServer
servers/storage/index.js   → stdio transport
servers/blog/server.js     → createBlogServer()      → McpServer
servers/blog/index.js      → stdio transport
servers/gateway/index.js   → Express + HTTP/SSE transports (all five servers)
```

## Base de datos

Usa `@libsql/client` con un archivo SQLite local en `~/.crow/data/crow.db`. La sincronización multi-dispositivo se maneja con replicación P2P de Hypercore.

Tablas clave:
- `memories` — Con búsqueda de texto completo vía tabla virtual FTS5 con triggers de sincronización
- `project_spaces` → `research_sources` → `research_notes` — proyectos y sus datos hijos (claves foráneas). `project_members` contiene los roles/capacidades por miembro; `project_audit_log` registra las mutaciones. La tabla legada `research_projects` es un espejo inactivo que los triggers mantienen sincronizado, a la espera de su retiro
- `crow_context` — Secciones de contexto de comportamiento (usadas para generar crow.md), soporta overrides por dispositivo vía la columna `device_id`
- `oauth_clients` / `oauth_tokens` — Persistencia de la autenticación del gateway
- `contacts` — Identidades de peers, claves públicas, estado de relay, última conexión vista
- `shared_items` — Seguimiento de comparticiones enviadas/recibidas con permisos
- `messages` — Caché local de mensajes Nostr con estado de lectura
- `relay_config` — Relays Nostr y peer relays configurados
- `storage_files` — Metadatos de objetos S3 (clave, nombre, MIME, tamaño, bucket)
- `blog_posts` — Contenido del blog con slug, estado, visibilidad, etiquetas, imagen de portada
- `blog_posts_fts` — Índice FTS5 sobre las entradas del blog con triggers de sincronización
- `dashboard_settings` — Almacén clave-valor para la configuración de Crow's Nest

## Sincronización multi-instancia

Las instancias de Crow se pueden encadenar para replicación de datos P2P vía feeds de Hypercore. Cada instancia mantiene su propia base de datos SQLite; los cambios se propagan mediante entradas firmadas con marcas de tiempo de Lamport. La federación permite hacer proxy de llamadas a herramientas entre instancias a través del `StreamableHTTPClientTransport` del gateway. Consulta la [Arquitectura Multi-Instancia](./instances) para el diseño completo.

## Contexto de comportamiento (crow.md)

Las instrucciones de comportamiento de Crow — identidad, protocolos de memoria, protocolos de investigación, gestión de sesiones y principios clave — se almacenan en la tabla `crow_context` de la base de datos y se sirven dinámicamente como **crow.md**. Esto hace que el mismo contexto de comportamiento esté disponible en todas las plataformas (Claude, ChatGPT, Gemini, Grok, Cursor, etc.).

### Qué es

Un documento markdown generado dinámicamente, ensamblado a partir de las filas de la tabla `crow_context`. Cada fila es una sección con nombre (p. ej., `identity`, `memory-protocols`, `research-protocols`) con contenido y orden. El documento se reconstruye en cada solicitud, así que los cambios surten efecto de inmediato. Las secciones soportan overrides por dispositivo vía la columna `device_id` — las secciones específicas de un dispositivo anulan a las globales con la misma clave, lo que permite preferencias de comportamiento distintas por dispositivo.

### Cómo se sirve

| Método | Endpoint / Herramienta | Autenticación |
|---|---|---|
| Herramienta MCP | `crow_get_context` (con parámetros opcionales `platform` e `include_dynamic`) | Vía sesión MCP |
| Recurso MCP | `crow://context` | Vía sesión MCP |
| Endpoint HTTP | `GET /crow.md` (soporta `?platform=` y `?dynamic=false`) | OAuth (cuando está habilitado) |

### Herramientas de gestión

| Herramienta | Propósito |
|---|---|
| `crow_list_context_sections` | Lista todas las secciones con claves, títulos y estado de protección |
| `crow_update_context_section` | Actualiza el contenido o el título de una sección existente |
| `crow_add_context_section` | Agrega una nueva sección personalizada |
| `crow_delete_context_section` | Elimina una sección personalizada (las secciones protegidas no se pueden eliminar) |

### Secciones protegidas vs personalizadas

Algunas secciones (como `identity` y `memory-protocols`) están marcadas como **protegidas** — se pueden actualizar pero no eliminar. Las secciones personalizadas agregadas por el usuario se pueden modificar o eliminar libremente.

### Consistencia entre plataformas

Como crow.md se genera desde la base de datos, cualquier plataforma que lo cargue recibe las mismas instrucciones de comportamiento. Los suplementos específicos de plataforma (como CLAUDE.md para Claude Code) se suman a esta base compartida pero no la reemplazan.

Para el flujo de trabajo completo, consulta la [Guía Multiplataforma](/es/guide/cross-platform).

## Gestión de contexto

Crow incluye un sistema inteligente de carga de herramientas para reducir el uso de la ventana de contexto. El router del gateway (`/router/mcp`) consolida más de 126 herramientas en 10 herramientas de categoría (una reducción de contexto de ~90%). Para despliegues stdio, `crow-core` proporciona activación de servidores bajo demanda. Consulta la [referencia de arquitectura de Gestión de Contexto](/es/architecture/context-management) para más detalles.
