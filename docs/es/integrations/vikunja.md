---
title: Vikunja
---

# Vikunja

Conecta Crow a Vikunja para gestionar tareas, proyectos, etiquetas y fechas de vencimiento a través de tu asistente de IA. Soporta tableros kanban y colaboración en equipo.

## Qué obtienes

- Listar y explorar proyectos
- Crear y gestionar tareas con prioridades y fechas de vencimiento
- Filtrar tareas (completadas, prioridad, proyecto, vencidas)
- Gestionar etiquetas
- Crear nuevos proyectos
- Hacer seguimiento del avance de las tareas

## Configuración

Crow soporta dos modos para Vikunja: autoalojamiento via Docker o conexión a una instancia existente.

### Opción A: Docker (autoalojado)

Instala Vikunja como un bundle de Crow. Esto ejecuta Vikunja en Docker junto a tu gateway de Crow. Vikunja usa SQLite integrado, así que no se necesita una base de datos externa.

> "Crow, instala el bundle de Vikunja"

O instálalo desde el panel de **Extensiones** en el Crow's Nest.

Vikunja estará disponible en `http://tu-servidor:3456` para la configuración inicial. Crea una cuenta desde la interfaz web y luego genera un token de API desde **Settings** > **API Tokens**.

### Opción B: Conectar a Vikunja existente

Si ya tienes una instancia de Vikunja funcionando, conecta Crow directamente a ella.

#### Paso 1: Obtener tu token de API

1. Abre la interfaz web de Vikunja
2. Ve a **Settings** > **API Tokens**
3. Crea un nuevo token
4. Copia el token generado

#### Paso 2: Agregar a Crow

Configura lo siguiente en tu archivo `.env` o via **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
VIKUNJA_URL=http://tu-servidor-vikunja:3456
VIKUNJA_API_TOKEN=tu-token-api-aqui
```

## Herramientas de IA

Una vez conectado, puedes interactuar con Vikunja a través de tu IA:

> "Muéstrame mis tareas abiertas"

> "Crea una tarea: Revisar el informe trimestral, vence el viernes, prioridad alta"

> "¿Qué tareas están vencidas?"

> "Marca esa tarea como completada"

> "Crea un nuevo proyecto llamado Renovación de la Casa"

> "Muéstrame las tareas del proyecto Marketing"

## Referencia de Docker Compose

Si prefieres una configuración manual de Docker en lugar del instalador de bundles:

```yaml
services:
  vikunja:
    image: vikunja/vikunja:latest
    container_name: crow-vikunja
    ports:
      - "3456:3456"
    volumes:
      - vikunja-data:/app/vikunja/files
      - vikunja-db:/db
    restart: unless-stopped

volumes:
  vikunja-data:
  vikunja-db:
```

## Solución de problemas

### "Conexión rechazada" o tiempo de espera agotado

Asegúrate de que la `VIKUNJA_URL` sea accesible desde la máquina que ejecuta Crow. Si Vikunja está en otra máquina, usa la IP o el nombre de host correcto.

### "401 No autorizado" o token inválido

Es posible que el token de API haya sido eliminado o haya expirado. Genera un nuevo token desde **Settings** > **API Tokens** en Vikunja.

### Las tareas no aparecen

Verifica los permisos de proyecto del usuario asociado a tu token de API. Los tokens de API heredan los permisos del usuario que los creó. Si los proyectos se compartieron con acceso restringido, es posible que algunas tareas no sean visibles a través de la API.
