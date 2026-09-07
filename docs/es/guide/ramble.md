---
title: Ramble
---

# Ramble

Ramble es una extensión de proximidad: dejas **marcas** (notas ancladas a un lugar) y **caws** (señales de presencia efímeras), y ves las que otras personas dejaron cerca de ti. Se instala como bundle, con un servidor MCP, un panel del dashboard con mapa, y un transporte Nostr que corre dentro del gateway.

La fase 1 es deliberadamente estrecha:

- **Solo geo.** La rejilla de privacidad tiene canales `ble` y `lan`, pero solo `geo` está conectado.
- **Solo el cable público.** Las marcas con visibilidad `contacts` o `groups` se guardan y se replican entre tus propias instancias de Crow, pero nunca se publican a los relays. La entrega a contactos/grupos es la fase 1b.
- Las marcas públicas `locked` son una **puerta del cliente, no criptografía.** El contenido está en el relay en claro; el panel simplemente se niega a mostrarlo hasta que pruebes proximidad. No pongas un secreto en una.

## Privacidad

Todo está apagado por defecto. Nada sale de la máquina hasta que enciendes **ambos**:

1. el interruptor maestro ("Soy visible"), y
2. la celda (audiencia × canal) específica — en la fase 1 eso es `public` × `geo`.

Ambos viven en la rejilla de privacidad del panel, guardados como filas planas en `ramble_settings` (`master`, `grid.<audiencia>.<canal>`). Son estado del usuario, así que se replican entre tus propias instancias.

El **nivel de identidad pública** decide qué clave firma lo que publicas:

| Nivel | Qué va al cable |
|---|---|
| `rotating` (por defecto) | Las marcas las firma un seudónimo estable derivado de tu semilla; los caws usan una clave nueva en cada arranque, así que las señales de presencia no son enlazables entre reinicios. |
| `pseudonym` | Marcas y caws usan el seudónimo estable — identidad consistente, sin vínculo con tu id real de Crow. |
| `real` | La clave propia de tu instancia y su `crow_id`. Todo lo que publiques es atribuible a este Crow. |

## Cómo funciona la publicación

La autoría es local y síncrona; el cable no. Una marca nueva se guarda con `publish_state = 'pending'`, y el transporte del gateway la publica en el siguiente tick de drenaje (cada 15 s, o de inmediato si se creó dentro del mismo proceso).

Valores de `publish_state`:

| Valor | Significado |
|---|---|
| `pending` | Esperando un tick, o la rejilla está cerrada, o es una marca no pública (que nunca se publica en la fase 1). |
| `published` | Al menos un relay aceptó el evento. |
| `synced` | Escrita por instance sync desde otro de tus propios Crows. |
| `remote` | Recibida de un relay — la marca de otra persona. |
| `failed` | Aparcada tras 20 intentos rechazados, para que una fila envenenada no ocupe un espacio del drenaje para siempre. |

Una fila `failed` es terminal hasta que un operador la rearma:

```sql
UPDATE ramble_marks SET publish_state='pending' WHERE mark_id=?;
```

Los borrados también son asíncronos. Borrar una marca publicada escribe una fila en `ramble_tombstones`; el transporte la convierte en un evento NIP-09 kind-5 en el siguiente tick y elimina la lápida solo cuando un relay la aceptó.

## Expiración

Marcas y caws llevan un TTL, y los valores por defecto dependen del tipo:

- marcas públicas: **24 h**
- caws: **1 h**
- marcas `contacts` / `groups`: sin expiración

El barrido corre en el mismo tick de 15 s. Las filas expiradas se borran localmente y el borrado se emite a instance sync, así que tus otros Crows también las descartan. Una marca expirada **no se puede desbloquear** ni siquiera en la ventana previa al barrido — `ramble_unlock` la rechaza.

## Tu huevo y tu pájaro

Cada instancia siempre tiene un huevo incubando. La actividad real acredita **calor** hacia él; cuando el calor alcanza el umbral de eclosión, el huevo eclosiona en un pájaro.

| Evento | Calor |
|---|---|
| Visitar un lugar nuevo | 20 |
| Dejar una marca | 15 |
| Desbloquear una marca | 10 |
| Encontrarte con un Crow cercano | 20 |
| Hacer el check-in | 8 |
| **Umbral de eclosión** | **100** |

Cada evento es idempotente según su propia clave, así que repetir la misma acción real nunca acumula calor dos veces:

- **Visitar un lugar** acredita una vez por celda geohash-7 por semana ISO, y solo desde tu posición real (`here`, la geolocalización del navegador) — desplazar el mapa a una celda nueva nunca acredita.
- **El check-in** acredita una vez por día calendario local.
- **Encontrarte con un Crow** acredita una vez por par (persona, semana ISO).
- **Dejar una marca** y **desbloquear una marca** no tienen clave de repetición — cada una se acredita.

Cuando el calor alcanza el umbral de eclosión, se sortean una especie y una semilla del lado del servidor (`crypto.randomInt`, nunca `Math.random`, para que la tirada no se pueda predecir ni repetir); el aspecto del pájaro es único para esa semilla. Un huevo nuevo empieza a incubar de inmediato.

Tu pájaro activo viaja en tus caws y marcas **públicas** — el JSON del cable lleva `bird: { species, seed }`, así que otras personas lo ven en tus pines. Las marcas de contactos y "solo para mí" nunca llegan al cable (ver abajo), así que nunca llevan pájaro.

Una vez que un pájaro ha eclosionado, el crow de la cabecera del Nest se convierte en él: su cara refleja la energía de la mascota (ver Tareas), mientras que la insignia de alerta "!" es independiente y sigue significando la salud del host, no el ánimo de la mascota.

Renderiza cualquier pájaro a partir de su especie y semilla con:

```
GET /api/ramble/bird/:species/:seed.svg?mood=happy|tired|alarmed
```

Autenticada por el dashboard, devuelve `image/svg+xml`, cacheada de forma privada durante un día. Una especie desconocida o una semilla malformada/desconocida responde `400`.

## Tareas

Tres tareas — **alimentar** (`feed`), **acicalar** (`preen`), **jugar** (`play`) — son tuyas para hacer una vez cada una por día local. Cada una completada da +8 de energía a la mascota; ninguna toca el calor del huevo.

`POST /api/ramble/pet/chore { kind: "feed" | "preen" | "play" }` completa una. Repetir un tipo ya hecho hoy es un no-op (`done: false`); en ambos casos la respuesta trae el estado actual de la mascota.

## Marcas solo para mí

Las marcas con `visibility: "private"` son solo para ti: nunca salen de la instancia por Nostr, así que ningún relay ni contacto las ve jamás. A diferencia de las marcas públicas y de contactos, son **persistentes por defecto** (sin TTL) y **abiertas por defecto** (sin puerta de proximidad).

"Solo para mí" sigue significando *tú*, en todas partes: una marca privada se replica a tus propias instancias enlazadas vía instance sync, así que te sigue entre tus Crows — simplemente nunca cruza al cable de Nostr. En el mapa, una marca privada lleva la etiqueta "Just me".

## Teselas del mapa

El mapa nunca habla directamente con un servidor de teselas. Carga `/ramble/tiles/{z}/{x}/{y}.png`, un proxy del mismo origen y autenticado por el dashboard, así que el proveedor de teselas nunca ve tu navegador ni tu sesión. El upstream es la clave `tile_url` de `ramble_settings`; el valor por defecto es OpenStreetMap (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`). La línea de atribución bajo el mapa viene de `tile_attribution`.

**Todavía no hay UI para ninguna de las dos** — configúralas con SQL contra `crow.db`:

```sql
INSERT INTO ramble_settings (key, value) VALUES ('tile_url', 'https://tiles.example.org/{z}/{x}/{y}.png')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```

El proxy solo acepta una plantilla `http(s)` que contenga `{z}`, `{x}` y `{y}`, y solo sirve respuestas de imagen.

## Configuración

| Variable de entorno | Por defecto | Efecto |
|---|---|---|
| `RAMBLE_DEFAULT_GEOHASH_PRECISION` | `5` | Precisión del geohash de la celda que se publica con cada marca (5 ≈ celda de 4,9 km). Acotada a 1–12. Menor es más grueso y más privado. |

### Pesos de calor

Cada peso de la tabla anterior es también un override de `ramble_settings`, leído en vivo en cada acreditación — sin necesidad de reiniciar. Un override debe ser un entero no negativo; `hatch_at` además debe ser `>= 1` (cualquier valor menor haría eclosionar cualquier huevo nuevo, con calor cero, en cada lectura). Un override ausente, no numérico o fuera de rango cae al valor por defecto.

| Clave | Por defecto |
|---|---|
| `warmth.visit_place` | 20 |
| `warmth.mark_left` | 15 |
| `warmth.unlock_mark` | 10 |
| `warmth.meet_crow` | 20 |
| `warmth.checkin` | 8 |
| `warmth.hatch_at` | 100 |

## Herramientas MCP

| Herramienta | Propósito |
|---|---|
| `ramble_leave_mark` | Dejar una marca en una ubicación. |
| `ramble_caw` | Emitir un marcador de presencia público y efímero. |
| `ramble_query_world` | Listar marcas y caws cercanos en la celda que contiene una ubicación. |
| `ramble_unlock` | Desbloquear una marca bloqueada probando proximidad a su ancla. |
| `ramble_pet_state` | Ánimo, energía, contadores semanales, pájaro activo y progreso del huevo de la mascota compañera. |
| `ramble_egg_state` | El progreso de calor del huevo incubando y la lista de comprobación hacia la eclosión. |
| `ramble_checkin` | Registrar el check-in de hoy, acreditando calor hacia el huevo. |
| `ramble_chore` | Completar una tarea diaria (`feed`, `preen` o `play`) para la mascota compañera. |
| `ramble_block` | Bloquear una persona por su pubkey x-only y purgar sus marcas guardadas. |
| `ramble_unblock` | Quitar una persona de la lista de bloqueo. |

Los grupos (`ramble_group_create` / `ramble_group_join`) no están en la fase 1.

Una eclosión disparada a través de estas herramientas nunca envía una actualización en vivo a un panel del dashboard abierto — corren sobre el proceso MCP stdio, no por la ruta de peticiones del panel, así que no hay nada que empuje un evento `ramble-hatched`. El panel igual recoge el pájaro nuevo en su siguiente actualización (tras cualquier acción).

## Notas de operación

El transporte vive en el núcleo (`servers/gateway/boot/ramble-transport.js`), no en el bundle, porque debe reutilizar el único gestor Nostr vivo del gateway. Arranca en **cualquier gateway que tenga el directorio del bundle ramble y un gestor Nostr**. El arranque imprime una de estas líneas:

```
[ramble] transport started
[ramble] transport not started: no nostrManager (sharing disabled or boot order)
```

La segunda significa que el bundle está instalado pero nunca se publicará ni se recibirá nada — verifica que sharing/Nostr esté habilitado en esa instancia. Ningún fallo de Ramble puede bloquear el arranque del gateway; todo problema es una advertencia.
