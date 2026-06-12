# Qwen CLI

Conecta Crow a [Qwen Code](https://github.com/QwenLM/qwen-code), el agente de programación para terminal de Alibaba.

## Requisitos previos

- Node.js 18 o posterior
- Crow clonado y configurado localmente (para stdio) o un gateway desplegado (para remoto)
- Qwen CLI instalado y configurado

## Opción A: Local (stdio)

Ideal para desarrollo — ejecuta los servidores de Crow directamente en tu máquina. No requiere gateway ni red.

### Pasos de configuración

1. Clona y configura Crow:
   ```bash
   git clone https://github.com/kh0pper/crow.git
   cd crow
   npm run setup
   ```

2. Edita `~/.qwen/mcp.json` y agrega los servidores de Crow bajo `mcpServers`:
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
       },
       "crow-sharing": {
         "command": "node",
         "args": ["/path/to/crow/servers/sharing/index.js"],
         "env": {
           "CROW_DB_PATH": "/path/to/crow/data/crow.db"
         }
       },
       "crow-blog": {
         "command": "node",
         "args": ["/path/to/crow/servers/blog/index.js"],
         "env": {
           "CROW_DB_PATH": "/path/to/crow/data/crow.db"
         }
       },
       "crow-storage": {
         "command": "node",
         "args": ["/path/to/crow/servers/storage/index.js"],
         "env": {
           "CROW_DB_PATH": "/path/to/crow/data/crow.db",
           "MINIO_ENDPOINT": "localhost",
           "MINIO_PORT": "9000",
           "MINIO_ACCESS_KEY": "your-access-key",
           "MINIO_SECRET_KEY": "your-secret-key"
         }
       }
     }
   }
   ```

   Reemplaza `/path/to/crow` con la ruta absoluta donde clonaste Crow. Omite `crow-storage` si no estás ejecutando MinIO.

3. Reinicia Qwen CLI — detectará los servidores MCP automáticamente.

### Transporte

- **Tipo**: stdio
- **Autenticación**: Ninguna (proceso local)

### Servidor combinado (huella más ligera)

Si prefieres un único punto de entrada en lugar de cinco servidores separados, usa el servidor combinado `crow-core`. Inicia con las herramientas de memoria activas y carga los demás servidores bajo demanda:

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

- Gateway de Crow desplegado y accesible ([Guía de despliegue en la nube](/es/getting-started/cloud-deploy) o [Configuración de Tailscale](/es/getting-started/tailscale-setup))

### Pasos de configuración

1. Edita `~/.qwen/mcp.json`:
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

   Para un gateway accesible por Tailscale, usa la dirección de Tailscale en su lugar:
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

2. En el primer uso, Qwen CLI abrirá el flujo de OAuth en tu navegador para autorizar.

### Transporte

- **Tipo**: Streamable HTTP
- **Protocolo**: `2025-03-26`
- **Autenticación**: OAuth 2.1 (descubrimiento automático)

## Verificación

Inicia Qwen CLI y pide:

```
Guarda un recuerdo de que Qwen CLI está conectado a Crow.
```

Luego verifica que se guardó:

```
Busca en mis recuerdos "Qwen".
```

## Contexto multiplataforma

Crow entrega automáticamente contexto de comportamiento cuando Qwen CLI se conecta vía MCP — los protocolos de memoria, la gestión de sesiones y las reglas de transparencia están activos desde el primer mensaje.

Para obtener orientación más detallada, pídele a Qwen que use los prompts de MCP: `session-start`, `crow-guide`, `project-guide`, `blog-guide` o `sharing-guide`.

Los recuerdos y proyectos almacenados a través de Qwen CLI están disponibles de inmediato en todas las demás plataformas conectadas. Consulta la [Guía multiplataforma](/es/guide/cross-platform).

## Consejos

- Qwen CLI usa `~/.qwen/mcp.json` para la configuración global de MCP
- Ejecuta `npm run mcp-config` en el directorio de Crow para generar una configuración completa, y luego copia las entradas relevantes a `~/.qwen/mcp.json`
- El servidor `crow-storage` requiere MinIO; omítelo si no usas almacenamiento de archivos
- Para aislamiento por proyecto, coloca un `mcp.json` en un directorio `.qwen/` en la raíz de tu proyecto
