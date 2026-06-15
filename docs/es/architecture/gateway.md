# Gateway

El gateway (`servers/gateway/`) es un servidor Express que hace accesibles los servidores MCP de Crow sobre HTTP con autenticación OAuth 2.1.

## Estructura modular de rutas

El punto de entrada del gateway (`servers/gateway/index.js`, ~600 líneas) es una **narrativa de seguridad ordenada**: el middleware de funnel/frontera de red y la cadena de autenticación se conectan en línea, en un orden deliberado que *es* el modelo de seguridad. Todo lo demás se monta desde módulos bajo `servers/gateway/boot/`:

| Módulo de boot | Propósito |
|---|---|
| `boot/public-endpoints.js` | Endpoints seguros para exposición pública (`/health`, `.well-known`, robots, manifest) |
| `boot/mcp-mounts.js` | Todos los montajes de servidores MCP (endpoints por servidor + el router) |
| `boot/feature-mounts.js` | Rutas de funcionalidades: administración de respaldos, almacenamiento, blog, gestor de ventanas, media |
| `boot/admin-api.js` | Rutas de la API de administración del dashboard |
| `boot/peer-public-api.js` | Superficie de API pública de peers/federación |
| `boot/late-mounts.js` | Rutas que deben montarse después de las pilas principales |
| `boot/post-listen.js` | Tareas de arranque posteriores al listen + resumen en consola |

La lógica central de transporte MCP está en `routes/mcp.js`, que exporta el helper `mountMcpServer()`. Otros módulos de rutas manejan asuntos específicos:

| Módulo | Propósito |
|---|---|
| `routes/mcp.js` | `mountMcpServer()` — monta los transportes Streamable HTTP + SSE para cualquier servidor MCP |
| `routes/storage-http.js` | Rutas HTTP de subida de archivos (multipart) y descarga (redirección prefirmada) |
| `routes/blog-public.js` | Páginas públicas del blog, páginas de etiquetas, feeds RSS y Atom (sin autenticación) |
| `dashboard/` | Paneles de la UI de Crow's Nest y sistema de autenticación |
| `session-manager.js` | Almacenamiento de sesiones consolidado para todos los servidores MCP (reemplaza los Maps por servidor) |

## Transportes

### El helper mountMcpServer()

Todos los servidores MCP se montan mediante la función `mountMcpServer(router, prefix, createServer, sessionManager, authMiddleware, peerGate)` de `routes/mcp.js`. Registra los endpoints Streamable HTTP y SSE para una fábrica de servidor dada, usando el `SessionManager` consolidado para el seguimiento de sesiones. El `peerGate` opcional es una verificación de exposición con denegación por defecto que se aplica a las **instancias peer** autenticadas (federación): una instancia remota solo puede alcanzar los servidores que el operador le haya expuesto explícitamente. Los operadores locales (sesión del dashboard, OAuth o el token MCP local) omiten el peer gate.

### Streamable HTTP (principal)

Transporte MCP moderno usado por la mayoría de los clientes.

| Endpoint | Servidor |
|---|---|
| `POST\|GET\|DELETE /memory/mcp` | crow-memory |
| `POST\|GET\|DELETE /projects/mcp` | crow-projects |
| `POST\|GET\|DELETE /research/mcp` | crow-projects (alias legado) |
| `POST\|GET\|DELETE /sharing/mcp` | crow-sharing |
| `POST\|GET\|DELETE /storage/mcp` | crow-storage (condicional, requiere MinIO) |
| `POST\|GET\|DELETE /blog-mcp/mcp` | crow-blog |
| `POST\|GET\|DELETE /tools/mcp` | Proxy de herramientas externas |
| `POST\|GET\|DELETE /wm/mcp` | Gestor de ventanas (cliente kiosk del companion; misma cadena de autenticación que cualquier otro montaje — token MCP local, OAuth o peer con exposición controlada) |
| `POST\|GET\|DELETE /mcp` | crow-memory (alias de compatibilidad) |

Las sesiones se gestionan mediante el header `mcp-session-id`. Las sesiones nuevas se crean en las solicitudes `initialize`. Cada transporte recibe un `EventStore` en memoria para reanudación.

### SSE (legado)

Transporte legado para ChatGPT y clientes antiguos.

| Endpoint | Propósito |
|---|---|
| `GET /memory/sse` | Abre el stream SSE + crea la sesión |
| `POST /memory/messages` | Envía mensajes a la sesión |
| `GET /projects/sse` | Abre el stream SSE |
| `POST /projects/messages` | Envía mensajes |
| `GET /research/sse` | Abre el stream SSE (alias legado) |
| `POST /research/messages` | Envía mensajes (alias legado) |
| `GET /sharing/sse` | Abre el stream SSE |
| `POST /sharing/messages` | Envía mensajes |
| `GET /storage/sse` | Abre el stream SSE (condicional) |
| `POST /storage/messages` | Envía mensajes (condicional) |
| `GET /blog-mcp/sse` | Abre el stream SSE |
| `POST /blog-mcp/messages` | Envía mensajes |
| `GET /tools/sse` | Abre el stream SSE |
| `POST /tools/messages` | Envía mensajes |

Las sesiones se identifican por el parámetro de consulta `sessionId` en los endpoints de mensajes.

## OAuth 2.1

El gateway implementa OAuth 2.1 con Registro Dinámico de Clientes:

| Ruta | Propósito |
|---|---|
| `GET /.well-known/oauth-authorization-server` | Descubrimiento de metadatos OAuth |
| `GET /.well-known/oauth-protected-resource` | Metadatos del recurso protegido |
| `POST /register` | Registro dinámico de clientes |
| `GET /authorize` | Endpoint de autorización |
| `POST /token` | Endpoint de tokens |
| `POST /introspect` | Introspección de tokens |

OAuth está respaldado por tablas SQLite (`oauth_clients`, `oauth_tokens`) para persistir entre reinicios.

Ejecuta sin autenticación solo para desarrollo local:
```bash
node servers/gateway/index.js --no-auth
```

> **Salvaguarda:** El gateway se niega a arrancar con `--no-auth` si `CROW_GATEWAY_URL` contiene un dominio público (p. ej., `.ts.net`, `.onrender.com`, `.fly.dev`). Esto evita la exposición accidental de endpoints MCP sin autenticación vía Tailscale Funnel u hosting en la nube.

## Proxy de integraciones

El sistema de proxy (`proxy.js` + `integrations.js`) agrega servidores MCP externos en el endpoint `/tools/mcp`:

1. Al arrancar, lee qué claves de API están presentes en las variables de entorno
2. Para cada integración configurada, lanza el servidor MCP como proceso hijo
3. Se conecta vía transporte stdio y descubre las herramientas disponibles
4. Prefija los nombres de las herramientas con el ID de la integración (p. ej., `github_create_issue`)
5. Expone todas las herramientas a través de un único endpoint MCP

### Agregar una nueva integración

Edita `servers/gateway/integrations.js`:

```js
{
  id: "my-service",
  name: "My Service",
  description: "What it does",
  command: "npx",
  args: ["-y", "mcp-server-my-service"],
  envVars: ["MY_SERVICE_API_KEY"],
  keyUrl: "https://example.com/api-keys",
  keyInstructions: "How to get the key.",
}
```

## Página de configuración

`GET /setup` sirve una página HTML adaptada a móviles que muestra:

- Integraciones conectadas (verde) con conteos de herramientas
- Integraciones disponibles (gris) con enlaces de configuración
- URLs de endpoints MCP para todos los transportes soportados
- Instrucciones rápidas de configuración para cada plataforma de IA

No requiere autenticación — no expone secretos.

## Consideraciones de seguridad

- **Nunca uses `--no-auth` en producción** — desactiva toda la autenticación. El gateway rechaza `--no-auth` cuando `NODE_ENV=production` o cuando `CROW_GATEWAY_URL` contiene un dominio público
- **Despliega siempre detrás de HTTPS** — Render y Railway lo proporcionan automáticamente. Si te autoalojas, usa un reverse proxy (nginx, Caddy) con TLS, o Tailscale Funnel
- La **página `/setup`** no tiene autenticación por diseño — solo muestra un formulario de contraseña (sin secretos). Protégela con `CROW_SETUP_TOKEN` en instancias alojadas
- **`/api/health`** está protegido por la autenticación de sesión del dashboard — expone métricas del sistema (RAM, disco, CPU). El endpoint público **`/health`** devuelve solo el estado del servidor (sin información del sistema)
- Los **tokens OAuth** se almacenan en la base de datos SQLite y persisten entre reinicios
- El **rate limiting** viene integrado — 200 solicitudes por 15 minutos (general) y 20 solicitudes por 15 minutos (endpoints de autenticación: `/authorize`, `/token`, `/register`). Para despliegues de alto tráfico, agrega rate limiting adicional vía tu reverse proxy o proveedor de hosting
- Las **conexiones SSE tienen un tope** — como máximo `CROW_SSE_MAX` (200 por defecto) streams abiertos concurrentes entre los ocho endpoints SSE. Por encima del tope, el gateway responde `503` con `Retry-After: 5` y libera todos los recursos por stream
- Un **token MCP local** (generado desde el panel Connect del dashboard) autentica clientes de IA locales sin el flujo OAuth — verificado del lado del servidor, almacenado como hash, revocable desde el mismo panel. Consulta la [Guía Multiplataforma](/es/guide/cross-platform)
- La **Content Security Policy** restringe la carga de recursos — permite Google Fonts (dashboard), scripts del mismo origen y fuentes de media de podcasts
- El **endpoint `/crow.md`** está protegido por OAuth cuando la autenticación está habilitada, ya que expone contexto de comportamiento

Para el modelo completo de acceso público/privado, consulta la [Guía de Seguridad](https://github.com/kh0pper/crow/blob/main/SECURITY.md#whats-public-by-default).

## Modo router

El endpoint `/router/mcp` expone **una herramienta de categoría consolidada por servidor** en lugar de la superficie completa de herramientas en crudo (más de 120 herramientas entre todos los servidores). Esto supone una reducción importante de la ventana de contexto y es la forma recomendada de conectar un cliente de IA.

En una instalación completa el router registra 9 herramientas: 7 herramientas de categoría (`crow_memory`, `crow_projects`, `crow_blog`, `crow_sharing`, `crow_storage`, `crow_media`, `crow_consulting`) más `crow_tools` (integraciones externas + instancias remotas) y `crow_discover` (consulta de esquemas). Las categorías de almacenamiento y media aparecen solo cuando su servicio o bundle de respaldo está disponible. Cada herramienta de categoría despacha al servidor subyacente mediante un Client MCP en proceso. La herramienta `crow_discover` devuelve esquemas completos bajo demanda, de modo que los clientes pueden inspeccionar las acciones disponibles sin cargar todas las definiciones de herramientas por adelantado. El nombre `crow_research` se acepta como alias retrocompatible de `crow_projects`.

El modo router es retrocompatible — los endpoints por servidor existentes (`/memory/mcp`, `/research/mcp`, etc.) permanecen sin cambios y siguen funcionando como antes. El router es un endpoint adicional, no un reemplazo.

Para desactivar el modo router, establece la variable de entorno `CROW_DISABLE_ROUTER=1`.

Para la referencia completa, consulta [Gestión de Contexto](/es/architecture/context-management).

## API de Chat

El gateway incluye un sistema de Chat con IA integrado (`/api/chat/*`) que convierte a Crow en un cliente de IA. Esto impulsa la función de Chat BYOAI en el Crow's Nest. Todas las rutas de chat están protegidas por la autenticación de sesión del dashboard (basada en cookies).

### Rutas

| Método | Endpoint | Propósito |
|---|---|---|
| `POST` | `/api/chat/conversations` | Crea una conversación nueva |
| `GET` | `/api/chat/conversations` | Lista las conversaciones (paginado) |
| `GET` | `/api/chat/conversations/:id` | Obtiene una conversación con todos sus mensajes |
| `DELETE` | `/api/chat/conversations/:id` | Elimina una conversación (en cascada a los mensajes) |
| `POST` | `/api/chat/conversations/:id/messages` | Envía un mensaje, recibe un stream SSE |
| `POST` | `/api/chat/conversations/:id/cancel` | Cancela una generación en curso |
| `GET` | `/api/chat/providers` | Lista los proveedores disponibles y la configuración actual |
| `POST` | `/api/chat/providers/test` | Prueba la conexión con el proveedor |

### Patrón de adaptadores de proveedor

La capa de proveedores de IA (`ai/provider.js`) usa un registro de adaptadores de carga diferida:

| Proveedor | Adaptador | Formato de API |
|---|---|---|
| `openai` | `ai/adapters/openai.js` | OpenAI Chat Completions (también OpenRouter, vLLM, LM Studio) |
| `anthropic` | `ai/adapters/anthropic.js` | Anthropic Messages API |
| `google` | `ai/adapters/google.js` | API REST de Google Gemini |
| `ollama` | `ai/adapters/ollama.js` | `/api/chat` nativo de Ollama |

Cada adaptador implementa un método `chatStream(messages, tools, options)` que devuelve un iterador asíncrono que emite eventos: `content_delta` (fragmentos de texto), `tool_call` (llamadas a funciones) y `done` (estadísticas de uso). La configuración del proveedor se recarga en caliente desde `.env` con una caché de 5 segundos.

### Patrón del ejecutor de herramientas

Cuando la IA responde con llamadas a herramientas, el ejecutor de herramientas (`ai/tool-executor.js`) las despacha a los servidores MCP de Crow:

1. El ejecutor mantiene un pool de Clients MCP en proceso de carga diferida, uno por categoría de servidor
2. Cada client se conecta a su fábrica de servidor vía `InMemoryTransport` (el mismo patrón que el router de herramientas)
3. Las llamadas a herramientas se resuelven por categoría — `crow_memory` enruta al servidor de memoria, `crow_projects` al servidor de proyectos, etc.
4. La IA ve las herramientas de categoría al estilo del router (el ejecutor despacha las categorías de memoria, proyectos, blog, compartición, almacenamiento y media), más `crow_tools`, `crow_discover` para consulta de esquemas, y herramientas explícitas de orquestación
5. Los resultados se truncan a 2000 caracteres para evitar el desbordamiento del contexto
6. Hasta 10 rondas de llamadas a herramientas por turno de mensaje (la IA puede llamar herramientas, obtener resultados y llamar más herramientas)

```
Mensaje del usuario
  → API del proveedor de IA (streaming)
    → eventos content_delta → SSE al navegador
    → eventos tool_call → Ejecutor de herramientas
      → InMemoryTransport → Servidor MCP → Base de datos
      → resultado → de vuelta a la IA para la siguiente ronda
  → evento done → SSE al navegador
```

Los resultados de herramientas y los mensajes del asistente se persisten en `chat_messages` con conteos de tokens. Las conversaciones registran el total de tokens para el monitoreo de uso.

### Rate limiting

Los mensajes de chat están limitados a 10 mensajes por minuto por sesión (independiente del rate limiter general del gateway). Las generaciones activas se pueden cancelar vía el endpoint de cancelación o cuando el cliente se desconecta.

## Apagado controlado

Ante `SIGTERM`/`SIGINT` el gateway ejecuta un drenaje por etapas en lugar de salir de inmediato: detiene el scheduler (para que no se disparen nuevos ticks en segundo plano durante el desmontaje), deja de aceptar conexiones nuevas, da a las solicitudes en curso hasta `CROW_SHUTDOWN_DRAIN_MS` (3000 ms por defecto) para terminar, corta los sockets restantes (los streams SSE de larga duración se reconectan tras el reinicio), cierra las sesiones MCP y los procesos hijos del proxy, y finalmente hace un checkpoint best-effort del WAL de SQLite antes de salir. Esto minimiza las interrupciones a mitad de operación durante despliegues y reinicios. Un monitor que consulte `/health` puede ver rechazos durante la ventana de drenaje — ese es el comportamiento esperado de un reinicio.

## Health check

`GET /health` devuelve el estado en JSON:

```json
{
  "status": "ok",
  "servers": ["crow-memory", "crow-projects", "crow-sharing", "crow-storage", "crow-blog"],
  "externalServers": [{"id": "github", "name": "GitHub", "tools": 15}]
}
```

Las métricas de recursos del sistema (RAM, disco, CPU) están disponibles en `GET /api/health`, protegido por la autenticación de sesión del dashboard.

## Federación

El gateway puede hacer proxy de llamadas a herramientas hacia instancias remotas de Crow vía HTTP. Cuando una instancia está registrada en la tabla `crow_instances` con un `gateway_url`, la capa de proxy se conecta usando el `StreamableHTTPClientTransport` del SDK de MCP y hace disponibles las herramientas remotas a través de la acción `crow_tools` del router con un parámetro `instance_id`. Consulta la [Arquitectura Multi-Instancia](./instances) para los detalles de sincronización, resolución de conflictos y seguridad.
