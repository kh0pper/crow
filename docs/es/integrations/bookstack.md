---
title: BookStack
---

# BookStack

Conecta Crow a BookStack para buscar, explorar, crear y editar páginas wiki organizadas en estantes, libros y capítulos a través de tu asistente de IA.

## Qué obtienes

- Búsqueda de texto completo en todo el contenido del wiki
- Explorar estantes, libros y capítulos
- Leer el contenido de las páginas (HTML y Markdown)
- Crear nuevas páginas en libros o capítulos
- Editar páginas existentes
- Gestionar la estructura del wiki

## Configuración

Crow soporta dos modos para BookStack: autoalojamiento vía Docker o conexión a una instancia existente.

### Opción A: Docker (autoalojado)

Instala BookStack como un bundle de Crow. Esto ejecuta BookStack en Docker junto a tu gateway de Crow.

> "Crow, instala el bundle de BookStack"

O instálalo desde el panel de **Extensiones** en el Crow's Nest.

Después de la instalación, configura la contraseña de la base de datos:

```bash
# En tu archivo .env
BOOKSTACK_DB_PASSWORD=tu-contrasena-segura
```

Reinicia el bundle para que los cambios surtan efecto:

> "Crow, reinicia el bundle de BookStack"

BookStack estará disponible en `http://tu-servidor:6875` para la configuración inicial. Las credenciales predeterminadas son `admin@admin.com` / `password`. Cámbialas inmediatamente después del primer inicio de sesión.

::: warning Mapeo de puertos
El puerto predeterminado de BookStack (80) se remapea al **6875** para evitar conflictos con otros servicios.
:::

::: warning Credenciales predeterminadas
Cambia el login predeterminado (`admin@admin.com` / `password`) inmediatamente después del primer inicio de sesión.
:::

### Opción B: Conectar a BookStack existente

Si ya tienes una instancia de BookStack funcionando, conecta Crow directamente a ella.

#### Paso 1: Crear un token de API

1. Abre la interfaz web de BookStack
2. Ve a **Ajustes** > **Tokens de API**
3. Crea un nuevo token
4. Copia el **Token ID** y el **Token Secret**

#### Paso 2: Agregar a Crow

Configura lo siguiente en tu archivo `.env` o vía **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
BOOKSTACK_URL=http://tu-servidor-bookstack:6875
BOOKSTACK_TOKEN_ID=tu-token-id
BOOKSTACK_TOKEN_SECRET=tu-token-secret
```

BookStack usa un formato de token compuesto (ID:SECRET) para la autenticación de la API. Crow los combina automáticamente.

## Herramientas de IA

Una vez conectado, puedes interactuar con BookStack a través de tu IA:

> "Busca la guía de despliegue en mi wiki"

> "Muéstrame todos los libros del estante DevOps"

> "Crea una nueva página en el libro Arquitectura"

> "Actualiza la página Primeros Pasos con este contenido"

> "¿Qué capítulos hay en ese libro?"

## Referencia de Docker Compose

Si prefieres una configuración manual de Docker en lugar del instalador de bundles:

```yaml
services:
  bookstack:
    image: lscr.io/linuxserver/bookstack:latest
    container_name: crow-bookstack
    ports:
      - "6875:80"
    volumes:
      - bookstack-config:/config
    environment:
      DB_HOST: bookstack-db
      DB_PORT: 3306
      DB_USER: bookstack
      DB_PASS: ${BOOKSTACK_DB_PASSWORD}
      DB_DATABASE: bookstack
    depends_on:
      - bookstack-db
    restart: unless-stopped

  bookstack-db:
    image: mariadb:11
    container_name: crow-bookstack-db
    volumes:
      - bookstack-dbdata:/var/lib/mysql
    environment:
      MYSQL_ROOT_PASSWORD: ${BOOKSTACK_DB_PASSWORD}
      MYSQL_DATABASE: bookstack
      MYSQL_USER: bookstack
      MYSQL_PASSWORD: ${BOOKSTACK_DB_PASSWORD}
    restart: unless-stopped

volumes:
  bookstack-config:
  bookstack-dbdata:
```

## Solución de problemas

### "Conexión rechazada" o tiempo de espera agotado

Asegúrate de que la `BOOKSTACK_URL` sea accesible desde la máquina que ejecuta Crow. Si BookStack está en otra máquina, usa la IP o el nombre de host correcto.

### "401 No autorizado"

Es posible que el token de API haya sido eliminado o haya expirado. Regenera un nuevo token desde **Ajustes** > **Tokens de API** en BookStack.

### Las páginas no se pueden editar

Verifica que el token de API tenga los permisos correctos. Los tokens de API de BookStack heredan los permisos del usuario que los creó. Asegúrate de que ese usuario tenga acceso de edición a los libros y páginas que quieres modificar.
