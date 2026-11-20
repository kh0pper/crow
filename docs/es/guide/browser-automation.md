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

El visor se conecta solo: no hay una contraseña de VNC aparte. La pantalla (x11vnc y la pantalla X debajo) no está en ningún puerto de red: x11vnc escucha solo en un socket unix, accesible solo para root, dentro del contenedor, y la pantalla X necesita una cookie nueva en cada arranque y no tiene socket TCP ni visible en toda la máquina. noVNC (puerto 6080) escucha solo en `127.0.0.1` y solo conecta un visor con una clave por instancia que Crow genera al instalar (`CROW_BROWSER_VNC_TOKEN` en el `.env` del bundle, entregada al contenedor como un archivo solo para root). El gateway de Crow añade la clave de su lado, después de comprobar tu sesión y que la petición viene de la propia página del dashboard; ninguna página ni enlace la contiene, y una clave equivocada se rechaza sin registrarla. Chrome DevTools (CDP) funciona igual desde 1.5.0: el navegador **no** abre ningún puerto (se ejecuta sobre un pipe), y un pequeño relay dentro del contenedor sirve `127.0.0.1:9222` solo a quien envía el `CROW_BROWSER_CDP_TOKEN` de esta instancia como token bearer (`/json/version` y el WebSocket del depurador; todo lo demás se rechaza). Desde 1.7.0 ese relay se ejecuta con **tu propio usuario de Crow** (el uid del gateway) mientras Chromium y el perfil con tus sesiones iniciadas siguen siendo solo de root: un programa que se ejecuta en tu nombre —por ejemplo un add-on de navegador amurallado— puede ser reconocido como dueño de ese puerto, y el contenedor se niega a arrancar si el listener pertenece a otro usuario o si Crow no le dijo cuál usar. Esto deja **las páginas web, otras máquinas y otros usuarios** fuera de la pantalla y de los controles del navegador. **No** deja fuera a un proceso de tu usuario de Crow que pueda leer la copia de la clave del relay. El contenedor se detiene al arrancar si la pantalla está en algún puerto TCP, si hay un socket X visible en toda la máquina, si noVNC o el relay CDP se puede alcanzar en una dirección que no sea loopback, si el relay CDP se ejecuta con otro uid, o si falta el token de CDP. Después de cambiar una clave en `.env`, recrea el contenedor.

## Contenedor Docker

El contenedor ejecuta:
- **Ubuntu 22.04** con Xvfb (framebuffer virtual)
- **Playwright Chromium** (última versión), sobre un pipe de DevTools (`--remote-debugging-pipe`) en vez de un puerto de depuración
- **x11vnc + noVNC** para visualizar el navegador
- **Un pequeño relay CDP** que sirve `127.0.0.1:9222` para los clientes de control del navegador, con la comprobación del token
- **Red del host** (`network_mode: host`): el navegador puede llegar a los servicios que escuchan solo en esta máquina, pero las herramientas de Crow se niegan a enviarlo a una dirección privada o local (ver [Se bloquean las direcciones privadas](#se-bloquean-las-direcciones-privadas))

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

El perfil del navegador (sus cookies y sesiones iniciadas) vive en un volumen de Docker con nombre, uno por instancia (`browser_chromium-profile` en la instancia principal), así que detener, reiniciar, reconstruir o recrear el contenedor lo conserva. Solo `docker compose down -v` (o `docker volume rm`) lo borra. El bundle necesita Docker Compose 2.23.1 o posterior (entrega la clave del visor al contenedor como un archivo `configs` de compose). Una instalación anterior a 1.4.0 mantiene su perfil dentro del contenedor antiguo hasta que un operador lo mueve una vez con `scripts/ops/browser-profile-to-volume.sh` (primero con `--dry-run`); hasta entonces, evita todo lo que recree ese contenedor.

## Skill de declaración FFFF

La extensión Browser Automation incluye una skill para declarar impuestos vía IRS Free File Fillable Forms. Consulta la guía del [Asistente de Declaración de Impuestos](/es/guide/tax-filing) para más detalles.

## Seguridad

- El **puerto CDP (9222)** se vincula solo a `127.0.0.1` y lo sirve el relay CDP del contenedor, no Chromium (que no abre ningún puerto: se ejecuta sobre un pipe). Ese relay se ejecuta con el usuario de Crow (el uid del gateway), no como root, que es lo que permite reconocer a un add-on de navegador amurallado como dueño de su propio navegador; Chromium y el perfil siguen siendo solo de root. Una petición sin el `CROW_BROWSER_CDP_TOKEN` de esta instancia como token bearer recibe 401; solo existen `/json/version` y el WebSocket del depurador; las cabeceras y las conexiones tienen un límite, y nunca se registra el valor de una cabecera. Los propios clientes del navegador de Crow (las herramientas Browser, el recuadro del navegador del dashboard) envían el token solos, así que tú nunca lo escribes. Lo que esto **no** detiene: un proceso de tu usuario de Crow que pueda leer la copia del token del relay
- **VNC**: x11vnc está en un socket unix dentro del contenedor (sin puerto TCP); la pantalla X necesita una cookie nueva en cada arranque y no tiene socket TCP ni visible en toda la máquina; noVNC (6080) se vincula solo a `127.0.0.1` y necesita la clave por instancia que añade el gateway, tras comprobar la sesión y el mismo origen
- **Ningún puerto expuesto** a la red — todo pasa por el HTTPS del gateway
- Sin contraseña de VNC: para las páginas web y otras máquinas, el inicio de sesión del dashboard es la puerta (programas de esta máquina: ver CDP arriba). Una página que sirve otra app bajo `/proxy/` del dashboard comparte el origen del dashboard, así que un fallo en esa app alcanza lo mismo que el dashboard. El proxy no reenvía tus cookies de Crow a esa app (y descarta cualquier `Set-Cookie` con el nombre de una cookie de Crow), pero el código del mismo origen aún puede actuar con tu sesión abierta — servir las extensiones desde su propio origen es el arreglo pendiente (issue #51). Si una instalación anterior tiene `CROW_BROWSER_VNC_PASSWORD` en el `.env` del bundle, se ignora

### Se bloquean las direcciones privadas

El contenedor del navegador usa la red del host, así que las propias herramientas de navegador de Crow se niegan a enviarlo a un destino privado o local. Se rechazan: loopback (`127.0.0.0/8`, `::1`), las redes privadas (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), la tailnet (`100.64.0.0/10`), link-local (`169.254/16`, `fe80::/10`), los rangos site-local, reservados y multicast, la dirección no especificada, y las direcciones de metadatos de la nube (`169.254.169.254`, `fd00:ec2::/32`) — en cualquier forma de escribir una dirección (un número suelto, hexadecimal, octal, formas cortas como `127.1`, IPv6 con una IPv4 incrustada, `localhost` y `*.localhost`, y cualquier nombre que resuelva a una de ellas). Las herramientas también rechazan navegar a un esquema que no sea `http`, `https`, `ws` o `wss` (`file:`, `data:`, `javascript:` y similares).

Para permitir un destino, inclúyelo en el archivo de ajustes del complemento (`~/.crow/bundles/browser/.env`) y reinicia el complemento:

```bash
CROW_BROWSER_ALLOW_PRIVATE=192.168.1.50, 10.1.0.0/16, intranet.example
```

La lista se separa con comas o espacios: nombres de host (exactos), direcciones IP sueltas y rangos CIDR (IPv4 o IPv6). Las entradas que no sean una de esas cosas se ignoran. Las direcciones de metadatos de la nube nunca se exceptúan, ni siquiera con un rango que las cubra.

Dos cosas sobre la lista: una excepción de **nombre de host** exceptúa aquello a lo que ese nombre resuelva, incluido loopback (incluir `myapp.local` lo permite aunque responda `127.0.0.1`). Y cuando el contenedor va tras un proxy (`CROW_BROWSER_PROXY`), la dirección que el navegador informa para una respuesta es la del **proxy**, así que un proxy que escuche en una dirección privada necesita una excepción para esa dirección.

La regla se aplica mientras las herramientas de navegador de Crow están conectadas: todo el contexto del navegador queda protegido, así que también cubre una pestaña que abra el operador en esa misma ventana del navegador (se juzgan las redirecciones, las ventanas emergentes, las pestañas nuevas, los subframes y las subpeticiones de una página). Lo que **no** es:

- **No es un muro de red.** Es una regla dentro de las herramientas de Crow. Un programa que tenga la clave de control del navegador (`CROW_BROWSER_CDP_TOKEN`), y quien use el visor VNC, puede ir a donde quiera.
- **No cubre todas las peticiones de un service worker.** Las peticiones propias de un service worker de una página no se pueden interceptar, así que el guard rechaza su registro en la página (el contenedor de la página y `ServiceWorkerContainer.prototype`, en la medida de lo posible).
- **WebRTC queda desactivado en la página, en la medida de lo posible.** El mismo script de arranque sustituye `RTCPeerConnection`, `webkitRTCPeerConnection`, `RTCIceTransport` y `RTCDataChannel` en cada frame, junto con los constructores de sus prototipos, así que `new RTCPeerConnection(...)` lanza un `TypeError`. Sin eso, ICE reuniría candidatos de host en las interfaces de la propia máquina y enviaría UDP directamente a una dirección privada, donde ninguna ruta de esta regla lo ve — el Chromium del contenedor se lanza además con `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, pero algunas compilaciones de Chromium ignoran esa opción, así que no se confía solo en ella: la desactivación del script de arranque es el control a nivel de página, y un filtro de salida (egress) de UDP para el contenedor es el siguiente paso. Un script dentro de un worker todavía alcanza la API (este script no se ejecuta ahí), así que esto es lo mejor posible: la solución real para el UDP de una página es un filtro de salida (egress).
- **No cubre las peticiones que abre un worker por sí mismo.** Una petición abierta desde dentro de un dedicated worker, un shared worker o un service worker no es una petición que vean las rutas de Playwright, así que ese script todavía puede alcanzar una dirección privada: los WebSockets desde workers, las peticiones de `SharedWorker` y `WebTransport` **no quedan cubiertos** por esta regla. La solución real para ellos es un filtro de salida (egress) o un proxy filtrante delante del contenedor del navegador; Crow no incluye ninguno.
- **No se limpia tras un fallo del proceso.** La regla vive en la propia conexión Playwright del servidor MCP. Cuando ese proceso se va de una forma que aún ejecuta sus manejadores (se cierra stdin, `SIGTERM`, `SIGINT`, el bucle de eventos se vacía) manda cada página abierta a `about:blank` y cierra antes las pestañas de más. Un fallo que no ejecuta ningún manejador (`SIGKILL`, un segfault, el OOM killer) deja las páginas corriendo sin protección — eso tampoco se puede limpiar desde aquí; la imposición en la capa de red es la solución real.
- **No permite fijar la resolución DNS del propio Chrome.** Para un nombre, el guard resuelve y juzga el destino antes de continuar la petición (la ruta espera a `checkUrl` y un rechazo aborta antes de `route.continue()`), pero Playwright no puede hacer que Chrome resuelva con la búsqueda de Crow: Chrome vuelve a resolver el nombre un instante después. Un nombre cuya respuesta cambia entre esas dos resoluciones puede, por tanto, alcanzar una dirección privada en su primera petición rebotada. Crow juzga la dirección desde la que realmente se sirvió la respuesta, descarta la página cuando es privada y rechaza ese nombre de host en la capa de ruta durante cinco minutos, así que toda petición posterior a él se detiene. La primera petición rebotada no se detiene. Un despliegue endurecido puede añadir una regla de resolución de host de Chromium para los nombres que le importen, de modo que Chrome no pueda resolverlos a una dirección privada (por ejemplo `--host-resolver-rules=MAP internal.example 203.0.113.10`); Crow no añade esa regla, y esto no se impone al resolutor propio de Chrome.

Cuando termina el turno de un bot, Crow lleva cada página que ese bot abrió o usó a una página en blanco, espera a que quede en blanco y luego la cierra, así que nada de lo que abrió sigue en marcha y el botón Atrás no puede recuperarlo. Las pestañas que abriste tú antes del turno siguen abiertas con su historial. Por seguridad, Crow también cierra: tu pestaña cuya ventana emergente usó el bot (y las demás ventanas emergentes de esa pestaña), una ventana emergente cuya pestaña de origen ya habías cerrado, y cualquier pestaña nueva que aparezca mientras un bot trabaja o en los cinco segundos siguientes. Las cookies y los inicios de sesión guardados del bot se conservan.
