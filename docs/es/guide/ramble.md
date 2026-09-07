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

## Herramientas MCP

| Herramienta | Propósito |
|---|---|
| `ramble_leave_mark` | Dejar una marca en una ubicación. |
| `ramble_caw` | Emitir un marcador de presencia público y efímero. |
| `ramble_query_world` | Listar marcas y caws cercanos en la celda que contiene una ubicación. |
| `ramble_unlock` | Desbloquear una marca bloqueada probando proximidad a su ancla. |
| `ramble_pet_state` | Ánimo, energía y contadores semanales de la mascota compañera. |
| `ramble_block` | Bloquear una persona por su pubkey x-only y purgar sus marcas guardadas. |
| `ramble_unblock` | Quitar una persona de la lista de bloqueo. |

Los grupos (`ramble_group_create` / `ramble_group_join`) no están en la fase 1.

## Notas de operación

El transporte vive en el núcleo (`servers/gateway/boot/ramble-transport.js`), no en el bundle, porque debe reutilizar el único gestor Nostr vivo del gateway. Arranca en **cualquier gateway que tenga el directorio del bundle ramble y un gestor Nostr**. El arranque imprime una de estas líneas:

```
[ramble] transport started
[ramble] transport not started: no nostrManager (sharing disabled or boot order)
```

La segunda significa que el bundle está instalado pero nunca se publicará ni se recibirá nada — verifica que sharing/Nostr esté habilitado en esa instancia. Ningún fallo de Ramble puede bloquear el arranque del gateway; todo problema es una advertencia.
