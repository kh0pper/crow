# Integraciones

Crow se conecta a más de 20 servicios externos a través de servidores MCP. Los cinco servidores integrados (Memoria, Proyectos, Compartición, Almacenamiento y Blog) funcionan de inmediato. Las integraciones externas necesitan claves de API agregadas a tu entorno.

## Servidores integrados

Estos siempre están disponibles — no se necesitan claves de API:

| Servidor | Herramientas | Descripción |
|---|---|---|
| **crow-memory** | 12 herramientas | Memoria persistente (7 herramientas) + gestión de contexto multiplataforma (5 herramientas) |
| **crow-projects** | 12 herramientas | Pipeline de proyectos: proyectos, fuentes, notas, citas, bibliografía, backends de datos |
| **crow-sharing** | 8 herramientas | Compartición P2P: códigos de invitación, contactos, compartición cifrada, mensajería Nostr, bandeja de entrada |
| **crow-storage** | 5 herramientas | Almacenamiento de archivos compatible con S3: subir, listar, descargar (URLs prefirmadas), eliminar, estadísticas |
| **crow-blog** | 12 herramientas | Plataforma de blogging: posts, publicación, temas, feeds RSS/Atom, exportación a Hugo/Jekyll |

## Mantén tus claves seguras

Cada clave de API solo otorga acceso a ese único servicio — una clave de GitHub filtrada no puede acceder a tu Gmail, por ejemplo. Aún así, debes tratar cada clave con cuidado:

- **Agrega solo claves de servicios que realmente uses** — menos claves significa menos que gestionar y menos riesgo
- **Nunca compartas claves** en capturas de pantalla, mensajes o repositorios públicos
- **Si una clave se filtra**, revócala de inmediato en el sitio web del servicio y crea una nueva

Para una guía de seguridad completa y amigable para principiantes, consulta [SECURITY.md](https://github.com/kh0pper/crow/blob/main/SECURITY.md).

## Integraciones externas

Agrega claves de API para habilitar estas integraciones. Para despliegues en la nube, agrega las claves en tu [panel de Render](https://dashboard.render.com) en la sección Environment.

| Integración | Variables de entorno | Descripción | Obtener clave de API |
|---|---|---|---|
| **GitHub** | `GITHUB_PERSONAL_ACCESS_TOKEN` | Repos, issues, PRs, búsqueda de código | [Ajustes de GitHub](https://github.com/settings/tokens) |
| **Brave Search** | `BRAVE_API_KEY` | Búsqueda web, búsqueda local | [API de Brave](https://brave.com/search/api/) |
| **Slack** | `SLACK_BOT_TOKEN` | Mensajes, canales, hilos | [Apps de Slack](https://api.slack.com/apps) |
| **Notion** | `NOTION_TOKEN` | Páginas, bases de datos, comentarios | [Integraciones de Notion](https://www.notion.so/my-integrations) |
| **Trello** | `TRELLO_API_KEY`, `TRELLO_TOKEN` | Tableros, tarjetas, listas | [Power-Ups de Trello](https://trello.com/power-ups/admin) |
| **Discord** | `DISCORD_BOT_TOKEN` | Servidores, canales, mensajes | [Portal de desarrolladores de Discord](https://discord.com/developers/applications) |
| **Google Workspace** | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Gmail, Calendar, Drive, Docs, Sheets, Slides, Chat | [Consola de Google Cloud](https://console.cloud.google.com/apis/credentials) |
| **Canvas LMS** | `CANVAS_API_TOKEN`, `CANVAS_BASE_URL` | Cursos, tareas, calificaciones | Ajustes de cuenta de Canvas |
| **Microsoft Teams** | `TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET`, `TEAMS_TENANT_ID` | Mensajes, canales, equipos | [Portal de Azure](https://portal.azure.com) |
| **Zotero** | `ZOTERO_API_KEY`, `ZOTERO_USER_ID` | Citas, gestión de biblioteca | [Ajustes de Zotero](https://www.zotero.org/settings/keys) |
| **arXiv** | *(ninguna)* | Búsqueda de artículos académicos, texto completo | Funciona de inmediato |
| **Obsidian** | `OBSIDIAN_VAULT_PATH` | Búsqueda en el vault, sincronización de notas | Ruta local al vault |
| **Home Assistant** | `HA_URL`, `HA_TOKEN` | Control de dispositivos del hogar inteligente | [Tokens de larga duración de HA](https://www.home-assistant.io/docs/authentication/) |
| **Render** | `RENDER_API_KEY` | Gestión de despliegues | [Claves de API de Render](https://dashboard.render.com/account/api-keys) |

## Guías de configuración

Instrucciones de configuración detalladas paso a paso para cada integración:

- [GitHub](./github) — Tokens de acceso personal, scopes requeridos
- [Brave Search](./brave-search) — Registro para la clave de API gratuita
- [Slack](./slack) — Token de bot, scopes de OAuth, instalación en el workspace
- [Notion](./notion) — Configuración de integración interna, compartición de páginas
- [Trello](./trello) — Clave de API y token del Power-Up
- [Discord](./discord) — Token de bot, intent de contenido de mensajes
- [Google Workspace](./google-workspace) — Credenciales OAuth, habilitación de APIs
- [Canvas LMS](./canvas-lms) — Token de acceso, URL de la institución
- [Microsoft Teams](./microsoft-teams) — Registro de app en Azure AD
- [Zotero](./zotero) — Clave de API e ID de usuario
- [Home Assistant](./home-assistant) — Token de acceso de larga duración
- [Obsidian](./obsidian) — Configuración de la ruta del vault
- [Render](./render) — Clave de API para gestión de despliegues

## Add-ons de autoalojamiento (Bundles)

Estos son add-ons instalables con configuraciones de Docker Compose. Instálalos con `crow bundle install <id>` o pídeselo a tu IA.

| Add-on | Tipo | Descripción |
|---|---|---|
| **Obsidian** | Servidor MCP | Búsqueda en el vault, sincronización de notas e integración con base de conocimiento |
| **Home Assistant** | Servidor MCP | Control de dispositivos del hogar inteligente con puntos de control de seguridad |
| **Ollama** | Bundle (Docker) | Modelos de IA locales para embeddings, resúmenes y clasificación |
| **Nextcloud** | Bundle (Docker) | Sincronización de archivos vía montaje WebDAV (v1: solo archivos) |
| **Immich** | Bundle (Docker + MCP personalizado) | Búsqueda en la biblioteca de fotos, gestión de álbumes |
| **Calibre Server** | Bundle (Docker) | Servidor de ebooks OPDS — buscar, explorar, descargar |
| **Calibre-Web** | Bundle (Docker) | Lector de ebooks basado en web con estantes y progreso de lectura |
| **Miniflux** | Bundle (Docker) | Lector RSS minimalista con gestión de feeds |
| **Audiobookshelf** | Bundle (Docker) | Servidor de audiolibros y podcasts con seguimiento de progreso |
| **Kavita** | Bundle (Docker) | Lector de manga, cómics y ebooks |
| **Navidrome** | Bundle (Docker) | Servidor de streaming de música (compatible con Subsonic) |
| **Paperless-ngx** | Bundle (Docker) | Gestión de documentos con OCR |
| **Wallabag** | Bundle (Docker) | Archivador de artículos para leer después |
| **Linkding** | Bundle (Docker) | Gestor de marcadores ligero |
| **Shiori** | Bundle (Docker) | Gestor de marcadores con caché de páginas sin conexión |
| **BookStack** | Bundle (Docker) | Plataforma wiki (estantes, libros, capítulos, páginas) |
| **Vikunja** | Bundle (Docker) | Gestión de tareas con tableros kanban |
| **Actual Budget** | Bundle (Docker) | Presupuesto personal con privacidad ante todo |

## Cómo funciona el proxy de integraciones

Cuando se despliega vía el gateway, las integraciones externas están disponibles a través del endpoint `/tools/mcp`. El gateway:

1. Lee qué claves de API están configuradas en el entorno
2. Lanza solo los servidores MCP configurados como procesos hijos
3. Agrega todas sus herramientas en un único endpoint `/tools/mcp`
4. Prefija los nombres de las herramientas para evitar conflictos

Esto significa que agregas una sola conexión MCP desde tu cliente de IA (la URL `/tools/mcp`) y obtienes acceso a todos los servicios externos configurados.

## Agregar una nueva integración

Consulta la página [Arquitectura > Gateway](/es/architecture/gateway) para ver los detalles de cómo funciona el sistema de proxy y cómo agregar nuevas integraciones.
