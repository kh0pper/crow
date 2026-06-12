---
title: Crear complementos
---

# Crear complementos

> El contrato de bundle (campos del manifiesto + superficies) está documentado en [bundles.md](./bundles.md).

Construye extensiones reutilizables para la plataforma Crow. Los complementos empaquetan paneles, servidores MCP, skills o combinaciones de estos en unidades instalables.

## ¿Qué es esto?

Un complemento de Crow es una extensión empaquetada que otros usuarios pueden instalar. Sigue un formato estándar con un archivo de manifiesto, para que la plataforma sepa qué contiene y cómo configurarlo.

## ¿Por qué querría esto?

- **Comparte tu trabajo** — Empaqueta un panel, servidor o skill personalizado para que otros lo usen
- **Bundles reutilizables** — Combina componentes relacionados (p. ej., un servidor + skill + panel) en un solo paquete instalable
- **Ecosistema comunitario** — Contribuye al registro de complementos de Crow

## Tipos de complementos

| Tipo | Qué contiene | Se instala en |
|---|---|---|
| `panel` | Panel del Crow's Nest | `~/.crow/panels/` |
| `mcp-server` | Servidor MCP (fábrica + stdio) | Se registra en `~/.crow/mcp-addons.json` |
| `skill` | Archivo markdown de skill | `~/.crow/skills/` |
| `bundle` | Varios componentes | Cada uno en su ubicación correspondiente |

## manifest.json

Todo complemento tiene un `manifest.json` en su raíz:

```json
{
  "id": "weather",
  "name": "Weather Panel",
  "version": "1.0.0",
  "type": "panel",
  "description": "Weather panel showing local forecast",
  "author": "Your Name",
  "license": "MIT",
  "category": "productivity",
  "tags": ["weather", "dashboard"],
  "icon": "cloud",
  "panel": "panel/index.js",
  "requires": {
    "env": ["WEATHER_API_KEY"]
  },
  "env_vars": [
    {
      "name": "WEATHER_API_KEY",
      "description": "API key from openweathermap.org",
      "required": true,
      "secret": true
    }
  ]
}
```

Aquí hay un ejemplo más completo (un bundle con Docker, un servidor MCP, un panel y un skill):

```json
{
  "id": "jellyfin",
  "name": "Jellyfin",
  "version": "1.0.0",
  "type": "bundle",
  "description": "Self-hosted media server with AI-powered library management",
  "author": "Crow",
  "category": "media",
  "tags": ["media", "movies", "tv", "music", "streaming"],
  "icon": "film",
  "docker": { "composefile": "docker-compose.yml" },
  "server": {
    "command": "node",
    "args": ["server/index.js"],
    "envKeys": ["JELLYFIN_URL", "JELLYFIN_API_KEY"]
  },
  "panel": "panel/jellyfin.js",
  "skills": ["skills/jellyfin.md"],
  "requires": { "env": ["JELLYFIN_API_KEY"], "min_ram_mb": 1024, "min_disk_mb": 2000 },
  "env_vars": [
    { "name": "JELLYFIN_URL", "description": "Jellyfin server URL", "default": "http://localhost:8096", "required": true },
    { "name": "JELLYFIN_API_KEY", "description": "Jellyfin API key", "required": true, "secret": true }
  ],
  "ports": [8096],
  "webUI": { "port": 8096, "path": "/", "label": "Jellyfin" },
  "notes": "Self-host via Docker or connect to an existing Jellyfin instance."
}
```

### Campos del manifiesto

| Campo | Obligatorio | Descripción |
|---|---|---|
| `id` | Sí | Identificador único (minúsculas, solo guiones) |
| `name` | Sí | Nombre legible para humanos |
| `version` | Sí | Cadena de versión semver |
| `type` | Sí | Uno de: `panel`, `mcp-server`, `skill`, `bundle` |
| `description` | Sí | Descripción corta (menos de 200 caracteres) |
| `author` | Sí | Nombre o alias del autor |
| `license` | Sí | Identificador de licencia SPDX |
| `category` | Sí | Categoría: `ai`, `media`, `productivity`, `storage`, `smart-home`, `networking`, `social`, `gaming`, `data`, `finance`, `other` |
| `tags` | No | Arreglo de etiquetas buscables (máx. 10) |
| `icon` | No | Clave de icono (consulta [Claves de icono compatibles](#claves-de-icono-compatibles) más abajo) |
| `docker` | No | Configuración de Docker: `{ "composefile": "docker-compose.yml" }` |
| `server` | No | Configuración del servidor MCP: `{ "command", "args", "envKeys" }` |
| `panel` | No | Ruta al módulo de panel del Crow's Nest (relativa a la raíz del complemento) |
| `panelRoutes` | No | Ruta a rutas Express adicionales para el panel |
| `skills` | No | Arreglo de rutas a archivos markdown de skills (relativas a la raíz del complemento) |
| `requires` | No | Requisitos: `env` (arreglo), `min_ram_mb`, `min_disk_mb`, `gpu` (booleano) |
| `env_vars` | No | Definiciones detalladas de variables de entorno (name, description, required, secret, default) |
| `ports` | No | Puertos que usa el complemento |
| `webUI` | No | Configuración de la interfaz web (ver abajo), o `null` para complementos sin interfaz |
| `notes` | No | Notas adicionales que se muestran en la página de Extensiones |

### Campo `webUI`

Los complementos que ofrecen una interfaz accesible desde el navegador deben declarar un objeto `webUI`:

```json
{
  "webUI": {
    "port": 8080,
    "path": "/",
    "label": "Open App"
  }
}
```

| Campo | Descripción |
|---|---|
| `port` | El puerto local en el que escucha la interfaz web |
| `path` | Ruta de URL a anexar después del puerto (p. ej., `/` o `/admin`) |
| `label` | Texto del botón que se muestra en los mosaicos del lanzador y en la página de Extensiones |

Establece `webUI` en `null` para complementos headless (sin interfaz web). El mosaico de la pantalla de inicio del Crow's Nest usa esta lógica para los destinos de clic:

1. Si el bundle tiene un **panel**, el mosaico enlaza al panel (`/dashboard/<id>`)
2. Si el bundle tiene **webUI pero no panel**, el mosaico abre la interfaz web
3. Si el bundle no tiene **ninguno de los dos**, el mosaico enlaza a la página de Extensiones

### Campo `panel`

Los complementos pueden incluir un panel del Crow's Nest que se instala y se registra automáticamente:

```json
{
  "panel": "panels/my-panel.js"
}
```

La ruta es relativa al directorio raíz del complemento. Durante la instalación, el archivo del panel se copia a `~/.crow/panels/` y su ID se agrega a `~/.crow/panels.json`. Al desinstalar, el panel se elimina. Esto funciona para cualquier tipo de complemento, no solo para los de tipo `panel`.

### Logos SVG

Los complementos oficiales tienen logos SVG en línea definidos en `servers/gateway/dashboard/shared/logos.js`. Estos aparecen en la página de Extensiones y en los mosaicos del lanzador. Los complementos de la comunidad que no están en el set de logos integrado usan como respaldo un icono de emoji (página de Extensiones) o un círculo con la letra inicial (mosaicos del lanzador).

::: tip
Si vas a enviar un complemento al registro, puedes proponer un logo SVG para que se incluya en `logos.js`. Usa un viewBox de 24x24, `stroke="currentColor"` y sin rellenos para que el icono se adapte a los temas oscuro y claro.
:::

## Estructura de archivos

### Complemento de panel

```
crow-weather-panel/
  manifest.json              # "panel": "panel/index.js"
  panel/
    index.js                 # Manifiesto del panel + handler
    assets/                  # Archivos estáticos opcionales
```

### Complemento de servidor MCP

```
crow-task-server/
  manifest.json              # "server": { "command": "node", "args": ["server/index.js"], "envKeys": [...] }
  server/
    server.js                # Función fábrica
    index.js                 # Punto de entrada stdio
  schema/
    init.sql                 # Tablas de la base de datos (se ejecuta durante la instalación)
  skills/
    tasks.md                 # Skill complementario opcional
```

### Complemento de skill

```
crow-pomodoro-skill/
  manifest.json              # "skills": ["skills/pomodoro.md"]
  skills/
    pomodoro.md              # Archivo del skill
```

### Complemento de bundle (Docker + servidor + panel + skill)

```
crow-media-manager/
  manifest.json              # Todos los campos: docker, server, panel, skills
  docker-compose.yml         # Referenciado por "docker": { "composefile": "docker-compose.yml" }
  server/
    server.js
    index.js
  panel/
    index.js
  skills/
    media-manager.md
```

## Pruebas locales

1. Crea el directorio de tu complemento con un `manifest.json`
2. Ejecuta `npm run build-registry` para regenerar `registry/add-ons.json` (nunca lo edites a mano — el registro se genera a partir de los manifiestos)
3. Para paneles: crea un symlink o copia a `~/.crow/panels/` y agrega el ID a `~/.crow/panels.json`
4. Para servidores: agrégalo temporalmente a `scripts/server-registry.js`
5. Para skills: cópialo a `skills/`
6. Reinicia el gateway y verifica que todo funcione

::: tip
Si usas un valor nuevo de `category` o `icon`, también necesitas actualizar la infraestructura del panel de Extensiones. Consulta la [lista de verificación del mantenedor](/es/developers/addon-registry) en la documentación del registro para ver la lista completa de archivos.
:::

Prueba el manifiesto:

```bash
node -e "const m = JSON.parse(require('fs').readFileSync('manifest.json')); console.log(m.name, m.version, m.type);"
```

## Mosaicos de la pantalla de inicio

Cuando se instala un complemento de tipo bundle, aparece automáticamente como un mosaico en la pantalla de inicio del Crow's Nest. No se requiere configuración adicional.

### Cómo funciona

- Los mosaicos aparecen al instalar y desaparecen al desinstalar
- La etiqueta del mosaico proviene del campo `name` de tu manifiesto
- El icono del mosaico se resuelve en este orden: logo de marca (para complementos oficiales) → SVG del campo `icon` → respaldo con la primera letra
- Los bundles con `webUI` configurado abren la interfaz web al hacer clic
- Los bundles sin `webUI` enlazan al panel de Extensiones

### Claves de icono compatibles

El campo `icon` de tu manifiesto debe ser uno de estos nombres de icono estilo feather:

`brain`, `cloud`, `image`, `home`, `book`, `rss`, `mic`, `music`, `message-circle`, `gamepad`, `archive`, `file-text`, `phone-video`

Las claves de icono desconocidas usan como respaldo un círculo con la primera letra. Para agregar una nueva clave de icono, agrega una entrada a `ICON_MAP` en `servers/gateway/dashboard/panels/extensions.js`.

### Qué no recibe mosaicos

- **Servidores MCP** — headless, sin destino de clic
- **Skills** — markdown puro, sin superficie de UI
- **Paneles** — ya aparecen vía el registro de paneles (consulta [Crear paneles](/es/developers/creating-panels))

## Publicación

Una vez que tu complemento esté probado:

1. Súbelo a un repositorio Git público
2. Etiqueta un release con la versión de tu manifiesto
3. Envíalo al [registro de complementos](/es/developers/addon-registry) para su publicación

Consulta la [documentación del registro](/es/developers/addon-registry) para el proceso completo de envío.

## Notificaciones

Los complementos pueden crear notificaciones que aparecen en el icono de campana del Crow's Nest y en el menú desplegable del tamagotchi. Importa el helper compartido:

```js
import { createNotification } from "../../shared/notifications.js";
// o ajusta la ruta relativa según la ubicación de tu complemento
```

Crea una notificación después de acciones visibles para el usuario:

```js
try {
  await createNotification(db, {
    title: "Task completed: Build report",
    type: "system",       // "reminder", "media", "peer" o "system"
    source: "my-addon",   // identifica el origen
    action_url: "/dashboard/my-panel",  // destino de clic opcional
  });
} catch {}
```

Envuélvelo siempre en `try/catch` para que un fallo de notificación nunca rompa la acción principal. El helper respeta las preferencias del usuario — si un usuario desactiva ese tipo de notificación en Configuración, la llamada devuelve `null` silenciosamente.

## Lineamientos

- Mantén los complementos enfocados — un propósito por complemento
- Usa variables de entorno para los secretos, nunca los escribas directamente en el código
- Sigue el patrón de restricciones `.max()` de Zod para cualquier parámetro de herramienta MCP
- Usa `sanitizeFtsQuery()` para cualquier consulta FTS5
- Incluye un archivo `LICENSE`
- Si estás construyendo un panel, pruébalo con los temas oscuro y claro del Crow's Nest
