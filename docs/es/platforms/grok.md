# Grok (xAI)

Conecta Crow a Grok de xAI usando su soporte de Remote MCP Tools.

## Requisitos previos

- Gateway de Crow desplegado y funcionando ([guía de Primeros pasos](/es/getting-started/))
- Una cuenta de API de xAI

Cualquiera de las dos rutas requiere que tu gateway de Crow sea accesible desde la internet pública (los servidores de xAI lo llaman directamente) — un gateway accesible solo por Tailscale no funcionará con Grok. Recuerda las [reglas de exposición de red](https://github.com/kh0pper/crow/blob/main/SECURITY.md#whats-public-by-default) antes de exponer endpoints MCP públicamente.

## Opción A: Connectors de grok.com (interfaz de consumidor)

1. Ve a **grok.com → Connectors → Custom** y agrega un conector MCP personalizado.
2. Ingresa la URL de tu servidor MCP de Crow (p. ej. `https://your-crow-server/router/mcp`).
3. Completa la autorización OAuth cuando se te solicite — el gateway de Crow soporta el flujo OAuth 2.1 que usa Connectors.

## Opción B: API de xAI — Remote MCP Tools

Declara Crow como una entrada MCP en el arreglo `tools` de tu solicitud a la API:

```json
{
  "tools": [
    {
      "type": "mcp",
      "server_url": "https://your-crow-server/router/mcp",
      "server_label": "crow",
      "authorization": "YOUR_ACCESS_TOKEN"
    }
  ]
}
```

El valor de `authorization` se envía a Crow como un encabezado `Bearer`. Para generar un token, registra un cliente mediante el endpoint `/register` del gateway y completa el flujo de OAuth para obtener un token de acceso (consulta [OAuth 2.1](/es/architecture/gateway)). Campos opcionales: `server_description`, `allowed_tools`, `headers`.

## Transporte

- **Tipo**: Streamable HTTP (o SSE)
- **Protocolo**: `2025-03-26`
- **Autenticación**: OAuth 2.1 (Connectors) o Bearer vía el campo `authorization` (API)

## Contexto multiplataforma

Crow entrega automáticamente contexto de comportamiento cuando Grok se conecta — los protocolos de memoria, la gestión de sesiones y las reglas de transparencia están activos desde el primer mensaje.

Para obtener orientación detallada, Grok puede solicitar prompts de MCP como `session-start`, `crow-guide` (con `platform: "grok"`) o las guías de funciones específicas.

También puedes cargar manualmente el contexto completo:

> "Usa la herramienta crow_get_context con platform configurado como grok"

O accede mediante HTTP: `GET https://your-crow-server/crow.md?platform=grok`

Los recuerdos y proyectos almacenados desde cualquier plataforma se comparten. Consulta la [Guía multiplataforma](/es/guide/cross-platform).

## Verificación

Usa las llamadas a herramientas de Grok para probar:

> "Usa la herramienta crow_store_memory para guardar que Grok está conectado."
