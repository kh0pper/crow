# ChatGPT

Conecta Crow a ChatGPT mediante el transporte SSE. ChatGPT admite MCP a través de su función de Apps/Connectors.

## Requisitos previos

- Gateway de Crow desplegado y funcionando ([Guía de despliegue en la nube](/es/getting-started/cloud-deploy))
- Un plan ChatGPT Plus o Team

## Pasos de configuración

1. Ve a [Configuración de ChatGPT](https://chat.openai.com/settings) → **Apps** (o **Connectors**)
2. Haz clic en **Create** o **Add MCP Server**
3. Ingresa la URL del endpoint SSE de Crow:
   ```
   https://your-crow-server/memory/sse
   ```
4. ChatGPT descubrirá los metadatos de OAuth e iniciará la autorización
5. Autoriza la conexión cuando se te solicite

Repite el proceso para servidores adicionales:

| Servidor | URL SSE |
|---|---|
| Memory | `https://your-crow-server/memory/sse` |
| Projects | `https://your-crow-server/projects/sse` |
| External Tools | `https://your-crow-server/tools/sse` |

## Transporte

- **Tipo**: SSE (Server-Sent Events)
- **Protocolo**: `2024-11-05`
- **Autenticación**: OAuth 2.1 (descubrimiento automático)

::: tip Importante
ChatGPT utiliza el transporte **SSE**, no Streamable HTTP. Usa los endpoints `/sse`, no los endpoints `/mcp`.
:::

## Verificación

Después de conectar, prueba preguntándole a ChatGPT:

> "Usa la herramienta de memoria para guardar que ChatGPT está conectado a Crow."

Luego verifica:

> "Busca en mis recuerdos 'ChatGPT'."

## Contexto multiplataforma

Crow entrega automáticamente contexto de comportamiento cuando ChatGPT se conecta. Durante el handshake de MCP, ChatGPT recibe la identidad de Crow, los protocolos de memoria, el protocolo de sesión y las reglas de transparencia, sin necesidad de configuración manual.

Esto significa que ChatGPT sabe cómo recuperar recuerdos relevantes al inicio de cada conversación y almacenar información importante de forma automática.

Para obtener orientación más detallada, ChatGPT puede solicitar prompts de MCP:

- **session-start** — Protocolo detallado de inicio y cierre de sesión
- **crow-guide** — Documento completo de crow.md (usa con `platform: "chatgpt"` para formato específico de ChatGPT)
- **research-guide** / **blog-guide** / **sharing-guide** — Guías de flujo de trabajo para funciones específicas

También puedes cargar manualmente el contexto completo:

> "Usa la herramienta crow_get_context con platform configurado como chatgpt"

O accede mediante HTTP:

```
GET https://your-crow-server/crow.md?platform=chatgpt
```

Cualquier recuerdo que almacenes en ChatGPT estará disponible instantáneamente desde Claude, Gemini o cualquier otra plataforma conectada. Consulta la [Guía multiplataforma](/es/guide/cross-platform) para más detalles.

## Optimización de contexto

ChatGPT se conecta a través del gateway. Si tienes muchas integraciones habilitadas, considera usar el endpoint `/router/mcp` en lugar de conectar cada servidor individualmente. El router consolida más de 126 herramientas en 10 herramientas de categoría, lo que reduce el uso de la ventana de contexto:

```
https://your-crow-server/router/sse
```

Consulta la guía de [Contexto y rendimiento](/es/guide/context-performance) para más detalles.

## Limitaciones

- El soporte de MCP en ChatGPT puede variar según el plan y la región
- El transporte SSE es un protocolo legacy pero es completamente funcional
- El comportamiento de llamadas a herramientas puede diferir ligeramente del de Claude
