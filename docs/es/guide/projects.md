---
title: Espacios de Proyecto
description: Espacios de trabajo compartibles de primera clase con miembros, capacidades, recursos adjuntos y un registro de auditoría.
---

# Espacios de Proyecto

Un **espacio de proyecto** es la unidad de trabajo colaborativo y compartible en Crow. Cada espacio de proyecto tiene:

- Un **slug** (legible para humanos, usado en URLs y rutas de almacenamiento)
- Un **directorio de espacio de trabajo** en disco donde los bots y agentes pueden escribir
- Un **prefijo de almacenamiento MinIO** para archivos con alcance de proyecto
- **Miembros** con roles y anulaciones de capacidades por miembro
- Un **registro de auditoría** de quién hizo qué y cuándo
- **Recursos adjuntos** opcionales: fuentes de investigación, notas, backends de datos, archivos

Los espacios de proyecto son de primera clase en la superficie MCP de Crow — tu IA puede crearlos, compartirlos, gestionar miembros y razonar sobre ellos. También son donde operan los bots: el espacio de trabajo de un bot ES el espacio de trabajo del proyecto.

## Inicio rápido

```
"Crea un proyecto llamado Investigación Primavera 2026 con descripción ..."
```

La IA llama a `crow_create_project`. Tras bambalinas, Crow crea:
- Una fila en `project_spaces` (con un slug generado como `spring-2026-research-12`)
- Una fila de propietario en `project_members` para el usuario local
- Un directorio de espacio de trabajo en `~/.crow/data/projects/<slug>/workspace/`
- Un prefijo de claves MinIO `crow-files/projects/<slug>/`

Puedes agregar fuentes, notas, backends de datos y miembros de inmediato.

## Miembros y roles

Cada espacio de proyecto tiene al menos un miembro: el usuario local (su creador, como `owner`). Agregar un contacto como miembro le otorga un rol.

| Rol | Capacidades predeterminadas |
|---|---|
| **owner** | Todas las capacidades, incluyendo `manage_members` y `delete_project` |
| **editor** | Lectura + escritura en fuentes, notas, archivos y tareas. `invoke_bot`. `query_backend`. |
| **viewer** | Lectura en fuentes, notas, archivos, tareas. |
| **guest** | Lectura solo en fuentes y notas. |

El rol establece los paquetes de capacidades *predeterminados*. Las anulaciones por miembro pueden activar o desactivar cualquier capacidad mediante un objeto JSON:

```json
{"invoke_bot": false}
```

Por ejemplo: "Robin es editor pero no puede hablar con el bot" — establece role=editor + capacidades `{"invoke_bot": false}`. O: "Sam es guest pero puede consultar el backend tea-data" — establece role=guest + capacidades `{"query_backend:tea-data": true}`.

### Agregar un miembro

Vía la IA:

```
"Agrega a Robin al proyecto #12 como editor sin invoke_bot"
```

La IA llama a `crow_add_member` con el id del proyecto, el id del contacto, el rol y el JSON de capacidades.

Vía el dashboard: abre la vista de detalle del proyecto, desplázate hasta la sección **Miembros**, completa el pequeño formulario en línea (desplegable de contacto + selector de rol + JSON de capacidades opcional) y envíalo.

### Eliminar un miembro

Vía la IA:

```
"Revoca el acceso de Robin al proyecto #12"
```

`crow_remove_member` realiza una revocación suave (establece `revoked_at`; no elimina la fila). Las capacidades del miembro quedan en cero de inmediato. El registro de auditoría anota quién revocó y cuándo.

Vía el dashboard: haz clic en el botón **revoke** en la fila del miembro.

## Capacidades

Las capacidades son compuertas booleanas verificadas en cada ruta de escritura:

| Capacidad | Ruta controlada |
|---|---|
| `read_sources`, `read_notes`, `read_files`, `read_tasks` | (actualmente consultivas — las rutas de lectura en la Fase 1 son solo locales) |
| `write_sources` | `crow_add_source` cuando `project_id` está definido |
| `write_notes` | `crow_add_note` cuando `project_id` está definido |
| `write_files` | `crow_upload_file` + `POST /storage/upload` cuando `project_id` está definido |
| `write_tasks` | (consultiva — las escrituras de tareas fluyen por las herramientas propias del bundle) |
| `invoke_bot` | Entrada del bot: lista de permitidos de Gmail + futuras rutas peer de Nostr |
| `query_backend` (maestra) + `query_backend:<id>` (anulaciones por backend) | Lista de backends de datos permitidos del bot |
| `manage_members` | `crow_add_member`, `crow_remove_member`, `crow_share` (modo proyecto) |
| `delete_project` | (consultiva — la Fase 1 usa archivado suave) |

Las capacidades se resuelven en el momento de la escritura: valor predeterminado del rol ⇒ anulación JSON por miembro ⇒ booleano final.

## Directorio de espacio de trabajo

Cada proyecto obtiene un directorio en `~/.crow/data/projects/<slug>/workspace/`. Este es:

- Donde los bots asignados al proyecto escriben artefactos (`<workspace>/bots/<bot_id>/`)
- La entrada `write_paths` predeterminada para los bots del proyecto
- Disponible para los agentes vía la herramienta MCP `crow_workspace_dir`

El directorio persiste cuando el proyecto se archiva (solo se elimina con el borrado definitivo).

## Adjuntar recursos

### Fuentes y notas

Cuando ejecutas `crow_add_source` o `crow_add_note` con un `project_id`, Crow:

1. Verifica la capacidad `write_sources` / `write_notes` del usuario local
2. Inserta la fila con el project_id
3. Agrega una entrada de auditoría `source.add` / `note.add`

### Archivos

`crow_upload_file` y `POST /storage/upload` aceptan un `project_id` opcional. Cuando está definido:

- Quien llama debe tener `write_files`
- El archivo se almacena bajo `crow-files/projects/<slug>/...`
- Se establece `storage_files.project_id`
- Se escribe una entrada de auditoría `file.upload`
- Si `reference_id` también está definido (por ejemplo, para el adjunto de una fuente), el proyecto de la fila referenciada debe coincidir — Crow rechaza referencias de archivos entre proyectos

Los archivos subidos *sin* `project_id` conservan el comportamiento previo al rediseño (visibles para el usuario con sesión iniciada, sin ACL de proyecto aplicada).

### Backends de datos

`crow_register_backend` ya soporta `project_id`. Un bot asignado al proyecto hereda los backends de su proyecto (vía la resolución de la capacidad `query_backend`).

## Bots y espacios de proyecto

El **proyecto** de un bot se define en la columna `pi_bot_defs.project_id`. Cuando el bridge inicia un turno para un bot nativo de proyecto:

1. `session_dir` se resuelve a `<project workspace>/bots/<bot_id>/`
2. El prompt recibe un bloque de contexto estructurado (nombre del proyecto, slug, ruta del espacio de trabajo, lista de miembros)
3. La instantánea del Kanban lee del `tasks_db_uri` del proyecto (con respaldo al valor predeterminado del bundle)
4. Cada turno agrega una entrada de auditoría `bot.invoke` (o `bot.error` ante un fallo)
5. La lista de permitidos de entrada de Gmail es la unión de las direcciones estáticas del operador + el correo de cada miembro del proyecto con `invoke_bot=true`

Edita el proyecto de un bot vía la pestaña **Project / Kanban** del panel Bot Builder.

## Registro de auditoría

Cada mutación significativa agrega una entrada a `project_audit_log`:

| Acción | Escrita por |
|---|---|
| `member.add`, `member.update`, `member.revoke` | Herramientas de proyecto + panel de proyectos |
| `source.add`, `note.add`, `file.upload` | Agregar fuente / agregar nota / subir archivo (cuando project_id está definido) |
| `bot.invoke`, `bot.error` | El bridge del bot tras cada turno |
| `share.send`, `share.revoke`, `share.received` | Flujo de compartición de proyectos |

Velo en la sección de registro de auditoría del dashboard, o vía la herramienta MCP `crow_audit_log`:

```
"Muéstrame las últimas 20 entradas de auditoría del proyecto #12"
```

## Compartir espacios de proyecto

Consulta la [guía de Compartición de Datos](./data-sharing) para el modelo completo de compartición.

En la Fase 1, el **modo clon** es el único modo disponible. Un clon entrega:

- La fila de metadatos del proyecto
- Todas las fuentes y notas
- El registro de auditoría hasta el momento de la instantánea
- Manifiestos de los backends de datos (solo nombres de variables de entorno — nunca secretos)
- Un manifiesto de los archivos del proyecto (con URLs prefirmadas de 24 horas que el destinatario puede usar para descargar los blobs por fuera de banda)

El destinatario obtiene un proyecto nuevo e independiente con un slug `-clone-N`. Sin sincronización posterior. El origen registra una entrada de auditoría `share.send` y una fila en `project_members` (con `mode='clone'`) para que una revocación futura pueda encontrar el registro de la compartición.

La suscripción (sincronización unidireccional en vivo) y la lectura federada son hitos planeados para más adelante.

## Archivar vs eliminar

La Fase 1 usa **archivado suave**: cambiar el estado de un proyecto a `archived` establece `archived_at` y oculta el proyecto de los listados activos. Las fuentes, notas, miembros, auditoría y el directorio del espacio de trabajo se preservan. El proyecto puede desarchivarse desde el dashboard en cualquier momento.

El borrado definitivo (eliminar el directorio del espacio de trabajo y todo en cascada) no está implementado en la Fase 1 — registra tu decisión antes de reimplementarlo como una operación irreversible.

## Ver también

- [Guía de compartición](./sharing) — conexiones peer y el modelo de compartición más amplio
- [Guía de Compartición de Datos](./data-sharing) — modos de compartición clon / suscripción / lectura federada
- [Guía de Backends de Datos](/es/guide/data-backends) — conectar servidores MCP externos como recursos del proyecto
