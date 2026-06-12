---
title: Shiori
---

# Shiori

Conecta Crow a Shiori para guardar páginas web con caché completa sin conexión, buscar marcadores y gestionar tu archivo de lectura a través de tu asistente de IA.

## Qué obtienes

- Guardar páginas web con contenido en caché para lectura sin conexión
- Buscar marcadores por palabra clave
- Explorar marcadores con paginación
- Etiquetar y organizar páginas guardadas
- Ver el contenido en caché de las páginas
- Eliminar marcadores

## Configuración

Crow soporta dos modos para Shiori: autoalojamiento via Docker o conexión a una instancia existente.

### Opción A: Docker (autoalojado)

Instala Shiori como un bundle de Crow. Esto ejecuta Shiori en Docker junto a tu gateway de Crow.

> "Crow, instala el bundle de Shiori"

O instálalo desde el panel de **Extensiones** en el Crow's Nest.

Shiori estará disponible en `http://tu-servidor:8086` para la configuración inicial. Las credenciales predeterminadas son `shiori` / `gopher`. Cambia la contraseña inmediatamente después del primer inicio de sesión.

::: warning Mapeo de puertos
El puerto predeterminado de Shiori (8080) se remapea a **8086** para evitar conflictos con otros servicios.
:::

::: warning Credenciales predeterminadas
Cambia la contraseña predeterminada (`shiori` / `gopher`) inmediatamente después del primer inicio de sesión.
:::

### Opción B: Conectar a Shiori existente

Si ya tienes una instancia de Shiori funcionando, conecta Crow directamente a ella. Shiori usa autenticación basada en sesiones, así que Crow inicia sesión automáticamente con tus credenciales.

Configura lo siguiente en tu archivo `.env` o via **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
SHIORI_URL=http://tu-servidor-shiori:8086
SHIORI_USERNAME=tu-usuario
SHIORI_PASSWORD=tu-contraseña
```

## Herramientas de IA

Una vez conectado, puedes interactuar con Shiori a través de tu IA:

> "Guarda esta página: https://example.com"

> "Busca recetas de cocina en mis marcadores"

> "Muéstrame mis marcadores recientes"

> "¿Qué etiquetas tengo?"

## Caché sin conexión

Shiori guarda en caché el contenido completo de la página cuando guardas un marcador, de modo que las páginas guardadas siguen disponibles incluso si el sitio original deja de existir. Esto lo convierte en un archivo confiable para material de referencia, tutoriales y documentación que quieras conservar permanentemente.

## Referencia de Docker Compose

Si prefieres una configuración manual de Docker en lugar del instalador de bundles:

```yaml
services:
  shiori:
    image: ghcr.io/go-shiori/shiori:latest
    container_name: crow-shiori
    ports:
      - "8086:8080"
    volumes:
      - shiori-data:/shiori
    restart: unless-stopped

volumes:
  shiori-data:
```

## Solución de problemas

### Falló el inicio de sesión

Verifica que el nombre de usuario y la contraseña sean correctos. Si estás usando las credenciales predeterminadas, son `shiori` / `gopher`. Si cambiaste la contraseña en la interfaz web de Shiori, actualiza `SHIORI_PASSWORD` en tu archivo `.env`.

### "Conexión rechazada" o tiempo de espera agotado

Asegúrate de que la `SHIORI_URL` sea accesible desde la máquina que ejecuta Crow. Si Shiori está en otra máquina, usa la IP o el nombre de host correcto.

### Las páginas no guardan contenido en caché

Shiori necesita acceso a la red para obtener el contenido de la página al guardar un marcador. Si el servidor que ejecuta Shiori no puede alcanzar la URL de destino, la página se guardará sin contenido en caché. Verifica la conectividad de red desde el contenedor de Shiori.
