# Crear integraciones

Esta guía explica cómo agregar a Crow una nueva integración con un servicio externo.

## ¿Qué es una integración?

Una integración conecta Crow con un servicio externo (p. ej., Gmail, Trello, Slack) vía un servidor MCP. La mayoría de las integraciones usan paquetes npm existentes — los configuras y escribes un archivo de skill que le enseña a la IA cómo usarlos.

## Paso 1: Encuentra o construye un servidor MCP

Busca un paquete de servidor MCP existente:
- [MCP Server Registry](https://github.com/modelcontextprotocol/servers)
- npm: busca `mcp-server-<service>`

Si no existe ningún paquete, puedes construir uno usando el paquete `@modelcontextprotocol/sdk`.

## Paso 2: Agrégala al registro de integraciones

Agrega una entrada en `servers/gateway/integrations.js`:

```js
{
  id: "your-service",
  name: "Your Service",
  description: "Brief description of what this integration does",
  npmPackage: "@scope/mcp-server-your-service",
  envVars: [
    {
      name: "YOUR_SERVICE_API_KEY",
      description: "API key from Your Service",
      helpUrl: "https://yourservice.com/api-keys"
    }
  ],
  command: "npx",
  args: ["-y", "@scope/mcp-server-your-service"],
}
```

## Paso 3: Agrégala a .mcp.json

Agrega la configuración del servidor MCP:

```json
{
  "your-service": {
    "command": "npx",
    "args": ["-y", "@scope/mcp-server-your-service"],
    "env": {
      "YOUR_SERVICE_API_KEY": "${YOUR_SERVICE_API_KEY}"
    }
  }
}
```

## Paso 4: Actualiza .env.example

Agrega tus variables de entorno:

```
YOUR_SERVICE_API_KEY=         # Clave de API de https://yourservice.com/api-keys
```

## Paso 5: Crea un archivo de skill

Crea `skills/your-service.md` siguiendo la plantilla de skills:

```markdown
# Your Service Skill

## Description
What this integration enables.

## When to Use
- Trigger phrases and conditions

## Tools Available
- List the MCP tools provided

## Workflow: Main Use Case
1. Step-by-step workflow
2. Including which tools to call
3. And what to store in memory

## Best Practices
- Configuration tips
- Common pitfalls
```

## Paso 6: Agrega la fila de disparadores

Agrega una fila a la tabla de disparadores en `skills/superpowers.md`:

```
| "your service", "keyword" | "tu servicio", "palabra clave" | your-service | your-service |
```

## Paso 7: Prueba

```bash
# Verifica que el servidor inicie
npx -y @scope/mcp-server-your-service

# Verifica que el gateway de crow siga iniciando
node servers/gateway/index.js --no-auth
```

## Herramienta de scaffolding

Usa la CLI interactiva de scaffolding para generar el código base:

```bash
npm run create-integration
```

Esto genera los fragmentos de código para todos los archivos anteriores — solo tienes que copiarlos.

## Envíala

1. Abre un issue de [solicitud de integración](https://github.com/kh0pper/crow/issues/new?template=integration-request.md) para discutir tu idea
2. Haz un fork del repo, implementa la integración y envía un PR
