---
title: Ramble
---

# Ramble

Ramble es una extensión de proximidad: dejas **marcas** (notas ancladas a un lugar) y **caws** (señales de presencia efímeras), y ves las que otras personas dejaron cerca de ti. Se instala como bundle, con un servidor MCP, un panel del dashboard con mapa, y un transporte Nostr que corre dentro del gateway. Un punto azul con un anillo de precisión te sigue en el mapa; **Alrededor de ti** activa o desactiva el modo seguir (arrastrar el mapa lo desactiva).

La fase 1 es deliberadamente estrecha:

- **Solo geo.** La rejilla de privacidad tiene canales `ble` y `lan`, pero solo `geo` está conectado.
- **Contactos y grupos viajan como DMs.** Las marcas con visibilidad `contacts` o `group:<uid>` se sellan para cada destinatario (NIP-44, un DM por contacto) y nunca tocan un relay público en claro — ver más abajo. Regalos e intercambios usan la misma puerta.
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

**Nombre en el mundo.** En la hoja Visible puedes fijar un nombre en el mundo (hasta 24 caracteres) que los desconocidos ven en tus marcas y caws públicos en lugar de una clave — pero solo mientras tu nivel de Nombre sea `pseudonym` o `real`; en `rotating` no sale nada más que la clave corta. No está verificado, así que el nombre de un desconocido se muestra siempre con los cuatro primeros caracteres de su clave ("Kevin · f665"). Los contactos nunca lo ven: ven tu nombre de Crow, o el nombre que guardaron para ti. Tus propias marcas dicen "your mark".

## Cómo funciona la publicación

La autoría es local y síncrona; el cable no. Una marca nueva se guarda con `publish_state = 'pending'`, y el transporte del gateway la publica en el siguiente tick de drenaje (cada 15 s, o de inmediato si se creó dentro del mismo proceso).

Valores de `publish_state`:

| Valor | Significado |
|---|---|
| `pending` | Esperando un tick de drenaje, o la puerta de la rejilla está cerrada, o (contactos/grupo) el DM de algún destinatario aún no ha sido aceptado por un relay. |
| `published` | Al menos un relay aceptó el evento — o, para una marca de contactos/grupo, el DM de cada destinatario fue aceptado (una marca sin nadie a quien enviarla se marca publicada al instante). |
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

Los nidos son puntos de aparición en el mundo. Cada semana ISO, cada celda geohash-7 (unos 150 m de lado) tiene un nido o no, decidido por una fórmula pública — `sha256("ramble-nest-v1:" + celda + ":" + semana)`, hay nido cuando los primeros 32 bits mod `nest.rate` (24 por defecto) dan 0 — así que todo el mundo ve los mismos nidos sin ninguna intervención del servidor y sin que se revele nada sobre las personas. El mapa los muestra como pines de huevo en cuanto haces zoom (nivel 15 o más cerca), obtenidos de `GET /api/ramble/nests?bbox=south,west,north,east`.

Camina hasta quedar a menos de **75 m** de un nido y toca **Tomar el huevo** (`POST /api/ramble/nests/claim`): un huevo nuevo llega a tu **estante** (sin eclosionar, calor 0, marcado con la celda y la semana en que se encontró). Límites: **una recogida por día local** y un **tope de estante de 5** (`shelf.cap`); ambos rechazos vuelven como una razón amistosa, no como un error. Recoger el mismo nido dos veces devuelve el mismo huevo. Recoger un huevo no acredita **nada** de calor ni alimenta **nada** de energía — el huevo mismo es la recompensa. Las recogidas se registran por instancia (`ramble_nest_claims`) y nunca se replican; el huevo sí.

Siempre incuba exactamente un huevo. Desde la pantalla **Bandada** puedes **incubar** cualquier huevo del estante (`POST /api/ramble/eggs/:id/incubate`); el que reemplaza pasa al estante conservando su calor. Instance sync distingue un huevo que *tú* aparcaste (`shelf_origin = 'user'`) de uno que la capa de sincronización dejó en el estante al reconciliar dos instancias (`'sync'`): solo este último se recupera automáticamente a la ranura de incubación.

**El mapa se desbloquea al caminar.** El terreno donde realmente has estado queda desbloqueado para siempre: puedes leer las marcas y los caws que hay allí y recoger el huevo de cualquier nido. Unas manzanas más allá está la frontera, donde ves que algo te espera sin ver qué es. Todo lo demás es niebla hasta que vayas. Solo el mapa público funciona así: la marca de un contacto siempre te llega, estés donde estés. Caminar por terreno que ya desbloqueaste hace aparecer **alpiste**, que vuelve a crecer al cabo de un día. El alpiste aparece en aproximadamente una de cada cuatro celdas despejadas, en un punto dentro de ella, así que un paseo tiene unos pocos lugares a los que merece la pena ir en vez de uno en cada cuadro; lo recoges al pasar por allí, no al tocarlo. Aleja el mapa para ver la forma completa del terreno que has despejado. De vez en cuando un lugar nuevo también contiene un **contenedor de corazón**, que alarga de forma permanente la barra de energía de tu pájaro — aproximadamente uno de cada tres lugares la primera vez que entras en él, y con mucha menos frecuencia en terreno que ya has despejado. Los corazones son lo único que eleva el máximo; le dan a tu pájaro un margen más largo entre paseos antes de que decaiga, y nada más. Un corazón que no has recogido aparece en el mapa allí donde te espera, así que los lugares que despejaste antes de que existieran los corazones merecen la pena volver a caminarlos. Lo recoges caminando hasta él, igual que el alpiste.

## Tu bandada

Cada pájaro eclosionado se queda en tu bandada. La pantalla **Bandada** (`GET /api/ramble/flock`) los lista con el **activo** marcado — ese es el pájaro que aparece en tu mapa, en la cabecera del Nest y en tus caws públicos — y tocar otro pájaro lo activa (`POST /api/ramble/birds/:id/activate`). La puntuación es especies encontradas de 8 posibles; un segundo pájaro de una especie que ya tienes sigue siendo un pájaro, solo que no es una especie nueva.

## Contactos y grupos

Una marca para **Contactos** llega a cada contacto completo (no bloqueado, no bot, no una solicitud pendiente) como un DM NIP-44 individual, firmado con la clave de esta instancia — la misma puerta que usa cualquier DM de Crow. Una marca para un **Grupo** llega a los miembros de ese grupo de contactos (`group:<group_uid>`, los grupos del panel Contactos; el panel de Ramble solo muestra la audiencia Grupo cuando tienes alguno). La única etiqueta del DM es el destinatario; el texto, el lugar y el pájaro de la marca van cifrados. Nada de una marca para contactos o grupo llega a un relay en claro.

La entrega se encola, no es inmediata: al escribir se crea una fila de `ramble_outbox` por destinatario y el transporte del gateway las envía en su tick de drenaje (cada 15 s, o al instante si escribes desde el panel). Una marca para contactos pasa por la rejilla de privacidad igual que una pública — la celda `contacts` (o `groups`) × `geo` y el interruptor maestro deben estar activados, o espera en la cola. La fila pasa a `published` cuando el DM de cada destinatario ha sido aceptado por un relay (o descartado porque ese contacto ya no existe). Quien la recibe la guarda como una marca de contactos persistente, con el nombre del contacto, y cuenta como haber conocido a su pájaro para el calor.

Las marcas de un contacto están acotadas por retención: conservas las 50 más recientes de cada contacto y las más antiguas se eliminan cuando llegan nuevas (su `created_at` lo pone quien envía, así que un tope diario sería su reloj para hacer trampa). Bloquear sigue siendo el freno definitivo.

La entrega a contactos es solo entre contactos en ambas direcciones: un DM de este tipo de alguien que no es contacto se descarta y nunca se convierte en una solicitud de mensaje. El pin de un desconocido en tu mapa ofrece **Compartir una invitación**, que abre el panel Contactos — primero haceos contactos, luego intercambiad.

La cola es por instancia: solo el Crow desde el que escribiste envía una marca, un regalo o una oferta. Todos tus Crows comparten una misma identidad Nostr, así que cada uno recibe lo que un contacto envía y lo aplica; luego las filas coinciden mediante instance sync. Un paso de intercambio que un contacto responde se completa en cada uno de tus Crows, y cada uno envía la confirmación — el contacto simplemente ignora las copias.

## Regalos e intercambios

Cualquier huevo sin eclosionar de tu estante — recogido de un nido o recibido de alguien — se puede **regalar** a un contacto (`POST /api/ramble/eggs/:id/gift { crow_id }`, herramienta `ramble_gift_egg`). El huevo sale de tu estante como `gifted` y llega al suyo como `received`, aún sin eclosionar: el cable solo lleva `{ egg_id, warmth, found_cell, found_week }`, nunca una especie ni una semilla — quien lo haga eclosionar tira el pájaro. Un huevo recibido se muestra como "Un regalo · de <nombre>" y se puede incubar, regalar de nuevo u ofrecer en un intercambio. Los huevos recibidos no ocupan ninguna de las cinco plazas de recogida. Un regalo entregado dos veces se guarda una sola vez; un huevo que diste y te devuelven simplemente vuelve a tu estante.

Un **intercambio** es una oferta de uno de tus huevos por uno de los suyos (`POST /api/ramble/trades { egg_id, crow_id }`, herramienta `ramble_propose_swap`). El contacto ve la oferta en su pantalla Bandada y responde con un huevo de su elección (**Aceptar**, `POST /api/ramble/trades/:id/accept { egg_id }`) o **Rechazar**; tú puedes **Retirar** una oferta sin respuesta. Los huevos cambian de manos solo cuando el intercambio se completa — en cada lado, de forma atómica — y un huevo nombrado por una oferta abierta queda bloqueado (no se puede incubar, regalar ni ofrecer de nuevo hasta que la oferta se cierre). Las ofertas caducan a los siete días en cada lado; una oferta caducada libera el huevo. Si tu respuesta llega cuando la oferta ya caducó en su lado, responden con un rechazo y tu huevo queda libre. Aceptar y rechazar son acciones del panel (no hay herramienta MCP para ellas).

Todo esto es solo entre contactos, va cifrado y tiene límites: un contacto puede tener como máximo 20 ofertas abiertas contigo y darte como máximo 20 huevos al día; lo que pase de ahí se ignora. Una oferta, una respuesta o una finalización que nombre un huevo que todavía tienes se ignora. No hay mercado, ni registro de valor, ni escasez: si los dos lados discrepan justo en el momento en que una oferta caduca, el peor caso es un huevo duplicado, nunca uno perdido. Conocer a un contacto a través de una marca cuenta para el calor igual que conocer a un desconocido (por clave, por semana).

## La vista AR

Toca **Mirar alrededor** en el mapa para abrir la vista AR: la cámara trasera llena la pantalla y cada marca, caw y nido a menos de unos 500 m recibe una etiqueta colocada por dirección y distancia. Las etiquetas a menos de 35° de hacia donde miras se posan sobre la imagen, las más cercanas más abajo y más grandes; el resto se aparca en el borde izquierdo o derecho con una flecha, apiladas por distancia. Las marcas bloqueadas son etiquetas discontinuas con una distancia a pie medida hasta el centro de su celda (no llevan posición exacta, igual que en el mapa). Tocar cualquier etiqueta abre las mismas acciones que su pin del mapa — desbloquear, tomar el huevo, leer el texto, compartir una invitación. Tu pájaro activo se posa abajo, salta cuando una etiqueta entra en vista y dice qué es lo más cercano. Un caw que solo lleva su celda de publicación gruesa se lista como "en algún lugar por aquí" y nunca recibe una dirección. A menos de 75 m de un nido su etiqueta se vuelve dorada y muestra el huevo; tócala para abrir la hoja, pulsa **Tomar el huevo**, y la etiqueta, el pin y el botón laten mientras se comprueba tu posición; luego el huevo baja volando hacia tu pájaro cuando es tuyo (el pin del mapa hace lo mismo).

La posición viene de `watchPosition`; el rumbo de `deviceorientationabsolute` (Safari informa `webkitCompassHeading` en el evento normal, y iOS pide una vez acceso al movimiento desde el toque del botón). Sin posición, sin cámara o sin brújula se recurre a la **franja de radar** — un anillo de rumbos (norte arriba, o rumbo arriba cuando hay brújula) y una lista de distancias — así que la pantalla nunca queda en blanco; la primera apertura explica los límites (precisión de la brújula, el aviso de iOS, sin anclaje a superficies, la cámara se queda en el teléfono). La imagen de la cámara nunca sale del dispositivo: la vista se dibuja en el cliente sin captura, canvas ni subida, y el flujo se detiene al cerrar la vista o cambiar de pestaña (se reanuda al volver).

El panel consulta `GET /api/ramble/around?lat=&lon=&radius_m=` (radio 50–1000 m, 500 por defecto): marcas tal como están guardadas (una marca bloqueada como su adelanto en el centro de la celda, la marca de un contacto con su nombre, el nombre en el mundo de un desconocido con la cola de su clave), cada una con `distance_m`, más los nidos de esta semana, los más cercanos primero. El panel lista lo mismo que el mapa (marcas públicas, de contactos y tus propias marcas "solo para mí"). Se actualiza tras moverte 50 m, una vez por minuto, al cerrar una etiqueta tocada y con cada evento en vivo. Es una lectura y no acredita nada. La vista necesita un contexto seguro: abre el Nest por su dirección HTTPS de Tailscale Serve, no por una URL `http://` con IP, o el navegador rechaza la cámara y la brújula y obtienes la franja de radar.

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
| `frontier.depth` | 3 | Cuántas manzanas más allá de tu terreno desbloqueado puedes ver. |
| `seed.rate` | 4 | Aproximadamente una de cada tantas celdas despejadas lleva alpiste (entero ≥ 1). Menos significa más denso. |
| `seed.respawn.hours` | 24 | Cuánto tarda el alpiste en volver a aparecer en un lugar. |
| `seed.per.pickup` | 1 | Cuánto alpiste da un lugar. |
| `heart.rate` | 3 | Aproximadamente uno de cada tantos lugares contiene un contenedor de corazón la primera vez que entras en él (entero ≥ 1). |
| `heart.wild.days` | 30 | Cuánto tarda un corazón en poder reaparecer en terreno que ya has despejado. |
| `heart.wild.rate` | 40 | Aproximadamente uno de cada tantos lugares despejados contiene ese corazón que reaparece (entero ≥ 1). |
| `energy.max.base` | 100 | La longitud de la barra de energía sin ningún contenedor de corazón. |
| `energy.max.per.heart` | 10 | Cuánto alarga la barra cada contenedor de corazón. |
| `energy.max.cap` | 300 | Lo máximo que puede llegar a medir la barra, por muchos corazones que encuentres. |
| `unlock.max.accuracy.m` | 100 | Qué tan precisa debe ser tu ubicación para que un lugar cuente como visitado. |

## Herramientas MCP

| Herramienta | Propósito |
|---|---|
| `ramble_leave_mark` | Dejar una marca en una ubicación. |
| `ramble_caw` | Emitir un marcador de presencia público y efímero. |
| `ramble_query_world` | Listar marcas y caws cercanos en la celda que contiene una ubicación; cada fila lleva un `label` ("your mark", "mark by <contacto>", "mark by <nombre en el mundo> · <clave4>" o "mark by <clave8>"). |
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
| `ramble_gift_egg` | Regalar un huevo sin eclosionar del estante a un contacto (encolado como un DM cifrado). |
| `ramble_propose_swap` | Ofrecer un huevo del estante a un contacto a cambio de uno de los suyos; ellos eligen qué devolver. |

Las audiencias de grupo son los grupos de contactos del panel Contactos (`visibility: "group:<group_uid>"`); no hay herramientas de grupo propias de ramble. `ramble_leave_mark` informa `recipients` para una marca de contactos o grupo.

Una eclosión disparada a través de estas herramientas nunca envía una actualización en vivo a un panel del dashboard abierto — corren sobre el proceso MCP stdio, no por la ruta de peticiones del panel, así que no hay nada que empuje un evento `ramble-hatched`. El panel igual recoge el pájaro nuevo en su siguiente actualización (tras cualquier acción).

## Notas de operación

El transporte vive en el núcleo (`servers/gateway/boot/ramble-transport.js`), no en el bundle, porque debe reutilizar el único gestor Nostr vivo del gateway. Arranca en **cualquier gateway que tenga el directorio del bundle ramble y un gestor Nostr**. El arranque imprime una de estas líneas:

```
[ramble] transport started
[ramble] transport not started: no nostrManager (sharing disabled or boot order)
```

La segunda significa que el bundle está instalado pero nunca se publicará ni se recibirá nada — verifica que sharing/Nostr esté habilitado en esa instancia. Ningún fallo de Ramble puede bloquear el arranque del gateway; todo problema es una advertencia.

El límite de una recogida por día y el tope del estante se comprueban por instancia (las recogidas no se replican), así que un usuario con dos Crows puede recoger un huevo por día en cada una.

El mapa de los lugares que has desbloqueado, y tus saldos de alpiste y de corazones, se replican a tus propios Crows enlazados, y nunca llegan a un contacto.

El tope solo limita las recogidas. Incubar un huevo que la capa de sincronización había dejado aparcado (`shelf_origin='sync'`) manda al estante el huevo que reemplaza sin que nada salga de él, así que el estante puede leer brevemente `6 de 5`; se estabiliza a medida que eclosionas huevos.

Dos instancias pueden discrepar durante un ciclo de sincronización sobre qué huevo está incubando: si cambias de huevo en un Crow mientras el otro sigue acreditando calor al huevo anterior, el huevo más antiguo gana en ambos lados y tu cambio se deshace (de forma consistente). Vuelve a cambiar una vez que ambas estén sincronizadas.

La entrega a contactos, los regalos y los intercambios necesitan todos los gateways en el código nuevo: un gateway con la fase 2 guarda un sobre de ramble como un mensaje de chat. Reinícialos todos antes de que nadie envíe. El transporte registra `dropping <kind> delivery to <crow_id>: not a deliverable contact` cuando un destinatario encolado fue borrado o bloqueado, y `gave up after 20 attempts` cuando ningún relay acepta un DM. Durante un reinicio escalonado, un gateway que sigue en la fase 2 descarta en silencio las operaciones de sincronización entrantes de `ramble_trades` (una tabla desconocida avanza su punto de control sin aplicarla); una fila de intercambio emitida en esa ventana llega a ese Crow solo cuando una operación posterior toca el mismo intercambio. Reinicia todos los gateways uno tras otro para que la ventana dure segundos.

La vista AR es solo del cliente: el gateway ve `GET /api/ramble/around` y nada más nuevo. Un teléfono que muestra "Radar · no compass" en Android normalmente no tiene soporte de `deviceorientationabsolute` en ese navegador; "Radar · no camera" en cualquier dispositivo significa que se rechazó el permiso o que la página no es un contexto seguro. Un caw publicado con una precisión de geohash de 4 o menos (un `RAMBLE_DEFAULT_GEOHASH_PRECISION` no predeterminado en el emisor) se muestra en el mapa pero no en la vista AR.
