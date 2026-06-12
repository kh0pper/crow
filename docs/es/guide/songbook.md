# Cancionero

El Cancionero (Songbook) es un cancionero personal de acordes integrado en el blog de Crow. Guarda hojas de acordes en formato ChordPro, transpórtalas a cualquier tonalidad, ve diagramas de acordes para guitarra y piano, adjunta grabaciones, arma setlists y comparte con tus compañeros de banda.

## Inicio rápido

Dile a tu asistente de IA:

> "Agrega 'Alone Again Naturally' a mi cancionero en la tonalidad de D"

La IA hará lo siguiente:
1. Formatear la canción en notación ChordPro
2. Crear una entrada en el cancionero con la hoja de acordes
3. Podrás verla en `/blog/songbook/alone-again-naturally`

## Formato ChordPro

Las canciones se guardan en formato [ChordPro](https://www.chordpro.org/) — el estándar de la industria para hojas de acordes. Los acordes se colocan entre corchetes antes de la sílaba a la que acompañan:

```
{title: To Ramona}
{key: Am}

{start_of_verse: Verse 1}
[Am]Ra[C]mona, [G]come [Am]closer
[F]Shut [C]softly your [Am]watery eyes
{end_of_verse}
```

### Metadatos

Agrega metadatos a la canción usando encabezados de clave en negrita al inicio del contenido:

```
**Key:** Am
**Tempo:** 120
**Time:** 3/4
**Capo:** 2
**Artist:** Bob Dylan
**Album:** Another Side of Bob Dylan
**Audio:** storage:songs/ramona.mp3
```

### Directivas soportadas

| Directiva | Forma corta | Propósito |
|-----------|-----------|---------|
| `{title: text}` | `{t: text}` | Título de la canción |
| `{subtitle: text}` | `{st: text}` | Artista/subtítulo |
| `{key: Am}` | — | Tonalidad |
| `{tempo: 120}` | — | BPM |
| `{time: 3/4}` | — | Compás |
| `{capo: 2}` | — | Posición del capo |
| `{start_of_verse}` | `{sov}` | Inicia sección de verso |
| `{end_of_verse}` | `{eov}` | Termina sección de verso |
| `{start_of_chorus}` | `{soc}` | Inicia coro |
| `{end_of_chorus}` | `{eoc}` | Termina coro |
| `{start_of_bridge}` | `{sob}` | Inicia puente |
| `{end_of_bridge}` | `{eob}` | Termina puente |
| `{start_of_tab}` | `{sot}` | Inicia sección de tablatura |
| `{end_of_tab}` | `{eot}` | Termina sección de tablatura |
| `{comment: text}` | `{c: text}` | Nota de interpretación |

## Transposición

Cada página de canción incluye una barra de transposición con las 12 tonalidades. Haz clic en una tonalidad para transponer al instante:

```
/blog/songbook/alone-again-naturally?key=C
```

El motor de transposición sigue las convenciones de la teoría musical:
- Las tonalidades con bemoles (F, Bb, Eb, Ab, Db, Gb) usan nombres de notas con bemol
- Las tonalidades con sostenidos (G, D, A, E, B, F#) usan nombres de notas con sostenido
- Las notas del bajo en acordes con barra se transponen según la preferencia de la tonalidad de destino

## Diagramas de acordes

Las páginas de canciones muestran diagramas de digitación para cada acorde de la canción. Alterna entre guitarra y piano:

```
/blog/songbook/my-song?instrument=piano
```

Los diagramas se generan algorítmicamente, con ajustes curados para los acordes comunes. Los acordes no reconocidos muestran el nombre sin diagrama.

## Audio

Adjunta grabaciones a las canciones subiendo el audio al almacenamiento de Crow. La página de la canción muestra un reproductor de audio HTML5 con un botón de descarga.

Las canciones etiquetadas con `songbook` y `podcast` a la vez aparecen en tu feed RSS de podcast.

## Setlists

Organiza las canciones en setlists ordenados, con tonalidad personalizada por canción:

> "Crea un setlist llamado 'Friday Night' con Autumn Leaves en Gm y All The Things You Are en Ab"

Los setlists se pueden ver en `/blog/songbook/setlist/:id` con un diseño optimizado para impresión.

## Compartir

Las canciones usan el mismo modelo de visibilidad que las publicaciones del blog:

| Nivel | Cómo | Caso de uso |
|-------|-----|----------|
| Privado | Predeterminado | Cancionero personal |
| Peers | `crow_share_post` | Compartir con compañeros de banda |
| Público | Publicar | Cancionero público + RSS |

## Modo de teoría musical

Activa el asistente de teoría para sugerencias de acordes y análisis de progresiones:

> "Activa el modo de teoría musical"

La IA entonces ofrecerá:
- Sugerencias de sustitución de acordes
- Identificación de progresiones (ii-V-I, etc.)
- Recomendaciones de voicings
- Ideas de arreglos

## Herramientas MCP

| Herramienta | Descripción |
|------|-------------|
| `crow_create_song` | Crea una canción (valida ChordPro, etiqueta songbook automáticamente) |
| `crow_transpose_song` | Transposición no destructiva a cualquier tonalidad |
| `crow_list_songs` | Lista canciones con búsqueda y filtro por tonalidad |
| `crow_get_chord_diagram` | Diagrama de acorde en SVG para cualquier acorde |
| `crow_create_setlist` | Crea un setlist con IDs de canciones |
| `crow_add_to_setlist` | Agrega una canción con tonalidad personalizada |
| `crow_remove_from_setlist` | Quita una canción del setlist |
| `crow_update_setlist` | Actualiza o reordena un setlist |
| `crow_list_setlists` | Lista todos los setlists |
| `crow_get_setlist` | Obtiene un setlist con sus canciones |
| `crow_delete_setlist` | Elimina un setlist |

Las canciones se eliminan con la herramienta estándar `crow_delete_post`.

## Crow's Nest

El panel Songbook en el Crow's Nest ofrece una interfaz visual para gestionar canciones y setlists en `/dashboard/songbook`.
