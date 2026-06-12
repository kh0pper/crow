# Claude Code (CLI)

Conecta Crow a [Claude Code](https://docs.anthropic.com/en/docs/claude-code), la herramienta CLI de Anthropic para usar Claude en la terminal.

## Opción A: Local (stdio)

Ideal para desarrollo: ejecuta los servidores de Crow directamente en tu máquina.

### Pasos de configuración

1. Clona y configura Crow localmente:
   ```bash
   git clone https://github.com/kh0pper/crow.git
   cd crow
   npm run setup
   ```

2. Agrega la configuración al archivo `.mcp.json` de tu proyecto (por proyecto) o a `~/.claude/mcp.json` (global):
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

3. Reinicia Claude Code: detectará automáticamente los servidores MCP.

### Transporte

- **Tipo**: stdio
- **Autenticación**: Ninguna (proceso local)

## Opción B: Remoto (HTTP)

Conéctate a un gateway de Crow desplegado para acceder a la plataforma completa, incluyendo integraciones externas.

### Pasos de configuración

1. Despliega Crow ([Guía de despliegue en la nube](/es/getting-started/cloud-deploy))

2. Agrega la configuración a `.mcp.json`:
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

3. En el primer uso, Claude Code abrirá el flujo de OAuth en tu navegador para autorizar la conexión.

### Transporte

- **Tipo**: Streamable HTTP
- **Autenticación**: OAuth 2.1 (automática)

## Verificación

Inicia Claude Code y prueba:

```
> Guarda un recuerdo de que Claude Code está conectado a Crow
```

Verifica que funcionó:

```
> ¿Qué recuerdas?
```

## Contexto multiplataforma

Crow entrega automáticamente contexto de comportamiento cuando Claude Code se conecta vía MCP: los protocolos de memoria, la gestión de sesiones y las reglas de transparencia están activos desde el primer mensaje.

Los usuarios de Claude Code también tienen acceso a los archivos de skills en `skills/` y al archivo `CLAUDE.md` del proyecto, que proporcionan orientación adicional específica de la plataforma más allá de lo que entregan las instrucciones de MCP.

Para obtener orientación detallada vía MCP, usa los prompts: `session-start`, `crow-guide`, `research-guide`, `blog-guide`, `sharing-guide`. O usa `crow_get_context` con `platform: "claude"`. Los recuerdos almacenados a través de Claude Code se comparten con todas las demás plataformas conectadas. Consulta la [Guía multiplataforma](/es/guide/cross-platform).

::: tip ¿Ya configuraste Crow en claude.ai?
Si agregaste Crow como Integración Personalizada en claude.ai, esos servidores MCP también están disponibles en Claude Code CLI sin configuración adicional: el ecosistema de Anthropic comparte la configuración de conectores entre los productos de Claude. No es necesario duplicar la configuración en `.mcp.json`. Este comportamiento compartido es específico de Claude; otras plataformas (ChatGPT, Gemini) gestionan sus conexiones MCP de forma independiente.
:::

## Consejos

- Usa el archivo `.mcp.json` a nivel de proyecto para compartir la configuración de Crow con tu equipo
- Usa `~/.claude/mcp.json` para acceso global en todos los proyectos
- El repositorio de Crow incluye un `.mcp.json` con todos los servidores MCP preconfigurados
