# Servidor de Compartición

El servidor de compartición (`servers/sharing/`) hace posible compartir de forma segura, peer a peer, entre usuarios de Crow. Ofrece tres capacidades centrales:

1. **Compartición de conocimiento** — Transfiere memorias individuales, citas y notas entre usuarios
2. **Colaboración en proyectos** — Otorga acceso continuo de lectura o lectura-escritura a proyectos de investigación
3. **Mensajería social** — Conversaciones cifradas vía el protocolo Nostr

No se requieren cuentas externas ni servidores centrales. Todo corre en la infraestructura del propio usuario.

> Recorridos para el usuario: la [guía de Compartir](/es/guide/sharing) (contactos, invitaciones, mensajería) y la [guía de Compartir Datos](/es/guide/data-sharing) (compartir memorias y proyectos). Esta página cubre los internos.

## Arquitectura

```
┌──────────────────────────────────────────────────┐
│  Capa 5: Aplicaciones                            │
│  ┌────────────┐ ┌──────────┐ ┌────────────┐      │
│  │Conocimiento│ │ Colab. de│ │  Social/   │      │
│  │ compartido │ │ proyectos│ │ Mensajería │      │
│  └────────────┘ └──────────┘ └────────────┘      │
├──────────────────────────────────────────────────┤
│  Capa 4: Protocolo de compartición               │
│  Tipos: memory | project | source | note |       │
│    kb_article | message | reaction               │
│  Permisos: read | read-write | one-time          │
├──────────────────────────────────────────────────┤
│  Capa 3: Sincronización de datos (Hypercore)     │
│  Feeds append-only, consistencia eventual        │
│  Cada par de contactos = dos feeds Hypercore     │
├──────────────────────────────────────────────────┤
│  Capa 2: Descubrimiento y transporte (Hyperswarm)│
│  Descubrimiento de peers en la DHT, holepunching │
│  Streams cifrados, sin servidor central          │
├──────────────────────────────────────────────────┤
│  Capa 1: Identidad y criptografía                │
│  Ed25519 + secp256k1 desde una semilla común     │
│  Crow ID = huella corta de la clave pública      │
└──────────────────────────────────────────────────┘
```

**División tecnológica:**
- **Hypercore + Hyperswarm** — Sincronización pesada de datos (proyectos, memorias en lote, archivos)
- **Nostr** — Capa social ligera (mensajes, reacciones, hilos) vía relays públicos gratuitos
- **Peer relays** — Gateways en la nube, opcionales (opt-in), para entrega asíncrona de datos de Hypercore

## Capa 1: Identidad

Cada instalación de Crow tiene una identidad criptográfica, generada durante `npm run setup`:

- **Semilla maestra**: semilla aleatoria de 32 bytes, cifrada en reposo con una frase de contraseña elegida por el usuario (Argon2id)
- **Par de claves Ed25519**: derivado de la semilla vía HKDF — se usa para los feeds de Hypercore y la autenticación entre peers
- **Par de claves secp256k1**: derivado de la semilla vía HKDF — se usa para los eventos de Nostr y el cifrado
- **Crow ID**: identificador corto y compartible derivado de la clave pública Ed25519 (p. ej., `crow:k3x7f9m2q4`)

La identidad se almacena en `data/identity.json` (ignorado por git). El respaldo se hace con una frase mnemónica BIP39 que se muestra una sola vez durante la configuración.

### Gestión de identidad

| Comando | Propósito |
|---|---|
| `npm run identity` | Muestra tu Crow ID y tus claves públicas |
| `npm run identity:export` | Exporta la identidad cifrada para migrar de dispositivo |
| `npm run identity:import` | Importa la identidad en un dispositivo nuevo |

## Capa 2: Descubrimiento (Hyperswarm)

Los peers se encuentran entre sí a través de la tabla hash distribuida (DHT) de Hyperswarm. No se necesita ningún servidor central de señalización.

- **Topic**: hash determinista de las claves públicas de ambos peers (ordenadas) — cada par de contactos tiene un topic único
- **Atravesar NAT**: el holepunching automático funciona detrás de routers domésticos sin abrir puertos
- **Autenticación**: cada conexión comienza con un intercambio desafío-respuesta usando nonces firmados

Cuando dos peers se descubren en la DHT, Hyperswarm establece entre ellos un stream dúplex cifrado.

## Capa 3: Sincronización de datos (Hypercore)

Los datos compartidos fluyen por feeds append-only de Hypercore:

- Cada relación de contacto tiene **dos feeds** — uno por dirección
- Los feeds se almacenan localmente bajo el directorio de datos, en `peers/<contactId>/out` y `peers/<contactId>/in`
- Las entradas van firmadas por el remitente y cifradas para el destinatario (NaCl box)
- Cuando los peers se conectan vía Hyperswarm, Hypercore sincroniza automáticamente cualquier entrada pendiente
- **Consistencia eventual**: si Alice comparte a las 2pm y Bob se conecta a las 8pm, él recibe todo lo que se perdió

### Formato de las entradas de compartición

```json
{
  "type": "memory",
  "action": "share",
  "payload": {
    "content": "Sourdough starter needs feeding every 12 hours",
    "category": "cooking",
    "tags": "baking, sourdough"
  },
  "permissions": "read",
  "timestamp": "2026-03-07T14:30:00Z",
  "signature": "<Ed25519 signature>"
}
```

## Capa 4: Protocolo de compartición

### Tipos de compartición

| Tipo | Payload | Modelo de sincronización |
|---|---|---|
| `memory` | Una sola memoria | Una vez o continua |
| `project` | Paquete snapshot del proyecto (modo clon) | Entrega de clon de una sola vez |
| `source` | Fuente de investigación con cita | Una vez |
| `note` | Nota de investigación | Una vez |
| `kb_article` | Artículo de la base de conocimiento | Una vez |
| `message` | Texto libre (vía Nostr) | Entrega por relays de Nostr |
| `reaction` | Respuesta a una compartición | Evento de Nostr |

### Modo clon de proyectos

Compartir un proyecto (`crow_share` con `share_type: "project"`) entrega un **paquete snapshot de una sola vez**: los metadatos del proyecto (con una lista de columnas permitidas en el lado emisor — los campos específicos del sistema como `workspace_dir` nunca viajan por la red), sus fuentes, notas, registro de auditoría, manifiestos de backends de datos y manifiesto de almacenamiento. El destinatario crea una copia independiente con un slug `-clone-N`; los cambios posteriores en cualquiera de los dos lados **no** se sincronizan. Si el contacto está sin conexión, la compartición se encola con `mode='clone'` y se reconstruye un paquete fresco al reentregarla. El modo suscripción (sincronización unidireccional en vivo) está planeado para un hito posterior.

### Niveles de permiso

| Permiso | Significado |
|---|---|
| `read` | El destinatario puede ver pero no modificar |
| `read-write` | El destinatario puede agregar al proyecto compartido |
| `one-time` | Los datos se entregan una vez y luego se eliminan del feed |

## Capa 5: Social (Nostr)

Los mensajes y las interacciones sociales usan el protocolo Nostr:

- **Cifrado NIP-44** (ChaCha20-Poly1305) para todos los mensajes directos
- **Gift wraps NIP-59** para el anonimato del remitente en relays públicos
- Los **relays públicos gratuitos** garantizan la entrega asíncrona (los mensajes persisten en los relays hasta que se recogen)
- Relays predeterminados: `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.nostr.band`

La identidad de Nostr (clave secp256k1) se deriva de la misma semilla maestra que la identidad de Hypercore, así que los usuarios tienen un único Crow ID para todo.

### ¿Por qué Nostr para la mensajería?

- **Asíncrono por diseño**: los mensajes persisten en los relays; no hace falta que ambos peers estén en línea
- **Sin cuentas**: la identidad es solo un par de claves — encaja con la filosofía autocontenida de Crow
- **Ligero**: mucho más simple que operar un servidor de Matrix
- **Infraestructura existente**: los relays públicos gratuitos se encargan de la entrega de mensajes

## Sistema de peer relays

Para los datos de Hypercore (más pesados que los mensajes de Nostr), la entrega asíncrona requiere un relay cuando los peers nunca coinciden en línea.

- Cualquier gateway de Crow desplegado en la nube puede **optar por actuar** como relay para sus contactos
- Los relays almacenan blobs cifrados que no pueden leer (cifrados de extremo a extremo para el destinatario)
- No hay un servicio central de relays — es ayuda mutua entre peers
- Las cuotas de almacenamiento y el TTL (30 días por defecto) previenen abusos

### Endpoints del relay

| Endpoint | Propósito |
|---|---|
| `POST /relay/store` | Almacena un blob cifrado para un contacto |
| `GET /relay/fetch` | Recupera los blobs pendientes |

Ambos endpoints requieren autenticación (solicitud firmada con la clave Ed25519 del remitente).

## Herramientas MCP

El servidor registra **33 herramientas**, organizadas en nueve módulos bajo `servers/sharing/tools/`:

| Módulo | Herramientas |
|---|---|
| `contacts.js` | `crow_generate_invite`, `crow_accept_invite`, `crow_list_contacts` |
| `share-inbox.js` | `crow_share` (memorias, proyectos, fuentes, notas, artículos de KB), `crow_inbox` |
| `messaging.js` | `crow_send_message`, `crow_create_message_group`, `crow_list_message_groups`, `crow_send_group_message` |
| `sharing-admin.js` | `crow_revoke_access`, `crow_sharing_status` |
| `discovery.js` | `crow_find_contacts`, `crow_set_discoverable` |
| `instances.js` | `crow_discover_relays`, `crow_add_relay`, `crow_list_instances`, `crow_register_instance`, `crow_update_instance`, `crow_revoke_instance`, `crow_list_sync_conflicts` |
| `rooms-social.js` | `crow_room_invite`, `crow_room_close`, `crow_voice_memo`, `crow_react` |
| `identity.js` | `crow_identity_attest`, `crow_identity_verify`, `crow_identity_revoke`, `crow_identity_list` |
| `crosspost.js` | `crow_list_crosspost_transforms`, `crow_crosspost`, `crow_crosspost_cancel`, `crow_crosspost_mark_published`, `crow_list_crossposts` |

## Modelo de seguridad

### Cifrado

- Todos los datos compartidos van cifrados de extremo a extremo con NaCl box (Curve25519 + XSalsa20 + Poly1305)
- Los mensajes de Nostr usan NIP-44 (ChaCha20-Poly1305)
- La semilla de identidad está cifrada en reposo con una clave derivada con Argon2id

### Seguridad de las invitaciones

- Los códigos de invitación son de **un solo uso** y expiran después de 24 horas
- Los códigos incluyen un HMAC para prevenir manipulaciones
- Tras el handshake, ambos lados muestran un **número de seguridad** (hash del secreto compartido) para verificarlo por un canal independiente

### Seguridad del relay

- Los relays solo aceptan solicitudes firmadas por contactos conocidos
- Cuota de blobs pendientes: máximo 100 blobs almacenados por contacto
- Cuotas de almacenamiento: máximo configurable de almacenamiento por contacto
- Los blobs expiran tras el TTL (30 días por defecto)

### Gestión de contactos

- Los contactos se pueden bloquear, lo que detiene toda replicación y mensajería
- Los contactos bloqueados no pueden volver a invitar (quedan almacenados en la lista de bloqueo)
- La rotación de claves notifica las claves nuevas a todos los contactos

## Tablas de la base de datos

El servidor de compartición agrega estas tablas a la base de datos SQLite compartida:

| Tabla | Propósito |
|---|---|
| `contacts` | Identidades de los peers, claves públicas, estado de relay, última conexión |
| `shared_items` | Seguimiento de comparticiones enviadas/recibidas con sus permisos; la columna `mode` marca los clones de proyecto encolados (`mode='clone'`) para que la reentrega reconstruya un paquete fresco |
| `messages` | Caché local de mensajes de Nostr con estado de lectura |
| `relay_config` | Relays de Nostr y peer relays configurados |
| `relay_blobs` | Blobs cifrados store-and-forward retenidos para destinatarios sin conexión (expiran por TTL) |
| `sync_conflicts` | Conflictos de sincronización multi-instancia pendientes de revisión (ver [Sincronización de Instancias](./instances.md)) |

## Estructura de módulos

```
servers/sharing/
├── server.js          → Orquestador createSharingServer(): construye el contexto
│                        compartido, registra los 9 módulos de herramientas en un orden fijo
├── index.js           → Wrapper de transporte stdio
├── boot.js            → Cableado de arranque: reentrega de la cola de comparticiones
│                        pendientes, inicialización de feeds
├── managers.js        → Propiedad singleton de los managers de peers/sync/relay
├── identity.js        → Generación de claves, Crow ID, códigos de invitación, cifrado
├── peer-manager.js    → Descubrimiento Hyperswarm, gestión de conexiones
├── sync.js            → Gestión de feeds de Hypercore, replicación
├── instance-sync.js   → Replicación multi-instancia (ver instances.md)
├── sync-conflict-resolve.js → Flujo de restauración de conflictos para la vista de
│                        recuperación en Configuración
├── clone-bundle.js    → Construcción del paquete de clonación de proyectos (lista de
│                        columnas permitidas en el lado emisor)
├── rooms.js           → Ciclo de vida de las salas compartidas
├── bot-relay.js       → Relay de mensajes bot a bot
├── tailnet-sync.js    → Sincronización de instancias con transporte tailnet
├── secret-box.js      → Helpers de cifrado NaCl box
├── nostr.js           → Eventos de Nostr, cifrado NIP-44, comunicación con relays
├── relay.js           → Opt-in de peer relay, store-and-forward
└── tools/             → 9 módulos que registran las 33 herramientas MCP (tabla de arriba)
```

El gateway importa `createSharingServer()` y lo conecta al transporte HTTP en `/sharing/mcp` y `/sharing/sse`, siguiendo el mismo patrón que los servidores de memoria y de proyectos.
