---
title: Crear paneles
---

# Crear paneles del Crow's Nest

Construye paneles personalizados que aparecen en el Crow's Nest junto a los paneles integrados de Mensajes, Blog, Archivos y Configuración.

## ¿Qué es esto?

Un panel del Crow's Nest es un pequeño complemento que agrega una página nueva al Crow's Nest. Los paneles son HTML renderizado en el servidor — escribes una función handler que recibe la base de datos y el sistema de layout, y devuelve contenido HTML.

## ¿Por qué querría esto?

- **Vistas personalizadas** — Construye un panel que muestre datos de una integración (p. ej., tu calendario, lista de tareas o analíticas)
- **Herramientas de flujo de trabajo** — Agrega un panel para acciones comunes específicas de tu configuración
- **Comparte con otros** — Publica tu panel para que la comunidad de Crow lo use

## Estructura de un panel

Un panel es un único archivo JS en `~/.crow/panels/<id>.js`, opcionalmente acompañado de un archivo `<id>-routes.js` que registra rutas Express adicionales:

```
~/.crow/panels/
  weather.js          # Manifiesto y handler del panel
  weather-routes.js   # Rutas complementarias opcionales (endpoints POST, etc.)
```

El ID del panel (el nombre de archivo sin `.js`) debe coincidir con `[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}` y debe estar listado en `~/.crow/panels.json` para cargarse.

## Manifiesto del panel

El archivo del panel exporta un objeto manifiesto:

```js
export default {
  id: 'weather',
  name: 'Weather',
  icon: 'cloud',
  route: '/dashboard/weather',
  navOrder: 50,
  handler: async (req, res, { db, layout }) => {
    const content = `
      <h1>Weather Panel</h1>
      <p>Your custom content here.</p>
    `;
    return layout({ title: 'Weather', content });
  }
};
```

### Campos del manifiesto

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | string | Identificador único. Debe coincidir con el nombre del archivo (sin `.js`). |
| `name` | string | Nombre que se muestra en la barra de navegación. |
| `icon` | string | Identificador de icono (usado en la navegación). |
| `route` | string | Ruta de URL. Debe comenzar con `/dashboard/`. |
| `navOrder` | number | Posición en la barra de navegación. Los paneles integrados usan 1–80; usa un valor más alto (p. ej. 100+) para colocar el tuyo después de ellos. |
| `handler` | function | Handler de ruta Express. Recibe `(req, res, context)`. |

### Visibilidad en la pantalla de inicio

Los paneles aparecen automáticamente como mosaicos en la pantalla de inicio del Crow's Nest Y en la navegación de la barra lateral. Para ocultar un panel de ambas, establece `hidden: true` en el manifiesto:

```js
export default {
  id: "my-panel",
  name: "My Panel",
  hidden: true, // Oculto de la barra lateral y la pantalla de inicio
  // ...
};
```

La ruta del panel sigue funcionando para el acceso directo por URL — `hidden` solo afecta la visibilidad en la navegación.

## Contexto del handler

La función `handler` recibe tres argumentos:

### req / res

Objetos estándar de solicitud y respuesta de Express. La solicitud ya pasó las verificaciones de autenticación y CSRF.

### context.db

El cliente de la base de datos de Crow. Úsalo para consultar cualquier tabla de Crow:

```js
const memories = await db.execute('SELECT * FROM memories ORDER BY created_at DESC LIMIT 10');
```

Todos los métodos estándar de `@libsql/client` están disponibles (`execute`, `batch`, etc.).

### context.appRoot

La ruta absoluta al directorio raíz del código fuente de Crow. Úsala para importar dinámicamente módulos compartidos como logos SVG o componentes de UI:

```js
const { getAddonLogo } = await import(
  join(appRoot, 'servers/gateway/dashboard/shared/logos.js')
);
const logo = getAddonLogo('ollama', 32);
```

Esto es especialmente útil para paneles de terceros que necesitan acceso a los componentes compartidos integrados sin escribir rutas fijas en el código.

### context.lang

El idioma del panel de control del operador (`"en"` o `"es"`), leído de Configuración → Idioma. Úsalo para localizar los textos de tu panel:

```js
handler: async (req, res, { db, layout, lang }) => {
  const title = lang === 'es' ? 'Clima' : 'Weather';
  // ...
}
```

### context.layout

La función layout envuelve tu contenido en el shell del Crow's Nest (navegación, tema, pie de página):

```js
return layout({ title: pageTitle, content: htmlContent });
```

Opciones:

| Opción | Tipo | Descripción |
|---|---|---|
| `title` | string | Título de la página que se muestra en el encabezado y en la pestaña del navegador. |
| `content` | string | Contenido HTML principal para el cuerpo de la página. |
| `activePanel` | string | ID del panel a resaltar en la navegación. |
| `panels` | Array | Arreglo de objetos de panel para la barra lateral de navegación. |
| `theme` | string | Fuerza `'dark'` o `'light'`. Usualmente se omite (usa la preferencia del usuario). |
| `scripts` | string | JS en línea adicional para incluir en la página. |
| `afterContent` | string | HTML renderizado después de `</main>` dentro del dashboard (p. ej., barras de posición fija). |

### Reproductor global (`window.crowPlayer`)

Cada página del dashboard incluye una barra de reproductor de audio persistente. Tu panel puede usarla para reproducir audio sin construir su propio reproductor:

```js
// Reproducir una sola pista
window.crowPlayer.load('/my-audio.mp3', 'Track Title', 'Subtitle');

// Poner varias pistas en cola
window.crowPlayer.queue([
  { src: '/track1.mp3', title: 'Track 1' },
  { src: '/track2.mp3', title: 'Track 2' },
]);
```

Consulta [Capacidades de la plataforma](/es/developers/platform-capabilities) para la referencia completa de la API.

## Ejemplo: panel de estadísticas de memoria

Un panel que muestra estadísticas del almacenamiento de memorias:

```js
export default {
  id: 'memory-stats',
  name: 'Memory Stats',
  icon: 'bar-chart',
  route: '/dashboard/memory-stats',
  navOrder: 51,
  handler: async (req, res, { db, layout }) => {
    const stats = await db.execute(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN created_at > datetime('now', '-7 days') THEN 1 END) as this_week,
        COUNT(CASE WHEN created_at > datetime('now', '-1 day') THEN 1 END) as today
      FROM memories
    `);

    const row = stats.rows[0];

    const content = `
      <h1>Memory Statistics</h1>
      <div class="stats-grid">
        <div class="stat-card">
          <span class="stat-value">${row.total}</span>
          <span class="stat-label">Total Memories</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${row.this_week}</span>
          <span class="stat-label">This Week</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${row.today}</span>
          <span class="stat-label">Today</span>
        </div>
      </div>
      <style>
        .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
        .stat-card { background: var(--crow-bg-elevated); padding: 1.5rem; border-radius: 8px; text-align: center; }
        .stat-value { display: block; font-size: 2rem; font-weight: bold; color: var(--crow-accent); }
        .stat-label { display: block; margin-top: 0.5rem; color: var(--crow-text-secondary); }
      </style>
    `;

    return layout({ title: 'Memory Stats', content });
  }
};
```

## Manejo de formularios

Los paneles pueden incluir formularios para la interacción del usuario. Las rutas POST están soportadas:

```js
export default {
  id: 'quick-note',
  name: 'Quick Note',
  icon: 'edit',
  route: '/dashboard/quick-note',
  navOrder: 52,
  handler: async (req, res, { db, layout }) => {
    if (req.method === 'POST') {
      const { note } = req.body;
      await db.execute({
        sql: 'INSERT INTO memories (content, context) VALUES (?, ?)',
        args: [note, 'quick-note-panel']
      });
      return res.redirect('/dashboard/quick-note?saved=1');
    }

    const saved = req.query.saved ? '<p class="success">Note saved.</p>' : '';

    const content = `
      <h1>Quick Note</h1>
      ${saved}
      <form method="POST" action="/dashboard/quick-note">
        <input type="hidden" name="_csrf" value="${req.csrfToken}" />
        <textarea name="note" rows="4" placeholder="Type a note..."></textarea>
        <button type="submit">Save</button>
      </form>
    `;

    return layout({ title: 'Quick Note', content });
  }
};
```

Observa el campo oculto `_csrf` — todas las solicitudes POST requieren un token CSRF válido.

## Crear notificaciones

Los paneles pueden crear notificaciones vía el helper compartido. Esto es útil para confirmar acciones del usuario o alertar sobre eventos en segundo plano:

```js
import { createNotification } from "../../shared/notifications.js";

// Dentro de tu handler:
await createNotification(db, {
  title: "Report generated",
  type: "system",
  source: "my-panel",
  action_url: "/dashboard/my-panel",
});
```

El helper respeta las preferencias de notificación del usuario establecidas en Configuración.

## Habilitar tu panel

Después de colocar tu panel en `~/.crow/panels/`, agrégalo a `~/.crow/panels.json` (un arreglo JSON de IDs de panel):

```json
["memory-stats", "quick-note"]
```

Reinicia el gateway para que detecte los paneles nuevos.

## Estilos

Usa las propiedades CSS personalizadas del Crow's Nest para un tema consistente:

- `--crow-bg-deep` / `--crow-bg-surface` / `--crow-bg-elevated` — Capas de fondo (página, tarjeta, elevado)
- `--crow-text-primary` / `--crow-text-secondary` / `--crow-text-muted` — Jerarquía de texto
- `--crow-accent` / `--crow-accent-hover` / `--crow-accent-muted` — Acento índigo y variantes
- `--crow-brand-gold` — Acento dorado para detalles de marca
- `--crow-border` — Color de borde
- `--crow-success` / `--crow-error` / `--crow-info` — Colores semánticos

Estas se adaptan automáticamente a los modos oscuro y claro. Consulta la sección de [identidad de marca](/es/architecture/dashboard) para la tabla completa de tokens.

## Pruebas locales

1. Guarda tu panel como `~/.crow/panels/<id>.js`
2. Habilítalo en `~/.crow/panels.json`
3. Inicia el gateway: `npm run gateway`
4. Abre `http://localhost:3001/dashboard/<id>`

## Compatibilidad con Turbo Drive

El Crow's Nest navega entre paneles con [Turbo Drive](https://turbo.hotwired.dev/) cuando `CROW_ENABLE_TURBO=1` está configurado en el gateway. Turbo hace un fetch HTTP, intercambia el contenido de `<main>` en el body y mantiene en su lugar el `<head>` + la barra lateral + la barra del reproductor persistente. Los paneles normales funcionan sin cambios, pero algunos patrones requieren cuidado:

### Scripts en línea idempotentes

Cualquier etiqueta `<script>` que tu panel emita dentro del body **se vuelve a ejecutar en cada navegación de Turbo hacia el panel**. Si adjunta listeners a `document` / `window`, inicia un `setInterval`, abre un `WebSocket` o asigna cualquier recurso que no sea propiedad de un elemento dentro de la raíz del panel, habrá fugas (listeners apilados, pollers multiplicados) cada vez que el usuario lo visite.

La solución idiomática es rastrear el recurso en un global `window.__myPanel*` y limpiar el anterior al volver a entrar:

```js
<script>
(function() {
  // Limpia cualquier intervalo previo (de una navegación anterior a este panel)
  if (window.__myPanelPollInterval) {
    clearInterval(window.__myPanelPollInterval);
    window.__myPanelPollInterval = null;
  }

  async function poll() {
    var root = document.getElementById('my-panel-root');
    if (!root || !root.isConnected) {
      // El panel fue intercambiado — autocancelarse
      clearInterval(window.__myPanelPollInterval);
      window.__myPanelPollInterval = null;
      return;
    }
    // ... fetch + render
  }

  poll();
  window.__myPanelPollInterval = setInterval(poll, 10000);
})();
</script>
```

**Los listeners a nivel de elemento** (handlers de clic en botones dentro de la raíz del panel) no necesitan ninguna protección — se adjuntan a un DOM nuevo en cada navegación y se recolectan automáticamente junto con el body anterior cuando Turbo hace el intercambio.

**Los listeners a nivel de documento** (p. ej., `document.addEventListener('keydown', ...)` para un handler de cerrar-el-modal-con-escape) deben adjuntarse una sola vez por vida del documento con una bandera `window.__myBound`, y el callback debe buscar el DOM actual mediante IDs en lugar de capturar elementos específicos en el closure.

### 303-después-de-POST para respuestas de formularios

Turbo trata un `302 Found` después de un POST de formulario como "permanecer en la URL actual". Para que un envío actualice correctamente la URL del navegador, responde con `303 See Other`. El gateway expone `res.redirectAfterPost(url)` como helper:

```js
if (req.method === "POST" && req.body.action === "save") {
  await saveIt(req.body);
  return res.redirectAfterPost("/dashboard/my-panel?saved=1");
}
```

Para rutas `router.get(...)` (redirecciones GET-después-de-GET), un `res.redirect(url)` normal está bien — Turbo trata correctamente un 302 después de un GET.

### Válvula de escape: `data-turbo="false"`

Para excluir de Turbo por completo un enlace o formulario específico, establece `data-turbo="false"`:

```html
<a href="/dashboard/logout" data-turbo="false">Logout</a>
```

Este es el patrón para los enlaces de frontera de autenticación (logout, login). El gateway también intercepta las respuestas `401`, redirige a `/dashboard/login` y fuerza una recarga completa vía `turbo:before-fetch-response`, así que la expiración de sesión siempre se maneja de forma segura.

### Paneles que embeben iframes

Varios paneles de bundles (Jellyfin, Navidrome, Audiobookshelf, Paperless, Vaultwarden, Calibre-Web, Gitea, Stirling-PDF, Netdata, etc.) embeben una interfaz web de terceros dentro de un `<iframe>`. **Con Turbo, navegar a un panel diferente descarta el iframe**, y al volver se vuelve a crear — lo que significa que el video de Jellyfin se reinicia en 0:00, la sesión de Vaultwarden puede caerse y el reproductor en el navegador de Navidrome se detiene.

El comportamiento pre-Turbo era idéntico (la recarga completa de página también mataba el iframe), pero Turbo hace que alternar entre paneles se sienta instantáneo, lo que anima a los usuarios a cambiar de panel con más frecuencia. Tres iframes con sesión de medios (`jellyfin`, `navidrome`, `audiobookshelf`) están marcados con `data-turbo-permanent id="<panel>-iframe"` para que el iframe sobreviva en escenarios acotados dentro del mismo panel (p. ej., cambiar entre las pestañas Overview y Web UI del mismo bundle). Para una persistencia más amplia entre paneles, usa el panel nativo de Crow en su lugar — el panel del bundle de Música usa `window.crowPlayer` y la barra del reproductor persistente, que mantiene el audio reproduciéndose a través de cualquier navegación entre paneles.

Si construyes un panel basado en iframe, trátalo como "visítalo una vez y quédate ahí" y dirige a los usuarios hacia los equivalentes nativos para la reproducción de medios.

### Depurar problemas de Turbo

El gateway incluye un overlay de diagnóstico opcional cuando `CROW_ENABLE_TURBO=1`. Agrega `?diag=turbo` a cualquier URL del dashboard para activarlo (se persiste por navegador vía `localStorage.crowDiagTurbo`). El overlay muestra el estado de arranque de Turbo, la disponibilidad de `window.crowPlayer`, las banderas de inicialización de los elementos permanentes, los eventos recientes del ciclo de vida `turbo:*` y cualquier error no capturado o rechazo de promesa sin manejar. Agrega `?diag=off` para descartarlo.
