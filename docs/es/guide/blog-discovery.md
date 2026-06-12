---
title: Descubrimiento de blogs
---

# Descubrimiento de blogs

Los blogs de Crow pueden ser descubiertos por otras instancias de Crow a través de endpoints JSON ligeros. Esto habilita una red de blogs independientes y autoalojados que se pueden encontrar sin depender de una sola plataforma.

## Cómo funciona

Cada gateway de Crow expone dos endpoints JSON en el blog público:

| Endpoint | ¿Restringido? | Propósito |
|---|---|---|
| `/blog/discover.json` | No | Descubrimiento ligero para búsqueda manual peer-to-peer |
| `/blog/registry.json` | Sí (ajuste `blog_listed`) | Metadatos completos para una futura integración con registro |

Ambos endpoints son de solo lectura y cachean las respuestas durante una hora.

### `/blog/discover.json`

Siempre disponible en cualquier gateway de Crow con el servidor de blog en ejecución. Devuelve una carga mínima:

```json
{
  "crow_blog": true,
  "title": "My Blog",
  "rss_url": "https://example.com/blog/feed.xml",
  "atom_url": "https://example.com/blog/feed.atom",
  "post_count": 12
}
```

Casos de uso:

- Un peer comparte la URL de su gateway y quieres comprobar si tiene un blog
- Los lectores de feeds o agregadores pueden detectar blogs de Crow comprobando si `crow_blog: true`
- Scripts que construyen un blogroll personal a partir de una lista de URLs de Crow conocidas

### `/blog/registry.json`

Solo devuelve datos si el dueño del blog optó por participar estableciendo `blog_listed` en `"true"` en la configuración del Crow's Nest. De lo contrario devuelve 404.

```json
{
  "title": "My Blog",
  "tagline": "Thoughts on technology",
  "author": "Alice",
  "url": "https://example.com/blog",
  "post_count": 12,
  "last_published": "2026-03-10T14:30:00.000Z"
}
```

Este endpoint está diseñado para ser consultado por un futuro servicio de registro central.

## Optar por el descubrimiento

Para hacer disponibles los metadatos completos de tu blog:

1. Abre el Crow's Nest y ve a **Settings**
2. Establece `blog_listed` en `true`
3. El endpoint `/blog/registry.json` empezará a devolver datos

O pídele a tu IA:

> "Lista mi blog en el Crow Blog Registry"

La IA establecerá el ajuste `blog_listed` por ti.

Para salir más adelante, establece `blog_listed` en `false` (o elimina el ajuste). El endpoint `/blog/registry.json` devolverá 404 de inmediato.

### Qué se comparte

Cuando optas por participar, el endpoint devuelve únicamente:

- Título y lema del blog
- Nombre del autor
- URL del blog
- Cantidad de posts y fecha de la última publicación

No se comparte contenido de posts, direcciones de correo ni otros datos privados.

## Futuro: registro central de blogs

::: info PLANEADO
Un Crow Blog Registry central está en la [hoja de ruta](/roadmap) pero aún no se ha construido. Los endpoints de descubrimiento de arriba están disponibles ahora y funcionan independientemente de cualquier registro.
:::

El registro planeado agregaría metadatos de los blogs de Crow que opten por participar en un directorio navegable. Haría lo siguiente:

1. Consultar periódicamente el endpoint `/blog/registry.json` de cada blog conocido
2. Servir un directorio público de blogs de Crow activos
3. Permitir búsqueda por título, autor o etiqueta
4. Quitar automáticamente del listado los blogs que devuelvan 404 en consultas consecutivas

## Futuro: descubrimiento peer-to-peer

::: info PLANEADO
El descubrimiento de blogs basado en Hyperswarm es una mejora futura y no se ha implementado.
:::

Una mejora futura permitiría que los blogs se anuncien vía Hyperswarm, habilitando el descubrimiento sin ningún servidor central. Las instancias de Crow que escuchen en un topic bien conocido descubrirían nuevos blogs a través de la red P2P.

## Resumen de métodos de descubrimiento

| Método | Estado | ¿Requiere internet? | ¿Descentralizado? |
|---|---|---|---|
| URL directa (`/blog/discover.json`) | **Disponible ahora** | Sí | Sí |
| Registro central | Planeado | Sí | No |
| Hyperswarm P2P | Planeado | Tailscale o LAN | Sí |

El descubrimiento por URL directa funciona hoy. Un blog que en el futuro opte por el descubrimiento vía registro también seguirá siendo siempre descubrible por su URL directa.
