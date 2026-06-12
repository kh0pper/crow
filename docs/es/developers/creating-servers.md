---
title: Crear servidores MCP
---

# Crear servidores MCP

> El contrato de bundle (campos del manifiesto + superficies) está documentado en [bundles.md](./bundles.md).

Agrega un nuevo servidor MCP a la plataforma Crow, siguiendo los mismos patrones que usan los servidores integrados de memoria, proyectos, compartición, almacenamiento y blog.

## ¿Qué es esto?

Un servidor MCP expone herramientas que los asistentes de IA pueden llamar. Los servidores integrados de Crow manejan memoria, proyectos, compartición, almacenamiento y blogs. Puedes agregar tu propio servidor para cualquier dominio — gestión de tareas, analíticas, automatización del hogar o cualquier otra cosa.

## ¿Por qué querría esto?

- **Herramientas personalizadas** — Dale a tu IA nuevas capacidades adaptadas a tu flujo de trabajo
- **Arquitectura consistente** — Sigue el mismo patrón de fábrica para que tu servidor funcione tanto con transporte stdio como HTTP
- **Acceso a la base de datos** — Usa la base de datos SQLite compartida para la persistencia
- **Compartir con la comunidad** — Publica tu servidor como complemento para otros usuarios de Crow

## El patrón de fábrica

Cada servidor MCP de Crow sigue la misma estructura:

```
servers/your-server/
  server.js    # Función fábrica con las definiciones de herramientas
  index.js     # Enlace del transporte stdio
```

### server.js

La función fábrica crea y devuelve una instancia configurada de `McpServer`:

```js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDbClient, sanitizeFtsQuery, escapeLikePattern } from '../db.js';

export function createYourServer(dbPath) {
  const server = new McpServer({
    name: 'crow-your-server',
    version: '1.0.0',
  });

  const db = getDbClient(dbPath);

  server.tool(
    'crow_your_tool',
    'Description of what this tool does',
    {
      input: z.string().max(500).describe('What this parameter is for'),
      optional_param: z.string().max(200).optional().describe('Optional parameter'),
    },
    async ({ input, optional_param }) => {
      // Lógica de la herramienta aquí
      const result = await db.execute({
        sql: 'SELECT * FROM your_table WHERE column = ?',
        args: [input],
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(result.rows) }],
      };
    }
  );

  return server;
}
```

### index.js

El punto de entrada stdio es mínimo:

```js
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createYourServer } from './server.js';

const server = createYourServer();
const transport = new StdioServerTransport();
await server.connect(transport);
```

## Restricciones de esquemas Zod

Todos los parámetros de tipo string deben incluir restricciones `.max()` para prevenir abusos:

```js
// Bien
z.string().max(500).describe('Search query')
z.string().max(50000).describe('Content body')

// Mal — sin límite de tamaño
z.string().describe('Search query')
```

Límites recomendados:
- Campos cortos (nombres, IDs, consultas): `.max(500)`
- Campos de contenido (texto del cuerpo, notas): `.max(50000)`
- Límites numéricos: usa `.min()` y `.max()` en `z.number()`

## Tablas de la base de datos

Si tu servidor necesita sus propias tablas, agrégalas a `scripts/init-db.js`:

```js
await db.execute(`
  CREATE TABLE IF NOT EXISTS your_table (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);
```

Luego ejecuta `npm run init-db` para crear las tablas.

### Índices FTS5

Si tu tabla necesita búsqueda de texto completo, agrega una tabla virtual FTS5 y triggers de sincronización:

```js
await db.execute(`
  CREATE VIRTUAL TABLE IF NOT EXISTS your_table_fts USING fts5(
    name, content,
    content='your_table',
    content_rowid='id'
  )
`);

// Trigger de insert
await db.execute(`
  CREATE TRIGGER IF NOT EXISTS your_table_ai AFTER INSERT ON your_table BEGIN
    INSERT INTO your_table_fts(rowid, name, content)
    VALUES (new.id, new.name, new.content);
  END
`);

// Trigger de update
await db.execute(`
  CREATE TRIGGER IF NOT EXISTS your_table_au AFTER UPDATE ON your_table BEGIN
    INSERT INTO your_table_fts(your_table_fts, rowid, name, content)
    VALUES ('delete', old.id, old.name, old.content);
    INSERT INTO your_table_fts(rowid, name, content)
    VALUES (new.id, new.name, new.content);
  END
`);

// Trigger de delete
await db.execute(`
  CREATE TRIGGER IF NOT EXISTS your_table_ad AFTER DELETE ON your_table BEGIN
    INSERT INTO your_table_fts(your_table_fts, rowid, name, content)
    VALUES ('delete', old.id, old.name, old.content);
  END
`);
```

Usa `sanitizeFtsQuery()` de `servers/db.js` para cualquier consulta FTS5 MATCH:

```js
import { sanitizeFtsQuery } from '../db.js';

const safeQuery = sanitizeFtsQuery(userInput);
const results = await db.execute({
  sql: `SELECT * FROM your_table WHERE id IN (
    SELECT rowid FROM your_table_fts WHERE your_table_fts MATCH ?
  )`,
  args: [safeQuery],
});
```

Usa `escapeLikePattern()` para consultas LIKE:

```js
import { escapeLikePattern } from '../db.js';

const safePattern = escapeLikePattern(userInput);
const results = await db.execute({
  sql: `SELECT * FROM your_table WHERE name LIKE ? ESCAPE '\\'`,
  args: [`%${safePattern}%`],
});
```

## Registrar en server-registry.js

Agrega tu servidor a `scripts/server-registry.js` para que `npm run mcp-config` lo incluya:

```js
{
  name: 'crow-your-server',
  command: 'node',
  args: ['servers/your-server/index.js'],
  envVars: [],  // Variables de entorno requeridas (vacío = siempre incluido)
}
```

Si tu servidor requiere variables de entorno (p. ej., claves de API), lístalas en `envVars`. El servidor solo se incluirá en `.mcp.json` cuando esas variables estén configuradas.

## Agregar al gateway

Importa tu fábrica en `servers/gateway/index.js` y cabléala junto a los servidores existentes:

```js
import { createYourServer } from '../your-server/server.js';
// ... luego agrega el enlace del transporte HTTP
```

## Crear un archivo de skill

Escribe un archivo de skill en `skills/` que describa las capacidades de tu servidor y guíe a la IA sobre cuándo y cómo usar las herramientas:

```markdown
# Tu funcionalidad

## Cuándo activarse
- El usuario pregunta sobre [tu dominio]
- El usuario quiere [tu caso de uso]

## Herramientas disponibles
- `crow_your_tool` — Hace esto
- `crow_your_other_tool` — Hace aquello

## Flujo de trabajo
1. Paso uno
2. Paso dos
```

Agrega una fila de activación en `skills/superpowers.md` para que el skill se active automáticamente.

## Pruebas

Verifica que tu servidor inicie sin errores:

```bash
node servers/your-server/index.js
# Debería iniciar y esperar entrada por stdio (Ctrl-C para detenerlo)
```

Ejecuta `npm run mcp-config` y revisa `.mcp.json` para confirmar que tu servidor aparece.

## Compatibilidad con el router

Los servidores personalizados se vuelven detectables automáticamente a través de la categoría `crow_tools` del router cuando se agregan al gateway. El router consolida todas las herramientas en un despacho basado en categorías, así que las herramientas de tu servidor serán accesibles sin ninguna configuración adicional.

Buenas prácticas para la compatibilidad con el router:

- **Mantén las descripciones de las herramientas concisas** — aparecen en los manifiestos comprimidos que devuelve `crow_discover`, así que descripciones más cortas reducen el uso de contexto
- **Prueba tanto en modo directo como vía router** — verifica que tus herramientas funcionen cuando se llaman directamente vía `/your-server/mcp` y cuando se despachan a través de `/router/mcp`
- **Usa nombres de herramientas claros** — usa el prefijo `crow_` seguido de un nombre descriptivo, ya que el router agrupa las herramientas por categoría
