# Gemini

Conecta Crow a Gemini de Google — tanto la Gemini CLI como Gemini en Google AI Studio/Enterprise.

## Gemini CLI — Local (stdio)

Ideal para desarrollo — ejecuta los servidores de Crow directamente en tu máquina. No requiere gateway.

### Pasos de configuración

1. Clona y configura Crow localmente:
   ```bash
   git clone https://github.com/kh0pper/crow.git
   cd crow
   npm run setup
   ```

2. Edita `~/.gemini/settings.json`:
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

3. Reinicia la Gemini CLI — detectará los servidores MCP automáticamente.

::: tip
Ejecuta `npm run mcp-config` en el directorio de Crow para generar una configuración MCP completa, y luego copia las entradas relevantes a tu configuración de Gemini.
:::

## Gemini CLI — Remoto (HTTP)

Conéctate a un gateway de Crow desplegado para acceder a la plataforma completa, incluyendo integraciones externas.

### Requisitos previos

- Gateway de Crow desplegado y funcionando ([guía de Primeros pasos](/es/getting-started/))

### Pasos de configuración

1. Edita `~/.gemini/settings.json`:
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

2. Inicia la Gemini CLI — descubrirá automáticamente los metadatos de OAuth y te pedirá la autorización.

## Google AI Studio

Google AI Studio admite servidores MCP para el uso de herramientas en el chat. La configuración está disponible en la interfaz al crear un nuevo chat o agente.

### Pasos de configuración

1. Abre [Google AI Studio](https://aistudio.google.com)
2. Crea un nuevo chat o agente
3. En la sección de herramientas, agrega un servidor MCP
4. Ingresa la URL de Streamable HTTP:
   ```
   https://your-crow-server/memory/mcp
   ```
5. Completa el flujo de autorización de OAuth

## Configuración local / autoalojada

Si ejecutas el gateway de Crow en tu propia máquina, puedes exponerlo a Gemini usando [Tailscale Funnel](/es/getting-started/tailscale-setup). Una vez que Funnel esté habilitado en la máquina que ejecuta el gateway, la URL de tu endpoint MCP será:

```
https://<hostname>.<tailnet>.ts.net/memory/mcp
```

Reemplaza `<hostname>` y `<tailnet>` con el nombre de tu máquina en Tailscale y el dominio de tu tailnet. Usa el mismo patrón de URL para los demás servidores (`/projects/mcp`, `/router/mcp`, etc.). Los pasos de configuración son idénticos a las instrucciones remotas de arriba — solo sustituye `your-crow-server` por tu URL de Funnel en la configuración de Gemini.

Consulta la [guía de configuración de Tailscale](/es/getting-started/tailscale-setup) para todos los detalles de configuración.

## Transporte

- **Tipo**: Streamable HTTP
- **Protocolo**: `2025-03-26`
- **Autenticación**: OAuth 2.1 (descubrimiento automático)

## Contexto multiplataforma

Crow entrega automáticamente contexto de comportamiento cuando Gemini se conecta — los protocolos de memoria, la gestión de sesiones y las reglas de transparencia están activos desde el primer mensaje. No se requiere carga manual.

Para obtener orientación detallada, Gemini puede solicitar prompts de MCP como `session-start`, `crow-guide` (con `platform: "gemini"`) o las guías de funciones específicas (`research-guide`, `blog-guide`, `sharing-guide`).

También puedes cargar manualmente el contexto completo:

> "Usa la herramienta crow_get_context con platform configurado como gemini"

Los recuerdos y proyectos almacenados desde cualquier plataforma se comparten. Consulta la [Guía multiplataforma](/es/guide/cross-platform).

## Verificación

Pregúntale a Gemini:

> "Guarda un recuerdo de que Gemini está conectado a Crow."

Luego verifica:

> "Busca en mis recuerdos 'Gemini'."
