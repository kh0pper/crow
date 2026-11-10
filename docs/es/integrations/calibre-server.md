---
title: Calibre Server
---

# Calibre Server

Conecta Crow al servidor de contenido de Calibre para buscar, explorar y descargar ebooks de tu biblioteca a través de tu asistente de IA.

## Qué obtienes

- Buscar libros por título, autor o etiqueta
- Explorar por categoría (autor, etiqueta, serie, editorial)
- Obtener detalles y metadatos de los libros
- Descargar libros en cualquier formato disponible
- Explorar tu biblioteca completa de Calibre vía OPDS

## Configuración

Crow soporta dos modos para Calibre: autoalojamiento vía Docker o conexión a una instancia existente.

### Opción A: Docker (autoalojado)

Instala Calibre como un bundle de Crow. Esto ejecuta el **servidor de contenido** de Calibre en Docker junto a tu gateway de Crow — no la aplicación de escritorio de Calibre a través del navegador, que era lo que este bundle ofrecía antes.

> "Crow, instala el bundle de Calibre Server"

O instálalo desde el panel de **Extensiones** en el Crow's Nest.

Después de la instalación, configura la ruta al directorio de tu biblioteca de Calibre:

```bash
# En tu archivo .env
CALIBRE_LIBRARY_PATH=/ruta/a/tu/biblioteca/calibre
```

Reinicia el bundle para que los cambios surtan efecto:

> "Crow, reinicia el bundle de Calibre Server"

El servidor de contenido de Calibre estará disponible en `http://tu-servidor:8081`.

#### El inicio de sesión

El servidor de contenido necesita un inicio de sesión: cada página que muestra tus libros y cada descarga lo piden. Crow crea la cuenta `admin` por sí mismo justo después de la instalación, genera su contraseña y la guarda en **Ajustes → Contraseñas**. El mismo `CALIBRE_USERNAME` y `CALIBRE_PASSWORD` van al `.env` del bundle y a la configuración MCP de la extensión, que es lo que leen las herramientas de Crow. Cambia la contraseña en la interfaz web de Calibre (**Settings → Passwords**) si quieres otra.

El servidor de contenido guarda sus usuarios en su propia base de datos de usuarios (`/config/users.sqlite`). Las cuentas creadas en la antigua versión de escritorio no se conservan: vivían en el archivo de usuarios de la aplicación de escritorio, bajo `/config/.config/calibre/`, y el servidor de contenido nunca lo lee. Crow crea `admin`; añade más cuentas con las propias herramientas de Calibre (`calibre-server --manage-users`) si las necesitas.

Una carpeta de biblioteca sin `metadata.db` se rellena con una biblioteca de Calibre vacía en el primer arranque, para que el servidor tenga dónde funcionar.

### Actualizar desde la versión de escritorio

La aplicación de escritorio en el navegador ya no está: este bundle ejecuta solo el servidor de contenido, así que la antigua interfaz web y sus puertos no vuelven. Tus libros se quedan donde están: la biblioteca sigue siendo la carpeta que montaste.

Después de pulsar **Apply the update**, el servidor de contenido pide un inicio de sesión que todavía no existe. Pulsa **Set it up for me** en la tarjeta de Extensiones para que Crow cree el inicio de sesión `admin` y lo guarde en **Ajustes → Contraseñas**.

### Opción B: Conectar a Calibre existente

Si ya tienes un servidor de contenido de Calibre funcionando, conecta Crow directamente a él.

#### Paso 1: Anotar la URL de tu servidor

Encuentra la URL donde está funcionando tu servidor de contenido de Calibre (normalmente `http://hostname:8080` o `http://hostname:8081`).

#### Paso 2: Agregar a Crow

Configura lo siguiente en tu archivo `.env` o vía **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
CALIBRE_URL=http://tu-servidor-calibre:8081

# Solo se necesita si la autenticación está habilitada
CALIBRE_USERNAME=tu-nombre-de-usuario
CALIBRE_PASSWORD=tu-contrasena
```

## Herramientas de IA

Una vez conectado, puedes interactuar con Calibre a través de tu IA:

> "Busca ciencia ficción en mis ebooks"

> "Muéstrame libros de Isaac Asimov"

> "Descarga ese libro como EPUB"

> "¿Qué categorías hay en mi biblioteca de Calibre?"

## Solución de problemas

### "Conexión rechazada" o tiempo de espera agotado

Asegúrate de que la `CALIBRE_URL` sea accesible desde la máquina que ejecuta Crow. Si Calibre está en otra máquina, usa la IP o el nombre de host correcto.

### "401 No autorizado"

Crow inicia sesión en el servidor de contenido con `CALIBRE_USERNAME` y `CALIBRE_PASSWORD` del `.env` del bundle. La contraseña que Crow generó está en **Ajustes → Contraseñas**; cópiala ahí, o cambia la contraseña de Calibre en su propia interfaz web (**Settings → Passwords**).

### Los libros no aparecen

Verifica que `CALIBRE_LIBRARY_PATH` apunte al directorio que contiene tu archivo `metadata.db`. Esta es la raíz de tu biblioteca de Calibre, no una subcarpeta dentro de ella.
