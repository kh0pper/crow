# Protocolo de Relay

Este documento describe la arquitectura técnica del sistema de peer relays de Crow — la capa de almacenar-y-reenviar (store-and-forward) que permite la entrega asíncrona de datos de Hypercore entre peers.

## Visión general

El sistema de compartición de Crow usa Hyperswarm para conexiones directas peer-to-peer y Hypercore para la replicación de datos. Ambos requieren que los peers estén en línea simultáneamente. El protocolo de relay agrega un intermediario que retiene los datos cifrados para los destinatarios desconectados.

```
Emisor                    Relay                     Destinatario
  │                         │                          │
  │  POST /relay/store      │                          │
  │  {blob, signature}      │                          │
  │────────────────────────>│                          │
  │                         │  almacena el blob cifrado│
  │                         │                          │
  │                         │   GET /relay/fetch       │
  │                         │   {pubkey, signature}    │
  │                         │<─────────────────────────│
  │                         │                          │
  │                         │   {blobs: [...]}         │
  │                         │─────────────────────────>│
  │                         │                          │
  │                         │  elimina los blobs entregados
```

## Modelo de almacenar-y-reenviar

El relay actúa como un buzón temporal:

1. **Almacenar (store)** — Un emisor envía un blob cifrado dirigido a la clave pública de un destinatario
2. **Retener (hold)** — El relay almacena el blob hasta que el destinatario lo recupera o el TTL expira
3. **Reenviar (forward)** — Cuando el destinatario se conecta y se autentica, se le entregan todos los blobs pendientes
4. **Limpieza (cleanup)** — Los blobs entregados se eliminan de inmediato; los blobs expirados se purgan periódicamente

El relay nunca descifra, inspecciona ni modifica el contenido de los blobs. Es un simple conducto con autenticación.

## Formato de mensajes

### Solicitud de almacenamiento (store)

```
POST /relay/store
Content-Type: application/json

{
  "recipient": "<clave pública Ed25519 en hex>",
  "blob": "<datos cifrados, base64 o JSON>",
  "signature": "<firma Ed25519 en hex>",
  "senderPubkey": "<clave pública Ed25519 en hex>"
}
```

La `signature` cubre `JSON.stringify({ recipient, blob })`, lo que prueba que el emisor es el autor de la solicitud.

El campo `blob` contiene datos cifrados con NaCl box (Curve25519 + XSalsa20 + Poly1305) para la clave pública del destinatario. El relay no puede descifrarlo.

### Solicitud de recuperación (fetch)

```
GET /relay/fetch?pubkey=<hex>&signature=<hex>&timestamp=<ms>
```

La `signature` cubre `"<pubkey>:<timestamp>"`. El timestamp debe estar dentro de los 5 minutos del reloj del relay para prevenir ataques de repetición (replay).

### Respuesta de recuperación

```json
{
  "blobs": [
    {
      "blob": "<datos cifrados>",
      "sender": "<clave pública Ed25519 del emisor en hex>",
      "timestamp": 1741782600000
    }
  ],
  "count": 1
}
```

Todos los blobs coincidentes se devuelven en una sola respuesta y se eliminan del relay.

## Garantías de entrega

El protocolo de relay ofrece **entrega eventual de mejor esfuerzo (best-effort)**:

- **Sin orden garantizado** — Los blobs de múltiples emisores pueden llegar en cualquier orden
- **A lo sumo una vez desde el relay** — Una vez recuperados, los blobs se eliminan; el relay no los vuelve a entregar
- **Entrega eventual vía Hypercore** — Si la entrega por relay falla (el TTL expira, el relay se cae), Hypercore sincroniza los datos directamente cuando ambos peers están en línea vía Hyperswarm
- **Sin protocolo de acuse de recibo** — El emisor no recibe confirmación de que el destinatario recuperó el blob

El relay es una capa de optimización, no el mecanismo de entrega principal. Los feeds append-only de Hypercore aseguran que los datos nunca se pierdan — el relay solo acelera la entrega cuando los peers tienen ventanas de conexión que no se superponen.

### Escenarios de fallo

| Escenario | Resultado |
|---|---|
| El relay está caído cuando el emisor almacena | El emisor reintenta o espera la sincronización por Hyperswarm |
| El relay está caído cuando el destinatario recupera | El destinatario reintenta más tarde o espera la sincronización por Hyperswarm |
| El blob expira antes de recuperarse (TTL de 30 días) | Los datos se eliminan del relay; la sincronización por Hyperswarm se encarga de la entrega |
| El relay pierde datos (crash, fallo de disco) | Sin pérdida de datos — los feeds de Hypercore son la fuente de la verdad |
| El relay es comprometido | El atacante ve blobs cifrados pero no puede descifrarlos |

## Descubrimiento de relays

### Actual: configuración manual

Los relays los configura explícitamente el usuario:

- Vía conversación con la IA: *"Agrega un relay en https://relay.example.com"*
- Se almacenan en la tabla de base de datos `relay_config` con `relay_type = 'peer'`

Cada entrada de relay incluye:

| Campo | Descripción |
|---|---|
| `relay_url` | URL completa del endpoint del relay |
| `relay_type` | `'peer'` para relays de Hypercore, `'nostr'` para relays de mensajes |
| `enabled` | Si el relay está activo |

### Relay predeterminado

Hay un servicio de relay predeterminado planeado, pero aún no está desplegado. Actualmente, los usuarios deben configurar sus propios relays — ya sea el gateway de un amigo con el modo relay habilitado, o un gateway en la nube auto-alojado.

### Futuro: descubrimiento automático vía DHT

Una mejora planeada permitirá que Crow descubra relays automáticamente a través del DHT de Hyperswarm:

1. Los operadores de relays anuncian su disponibilidad en un topic DHT bien conocido
2. Los clientes de Crow consultan el topic para encontrar relays disponibles
3. Los clientes seleccionan relays según latencia, capacidad y preferencias de confianza

Esto aún no está implementado. El descubrimiento de relays actual es únicamente manual.

## Límites de capacidad y retención

### Valores predeterminados por relay

| Parámetro | Valor | Configurable |
|---|---|---|
| Tamaño máximo de blob | 1 MB | Sí (operador del relay) |
| Máximo de blobs pendientes por destinatario | 100 | Sí (operador del relay) |
| TTL de blob | 30 días | Sí (operador del relay) |
| Cuota de blobs pendientes | 100 blobs por contacto (sin límite por hora) | Sí (operador del relay) |

### Aplicación de cuotas

- **Las solicitudes de almacenamiento** que exceden el límite de tamaño de blob reciben `413 Payload Too Large`
- **Las solicitudes de almacenamiento** que exceden el conteo de blobs por destinatario reciben `429 Too Many Requests`
- **Los blobs expirados** se purgan mediante una rutina de limpieza periódica (`cleanupExpiredBlobs()`)

### Consideraciones de almacenamiento

Un relay con 100 contactos, cada uno con 100 blobs pendientes de 1 MB, usaría aproximadamente 10 GB de almacenamiento. En la práctica, el uso es mucho menor — la mayoría de los blobs se entregan en cuestión de horas y se eliminan.

La implementación actual usa un almacén en memoria (`Map`). Un relay en producción debería usar almacenamiento persistente (SQLite o similar) para sobrevivir reinicios.

## Modelo de autenticación

Todos los endpoints del relay requieren autenticación con firmas Ed25519:

### Autenticación de almacenamiento (store)

1. El emisor construye `message = JSON.stringify({ recipient, blob })`
2. El emisor firma `message` con su clave privada Ed25519
3. El relay verifica la firma contra `senderPubkey`
4. El relay comprueba que `senderPubkey` pertenece a un contacto conocido

### Autenticación de recuperación (fetch)

1. El destinatario construye `message = "<pubkey>:<timestamp>"`
2. El destinatario firma `message` con su clave privada Ed25519
3. El relay verifica la firma contra `pubkey`
4. El relay comprueba que `timestamp` está dentro de los 5 minutos de la hora del servidor (protección contra repetición)

### Modelo de confianza

Los relays solo atienden a contactos autenticados. Una clave pública desconocida no puede almacenar ni recuperar blobs. Esto previene:

- **Spam** — Partes anónimas no pueden llenar el relay con datos basura
- **Enumeración** — Las solicitudes no autenticadas no pueden descubrir qué claves públicas tienen blobs pendientes
- **Abuso** — Se aplica una cuota de blobs pendientes por contacto autenticado

## Implementación

El relay está implementado en `servers/sharing/relay.js` y expone dos manejadores de rutas de Express vía `createRelayHandlers()`:

- `store(req, res)` — Valida, autentica y almacena un blob
- `fetch(req, res)` — Autentica y devuelve todos los blobs pendientes del solicitante

El gateway los monta en `/relay/store` y `/relay/fetch` cuando el modo relay está habilitado.

### Dependencias del módulo

```
servers/sharing/relay.js
  └── servers/sharing/identity.js (función verify para firmas Ed25519)
```

### Módulos relacionados

| Módulo | Rol en el sistema de relay |
|---|---|
| `servers/sharing/relay.js` | Lógica de almacenar-y-reenviar, manejadores de Express |
| `servers/sharing/identity.js` | Gestión de claves Ed25519, verificación de firmas |
| `servers/sharing/peer-manager.js` | Descubrimiento por Hyperswarm (P2P directo, sin relay) |
| `servers/sharing/sync.js` | Replicación de Hypercore (P2P directo, sin relay) |
| `servers/sharing/server.js` | Herramientas MCP, incluida `crow_sharing_status` (toggle de relay_enabled) |
