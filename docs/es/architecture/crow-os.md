# Arquitectura de Crow OS

Crow OS transforma un Raspberry Pi OS de fábrica en un appliance dedicado de Crow. No es una distribución de Linux personalizada — es un script instalador que configura componentes estándar sobre Debian/Ubuntu.

## Filosofía de diseño

**Instalador, no imagen.** Siguiendo el enfoque al que convergió Umbrel, Crow OS usa un único script de instalación en lugar de una imagen de SO personalizada. Beneficios:
- Los usuarios pueden aplicar las actualizaciones de seguridad del SO con normalidad
- No hay kernel ni sistema init personalizados que mantener
- Funciona en cualquier sistema ARM64 con Debian/Ubuntu, no solo Raspberry Pi
- Menor carga de mantenimiento que mantener imágenes ISO

## Vista general de la arquitectura

```
┌─────────────────────────────────────────────┐
│       Navegador (cualquier dispositivo)      │
│         https://crow.local/setup            │
└──────────────────────┬──────────────────────┘
                       │ HTTPS (puerto 443)
┌──────────────────────▼──────────────────────┐
│                    Caddy                     │
│       Reverse proxy + terminación TLS        │
│    (autofirmado / Tailscale / Let's Encrypt) │
└──────────────────────┬──────────────────────┘
                       │ HTTP (puerto 3001)
┌──────────────────────▼──────────────────────┐
│              Crow Gateway (Node.js)          │
│  ┌─────────┐ ┌──────────┐ ┌──────────────┐  │
│  │Servidor │ │ Servidor │ │ Servidor de  │  │
│  │ Memoria │ │ Investi- │ │ Compartición │  │
│  │         │ │ gación   │ │              │  │
│  └────┬────┘ └─────┬────┘ └──────┬───────┘  │
│       │            │             │           │
│  ┌────▼────┐ ┌─────▼────┐ ┌─────▼───────┐  │
│  │Servidor │ │ Servidor │ │ Crow's Nest │  │
│  │  Blog   │ │ Almacen. │ │     UI      │  │
│  └────┬────┘ └─────┬────┘ └─────────────┘  │
│       │            │                         │
│  ┌────▼────────────▼────┐                   │
│  │    SQLite (local)     │                   │
│  │  ~/.crow/data/crow.db │                   │
│  └──────────────────────┘                   │
└─────────────────────────────────────────────┘
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
┌──────────────┐ ┌──────────┐ ┌──────────┐
│   Ollama     │ │Nextcloud │ │  Immich  │
│  (Docker)    │ │ (Docker) │ │ (Docker) │
│  opcional    │ │ opcional │ │ opcional │
└──────────────┘ └──────────┘ └──────────┘
```

## Estructura del directorio de datos

Todos los datos de Crow viven en `~/.crow/`, lo que hace que la instalación completa sea portátil:

```
~/.crow/
├── app/                    # Clon git del repo de Crow
├── data/
│   ├── crow.db             # Base de datos SQLite (todas las memorias, investigación, blog, etc.)
│   └── identity.json       # Identidad criptográfica (Ed25519 + secp256k1)
├── .env                    # Claves de API y configuración (permisos 600)
├── panels/                 # Paneles del Crow's Nest instalados
├── panels.json             # Paneles habilitados
├── installed.json          # Seguimiento de complementos instalados
├── bundles/                # Archivos de los complementos bundle instalados
│   ├── ollama/
│   │   ├── docker-compose.yml
│   │   └── .env
│   └── nextcloud/
│       ├── docker-compose.yml
│       └── .env
├── minio-data/             # Almacenamiento MinIO (si el almacenamiento está habilitado)
└── update.log              # Historial de actualizaciones
```

## Script instalador

`scripts/crow-install.sh` realiza estos pasos:

1. **Actualizaciones del sistema** — `apt update && apt upgrade`
2. **Node.js 20** — vía el repositorio de NodeSource
3. **Docker + Docker Compose** — script de instalación oficial
4. **Caddy** — reverse proxy con TLS automático
5. **Avahi** — mDNS para el hostname `crow.local`
6. **Configuración de Crow** — clonar el repo, `npm run setup`, generar la identidad
7. **Servicios systemd** — `crow-gateway.service` para el arranque automático
8. **Endurecimiento de seguridad** — firewall UFW, ufw-docker, fail2ban

### Modelo de seguridad

| Capa | Protección |
|---|---|
| **Red** | UFW con denegación por defecto, solo los puertos 22 (SSH) y 443 (HTTPS) |
| **Docker** | La utilidad `ufw-docker` resuelve el conflicto Docker/UFW sin romper la red entre contenedores |
| **Autenticación** | OAuth del gateway habilitado por defecto, contraseña del Crow's Nest requerida |
| **Secretos** | `~/.crow/.env` con permisos 600 |
| **SSH** | fail2ban monitorea y bloquea los intentos de fuerza bruta |
| **TLS** | Autofirmado por defecto, mejorable a Tailscale o Let's Encrypt |

::: warning ¿Por qué no `iptables: false`?
Establecer `"iptables": false` en el daemon.json de Docker es una recomendación común para los conflictos Docker/UFW, pero **rompe la red entre contenedores**. Crow usa en su lugar la utilidad `ufw-docker`, que agrega reglas UFW adecuadas que funcionan junto al iptables de Docker.
:::

## Gestor del ciclo de vida de bundles

La CLI `crow` gestiona los complementos bundle:

```bash
crow bundle install <id>    # Copiar archivos, descargar imágenes
crow bundle start <id>      # docker compose up -d
crow bundle stop <id>       # docker compose stop
crow bundle remove <id>     # Detener, eliminar imágenes, limpiar archivos
crow bundle status          # Listar los bundles instalados
```

Los archivos de los bundles se almacenan en `~/.crow/bundles/<id>/`. Cada bundle tiene su propio `docker-compose.yml` y su archivo `.env`.

## Mecanismo de actualización

`scripts/crow-update.sh` realiza actualizaciones seguras:

1. Guarda la referencia git actual para poder revertir
2. `git pull --ff-only` (falla de forma segura ante conflictos)
3. `npm install` para las dependencias nuevas
4. `npm run init-db` para las migraciones de esquema
5. Reinicia `crow-gateway.service`
6. Si el gateway no logra arrancar: reversión automática a la referencia anterior
7. Registra los resultados en `~/.crow/update.log`

## Opciones de HTTPS

HTTPS progresivamente mejor, de lo más simple a lo mejor:

| Opción | Configuración | Certificado | Requisito |
|---|---|---|---|
| Autofirmado (predeterminado) | Automática | Advertencia del navegador | Ninguno |
| Tailscale | `tailscale up` + actualizar el Caddyfile | Válido, automático | Cuenta gratuita de Tailscale |
| Let's Encrypt | Apuntar el DNS del dominio + actualizar el Caddyfile | Válido, automático | Nombre de dominio |
| Cloudflare Tunnel | Instalar cloudflared + configurar | Válido, automático | Cuenta gratuita de Cloudflare |

## Compatibilidad con ARM64

Todos los componentes centrales corren nativamente en ARM64. Compatibilidad de los complementos bundle:

| Bundle | ARM64 | Notas |
|---|---|---|
| Ollama | Sí | Usa modelos más pequeños (llama3.2:1b) en una Pi 4 |
| Nextcloud | Sí | Imágenes ARM64 oficiales |
| Immich | Limitado | Revisa la versión más reciente para el soporte de ARM64 |
| MinIO | Sí | Imágenes ARM64 oficiales |
