---
title: Audiobookshelf
---

# Audiobookshelf

Conecta Crow a Audiobookshelf para buscar audiolibros y podcasts, hacer seguimiento del progreso de escucha y gestionar tu biblioteca de audio a través de tu asistente de IA.

## Qué obtienes

- Buscar audiolibros y podcasts
- Explorar bibliotecas con ordenamiento y paginación
- Hacer seguimiento del progreso de escucha entre dispositivos
- Explorar colecciones y series
- Obtener URLs de stream para la reproducción
- Ver detalles de los audiolibros (capítulos, duración, narrador)

## Configuración

Crow soporta dos modos para Audiobookshelf: autoalojamiento vía Docker o conexión a una instancia existente.

### Opción A: Docker (autoalojado)

Instala Audiobookshelf como un bundle de Crow. Esto ejecuta Audiobookshelf en Docker junto a tu gateway de Crow.

> "Crow, instala el bundle de Audiobookshelf"

O instálalo desde el panel de **Extensiones** en el Crow's Nest.

Después de la instalación, configura las rutas a tus directorios multimedia:

```bash
# En tu archivo .env
AUDIOBOOKSHELF_AUDIOBOOK_PATH=/ruta/a/tus/audiolibros
AUDIOBOOKSHELF_PODCAST_PATH=/ruta/a/tus/podcasts
```

Reinicia el bundle para que los cambios surtan efecto:

> "Crow, reinicia el bundle de Audiobookshelf"

Audiobookshelf estará disponible en `http://tu-servidor:13378`. Crea una cuenta de administrador a través de la interfaz web en el primer arranque, luego genera una clave de API desde **Ajustes** > **Usuarios** > tu usuario.

### Opción B: Conectar a Audiobookshelf existente

Si ya tienes una instancia de Audiobookshelf funcionando, conecta Crow directamente a ella.

#### Paso 1: Obtener tu clave de API

1. Abre la interfaz web de Audiobookshelf
2. Ve a **Ajustes** > **Usuarios**
3. Haz clic en tu usuario
4. Copia tu token de API

#### Paso 2: Agregar a Crow

Configura lo siguiente en tu archivo `.env` o vía **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
AUDIOBOOKSHELF_URL=http://tu-servidor-audiobookshelf:13378
AUDIOBOOKSHELF_API_KEY=tu-clave-api-aqui
```

## Herramientas de IA

Una vez conectado, puedes interactuar con Audiobookshelf a través de tu IA:

> "Busca Stephen King en mis audiolibros"

> "¿Qué estoy escuchando actualmente?"

> "Muéstrame mi biblioteca de podcasts"

> "¿Por dónde voy en ese audiolibro?"

> "Reproduce el siguiente capítulo"

## Solución de problemas

### "Conexión rechazada" o tiempo de espera agotado

Asegúrate de que la `AUDIOBOOKSHELF_URL` sea accesible desde la máquina que ejecuta Crow. Si Audiobookshelf está en otra máquina, usa la IP o el nombre de host correcto.

### "401 No autorizado"

Es posible que el token de API haya sido invalidado. Regenéralo desde **Ajustes** > **Usuarios** > tu usuario en Audiobookshelf.

### Los archivos multimedia no aparecen

Verifica que las rutas de los volúmenes (`AUDIOBOOKSHELF_AUDIOBOOK_PATH` y `AUDIOBOOKSHELF_PODCAST_PATH`) sean correctas y que los directorios contengan archivos multimedia correctamente organizados. Audiobookshelf espera los audiolibros en una estructura de carpetas `Autor/Titulo del Libro/`. Activa un escaneo de biblioteca desde la interfaz web si los archivos se agregaron recientemente.
