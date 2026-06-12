---
title: Miniflux
---

# Miniflux

Conecta Crow a Miniflux, un lector RSS minimalista, para suscribirte a feeds, leer artículos y mantenerte al día con tus noticias a través de tu asistente de IA.

## Qué obtienes

- Suscribirte a feeds RSS/Atom
- Explorar artículos no leídos con filtros
- Leer el contenido completo de los artículos
- Destacar y marcar artículos importantes
- Marcar entradas como leídas (individual o en lote)
- Gestionar las suscripciones a feeds

## Configuración

Crow soporta dos modos para Miniflux: autoalojamiento vía Docker o conexión a una instancia existente.

### Opción A: Docker (autoalojado)

Instala Miniflux como un bundle de Crow. Esto ejecuta Miniflux con PostgreSQL en Docker junto a tu gateway de Crow.

> "Crow, instala el bundle de Miniflux"

O instálalo desde el panel de **Extensiones** en el Crow's Nest.

Después de la instalación, configura tu contraseña de administrador:

```bash
# En tu archivo .env
MINIFLUX_ADMIN_PASSWORD=tu-contraseña-segura
```

Reinicia el bundle para que los cambios surtan efecto:

> "Crow, reinicia el bundle de Miniflux"

Miniflux estará disponible en `http://tu-servidor:8085`. Inicia sesión con la cuenta de administrador y luego genera una clave de API desde **Settings** > **API Keys**.

::: tip Nota sobre el puerto
El puerto por defecto de Miniflux (8080) se reasigna al 8085 para evitar conflictos con otros servicios.
:::

### Opción B: Conectar a Miniflux existente

Si ya tienes una instancia de Miniflux funcionando, conecta Crow directamente a ella.

#### Paso 1: Obtener tu clave de API

1. Abre la interfaz web de Miniflux
2. Ve a **Settings** > **API Keys**
3. Haz clic en **Create a new API key**
4. Copia la clave generada

#### Paso 2: Agregar a Crow

Configura lo siguiente en tu archivo `.env` o vía **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
MINIFLUX_URL=http://tu-servidor-miniflux:8085
MINIFLUX_API_KEY=tu-clave-api-aqui
```

## Herramientas de IA

Una vez conectado, puedes interactuar con Miniflux a través de tu IA:

> "¿Cuáles son mis artículos no leídos?"

> "Suscríbete a https://example.com/feed.xml"

> "Muéstrame los artículos destacados"

> "Marca todos los feeds de noticias como leídos"

> "¿A qué feeds estoy suscrito?"

## Solución de problemas

### "Conexión rechazada" o tiempo de espera agotado

Asegúrate de que la `MINIFLUX_URL` sea accesible desde la máquina que ejecuta Crow. Si Miniflux está en otra máquina, usa la IP o el nombre de host correcto.

### "Clave de API inválida"

Las claves de API pueden invalidarse si se regeneran. Crea una nueva clave de API desde **Settings** > **API Keys** en Miniflux y actualiza tu archivo `.env`.

### Los feeds no se actualizan

Verifica que la URL del feed sea válida y accesible desde la máquina que ejecuta Miniflux. Algunos feeds requieren encabezados User-Agent específicos o pueden estar detrás de autenticación. Puedes verificar el estado de los feeds en la interfaz web de Miniflux, en **Feeds**.
