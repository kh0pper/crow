# Qwen Code

Conecta Crow a [Qwen Code](https://github.com/QwenLM/qwen-code), el agente de programación para terminal `qwen` del equipo Qwen de Alibaba. (Versiones anteriores de esta documentación lo cubrían en dos páginas como "Qwen CLI" y "Qwen Coder CLI" — es una sola herramienta, y esta es su página.)

## Requisitos previos

- Node.js 18 o posterior
- Qwen Code instalado y configurado
- Crow clonado y configurado localmente (para stdio) o un gateway desplegado (para remoto)

## Opción A: Local (stdio)

Ideal para desarrollo — ejecuta los servidores de Crow directamente en tu máquina. No requiere gateway ni red.

### Pasos de configuración

1. Clona y configura Crow:
   ```bash
   git clone https://github.com/kh0pper/crow.git
   cd crow
   npm run setup
   ```

2. Agrega los servidores de Crow al archivo `.qwen/mcp.json` de tu proyecto o a `~/.qwen/mcp.json` (global), bajo `mcpServers`:
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

   Reemplaza `/path/to/crow` con la ruta absoluta donde clonaste Crow.

3. Reinicia Qwen Code — detectará los servidores MCP automáticamente.

::: tip
Ejecuta `npm run mcp-config` en el directorio de Crow para generar una configuración MCP completa que cubre todos los servidores disponibles (sharing, blog, storage, …). Copia las entradas relevantes a tu archivo de configuración de Qwen.
:::

### Transporte

- **Tipo**: stdio
- **Autenticación**: Ninguna (proceso local)

### Servidor combinado (huella más ligera)

Si prefieres un único punto de entrada en lugar de servidores separados, usa el servidor combinado `crow-core`. Inicia con las herramientas de memoria activas y carga los demás servidores bajo demanda:

```json
{
  "mcpServers": {
    "crow-core": {
      "command": "node",
      "args": ["/path/to/crow/servers/core/index.js"],
      "env": {
        "CROW_DB_PATH": "/path/to/crow/data/crow.db"
      }
    }
  }
}
```

O genera la configuración automáticamente:

```bash
cd /path/to/crow
npm run mcp-config -- --combined
```

Luego copia la entrada `crow-core` del `.mcp.json` generado a `~/.qwen/mcp.json`.

## Opción B: Gateway (HTTP)

Conéctate a un gateway de Crow desplegado para acceso remoto — útil para configuraciones con Tailscale o despliegues en la nube.

### Requisitos previos

- Gateway de Crow desplegado y accesible ([Primeros pasos](/es/getting-started/) o [Configuración de Tailscale](/es/getting-started/tailscale-setup))

### Pasos de configuración

1. Edita `.qwen/mcp.json` (proyecto) o `~/.qwen/mcp.json` (global):
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

   Para un gateway accesible por Tailscale, usa la dirección de Tailscale — y considera el [endpoint del router](/es/guide/context-performance) para una superficie de herramientas mucho más pequeña:
   ```json
   {
     "mcpServers": {
       "crow": {
         "type": "url",
         "url": "http://100.x.x.x:3001/router/mcp"
       }
     }
   }
   ```

2. En el primer uso, Qwen Code abrirá el flujo de OAuth en tu navegador para autorizar.

### Transporte

- **Tipo**: Streamable HTTP
- **Protocolo**: `2025-03-26`
- **Autenticación**: OAuth 2.1 (descubrimiento automático)

## Verificación

Inicia Qwen Code y pide:

```
Guarda un recuerdo de que Qwen Code está conectado a Crow.
```

Luego verifica que se guardó:

```
Busca en mis recuerdos "Qwen".
```

## Contexto multiplataforma

Crow entrega automáticamente contexto de comportamiento cuando Qwen Code se conecta vía MCP — los protocolos de memoria, la gestión de sesiones y las reglas de transparencia están activos desde el primer mensaje.

Para obtener orientación más detallada, pídele a Qwen que use los prompts de MCP: `session-start`, `crow-guide`, `project-guide`, `blog-guide` o `sharing-guide`.

Los recuerdos y proyectos almacenados a través de Qwen Code están disponibles de inmediato en todas las demás plataformas conectadas. Consulta la [Guía multiplataforma](/es/guide/cross-platform).

## Consejos

- Usa el archivo `.qwen/mcp.json` a nivel de proyecto para compartir la configuración con tu equipo; `~/.qwen/mcp.json` aplica globalmente en todos los proyectos
- Ejecuta `npm run mcp-config` en el directorio de Crow para generar una configuración completa, y luego copia las entradas relevantes
- El servidor `crow-storage` requiere MinIO — consulta la [Guía de almacenamiento](/es/guide/storage) para la configuración y las variables de entorno que necesita
- Qwen Code sigue un formato de configuración al estilo `.mcp.json`, similar al de Claude Code
