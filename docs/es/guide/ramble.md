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

Encontrarte con Crows tiene además un tope de **5 acreditaciones por día calendario local** (`MEET_CROW_DAILY_CAP` en `bundles/ramble/server/eggs.js`): una persona no es más que una clave pública que cualquiera puede generar, así que sin ese techo una avalancha de personas falsas podría forzar eclosión tras eclosión; los encuentros por encima del tope no acreditan nada ni dejan fila en el registro.

Cuando el calor alcanza el umbral de eclosión, se sortean una especie y una semilla del lado del servidor (`crypto.randomInt`, nunca `Math.random`, para que la tirada no se pueda predecir ni repetir); el aspecto del pájaro es único para esa semilla. Un huevo nuevo empieza a incubar de inmediato.

Tu pájaro activo viaja en tus caws y marcas **públicas** — el JSON del cable lleva `bird: { species, seed }`, así que otras personas lo ven en tus pines. Las marcas de contactos y "solo para mí" nunca llegan al cable de Nostr (ver abajo), así que el pájaro se omite solo del **cable**: esas filas siguen guardando `bird_species` / `bird_seed` localmente y se replican, con pájaro incluido, a tus propias instancias enlazadas.

Una vez que un pájaro ha eclosionado, el crow de la cabecera del Nest se convierte en él: su cara refleja la energía de la mascota (ver Tareas), mientras que la insignia de alerta "!" es independiente y sigue significando la salud del host, no el ánimo de la mascota.

Renderiza cualquier pájaro a partir de su especie y semilla con:

```
GET /api/ramble/bird/:species/:seed.svg?mood=happy|tired|alarmed
```

Autenticada por el dashboard, devuelve `image/svg+xml`, cacheada de forma privada durante un día. Una especie desconocida o una semilla malformada/desconocida responde `400`.

## Tareas

Tres tareas — **alimentar** (`feed`), **acicalar** (`preen`), **jugar** (`play`) — son tuyas para hacer una vez cada una por día local. Cada una completada da +8 de energía a la mascota; ninguna toca el calor del huevo.

`POST /api/ramble/pet/chore { kind: "feed" | "preen" | "play" }` completa una. Repetir un tipo ya hecho hoy es un no-op (`done: false`); en ambos casos la respuesta trae el estado actual de la mascota.

## Nidos y el estante de huevos

Los nidos son puntos de aparición en el mundo. Cada semana ISO, cada celda geohash-7 (unos 150 m de lado) tiene un nido o no, decidido por una fórmula pública — `sha256("ramble-nest-v1:" + celda + ":" + semana)`, hay nido cuando los primeros 32 bits mod `nest.rate` (24 por defecto) dan 0 — así que todo el mundo ve los mismos nidos sin ninguna intervención del servidor y sin que se revele nada sobre las personas. El mapa los muestra como pines de huevo en cuanto haces zoom (nivel 14 o más cerca), obtenidos de `GET /api/ramble/nests?bbox=south,west,north,east`.

Camina hasta quedar a menos de **75 m** de un nido y toca **Coger el huevo** (`POST /api/ramble/nests/claim`): un huevo nuevo llega a tu **estante** (sin eclosionar, calor 0, marcado con la celda y la semana en que se encontró). Límites: **una recogida por día local** y un **tope de estante de 5** (`shelf.cap`); ambos rechazos vuelven como una razón amistosa, no como un error. Recoger el mismo nido dos veces devuelve el mismo huevo. Recoger un huevo no acredita **nada** de calor ni alimenta **nada** de energía — el huevo mismo es la recompensa. Las recogidas se registran por instancia (`ramble_nest_claims`) y nunca se replican; el huevo sí.

Siempre incuba exactamente un huevo. Desde la pantalla **Bandada** puedes **incubar** cualquier huevo del estante (`POST /api/ramble/eggs/:id/incubate`); el que reemplaza pasa al estante conservando su calor. Instance sync distingue un huevo que *tú* aparcaste (`shelf_origin = 'user'`) de uno que la capa de sincronización dejó en el estante al reconciliar dos instancias (`'sync'`): solo este último se recupera automáticamente a la ranura de incubación.

## Tu bandada

Cada pájaro eclosionado se queda en tu bandada. La pantalla **Bandada** (`GET /api/ramble/flock`) los lista con el **activo** marcado — ese es el pájaro que aparece en tu mapa, en la cabecera del Nest y en tus caws públicos — y tocar otro pájaro lo activa (`POST /api/ramble/birds/:id/activate`). La puntuación es especies encontradas de 8 posibles; un segundo pájaro de una especie que ya tienes sigue siendo un pájaro, solo que no es una especie nueva.

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

### Nidos y estante

| Clave | Por defecto | Efecto |
|---|---|---|
| `nest.rate` | 24 | Aproximadamente un nido cada este número de celdas geohash-7 por semana (entero ≥ 1). Se replica con tus ajustes, así que tus propias instancias concuerdan; es un ajuste de operador, y una tasa distinta ya no coincide con los nidos de otras personas. |
| `shelf.cap` | 5 | Cuántos huevos sin eclosionar caben en el estante (entero ≥ 0; 0 desactiva la recogida). |

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
| `ramble_flock` | Tu bandada: pájaros, el estante, el huevo incubando, especies encontradas. |
| `ramble_nests` | Nidos cerca de una ubicación esta semana, los más cercanos primero, marcando tus recogidas. |
| `ramble_claim_nest` | Recoger el nido en el que estás (o una celda indicada a menos de 75 m) para conseguir un huevo en el estante. |

Los grupos (`ramble_group_create` / `ramble_group_join`) no están en la fase 1.

Una eclosión disparada a través de estas herramientas nunca envía una actualización en vivo a un panel del dashboard abierto — corren sobre el proceso MCP stdio, no por la ruta de peticiones del panel, así que no hay nada que empuje un evento `ramble-hatched`. El panel igual recoge el pájaro nuevo en su siguiente actualización (tras cualquier acción).

## Notas de operación

El transporte vive en el núcleo (`servers/gateway/boot/ramble-transport.js`), no en el bundle, porque debe reutilizar el único gestor Nostr vivo del gateway. Arranca en **cualquier gateway que tenga el directorio del bundle ramble y un gestor Nostr**. El arranque imprime una de estas líneas:

```
[ramble] transport started
[ramble] transport not started: no nostrManager (sharing disabled or boot order)
```

La segunda significa que el bundle está instalado pero nunca se publicará ni se recibirá nada — verifica que sharing/Nostr esté habilitado en esa instancia. Ningún fallo de Ramble puede bloquear el arranque del gateway; todo problema es una advertencia.

El límite de una recogida por día y el tope del estante se comprueban por instancia (las recogidas no se replican), así que un usuario con dos Crows puede recoger un huevo por día en cada una.

El tope solo limita las recogidas. Incubar un huevo que la capa de sincronización había dejado aparcado (`shelf_origin='sync'`) manda al estante el huevo que reemplaza sin que nada salga de él, así que el estante puede leer brevemente `6 de 5`; se estabiliza a medida que eclosionas huevos.

Dos instancias pueden discrepar durante un ciclo de sincronización sobre qué huevo está incubando: si cambias de huevo en un Crow mientras el otro sigue acreditando calor al huevo anterior, el huevo más antiguo gana en ambos lados y tu cambio se deshace (de forma consistente). Vuelve a cambiar una vez que ambas estén sincronizadas.
