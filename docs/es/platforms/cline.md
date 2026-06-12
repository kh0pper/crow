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

2. Abre la Configuración de VS Code → busca "Cline MCP" → edita la configuración del servidor MCP, o crea `~/.cline/mcp_config.json`:
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

1. Despliega Crow ([Guía de despliegue en la nube](/es/getting-started/cloud-deploy))

2. Agrega a la configuración MCP de Cline:
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
