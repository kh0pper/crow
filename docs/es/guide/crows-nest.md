---
title: Crow's Nest
---

# Crow's Nest

El Crow's Nest es tu panel de control privado para gestionar tu instancia de Crow. Es accesible desde tu red local o vía Tailscale — nunca expuesto al internet público.

## ¿Qué es esto?

El Crow's Nest es una interfaz web protegida con contraseña servida por tu gateway. Te da una forma de apuntar y hacer clic para gestionar mensajes, publicaciones del blog, archivos y configuración — todo lo que puedes hacer mediante herramientas MCP, pero en un navegador.

## ¿Por qué querría esto?

- **Vista rápida** — Ve tus mensajes, publicaciones recientes y uso de almacenamiento de un vistazo
- **Acceso no técnico** — Gestiona Crow sin usar una terminal ni una conversación con la IA
- **Gestión de archivos** — Navega, sube y elimina archivos almacenados con arrastrar y soltar
- **Configuración** — Cambia la configuración sin editar archivos `.env`
- **Compatible con móviles** — Accede desde tu teléfono por tu red local o Tailscale

## Iniciar el gateway

El Crow's Nest requiere que el gateway esté en ejecución. Dependiendo de cómo instalaste Crow, esto puede estar ya resuelto:

- **Crow OS (Raspberry Pi)** — El instalador crea un servicio systemd `crow-gateway` que inicia automáticamente
- **Nube (Render)** — El gateway corre como el proceso principal
- **Docker** — `docker compose` ejecuta el contenedor del gateway
- **Escritorio (stdio)** — Sin gateway por defecto — necesitas iniciarlo manualmente si quieres el Crow's Nest o el blog

### Inicio manual (desarrollo / escritorio)

```bash
npm run gateway
```

Esto inicia el gateway en el puerto 3001 (o el puerto definido en `PORT` / `CROW_GATEWAY_PORT`). Presiona Ctrl-C para detenerlo.

### Servicio persistente (autoalojado)

Para un servidor autoalojado (Raspberry Pi, Ubuntu, etc.), crea un servicio systemd para que el gateway inicie al arrancar y se reinicie ante fallos.

**Servicio a nivel de sistema** (corre como un usuario dedicado):

```bash
sudo tee /etc/systemd/system/crow-gateway.service > /dev/null << 'EOF'
[Unit]
Description=Crow Gateway
After=network.target

[Service]
Type=simple
User=crow
WorkingDirectory=/home/crow/.crow/app
ExecStart=/usr/bin/node servers/gateway/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable crow-gateway
sudo systemctl start crow-gateway
```

**Servicio a nivel de usuario** (corre como tu propio usuario, sin sudo):

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/crow-gateway.service << 'EOF'
[Unit]
Description=Crow Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/.crow/app
ExecStart=/usr/bin/node servers/gateway/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable crow-gateway
systemctl --user start crow-gateway
```

**Verifica que esté corriendo:**

```bash
# Revisar el estado del servicio
sudo systemctl status crow-gateway    # nivel de sistema
systemctl --user status crow-gateway  # nivel de usuario

# Probar el endpoint de salud
curl http://localhost:3001/health
```

## Acceder al Crow's Nest

Una vez que el gateway esté en ejecución:

| Desde | URL |
|---|---|
| La misma máquina | `http://localhost:3001/dashboard` |
| LAN (otro dispositivo en tu red) | `http://<server-ip>:3001/dashboard` |
| Remoto vía Tailscale | `http://<tailscale-ip>:3001/dashboard` |
| Remoto vía `tailscale serve` | `https://<hostname>.tail1234.ts.net/dashboard` |

### Acceso remoto con `tailscale serve`

Si quieres HTTPS y un hostname apropiado sin exponer el Crow's Nest a internet:

```bash
# Servir el gateway por Tailscale con un certificado HTTPS válido
tailscale serve --bg --https=443 http://localhost:3001
```

Esto hace que el Crow's Nest esté disponible en `https://<hostname>.your-tailnet.ts.net/dashboard` desde cualquier dispositivo en tu red Tailscale. Solo los dispositivos conectados a Tailscale pueden alcanzarlo.

## Primer inicio de sesión

En el primer acceso, se te pedirá establecer una contraseña. Esta es independiente de cualquier token OAuth o clave de API — es una contraseña simple para el acceso por navegador.

Después de establecer tu contraseña, verás el Crow's Nest con su diseño de paneles.

## Paneles

El Crow's Nest está organizado en paneles. La página de inicio — etiquetada **Crow's Nest** en la navegación — muestra estadísticas de salud del sistema (CPU, RAM, disco, contenedores Docker, métricas de la base de datos) junto con la cuadrícula del [Lanzador de aplicaciones](#lanzador-de-aplicaciones).

### Mensajes

Un centro de mensajería unificado de tres paneles inspirado en WhatsApp/Signal/Telegram.

- **Franja de avatares** (izquierda) — Muestra todas las conversaciones (chats de IA y contactos peer) como avatares squircle con insignias de no leídos. Haz clic en cualquier avatar para cargar la conversación. El botón "+" abre un popover para iniciar un nuevo chat de IA, generar un código de invitación o aceptar una invitación de un contacto.
- **Área de chat** (centro) — Vista completa del chat con burbujas de mensajes, marcas de tiempo, vistas previas de respuestas y archivos adjuntos. Las conversaciones de IA usan streaming SSE con visualización de llamadas a herramientas. Los mensajes peer usan cifrado E2E de Nostr. Escribe un mensaje y presiona Enter o haz clic en Enviar.
- **Barra lateral de información** (derecha) — Perfil del contacto (avatar, Crow ID, estado en línea, información de cifrado) o detalles de la conversación de IA (proveedor, modelo, conteo de tokens). Bloquea/desbloquea contactos, elimina conversaciones y copia Crow IDs. Plegable con el botón "Info".

**Archivos adjuntos:** Si el almacenamiento MinIO está configurado, un botón de clip te permite adjuntar archivos a los mensajes peer. Las imágenes se muestran en línea; los demás archivos aparecen como tarjetas de descarga.

**Hilos de mensajes:** Haz clic en "Responder" sobre cualquier mensaje peer recibido para citarlo. La respuesta aparece con una vista previa resaltada del mensaje original.

**Actualizaciones en tiempo real:** El panel consulta nuevos mensajes cada 7 segundos, actualizando las insignias de no leídos y agregando los mensajes nuevos a la conversación activa sin recargar la página.

**Gestión de contactos:** Los contactos tienen su propio panel en `/dashboard/contacts` (cuadrícula de tarjetas, perfiles, grupos, importación/exportación de vCard); las acciones de invitar, bloquear/desbloquear y perfil también están accesibles desde el panel de Mensajes.

### Memoria

Navega y busca tus memorias almacenadas. Ve los conteos de memorias por categoría, busca por contenido y revisa las memorias recientes.

### Blog

Gestiona tus publicaciones del blog. Ve borradores y publicaciones, edita contenido, publica o despublica y revisa las estadísticas de publicaciones. El panel del blog muestra los mismos datos que las herramientas MCP `crow_list_posts` y `crow_get_post`.

### Archivos

Navega tus archivos almacenados con un explorador visual. Sube archivos nuevos arrastrando y soltando, previsualiza imágenes, copia URLs de archivos y elimina archivos. Muestra el uso de la cuota de almacenamiento.

### Extensiones

Navega e instala complementos de la comunidad. Cada complemento muestra un logo SVG (con un emoji de respaldo para complementos desconocidos), descripción y botones de acción en un diseño de tarjetas. Antes de instalar complementos que consumen muchos recursos, la página de Extensiones muestra una advertencia con los requisitos estimados de RAM y disco según el manifiesto del complemento.

### Podcasts

Suscríbete y escucha podcasts directamente en el Crow's Nest:

- **Suscripción** — Ingresa la URL de un feed RSS para agregar un podcast
- **Explorador de episodios** — Navega los episodios recientes de todas tus suscripciones con un reproductor de audio HTML5
- **Seguimiento de reproducción** — Marca episodios como reproducidos/no reproducidos
- **Soporte de playlists** — Organiza episodios en playlists (vía la base de datos — la UI está en camino)
- **Caché de feeds** — Los episodios se almacenan en caché localmente; los feeds se actualizan bajo demanda o en intervalos configurables

### Configuración

Configura tu instancia de Crow:

- Metadatos del blog (título, descripción, autor)
- Cuota de almacenamiento
- Reglas de acceso de red
- Preferencias de tema (modo oscuro/claro)

## Temas oscuro y claro

El Crow's Nest usa el sistema de diseño **Dark Editorial**. Alterna entre los modos oscuro y claro con el selector de tema en la navegación superior. Tu preferencia se guarda en tu navegador.

## Seguridad de red

El Crow's Nest es **privado por defecto** — piénsalo como una oficina trasera con llave. Solo se permiten conexiones desde redes de confianza:

| Red | Rango | Quién usa esto |
|---|---|---|
| Localhost | `127.0.0.1`, `::1` | El servidor mismo |
| LAN (Clase A) | `10.0.0.0/8` | Redes de hogar/oficina |
| LAN (Clase B) | `172.16.0.0/12` | Docker, algunas redes corporativas |
| LAN (Clase C) | `192.168.0.0/16` | La mayoría de los routers domésticos |
| Tailscale | `100.64.0.0/10` | VPN de Tailscale (rango CGNAT) |

Si una solicitud llega desde una IP fuera de estos rangos, el Crow's Nest devuelve una respuesta **403 Forbidden**. Esto es intencional — el Crow's Nest tiene control total sobre tus datos y no debe exponerse al internet público.

::: warning
Solo configura `CROW_DASHBOARD_PUBLIC=true` si el gateway está detrás de otra capa de autenticación (por ejemplo, un reverse proxy con autenticación HTTP básica, Cloudflare Access o una VPN). Sin una capa de autenticación adicional, cualquiera en internet podría acceder al Crow's Nest con solo una contraseña entre ellos y tus datos.
:::

Para acceso remoto sin abrir el Crow's Nest públicamente, usa [Tailscale](/es/getting-started/tailscale-setup). Las IPs de Tailscale caen dentro del rango `100.64.0.0/10` en el que el Crow's Nest ya confía.

Para el panorama completo de qué es público y qué es privado en Crow, consulta la [Guía de Seguridad](https://github.com/kh0pper/crow/blob/main/SECURITY.md#whats-public-by-default).

## Lanzador de aplicaciones

La página de inicio del Crow's Nest incluye una sección **Tus Apps** que muestra mosaicos de lanzamiento para tus complementos instalados. Cada mosaico muestra:

- **Logo SVG** (48px) — Provisto por el complemento, o una letra inicial de respaldo
- **Nombre** — El nombre visible del complemento
- **Indicador de estado** — Un punto verde para contenedores en ejecución o un punto gris para los detenidos (solo complementos basados en Docker)
- **Botón Abrir** — Para complementos con interfaz web (por ejemplo, Nextcloud, Immich), un botón que abre la app en una pestaña nueva

El lanzador lee `~/.crow/installed.json` y filtra los complementos de tipo `bundle` y `mcp-server`. El estado de los contenedores Docker se verifica vía `docker ps --filter` con una caché de 30 segundos para evitar comandos de shell repetidos al cargar la página.

Los complementos que declaran un campo `webUI` en su manifiesto (con `port`, `path` y `label`) obtienen un botón "Abrir" que enlaza a la interfaz web local.

## Paneles de terceros

El Crow's Nest soporta paneles complementarios creados por la comunidad. Los paneles se colocan en `~/.crow/panels/` y se habilitan mediante un archivo de configuración. Los complementos que incluyen un campo `panel` en su manifiesto obtienen su panel instalado y registrado automáticamente al instalar el complemento, y se elimina al desinstalarlo. Consulta [Creating Panels](/es/developers/creating-panels) para más detalles.

## Bajo el capó

Para el registro de paneles, el sistema de autenticación y los detalles internos del diseño, consulta la [arquitectura del Crow's Nest](/es/architecture/dashboard).
