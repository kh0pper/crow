---
title: Crow's Nest
---

# Crow's Nest

El Crow's Nest (`servers/gateway/dashboard/`) es una interfaz web renderizada en el servidor para gestionar una instancia de Crow. (El directorio de código todavía se llama `dashboard/` por compatibilidad con versiones anteriores; el nombre de cara al usuario es "Crow's Nest"). No usa ningún framework de frontend — el HTML se genera del lado del servidor y lo sirve directamente el gateway.

> Recorrido de cara al usuario (paneles, lanzador, uso diario): [guía del Crow's Nest](/es/guide/crows-nest). Esta página cubre los detalles internos.

## Identidad de marca

El Crow's Nest usa una paleta azul-negra fría con acentos índigo, definida como propiedades personalizadas de CSS en `servers/gateway/dashboard/shared/layout.js`.

### Tokens de color (oscuro — `:root`)

| Token | Valor | Uso |
|---|---|---|
| `--crow-bg-deep` | `#0f0f17` | Fondo de página |
| `--crow-bg-surface` | `#1a1a2e` | Fondos de tarjetas/paneles |
| `--crow-bg-elevated` | `#2d2d3d` | Superficies elevadas, estados hover |
| `--crow-border` | `#3d3d4d` | Bordes, divisores |
| `--crow-text-primary` | `#fafaf9` | Encabezados, texto del cuerpo |
| `--crow-text-secondary` | `#a8a29e` | Descripciones, etiquetas |
| `--crow-text-muted` | `#78716c` | Pistas, texto deshabilitado |
| `--crow-accent` | `#6366f1` | Acento primario (índigo) |
| `--crow-accent-hover` | `#818cf8` | Estado hover del acento |
| `--crow-accent-muted` | `#2d2854` | Fondos de acento sutiles |
| `--crow-brand-gold` | `#fbbf24` | Resaltado de navegación activa, branding |
| `--crow-success` | `#22c55e` | Estados de éxito |
| `--crow-error` | `#ef4444` | Estados de error |
| `--crow-info` | `#38bdf8` | Resaltados informativos |

### Tokens de color (claro — `.theme-light`)

| Token | Valor |
|---|---|
| `--crow-bg-deep` | `#fafaf9` |
| `--crow-bg-surface` | `#ffffff` |
| `--crow-bg-elevated` | `#f5f5f4` |
| `--crow-border` | `#e7e5e4` |
| `--crow-text-primary` | `#1c1917` |
| `--crow-text-secondary` | `#57534e` |
| `--crow-text-muted` | `#a8a29e` |
| `--crow-accent` | `#4f46e5` |
| `--crow-accent-hover` | `#6366f1` |
| `--crow-accent-muted` | `#e0e7ff` |

### Tipografía

- **Encabezados**: Fraunces (serif, peso variable)
- **Cuerpo**: DM Sans (sans-serif)
- **Código**: JetBrains Mono (monospace)

Las tres se cargan vía Google Fonts en el bloque `<style>` del layout.

### Detalles visuales

- Profundidad de tarjetas mediante `box-shadow` en capas (brillo sutil en superficies elevadas)
- Acento dorado (`--crow-brand-gold`) en el elemento activo de la navegación lateral
- Estados vacíos ilustrados con íconos SVG de cuervo en línea
- La página de inicio de sesión y la de configuración muestran un gráfico hero de cuervo

## Arquitectura

```
┌────────────────────────────────────────┐
│         Registro de paneles            │
│  health │ messages │ memory │ blog    │
│  files │ extensions │ settings         │
│  + paneles de terceros desde ~/.crow/  │
├────────────────────────────────────────┤
│          Sistema de layout             │
│  layout(title, content, options)       │
│  Navegación, selector de tema, pie    │
├────────────────────────────────────────┤
│       Sistema de autenticación         │
│  hashing scrypt, cookies de sesión    │
│  tokens CSRF, bloqueo de cuenta       │
├────────────────────────────────────────┤
│          Seguridad de red              │
│  lista de IPs permitidas (LAN,        │
│  Tailscale), 403 para orígenes        │
│  no permitidos                         │
├────────────────────────────────────────┤
│          Router de Express             │
│  GET/POST /dashboard/*                 │
└────────────────────────────────────────┘
```

## Registro de paneles

Los paneles son secciones modulares del Crow's Nest. Cada panel se registra con:

```js
{
  id: 'messages',          // Identificador único
  name: 'Messages',        // Nombre visible en la navegación
  icon: 'mail',            // Identificador del ícono
  route: '/dashboard/messages',
  navOrder: 1,             // Posición en la barra de navegación
  handler: async (req, res, { db, layout }) => {
    // Renderizar el contenido del panel
  }
}
```

Los paneles integrados viven en `servers/gateway/dashboard/panels/`:

| Panel | Archivo | Ruta | Propósito |
|---|---|---|---|
| Crow's Nest | `panels/health.js` | `/dashboard/nest` | Mosaicos del lanzador de apps, CPU, RAM, uso de disco, contenedores Docker, métricas de la BD |
| Mensajes | `panels/messages.js` | `/dashboard/messages` | Ver mensajes peer, hilos, estado de lectura |
| Memoria | `panels/memory.js` | `/dashboard/memory` | Navegar, buscar y gestionar memorias persistentes |
| Proyectos | `panels/projects.js` | `/dashboard/projects` | Navegar espacios de proyecto, fuentes, notas |
| Blog | `panels/blog.js` | `/dashboard/blog` | Gestionar publicaciones, publicar/despublicar, editar |
| Archivos | `panels/files.js` | `/dashboard/files` | Navegar el almacenamiento, subir, eliminar, previsualizar |
| Extensiones | `panels/extensions.js` | `/dashboard/extensions` | Navegar el marketplace, instalar/desinstalar complementos, advertencias de recursos |
| Skills | `panels/skills.js` | `/dashboard/skills` | Navegar y editar las skills de Crow |
| Configuración | `panels/settings.js` | `/dashboard/settings` | Configuración, cuotas, reglas de red, descubrimiento de contactos, recuperación de conflictos de sincronización |
| Contactos | `panels/contacts.js` | `/dashboard/contacts` | Contactos peer, invitaciones, descubrimiento |
| Bot Builder | `panels/bot-builder.js` | `/dashboard/bot-builder` | Crear y configurar bots (personas, skills, canales) |
| Bot Board | `panels/bot-board.js` | `/dashboard/bot-board` | Monitorear bots en ejecución, conversaciones, entregas |
| Sistema de diseño | `panels/design-system.js` | `/dashboard/design-system` | Referencia viva de tokens y componentes |
| Onboarding | `panels/onboarding.js` | (oculto) | Asistente de configuración de primer arranque |
| Conectar | `panels/connect.js` | `/dashboard/connect` | Asistente para conectar un cliente + gestión del token MCP local |
| Administración de Fediverse | `panels/fediverse.js` | `/dashboard/fediverse` | Administración de Fediverse/ActivityPub |

Los paneles más grandes son **directorios de módulos** en lugar de archivos individuales: `panels/<name>/` contiene `{css,data-queries,client,api-handlers,html}.js` (más módulos específicos del panel como `editor.js`), con el `panels/<name>.js` de nivel superior como un orquestador delgado que los conecta entre sí. `bot-builder`, `bot-board`, `extensions`, `contacts`, `messages` y `nest` siguen este patrón; los paneles más pequeños siguen siendo archivos individuales.

Las secciones de Configuración viven en `servers/gateway/dashboard/settings/sections/` — incluida `sync-conflicts.js`, la vista de recuperación de conflictos de sincronización multi-instancia a la que enlazan directamente las notificaciones de conflicto (`/dashboard/settings?section=sync-conflicts`).

## Sistema de autenticación

El Crow's Nest usa su propia capa de autenticación, separada del sistema OAuth del gateway.

### Hashing de contraseñas

Las contraseñas se hashean con `crypto.scrypt`, integrado en Node.js:

```js
crypto.scrypt(password, salt, 64, (err, derivedKey) => {
  // Almacenar salt + derivedKey
});
```

No requiere ninguna dependencia externa.

### Sesiones

Después de iniciar sesión, se establece una cookie de sesión con:

- `httpOnly: true` — No accesible para el JavaScript del lado del cliente
- `sameSite: 'strict'` — Previene CSRF vía solicitudes de origen cruzado
- `secure: true` — Solo se envía por HTTPS (cuando está detrás de un reverse proxy)
- Expiración configurable (predeterminado: 24 horas)

### Protección CSRF

Todas las solicitudes que cambian estado (POST, PUT, DELETE) requieren un token CSRF. El token se incrusta en los formularios como un campo oculto y se valida del lado del servidor.

### Bloqueo de cuenta

Después de 5 intentos fallidos de inicio de sesión en 15 minutos, la cuenta se bloquea por 30 minutos. Esto previene ataques de fuerza bruta contra la contraseña del Crow's Nest.

## Sistema de layout

La función de layout (`shared/layout.js`) envuelve el contenido del panel en una estructura de página consistente. Recibe un único objeto de opciones:

```js
renderLayout({
  title,        // título de la página
  content,      // HTML del panel
  activePanel,  // resalta la entrada de navegación
  theme,        // 'dark' | 'light'
  lang,         // 'en' | 'es'
  scripts,      // scripts adicionales de la página
  // ...además de panels, glass, serif, afterContent, headerIcons, navGroups, instanceTabs
})
```

Los paneles la reciben como `layout` en el contexto de su handler y la llaman como `layout({ title, content })`.

Todo es un template literal — sin dependencia de motor de plantillas. El CSS va inline en el `<head>` para evitar un servidor de archivos estáticos separado.

## Seguridad de red

Antes de que se ejecute cualquier ruta del Crow's Nest, un middleware verifica la IP de origen de la solicitud:

```js
const ALLOWED_RANGES = [
  '127.0.0.1/32',       // Localhost
  '::1/128',            // Localhost IPv6
  '10.0.0.0/8',         // LAN Clase A
  '172.16.0.0/12',      // LAN Clase B
  '192.168.0.0/16',     // LAN Clase C
  '100.64.0.0/10',      // CGNAT de Tailscale
];
```

Las solicitudes desde fuera de estos rangos reciben una respuesta `403 Forbidden`. Para permitir el acceso desde cualquier IP (p. ej., detrás de un reverse proxy), establece `CROW_DASHBOARD_PUBLIC=true`.

El middleware lee `X-Forwarded-For` cuando el gateway está detrás de un reverse proxy, pero solo confía en él si la conexión inmediata proviene de una IP de proxy conocida.

## Lanzador de aplicaciones

La página de inicio del Crow's Nest (el panel "Crow's Nest", `navOrder: 5`) incluye una cuadrícula **Tus Apps** que muestra los complementos instalados como mosaicos de lanzamiento.

### Cómo funciona

1. Lee `~/.crow/installed.json` y filtra las entradas con tipo `bundle` o `mcp-server`
2. Carga el manifiesto del complemento para obtener el nombre visible y el campo `webUI`
3. Llama a `getAddonLogo(id, 48)` de `servers/gateway/dashboard/shared/logos.js` para el ícono del mosaico (con respaldo a un círculo con la letra inicial)
4. Para complementos basados en Docker, verifica el estado del contenedor vía `docker ps --filter name=<id>` con una **caché de 30 segundos a nivel de módulo** (el Map `_dockerStatusCache`) para evitar comandos de shell excesivos
5. Renderiza un punto de estado (verde = en ejecución, gris = detenido) y un botón "Abrir" para los complementos con un campo `webUI` en su manifiesto

### Pipeline de mosaicos de la pantalla de inicio

La pantalla de inicio del Nest renderiza mosaicos desde dos fuentes:

1. **Registro de paneles** — `getVisiblePanels()` devuelve los paneles no ocultos ordenados por `navOrder`
2. **Bundles instalados** — `getNestData()` lee `~/.crow/installed.json`, carga los manifiestos, verifica el estado de Docker

Flujo de datos:
```
Registro de paneles ──→ getVisiblePanels() ──┐
                                             ├──→ buildNestHTML() ──→ Cuadrícula
~/.crow/installed.json ──→ getNestData() ────┘
```

**Orden de los mosaicos**: Primero los paneles integrados (por `navOrder`), luego los bundles (por `installedAt` de installed.json).

**Resolución de íconos** (bundles): Logo SVG de marca → campo `icon` del manifiesto → respaldo de círculo con la primera letra.

### El campo `webUI` del manifiesto

Los manifiestos de complementos pueden declarar un objeto `webUI` para indicar que el complemento tiene una interfaz accesible desde el navegador:

```json
{
  "webUI": {
    "port": 8080,
    "path": "/",
    "label": "Open Nextcloud"
  }
}
```

Establece `webUI` en `null` para complementos sin interfaz (p. ej., Ollama). El lanzador solo muestra el botón "Abrir" cuando `webUI` no es null.

## Instalación automática de paneles

Los complementos que incluyen un campo `panel` en su `manifest.json` obtienen su archivo de panel instalado automáticamente durante la instalación del complemento y eliminado durante la desinstalación. Esto funciona para cualquier tipo de complemento (bundle, mcp-server, skill), no solo para complementos de tipo panel.

Durante la instalación, `routes/bundles.js` copia el archivo del panel desde el directorio fuente del complemento a `~/.crow/panels/` y agrega su ID a `~/.crow/panels.json`. Durante la desinstalación, el archivo del panel se elimina y el ID se borra del JSON. Ejemplo de campo de manifiesto:

```json
{
  "panel": "panels/podcast.js"
}
```

El panel de Podcast (`bundles/podcast/panels/podcast.js`) es un ejemplo: se instala como panel de terceros cuando se instala el complemento de podcast.

| Panel | Tipo | Fuente |
|---|---|---|
| Podcast | Tercero (instalado automáticamente) | `bundles/podcast/panels/podcast.js` |

## Paneles de terceros

Los paneles creados por la comunidad viven en `~/.crow/panels/`. Cada panel es un único archivo JS llamado `<id>.js` (un archivo compañero opcional `<id>-routes.js` puede registrar rutas adicionales). Los IDs de panel deben coincidir con `[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}`; cualquier otra cosa se rechaza al momento de la carga. El Crow's Nest carga al arrancar los paneles listados en `~/.crow/panels.json` y registra los que sean válidos. Los paneles de terceros reciben el mismo contexto `{ db, layout, appRoot, lang }` que los paneles integrados. La ruta `appRoot` apunta a la raíz del código fuente de Crow, que los paneles pueden usar para imports dinámicos de componentes compartidos (p. ej., `logos.js`, `components.js`); `lang` es el idioma del panel de control del operador (`en`/`es`).

Habilita paneles en `~/.crow/panels.json` (un arreglo JSON de IDs de panel):

```json
["my-panel", "weather"]
```

También se acepta un formato de objeto con una clave `"enabled"` por compatibilidad con versiones anteriores.

Consulta [Creación de paneles](/es/developers/creating-panels) para un tutorial de desarrollo.

## Sistema de notificaciones

El Crow's Nest incluye un sistema de notificaciones con un ícono de campana y un dropdown estilo tamagotchi en la barra superior.

### Esquema

La tabla `notifications` almacena todas las notificaciones:

| Columna | Tipo | Descripción |
|---|---|---|
| `type` | text | `reminder`, `media`, `peer` o `system` |
| `source` | text | Identificador de origen (p. ej., `blog`, `sharing:message`, `bundle-installer`) |
| `title` | text | Titular corto |
| `body` | text | Descripción más larga, opcional |
| `priority` | text | `low`, `normal` o `high` |
| `action_url` | text | Enlace del panel para abrir al hacer clic |
| `is_read` | integer | Estado de lectura |
| `is_dismissed` | integer | Estado de descartada |
| `expires_at` | text | Marca de tiempo de expiración automática |

### Helper compartido

`servers/shared/notifications.js` exporta dos funciones:

- **`createNotification(db, opts)`** — Crea una notificación después de verificar las preferencias del usuario. Devuelve `{ id }` o `null` si el tipo está deshabilitado. Envuelve siempre las llamadas en `try/catch` para evitar que un fallo de notificación rompa las acciones primarias.
- **`cleanupNotifications(db)`** — Elimina las notificaciones expiradas y aplica un límite de retención de 500 notificaciones. La llaman el tick del scheduler y el endpoint REST GET.

### Preferencias de usuario

Los usuarios configuran qué tipos de notificación están habilitados en Configuración → Notificaciones. Las preferencias se almacenan como un objeto JSON en `dashboard_settings` bajo la clave `notification_prefs`:

```json
{ "types_enabled": ["reminder", "media", "peer", "system"] }
```

Todos los tipos están habilitados por defecto. El helper `createNotification` verifica esto antes de insertar.

### Fuentes de eventos

| Evento | Tipo | Fuente |
|---|---|---|
| Publicación del blog publicada | `media` | `blog` |
| Compartición P2P entrante | `peer` | `sharing:share` |
| Mensaje Nostr entrante | `peer` | `sharing:message` |
| Bundle instalado | `system` | `bundle-installer` |
| Bundle desinstalado | `system` | `bundle-installer` |
| Recordatorio programado | `reminder` | `scheduler` |

### UI

La campana de notificaciones en la barra superior muestra una insignia con el conteo de no leídas. Al hacer clic se abre un dropdown con las notificaciones recientes, cada una con título, hora y fuente. Las notificaciones pueden descartarse individualmente o limpiarse en bloque. La API REST en `/api/notifications` provee acceso JSON para las llamadas fetch del dropdown.

## Sin paso de build

El Crow's Nest no tiene paso de build, ni bundler, ni node_modules propios. Todo el HTML, el CSS y el JavaScript mínimo se generan inline en el servidor. Esto mantiene la UI ligera y evita la complejidad de una toolchain de frontend.

El CSS usa propiedades personalizadas para los temas (consulta la tabla completa de [Identidad de marca](#identidad-de-marca) arriba):

```css
:root {
  --crow-bg-deep: #0f0f17;
  --crow-bg-surface: #1a1a2e;
  --crow-accent: #6366f1;
  --crow-text-primary: #fafaf9;
  --crow-brand-gold: #fbbf24;
}

.theme-light {
  --crow-bg-deep: #fafaf9;
  --crow-bg-surface: #ffffff;
  --crow-accent: #4f46e5;
  --crow-text-primary: #1c1917;
}
```

## Onboarding de primer arranque (F6b)

`panels/onboarding.js` es un panel oculto del Crow's Nest (`hidden: true`, ruta `/dashboard/onboarding`) que renderiza un tour guiado de 5 pasos (Bienvenida, Integraciones, Bot, Conectar, Listo) controlado por un parámetro de consulta `?step=N` — renderizado en el servidor, sin JS de cliente. Es **orientar y dirigir**: cada paso explica una sola cosa y enlaza directamente (en pestaña nueva) a la superficie que hace el trabajo (Configuración → Integraciones, Bot Builder, el asistente de conexión). No escribe nada.

Se muestra automáticamente una sola vez: `POST /dashboard/login` redirige a él la primera vez que se establece una contraseña (la rama `wasFirstSetup` en `index.js`); los inicios de sesión normales van directo a `/dashboard`. Puede repetirse en cualquier momento vía el enlace "Repetir la guía de configuración" en Configuración → Ayuda y configuración.

El texto es bilingüe (EN/ES) vía las claves `onboarding.*` en `shared/i18n.js`; el handler resuelve el idioma con prioridad a la cookie (`crow_lang`), de modo que un usuario que eligió español durante la configuración recibe el onboarding en español. Tests: `tests/onboarding.test.js`.

## Asistente de conexión (F6c-1)

`panels/connect.js` es un panel oculto del Crow's Nest (`hidden: true`, ruta `/dashboard/connect`) que ofrece configuración MCP por cliente para copiar y pegar — renderizado en el servidor, sin JS de cliente más allá de los handlers compartidos de pestañas/copiado. Una franja `tabs()` cubre los clientes locales que pueden alcanzar un Crow privado (Claude Code, Cursor, Cline, Gemini CLI, Claude Desktop), cada uno con los dos estilos de conexión que funcionan hoy sin token: **stdio local** (`npm run mcp-config`) y **HTTP remoto vía OAuth** (pegas una entrada de servidor `http`; el cliente ejecuta el handshake OAuth en el primer uso). Las configuraciones incrustan el endpoint del host de la solicitud `${req.protocol}://${req.get("host")}/router/mcp` (la misma derivación de URL base que la sección Conexiones de Configuración), de modo que el snippet muestra la dirección desde la que el operador está navegando realmente.

Una sexta pestaña (claude.ai / ChatGPT) muestra una advertencia honesta de alcanzabilidad en lugar de una configuración: un Crow privado es solo-Tailnet y exponer MCP vía Funnel está bloqueado por la invariante de exposición de red, así que los clientes web en la nube no pueden conectarse.

Se llega a él desde el paso 3 del onboarding, la sección Ayuda y configuración de Configuración y la sección Conexiones de Configuración (todas apuntan ahora aquí en lugar de duplicar la configuración por plataforma). El texto es bilingüe (EN/ES) vía las claves `connect.*` en `shared/i18n.js`, resuelto con prioridad a la cookie igual que el onboarding. Tests: `tests/connect.test.js`.

### Token MCP local (F6c-2)

El panel de conexión también gestiona un único token bearer estático por instancia, de acceso total, para clientes headless / sin navegador (la vía HTTP remota que no puede ejecutar el handshake OAuth). El gateway lo verifica del lado del servidor vía `servers/gateway/local-token.js`: `localTokenAuthMiddleware` se monta justo después de `instanceAuthMiddleware` (y lee la BD solo en rutas de transporte MCP — `/mcp`, `/sse`, `/messages` — como protección de costo), y una rama en `skipAuthForInstance` de `routes/mcp.js` llama a `applyLocalTokenAuth(req)` para sintetizar un `req.auth` completo de operador local (después de la rama de instancia, antes del fallback de OAuth, y deliberadamente sin pasar por la puerta de exposición a peers).

Solo se almacena `sha256(token)`, en una configuración del dashboard de alcance local (`mcp_local_token_hash`, más `mcp_local_token_created`) que nunca se replica a instancias emparejadas. El token en crudo se revela exactamente una vez al generar/rotar, incrustado en una configuración `http` lista para pegar con un encabezado `Authorization: Bearer …`; el estado enmascarado muestra solo un marcador `<YOUR-TOKEN>`. Generar/rotar/revocar son acciones POST en el propio panel (protegidas por CSRF + dashboardAuth) y no necesitan reinicio del gateway, porque el verificador lee el hash en cada solicitud. La comparación usa `crypto.timingSafeEqual`; bajo `--no-auth` la rama del token queda inerte (solo desarrollo). La sección Conexiones de Configuración enlaza aquí para la generación del token. Tests: `tests/connect-token.test.js`. Spec: `docs/superpowers/specs/2026-06-10-f6c2-connect-token-design.md`.

Esto reemplaza la antigua variable de entorno `CROW_LOCAL_MCP_TOKEN`, que solo alimentaba el script de build `npm run mcp-config --http` y no autenticaba nada del lado del servidor.
