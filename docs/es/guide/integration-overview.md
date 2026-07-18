# Cómo trabaja la IA con Crow

Crow es una plataforma impulsada por IA, pero no está atada a ningún proveedor de IA en particular. Varios sistemas de IA pueden conectarse a la misma instancia de Crow simultáneamente, compartiendo una sola base de datos de memorias, proyectos, entradas de blog, archivos y contactos. Esta página explica los tres patrones de conexión y cómo encajan entre sí.

## Tres formas de conectarse

### 1. MCP externo (conexión directa)

Las plataformas de IA que soportan el Model Context Protocol se conectan directamente a los servidores MCP de Crow. Este es el patrón principal para Claude.ai, ChatGPT, Gemini, Cursor, Windsurf y otras herramientas de IA de escritorio/web.

```
AI Platform ──► MCP Transport ──► Crow MCP Servers ──► SQLite Database
  (Claude,        (stdio or           (memory,
   ChatGPT,        Streamable HTTP)    projects,
   Cursor)                             sharing,
                                       storage,
                                       blog)
```

**Cómo funciona:** La plataforma de IA lanza los servidores MCP de Crow como procesos hijos (stdio) o se conecta al gateway por HTTP. La IA integrada de la plataforma llama directamente a las herramientas de Crow — guardar memorias, buscar en proyectos, publicar entradas de blog, etc.

**Ideal para:** Sesiones de trabajo profundo, funciones específicas de cada plataforma (los artifacts de Claude, la edición de código de Cursor), usar la IA por la que ya pagas.

**Configuración:** Agrega entradas de servidores MCP al archivo de configuración de la plataforma. Consulta [Plataformas](/es/platforms/) para las guías por plataforma.

### 2. Chat BYOAI (Crow's Nest)

El AI Chat integrado de Crow te permite usar cualquier proveedor de IA a través del dashboard web Crow's Nest. Crow maneja internamente la conexión con el proveedor de IA y el despacho de herramientas.

```
User ──► Crow's Nest ──► /api/chat ──► AI Provider API ──► Tool Executor ──► MCP Servers ──► Database
           (browser)      (gateway)    (OpenAI, Anthropic,   (in-process
                                        Google, Ollama,       MCP Client)
                                        OpenRouter)
```

**Cómo funciona:** Configuras un proveedor de IA (clave de API + modelo) en Configuración. Cuando envías un mensaje, el gateway lo reenvía al proveedor. Cuando la IA responde con llamadas a herramientas, el ejecutor de herramientas del gateway las despacha a los servidores MCP de Crow dentro del mismo proceso y le devuelve los resultados a la IA. La respuesta se transmite a tu navegador vía Server-Sent Events.

**Ideal para:** Interacciones rápidas desde el dashboard, usar proveedores de IA gratuitos o baratos (Ollama para algo totalmente local, OpenRouter para modelos económicos), acceder a Crow desde dispositivos sin un cliente de IA nativo.

**Configuración:** Consulta la [guía de Proveedores de IA (BYOAI)](/es/guide/ai-providers).

### 3. Bots nativos (Bot Builder)

Agentes de IA que viven en Gmail, Discord y los lentes Meta — construidos y gestionados directamente desde el dashboard de Crow. El [Bot Builder](/es/guide/bot-builder) crea agentes con herramientas delimitadas, permisos aplicados y autoescritura opt-in.

```
Channel ──► Bot Builder Gateway ──► Crow MCP Servers ──► SQLite Database
  (Gmail,     (agent runtime,            ▲
   Discord,    skill dispatch)           │
   Glasses)                         Bot Board Panel
                                    (dashboard UI)
```

**Cómo funciona:** Creas un agente desde el dashboard, le asignas skills y herramientas, y lo despliegas. El agente se conecta vía MCP, hereda tus perfiles de proveedor de IA y aparece en el panel de Mensajes junto a tus peers y el chat de IA — una sola bandeja de entrada para todo.

Los agentes no son solo interfaces de chat — como se conectan vía MCP, tienen acceso a la misma suite de herramientas que Claude o ChatGPT: memoria, proyectos, blog, compartición, almacenamiento y extensiones. Un agente del hogar puede llevar el control de gastos y gestionar una despensa. Un agente de investigación puede monitorear feeds RSS y guardar hallazgos en proyectos.

**Ideal para:** Acceder a Crow desde apps de chat móviles, presencia multiplataforma, flujos de trabajo automatizados, uso colaborativo a través de canales compartidos.

**Configuración:** Consulta la [guía del Bot Builder](/es/guide/bot-builder).

## Lo que todos comparten

Los tres patrones de conexión acceden a la **misma base de datos, las mismas herramientas y los mismos datos**. Una memoria guardada desde Claude.ai es buscable al instante desde el AI Chat del Crow's Nest y desde un bot en Discord. Una entrada de blog redactada en Cursor puede publicarse desde ChatGPT.

| Recurso | Compartido entre todas las conexiones |
|---|---|
| Memorias | Búsqueda de texto completo, etiquetadas, puntuadas por importancia |
| Proyectos y fuentes | Investigación, conectores de datos, notas, citas |
| Entradas de blog | Borradores, publicaciones, temas, feeds RSS |
| Archivos | Almacenamiento compatible con S3 (cuando MinIO está configurado) |
| Contactos y mensajes | Identidades de peers, DMs de Nostr, elementos compartidos |
| Contexto de comportamiento | Identidad crow.md, protocolos y secciones personalizadas |

Esta es la propuesta de valor central: **usa la interfaz de IA que mejor se ajuste al momento, y tus datos te siguen**.

## Enrutamiento de herramientas

Crow expone 126+ herramientas MCP individuales repartidas entre sus servidores centrales. Cargarlas todas en la ventana de contexto de una IA es un desperdicio — la mayoría de las interacciones solo necesitan unas pocas.

### El patrón de router

El endpoint `/router/mcp` del gateway consolida todas las herramientas en **10 herramientas de categoría** (8 categorías de servidor más `crow_tools` y `crow_discover`), reduciendo el uso de contexto en aproximadamente un 90%:

| Herramienta de categoría | Enruta a | Acciones |
|---|---|---|
| `crow_memory` | Servidor de memoria | guardar, buscar, recordar, listar, actualizar, eliminar, estadísticas, contexto |
| `crow_projects` | Servidor de proyectos | crear, listar, actualizar, agregar fuentes/notas, buscar, bibliografía |
| `crow_blog` | Servidor de blog | crear, editar, publicar, despublicar, temas, exportar, compartir |
| `crow_sharing` | Servidor de compartición | invitar, aceptar, compartir, bandeja de entrada, enviar mensaje, contactos, revocar |
| `crow_storage` | Servidor de almacenamiento | subir, listar, obtener URL, eliminar, estadísticas |
| `crow_media` | Complemento de medios (cuando está instalado) | artículos, pódcasts, listas de reproducción |
| `crow_tools` | Integraciones externas | GitHub, Brave Search, Slack y otros servicios conectados |
| `crow_discover` | Consulta de esquemas | Devuelve los esquemas de parámetros completos bajo demanda |

Cada herramienta de categoría acepta un parámetro `action` (p. ej., `crow_memory` con `action: "store_memory"`) y un objeto `params`. La herramienta `crow_discover` le permite a la IA inspeccionar las acciones disponibles y sus esquemas completos sin cargar todo por adelantado.

### Dónde aplica el enrutamiento

- **Gateway HTTP** (`/router/mcp`): Lo usan los clientes MCP remotos y el ejecutor de herramientas BYOAI
- **crow-core** (`servers/core/`): Equivalente stdio para despliegues locales — arranca con las herramientas de memoria y activa los demás servidores bajo demanda
- **Endpoints directos** (`/memory/mcp`, `/projects/mcp`, etc.): Siguen disponibles para los clientes que prefieren las definiciones de herramientas completas

## Mensajería y compartición

Crow incluye una capa peer-to-peer para la comunicación y la compartición de datos entre usuarios, independiente de cualquier proveedor de IA.

### Nostr (mensajería)

Los mensajes directos entre usuarios de Crow se cifran con NIP-44 y se retransmiten a través de relays de Nostr. Los mensajes aparecen en el panel de Mensajes del Crow's Nest y son accesibles desde cualquier IA conectada vía las herramientas `crow_send_message` y `crow_inbox`.

### Hypercore (sincronización de datos)

Los elementos compartidos (memorias, proyectos, fuentes) se replican entre peers sobre feeds append-only de Hypercore. Los peers se descubren entre sí vía el DHT de Hyperswarm con NAT holepunching — sin necesidad de un servidor central.

### Peer relay (entrega sin conexión)

Cuando un peer está desconectado, los mensajes y las comparticiones pueden quedar retenidos por un peer relay opt-in para su entrega posterior. El relay almacena payloads cifrados y los reenvía cuando el destinatario se conecta.

## Elegir un patrón

| Escenario | Patrón recomendado |
|---|---|
| Sesión de investigación profunda con Claude | MCP externo (stdio) |
| Consulta rápida de memoria desde tu teléfono | Chat BYOAI (Crow's Nest) |
| Colaboración en equipo en Discord | Bots nativos (Bot Builder) |
| Proyecto de código con asistencia de IA | MCP externo vía Cursor o Claude Code |
| Totalmente local, sin IA en la nube | Chat BYOAI con Ollama |
| Acceso desde varias apps de chat | Bots nativos (Discord, Telegram, Slack, Gmail) |
| Gestión automatizada del hogar | Bots nativos con skills |
| Todo lo anterior, simultáneamente | Los tres — comparten una sola base de datos |

## Próximos pasos

- [Proveedores de IA (BYOAI)](/es/guide/ai-providers) — Configura el AI Chat integrado
- [Bot Builder](/es/guide/bot-builder) — Crea y gestiona agentes nativos desde el dashboard
- [Guía multiplataforma](/es/guide/cross-platform) — Cómo se sincroniza el contexto de comportamiento entre plataformas
- [Plataformas](/es/platforms/) — Guías de configuración por plataforma para MCP externo
- [Gestión de contexto](/es/architecture/context-management) — Análisis a fondo del router de herramientas
