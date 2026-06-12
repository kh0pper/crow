---
title: Navidrome
---

# Navidrome

Conecta Crow a Navidrome para explorar tu biblioteca musical, buscar artistas y álbumes, gestionar listas de reproducción y transmitir música a través de tu asistente de IA.

## Qué obtienes

- Buscar canciones, álbumes y artistas
- Explorar álbumes con ordenamiento (más nuevos, alfabético, recientes)
- Ver detalles de álbumes con el listado de pistas
- Crear y gestionar listas de reproducción
- Obtener URLs de stream para reproducción
- Ver qué se está reproduciendo actualmente

## Configuración

Crow soporta dos modos para Navidrome: autoalojamiento vía Docker o conexión a una instancia existente.

### Opción A: Docker (autoalojado)

Instala Navidrome como un bundle de Crow. Esto ejecuta Navidrome en Docker junto a tu gateway de Crow.

> "Crow, instala el bundle de Navidrome"

O instálalo desde el panel de **Extensiones** en el Crow's Nest.

Después de la instalación, configura la ruta a tu directorio de música:

```bash
# En tu archivo .env
NAVIDROME_MUSIC_PATH=/ruta/a/tu/musica
```

Reinicia el bundle para que los cambios surtan efecto:

> "Crow, reinicia el bundle de Navidrome"

Navidrome estará disponible en `http://tu-servidor:4533`. Crea una cuenta de administrador a través de la interfaz web en el primer arranque.

### Opción B: Conectar a Navidrome existente

Si ya tienes una instancia de Navidrome funcionando, conecta Crow directamente a ella. Navidrome usa la API de Subsonic para el acceso programático.

#### Paso 1: Ten a la mano tus credenciales

Crow se autentica con Navidrome usando tu nombre de usuario y contraseña vía la API de Subsonic.

#### Paso 2: Agregar a Crow

Configura lo siguiente en tu archivo `.env` o vía **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
NAVIDROME_URL=http://tu-servidor-navidrome:4533
NAVIDROME_USERNAME=tu-nombre-de-usuario
NAVIDROME_PASSWORD=tu-contrasena
```

## Herramientas de IA

Una vez conectado, puedes interactuar con Navidrome a través de tu IA:

> "Busca álbumes de jazz en mi música"

> "Muéstrame los álbumes agregados recientemente"

> "Crea una lista de reproducción llamada Road Trip"

> "Reproduce esa canción"

> "¿Qué álbumes tengo de Miles Davis?"

## Compatibilidad con la API de Subsonic

Navidrome implementa la API de Subsonic, lo que significa que funciona con cualquier cliente compatible con Subsonic (DSub, Symfonium, play:Sub, Ultrasonic, entre otros) junto a Crow. Puedes usar estas apps para reproducción móvil mientras gestionas tu biblioteca a través de tu IA.

## Solución de problemas

### "Conexión rechazada" o tiempo de espera agotado

Asegúrate de que la `NAVIDROME_URL` sea accesible desde la máquina que ejecuta Crow. Si Navidrome está en otra máquina, usa la IP o el nombre de host correcto.

### Falló la autenticación

Verifica que `NAVIDROME_USERNAME` y `NAVIDROME_PASSWORD` sean correctos. Intenta iniciar sesión en la interfaz web de Navidrome con las mismas credenciales para confirmar que funcionan.

### La música no aparece

Navidrome necesita escanear tu biblioteca musical después de que configures `NAVIDROME_MUSIC_PATH`. Abre la interfaz web de Navidrome y activa un escaneo de biblioteca desde los ajustes de administrador. Navidrome soporta MP3, FLAC, OGG, AAC y otros formatos comunes.
