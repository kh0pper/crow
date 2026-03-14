---
title: Blog
---

# Blog

Publica un blog personal gestionado completamente por tu asistente de IA. Escribe en Markdown, personaliza temas y comparte entradas con otros usuarios — todo desde una conversación.

## ¿Qué es esto?

Crow incluye una plataforma de blog integrada. Escribes entradas hablando con tu IA, y Crow se encarga del renderizado, la publicación, los feeds RSS y los temas. Las entradas se sirven como páginas HTML públicas desde tu gateway.

## ¿Por qué querría esto?

- **Escribe hablando** — Describe lo que quieres escribir, y Crow lo redacta y publica
- **Sé dueño de tu contenido** — Las entradas viven en tu propio servidor, no en una plataforma de terceros
- **RSS integrado** — Los lectores pueden suscribirse vía RSS o Atom sin configuración adicional
- **Comparte con otros usuarios** — Envía entradas directamente a usuarios de Crow conectados mediante P2P
- **Exporta cuando quieras** — Mueve tu contenido a Hugo, Jekyll o cualquier generador de sitios estáticos

## Configuración y acceso público

### Iniciar el servidor de blog

Las herramientas de blog están disponibles mediante dos opciones de transporte:

- **Stdio (MCP)** — Ejecuta `npm run blog-server` para iniciar el servidor MCP de blog directamente. Esto es lo que usa `.mcp.json` cuando Claude Code u otro cliente MCP se conecta.
- **Gateway (HTTP)** — Ejecuta `npm run gateway` para iniciar el gateway HTTP, que aloja todos los servidores MCP incluyendo el blog. El gateway también sirve las páginas públicas del blog.

Las herramientas MCP del blog (crear, editar, publicar, etc.) funcionan en ambos modos. El acceso web público a tu blog requiere el gateway.

### Rutas públicas del blog

Cuando el gateway está en ejecución, el blog se sirve en estas rutas públicas:

| Ruta | Descripción |
|---|---|
| `/blog` | Página principal del blog con todas las entradas públicas publicadas |
| `/blog/:slug` | Página de una entrada individual (ej., `/blog/notes-on-local-first-software`) |
| `/blog/tag/:tag` | Entradas filtradas por etiqueta |
| `/blog/feed.xml` | Feed RSS 2.0 |
| `/blog/feed.atom` | Feed Atom 1.0 |
| `/blog/sitemap.xml` | Sitemap XML para indexación en motores de búsqueda |

Los headers `<link>` de autodescubrimiento RSS se incluyen automáticamente en todas las páginas del blog, para que los lectores de feeds puedan encontrar tus feeds desde cualquier URL del blog.

### Configuración del gateway

Establece `CROW_GATEWAY_URL` en tu archivo `.env` con tu URL pública:

```bash
CROW_GATEWAY_URL=https://blog.example.com
```

Esto controla cómo se generan las URLs en los feeds RSS/Atom, las etiquetas Open Graph y el sitemap. Sin esto, todas las URLs apuntan a `http://localhost:3001`, lo cual no funcionará para visitantes externos ni para vistas previas en redes sociales.

### Hacer el blog accesible públicamente

El gateway escucha en `localhost:3001` por defecto. Para que tu blog sea accesible desde internet:

- **Tailscale Funnel** — La opción más fácil para usuarios de Tailscale. No requiere reenvío de puertos ni registro de dominio. Consulta los [detalles abajo](#tailscale-funnel-recomendado-para-autoalojamiento).
- **Reverse proxy con Caddy o nginx** — Usa un reverse proxy con certificados Let's Encrypt automáticos para un dominio personalizado. Consulta el [ejemplo con Caddy abajo](#dominio-personalizado-con-caddy).
- **Reenvío de puertos directo** — Reenvía el puerto 3001 en tu router. No recomendado: expone todo el gateway (Crow's Nest, endpoints MCP) sin TLS.

Para una comparación completa de despliegue, consulta la sección [Hacer tu blog público](#hacer-tu-blog-público) más adelante.

## Escribir una entrada

Pídele a Crow que cree una entrada:

> "Escribe una entrada de blog sobre mi proyecto de jardín este fin de semana"

> "Crea un borrador titulado 'Notas sobre software local-first'"

Crow crea la entrada en Markdown, genera un slug amigable para URLs y la guarda como borrador.

### Campos de una entrada

Cada entrada tiene:

- **Título** — Se muestra como encabezado de la página y en los feeds
- **Slug** — La ruta en la URL (ej., `/blog/notes-on-local-first-software`)
- **Contenido** — Cuerpo en Markdown, renderizado a HTML al publicar
- **Etiquetas** — Categorías opcionales para organización
- **Estado** — `draft` (borrador) o `published` (publicado)
- **Visibilidad** — Controla quién puede ver la entrada:
  - `private` — Solo tú (predeterminado)
  - `public` — Cualquiera con la URL
  - `peers` — Solo usuarios de Crow conectados

## Publicar

Cuando estés satisfecho con un borrador:

> "Publica mi entrada sobre software local-first"

La entrada se vuelve accesible públicamente en `http://tu-servidor:3001/blog/notes-on-local-first-software`.

Para despublicar:

> "Despublica la entrada del proyecto de jardín"

## Editar entradas

> "Actualiza mi entrada del jardín — agrega una sección sobre las camas elevadas"

> "Cambia el título de mi última entrada a 'Notas del jardín del fin de semana'"

Crow modifica la entrada en el lugar. Las entradas publicadas se actualizan de inmediato.

## Listar y buscar

> "Muéstrame todas mis entradas de blog"

> "Busca entradas con la etiqueta 'investigación'"

> "Busca en mi blog 'redes neuronales'"

Las entradas de blog están indexadas con búsqueda de texto completo FTS5, así que las búsquedas por palabras clave son rápidas incluso con cientos de entradas.

## Temas

El blog usa el tema **Dark Editorial** por defecto — un diseño limpio y enfocado en la lectura, con soporte para modo oscuro y claro. La paleta de colores del blog sigue la identidad de marca de Crow: acentos índigo, fondos azul-negro profundo en modo oscuro y tonos piedra cálidos en modo claro. Esto asegura consistencia visual entre tu blog y el Crow's Nest.

El tema controla:

- Tipografía y disposición
- Resaltado de sintaxis en bloques de código
- Estilo del encabezado y pie de página
- Etiquetas Open Graph para vistas previas al compartir en redes sociales

## Feeds RSS y Atom

Los feeds se generan automáticamente:

- **RSS 2.0**: `http://tu-servidor:3001/blog/feed.xml`
- **Atom**: `http://tu-servidor:3001/blog/feed.atom`

Los feeds incluyen las 20 entradas publicadas más recientes con contenido completo.

## Exportar

Mueve tu contenido a un generador de sitios estáticos:

> "Exporta mis entradas de blog para Hugo"

> "Exporta todas las entradas como Markdown compatible con Jekyll"

Crow genera archivos Markdown con el frontmatter apropiado para tu plataforma de destino.

## Compartir entradas con otros usuarios

Si tienes contactos conectados (consulta la [guía de Compartir](/es/guide/sharing)), puedes enviar entradas directamente:

> "Comparte mi última entrada de blog con Alice"

El destinatario recibe el contenido completo de la entrada en su bandeja de entrada de Crow.

## Configuración del blog

Establece los metadatos del blog en tu `.env`:

```bash
CROW_BLOG_TITLE=My Blog
CROW_BLOG_DESCRIPTION=Thoughts on technology and gardening
CROW_BLOG_AUTHOR=Your Name
```

Estos valores aparecen en el feed RSS y en los encabezados de las páginas.

## Hacer tu blog público

Tu blog no tiene presencia web sin el gateway en ejecución. Cómo se vuelve accesible tu blog depende de tu tipo de despliegue:

| Despliegue | ¿Blog accesible? | Cómo |
|---|---|---|
| **Escritorio (stdio)** | No | El gateway no está en ejecución — no hay blog web |
| **Autoalojado (Pi/servidor)** | Solo en LAN por defecto | Disponible en `http://<ip-del-servidor>:3001/blog` en tu red local |
| **Nube (Render/Oracle)** | Sí — internet público | Blog en `https://tu-servidor-crow/blog` |
| **Hosting gestionado** | Sí — internet público | Blog en `usuario.crow.maestro.press/blog` |

Para configuraciones autoalojadas, consulta las secciones de abajo para hacer tu blog accesible desde internet.

### Tailscale Funnel (Recomendado para autoalojamiento)

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) expone tu gateway a internet público a través de la infraestructura de Tailscale — sin reenvío de puertos, sin DNS dinámico, sin registro de dominio.

```bash
# Primero habilita Funnel en tu consola de administración de Tailscale:
# https://login.tailscale.com/admin/dns → Enable Funnel

# Luego expón tu gateway
tailscale funnel --bg --https=443 http://localhost:3001
```

Tu blog ahora es accesible públicamente en `https://<hostname>.tu-tailnet.ts.net/blog`.

El Crow's Nest permanece privado — las solicitudes desde IPs públicas reciben una respuesta 403 porque no están dentro de los rangos de red permitidos. Solo el blog (y otras rutas sin autenticación como `/health` y `/setup`) son efectivamente visibles para el público.

### Dominio personalizado con Caddy

Si quieres un dominio personalizado que solo sirva tu blog (no el gateway completo), puedes configurar Caddy como reverse proxy con restricciones de ruta.

::: warning
Este Caddyfile reemplaza el proxy predeterminado del gateway completo. Si estás usando Caddy para servir el Crow's Nest a través de Tailscale, necesitarás configuraciones de Caddy separadas o un Caddyfile combinado.
:::

```
tudominio.com {
    # Solo hacer proxy de rutas de blog y health
    handle /blog* {
        reverse_proxy localhost:3001
    }
    handle /health {
        reverse_proxy localhost:3001
    }

    # Bloquear todo lo demás
    handle {
        respond "Not Found" 404
    }
}
```

Caddy provisiona automáticamente certificados de Let's Encrypt para tu dominio.

### Configurar `CROW_GATEWAY_URL`

Para que los enlaces de feeds RSS, etiquetas Open Graph, URLs del sitemap y vistas previas en redes sociales funcionen correctamente, configura la URL pública de tu gateway:

```bash
# En tu archivo .env
CROW_GATEWAY_URL=https://tudominio.com
```

Sin esto, los enlaces en feeds y vistas previas en redes sociales apuntarán a `http://localhost:3001`, lo cual no funcionará para visitantes externos.
