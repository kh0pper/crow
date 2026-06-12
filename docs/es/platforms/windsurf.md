# Windsurf

Conecta Crow a [Windsurf](https://devin.ai/desktop) — el IDE impulsado por IA creado originalmente por Codeium, ahora **Devin Desktop** de Cognition (las instalaciones, planes y configuraciones existentes de Windsurf se conservan; las rutas de configuración de abajo no cambian).

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

1. Despliega Crow ([guía de Primeros pasos](/es/getting-started/))

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
