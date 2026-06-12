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
3. Ingresa una contraseña de VNC cuando se te pida
4. Docker construye el contenedor (toma unos minutos en la primera instalación)
5. El gateway se reinicia — el panel Browser aparece en la barra lateral

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
| `crow_browser_launch` | Conecta al navegador vía CDP, devuelve la URL de VNC |
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
2. Ves el mensaje y abres el visor VNC
3. Completas la acción manualmente en el navegador
4. Le dices a la IA que continúe (llama a `wait_for_user` con `resume: true`)

## Acceso VNC

El visor VNC es accesible a través del gateway de Crow:

- **Embebido**: en la pestaña Status del panel Browser (iframe)
- **Vista completa**: `/proxy/browser/vnc.html` (mismo HTTPS que tu dashboard)
- **Directo**: `http://localhost:6080/vnc.html` (solo acceso local)

No hace falta abrir puertos en el firewall — el VNC se sirve mediante proxy a través del gateway.

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
docker compose down       # detener
docker compose logs -f    # ver registros
```

## Skill de declaración FFFF

La extensión Browser Automation incluye una skill para declarar impuestos vía IRS Free File Fillable Forms. Consulta la guía del [Asistente de Declaración de Impuestos](/es/guide/tax-filing) para más detalles.

## Seguridad

- El **puerto CDP (9222)** se vincula solo a `127.0.0.1`
- El **VNC** se sirve mediante proxy a través del gateway con autenticación de sesión
- **Ningún puerto expuesto** a la red — todo pasa por el HTTPS del gateway
- Se requiere contraseña de VNC (se establece durante la instalación)
