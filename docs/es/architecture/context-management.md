# Gestión de Contexto

## Descripción general

El protocolo MCP carga de forma anticipada todas las firmas de herramientas cuando un servidor se conecta. El nombre, la descripción y el JSON Schema completo de cada herramienta consumen tokens en la ventana de contexto de la IA antes de que la conversación siquiera comience. Con 49 herramientas centrales entre cinco servidores más las integraciones externas, este costo base alcanza más de 10,000-20,000 tokens — una fracción significativa del contexto disponible en modelos de ventana pequeña y un multiplicador de costo en cada solicitud.

Crow aborda esto con dos estrategias complementarias: el **Router de Herramientas del Gateway** (despliegues HTTP) y la **Activación de Servidores Bajo Demanda** (despliegues stdio). Ambas se construyen sobre el mismo patrón de fábrica de servidores y la misma fontanería de `InMemoryTransport`.

## Router de herramientas del gateway

El router (`servers/gateway/router.js`) consolida todas las herramientas centrales y externas detrás de una herramienta de categoría por servidor — 10 herramientas en una instalación completa — reduciendo el uso de contexto en aproximadamente un 90%.

### Arquitectura

```
                        +-----------------------+
  [AI Client] -------->| /router/mcp           |
                        |  crow-router McpServer|
                        +-----------+-----------+
                                    |
            +-----------+-----------+-----------+-----------+
            |           |           |           |           |
     crow_memory  crow_projects  crow_blog  crow_sharing  crow_storage  (+media,
                                                            orchestrator, consulting)
            |           |           |           |           |
     [InMemory   [InMemory   [InMemory   [InMemory   [InMemory
      Transport]  Transport]  Transport]  Transport]  Transport]
            |           |           |           |           |
     [Memory     [Projects   [Blog       [Sharing   [Storage
      McpServer]  McpServer]  McpServer]  McpServer]  McpServer]

  crow_tools -----> connectedServers (from proxy.js)
  crow_discover --> static manifests + live schema lookup
```

Cada herramienta de categoría crea un `Client` en proceso conectado al `McpServer` subyacente vía `InMemoryTransport.createLinkedPair()`. Los clients se crean de forma diferida en el primer uso dentro de cada sesión.

### Herramientas del router

| Herramienta | Despacha a | Acciones |
|---|---|---|
| `crow_memory` | Servidor de memoria | 21 (almacenar, buscar, recuperar, listar, actualizar, eliminar, estadísticas, operaciones de contexto) |
| `crow_projects` | Servidor de proyectos | 16 (proyectos, fuentes, notas, bibliografía, estadísticas) |
| `crow_blog` | Servidor de blog | 23 (crear, editar, publicar, listar, eliminar, exportar, temas, estadísticas) |
| `crow_sharing` | Servidor de compartición | 21 (invitaciones, contactos, compartir, bandeja de entrada, mensajería, instancias, revocar) |
| `crow_storage` | Servidor de almacenamiento | 8 (subir, listar, URL de descarga, eliminar, estadísticas) — cuando MinIO está configurado |
| `crow_media` | Bundle de media | 17 (artículos, podcasts, playlists) — cuando el bundle está instalado |
| `crow_orchestrator` | Servidor orquestador | 7 (orquestar, estado, presets, pipelines) — cuando está disponible |
| `crow_consulting` | Servidor de consultoría | 6 (operaciones del pipeline de prospectos) |
| `crow_tools` | Servidores proxy externos | Dinámico (Trello, Canvas, Slack, etc.) + instancias remotas |
| `crow_discover` | Manifiestos estáticos + esquemas en vivo | Protocolo de descubrimiento |

### Esquema de parámetros

Toda herramienta de categoría acepta la misma forma:

```js
{
  action: z.string(),    // Nombre de la acción, p. ej. "store_memory" o "crow_store_memory"
  params: z.record(z.any()).optional()  // Parámetros reenviados a la herramienta subyacente
}
```

El router resuelve los nombres de herramientas con o sin el prefijo `crow_`, así que tanto `store_memory` como `crow_store_memory` funcionan.

### Manifiestos comprimidos

La descripción de cada herramienta de categoría se construye con `buildCompressedDescription()` a partir de `tool-manifests.js`. Empaqueta todos los nombres de acciones y las firmas de parámetros dentro del string de descripción de la herramienta:

```
Persistent memory: store, search, recall, list... Actions:
- store_memory(content, category?, context?, tags?, source?, importance?): Store a memory
- search_memories(query, category?, min_importance?, limit?): Search memories (FTS5)
...
```

Esto le da a la IA suficiente información para llamar la mayoría de las acciones sin descubrimiento, mientras mantiene pequeña la huella del esquema.

### Protocolo de descubrimiento

La herramienta `crow_discover` proporciona acceso bajo demanda a los JSON Schemas completos:

```
crow_discover()                              → Lista todas las categorías con conteos de acciones
crow_discover(category="memory")             → Lista las acciones de memoria con resúmenes de parámetros
crow_discover(category="memory", action="crow_store_memory") → JSON Schema completo
crow_discover(category="tools")              → Lista las herramientas de integraciones externas
crow_discover(category="tools", action="github_create_issue") → Esquema completo de la herramienta externa
```

El descubrimiento a nivel de categoría usa manifiestos estáticos (sin instanciar servidores). El descubrimiento a nivel de acción llama a `client.listTools()` en el servidor subyacente para devolver el esquema en vivo.

### Ahorro de contexto

| Modo | Herramientas cargadas | Tokens estimados |
|---|---|---|
| Servidores individuales (sin router) | 126+ x ~200 tokens | ~25,000+ |
| Modo router | 10 x ~300 tokens | ~3,000 |
| **Reducción** | | **~90%** |

### Bandera de funcionalidad

Desactiva el router para montar los servidores individualmente:

```bash
CROW_DISABLE_ROUTER=1 npm run gateway
```

## Activación de servidores bajo demanda (crow-core)

Para despliegues stdio, `servers/core/` proporciona un único servidor MCP que arranca con un servidor activo y agrega los demás bajo demanda.

### Arquitectura

```
  [AI Client] <--stdio--> [crow-core McpServer]
                                |
                          +-----+-----+
                          |           |
                   [Active Tools]  [Management Tools (3)]
                   (memory: 12)    crow_activate_server
                                   crow_deactivate_server
                                   crow_server_status

  crow_activate_server("projects")
        |
        v
  [registeredTool.enable()] --> toolListChanged notification
        |
        v
  [AI re-fetches tool list] --> project tools now visible
```

### Herramientas de gestión

| Herramienta | Parámetros | Descripción |
|---|---|---|
| `crow_activate_server` | `server: string` | Habilita las herramientas de un servidor (memory, projects, sharing, storage, blog) |
| `crow_deactivate_server` | `server: string` | Deshabilita las herramientas de un servidor (el servidor predeterminado no se puede desactivar) |
| `crow_server_status` | ninguno | Muestra los servidores activos/inactivos con conteos de herramientas |

### Comportamiento al arrancar

1. Todos los servidores se conectan vía `InMemoryTransport` y sus herramientas se registran en el `McpServer` core
2. Solo las herramientas del servidor predeterminado quedan habilitadas; todas las demás quedan registradas pero deshabilitadas
3. La IA ve 15 herramientas al arrancar: 12 herramientas de memoria + 3 herramientas de gestión
4. Llamar `crow_activate_server("projects")` cambia las herramientas registradas a habilitadas y dispara una notificación `toolListChanged`
5. El cliente de IA vuelve a obtener la lista de herramientas y ve las recién disponibles

El servidor predeterminado es configurable:

```bash
CROW_DEFAULT_SERVER=projects node servers/core/index.js
```

## Contexto de comportamiento automático (instructions de MCP)

El protocolo MCP soporta un campo `instructions` en el `InitializeResult` — un string enviado durante el handshake de conexión antes de cualquier llamada a herramienta. Según la especificación, este "puede ser usado por los clientes para mejorar la comprensión del LLM sobre las herramientas disponibles" y "PUEDE agregarse al system prompt".

Crow lo usa para entregar contexto de comportamiento automáticamente a cada cliente de IA conectado, eliminando la necesidad de que los usuarios le pidan manualmente a la IA cargar crow.md.

### Cómo funciona

```
  Arranque del gateway
       |
       v
  generateInstructions() ──> consulta la tabla crow_context
       |                     extrae las 5 secciones esenciales
       v                     condensa a un string de ~1KB
  string de instructions (precomputado)
       |
       +──> createMemoryServer(undefined, { instructions })
       +──> createProjectServer(undefined, { instructions })
       +──> createRouterServer({ instructions: routerInstructions })
       +──> ...
       |
       v
  McpServer({ name, version }, { instructions })
       |
       v
  El cliente se conecta ──> InitializeResult incluye instructions
       |
       v
  La IA ve el contexto de comportamiento antes de cualquier llamada a herramienta
```

El string de instructions se genera **una sola vez al arrancar el gateway** y se pasa a todas las fábricas de servidores como un string precomputado. Esto evita consultas a la base de datos por sesión y mantiene las fábricas síncronas.

### Contenido

Las instructions condensadas (~1KB) incluyen:

| Sección | Contenido |
|---|---|
| Identidad | Quién es Crow (1-2 oraciones) |
| Protocolo de sesión | "Llama crow_recall_by_context al inicio de la sesión" |
| Protocolo de memoria | Categorías, niveles de importancia, reglas de deduplicación |
| Reglas de transparencia | Notación [crow: action] para acciones autónomas |
| Capacidades | Tabla de enrutamiento de herramientas (nombres directos o nombres de categoría para el router) |

Se generan dos variantes:
- **Estilo directo**: Usa nombres de herramientas como `crow_store_memory` (para los endpoints de servidores individuales)
- **Estilo router**: Usa nombres de categoría como `crow_memory action: "store_memory"` (para `/router/mcp`)

### Respaldo

Si la tabla `crow_context` no existe o la base de datos no está disponible, se usa un fallback estático de ~500 bytes que proporciona una guía de comportamiento mínima.

### Overrides por dispositivo

Todas las funciones de generación de contexto (`generateCrowContext`, `generateCondensedContext`, `generateInstructions`) aceptan un parámetro opcional `deviceId`. Cuando se proporciona, el sistema consulta todas las filas de `crow_context` y fusiona las secciones globales (`device_id IS NULL`) con las secciones específicas del dispositivo (`device_id = ?`). Las secciones específicas del dispositivo anulan a las globales con la misma `section_key`; las secciones exclusivas del dispositivo se anexan al final.

La tabla `crow_context` usa dos índices únicos parciales para garantizar la unicidad: uno para las secciones globales (`WHERE device_id IS NULL`) y otro para las secciones específicas de dispositivo (`WHERE device_id IS NOT NULL`).

### Servidores stdio

Los puntos de entrada stdio (`servers/*/index.js`) generan las instructions al arrancar usando `await` de nivel superior, y luego pasan el string a la fábrica. crow-core hace lo mismo dentro de su función asíncrona `createCoreServer()`.

## Prompts MCP (equivalentes a skills)

Los prompts MCP son plantillas de prompt de primera clase que los clientes pueden listar y solicitar bajo demanda. Crow registra prompts como **equivalentes a skills para las plataformas distintas de Claude Code**, dándole a la IA acceso a guías de flujo de trabajo detalladas sin consumir espacio de la ventana de contexto por adelantado.

### Prompts disponibles

| Prompt | Servidor(es) | Descripción |
|---|---|---|
| `session-start` | Memoria, Router | Protocolo de inicio/fin de sesión de crow.md |
| `crow-guide` | Memoria, Router | Documento crow.md completo (acepta el argumento `platform`) |
| `research-guide` | Proyectos, Router | Flujo de investigación: proyectos, fuentes, citas, bibliografía |
| `blog-guide` | Blog, Router | Publicación en el blog: entradas, temas, RSS, exportación |
| `sharing-guide` | Compartición, Router | Compartición P2P: invitaciones, contactos, mensajería |

El router registra los 5 prompts, de modo que los clientes conectados a `/router/mcp` tienen acceso a todo. Los servidores individuales registran solo sus propios prompts relevantes.

### Cómo los clientes usan los prompts

```
Client: prompts/list
Server: [{ name: "session-start", description: "..." }, ...]

Client: prompts/get { name: "crow-guide", arguments: { platform: "chatgpt" } }
Server: { messages: [{ role: "user", content: { type: "text", text: "# crow.md — ..." } }] }
```

La IA puede solicitar un prompt cuando necesita una guía detallada para un flujo de trabajo específico, manteniendo pequeña la huella inicial de contexto mientras las instrucciones completas quedan disponibles bajo demanda.

## Integración con la fábrica de servidores

Tanto el router como crow-core reutilizan las mismas funciones de fábrica (`createMemoryServer`, `createProjectServer`, etc.) y el mismo patrón de `InMemoryTransport` + `Client`. La fábrica crea un `McpServer` independiente; quien la llama lo conecta al transporte que el despliegue necesite:

```js
// stdio (servidor individual)
const server = createMemoryServer();
await server.connect(new StdioServerTransport());

// Router del gateway (en proceso)
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

// crow-core (mismo patrón en proceso, herramientas proxied al McpServer core)
```

Los metadatos estáticos de herramientas viven en `servers/gateway/tool-manifests.js`. Tanto el router (`buildCompressedDescription`) como crow-core (`getToolNames`) los importan de ahí.

## Configuración

### Generación de .mcp.json

```bash
# Servidores individuales (una entrada por servidor en .mcp.json)
npm run mcp-config

# Modo combinado crow-core (una sola entrada)
npm run mcp-config -- --combined
```

La bandera `--combined` escribe una única entrada `crow-core` que apunta a `servers/core/index.js` en lugar de entradas separadas para cada servidor. El registro de servidores en `scripts/server-registry.js` define ambos modos.

### Endpoint de salud

La respuesta de `/health` del gateway incluye telemetría de conteo de herramientas:

```json
{
  "status": "ok",
  "servers": ["crow-memory", "crow-projects", "crow-sharing", "crow-storage", "crow-blog"],
  "externalServers": [{ "id": "github", "name": "GitHub", "tools": 15 }],
  "toolCounts": {
    "core": 143,
    "external": 15,
    "total": 158,
    "routerMode": 10
  }
}
```

El campo `routerMode` es el número de herramientas del router expuestas (10 en una instalación completa), o `null` cuando el router está desactivado vía `CROW_DISABLE_ROUTER=1`. `core` cuenta todas las acciones del manifiesto en las 8 categorías (143 incluyendo las 17 del complemento de medios).

## Referencia de API

| Endpoint | Método | Descripción |
|---|---|---|
| `/router/mcp` | POST, GET, DELETE | Transporte Streamable HTTP para el McpServer del router |
| `/health` | GET | Estado, incluye el objeto `toolCounts` |

Para guía de uso y consejos de optimización, consulta la [Guía de Rendimiento de Contexto](/es/guide/context-performance).
