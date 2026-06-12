# Cline

Conecta Crow a [Cline](https://github.com/cline/cline), la extensión de VS Code de asistencia de programación con IA.

## Opción A: Local (stdio)

### Pasos de configuración

1. Clona y configura Crow:
   ```bash
   git clone https://github.com/kh0pper/crow.git
   cd crow
   npm run setup
   ```

2. En el panel de Cline, haz clic en el icono **MCP Servers** (barra de herramientas) → **Configure** → **Configure MCP Servers**. Esto abre el archivo de configuración MCP de Cline (`cline_mcp_settings.json`, almacenado bajo el directorio `globalStorage/saoudrizwan.claude-dev/settings/` de VS Code). Agrega:
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

3. Recarga VS Code.

## Opción B: Remoto (HTTP)

### Pasos de configuración

1. Despliega Crow ([guía de Primeros pasos](/es/getting-started/))

2. En el panel de Cline, abre **MCP Servers** → **Remote Servers** y agrega el nombre del servidor + la URL, o edita `cline_mcp_settings.json` (vía **Configure** → **Configure MCP Servers**):
   ```json
   {
     "mcpServers": {
       "crow-memory": {
         "url": "https://your-crow-server/memory/mcp"
       },
       "crow-projects": {
         "url": "https://your-crow-server/projects/mcp"
       },
       "crow-tools": {
         "url": "https://your-crow-server/tools/mcp"
       }
     }
   }
   ```

3. Cline gestionará OAuth en la primera conexión.

## Transporte

- **Local**: stdio
- **Remoto**: Streamable HTTP con OAuth 2.1

## Contexto multiplataforma

Crow entrega automáticamente contexto de comportamiento cuando Cline se conecta — los protocolos de memoria y la gestión de sesiones están activos desde el primer mensaje.

Las plataformas IDE reciben una salida de transparencia mínima. Los prompts de MCP (`session-start`, `crow-guide`, etc.) están disponibles para una orientación más profunda. Los recuerdos almacenados desde Cline se comparten con todas las demás plataformas conectadas. Consulta la [Guía multiplataforma](/es/guide/cross-platform).

## Verificación

En el chat de Cline, prueba:

> "Guarda un recuerdo de que Cline está conectado a Crow."
