# Opciones de Hosting Gratuito

Crow puede desplegarse gratis en varias plataformas. Así se comparan:

## Comparación

| Opción | Cómputo | RAM | Almacenamiento | ¿Siempre Encendido? | ¿BD Externa? | Ideal Para |
|---|---|---|---|---|---|---|
| **[Oracle Cloud](./oracle-cloud)** | 1 OCPU (x86) | 1 GB | 47 GB | Sí | No (SQLite local) | Servidor en la nube gratuito permanente |
| **[Google Cloud](./google-cloud)** | e2-micro (0.25 vCPU) | 1 GB | 30 GB | Sí | No (SQLite local) | Instancia secundaria/satélite |
| **[Servidor en Casa](./home-server)** | Varía | 4-32 GB | Ilimitado | Sí | No (SQLite local) | Control total, todos los complementos |
| **[Instalación de Escritorio](./desktop-install)** | Tu PC | Tu PC | Tu PC | Mientras corre | No (SQLite local) | Inicio rápido, una sola máquina |
| **[Hosting Administrado](./managed-hosting)** | Compartido | Compartido | Incluido | Sí | No | Cero mantenimiento ($15/mes) |
| **Render** *(legado)* | Compartido | 512 MB | Efímero | No (se duerme) | N/A | No recomendado |

## Nivel Gratuito de Oracle Cloud (Recomendado)

El nivel Always Free de Oracle incluye una instancia VM.Standard.E2.1.Micro — 1 OCPU y 1 GB de RAM. Nunca se duerme, nunca expira y usa SQLite local directamente en disco (sin necesidad de base de datos externa).

> [Guía Completa de Configuración de Oracle Cloud →](./oracle-cloud)

## Servidor en Casa

Ejecuta Crow en una Raspberry Pi, una laptop vieja o cualquier máquina Linux siempre encendida. Instalación de un solo comando, control total sobre tu hardware y tus datos.

> [Guía de Servidor en Casa →](./home-server)

Para detalles específicos de Raspberry Pi (flasheo, mDNS, tabla de hardware), consulta la [Guía de Raspberry Pi](./raspberry-pi).

## Instalación de Escritorio

Ejecuta todo localmente en tu computadora personal. Se conecta directamente a Claude Desktop, Claude Code, Cursor y más. No necesita nube, pero solo funciona en esa máquina.

> [Guía de Instalación de Escritorio →](./desktop-install)

## Hosting Administrado

Olvídate de toda la infraestructura. Por $15/mes o $120/año obtienes una instancia de Crow preconfigurada con actualizaciones automáticas, respaldos diarios y SSL — sin configuración requerida.

> [Guía de Hosting Administrado →](./managed-hosting)

## ¿Cuál Debería Elegir?

- **¿Quieres un servidor gratuito permanente?** → [Oracle Cloud](./oracle-cloud). Nunca se duerme, SQLite local, 47 GB de disco.
- **¿Tienes una Raspberry Pi o una laptop vieja?** → [Servidor en Casa](./home-server). Control total, todos los complementos soportados.
- **¿Solo quieres probar Crow?** → [Instalación de Escritorio](./desktop-install). Clona, configura, conecta — listo en 5 minutos.
- **¿No quieres gestionar nada?** → [Hosting Administrado](./managed-hosting). Cero mantenimiento, en línea en minutos.

**Nuestra recomendación:** Empieza con [Oracle Cloud](./oracle-cloud) como tu instancia principal — tiene más RAM y está disponible de forma confiable. Luego agrega [Google Cloud](./google-cloud) como satélite y [encadénalas](./multi-device) para tener redundancia y federación. Dos nubes siempre gratuitas, sincronizadas automáticamente.

::: details Legado: Render (Archivado)
La ruta de despliegue Render + Turso ya no está soportada. El soporte para la base de datos en la nube de Turso fue eliminado de Crow — la sincronización multi-dispositivo ahora se maneja con replicación P2P de Hypercore con SQLite local.

Consulta la guía [Despliegue en la Nube (Legado)](./cloud-deploy) para referencia histórica.
:::
