# Trae Tu Propio Proveedor de IA (BYOAI)

El Chat de IA integrado de Crow te permite conversar con cualquier proveedor de IA directamente desde el dashboard del Crow's Nest. La IA tiene acceso completo a tus herramientas de Crow — memoria, proyectos, blog, almacenamiento y compartición — así que puedes gestionar tus datos mediante conversación natural.

## Cómo encaja BYOAI

BYOAI es una de las [tres formas en que la IA se conecta a Crow](/guide/integration-overview). Las plataformas externas (Claude.ai, ChatGPT, Cursor) se conectan vía MCP y traen su propia IA. BYOAI invierte eso: el gateway de Crow actúa como el cliente de IA, llamando a la API del proveedor en tu nombre y despachando las llamadas a herramientas internamente.

Esto significa que BYOAI y las conexiones MCP externas comparten la misma base de datos. Una memoria almacenada desde el Chat BYOAI está disponible al instante en Claude.ai, y viceversa. Todos los patrones de conexión leen y escriben los mismos datos.

## Cómo funciona

Los servidores MCP de Crow son **proveedores de herramientas**. Cuando configuras un proveedor de IA, el gateway de Crow actúa como un puente: envía tus mensajes a la IA, y cuando la IA quiere usar herramientas de Crow (buscar memorias, crear publicaciones del blog, etc.), el gateway ejecuta esas llamadas localmente y le devuelve los resultados.

Esto significa:
- Tus datos se quedan en tu máquina
- El proveedor de IA solo ve la conversación y los resultados de las herramientas
- Puedes cambiar de proveedor en cualquier momento con solo modificar unas variables de entorno
- Funciona con opciones gratuitas/baratas como Ollama (totalmente local) u OpenRouter

## Configuración rápida

### Desde el Crow's Nest (recomendado)

1. Abre el Crow's Nest → **Configuración**
2. Encuentra la sección **AI Provider**
3. Selecciona tu proveedor en el desplegable
4. Ingresa tu clave de API (no se necesita para Ollama)
5. Haz clic en **Guardar**, luego en **Probar Conexión**
6. Ve a **Mensajes** → la pestaña **AI Chat** ahora está activa

### Desde `.env`

Agrega esto a tu archivo `.env` (o `~/.crow/.env`):

```env
AI_PROVIDER=openai
AI_API_KEY=sk-...
AI_MODEL=gpt-4o
```

No se necesita reiniciar el gateway — la configuración se recarga en caliente.

## Proveedores soportados

| Proveedor | `AI_PROVIDER` | Modelo predeterminado | Requiere clave de API | Notas |
|---|---|---|---|---|
| OpenAI | `openai` | `gpt-4o` | Sí | [Obtener clave](https://platform.openai.com/api-keys) |
| Anthropic | `anthropic` | `claude-sonnet-4-20250514` | Sí | [Obtener clave](https://console.anthropic.com/settings/keys) |
| Google Gemini | `google` | `gemini-2.5-flash` | Sí | [Obtener clave](https://aistudio.google.com/app/apikey) |
| Ollama | `ollama` | `llama3.1` | No | Totalmente local, no requiere clave de API |
| OpenRouter | `openrouter` | `openai/gpt-4o` | Sí | [Obtener clave](https://openrouter.ai/keys) — acceso a más de 100 modelos |
| Meta AI (Llama) | `meta` | `Llama-4-Maverick-17B-128E-Instruct-FP8` | Sí | [Obtener clave](https://llama.com/) — modelos Llama 4 y 3.3 |
| DashScope Coding | `openai` | `qwen3.5-plus` | Sí | [Obtener clave](https://dashscope.console.aliyun.com/apiKey) — Qwen, GLM, Kimi, MiniMax ([guía](/guide/dashscope-coding)) |
| Z.AI Coding | `openai` | `glm-5` | Sí | [Obtener clave](https://z.ai) — modelos GLM ([guía](/guide/zai-coding)) |

### OpenAI

```env
AI_PROVIDER=openai
AI_API_KEY=sk-...
AI_MODEL=gpt-4o
```

Funciona con GPT-4o, GPT-4o-mini, o1 y cualquier modelo disponible en la API de OpenAI.

### Anthropic

```env
AI_PROVIDER=anthropic
AI_API_KEY=sk-ant-...
AI_MODEL=claude-sonnet-4-20250514
```

Funciona con los modelos Claude Opus, Sonnet y Haiku.

### Google Gemini

```env
AI_PROVIDER=google
AI_API_KEY=AIza...
AI_MODEL=gemini-2.5-flash
```

Usa la API REST de Gemini. Funciona con Gemini 2.5 Flash, Gemini 2.5 Pro y otros modelos disponibles. El nivel gratuito es generoso para uso personal.

### Ollama (Local)

```env
AI_PROVIDER=ollama
AI_MODEL=llama3.1
AI_BASE_URL=http://localhost:11434
```

Corre completamente en tu máquina — sin clave de API, ningún dato sale de tu red. Instala Ollama desde [ollama.com](https://ollama.com) o usa el complemento Ollama de Crow (`crow bundle install ollama`).

::: warning Llamadas a herramientas con Ollama
La mayoría de los modelos locales tienen soporte limitado o nulo para llamadas a funciones/herramientas. Para mejores resultados con las herramientas de Crow, usa modelos que soporten llamadas a funciones: `llama3.1`, `mistral-nemo`, `qwen2.5`. Sin soporte de herramientas, el chat funciona pero no puede acceder a tus datos de Crow.
:::

### OpenRouter

```env
AI_PROVIDER=openrouter
AI_API_KEY=sk-or-...
AI_MODEL=openai/gpt-4o
```

OpenRouter te da acceso a más de 100 modelos de múltiples proveedores con una sola clave de API. Excelente para probar distintos modelos sin registrarte en cada proveedor por separado. Muchos modelos tienen niveles gratuitos.

### Meta AI (Llama)

```env
AI_PROVIDER=meta
AI_API_KEY=LLM|...
AI_MODEL=Llama-4-Maverick-17B-128E-Instruct-FP8
```

La API Llama de Meta brinda acceso directo a los modelos Llama. Modelos disponibles:

| Modelo | RPM | TPM |
|---|---|---|
| `Llama-4-Maverick-17B-128E-Instruct-FP8` | 10 | 250,000 |
| `Llama-4-Scout-17B-16E-Instruct-FP8` | 10 | 250,000 |
| `Llama-3.3-70B-Instruct` | 10 | 250,000 |
| `Llama-3.3-8B-Instruct` | 10 | 250,000 |

La API es compatible con OpenAI — no se necesita una base URL personalizada.

::: tip Formato de la clave de API
Las claves de API de Meta comienzan con `LLM|` (por ejemplo, `LLM|953656...|8vKG-...`). Obtén una en [llama.com](https://llama.com/).
:::

::: warning Búsqueda semántica
La API de Meta no soporta embeddings. La búsqueda semántica no está disponible al usar Meta como tu proveedor de IA — Crow recurre automáticamente a la búsqueda por palabras clave (FTS5).
:::

### DashScope Coding Plan (Alibaba Cloud)

```env
AI_PROVIDER=openai
AI_API_KEY=sk-sp-...
AI_MODEL=qwen3.5-plus
AI_BASE_URL=https://coding-intl.dashscope.aliyuncs.com/v1
```

El DashScope Coding Plan te da acceso a modelos de Qwen, GLM, Kimi y MiniMax con una sola suscripción. Todos los modelos usan la misma clave de API y la misma base URL — solo cambia el nombre del modelo. Consulta la [guía del DashScope Coding Plan](/guide/dashscope-coding) para las instrucciones completas de configuración y los modelos disponibles.

### Z.AI Coding Plan (Zhipu AI)

```env
AI_PROVIDER=openai
AI_API_KEY=your-zai-key
AI_MODEL=glm-5
AI_BASE_URL=https://api.z.ai/api/coding/paas/v4
```

El Z.AI Coding Plan brinda acceso a la familia de modelos GLM (GLM-5, GLM-4.7 y más) mediante una suscripción mensual. Consulta la [guía del Z.AI Coding Plan](/guide/zai-coding) para las instrucciones completas de configuración y los modelos disponibles.

### Endpoint personalizado compatible con OpenAI

Cualquier API que implemente el formato Chat Completions de OpenAI funciona con el proveedor `openai` y una base URL personalizada:

```env
AI_PROVIDER=openai
AI_API_KEY=your-key
AI_MODEL=your-model
AI_BASE_URL=https://your-endpoint.com/v1
```

Esto funciona con vLLM, LM Studio, text-generation-webui y otros servidores compatibles con OpenAI.

## Variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `AI_PROVIDER` | Sí | Nombre del proveedor: `openai`, `anthropic`, `google`, `ollama`, `openrouter`, `meta` |
| `AI_API_KEY` | Depende | Clave de API (no se necesita para Ollama) |
| `AI_MODEL` | No | Nombre del modelo (usa el predeterminado del proveedor si está vacío) |
| `AI_BASE_URL` | No | Endpoint de API personalizado (para Ollama, OpenRouter o autoalojado) |

## Usar el Chat de IA

Una vez configurado, abre **Mensajes** en el Crow's Nest. La pestaña **AI Chat** aparece con:

- **Barra lateral de conversaciones** — Crea, cambia entre y elimina conversaciones
- **Área de chat** — Envía mensajes, ve las respuestas en streaming
- **Llamadas a herramientas** — Tarjetas expandibles que muestran cuándo la IA usa tus herramientas de Crow
- **Cancelar** — Detén una generación en progreso

La IA ve tus herramientas de Crow como un conjunto reducido de herramientas de categoría (`crow_memory`, `crow_projects`, `crow_blog`, `crow_sharing`, `crow_storage`, `crow_media`, más `crow_tools` para integraciones, `crow_discover` para consultar esquemas y herramientas explícitas de orquestación). Puede:

- Recordar tus memorias y almacenar nuevas
- Buscar y gestionar proyectos de investigación
- Crear y publicar publicaciones del blog
- Subir y gestionar archivos
- Enviar mensajes a contactos
- Descubrir las herramientas disponibles y sus esquemas

### Contexto de la conversación

Cada conversación envía a la IA el prompt de sistema (generado a partir de tu contexto crow.md) más los últimos 20 mensajes. Los resultados de las herramientas se truncan a 2000 caracteres para prevenir el desbordamiento de contexto. La IA puede hacer hasta 10 rondas de llamadas a herramientas por mensaje.

### Seguimiento de tokens

El total de tokens se rastrea por conversación y se muestra en la barra lateral. Esto te ayuda a monitorear los costos de uso de la API.

## Chat de IA vs plataformas externas

No tienes que elegir — funcionan en conjunto:

| Característica | Chat de IA (BYOAI) | Plataformas externas (Claude.ai, ChatGPT, etc.) |
|---|---|---|
| **Configuración** | Configura la clave de API en Configuración | Instala los servidores MCP de Crow en la plataforma |
| **Interfaz** | Dashboard del Crow's Nest | UI nativa de la plataforma |
| **Proveedor de IA** | Tu elección (cualquier proveedor soportado) | La IA integrada de la plataforma |
| **Acceso a herramientas** | Completo (todas las herramientas de Crow vía gateway) | Completo (todas las herramientas de Crow vía MCP) |
| **Datos compartidos** | Misma base de datos — ambos ven las mismas memorias | Misma base de datos |
| **Ideal para** | Interacciones rápidas desde el dashboard, IA gratuita/barata | Trabajo profundo, características específicas de la plataforma |

## Seguridad

- Las claves de API se almacenan en texto plano en tu archivo `.env` en tu dispositivo
- El Crow's Nest es privado por defecto (solo red local / Tailscale)
- Las conversaciones del chat se almacenan en tu base de datos SQLite local
- Los mensajes se envían a la API del proveedor de IA que elegiste — salen de tu máquina
- Para una operación totalmente local, usa Ollama — nada sale de tu red

## Búsqueda semántica

Cuando hay configurado un proveedor de embeddings, Crow mejora la búsqueda de memorias con **búsqueda semántica** — encontrando memorias por significado, no solo por palabras clave. Está activada por defecto (`semantic: true`) y se degrada con elegancia: si el proveedor de embeddings está fuera de línea, la búsqueda recurre automáticamente a la búsqueda de texto completo (FTS5) por palabras clave. No hace falta instalar software adicional.

### Requisitos

- Una entrada de proveedor de embeddings en `models.json` — funciona cualquier endpoint de embeddings compatible con OpenAI (un modelo de embeddings local en vLLM/llama.cpp, Ollama con `nomic-embed-text`, o un proveedor en la nube). Por defecto, Crow busca un proveedor llamado `grackle-embed`.
- Eso es todo — los embeddings se almacenan como BLOBs simples en la tabla `memory_embeddings` y se comparan dentro del propio proceso, lo cual es más que suficiente a la escala de una base de conocimiento personal.

### Cómo funciona

1. Cuando almacenas una memoria, Crow genera un vector de embedding a partir del contenido (de forma asíncrona — el almacenamiento nunca se bloquea por ello)
2. El vector se almacena en la tabla `memory_embeddings`
3. Cuando buscas, Crow compara el embedding de tu consulta contra los vectores almacenados y combina los resultados con la búsqueda por palabras clave para obtener lo mejor de ambos enfoques

## Bundle LocalAI

Para IA totalmente local (incluyendo embeddings), instala el bundle **LocalAI**:

```
crow bundle install localai
crow bundle start localai
```

Luego configura Crow para usarlo:
```env
AI_PROVIDER=openai
AI_BASE_URL=http://localhost:8080/v1
AI_MODEL=gpt-3.5-turbo
```

LocalAI provee una API compatible con OpenAI que corre completamente en tu hardware — ningún dato sale de tu red.

## Solución de problemas

### "No AI provider configured"
Define `AI_PROVIDER` en Configuración o en `.env`. Como mínimo necesitas el nombre del proveedor.

### "API key is invalid (401)"
Verifica tu `AI_API_KEY`. Para Anthropic, las claves comienzan con `sk-ant-`. Para OpenAI, `sk-`. Para Google, `AIza`. Para Meta, las claves comienzan con `LLM|`.

### "Model not found (404)"
El nombre del modelo es específico de cada proveedor. Revisa la documentación del proveedor para ver los modelos disponibles. Para Ollama, ejecuta `ollama pull <model>` primero.

### "Rate limited"
El proveedor está limitando las solicitudes. Espera un momento e intenta de nuevo, o mejora tu plan de API.

### Las llamadas a herramientas no funcionan
Algunos modelos (especialmente los modelos locales pequeños vía Ollama) no soportan llamadas a funciones/herramientas. Prueba un modelo que las soporte explícitamente: `llama3.1`, `gpt-4o`, `claude-sonnet-4-20250514`, `gemini-2.5-flash`.

### El campo del chat no responde
Revisa la consola del navegador en busca de errores. El chat usa Server-Sent Events (SSE) para el streaming — asegúrate de que tu red/proxy no almacene en búfer ni termine las conexiones SSE.
