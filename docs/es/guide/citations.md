---
title: Citas y verificación de fuentes
---

# Citas y verificación de fuentes

Crow genera citas correctamente formateadas de forma automática y registra cómo se encontró cada fuente — para que tu investigación sea siempre verificable.

## Citas en múltiples formatos

Cuando agregas una fuente, Crow genera citas en cuatro formatos a partir de los metadatos que proporcionas:

| Formato | Estilo | Ideal para |
|--------|-------|----------|
| **APA** | Author (Year). Title. Publisher. URL | Artículos académicos, psicología, ciencias sociales |
| **MLA** | Author. "Title." *Publisher*, Date. URL. | Humanidades, literatura, artes |
| **Chicago** | Author. "Title." Publisher. Date. URL. | Historia, publicaciones, muchos campos académicos |
| **Web** | Title. URL. Accessed DATE. [Found via METHOD] | Entradas de blog, referencias rápidas, investigación asistida por IA |

### Cómo funciona

Los cuatro formatos se generan al momento de la consulta a partir de los campos almacenados de la fuente (autores, título, fecha, URL, etc.) — no se necesita capturar datos adicionales.

- **Agregar una fuente**: De forma predeterminada, el formato APA se almacena como la cita principal. Usa el parámetro `citation_format` para cambiarlo.
- **Ver una fuente**: `crow_get_source` muestra los cuatro formatos de cita.
- **Generar una bibliografía**: `crow_generate_bibliography` acepta un parámetro `format`: `apa`, `mla`, `chicago`, `web` o `all`.

### Ejemplo

> "Crow, genera una bibliografía en estilo Chicago para mi proyecto de investigación sobre la Guerra Civil"

Crow obtiene todas las fuentes del proyecto y genera citas en formato Chicago, ordenadas alfabéticamente.

> "Crow, muéstrame la fuente #42 con todos los formatos de cita"

Crow muestra los detalles completos de la fuente, incluyendo las citas en APA, MLA, Chicago y web.

## Verificación de fuentes

Crow registra **cómo** se encontró cada fuente, para que puedas distinguir entre las fuentes que encontraste tú mismo y las descubiertas por búsqueda con IA.

### Métodos de obtención

Al agregar una fuente, el campo `retrieval_method` registra cómo se obtuvo:

- `"direct URL"` — el usuario proporcionó el enlace
- `"AI search via Claude"` — encontrada durante una búsqueda asistida por IA
- `"library database"` — encontrada en una base de datos académica
- `"user-provided"` — el usuario suministró la fuente directamente

### Flujo de verificación

1. **Agrega la fuente** con metadatos precisos y el método de obtención
2. **Verifica que la URL** sea real y accesible (especialmente para fuentes descubiertas por IA)
3. **Contrasta** las afirmaciones con otras fuentes
4. **Márcala como verificada** usando `crow_verify_source` con notas sobre lo que se comprobó

### El principio de "sin afirmaciones no verificadas"

Al investigar a través de Crow, cada afirmación factual debe enlazar a una fuente almacenada y citada. Esto significa:

- Los resúmenes de IA no son fuentes — rastrea hasta el original
- Si una URL no se puede verificar, anótalo en el estado de verificación
- Las fuentes primarias son preferibles a los resúmenes secundarios

## Personalización

Puedes establecer un formato de cita predeterminado en tu crow.md:

> "Crow, usa siempre el formato MLA para mis citas"

Esto actualiza tu protocolo de investigación para generar MLA como formato principal al agregar fuentes.
