# Compatibilidad de plataformas

Crow usa el estándar abierto [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Cualquier cliente de IA compatible con MCP puede conectarse al gateway de Crow — no se usan extensiones específicas de ningún proveedor.

## Matriz de compatibilidad

| Plataforma | Transporte | Autenticación | Dificultad de configuración | Estado |
|---|---|---|---|---|
| [Claude Web y Móvil](./claude) | Streamable HTTP | OAuth 2.1 | Fácil | Totalmente probado |
| [Claude Desktop](./claude-desktop) | stdio | N/A (local) | Fácil | Totalmente probado |
| [Claude Code (CLI)](./claude-code) | stdio / HTTP | OAuth 2.1 | Fácil | Totalmente probado |
| [ChatGPT](./chatgpt) | SSE | OAuth 2.1 | Fácil | Compatible |
| [Gemini](./gemini) | stdio / HTTP | OAuth 2.1 | Fácil | Compatible |
| [Grok (xAI)](./grok) | Streamable HTTP | Bearer token | Media | Compatible |
| [Cursor](./cursor) | stdio / HTTP | Varía | Fácil | Compatible |
| [Windsurf](./windsurf) | stdio / HTTP | Varía | Fácil | Compatible |
| [Cline](./cline) | stdio / HTTP | Varía | Fácil | Compatible |
| [Qwen Code](./qwen-coder) | stdio / HTTP | OAuth 2.1 | Fácil | Compatible |

## Apps móviles

La tabla anterior cubre los clientes MCP (asistentes de IA que se conectan a las herramientas de Crow). Crow también tiene acceso móvil dedicado al propio panel del Crow's Nest:

| Plataforma | Método de instalación | Estado |
|---|---|---|
| [Aplicación Android](./android) | APK nativo, o PWA vía Chrome | Totalmente probado |
| [iPhone (PWA)](./ios) | App web instalable vía Safari (sin App Store) | Totalmente probado |

## Endpoints MCP

Cada ruta es relativa a la URL de tu gateway (por ejemplo, `http://crow:3001`). Cada servidor está disponible vía Streamable HTTP en `<prefix>/mcp` y vía SSE legado en `<prefix>/sse` + `<prefix>/messages`:

| Prefijo | Servidor | Notas |
|---|---|---|
| `/router` | **Router de categorías (recomendado)** | 10 herramientas consolidadas en lugar de la superficie completa de más de 126 herramientas crudas — consulta [Contexto y rendimiento](/es/guide/context-performance) |
| `/memory` | Memory | La ruta `/mcp` a secas es un alias de compatibilidad para este servidor |
| `/projects` | Projects | `/research` es un alias legado — el mismo servidor, con su nombre anterior |
| `/sharing` | Sharing | |
| `/storage` | Storage | Disponible solo cuando MinIO está configurado |
| `/blog-mcp` | Blog | |
| `/tools` | Proxy de herramientas externas | Integraciones (GitHub, Trello, …) agregadas en un solo endpoint |

::: info Alias de nombres
El servidor de **projects** se llamaba antes **research**. Las configuraciones antiguas que usan `/research/mcp` o la herramienta de router `crow_research` siguen funcionando — son alias de `/projects/mcp` y `crow_projects`.
:::

## Tipos de transporte

El gateway de Crow admite dos protocolos de transporte MCP:

### Streamable HTTP (recomendado)

- Versión del protocolo: `2025-03-26`
- Endpoints: `<prefix>/mcp` de la tabla anterior
- Usado por: Claude, Gemini, Grok, Cursor, Windsurf, Cline, Claude Code

### SSE (legado)

- Versión del protocolo: `2024-11-05`
- Endpoints: `<prefix>/sse` + `<prefix>/messages` de la tabla anterior
- Usado por: ChatGPT

### stdio (solo local)

- Comunicación directa entre procesos, sin red
- Usado por: Claude Desktop, Claude Code (local), Gemini CLI (local), Qwen Coder CLI (local), Cursor (local), Windsurf (local), Cline (local)

## Autenticación

El gateway usa **OAuth 2.1 con Dynamic Client Registration**. Cuando conectas un cliente nuevo, este automáticamente:

1. Descubre los metadatos de OAuth en `/.well-known/oauth-authorization-server`
2. Se registra como cliente vía `/register`
3. Te redirige para autorizar en `/authorize`
4. Recibe un token de acceso vía `/token`

Este es el mismo flujo estándar que usan la mayoría de los proveedores de OAuth. No se necesita gestión manual de tokens para las plataformas que admiten descubrimiento de OAuth.

Para las plataformas que no admiten descubrimiento de OAuth (como Grok), puedes usar el endpoint `/introspect` o configurar bearer tokens manualmente.

## Contexto multiplataforma (crow.md)

Crow va más allá de los datos compartidos — también comparte **contexto de comportamiento** entre plataformas. El documento `crow.md` define cómo se comporta Crow: identidad, protocolos de memoria, reglas de transparencia y tus personalizaciones.

**Entrega automática:** Cuando cualquier IA se conecta a Crow, recibe una versión condensada de tu contexto de comportamiento durante el handshake de MCP — antes de que ocurra cualquier llamada a herramientas. La IA sabe de inmediato cómo usar la memoria, seguir los protocolos de sesión y respetar las reglas de transparencia. No se requiere acción del usuario.

**Orientación bajo demanda:** Para instrucciones de flujo de trabajo detalladas, la IA puede solicitar prompts de MCP como `session-start`, `crow-guide`, `research-guide`, `blog-guide` o `sharing-guide`. Estos proporcionan orientación completa sin consumir espacio en la ventana de contexto de antemano.

**Acceso manual:** Usa la herramienta `crow_get_context` (cualquier plataforma MCP) o `GET /crow.md` (endpoint HTTP) para obtener el documento completo.

Consulta la [Guía multiplataforma](/es/guide/cross-platform) para un recorrido completo.
