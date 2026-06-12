# Arquitectura del Cancionero

El cancionero (songbook) es la primera extensión de tipo de contenido del blog, y establece un patrón reutilizable para futuros tipos de contenido (recetas, visualización de datos, etc.).

## Principio de diseño

Las canciones son **entradas de blog etiquetadas con "songbook"** — no una entidad aparte. Esto significa que las canciones heredan las funciones del blog (CRUD, RSS, compartición, visibilidad, búsqueda FTS, exportación) sin duplicar infraestructura.

## Mapa de módulos

```
servers/blog/chordpro.js         — Parser de ChordPro + motor de transposición
servers/blog/chord-diagrams.js   — Generador de diagramas de acordes en SVG
servers/blog/songbook-renderer.js — Renderizado HTML de la página de canción
servers/gateway/routes/songbook.js — Rutas públicas
servers/gateway/dashboard/panels/songbook.js — Panel del Nest
skills/songbook.md               — Archivo de skill para la IA
```

## Flujo de contenido

```
El usuario pega acordes/letra
  → La IA los convierte a formato ChordPro
  → Se almacena como blog_posts.content (etiquetado "songbook")
  → Parser de ChordPro → AST
  → Motor de transposición (si hay tonalidad alternativa vía el parámetro ?key=)
  → Renderizador del cancionero → HTML (acordes sobre la letra + diagramas + audio)
  → Se sirve en /blog/songbook/:slug
```

## Motor ChordPro (`chordpro.js`)

### Estructura del AST

```js
{
  meta: { title, subtitle, key, tempo, time, capo },
  sections: [{
    type: "verse" | "chorus" | "bridge" | "tab" | "comment",
    label: "Verse 1",
    lines: [{
      type: "lyric",
      segments: [
        { chord: "Am", lyric: "Ramona, " },
        { chord: "C", lyric: "come " },
        { chord: null, lyric: "closer" }
      ]
    }]
  }]
}
```

### Transposición

- Escala cromática con forma canónica en sostenidos
- El mapeo enarmónico sigue el círculo de quintas (las tonalidades con bemoles usan bemoles, las de sostenidos usan sostenidos)
- Las notas de bajo de los acordes con barra (slash chords) se transponen de forma independiente
- `transposeAst(ast, targetKey)` devuelve un AST nuevo (no destructivo)

### Exports

| Función | Propósito |
|----------|---------|
| `parseChordPro(text)` | Texto → AST |
| `renderChordProHtml(ast)` | AST → HTML (acordes sobre la letra) |
| `transposeChord(name, semitones, preferFlats)` | Transpone un solo acorde |
| `transposeAst(ast, targetKey)` | Transpone el AST completo |
| `isChordPro(content)` | Detección (directivas o 2+ patrones de acordes) |
| `extractChords(ast)` | Obtiene los nombres de acordes únicos |
| `parseSongMeta(content)` | Extracción de metadatos con clave en negrita |
| `parseChord(name)` | Parsea en raíz/calidad/bajo |

## Diagramas de acordes (`chord-diagrams.js`)

**Primero algorítmico** con sobrescrituras curadas (~20 de guitarra, extensible):

1. Parsear el nombre del acorde → raíz + calidad
2. Buscar el conjunto de intervalos (mayor, m7, dim7, sus4, etc.)
3. Verificar las sobrescrituras curadas en busca de una coincidencia exacta
4. Recurrir a la generación algorítmica de digitaciones (voicings)
5. Renderizar como cadena SVG

Guitarra: ventana de 5 trastes, 6 cuerdas, puntos de dedos, marcadores de cuerda muda/al aire, notación de cejilla (barre).
Piano: teclado de 2 octavas, con las notas activas resaltadas.

## Base de datos

Dos tablas nuevas, sin cambios en `blog_posts`:

- **`songbook_setlists`** — name, description, visibility, timestamps
- **`songbook_setlist_items`** — FK setlist_id, FK post_id, position, key_override, notes (única sobre setlist_id + post_id)

Las canciones se identifican por la etiqueta "songbook" en `blog_posts.tags`.

## Convención de metadatos

Los metadatos de canciones usan el mismo patrón de **clave en negrita** que los podcasts:

```
**Key:** Am
**Tempo:** 120
**Artist:** Bob Dylan
```

`parseSongMeta()` sigue el mismo patrón de regex que `parsePodcastMeta()`. Cuando una entrada está etiquetada a la vez con "songbook" y "podcast", ambos parsers leen el mismo contenido sin conflicto.

## Rutas

Montadas en el gateway **antes** del catch-all `/:slug` del blog:

| Ruta | Descripción |
|-------|-------------|
| `GET /blog/songbook` | Página índice |
| `GET /blog/songbook/:slug` | Página de la canción |
| `GET /blog/songbook/:slug?key=G` | Vista transpuesta |
| `GET /blog/songbook/:slug?instrument=piano` | Diagramas de piano |
| `GET /blog/songbook/setlist/:id` | Vista de setlist |

## Herramientas MCP

10 herramientas agregadas al servidor del blog (`servers/blog/server.js`):

- `crow_create_song` — delega en la misma lógica de inserción de entradas
- `crow_transpose_song` — lectura no destructiva
- `crow_list_songs` — filtrada por la etiqueta "songbook"
- `crow_get_chord_diagram` — salida en SVG
- 6 herramientas CRUD de setlists que siguen los patrones existentes

## Patrón de extensión

Esto establece el patrón para futuros tipos de contenido del blog:

1. **El contenido se almacena en `blog_posts`** — usa etiquetas para identificar el tipo
2. **Parser específico del tipo** — transforma el contenido del formato almacenado a datos estructurados
3. **Renderizador específico del tipo** — genera HTML a partir de los datos estructurados
4. **Rutas dedicadas** — montadas antes del catch-all del blog
5. **Herramientas MCP** — agregadas al servidor del blog, delegan en la lógica compartida de entradas
6. **Panel del dashboard** — registrado junto al panel del blog
7. **Archivo de skill** — enruta la intención del usuario a las herramientas correctas
