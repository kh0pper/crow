---
title: Notificaciones y Push
---

# Notificaciones y Push

Crow tiene un sistema unificado de notificaciones que entrega alertas de llamadas, mensajes, recordatorios, novedades de medios y eventos del sistema. Las notificaciones aparecen en el dashboard del Crow's Nest, en tu teléfono vía push y a través del chat de IA.

## Tipos de notificación

| Tipo | Ícono | Ejemplos |
|------|------|----------|
| `reminder` | Campana | Recordatorios programados, tareas recurrentes |
| `media` | Periódico | Nuevos episodios de podcast, elementos RSS, briefings |
| `peer` | Globo de diálogo | Mensajes entrantes, elementos compartidos, invitaciones a llamadas |
| `system` | Engranaje | Instalación de extensiones, actualizaciones, resultados de respaldos |

Cada notificación tiene una **prioridad** (baja, normal, alta) que afecta el orden de visualización y la urgencia del push.

## Dónde aparecen las notificaciones

### Campana del dashboard / Tamagotchi

El indicador de notificaciones en el encabezado del Crow's Nest muestra el conteo de no leídas. Haz clic en él para ver las notificaciones recientes en un menú desplegable. Cada notificación se puede abrir con un clic (navega a su `action_url`) o descartar.

El sondeo se ejecuta cada 60 segundos y aprovecha el mismo viaje para incluir datos de salud del sistema (CPU, RAM, disco) y así evitar solicitudes adicionales.

### Aviso de llamada entrante

Cuando alguien te llama, aparece un banner que se desliza desde arriba en cualquier página del Crow's Nest, con botones de **Aceptar** y **Descartar**. El aviso se descarta automáticamente después de 60 segundos. Consulta [Llamadas](/es/guide/calls) para más detalles.

### Chat de IA

Pregúntale a Crow por tus notificaciones:

> "Revisa mis notificaciones"
> "¿Hay mensajes nuevos?"
> "Descarta todas las notificaciones leídas"

Las herramientas `crow_check_notifications` y `crow_dismiss_notification` se encargan de esto.

## Preferencias de notificación

Ve a **Ajustes > Notificaciones** en el Crow's Nest para controlar qué tipos recibes:

- Activa o desactiva cada tipo de forma independiente (reminder, media, peer, system)
- Los tipos desactivados se descartan silenciosamente antes de llegar a la base de datos

## Web Push

Las notificaciones push del navegador entregan alertas incluso cuando la pestaña del Crow's Nest está cerrada. Configuración:

1. Ve a **Ajustes > Notificaciones** en el Crow's Nest
2. Haz clic en **Activar notificaciones push**
3. Acepta la solicitud de permiso del navegador
4. Listo. Las notificaciones llegan como notificaciones nativas del sistema operativo.

Web Push usa el protocolo VAPID. Genera las claves una sola vez:

```bash
npx web-push generate-vapid-keys
```

Agrega las claves a tu `.env`:

```
VAPID_PUBLIC_KEY=BLx...
VAPID_PRIVATE_KEY=abc...
VAPID_EMAIL=mailto:you@example.com
```

### Cómo funciona

Cuando se ejecuta `createNotification()` (desde cualquier herramienta MCP, el scheduler o el manejador de mensajes de peers), hace lo siguiente:

1. Inserta la notificación en la base de datos
2. Envía un Web Push a todas las suscripciones de navegador registradas
3. Envía un push de ntfy si está configurado (ver más abajo)

Toda la entrega de push es no bloqueante y de tipo "dispara y olvida". Un push fallido nunca bloquea la acción principal.

## Bundle de ntfy

[ntfy](https://ntfy.sh) es un servidor ligero de notificaciones push. El bundle de ntfy de Crow ejecuta una instancia autoalojada junto a tu gateway, entregando notificaciones instantáneas a cualquier dispositivo con la app de ntfy.

### ¿Por qué ntfy?

- Funciona cuando el navegador está cerrado y la app de Crow está en segundo plano
- No requiere la infraestructura de push de Google/Apple (es autoalojado)
- Entrega en menos de un segundo
- Instala la app gratuita de ntfy en Android (Play Store / F-Droid) o iOS (App Store)

### Instalación

Instálalo desde la página de Extensiones o por CLI:

```bash
crow bundle install ntfy
```

### Configuración

| Variable | Predeterminado | Descripción |
|----------|---------|-------------|
| `NTFY_TOPIC` | `crow` | Nombre del topic (único para tu instancia) |
| `NTFY_PORT` | `2586` | Puerto del servidor (solo localhost) |
| `NTFY_AUTH_TOKEN` | *(vacío)* | Token de acceso para topics privados |

### Configuración del teléfono

1. Instala la app de ntfy en tu teléfono
2. En la app, agrega un servidor: `http://<your-tailscale-ip>:2586`
3. Suscríbete a tu topic (predeterminado: `crow`)
4. Todas las notificaciones de Crow ahora llegan al instante a tu teléfono

### Mapeo de prioridades

Las prioridades de notificación de Crow se corresponden con niveles de urgencia de ntfy:

| Crow | ntfy | Comportamiento |
|------|------|----------|
| `low` | 2 (low) | Entrega silenciosa |
| `normal` | 3 (default) | Notificación estándar |
| `high` | 5 (urgent) | Ignora el modo No molestar |

### Etiquetas

Los tipos de notificación se corresponden con tags de emoji de ntfy:

| Tipo | Tag | Emoji |
|------|-----|-------|
| `peer` | `incoming_envelope` | Sobre |
| `reminder` | `alarm_clock` | Despertador |
| `system` | `gear` | Engranaje |
| `media` | `musical_note` | Nota musical |

### Acciones al hacer clic

Cada notificación de ntfy incluye una URL de clic que abre la página relevante en tu Crow's Nest (el `action_url` de la notificación con la URL de tu gateway antepuesta).

## Retención de notificaciones

- Se retienen un máximo de 500 notificaciones
- Las notificaciones expiradas se limpian automáticamente
- Al superar el límite, primero se eliminan las notificaciones descartadas y luego las leídas más antiguas

## API de notificaciones

El Crow's Nest expone una API REST para notificaciones (autenticada vía sesión del dashboard):

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/api/notifications` | GET | Lista las notificaciones (query: `unread_only`, `type`, `limit`, `offset`) |
| `/api/notifications/count` | GET | Conteo ligero + salud del sistema (para sondeo) |
| `/api/notifications/:id/dismiss` | POST | Descartar o posponer (body: `snooze_minutes`) |
| `/api/notifications/:id/read` | POST | Marcar como leída |
| `/api/notifications/dismiss-all` | POST | Descarte masivo (body: `type` para filtrar) |
