# Agregar herramientas a los servidores centrales

Esta guía explica cómo agregar nuevas herramientas MCP a los servidores centrales de Crow: crow-memory, crow-projects o crow-sharing.

## Patrón de fábrica de servidores

Cada servidor tiene una función fábrica en `server.js` que devuelve un `McpServer` configurado:

```
servers/memory/server.js    → createMemoryServer()
servers/research/server.js  → createProjectServer()
servers/sharing/server.js   → createSharingServer()
```

La lógica de las herramientas vive en `server.js`. El cableado del transporte (`index.js`) y el montaje en el gateway (`servers/gateway/index.js`) son independientes — solo necesitas modificar `server.js`.

## Agregar una herramienta

Usa el patrón `server.tool()`:

```js
server.tool(
  "tool_name",
  "Description of what this tool does",
  {
    param1: z.string().max(500).describe("What this parameter is"),
    param2: z.number().optional().describe("Optional numeric parameter"),
  },
  async ({ param1, param2 }) => {
    const db = createDbClient();
    try {
      // Tu lógica aquí
      const result = await db.execute({
        sql: "SELECT * FROM table WHERE col = ?",
        args: [param1],
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      };
    } finally {
      db.close();
    }
  }
);
```

## Convenciones

### Esquemas Zod

Todos los parámetros deben usar Zod con restricciones `.max()`:

```js
z.string().max(50000)   // Campos de contenido
z.string().max(500)     // Campos cortos (títulos, etiquetas)
z.number().int().min(1).max(100)  // Límites numéricos
```

### Consultas a la base de datos

Usa consultas parametrizadas — nunca interpoles entrada del usuario:

```js
// Bien
db.execute({ sql: "SELECT * FROM memories WHERE id = ?", args: [id] });

// Mal — riesgo de inyección SQL
db.execute({ sql: `SELECT * FROM memories WHERE id = ${id}` });
```

### Consultas FTS5

Usa la utilidad `sanitizeFtsQuery()` para la búsqueda de texto completo:

```js
import { sanitizeFtsQuery, escapeLikePattern } from "../db.js";

// FTS5 MATCH
const safeQuery = sanitizeFtsQuery(userInput);
db.execute({
  sql: "SELECT * FROM memories_fts WHERE memories_fts MATCH ?",
  args: [safeQuery],
});

// Patrón LIKE
const safePattern = escapeLikePattern(userInput);
db.execute({
  sql: "SELECT * FROM memories WHERE title LIKE ? ESCAPE '\\'",
  args: [`%${safePattern}%`],
});
```

### Cambios de esquema

Si tu herramienta necesita nuevas tablas o columnas en la base de datos:

1. Agrega el esquema a `scripts/init-db.js` usando el helper `initTable()`
2. Si agregas FTS, crea la tabla virtual Y los triggers de insert/update/delete
3. Ejecuta `npm run init-db` para aplicarlo

## Pruebas

```bash
# Verifica que el servidor inicie
node servers/memory/index.js   # (o research/sharing/storage/blog)

# Verifica que el gateway inicie
node servers/gateway/index.js --no-auth
```

## Enviar

1. Haz un fork del repo e implementa tu herramienta
2. Envía un PR con la lista de verificación de la plantilla de PR
