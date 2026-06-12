# Capacidades de la plataforma

Crow provee varias capacidades base que cualquier bundle, panel o skill puede usar. Esta página documenta las APIs disponibles para desarrolladores de terceros.

## Reproducción de medios (`window.crowPlayer`)

El Crow's Nest incluye una barra de reproductor de audio persistente que sobrevive a la navegación entre páginas. Cualquier panel puede usarla para reproducir audio.

### API

```js
// Reproducir una sola pista
window.crowPlayer.load(src, title, subtitle?)

// Encolar varias pistas (la reproducción comienza de inmediato)
window.crowPlayer.queue([
  { src: '/api/media/articles/1/audio', title: 'Article 1', subtitle: 'Source' },
  { src: '/api/media/articles/2/audio', title: 'Article 2' },
])

// Agregar al final de la cola actual
window.crowPlayer.addToQueue({ src, title, subtitle })

// Controles de reproducción
window.crowPlayer.toggle()    // Reproducir/pausar
window.crowPlayer.next()      // Pista siguiente
window.crowPlayer.prev()      // Pista anterior (o reiniciar si llevas >3s de reproducción)
window.crowPlayer.close()     // Detener y ocultar el reproductor
window.crowPlayer.isPlaying() // Devuelve un booleano

// Inspeccionar la cola
window.crowPlayer.getQueue()      // Devuelve [{src, title, subtitle}, ...]
window.crowPlayer.getQueueIndex() // Devuelve el índice actual
```

### Características

- **Persistencia**: El estado del reproductor (pista, posición, cola) se guarda en `localStorage` y se restaura al cargar la página. Los usuarios pueden navegar entre paneles sin perder la reproducción.
- **Gestión de la cola**: Avance automático a la siguiente pista en `ended`. El botón de anterior reinicia la pista actual si llevas más de 3 segundos de reproducción.
- **Barra de progreso**: Barra de progreso clicable con indicador de tiempo.
- **Responsivo**: Ajusta su posición en móviles (con la barra lateral oculta).

### Uso desde un panel

Los paneles no necesitan importar nada. El reproductor se inyecta en cada página del dashboard vía el slot `afterContent` del layout:

```js
// En el handler de tu panel:
export default {
  id: 'my-panel',
  async handler(req, res, { layout }) {
    const content = `
      <button onclick="window.crowPlayer.load('/my-audio.mp3', 'My Track')">
        Play Audio
      </button>
    `;
    return layout({ title: 'My Panel', content });
  }
};
```

## Notificaciones

Crow incluye un sistema de notificaciones para mostrar recordatorios, eventos de medios, mensajes de peers y alertas del sistema. Las notificaciones aparecen en el ícono de campana del encabezado en el Crow's Nest y se pueden consultar vía herramientas MCP.

### API REST

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/api/notifications` | GET | Lista las notificaciones (query: `unread_only`, `type`, `limit`, `offset`) |
| `/api/notifications/count` | GET | Conteo ligero + datos de salud (para sondeo) |
| `/api/notifications/:id/dismiss` | POST | Descartar o posponer (body: `snooze_minutes?`) |
| `/api/notifications/:id/read` | POST | Marcar como leída |
| `/api/notifications/dismiss-all` | POST | Descarte masivo (body: `type?`) |

Todos los endpoints requieren autenticación de sesión del dashboard.

### Herramientas MCP

| Herramienta | Descripción |
|------|-------------|
| `crow_check_notifications` | Consulta las notificaciones pendientes (unread_only, type, limit) |
| `crow_create_notification` | Crea una notificación (title, body, type, priority, action_url, metadata, expires_in_minutes) |
| `crow_dismiss_notification` | Descarta o pospone por ID |
| `crow_dismiss_all_notifications` | Descarte masivo (type, before) |
| `crow_notification_settings` | Obtiene/establece las preferencias de notificaciones |

### Crear notificaciones desde bundles

Usa el helper compartido en `servers/shared/notifications.js`:

```js
import { createNotification } from "../../../servers/shared/notifications.js";

await createNotification(db, {
  title: "My event happened",
  body: "Details here",
  type: "system",        // reminder, media, peer, system
  source: "my-bundle",
  priority: "normal",    // low, normal, high
  action_url: "/dashboard/my-panel",
  expires_in_minutes: 60,
});
```

El helper revisa las preferencias del usuario (`notification_prefs` en `dashboard_settings`) y omite los tipos deshabilitados.

### Tipos de notificación

| Tipo | Origen | Descripción |
|------|--------|-------------|
| `reminder` | scheduler, MCP | Recordatorios disparados por una programación o creados por la IA |
| `media` | bundle de medios | Resumen informativo listo, contenido nuevo |
| `peer` | servidor de compartición | Nuevo mensaje de peer recibido |
| `system` | scheduler, media | Errores de feeds, alertas del sistema |

### Retención

- Máximo 500 notificaciones. Al superar el límite, el scheduler limpia primero las descartadas más antiguas y luego las leídas más antiguas.
- Las notificaciones expiradas (las que tienen `expires_at`) se eliminan en cada consulta.
- Las notificaciones pospuestas se ocultan hasta que pase `snoozed_until`.

### Puntos de extensión futuros (v2)

**Temas de notificación:** Renderizado personalizado del ícono de campana/salud. Interfaz:

```js
// Futuro: registrar un tema de notificaciones personalizado
registerNotificationTheme({
  id: 'tamagotchi',
  renderBadge(count) { /* devuelve HTML */ },
  renderDropdown(notifications) { /* devuelve HTML */ },
});
```

**Canales de notificación:** Entrega más allá del dashboard (correo, webhook, Slack). Interfaz:

```js
// Futuro: registrar un canal de entrega
registerNotificationChannel({
  id: 'email',
  async deliver(notification, config) { /* envía el correo */ },
});
```

## Extensión del layout

La función `renderLayout()` acepta varios slots de extensión:

- `afterContent` — HTML renderizado después de `</main>` (lo usa la barra del reproductor en `position:fixed;bottom:0`)
- `headerIcons` — HTML renderizado dentro de `.content-header`, a la derecha del título de la página (lo usan la campana de notificaciones y el estado de salud)
- `scripts` — JS inline adicional agregado al final de la página

Si necesitas más elementos de UI con posición fija, pásalos vía `afterContent` en tu llamada al layout.

## Turbo Drive

El Crow's Nest usa [Turbo Drive](https://turbo.hotwired.dev/) para convertir la navegación entre paneles en un intercambio del body en lugar de una recarga completa de la página. Esto es lo que mantiene visible la barra del reproductor (y el audio sonando) cuando el usuario hace clic entre paneles. También permite que los formularios actualicen la URL correctamente después de enviarse, sin el destello blanco de una recarga completa.

### Cómo habilitarlo

Configura `CROW_ENABLE_TURBO=1` en el gateway:

```bash
# drop-in de systemd
sudo tee /etc/systemd/system/crow-gateway.service.d/turbo.conf > /dev/null <<'EOF'
[Service]
Environment=CROW_ENABLE_TURBO=1
EOF
sudo systemctl daemon-reload && sudo systemctl restart crow-gateway
```

Elimina el drop-in para revertir. Con la bandera apagada, el dashboard se renderiza exactamente igual que antes — toda la navegación son cargas de página completas. Cada pieza de código específico de Turbo en la plataforma es o bien neutral en comportamiento (p. ej., los guards de idempotencia `window.__*`) o está condicionada a la bandera (p. ej., la inyección de `<script src="/vendor/turbo-8.0.5.umd.js">`).

### Qué provee la plataforma

- **Turbo 8.0.5 UMD** está vendorizado en `servers/gateway/public/vendor/turbo-8.0.5.umd.js`. Cuando la bandera está activa, el `<head>` del layout lo inyecta junto con `<meta name="turbo-cache-control" content="no-cache">` y `<meta name="view-transition" content="same-origin">`.
- **El helper `res.redirectAfterPost(url)`** está montado como middleware del gateway y emite un `303 See Other` para que Turbo actualice correctamente la URL del navegador después del POST de un formulario. (Un simple `302 Found` después de un POST hace que Turbo se quede en la URL anterior.)
- **Barra del reproductor persistente**: `#crow-player-bar` y su `<audio>` anidado llevan `data-turbo-permanent`. Turbo los preserva en cada navegación entre paneles, así que el estado del audio (cola, posición, `window.crowPlayer`) sobrevive.
- **Intercepción del límite de autenticación**: un listener de `turbo:before-fetch-response` fuerza una navegación completa con `window.location.href` ante cualquier respuesta `401` o redirección a `/dashboard/login`, lo que evita que una página de login se intercambie dentro del layout autenticado.
- **Permanencia de los iframes con sesión de medios**: los paneles de Jellyfin, Navidrome y Audiobookshelf marcan sus iframes con `data-turbo-permanent id="<panel>-iframe"` para que las sesiones de medios sobrevivan a los cambios de pestaña dentro del mismo panel (alcance estrecho — la navegación entre paneles aún los descarta; dirige a los usuarios hacia paneles nativos como el bundle de Música para reproducción persistente).

### Lo que los autores de paneles necesitan saber

Consulta [Crear paneles → Compatibilidad con Turbo Drive](/es/developers/creating-panels) para la guía completa. Puntos clave:

- Cualquier `<script>` inline dentro del body del panel se vuelve a ejecutar en cada navegación Turbo hacia el panel. Registra los recursos de `setInterval` / `addEventListener` a nivel de documento en globales `window.__*` y limpia el handle anterior al reingresar, o se irán acumulando.
- Los handlers de formularios en rutas `POST`/`PUT`/`PATCH`/`DELETE`/`all`/`use` deben emitir `res.redirectAfterPost(url)` en lugar de `res.redirect(url)`. El codemod `scripts/migrate-redirect-303.js` del gateway aplicó esto en todo el árbol — ejecútalo de nuevo si agregas rutas nuevas y quieres mantener la consistencia.
- Las páginas que cruzan el límite de autenticación (p. ej., el logout) deben poner `data-turbo="false"` en el enlace.

### Depuración

Agrega `?diag=turbo` a cualquier URL del dashboard (con la bandera activa) para abrir un overlay de posición fija que muestra el estado de arranque de Turbo, la disponibilidad de `window.crowPlayer`, las banderas de inicialización de los elementos permanentes, los eventos `turbo:*` recientes del ciclo de vida y cualquier error no capturado. La preferencia se persiste en `localStorage.crowDiagTurbo`. Agrega `?diag=off` para desactivarlo.

## Memoria persistente

Todos los paneles tienen acceso a la base de datos vía el parámetro `db` que se pasa a los handlers de los paneles. Usa la tabla `crow_context` para configuración y la tabla `memories` para datos almacenados.

## Programación de tareas

Crow tiene un sistema de programación integrado (tabla `schedules`). Registra tareas con expresiones cron:

```sql
INSERT INTO schedules (task, cron, config, enabled, created_at)
VALUES ('my-bundle:task', '0 8 * * *', '{"key":"value"}', 1, datetime('now'));
```

Tu ejecutor de tareas sondea la tabla `schedules` en busca de entradas vencidas (`next_run <= now()`).

## Búsqueda web (Brave)

Cuando `BRAVE_API_KEY` está configurada, el servidor MCP de Brave Search está disponible como integración externa. También puedes llamar a la API de Brave directamente:

```js
const res = await fetch('https://api.search.brave.com/res/v1/web/search?q=query', {
  headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY }
});
```

## Almacenamiento (S3/MinIO)

Cuando MinIO está configurado, el servidor de almacenamiento provee subida de archivos, listado, URLs prefirmadas y eliminación. Consulta la documentación de la [API de Almacenamiento](/es/developers/storage-api).

## Compartición P2P

El servidor de compartición provee descubrimiento de peers basado en Hyperswarm, replicación de datos con Hypercore y mensajería cifrada de Nostr. Los bundles pueden compartir datos con los peers usando la herramienta `crow_share`.

## Chat de IA (BYOAI)

El gateway incluye un sistema de chat de IA que soporta múltiples proveedores (OpenAI, Anthropic, Google, Ollama). Configúralo vía `.env` y usa los endpoints `/api/chat/*`. Consulta `servers/gateway/ai/` para el patrón de adaptadores.
