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

Instala Calibre como un bundle de Crow. Esto ejecuta el servidor de contenido de Calibre en Docker junto a tu gateway de Crow.

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

Si tu servidor de Calibre tiene la autenticación habilitada, verifica que `CALIBRE_USERNAME` y `CALIBRE_PASSWORD` estén configurados correctamente en tu archivo `.env`.

### Los libros no aparecen

Verifica que `CALIBRE_LIBRARY_PATH` apunte al directorio que contiene tu archivo `metadata.db`. Esta es la raíz de tu biblioteca de Calibre, no una subcarpeta dentro de ella.
