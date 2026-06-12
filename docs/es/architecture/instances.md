---
title: Arquitectura de Instancias
description: Análisis técnico profundo del encadenamiento multi-instancia — registro, sincronización, federación y resolución de conflictos.
---

# Arquitectura de Instancias

El encadenamiento multi-instancia conecta instalaciones separadas de Crow en un espacio de trabajo unificado. Esta página cubre los mecanismos internos: cómo las instancias se descubren entre sí, sincronizan datos, federan llamadas a herramientas y resuelven conflictos.

Para las instrucciones de configuración orientadas al usuario, consulta la [Guía Multi-Instancia](../guide/instances).

## Registro de instancias

Cada instalación de Crow mantiene un registro local de instancias conocidas.

### Tabla de base de datos

```sql
CREATE TABLE crow_instances (
  id TEXT PRIMARY KEY,            -- UUID
  name TEXT NOT NULL,             -- Etiqueta legible ("grackle", "black-swan")
  role TEXT NOT NULL,             -- "home" o "satellite"
  gateway_url TEXT,               -- Endpoint HTTP (p. ej., "http://100.121.254.89:3001")
  public_key TEXT NOT NULL,       -- Clave pública Ed25519 (debe coincidir con la identidad compartida)
  last_seen INTEGER,              -- Marca de tiempo Unix del último contacto exitoso
  status TEXT DEFAULT 'unknown',  -- "online", "syncing", "offline", "unknown"
  created_at INTEGER NOT NULL
);
```

Las instancias también se registran en `~/.crow/instances.json` para que la CLI y los scripts de arranque puedan usarlas antes de que la base de datos esté disponible.

### Flujo de registro

1. El usuario le pide a la IA registrar una instancia (o usa el panel de configuración del Nest)
2. `crow_register_instance` valida la URL del gateway con un health check
3. La clave pública de la instancia remota se verifica contra la identidad local — ambas deben derivarse de la misma semilla maestra
4. Si todo es correcto, la instancia se agrega a `crow_instances` y a `~/.crow/instances.json`

## Sincronización principal vía Hypercore

La sincronización de datos entre instancias usa feeds append-only de Hypercore, gestionados por `InstanceSyncManager`.

### InstanceSyncManager

El gestor de sincronización corre como parte del proceso del gateway. Se encarga de:

1. Mantener un feed de Hypercore saliente por cada instancia registrada
2. Escuchar conexiones de feeds entrantes desde instancias remotas
3. Anexar los cambios locales (escrituras de memoria, actualizaciones de proyectos, ediciones del blog) al feed saliente
4. Aplicar los cambios entrantes de los feeds remotos a la base de datos local

### Estructura del feed

Cada cambio se anexa como una entrada JSON:

```json
{
  "type": "memory_insert",
  "table": "memories",
  "row_id": "uuid-here",
  "data": { "content": "...", "category": "project", "importance": 7 },
  "lamport": 42,
  "instance_id": "grackle-uuid",
  "timestamp": 1711000000
}
```

Tipos de cambio soportados: `memory_insert`, `memory_update`, `memory_delete`, `project_update`, `source_insert`, `note_insert`, `blog_update`, `contact_update`, `setting_update`.

### Marcas de tiempo de Lamport

Cada instancia mantiene un contador de Lamport. El contador se incrementa en cada escritura local y avanza a `max(local, remoto) + 1` en cada cambio recibido. Esto establece un **orden causal** sin requerir relojes sincronizados.

El valor `lamport` se almacena junto a cada fila sincronizada en una columna `lamport_ts`, agregada a las tablas que participan en la sincronización.

### Detección de conflictos

Un conflicto ocurre cuando dos instancias modifican la misma fila (mismo `row_id`) sin haber visto los cambios de la otra. Detección:

1. Al recibir un cambio remoto, se compara contra la fila local. Las filas equivalentes (mismo contenido tras la normalización a formato de transmisión) se suprimen como ruido — solo cuenta la divergencia real.
2. Cuando dos instancias realmente cambiaron la misma fila sin haber visto las ediciones de la otra, gana la marca de tiempo de Lamport más alta, y la versión perdedora se conserva en `sync_conflicts`:

```sql
CREATE TABLE sync_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  winning_instance_id TEXT NOT NULL,
  losing_instance_id TEXT NOT NULL,
  winning_lamport_ts INTEGER NOT NULL,
  losing_lamport_ts INTEGER NOT NULL,
  winning_data TEXT NOT NULL,     -- JSON de la versión que se conservó
  losing_data TEXT NOT NULL,      -- JSON de la versión que fue sobrescrita
  op TEXT DEFAULT 'update',       -- 'update', 'delete' o 'insert' (colisión)
  resolved INTEGER DEFAULT 0,
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

Ninguna edición se descarta jamás en silencio: cada conflicto genera una notificación deduplicada de alta prioridad que enlaza directamente a **Configuración → Conflictos de sincronización**, la vista de recuperación. Ahí el operador puede conservar la versión actual, restaurar la sobrescrita o resolver todo. La restauración está protegida — primero relee la fila viva (protección contra snapshots obsoletos), nunca usa `INSERT OR REPLACE`, rechaza las colisiones `op='insert'` (ambas versiones permanecen visibles como JSON para resolución manual) y rechaza las filas de `crow_context` (ahí aplica en su lugar last-write-wins por clave compuesta). Una versión restaurada se propaga de vuelta a las otras instancias como cualquier edición normal.

### Estado de sincronización

El progreso de sincronización por instancia se registra en `sync_state`:

```sql
CREATE TABLE sync_state (
  instance_id TEXT PRIMARY KEY,
  local_counter INTEGER DEFAULT 0,        -- Contador de Lamport de esta instancia (incrementos atómicos)
  last_applied_seq_per_peer TEXT DEFAULT '{}', -- JSON: checkpoints de feed por peer, escritos por entrada
  updated_at TEXT DEFAULT (datetime('now'))
);
```

Los checkpoints se escriben por entrada aplicada (no por lote), de modo que un crash a mitad de la sincronización nunca re-aplica ni omite entradas.

Al reconectarse, la sincronización se reanuda desde el checkpoint por peer en `last_applied_seq_per_peer` — solo se transfieren las entradas nuevas.

## Federación vía proxy del gateway

La federación habilita llamadas remotas a herramientas sin sincronizar datos. El gateway local hace proxy de las solicitudes MCP hacia un gateway remoto.

### Transporte

La federación usa `StreamableHTTPClientTransport` del SDK de MCP para conectarse al endpoint MCP del gateway remoto (`/mcp` o `/router/mcp`). La conexión se establece bajo demanda cuando se solicita una llamada federada a una herramienta.

### Autenticación

Las solicitudes federadas llevan un token bearer en el header `Authorization`. El token se deriva de la identidad compartida:

1. La instancia local firma un desafío (marca de tiempo actual + ID de la instancia destino) con su clave privada Ed25519
2. El gateway remoto verifica la firma contra la clave pública conocida de su propia tabla `crow_instances`
3. Los tokens son de corta vida (expiración de 5 minutos) y se regeneran automáticamente

### Flujo de una solicitud

```
El usuario pide: "Busca en todas las instancias notas de impuestos"
  → La IA local despacha crow_search_memories localmente
  → La IA local despacha la búsqueda federada a cada instancia registrada
    → El proxy del gateway crea un StreamableHTTPClientTransport
    → Envía la llamada a herramienta MCP por HTTP al gateway remoto
    → El gateway remoto ejecuta la herramienta contra su base de datos local
    → Los resultados regresan por HTTP
  → La IA local combina todos los resultados y los presenta al usuario
```

### Resúmenes en caché

Para evitar llamadas de federación redundantes, el gateway guarda en caché resúmenes ligeros de las instancias remotas:

- Nombres e IDs de proyectos (se refrescan cada hora)
- Conteos de memorias por categoría (se refrescan cada hora)
- Estado de salud de las instancias (se refresca cada 5 minutos)

Los resúmenes ayudan a la IA a decidir qué instancias consultar para una solicitud dada.

## Seguridad

### Verificación de identidad

Todas las instancias de una cadena deben compartir la misma identidad criptográfica (la misma semilla maestra). Esto se verifica durante el registro y en cada conexión de sincronización/federación. Una instancia con una identidad distinta no puede unirse a la cadena.

### Seguridad del transporte

- **Sincronización Hypercore**: Cifrada en la capa de transporte de Hyperswarm (protocolo Noise)
- **HTTP de federación**: Debería correr sobre HTTPS o Tailscale (túnel cifrado). Los tokens bearer impiden el acceso no autorizado incluso en redes de confianza.
- **Sin exposición pública**: El registro de instancias requiere una acción explícita del usuario. Las instancias no son descubribles en la internet pública.

### Verificación de firmas

Cada entrada de un feed de Hypercore está firmada por la clave Ed25519 de la instancia de origen. La instancia receptora verifica las firmas antes de aplicar los cambios. Las entradas manipuladas se rechazan y se registran.

## Próximos pasos

- [Guía Multi-Instancia](../guide/instances) — Configuración y uso orientados al usuario
- [Servidor de Compartición](./sharing-server) — Compartición P2P entre usuarios distintos (relacionada pero distinta de la sincronización de instancias)
- [Arquitectura del Gateway](./gateway) — Detalles del transporte HTTP y del proxy
