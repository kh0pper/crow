---
title: Calibre-Web
---

# Calibre-Web

Conecta Crow a Calibre-Web para una experiencia rica de lectura de ebooks basada en web, con estantes, progreso de lectura y gestión de biblioteca.

## Qué obtienes

- Buscar y explorar tu biblioteca de ebooks
- Gestionar estantes y colecciones
- Hacer seguimiento del estado de lectura (leído, leyendo, por leer)
- Descargar libros en múltiples formatos
- Leer libros directamente en el navegador a través de la interfaz web

## Configuración

Crow soporta dos modos para Calibre-Web: autoalojamiento vía Docker o conexión a una instancia existente.

### Opción A: Docker (autoalojado)

Instala Calibre-Web como un bundle de Crow. Esto ejecuta Calibre-Web en Docker junto a tu gateway de Crow.

> "Crow, instala el bundle de Calibre-Web"

O instálalo desde el panel de **Extensiones** en el Crow's Nest.

Después de la instalación, configura la ruta al directorio que contiene tu `metadata.db`:

```bash
# En tu archivo .env
CALIBRE_WEB_DB_PATH=/ruta/a/biblioteca/calibre
```

Reinicia el bundle para que los cambios surtan efecto:

> "Crow, reinicia el bundle de Calibre-Web"

Calibre-Web estará disponible en `http://tu-servidor:8083`. Crea una cuenta de administrador inicial a través de la interfaz web en el primer arranque.

### Opción B: Conectar a Calibre-Web existente

Si ya tienes una instancia de Calibre-Web funcionando, conecta Crow directamente a ella.

#### Paso 1: Elige un usuario de Calibre-Web

La integración se autentica con **autenticación básica OPDS** — una cuenta de usuario normal de Calibre-Web (Calibre-Web estándar no tiene claves de API). Usa una cuenta existente o crea una dedicada en **Admin → Users**.

#### Paso 2: Agregar a Crow

Configura lo siguiente en tu archivo `.env` o vía **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
CALIBRE_WEB_URL=http://tu-calibre-web:8083
CALIBRE_WEB_USERNAME=tu-usuario
CALIBRE_WEB_PASSWORD=tu-contraseña
```

::: info Dos acciones se quedan en la interfaz web
Buscar, listar, ver detalles de libros, listar estantes y los enlaces de descarga funcionan por OPDS. Agregar un libro a un estante y cambiar el estado de lectura son rutas que en Calibre-Web estándar requieren sesión de navegador — la IA te indicará hacerlas en la interfaz web de Calibre-Web (solo funcionan de forma programática detrás de un proxy inverso con autenticación).
:::


## Herramientas de IA

Una vez conectado, puedes interactuar con Calibre-Web a través de tu IA:

> "Busca novelas de fantasía en mis libros"

> "Agrega este libro a mi estante de Lectura"

> "¿Qué estoy leyendo actualmente?"

> "Muéstrame mi lista de libros por leer"

> "Descarga ese libro como PDF"

## Solución de problemas

### "Conexión rechazada" o tiempo de espera agotado

Asegúrate de que la `CALIBRE_WEB_URL` sea accesible desde la máquina que ejecuta Crow. Si Calibre-Web está en otra máquina, usa la IP o el nombre de host correcto.

### Falló la autenticación

Verifica `CALIBRE_WEB_USERNAME` y `CALIBRE_WEB_PASSWORD` — son las mismas credenciales con las que inicias sesión en la interfaz web de Calibre-Web. Si la cuenta usa un proveedor de autenticación externo (LDAP/OAuth), asegúrate de que también tenga una contraseña local que OPDS pueda aceptar.

### "metadata.db not found"

Verifica que `CALIBRE_WEB_DB_PATH` apunte al directorio que contiene tu archivo `metadata.db` de Calibre. Calibre-Web requiere una base de datos de biblioteca de Calibre existente para funcionar.
