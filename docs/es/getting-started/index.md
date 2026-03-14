# Primeros Pasos

Crow se puede configurar de varias maneras dependiendo de tu caso de uso:

## Elige Tu Camino

### Oracle Cloud Nivel Gratuito (Recomendado) :star:

Un servidor en la nube permanente que nunca se apaga, nunca caduca y no cuesta nada. Usa SQLite local — no necesitas base de datos externa.

> [Guía de Oracle Cloud](./oracle-cloud)

### Servidor en Casa (Pi / Máquina siempre encendida)

Ejecuta Crow en una Raspberry Pi, laptop vieja, NUC o cualquier máquina Linux siempre encendida. Instalación con un solo comando.

> [Guía de Servidor en Casa](./home-server)

### Instalación de Escritorio (Computadora personal)

Ejecuta Crow localmente, conectado directamente a Claude Desktop, Claude Code, Cursor y otras herramientas. No necesitas la nube.

> [Guía de Instalación de Escritorio](./desktop-install)

### Hosting Administrado (Lo más fácil)

Instancia de Crow preconfigurada — sin configuración, sin mantenimiento. Tu propio subdominio en `usuario.crow.maestro.press` con Crow's Nest, blog, integraciones de IA, respaldos diarios y SSL incluidos.

> [Guía de Hosting Administrado](./managed-hosting)

## Lo Que Obtendrás

Después de la configuración, tu asistente de IA tendrá:

- **Memoria persistente** — recuerda entre conversaciones
- **Gestión de proyectos** — organiza investigaciones, conectores de datos, fuentes y citas APA generadas automáticamente
- **Más de 20 integraciones** — Gmail, GitHub, Slack, Notion, Trello y más
- **Búsqueda de texto completo** — encuentra cualquier cosa almacenada en la memoria o proyectos
- **Compartir P2P encriptado** — comparte memorias y proyectos con otros usuarios de Crow
- **Almacenamiento de archivos** — sube y gestiona archivos con almacenamiento compatible con S3
- **Plataforma de blog** — publica entradas con Markdown, feeds RSS y temas
- **Crow's Nest** — interfaz web visual para gestionar tu instancia de Crow

**¿Qué es público?** Tu blog es lo único visible al exterior, y solo aparecen las entradas que publiques explícitamente con visibilidad `public`. Tu Crow's Nest, datos y endpoints MCP son privados por defecto.

## Requisitos

- Node.js 18+ (para todas las opciones autoalojadas)
- Una cuenta gratuita de [Oracle Cloud](https://cloud.oracle.com) (para despliegue en la nube)
- Raspberry Pi 4+ con 4 GB de RAM (para Crow OS)
- Una cuenta en al menos una plataforma de IA (Claude, ChatGPT, Gemini, etc.)
