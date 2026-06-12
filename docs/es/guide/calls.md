---
title: Llamadas de video y audio
---

# Llamadas de video y audio

Haz llamadas peer-to-peer de video y audio entre instancias de Crow. Las llamadas usan WebRTC para los medios y el relay WebSocket del gateway para la señalización. Sin servidores de terceros, sin cuentas, ningún dato sale de tu red.

## Requisitos

- La extensión **Calls** instalada en ambas instancias (página de Extensiones o `crow bundle install calls`)
- Ambas instancias alcanzables por la red (se recomienda Tailscale)
- Un navegador moderno con soporte de WebRTC (Chrome, Firefox, Safari, Edge)
- HTTPS requerido para el acceso a cámara/micrófono (HTTPS de Tailscale o un reverse proxy)

## Iniciar una llamada

### Desde el panel Calls

1. Abre **Calls** en la barra lateral del Crow's Nest
2. Tus contactos aparecen con un botón **Call** junto a cada uno
3. Haz clic en **Call** para crear una sala y enviar una invitación vía Nostr
4. Se abre una pestaña nueva con la página de la llamada. Haz clic en **Join Call** para conectar tu micrófono y cámara

### Desde la IA

> "Llama a Alice"
> "Inicia una videollamada con Bob"

La IA usa la herramienta `crow_room_invite` para crear una sala y enviar la invitación.

### Vía enlace directo

Cada sala de llamada tiene una URL compartible:

```
https://your-instance.ts.net:8444/calls?room=abc123&token=xyz
```

Comparte este enlace por cualquier canal. Cualquiera con el enlace y el token puede unirse.

## Recibir una llamada

Cuando alguien te llama, suceden tres cosas:

### 1. Banner emergente

Un banner deslizante aparece en la parte superior de cualquier página del Crow's Nest:

```
+---------------------------------------------------+
|  Alguien te está llamando...    [Aceptar] [Descartar] |
+---------------------------------------------------+
```

- **Aceptar** abre la llamada en una pestaña nueva
- **Descartar** elimina la notificación
- Se descarta automáticamente después de 60 segundos

El banner aparece cuando la campana de notificaciones detecta nuevas invitaciones de llamada durante su ciclo de sondeo de 60 segundos. Para una entrega más rápida, usa Web Push o el bundle de ntfy.

### 2. Notificación push

Si tienes configurado [Web Push](/es/guide/notifications) o [ntfy](/es/guide/notifications), recibes una notificación instantánea en tu teléfono o escritorio. Al tocarla se abre directamente la página de la llamada.

### 3. Panel Calls

La sección **Incoming** en la parte superior del panel Calls muestra las invitaciones de llamada no descartadas de la última hora con un botón **Join**.

## Controles durante la llamada

Una vez en una llamada:

| Control | Acción |
|---------|--------|
| Alternar micrófono | Silenciar/activar tu audio |
| Alternar cámara | Iniciar/detener el video |
| Compartir pantalla | Comparte tu pantalla (navegadores de escritorio) |
| Colgar | Salir de la llamada |

El audio se inicia automáticamente cuando te unes. El video está apagado por defecto hasta que lo actives.

## Cómo funciona

```
Llamante                        Receptor
  |                               |
  |-- POST /api/rooms ----------->|  (crea la sala + envía la invitación Nostr)
  |                               |
  |-- WebSocket /calls/ws ------->|  (relay de señalización)
  |<- WebSocket /calls/ws --------|
  |                               |
  |<======= WebRTC P2P =========>|  (audio/video directo)
```

1. El llamante crea una sala vía `POST /api/rooms`, lo que genera un código de sala y un token
2. Un mensaje Nostr cifrado entrega la URL de la llamada al receptor
3. Ambos navegadores se conectan al relay de señalización WebSocket del gateway
4. El relay intermedia el intercambio de oferta/respuesta de WebRTC
5. Una vez que la negociación ICE se completa, el audio y el video fluyen directamente entre los navegadores

Todos los medios son peer-to-peer. El gateway solo maneja la señalización (gestión de salas e intercambio SDP). En redes Tailscale, STUN suele ser suficiente para atravesar NAT.

## Seguridad de las salas

- Cada sala tiene un código aleatorio de 12 caracteres y un token de autenticación separado
- El relay de señalización valida el token antes de aceptar conexiones WebSocket
- No se permiten conexiones sin token
- Los tokens de sala se generan por llamada y expiran a las 24 horas; dentro de esa ventana el token admite uniones solo a esa sala

## Llamadas con varios participantes

Las salas soportan hasta 4 participantes por defecto (configurable vía `CROW_CALLS_MAX_PEERS`). Cada participante establece una conexión WebRTC con cada uno de los demás participantes (topología de malla).

## Integración con el Companion

Cuando el bundle del [AI Companion](/es/architecture/companion) también está instalado, la página de Calls gana modos adicionales:

- **Modo avatar** — el avatar Live2D del companion se une a la llamada como participante de video
- **Seguimiento facial** — el avatar refleja tus expresiones vía webcam

Estos modos aparecen como botones adicionales en la página de la llamada cuando ambos bundles están activos.

## Configuración

| Variable | Predeterminado | Descripción |
|----------|---------|-------------|
| `CROW_CALLS_ENABLED` | `1` | Habilita la señalización de llamadas en el gateway |
| `CROW_CALLS_MAX_PEERS` | `4` | Máximo de participantes por sala |

## Solución de problemas

**¿No hay audio ni video?**
- Verifica que estés usando HTTPS (requerido para `getUserMedia`)
- Verifica que ambas instancias puedan alcanzarse por la red
- Revisa la consola del navegador en busca de errores ICE de WebRTC

**¿No llega la invitación de llamada?**
- Verifica que los relays de Nostr estén conectados (busca `[nostr] Subscribed` en los registros del gateway)
- Verifica que el receptor tenga al llamante como contacto

**¿"Join Call" no hace nada?**
- Revisa la consola del navegador en busca de errores de conexión WebSocket
- Verifica que el endpoint de señalización sea accesible: `wss://your-instance.ts.net:8444/calls/ws`
