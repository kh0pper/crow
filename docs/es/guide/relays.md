# Relays

Los relays proporcionan entrega de tipo almacenar-y-reenviar (store-and-forward) para el sistema de compartición peer-to-peer de Crow. Cuando dos peers rara vez están en línea al mismo tiempo, un relay retiene los datos cifrados hasta que el destinatario se conecta.

## ¿Qué es un relay?

El sistema de compartición de Crow usa dos capas de transporte:

- **Hyperswarm** — Conexiones directas peer-to-peer para datos pesados (sincronización de proyectos, memorias en bloque, archivos). Requiere que ambos peers estén en línea simultáneamente.
- **Relays de Nostr** — Mensajería ligera (DMs, reacciones). Los mensajes persisten en relays públicos hasta que se recuperan.

Un **peer relay** cubre la brecha para los datos de Hypercore. Acepta blobs cifrados de un remitente, los almacena temporalmente y los entrega cuando el destinatario se conecta. Piensa en él como un buzón para tus datos cifrados.

## Cómo funcionan los peer relays

Cualquier gateway de Crow desplegado en la nube puede actuar como relay para sus contactos. Esto es opcional (opt-in) y mutuo — tú ayudas a tus amigos, y ellos te ayudan a ti.

### Habilitar el modo relay

Pídele a Crow que habilite tu gateway como relay:

> "Habilita el modo relay para mi gateway"

Esto establece `relay_enabled` en tu estado de compartición. Tu gateway entonces aceptará solicitudes `POST /relay/store` y `GET /relay/fetch` de contactos autenticados.

### Cómo funciona la entrega

1. Alice quiere compartir una memoria con Bob, pero Bob está desconectado
2. El Crow de Alice cifra los datos para la clave pública de Bob
3. El Crow de Alice envía el blob cifrado a un relay en el que tanto Alice como Bob confían
4. El relay almacena el blob (no puede descifrarlo)
5. Cuando Bob se conecta, su Crow recupera los blobs pendientes del relay
6. El Crow de Bob descifra y procesa los datos localmente

### Autenticación

Los relays solo aceptan solicitudes de contactos conocidos:

- Las **solicitudes de almacenamiento** requieren una firma Ed25519 del remitente
- Las **solicitudes de recuperación** requieren una firma Ed25519 más una marca de tiempo reciente (dentro de un margen de 5 minutos) para prevenir ataques de repetición

Los contactos desconocidos o bloqueados son rechazados.

## Encontrar relays

Actualmente, el descubrimiento de relays es manual:

- **Amigos con gateways desplegados en la nube** — Pregunta a tus contactos si operan un relay
- **Listas de la comunidad** — Revisa los canales de la comunidad de Crow en busca de direcciones de relays compartidas

::: info RELAY PREDETERMINADO PLANEADO
Un servicio de relay predeterminado está en la [hoja de ruta](/roadmap) pero aún no se ha desplegado. Por ahora, necesitas usar el gateway de un amigo como relay o desplegar tu propio gateway en la nube con el modo relay habilitado.
:::

Las versiones futuras podrían soportar el descubrimiento automático de relays vía la DHT, permitiendo que Crow encuentre relays cercanos sin configuración manual.

## Modelo de privacidad

Los relays están diseñados para que operar uno revele información mínima sobre los usuarios:

| Lo que el relay ve | Lo que el relay no puede ver |
|---|---|
| La clave pública del remitente | El contenido del mensaje (cifrado) |
| La clave pública del destinatario | Nombres de archivos, texto de memorias, datos de proyectos |
| El tamaño del blob y la marca de tiempo | El tipo de datos que se comparten |
| Cuándo se recuperan los blobs | El contenido o el contexto de la conversación |

Todos los datos compartidos están cifrados de extremo a extremo usando NaCl box (Curve25519 + XSalsa20 + Poly1305). El operador del relay — incluso si se ve comprometido — solo puede ver que se intercambiaron blobs cifrados entre dos claves públicas.

### Confianza en el relay

Agregar un relay significa confiar en que:

- Almacenará tus blobs de forma confiable (no los eliminará antes de tiempo)
- Los entregará al destinatario correcto
- Respetará las cuotas de almacenamiento y el TTL

**No** necesitas confiarle la confidencialidad de tus datos — de eso se encarga el cifrado.

## Configurar relays

### Agregar un relay

Pídele a Crow que agregue un relay:

> "Crow, agrega un relay en wss://my-relay.example"

O agrega el gateway de un amigo como relay de confianza:

> "Agrega el gateway de Alice como relay de confianza: https://alice-crow-server"

### Eliminar un relay

> "Elimina el relay en wss://old-relay.example"

### Ver el estado de los relays

> "Muestra mi configuración de relays"

La herramienta `crow_sharing_status` muestra tus relays actuales, si el modo relay está habilitado en tu gateway y los conteos de blobs pendientes.

## Capacidad y retención

Los relays aplican límites para prevenir abusos:

| Límite | Predeterminado |
|---|---|
| Tamaño máximo de blob | 1 MB |
| Máximo de blobs pendientes por contacto | 100 |
| Retención de blobs (TTL) | 30 días |
| Autenticación | Solicitudes firmadas con Ed25519 |
| Limitación de tasa | Configurable por contacto por hora |

Los blobs expirados se limpian automáticamente. Si un destinatario nunca recupera sus blobs dentro del TTL, los datos se eliminan del relay. El Crow del remitente volverá a poner en cola la entrega la próxima vez que ambos peers estén en línea vía Hyperswarm.

## Comparación con los relays de Nostr

Crow usa dos sistemas de relay distintos para propósitos distintos:

| | Peer Relays | Relays de Nostr |
|---|---|---|
| **Se usan para** | Datos pesados (proyectos, memorias, archivos) | Mensajes ligeros y reacciones |
| **Protocolo** | HTTP REST (autenticación Ed25519) | WebSocket (protocolo Nostr) |
| **Cifrado** | NaCl box (Curve25519) | NIP-44 (ChaCha20-Poly1305) |
| **Descubrimiento** | Configuración manual | Listas de relays públicos |
| **Relays predeterminados** | Ninguno aún (planeado) | `relay.damus.io`, `nos.lol`, `relay.nostr.band` |
| **Quién los opera** | Usuarios de Crow con gateways en la nube | La comunidad de Nostr |

Ambos sistemas comparten la misma identidad de Crow. No necesitas cuentas ni claves separadas.
