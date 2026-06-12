---
title: Paperless-ngx
---

# Paperless-ngx

Conecta Crow a Paperless-ngx para buscar, subir, etiquetar y organizar tus documentos digitalizados a través de tu asistente de IA. Incluye búsqueda de texto completo con OCR.

## Qué obtienes

- Búsqueda de texto completo en todos los documentos (contenido OCR)
- Explorar y filtrar por etiquetas, remitentes y tipos de documento
- Subir nuevos documentos para procesamiento OCR
- Descargar las versiones originales o archivadas
- Gestionar etiquetas y remitentes
- Actualizar metadatos de documentos

## Configuración

Crow soporta dos modos para Paperless-ngx: autoalojamiento vía Docker o conexión a una instancia existente.

### Opción A: Docker (autoalojado)

Instala Paperless-ngx como un bundle de Crow. Esto ejecuta Paperless-ngx en Docker junto a tu gateway de Crow.

> "Crow, instala el bundle de Paperless"

O instálalo desde el panel de **Extensiones** en el Crow's Nest.

Después de la instalación, configura la contraseña de la base de datos:

```bash
# En tu archivo .env
PAPERLESS_DB_PASSWORD=tu-contrasena-segura
```

Reinicia el bundle para que los cambios surtan efecto:

> "Crow, reinicia el bundle de Paperless"

Paperless-ngx estará disponible en `http://tu-servidor:8000` para la configuración inicial. Crea una cuenta de superusuario vía la interfaz web y luego genera un token de API desde **Administración** > **Usuarios** > **Editar** > **Tokens de autenticación**.

### Opción B: Conectar a Paperless-ngx existente

Si ya tienes una instancia de Paperless-ngx funcionando, conecta Crow directamente a ella.

#### Paso 1: Obtener tu token de API

1. Abre la interfaz web de Paperless-ngx
2. Ve a **Administración** > **Usuarios**
3. Edita tu cuenta de usuario
4. Bajo **Tokens de autenticación**, genera un nuevo token
5. Copia el token

#### Paso 2: Agregar a Crow

Configura lo siguiente en tu archivo `.env` o vía **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
PAPERLESS_URL=http://tu-servidor-paperless:8000
PAPERLESS_API_TOKEN=tu-token-api-aqui
```

## Herramientas de IA

Una vez conectado, puedes interactuar con Paperless-ngx a través de tu IA:

> "Busca declaraciones de impuestos en mis documentos"

> "Muéstrame todos los documentos etiquetados como 'recibos'"

> "Sube este documento a Paperless"

> "¿Quiénes son mis remitentes?"

> "Etiqueta ese documento como 'seguro'"

## Referencia de Docker Compose

Si prefieres una configuración manual de Docker en lugar del instalador de bundles:

```yaml
services:
  paperless:
    image: ghcr.io/paperless-ngx/paperless-ngx:latest
    container_name: crow-paperless
    ports:
      - "8000:8000"
    volumes:
      - paperless-data:/usr/src/paperless/data
      - paperless-media:/usr/src/paperless/media
      - paperless-consume:/usr/src/paperless/consume
    environment:
      PAPERLESS_DBHOST: paperless-db
      PAPERLESS_REDIS: redis://paperless-redis:6379
    depends_on:
      - paperless-db
      - paperless-redis
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 1024M

  paperless-db:
    image: postgres:16
    container_name: crow-paperless-db
    volumes:
      - paperless-pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: paperless
      POSTGRES_USER: paperless
      POSTGRES_PASSWORD: ${PAPERLESS_DB_PASSWORD}
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 256M

  paperless-redis:
    image: redis:7-alpine
    container_name: crow-paperless-redis
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 128M

volumes:
  paperless-data:
  paperless-media:
  paperless-consume:
  paperless-pgdata:
```

## Solución de problemas

### "Conexión rechazada" o tiempo de espera agotado

Asegúrate de que la `PAPERLESS_URL` sea accesible desde la máquina que ejecuta Crow. Si Paperless-ngx está en otra máquina, usa la IP o el nombre de host correcto.

### "401 No autorizado" o token inválido

Es posible que el token de API haya sido eliminado o haya expirado. Regenera un nuevo token desde el panel de administración de Paperless-ngx bajo **Administración** > **Usuarios** > **Editar** > **Tokens de autenticación**.

### El OCR no funciona en los documentos subidos

Revisa tus paquetes de idioma en los ajustes de Paperless-ngx. Por defecto, solo está instalado el inglés. Agrega idiomas de OCR adicionales desde **Ajustes** > **OCR** en la interfaz web de Paperless-ngx.

### Las subidas fallan

Verifica que el directorio consume tenga los permisos correctos. El contenedor de Paperless-ngx necesita acceso de escritura al volumen consume.
