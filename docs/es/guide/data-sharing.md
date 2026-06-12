---
title: Compartir Datos
description: Comparte bases de datos y espacios de proyecto entre usuarios de Crow usando los modos de clonación, lectura federada o suscripción.
---

# Compartir datos

Comparte espacios de proyecto y bases de datos con otros usuarios de Crow. Tres modos te dan control sobre cuántos datos viajan y quién puede acceder a ellos.

::: info Estado actual de entrega (Fase 1)
**El modo clonación es el único disponible hoy** para compartir espacios de proyecto (`crow_share` con `share_type: "project"`, `mode: "clone"`). El paquete incluye los metadatos del proyecto, fuentes, notas, registro de auditoría, manifiestos de backends de datos (solo nombres de variables de entorno — sin secretos) y un manifiesto de archivos de almacenamiento con URLs prefirmadas de 24 horas. El destinatario obtiene un proyecto independiente con un slug `-clone-N`; los cambios posteriores en cualquiera de los dos lados no se sincronizan.

**Suscripción** y **lectura federada** son hitos planificados a futuro — requieren infraestructura nueva (un feed de Hypercore por proyecto con filtrado a nivel de fila para suscripción; autenticación de proxy en el gateway + enrutamiento de consultas para lectura federada). Las descripciones de abajo son el diseño objetivo, no la implementación actual.
:::

## Modos de compartición

| Modo | Estado | Qué sucede | Ideal para |
|---|---|---|---|
| **Clonación** | **Disponible (Fase 1)** | Se envía una copia completa de la base de datos / proyecto al destinatario. Recibe un snapshot independiente. | Entregas únicas, datasets pequeños, acceso sin conexión |
| **Lectura federada** | *Planificado (Fase 2+)* | El destinatario consulta tu base de datos de forma remota a través del proxy del gateway. No se copia ningún dato. | Datasets grandes, datos en vivo, acceso controlado |
| **Suscripción** | *Planificado (Fase 2+)* | El destinatario recibe actualizaciones continuas a medida que modificas la base de datos de origen. | Proyectos colaborativos, datos de referencia compartidos |

## Clonación

Una clonación envía una copia completa de un archivo de base de datos a un contacto. El destinatario obtiene su propia copia independiente — los cambios que haga no afectan tu original.

```
"Clona mi base de datos county-data y compártela con Robin"
```

La IA usa `crow_share` con `share_type: "database"` y `mode: "clone"`. El archivo de base de datos se transfiere a través de Hypercore, el mismo canal P2P que se usa para compartir memorias.

### Cuándo clonar

- El dataset es lo bastante pequeño para transferirse con comodidad (menos de ~500 MB)
- El destinatario necesita acceso sin conexión
- Quieres entregar un dataset sin mantener una conexión

## Lectura federada

La lectura federada le da a un contacto permiso para ejecutar consultas de solo lectura contra tu base de datos a través del proxy del gateway. No se copia ningún dato — las consultas se ejecutan en tu máquina y solo los resultados viajan por la red.

```
"Dale a Robin acceso de lectura a mi base de datos tax-filings"
```

El destinatario puede entonces consultar tu base de datos desde su propia IA o su Data Dashboard. Las solicitudes se autentican con tokens bearer y están sujetas al mismo [modelo de seguridad](./data-dashboard) que las consultas locales.

### Cuándo federar

- El dataset es grande y clonarlo sería poco práctico
- Quieres que el destinatario siempre vea los datos más recientes
- Necesitas poder revocar el acceso más adelante sin perseguir copias

Revoca el acceso en cualquier momento:

```
"Revoca el acceso de Robin a mi base de datos tax-filings"
```

## Suscripción

Una suscripción es un canal de sincronización persistente. Cuando actualizas la base de datos de origen, los cambios se propagan al suscriptor automáticamente a través de la replicación de Hypercore.

```
"Suscribe a Robin a las actualizaciones de mi base de datos county-data"
```

Las suscripciones son unidireccionales — el suscriptor recibe tus cambios, pero sus modificaciones locales (si las hay) no fluyen de vuelta hacia ti.

### Cuándo suscribir

- Varias personas necesitan el mismo dataset de referencia siempre actualizado
- Mantienes una fuente de datos compartida (por ejemplo, un dataset curado para un grupo de investigación)
- Quieres sincronización automática sin tener que volver a compartir manualmente

## Gestionar bases de datos compartidas

### Listar comparticiones activas

```
"Muéstrame mis bases de datos compartidas"
```

### Revisar el estado de una compartición

El panel de Compartir del Nest muestra todas las comparticiones de bases de datos activas, incluyendo modo, destinatario y hora de la última sincronización.

### Revocar acceso

Todos los modos de compartición admiten revocación:

- **Clonación** — No hay nada que revocar. El destinatario ya tiene una copia.
- **Lectura federada** — Detiene de inmediato el acceso a consultas.
- **Suscripción** — Detiene las actualizaciones futuras. Los datos ya recibidos se quedan con el suscriptor.

## Próximos pasos

- [Guía de Compartir](./sharing) — Conceptos generales de compartición P2P
- [Data Dashboard](./data-dashboard) — Consulta y visualiza bases de datos compartidas
- [Backends de Datos](/guide/data-backends) — Registra bases de datos para compartir

## Bajo el capó

Para el formato del paquete de clonación y los detalles internos del protocolo de compartición, consulta la [arquitectura del Sharing Server](/architecture/sharing-server).
