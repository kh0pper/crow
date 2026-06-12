# Claude Desktop

Conecta Crow a Claude Desktop usando el transporte stdio local. Esto ejecuta los servidores MCP directamente en tu máquina — no se necesita despliegue en la nube.

## Requisitos previos

- [Claude Desktop](https://claude.ai/download) instalado
- Crow clonado y configurado localmente ([Guía de configuración de escritorio](/es/getting-started/desktop-setup))

## Pasos de configuración

1. Ejecuta el generador de configuración:
   ```bash
   cd crow
   npm run desktop-config
   ```

2. Copia el JSON resultante en tu archivo de configuración de Claude Desktop:
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
   - **Linux**: `~/.config/Claude/claude_desktop_config.json`

3. Reinicia Claude Desktop

La configuración se verá algo así:
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

## Transporte

- **Tipo**: stdio (proceso directo)
- **Autenticación**: No se necesita (proceso local)

## Verificación

Después de reiniciar Claude Desktop, busca los íconos de servidores MCP (ícono de martillo) en el área de entrada. Haz clic en ellos para ver las herramientas disponibles.

Prueba: "Guarda un recuerdo de que Crow Desktop está conectado."

## Contexto multiplataforma

Crow entrega automáticamente contexto de comportamiento cuando Claude Desktop se conecta vía MCP — los protocolos de memoria, la gestión de sesiones y las reglas de transparencia están activos desde el primer mensaje. No se requiere carga manual.

Para obtener orientación más profunda, Claude Desktop puede usar los prompts de MCP: `session-start`, `crow-guide`, `research-guide`, `blog-guide`, `sharing-guide`.

También puedes cargar manualmente el contexto completo:

> "Carga tu contexto de crow.md"

Los recuerdos almacenados en Claude Desktop se comparten con todas las demás plataformas conectadas (Claude Web, ChatGPT, Gemini, etc.) cuando se usa la misma base de datos. Consulta la [Guía multiplataforma](/es/guide/cross-platform).

## Agregar integraciones externas

Para usar integraciones externas (GitHub, Slack, etc.) con Claude Desktop, agrégalas directamente a la configuración de Desktop. El archivo `.mcp.json` del repositorio de Crow tiene todas las configuraciones — combínalas en tu archivo de configuración de Desktop.

Necesitarás reemplazar las referencias `${VAR_NAME}` con valores reales o definirlas como variables de entorno.
