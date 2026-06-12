# Windsurf

Conecta Crow a [Windsurf](https://codeium.com/windsurf), el IDE impulsado por IA de Codeium.

## Opción A: Local (stdio)

### Pasos de configuración

1. Clona y configura Crow:
   ```bash
   git clone https://github.com/kh0pper/crow.git
   cd crow
   npm run setup
   ```

2. Edita `~/.codeium/windsurf/mcp_config.json`:
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

3. Reinicia Windsurf.

## Opción B: Remoto (HTTP)

### Pasos de configuración

1. Despliega Crow ([Guía de despliegue en la nube](/es/getting-started/cloud-deploy))

2. Edita `~/.codeium/windsurf/mcp_config.json`:
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

3. Windsurf gestionará OAuth automáticamente al conectarse.

## Transporte

- **Local**: stdio
- **Remoto**: Streamable HTTP con OAuth 2.1

## Contexto multiplataforma

Crow entrega automáticamente contexto de comportamiento cuando Windsurf se conecta — los protocolos de memoria y la gestión de sesiones están activos desde el primer mensaje.

Las plataformas IDE reciben una salida de transparencia mínima. Los prompts de MCP (`session-start`, `crow-guide`, etc.) están disponibles para una orientación más profunda. Los recuerdos almacenados desde Windsurf se comparten con todas las demás plataformas conectadas. Consulta la [Guía multiplataforma](/es/guide/cross-platform).

## Verificación

En el chat Cascade de Windsurf, prueba:

> "Guarda un recuerdo de que Windsurf está conectado a Crow."
