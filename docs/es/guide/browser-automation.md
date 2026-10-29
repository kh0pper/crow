---
title: Automatización de navegador
---

# Automatización de navegador

Automatización sigilosa de navegador con visualización por VNC — navega sitios web, llena formularios, extrae contenido y haz scraping de datos vía Chrome DevTools Protocol.

## Qué obtienes

- **18 herramientas MCP** — navegación, llenado de formularios, capturas de pantalla, extracción de contenido, scraping
- **Contenedor Docker** — Chrome headless con Xvfb + visor VNC
- **Modo sigiloso** — escritura tipo humano, aleatorización de clics, suplantación de huella digital
- **Panel del dashboard** — vista VNC en vivo, controles del contenedor, sesiones guardadas, skills instaladas
- **Extracción de contenido** — texto de artículos, tablas HTML, datos estructurados, paginación
- **Skill de declaración FFFF** — automatización de IRS Free File Fillable Forms (incluida)

## Instalación

1. Abre la página de **Extensiones** en tu dashboard del Crow's Nest
2. Busca **Browser Automation** y haz clic en **Install**
3. Docker construye el contenedor (toma unos minutos en la primera instalación)
4. El gateway se reinicia — el panel Browser aparece en la barra lateral

No hay contraseña de VNC que configurar ni escribir: al visor solo se llega a través de tu dashboard de Crow con la sesión iniciada.

## Panel del dashboard

El panel Browser tiene tres pestañas:

### Status
- Estado del contenedor (Running/Stopped) con botones Start/Stop/Restart
- Estado de la conexión CDP (Chrome DevTools Protocol)
- **Vista VNC en vivo** — iframe embebido que muestra el navegador en tiempo real
- Enlace "Open VNC Viewer" para una vista más grande

### Sessions
- Lista de sesiones de navegador guardadas (cookies + localStorage)
- Restaura sesiones para retomar donde lo dejaste

### Skills
- Skills de automatización instaladas (p. ej., FFFF Filing, recetas de scraping personalizadas)

## Herramientas MCP

### Herramientas principales

| Herramienta | Descripción |
|------|-------------|
| `crow_browser_launch` | Conecta al navegador vía CDP, devuelve la ruta del visor en el dashboard |
| `crow_browser_status` | Comprobación de salud del contenedor y de CDP |
| `crow_browser_navigate` | Va a una URL con scripts de sigilo |
| `crow_browser_screenshot` | Captura la página o un elemento como PNG |
| `crow_browser_fill_form` | Llena campos de formulario con escritura tipo humano |
| `crow_browser_click` | Hace clic con aleatorización de posición |
| `crow_browser_evaluate` | Ejecuta JavaScript en el contexto de la página |
| `crow_browser_wait_for_user` | Pausa para intervención humana (CAPTCHA, 2FA) |
| `crow_browser_discover_selectors` | Encuentra todos los elementos interactivos de la página |
| `crow_browser_save_session` | Guarda cookies + localStorage en un archivo |
| `crow_browser_load_session` | Restaura una sesión guardada |

### Herramientas de extracción de contenido

| Herramienta | Descripción |
|------|-------------|
| `crow_browser_extract_text` | Texto limpio del artículo vía Mozilla Readability |
| `crow_browser_extract_tables` | Tablas HTML a JSON o CSV |
| `crow_browser_extract_links` | Todos los enlaces con texto y URLs, filtrables |
| `crow_browser_scrape` | Datos estructurados vía mapeo de selectores CSS |
| `crow_browser_paginate` | Sigue la paginación, recolecta resultados de varias páginas |
| `crow_browser_export` | Guarda los datos extraídos como archivo CSV o JSON |
| `crow_browser_capture_har` | Graba las peticiones de red para descubrir APIs |

## Flujos de trabajo

### Navegación básica y llenado de formularios

```
1. crow_browser_launch          → conectar al navegador
2. crow_browser_navigate        → ir al sitio
3. crow_browser_discover_selectors → encontrar los campos del formulario
4. crow_browser_fill_form       → llenar los valores
5. crow_browser_click           → enviar
6. crow_browser_screenshot      → verificar el resultado
```

### Scraping de contenido

```
1. crow_browser_navigate        → ir a la página
2. crow_browser_extract_text    → obtener el texto limpio del artículo
   — o —
   crow_browser_scrape          → extraer datos estructurados vía selectores CSS
3. crow_browser_export          → guardar como CSV o JSON
```

### Scraping de varias páginas

```
1. crow_browser_navigate        → ir a la primera página
2. crow_browser_paginate        → seguir los enlaces "siguiente", extraer de cada página
3. crow_browser_export          → guardar los resultados combinados
```

### Gestión de sesiones

```
1. crow_browser_save_session    → guardar las cookies antes de operaciones largas
2. (... pasa el tiempo, la sesión podría expirar ...)
3. crow_browser_load_session    → restaurar las cookies y continuar
```

## Funciones de sigilo

El navegador incluye medidas anti-detección:

- **navigator.webdriver** enmascarado
- **Rotación de User-Agent** — perfiles de Chrome en Windows, macOS o Linux
- **Suplantación de plugins** — Chrome PDF Plugin, PDF Viewer y Native Client falsos
- **Dimensiones de pantalla** — 1920x1080 con área disponible realista
- **Objeto window.chrome** simulado
- **Zona horaria** configurable (por defecto, hora del Centro)
- **Escritura tipo humano** — retrasos por carácter con aleatorización
- **Clics tipo humano** — posición aleatorizada dentro de los límites del elemento
- **Pausas de navegación** — retrasos aleatorios entre acciones

## Intervención humana

Para CAPTCHA, 2FA, preguntas de seguridad o cualquier acción que requiera juicio humano:

1. La IA llama a `crow_browser_wait_for_user` con un mensaje
2. Ves el mensaje y tocas **Tomar el control** en el chat (o abres el panel Browser)
3. Completas la acción manualmente en el navegador
4. Le dices a la IA que continúe (llama a `wait_for_user` con `resume: true`)

## Acceso VNC

Al visor VNC solo se llega a través del gateway de Crow, con tu sesión del dashboard iniciada:

- **Embebido**: en la pestaña Status del panel Browser (iframe), en el recuadro del navegador en vivo y en la hoja **Tomar el control** de un chat
- **Vista completa**: `/proxy/browser/vnc.html?autoconnect=true&resize=scale&view_only=false` (mismo HTTPS que tu dashboard)

El visor se conecta solo: no hay una contraseña de VNC aparte. La pantalla en sí (x11vnc) no está en ningún puerto de red: escucha solo en un socket unix, accesible solo para root, dentro del contenedor. noVNC (puerto 6080) escucha solo en `127.0.0.1` y solo conecta un visor a ese socket con una clave por instancia que Crow genera al instalar (`CROW_BROWSER_VNC_TOKEN` en el `.env` del bundle) y que solo usa el gateway de Crow: la añade de su lado, después de comprobar tu sesión y que la petición viene de la propia página del dashboard. Ninguna página, enlace ni registro la contiene, así que otro programa o una página web en la misma máquina que llegue al puerto 6080 no obtiene ni imagen ni control. El contenedor se detiene al arrancar si la pantalla está en algún puerto TCP o si noVNC se puede alcanzar en una dirección que no sea loopback.

## Contenedor Docker

El contenedor ejecuta:
- **Ubuntu 22.04** con Xvfb (framebuffer virtual)
- **Playwright Chromium** (última versión)
- **x11vnc + noVNC** para visualizar el navegador
- **Red del host** (`network_mode: host`) para el acceso CDP

Límites del contenedor: 2 GB de RAM, 1 GB de memoria compartida.

### Gestión del contenedor

Desde el panel Browser:
- Botones **Start** / **Stop** / **Restart**
- El contenedor se reinicia automáticamente tras un reinicio del sistema (`restart: unless-stopped`)

Desde la línea de comandos:
```bash
cd ~/.crow/bundles/browser
docker compose up -d      # iniciar
docker compose stop       # detener
docker compose logs -f    # ver registros
```

El perfil del navegador (sus cookies y sesiones iniciadas) vive dentro del contenedor, no en un volumen. `docker compose stop` y `restart` lo conservan; todo lo que **elimina o recrea** el contenedor lo pierde: `docker compose down`, `up --force-recreate`, una reconstrucción que cambia la imagen, o `crow_browser_launch` con `proxy_url`. Guarda antes las sesiones con `crow_browser_save_session`.

## Skill de declaración FFFF

La extensión Browser Automation incluye una skill para declarar impuestos vía IRS Free File Fillable Forms. Consulta la guía del [Asistente de Declaración de Impuestos](/es/guide/tax-filing) para más detalles.

## Seguridad

- El **puerto CDP (9222)** se vincula solo a `127.0.0.1`
- **VNC**: x11vnc está en un socket unix dentro del contenedor (sin puerto TCP); noVNC (6080) se vincula solo a `127.0.0.1` y necesita la clave por instancia que solo añade el gateway, tras comprobar la sesión y el mismo origen
- **Ningún puerto expuesto** a la red — todo pasa por el HTTPS del gateway
- Sin contraseña de VNC: el inicio de sesión del dashboard es la puerta. Si una instalación anterior tiene `CROW_BROWSER_VNC_PASSWORD` en el `.env` del bundle, se ignora
