---
title: Linkding
---

# Linkding

Conecta Crow a Linkding para guardar, buscar, etiquetar y organizar tus marcadores a través de tu asistente de IA.

## Qué obtienes

- Guardar marcadores con etiquetas y descripciones
- Buscar marcadores por texto
- Explorar y filtrar por etiquetas
- Editar los detalles de los marcadores
- Organizar con indicadores de archivado y no leído
- Eliminar marcadores

## Configuración

Crow soporta dos modos para Linkding: autoalojamiento vía Docker o conexión a una instancia existente.

### Opción A: Docker (autoalojado)

Instala Linkding como un bundle de Crow. Esto ejecuta Linkding en Docker junto a tu gateway de Crow.

> "Crow, instala el bundle de Linkding"

O instálalo desde el panel de **Extensiones** en el Crow's Nest.

Linkding estará disponible en `http://tu-servidor:9090` para la configuración inicial. Crea una cuenta a través de la interfaz web y luego obtén tu token de API desde **Settings** > **Integrations**.

### Opción B: Conectar a Linkding existente

Si ya tienes una instancia de Linkding funcionando, conecta Crow directamente a ella.

#### Paso 1: Obtener tu token de API

1. Abre la interfaz web de Linkding
2. Ve a **Settings** > **Integrations**
3. Copia el token de API que se muestra en la página

#### Paso 2: Agregar a Crow

Configura lo siguiente en tu archivo `.env` o vía **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
LINKDING_URL=http://tu-servidor-linkding:9090
LINKDING_API_TOKEN=tu-token-api-aqui
```

## Herramientas de IA

Una vez conectado, puedes interactuar con Linkding a través de tu IA:

> "Guarda este enlace: https://example.com con la etiqueta 'referencia'"

> "Busca tutoriales de python en mis marcadores"

> "Muéstrame los marcadores etiquetados con 'recetas'"

> "Elimina ese marcador"

## Referencia de Docker Compose

Si prefieres una configuración manual de Docker en lugar del instalador de bundles:

```yaml
services:
  linkding:
    image: sissbruecker/linkding:latest
    container_name: crow-linkding
    ports:
      - "9090:9090"
    volumes:
      - linkding-data:/etc/linkding/data
    restart: unless-stopped

volumes:
  linkding-data:
```

## Solución de problemas

### "Conexión rechazada" o tiempo de espera agotado

Asegúrate de que la `LINKDING_URL` sea accesible desde la máquina que ejecuta Crow. Si Linkding está en otra máquina, usa la IP o el nombre de host correcto.

### "401 No autorizado" o token inválido

Es posible que el token de API haya sido regenerado. Obtén el token actual desde **Settings** > **Integrations** en Linkding y actualiza tu archivo `.env`.

### La búsqueda no encuentra resultados

Linkding indexa los títulos, descripciones y etiquetas de los marcadores, pero no el contenido completo de las páginas guardadas. Asegúrate de agregar etiquetas y notas descriptivas al guardar marcadores para mejorar los resultados de búsqueda.
