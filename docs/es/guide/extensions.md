---
title: Extensiones
---

# Extensiones

La funcionalidad de Crow se puede ampliar con add-ons instalados desde la página de Extensiones. Cada extensión puede incluir herramientas MCP, paneles del dashboard, servicios Docker y skills de IA.

## Instalar Extensiones

1. Ve a **Extensiones** en tu dashboard Crow's Nest
2. Explora las extensiones disponibles por categoría
3. Haz clic en **Instalar** y configura cualquier ajuste requerido (claves de API, contraseñas, etc.)
4. La extensión se instala automáticamente — los paneles aparecen en la barra lateral tras reiniciar el gateway

## Qué Sucede al Instalar

Según el tipo de extensión:

- **Servidor MCP** — registra herramientas accesibles para el chat de IA y Claude Code
- **Bundle** (Docker) — descarga imágenes, inicia contenedores, abre puertos del firewall
- **Skill** — agrega prompts conductuales que guían las respuestas de la IA
- **Panel** — agrega una página del dashboard con interfaz web

Las extensiones con interfaces web se sirven automáticamente a través del proxy del gateway (sin puertos extra que abrir).

## Eliminar Extensiones

1. Ve a **Extensiones** en el dashboard
2. Encuentra la extensión instalada y haz clic en **Eliminar**
3. Los contenedores se detienen, los archivos se eliminan, los puertos del firewall se cierran

## Extensiones Disponibles

### IA y Automatización
| Extensión | Tipo | Descripción |
|-----------|------|-------------|
| [Automatización de Navegador](/guide/browser-automation) | Bundle | Navegador sigiloso con VNC, llenado de formularios, scraping |
| Ollama | Bundle | Modelos de IA locales para embeddings y análisis |
| LocalAI | Bundle | Inferencia local compatible con OpenAI |
| [Bot Builder](/es/guide/bot-builder) | Integrado | Agentes de Gmail, Discord y lentes — crea, despliega y gestiona agentes desde el dashboard. Autoconfiguración BYOAI, integración con Mensajes, despliegue de skills. |

### Finanzas
| Extensión | Tipo | Descripción |
|-----------|------|-------------|
| [Asistente de Declaración de Impuestos](/guide/tax-filing) | Servidor MCP | Preparación de impuestos federales con ingesta de PDF |

### Medios
| Extensión | Tipo | Descripción |
|-----------|------|-------------|
| Media Hub | Servidor MCP | Feeds RSS, YouTube, podcasts, TTS, resúmenes por correo |
| Podcast | Skill | Publicación de podcasts con RSS de iTunes |
| Songbook | Skill | Partituras ChordPro, transposición, setlists |

### Almacenamiento y Productividad
| Extensión | Tipo | Descripción |
|-----------|------|-------------|
| Almacenamiento de Archivos (MinIO) | Bundle | Almacenamiento de archivos compatible con S3 |
| Nextcloud | Bundle | Sincronización de archivos vía WebDAV |
| Obsidian Vault | Servidor MCP | Lee y busca en notas de Obsidian |

### Hogar Inteligente y Videojuegos
| Extensión | Tipo | Descripción |
|-----------|------|-------------|
| Home Assistant | Servidor MCP | Controla luces, interruptores, sensores |
| RoMM | Bundle | Biblioteca de juegos retro y emulador |

### Social y Comunicación
| Extensión | Tipo | Descripción |
|-----------|------|-------------|
| [Videollamadas y Llamadas de Audio](/guide/calls) | Bundle | Llamadas de video/audio entre pares con WebRTC |

### Infraestructura
| Extensión | Tipo | Descripción |
|-----------|------|-------------|
| Tailscale | Bundle | Acceso VPN desde cualquier dispositivo |
| [Notificaciones Push (ntfy)](/es/guide/notifications) | Bundle | Push autoalojado vía la app ntfy |
| Servidor TURN (coturn) | Bundle | Relay WebRTC para atravesar NAT |

## Interfaces Web de las Extensiones

Algunas extensiones proveen interfaces web (visor VNC, consola de MinIO, etc.). Se accede a ellas de dos maneras:

### Modo Proxy (predeterminado)
La interfaz de la extensión se sirve a través del gateway de Crow en `/proxy/<id>/`. No se necesitan puertos extra ni reglas de firewall. Funciona para apps simples (VNC/noVNC).

**Ejemplo**: `/proxy/browser/vnc.html`

### Modo Directo
Para apps SPA (React, Vue) que no pueden funcionar detrás de un proxy con subruta. El puerto de la extensión se abre en el firewall y se sirve vía HTTPS de Tailscale.

**Ejemplo**: `https://your-machine.ts.net:9001/` (consola de MinIO)

Esto se configura automáticamente durante la instalación — los puertos se abren y el HTTPS de Tailscale queda listo.

## Para Desarrolladores

Consulta la guía [Creating Add-ons](/developers/creating-addons) para construir tus propias extensiones.
