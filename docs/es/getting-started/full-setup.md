---
title: Instalación Completa
---

# Instalación Completa

Ejecuta la plataforma Crow completa — gateway, almacenamiento de objetos Garage, blog y Crow's Nest — con un solo comando de Docker Compose.

## ¿Qué es esto?

La instalación completa inicia todos los servicios de Crow juntos: el gateway MCP, el almacenamiento de objetos [Garage](https://garagehq.deuxfleurs.fr/) y el Crow's Nest. Esta es la forma recomendada de ejecutar Crow si quieres tener todas las funciones disponibles.

## ¿Por qué querría esto?

- **Todo a la vez** — Un comando para iniciar la plataforma completa
- **Almacenamiento de archivos incluido** — Garage corre junto al gateway, sin configuración separada
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
cp .env.garage.example .env.garage
```

Dos archivos, dos lectores:

- **`.env`** — lo lee el gateway. Los ajustes propios de Crow, más la clave `S3_*` con la que llega al almacenamiento de objetos.
- **`.env.garage`** — lo lee solo el servicio `garage` (su propio `env_file:` en `docker-compose.yml`). Aquí viven los cinco secretos `GARAGE_*` de Garage.

El token de administración, el secreto RPC y el token de métricas de Garage no van nunca en `.env`: el gateway necesita una clave S3, nunca el token de administración del clúster. Entre los dos archivos solo se comparte el par de claves S3, copiado a mano.

## Paso 2: Editar las Variables de Entorno

`.env` — el archivo del gateway. De Garage solo entra el par de claves S3:

```bash
# El gateway llega a Garage por S3 con ESTE par de claves y nada más: ningún otro
# valor de Garage va en este archivo. Garage crea esa clave en su primer arranque
# (--default-access-key), así que copia el mismo par desde .env.garage.
S3_ENDPOINT=garage:3900        # "garage" para Docker Compose, 127.0.0.1:3900 fuera de Docker
S3_ACCESS_KEY=                 # = GARAGE_DEFAULT_ACCESS_KEY de .env.garage
S3_SECRET_KEY=                 # = GARAGE_DEFAULT_SECRET_KEY de .env.garage
S3_USE_SSL=false
S3_REGION=us-east-1            # debe coincidir con s3_region en bundles/garage/garage.toml

# Cuota de almacenamiento (en MB)
STORAGE_QUOTA_MB=1024
```

`.env.garage` — los secretos propios del contenedor Garage (los cinco son obligatorios). Formatos: el ID de clave es `GK` + 24 caracteres hex, el secreto S3 y el secreto RPC son 64 caracteres hex, y los tokens de administración y métricas son cualquier cadena aleatoria larga de al menos 32 caracteres (64 hex vale):

```bash
GARAGE_RPC_SECRET=             # 64 hex — el preflight rechaza uno en blanco o no hex
GARAGE_ADMIN_TOKEN=            # una cadena aleatoria larga (32+ caracteres) — control total
GARAGE_METRICS_TOKEN=          # una cadena aleatoria larga (32+ caracteres)
GARAGE_DEFAULT_ACCESS_KEY=     # ID de clave "GK" + 24 hex — cópialo a .env como S3_ACCESS_KEY
GARAGE_DEFAULT_SECRET_KEY=     # 64 hex — cópialo a .env como S3_SECRET_KEY
```

Genera los cinco valores y pega cada línea en `.env.garage` — Compose no expande `$(…)` dentro de un archivo de entorno, así que los valores tienen que quedar literales ahí. Después copia la clave de acceso y su secreto a `.env` como `S3_ACCESS_KEY` / `S3_SECRET_KEY`:

```bash
echo "GARAGE_DEFAULT_ACCESS_KEY=GK$(openssl rand -hex 12)"   # ID de clave: "GK" + 24 hex — cópialo también como S3_ACCESS_KEY
echo "GARAGE_DEFAULT_SECRET_KEY=$(openssl rand -hex 32)"     # 64 hex — cópialo también como S3_SECRET_KEY
echo "GARAGE_RPC_SECRET=$(openssl rand -hex 32)"             # 64 hex — el preflight rechaza uno en blanco o no hex
echo "GARAGE_ADMIN_TOKEN=$(openssl rand -hex 32)"
echo "GARAGE_METRICS_TOKEN=$(openssl rand -hex 32)"
```

Por qué la separación: el gateway habla con Garage por S3 y no necesita nada más que el par de claves, así que nunca debe guardar el token de administración del clúster ni el secreto RPC — si se filtrara el entorno del gateway, entregaría todo el clúster de almacenamiento. `.env.garage` lo lee únicamente el contenedor de Garage y su comprobación de un solo uso `garage-preflight` (y está en `.gitignore`, igual que `.env`).

El puerto va dentro de `S3_ENDPOINT` (no existe `S3_PORT`), y `S3_ACCESS_KEY` / `S3_SECRET_KEY` del gateway deben ser el mismo par que `GARAGE_DEFAULT_ACCESS_KEY` / `GARAGE_DEFAULT_SECRET_KEY` — Garage crea esa clave en el primer arranque. Si dejas un valor `GARAGE_*` en blanco (o fuera del formato de arriba), el perfil de almacenamiento se detiene antes de que Garage arranque: el servicio de un solo uso `garage-preflight` revisa los cinco, sale con 78 y una línea que nombra la variable mala, y `garage` espera por él — mientras que el gateway sí arranca. La configuración del blog se gestiona vía la herramienta MCP `crow_blog_settings` o el Crow's Nest — no se necesitan variables de entorno.

::: warning MinIO ya no es el valor por defecto — y su imagen ya no se publica
Garage pasó a ser el almacenamiento de objetos por defecto el 2026-11-05. **Las imágenes públicas de MinIO ya no están:** Docker Hub y Quay rechazan las descargas anónimas desde esa fecha, así que una instalación nueva ya no puede descargar MinIO. MinIO quedó detrás del perfil `minio-legacy`.

**¿Ya tienes MinIO corriendo?** Tus datos no cambian. Arranca el perfil heredado en lugar de `storage`:

```bash
docker compose --profile cloud --profile minio-legacy up -d
```

Conserva tus ajustes `MINIO_ENDPOINT` / `MINIO_PORT` / `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` — los nombres antiguos `MINIO_*` se siguen leyendo cuando no hay ningún ajuste `S3_*` — y puedes seguir ahí todo el tiempo que quieras. Un `MINIO_ROOT_PASSWORD` en blanco, el valor por defecto `minioadmin`, o cualquier cosa de menos de 8 caracteres detiene el contenedor de MinIO al arrancar: el entrypoint del servicio lo rechaza (salida 78) en vez de dejar que MinIO caiga en sus credenciales públicas por defecto.

**Mover datos a Garage no está automatizado.** Crow no tiene ningún comando de exportación o importación de MinIO a Garage: una instalación con `--profile storage` arranca con los volúmenes `garage-meta` / `garage-data` vacíos, y los archivos guardados no se trasladan. Por eso las instalaciones existentes pueden seguir usando `--profile minio-legacy` como su almacenamiento; las instalaciones nuevas deben usar `--profile storage` y los ajustes `S3_*` de arriba.
:::

## Paso 3: Iniciar Todo

```bash
docker compose --profile cloud --profile storage up --build
```

Esto inicia:

- **Gateway** en el puerto `3001` — servidor MCP, blog y API
- **Garage** — almacenamiento de archivos; la API S3 se queda en la red de compose y solo la API de administración responde en `127.0.0.1:3903`
- **Crow's Nest** en `/dashboard` en el gateway

En la primera ejecución, Docker descarga las imágenes y construye el gateway. Los inicios posteriores son más rápidos.

## Paso 4: Inicializar la Base de Datos

En una terminal separada:

```bash
docker compose exec crow-gateway npm run init-db
```

Esto crea la base de datos SQLite con todas las tablas requeridas.

## Paso 5: Acceder a Tus Servicios

| Servicio | URL |
|---|---|
| Chequeo de salud del gateway | `http://localhost:3001/health` |
| Crow's Nest | `http://localhost:3001/dashboard` |
| Blog | `http://localhost:3001/blog` |

Los archivos almacenados se navegan en la página **Archivos** del Crow's Nest — Garage no tiene consola web propia (su API de administración en `127.0.0.1:3903` es para herramientas, no para el navegador).

## Paso 6: Generar la Configuración MCP

Para usar el servidor de almacenamiento con Claude u otras plataformas de IA:

```bash
npm run mcp-config
```

Esto regenera `.mcp.json` con el servidor de almacenamiento incluido (solo si las variables de entorno `S3_*` están definidas).

## Ejecutar en Segundo Plano

Para mantener los servicios corriendo después de cerrar la terminal:

```bash
docker compose --profile cloud --profile storage up --build -d
```

Ver registros:

```bash
docker compose logs -f crow-gateway
docker compose logs -f garage
```

Detener todo:

```bash
docker compose --profile cloud --profile storage down
```

## Datos Persistidos

Los datos se almacenan en volúmenes de Docker:

- **crow-data** — Base de datos SQLite, archivos de identidad
- **garage-meta** / **garage-data** — Metadatos de Garage y todos los archivos subidos

Estos persisten entre reinicios de contenedores. Para reiniciar todo desde cero:

```bash
docker compose --profile cloud --profile storage down -v
```

Esto elimina todos los datos. Úsalo con precaución.

## Agregar Tailscale

Para acceso remoto seguro, instala Tailscale en la máquina anfitriona (no dentro de Docker). Consulta la [guía de Configuración de Tailscale](/es/getting-started/tailscale-setup).

## Contraseña del Crow's Nest

La primera vez que visites el Crow's Nest (`/dashboard`), se te pedirá definir una contraseña. También puedes definirla desde la página `/setup` o pidiéndoselo a tu IA: "Define mi contraseña del Crow's Nest."

::: tip Enlace de configuración inicial
Mientras no exista una contraseña, las páginas de configuración inicial piden un token de un solo uso, para que nadie más en tu red pueda definir la contraseña primero. El instalador imprime la URL de configuración con `?token=…` ya incluido; ese mismo token se guarda en `~/.crow/setup-token` (solo tu cuenta puede leerlo) por si lo necesitas de nuevo. Abrir la página en la máquina misma — `http://localhost:3001/setup`, o mediante un túnel SSH — no requiere token. El token deja de funcionar en cuanto defines la contraseña.
:::

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

## Solución de Problemas

**El gateway se reinicia sin parar y el registro dice `Cannot find module '/prebuilds/linux-x64/rocksdb-native.node'`.** El addon nativo precompilado enlaza con `libatomic.so.1`, que las imágenes de servidor y de nube mínimas no incluyen. Instálalo y reinicia el gateway:

```bash
sudo apt install libatomic1
docker compose restart crow-gateway
```

(Si el instalador configuró el gateway como servicio, usa `sudo systemctl restart crow-gateway` en su lugar.)

## Próximos Pasos

- [Guía de almacenamiento](/es/guide/storage) — Aprende a subir y gestionar archivos (Garage, la extensión File Storage)
- [Guía del blog](/es/guide/blog) — Empieza a escribir y publicar entradas
- [Guía del Crow's Nest](/es/guide/crows-nest) — Explora el panel de control visual
