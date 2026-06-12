# Cursor

Conecta Crow a [Cursor](https://cursor.com), el editor de código impulsado por IA.

## Opción A: Local (stdio)

Ejecuta los servidores de Crow localmente para una integración directa.

### Pasos de configuración

1. Clona y configura Crow:
   ```bash
   git clone https://github.com/kh0pper/crow.git
   cd crow
   npm run setup
   ```

2. Crea `.cursor/mcp.json` en la raíz de tu proyecto:
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

3. Reinicia Cursor para cargar los servidores MCP.

## Opción B: Remoto (HTTP)

Conéctate a un gateway de Crow desplegado.

### Pasos de configuración

1. Despliega Crow ([guía de Primeros pasos](/es/getting-started/))

2. Crea `.cursor/mcp.json`:
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

3. Cursor gestionará el flujo de OAuth automáticamente.

## Transporte

- **Local**: stdio
- **Remoto**: Streamable HTTP con OAuth 2.1

## Contexto multiplataforma

Crow entrega automáticamente contexto de comportamiento cuando Cursor se conecta — los protocolos de memoria y la gestión de sesiones están activos desde el primer mensaje.

Las plataformas IDE reciben una salida de transparencia mínima — solo checkpoints de Tier 2. Los prompts de MCP (`session-start`, `crow-guide`, etc.) están disponibles para una orientación más profunda. Los recuerdos y proyectos almacenados desde Cursor se comparten con todas las demás plataformas conectadas. Consulta la [Guía multiplataforma](/es/guide/cross-platform).

## Optimización de contexto

Cursor usa el transporte stdio localmente. Para una configuración más ligera, `crow-core` proporciona un único punto de entrada combinado que activa los servidores bajo demanda en lugar de ejecutarlos todos simultáneamente. Genera una configuración combinada con:

```bash
npm run mcp-config -- --combined
```

Esto crea una única entrada `crow-core` en `.mcp.json` en lugar de entradas separadas para cada servidor. Para despliegues remotos, el endpoint `/router/mcp` ofrece una consolidación similar. Consulta la guía de [Contexto y rendimiento](/es/guide/context-performance) para más detalles.

## Verificación

En el chat de IA de Cursor, prueba:

> "Guarda un recuerdo de que Cursor está conectado a Crow."
