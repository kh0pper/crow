---
title: TriliumNext
---

# TriliumNext

Conecta Crow a TriliumNext para buscar, crear y organizar notas en tu base de conocimiento personal a través de tu asistente de IA.

## Qué obtienes

- Buscar notas por contenido, título o atributos
- Crear y editar notas con texto enriquecido o markdown
- Explorar la estructura del árbol de notas
- Recortar páginas web en notas
- Acceder y crear notas del día (diario diario)
- Exportar notas en varios formatos

## Configuración

Crow soporta dos modos: autoalojar TriliumNext vía Docker o conectarse a una instancia existente.

### Opción A: Docker (autoalojado)

Instala TriliumNext como un bundle de Crow:

> "Crow, instala el bundle de TriliumNext"

O instálalo desde el panel de **Extensiones** en el Crow's Nest.

TriliumNext estará disponible en `http://tu-servidor:8080` después de la instalación. Completa la configuración inicial en la interfaz web para establecer tu contraseña.

### Opción B: Conectar a TriliumNext existente

Si ya tienes un servidor TriliumNext funcionando, conecta Crow directamente.

#### Paso 1: Obtener tu token ETAPI

1. Abre la interfaz web de TriliumNext
2. Ve a **Opciones** (menú superior derecho) > **ETAPI**
3. Haz clic en **Crear nuevo token ETAPI**
4. Ponle un nombre (ej., "Crow")
5. Copia el token generado

#### Paso 2: Agregar a Crow

Configura lo siguiente en tu archivo `.env` o vía **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
TRILIUM_URL=http://tu-servidor-trilium:8080
TRILIUM_ETAPI_TOKEN=tu-token-etapi-aqui
```

## Herramientas de IA

Una vez conectado, interactúa con TriliumNext a través de tu IA:

> "Busca en mis notas 'planificación de proyecto'"

> "Crea una nota llamada 'Notas de reunión — 21 de marzo' bajo mi carpeta Trabajo"

> "Muéstrame la nota del día de hoy"

> "Recorta este artículo en TriliumNext: https://ejemplo.com/articulo"

> "Explora mi árbol de notas"

> "Exporta mi carpeta de Investigación como HTML"

## Flujos de trabajo

### Captura de investigación

Combina TriliumNext con las herramientas de investigación de Crow:

> "Guarda estos hallazgos de investigación en una nota de TriliumNext y agrega la fuente a mi proyecto de Crow"

Las notas creadas de esta forma se vinculan a tu proyecto de investigación de Crow para referencias cruzadas.

### Organización de conocimiento

Usa tu IA para reorganizar notas:

> "Mueve todas mis notas de reuniones de 2025 a una carpeta de Archivo"

> "Crea una nota de tabla de contenidos para mi carpeta de Recetas de Cocina"

### Diario diario

Las notas del día de TriliumNext funcionan bien con el protocolo de sesión de Crow:

> "Agrega un resumen de la sesión de hoy a mi nota del día"

## Referencia de Docker Compose

Si prefieres una configuración manual de Docker:

```yaml
services:
  trilium:
    image: triliumnext/notes:latest
    container_name: crow-trilium
    ports:
      - "8080:8080"
    volumes:
      - trilium-data:/home/node/trilium-data
    restart: unless-stopped

volumes:
  trilium-data:
```

## Solución de problemas

### "Conexión rechazada" o tiempo de espera agotado

Asegúrate de que la `TRILIUM_URL` sea accesible desde la máquina que ejecuta Crow. TriliumNext usa el puerto 8080 por defecto.

### "401 No autorizado"

Es posible que el token ETAPI haya sido eliminado. Crea uno nuevo desde Opciones > ETAPI en la interfaz web de TriliumNext.

### Las notas no aparecen en la búsqueda

Los índices de búsqueda de TriliumNext pueden necesitar reconstruirse. Abre la interfaz web de TriliumNext y revisa Opciones > Avanzado para opciones de reindexación.

### Las notas del día no funcionan

Las notas del día requieren una estructura de notas específica en TriliumNext. Asegúrate de tener una nota "Journal" con el atributo `#calendarRoot`. TriliumNext la crea automáticamente durante la configuración inicial.
