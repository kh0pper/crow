---
title: Wallabag
---

# Wallabag

Conecta Crow a Wallabag, un servicio autoalojado de "leer más tarde", para guardar artículos, leer sin conexión y organizar tu lista de lectura a través de tu asistente de IA.

## Qué obtienes

- Guardar cualquier URL para leerla más tarde
- Buscar artículos guardados por texto
- Explorar artículos con filtros (archivados, destacados, etiquetas)
- Leer el contenido completo de los artículos
- Organizar con etiquetas
- Marcar artículos como leídos o destacados

## Configuración

Crow soporta dos modos para Wallabag: autoalojamiento via Docker o conexión a una instancia existente.

### Opción A: Docker (autoalojado)

Instala Wallabag como un bundle de Crow. Esto ejecuta Wallabag en Docker junto a tu gateway de Crow.

> "Crow, instala el bundle de Wallabag"

O instálalo desde el panel de **Extensiones** en el Crow's Nest.

Después de la instalación, configura la contraseña de la base de datos:

```bash
# En tu archivo .env
WALLABAG_DB_PASSWORD=tu-contraseña-segura
```

Reinicia el bundle para que los cambios surtan efecto:

> "Crow, reinicia el bundle de Wallabag"

Wallabag estará disponible en `http://tu-servidor:8084` para la configuración inicial. Crea una cuenta desde la interfaz web y luego crea un cliente de API desde el menú **Developer**.

::: warning Mapeo de puertos
El puerto predeterminado de Wallabag (80) se remapea a **8084** para evitar conflictos con otros servicios.
:::

### Opción B: Conectar a Wallabag existente

Si ya tienes una instancia de Wallabag funcionando, conecta Crow directamente a ella. Wallabag usa autenticación OAuth2, así que necesitas cuatro credenciales.

#### Paso 1: Crear un cliente de API

1. Abre la interfaz web de Wallabag
2. Ve a **Developer** > **API clients management**
3. Crea un nuevo cliente
4. Copia el **Client ID** y el **Client Secret**

#### Paso 2: Agregar a Crow

Configura lo siguiente en tu archivo `.env` o via **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
WALLABAG_URL=http://tu-servidor-wallabag:8084
WALLABAG_CLIENT_ID=tu-client-id
WALLABAG_CLIENT_SECRET=tu-client-secret
WALLABAG_USERNAME=tu-usuario
WALLABAG_PASSWORD=tu-contraseña
```

Las cinco variables son obligatorias. Crow usa el Client ID y el Secret junto con tu nombre de usuario y contraseña para autenticarse via OAuth2.

## Herramientas de IA

Una vez conectado, puedes interactuar con Wallabag a través de tu IA:

> "Guarda este artículo: https://example.com/great-article"

> "Muéstrame mis artículos sin leer"

> "Destaca ese artículo"

> "Busca machine learning en mis artículos guardados"

> "Archiva todos los artículos leídos"

## Referencia de Docker Compose

Si prefieres una configuración manual de Docker en lugar del instalador de bundles:

```yaml
services:
  wallabag:
    image: wallabag/wallabag:latest
    container_name: crow-wallabag
    ports:
      - "8084:80"
    volumes:
      - wallabag-data:/var/www/wallabag/data
      - wallabag-images:/var/www/wallabag/web/assets/images
    environment:
      SYMFONY__ENV__DATABASE_DRIVER: pdo_mysql
      SYMFONY__ENV__DATABASE_HOST: wallabag-db
      SYMFONY__ENV__DATABASE_PORT: 3306
      SYMFONY__ENV__DATABASE_NAME: wallabag
      SYMFONY__ENV__DATABASE_USER: wallabag
      SYMFONY__ENV__DATABASE_PASSWORD: ${WALLABAG_DB_PASSWORD}
    depends_on:
      - wallabag-db
      - wallabag-redis
    restart: unless-stopped

  wallabag-db:
    image: mariadb:11
    container_name: crow-wallabag-db
    volumes:
      - wallabag-dbdata:/var/lib/mysql
    environment:
      MYSQL_ROOT_PASSWORD: ${WALLABAG_DB_PASSWORD}
      MYSQL_DATABASE: wallabag
      MYSQL_USER: wallabag
      MYSQL_PASSWORD: ${WALLABAG_DB_PASSWORD}
    restart: unless-stopped

  wallabag-redis:
    image: redis:7-alpine
    container_name: crow-wallabag-redis
    restart: unless-stopped

volumes:
  wallabag-data:
  wallabag-images:
  wallabag-dbdata:
```

## Solución de problemas

### Falló el inicio de sesión OAuth2

Verifica que las cuatro credenciales (Client ID, Client Secret, nombre de usuario, contraseña) sean correctas. Si cambiaste tu contraseña de Wallabag, actualiza también `WALLABAG_PASSWORD` en tu archivo `.env`.

### "Conexión rechazada" o tiempo de espera agotado

Asegúrate de que la `WALLABAG_URL` sea accesible desde la máquina que ejecuta Crow. Si Wallabag está en otra máquina, usa la IP o el nombre de host correcto.

### Los artículos no se guardan

Verifica que la URL de destino sea accesible desde el servidor que ejecuta Wallabag. Wallabag obtiene y analiza el contenido de la página del lado del servidor, así que necesita acceso de red a la URL del artículo.
