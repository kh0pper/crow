---
title: Podcast
---

# Podcast

Crea y publica un podcast desde tu instancia de Crow. Los episodios se gestionan a través del Crow's Nest o hablando con tu IA, y se sirven como un feed RSS compatible con iTunes que funciona con Apple Podcasts, Spotify y otros directorios.

## Cómo funciona

Los episodios del podcast son publicaciones de blog etiquetadas con `podcast`. Cada episodio tiene metadatos de audio incrustados en el contenido de la publicación, y Crow genera un feed RSS de podcast conforme a los estándares en `/blog/podcast.xml`.

No necesitas entender nada de esto para usarlo — solo pídele a tu IA que cree episodios, o usa el panel de Podcast en el Crow's Nest.

## Primeros pasos

### 1. Instala el complemento de podcast

Desde el Crow's Nest, ve a **Extensiones** e instala el complemento **Podcast**. Esto agrega un panel de **Podcast** a tu barra lateral.

O pídele a tu IA:

> "Instala el complemento de podcast"

### 2. Configura los ajustes de tu podcast

Define el nombre, la categoría y la información de contacto de tu podcast. Apple Podcasts y Spotify los requieren para el envío a sus directorios.

> "Configura los ajustes de mi podcast: la categoría es Tecnología, el correo del propietario es me@example.com"

O usa la herramienta `crow_blog_settings` directamente:

| Ajuste | Qué hace | Ejemplo |
|---------|-------------|---------|
| `podcast_category` | Categoría de iTunes (admite subcategorías con ` > `) | `Technology > Software How-To` |
| `podcast_type` | Formato del programa | `episodic` (lo más nuevo primero) o `serial` (lo más antiguo primero) |
| `podcast_owner_email` | Correo de contacto (requerido por Apple) | `me@example.com` |
| `podcast_cover_url` | Arte del programa (1400x1400 a 3000x3000, JPEG o PNG) | `https://example.com/cover.jpg` |
| `podcast_language` | Código de idioma | `en`, `es`, `fr`, etc. |

Estos ajustes aplican a todo el podcast. Los ajustes por episodio (arte, duración, etc.) se definen al crear cada episodio.

### 3. Crea tu primer episodio

Desde el panel de **Podcast** en el Crow's Nest, baja hasta **Nuevo episodio** y completa el formulario. O pídele a tu IA:

> "Crea un episodio de podcast titulado 'Bienvenidos a mi programa' con el audio en https://example.com/ep1.mp3, duración 15:30, episodio 1"

## Subir archivos de audio

Hay dos formas de adjuntar audio a un episodio:

### Opción A: Subir directamente (recomendado)

Si tienes [almacenamiento MinIO](/es/guide/storage) configurado, el panel de Podcast muestra una **zona de carga de arrastrar y soltar** para archivos de audio. Puedes:

- **Arrastrar y soltar** un archivo de audio (MP3, M4A, OGG o WAV) sobre la zona de carga
- **Hacer clic en la zona de carga** para abrir un explorador de archivos
- Después de subirlo, verás el nombre del archivo y su tamaño con una marca de verificación verde

El archivo subido se almacena en tu almacenamiento MinIO y la URL se rellena automáticamente. No necesitas copiar ni pegar nada.

::: tip
Si prefieres alojar el audio en otro lugar (p. ej., en un CDN), aún puedes escribir una URL en el campo de URL manual debajo de la zona de carga. La URL manual tiene prioridad sobre cualquier archivo subido.
:::

### Opción B: Ingresar una URL manualmente

Si el almacenamiento no está configurado, el formulario muestra un campo de texto simple donde ingresas la URL de tu archivo de audio alojado en otro lugar.

## Arte del episodio

Cada episodio puede tener su propia imagen de portada, separada del arte principal del podcast. Esto es lo que aparece en las apps de podcast cuando alguien explora tus episodios.

Cuando el almacenamiento está disponible, el formulario del episodio muestra un botón de **Subir imagen** junto a una pequeña miniatura de vista previa. Haz clic en él para subir una imagen JPEG o PNG. La vista previa se actualiza para mostrar tu arte de inmediato.

La URL del arte se incrusta en la entrada RSS del episodio como una etiqueta `itunes:image`, de modo que las apps de podcast la muestran junto al título del episodio.

::: info
El arte del episodio es opcional. Si no defines uno, las apps de podcast recurrirán a la imagen de portada principal de tu podcast (definida en los ajustes del podcast).
:::

## Metadatos del episodio

Cuando creas un episodio — ya sea a través del panel o hablando con tu IA — los siguientes metadatos se almacenan en el contenido de la publicación:

| Campo | Formato | Ejemplo | ¿Requerido? |
|-------|--------|---------|-----------|
| **Audio** | URL al archivo de audio | `https://example.com/ep1.mp3` | Sí |
| **Duración** | `MM:SS` o `HH:MM:SS` | `45:32` | Recomendado |
| **Episodio** | Número de episodio | `12` | Opcional |
| **Temporada** | Número de temporada | `2` | Opcional |
| **Arte** | URL a la imagen del episodio | `https://example.com/ep1-cover.jpg` | Opcional |

Todo lo que viene después del bloque de metadatos se convierte en las **notas del programa**, que aparecen en las apps de podcast como la descripción del episodio.

## Publicar y gestionar episodios

### Publicar un episodio

Desde el panel de Podcast, haz clic en **Publicar** en cualquier episodio en borrador. O:

> "Publica mi episodio de podcast más reciente"

### Despublicar o eliminar

Haz clic en **Despublicar** para regresar un episodio al estado de borrador (permanece en el sistema pero desaparece del feed). Haz clic en **Eliminar** para quitarlo permanentemente.

### Vista previa de audio

Cada episodio de la lista tiene un reproductor de audio integrado para que puedas previsualizar el audio directamente desde el panel de Podcast sin salir de la página.

## Feed RSS

Tu feed de podcast se genera automáticamente en:

```
https://your-server/blog/podcast.xml
```

La URL del feed se muestra de forma prominente en la parte superior del panel de Podcast con un botón **Copiar** para compartirla fácilmente.

### Qué contiene el feed

El feed incluye el [espacio de nombres de podcast de iTunes](https://podcasters.apple.com/support/823-podcast-requirements) completo, lo que significa que funciona con:

- **Apple Podcasts** — Envía la URL de tu feed en [podcastsconnect.apple.com](https://podcastsconnect.apple.com)
- **Spotify** — Envíala en [podcasters.spotify.com](https://podcasters.spotify.com)
- **Google Podcasts**, **Pocket Casts**, **Overcast** y cualquier otra app que acepte RSS

El feed incluye:

| Etiqueta | Fuente |
|-----|--------|
| `itunes:author` | Ajuste de autor del blog |
| `itunes:owner` (nombre + correo) | Ajuste de correo del propietario del podcast |
| `itunes:category` | Ajuste de categoría del podcast (admite subcategorías) |
| `itunes:type` | `episodic` o `serial` |
| `itunes:image` | URL de portada del podcast (a nivel de canal) y arte por episodio |
| `itunes:duration` | Duración del episodio |
| `itunes:episode` / `itunes:season` | Números de episodio y temporada |
| `content:encoded` | Notas del programa completas como HTML |
| `enclosure` | URL del archivo de audio, tipo MIME y tamaño del archivo |

### Tamaño de archivo en los enclosures

El feed RSS detecta automáticamente el tamaño de archivo de cada URL de audio enviando una verificación rápida al servidor que aloja el archivo. Esto rellena el atributo `length` de la etiqueta `<enclosure>`, que algunas apps de podcast usan para mostrar el tamaño de descarga. Si el tamaño no se puede determinar (p. ej., el host no lo reporta), el valor predeterminado es 0 — esto es inofensivo y no impedirá la reproducción.

## Hacer público tu podcast

El feed de tu podcast necesita ser accesible desde la internet pública para el envío a los directorios. Las mismas opciones que aplican para [hacer público tu blog](/es/guide/blog) funcionan para el feed del podcast:

- **Tailscale Funnel** — Expone tu gateway públicamente. URL del feed: `https://your-hostname.your-tailnet.ts.net/blog/podcast.xml`
- **Proxy inverso con Caddy** — Dominio personalizado con TLS automático. Asegúrate de que tu Caddyfile incluya las rutas `/blog*`.
- **Despliegue en la nube** — El feed es público automáticamente.

Configura `CROW_GATEWAY_URL` en tu `.env` para que las URLs del feed apunten al lugar correcto:

```bash
CROW_GATEWAY_URL=https://yourdomain.com
```

## Requisitos de almacenamiento

| Qué | Dónde | Notas |
|------|-------|-------|
| Metadatos de episodios | Base de datos de Crow | Insignificante — solo texto |
| Archivos de audio (si se suben) | Almacenamiento MinIO | Depende de la duración y el formato del episodio. Un MP3 de 60 minutos a 128kbps son ~57 MB |
| Arte de episodios (si se sube) | Almacenamiento MinIO | Típicamente 100 KB – 2 MB por imagen |

Si alojas el audio externamente (CDN, S3, etc.), no se usa almacenamiento local para los archivos de audio.
