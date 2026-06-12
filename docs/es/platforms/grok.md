# Grok (xAI)

Conecta Crow a Grok de xAI usando su soporte de Remote MCP Tools.

## Requisitos previos

- Gateway de Crow desplegado y funcionando ([Guía de despliegue en la nube](/es/getting-started/cloud-deploy))
- Una cuenta de API de xAI

## Pasos de configuración

Grok admite servidores MCP remotos a través de su API. Configura Crow como una fuente de herramientas remota:

1. En tu configuración de Grok/xAI, agrega un servidor MCP remoto:
   ```json
   {
     "mcp_servers": [
       {
         "url": "https://your-crow-server/memory/mcp",
         "name": "crow-memory"
       },
       {
         "url": "https://your-crow-server/projects/mcp",
         "name": "crow-projects"
       },
       {
         "url": "https://your-crow-server/tools/mcp",
         "name": "crow-tools"
       }
     ]
   }
   ```

2. Si usas OAuth, el cliente deberá completar el flujo de autorización. Si usas tokens bearer, puedes generar un token mediante el flujo de OAuth del gateway y pasarlo directamente.

## Transporte

- **Tipo**: Streamable HTTP
- **Protocolo**: `2025-03-26`
- **Autenticación**: OAuth 2.1 o token Bearer

## Uso de tokens Bearer

Si tu cliente de Grok no admite el descubrimiento de OAuth, puedes:

1. Registrar un cliente manualmente mediante el endpoint `/register`
2. Completar el flujo de OAuth para obtener un token de acceso
3. Pasar el token como encabezado `Bearer` en las solicitudes

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
