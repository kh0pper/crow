---
title: TriliumNext
---

# TriliumNext

Conecta Crow a TriliumNext para buscar, crear y organizar notas en tu base de conocimiento personal a traves de tu asistente de IA.

## Que obtienes

- Buscar notas por contenido, titulo o atributos
- Crear y editar notas con texto enriquecido o markdown
- Explorar la estructura del arbol de notas
- Recortar paginas web en notas
- Acceder y crear notas del dia (diario diario)
- Exportar notas en varios formatos

## Configuracion

Crow soporta dos modos: autoalojar TriliumNext via Docker o conectarse a una instancia existente.

### Opcion A: Docker (autoalojado)

Instala TriliumNext como un bundle de Crow:

> "Crow, instala el bundle de TriliumNext"

O instalalo desde el panel de **Extensiones** en el Crow's Nest.

TriliumNext estara disponible en `http://tu-servidor:8080` despues de la instalacion. Completa la configuracion inicial en la interfaz web para establecer tu contrasena.

### Opcion B: Conectar a TriliumNext existente

Si ya tienes un servidor TriliumNext funcionando, conecta Crow directamente.

#### Paso 1: Obtener tu token ETAPI

1. Abre la interfaz web de TriliumNext
2. Ve a **Opciones** (menu superior derecho) > **ETAPI**
3. Haz clic en **Crear nuevo token ETAPI**
4. Ponle un nombre (ej., "Crow")
5. Copia el token generado

#### Paso 2: Agregar a Crow

Configura lo siguiente en tu archivo `.env` o via **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
TRILIUM_URL=http://tu-servidor-trilium:8080
TRILIUM_ETAPI_TOKEN=tu-token-etapi-aqui
```

## Herramientas de IA

Una vez conectado, interactua con TriliumNext a traves de tu IA:

> "Busca en mis notas 'planificacion de proyecto'"

> "Crea una nota llamada 'Notas de reunion — 21 de marzo' bajo mi carpeta Trabajo"

> "Muestrame la nota del dia de hoy"

> "Recorta este articulo en TriliumNext: https://ejemplo.com/articulo"

> "Explora mi arbol de notas"

> "Exporta mi carpeta de Investigacion como HTML"

## Flujos de trabajo

### Captura de investigacion

Combina TriliumNext con las herramientas de investigacion de Crow:

> "Guarda estos hallazgos de investigacion en una nota de TriliumNext y agrega la fuente a mi proyecto de Crow"

Las notas creadas de esta forma se vinculan a tu proyecto de investigacion de Crow para referencias cruzadas.

### Organizacion de conocimiento

Usa tu IA para reorganizar notas:

> "Mueve todas mis notas de reuniones de 2025 a una carpeta de Archivo"

> "Crea una nota de tabla de contenidos para mi carpeta de Recetas de Cocina"

### Diario diario

Las notas del dia de TriliumNext funcionan bien con el protocolo de sesion de Crow:

> "Agrega un resumen de la sesion de hoy a mi nota del dia"

## Referencia de Docker Compose

Si prefieres una configuracion manual de Docker:

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

## Solucion de problemas

### "Conexion rechazada" o tiempo de espera agotado

Asegurate de que la `TRILIUM_URL` sea accesible desde la maquina que ejecuta Crow. TriliumNext usa el puerto 8080 por defecto.

### "401 No autorizado"

Es posible que el token ETAPI haya sido eliminado. Crea uno nuevo desde Opciones > ETAPI en la interfaz web de TriliumNext.

### Las notas no aparecen en la busqueda

Los indices de busqueda de TriliumNext pueden necesitar reconstruirse. Abre la interfaz web de TriliumNext y revisa Opciones > Avanzado para opciones de reindexacion.

### Las notas del dia no funcionan

Las notas del dia requieren una estructura de notas especifica en TriliumNext. Asegurate de tener una nota "Journal" con el atributo `#calendarRoot`. TriliumNext la crea automaticamente durante la configuracion inicial.
