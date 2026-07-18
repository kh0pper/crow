---
title: Instalación Completa
---

# Instalación Completa

Ejecuta la plataforma Crow completa — gateway, almacenamiento MinIO, blog y Crow's Nest — con un solo comando de Docker Compose.

## ¿Qué es esto?

El perfil de instalación completa inicia todos los servicios de Crow juntos: el gateway MCP, MinIO para almacenamiento de archivos y el Crow's Nest. Esta es la forma recomendada de ejecutar Crow si quieres tener todas las funciones disponibles.

## ¿Por qué querría esto?

- **Todo a la vez** — Un comando para iniciar la plataforma completa
- **Almacenamiento de archivos incluido** — MinIO corre junto al gateway, sin configuración separada
- **Blog listo** — Empieza a publicar inmediatamente después de la configuración
- **Acceso al Crow's Nest** — Gestión visual desde tu navegador

## Requisitos Previos

- Docker y Docker Compose instalados
- Git (para clonar el repositorio)
- Una máquina con al menos 1 GB de RAM

## Paso 1: Clonar y Configurar

```bash
git clone https://github.com/kh0pper/crow.git
cd crow
cp .env.example .env
```

## Paso 2: Editar las Variables de Entorno

Abre `.env` y define los valores requeridos:

```bash
# MinIO (almacenamiento de archivos)
MINIO_ENDPOINT=minio          # Usa "minio" para Docker, "localhost" para local
MINIO_PORT=9000
MINIO_ROOT_USER=crowadmin
MINIO_ROOT_PASSWORD=change-this-to-a-secure-password
MINIO_USE_SSL=false

# Cuota de almacenamiento (en MB)
STORAGE_QUOTA_MB=1024
```

Cuando ejecutes dentro de Docker Compose, define `MINIO_ENDPOINT=minio` (el nombre del servicio en Docker). Para instalaciones locales (sin Docker), usa `MINIO_ENDPOINT=localhost`. La configuración del blog se gestiona vía la herramienta MCP `crow_blog_settings` o el Crow's Nest — no se necesitan variables de entorno.

## Paso 3: Iniciar Todo

```bash
docker compose --profile full up --build
```

Esto inicia:

- **Gateway** en el puerto `3001` — servidor MCP, blog y API
- **MinIO** en los puertos `9000` (API) y `9001` (consola) — almacenamiento de archivos
- **Crow's Nest** en `/dashboard` en el gateway

En la primera ejecución, Docker descarga las imágenes y construye el gateway. Los inicios posteriores son más rápidos.

## Paso 4: Inicializar la Base de Datos

En una terminal separada:

```bash
docker compose exec gateway npm run init-db
```

Esto crea la base de datos SQLite con todas las tablas requeridas.

## Paso 5: Acceder a Tus Servicios

| Servicio | URL |
|---|---|
| Chequeo de salud del gateway | `http://localhost:3001/health` |
| Crow's Nest | `http://localhost:3001/dashboard` |
| Blog | `http://localhost:3001/blog` |
| Consola de MinIO | `http://localhost:9001` |

La consola de MinIO te permite explorar los archivos almacenados directamente. Inicia sesión con tu `MINIO_ROOT_USER` y `MINIO_ROOT_PASSWORD`.

## Paso 6: Generar la Configuración MCP

Para usar el servidor de almacenamiento con Claude u otras plataformas de IA:

```bash
npm run mcp-config
```

Esto regenera `.mcp.json` con el servidor de almacenamiento incluido (solo si las variables de entorno de MinIO están definidas).

## Ejecutar en Segundo Plano

Para mantener los servicios corriendo después de cerrar la terminal:

```bash
docker compose --profile full up --build -d
```

Ver registros:

```bash
docker compose logs -f gateway
docker compose logs -f minio
```

Detener todo:

```bash
docker compose --profile full down
```

## Datos Persistidos

Los datos se almacenan en volúmenes de Docker:

- **crow-data** — Base de datos SQLite, archivos de identidad
- **minio-data** — Todos los archivos subidos

Estos persisten entre reinicios de contenedores. Para reiniciar todo desde cero:

```bash
docker compose --profile full down -v
```

Esto elimina todos los datos. Úsalo con precaución.

## Agregar Tailscale

Para acceso remoto seguro, instala Tailscale en la máquina anfitriona (no dentro de Docker). Consulta la [guía de Configuración de Tailscale](/es/getting-started/tailscale-setup).

## Contraseña del Crow's Nest

La primera vez que visites el Crow's Nest (`/dashboard`), se te pedirá definir una contraseña. También puedes definirla desde la página `/setup` o pidiéndoselo a tu IA: "Define mi contraseña del Crow's Nest."

### Autenticación de Dos Factores (Opcional)

Puedes habilitar 2FA basada en TOTP desde **Configuración → Autenticación de Dos Factores** en el Crow's Nest. Esto agrega un segundo paso de verificación usando una app de autenticación (Google Authenticator, Authy, etc.).

### ¿Olvidaste Tu Contraseña?

Si quedas bloqueado, restablece tu contraseña desde la línea de comandos:

```bash
npm run reset-password
```

Esto te solicita una nueva contraseña y actualiza la base de datos directamente — sin necesidad de correo ni servicios externos.

## Conectar Tu IA

Visita `http://localhost:3001/setup` para ver el estado de las integraciones y las URLs de los endpoints.

[Claude](/es/platforms/claude) · [ChatGPT](/es/platforms/chatgpt) · [Todas las plataformas](/es/platforms/)

**Pruébalo** — después de conectar tu plataforma de IA, di:

> "Recuerda que hoy es mi primer día usando Crow"
> "¿Qué recuerdas?"

::: tip Encadena múltiples instancias
Las instancias en Docker pueden encadenarse con otras instalaciones de Crow — VMs en la nube, escritorios o Raspberry Pis. Las memorias se sincronizan automáticamente vía P2P. Consulta el [Inicio Rápido Multi-Dispositivo](./multi-device).
:::

## Próximos Pasos

- [Guía de almacenamiento](/es/guide/storage) — Aprende a subir y gestionar archivos
- [Guía del blog](/es/guide/blog) — Empieza a escribir y publicar entradas
- [Guía del Crow's Nest](/es/guide/crows-nest) — Explora el panel de control visual
