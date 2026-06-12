# Qwen Coder CLI

Conecta Crow a [Qwen Coder CLI](https://github.com/QwenLM/qwen-coder-cli), el asistente de programación para terminal del equipo Qwen de Alibaba.

## Opción A: Local (stdio)

Ideal para desarrollo — ejecuta los servidores de Crow directamente en tu máquina.

### Pasos de configuración

1. Clona y configura Crow localmente:
   ```bash
   git clone https://github.com/kh0pper/crow.git
   cd crow
   npm run setup
   ```

2. Agrega la configuración al archivo `.qwen/mcp.json` de tu proyecto o a `~/.qwen/mcp.json` (global):
   ```json
   {
     "mcpServers": {
       "crow-memory": {
         "command": "node",
         "args": ["/path/to/crow/servers/memory/index.js"],
         "env": {
           "CROW_DB_PATH": "/path/to/crow/data/crow.db"
         }
       },
       "crow-projects": {
         "command": "node",
         "args": ["/path/to/crow/servers/research/index.js"],
         "env": {
           "CROW_DB_PATH": "/path/to/crow/data/crow.db"
         }
       }
     }
   }
   ```

3. Reinicia Qwen Coder CLI — detectará los servidores MCP automáticamente.

::: tip
Ejecuta `npm run mcp-config` en el directorio de Crow para generar una configuración MCP completa. Copia las entradas relevantes a tu archivo de configuración de Qwen.
:::

### Transporte

- **Tipo**: stdio
- **Autenticación**: Ninguna (proceso local)

## Opción B: Remoto (HTTP)

Conéctate a un gateway de Crow desplegado para acceder a la plataforma completa.

### Requisitos previos

- Gateway de Crow desplegado y en buen estado ([Guía de despliegue en la nube](/es/getting-started/cloud-deploy))

### Pasos de configuración

1. Agrega la configuración a `.qwen/mcp.json`:
   ```json
   {
     "mcpServers": {
       "crow-memory": {
         "type": "url",
         "url": "https://your-crow-server/memory/mcp"
       },
       "crow-projects": {
         "type": "url",
         "url": "https://your-crow-server/projects/mcp"
       },
       "crow-tools": {
         "type": "url",
         "url": "https://your-crow-server/tools/mcp"
       }
     }
   }
   ```

2. En el primer uso, Qwen Coder CLI abrirá el flujo de OAuth para autorizar.

### Transporte

- **Tipo**: Streamable HTTP
- **Protocolo**: `2025-03-26`
- **Autenticación**: OAuth 2.1 (descubrimiento automático)

## Contexto multiplataforma

Crow entrega automáticamente contexto de comportamiento cuando Qwen Coder se conecta — los protocolos de memoria, la gestión de sesiones y las reglas de transparencia están activos desde el primer mensaje.

Para obtener orientación detallada, usa los prompts de MCP: `session-start`, `crow-guide`, `project-guide`, `blog-guide`, `sharing-guide`. Los recuerdos almacenados desde cualquier plataforma se comparten. Consulta la [Guía multiplataforma](/es/guide/cross-platform).

## Verificación

Inicia Qwen Coder CLI y prueba:

> "Guarda un recuerdo de que Qwen Coder está conectado a Crow."

Luego verifica:

> "Busca en los recuerdos 'Qwen'."

## Consejos

- Usa el archivo `.qwen/mcp.json` a nivel de proyecto para compartir la configuración con tu equipo
- Usa `~/.qwen/mcp.json` para acceso global en todos los proyectos
- Qwen Coder sigue un formato de configuración al estilo `.mcp.json`, similar al de Claude Code
