---
title: Panel de Datos
description: Explora bases de datos, ejecuta consultas, crea gráficos y publica estudios de caso — todo desde el Crow's Nest.
---

# Panel de Datos

El Panel de Datos es un complemento (bundle) que convierte a Crow en una plataforma ligera de exploración de datos. Navega esquemas de bases de datos, escribe consultas SQL, visualiza resultados con gráficos y publica hallazgos como entradas de blog.

## Visión General

Instala el complemento del Panel de Datos para obtener un nuevo panel en el Crow's Nest con cuatro pestañas:

| Pestaña | Propósito |
|---|---|
| **Explorador de Esquemas** | Navega tablas, columnas, tipos y relaciones entre las bases de datos conectadas |
| **Editor SQL** | Escribe y ejecuta consultas con resaltado de sintaxis y tablas de resultados |
| **Gráficos** | Crea visualizaciones a partir de los resultados de consultas (barras, líneas, pastel, dispersión) |
| **Estudios de Caso** | Combina consultas, gráficos y narrativa en estudios de caso publicables |

## Primeros Pasos

Instala el complemento:

```
"Instala el panel de datos"
```

O por CLI:

```bash
crow bundle install data-dashboard
crow bundle start data-dashboard
```

El Panel de Datos aparece en la barra lateral del Nest después de la instalación.

## Explorador de Esquemas

El Explorador de Esquemas muestra cada base de datos registrada como [backend de datos](/guide/data-backends). Selecciona una base de datos en el menú desplegable para ver sus tablas, columnas, tipos de datos y relaciones de claves foráneas.

Úsalo para entender conjuntos de datos desconocidos antes de escribir consultas. El explorador lee únicamente metadatos del esquema — nunca toca tus datos.

## Editor SQL

Escribe consultas SQL contra cualquier base de datos registrada. Características:

- **Resaltado de sintaxis** y autocompletado básico
- **Tabla de resultados** con columnas ordenables y conteo de filas
- **Guardar consultas** con nombre y descripción para reutilizarlas
- **Exportar** los resultados como CSV o JSON

```sql
SELECT county, COUNT(*) as filings
FROM tax_returns
WHERE year = 2025
GROUP BY county
ORDER BY filings DESC
LIMIT 20;
```

Ejecuta la consulta con el botón Ejecutar o con `Ctrl+Enter`.

### Consultas Guardadas

Las consultas guardadas persisten en la base de datos de Crow. Accede a ellas desde la barra lateral del Editor SQL. Cada consulta guardada registra:

- Nombre y descripción
- El texto SQL
- A qué base de datos apunta
- Cuándo se ejecutó por última vez

## Gráficos

Selecciona una consulta guardada o ejecuta una consulta ad-hoc, y luego cambia a la pestaña de Gráficos para visualizar los resultados.

Tipos de gráfico soportados:

- **Barras** — Compara categorías (p. ej., declaraciones por condado)
- **Líneas** — Muestra tendencias en el tiempo (p. ej., envíos mensuales)
- **Pastel** — Muestra proporciones (p. ej., distribución por tipo de crédito)
- **Dispersión** — Explora relaciones entre dos columnas numéricas

Los gráficos se renderizan con Chart.js. Configura las etiquetas de los ejes, los colores y los títulos en el editor de gráficos. Guarda los gráficos junto a sus consultas de origen.

## Estudios de Caso

Un estudio de caso combina múltiples consultas, gráficos y análisis escrito en un solo documento. Usa los estudios de caso para contar una historia con datos.

### Crear un Estudio de Caso

1. Ejecuta tus consultas y crea tus gráficos
2. Abre la pestaña de Estudios de Caso y haz clic en **Nuevo Estudio de Caso**
3. Agrega secciones — cada sección puede ser texto narrativo (Markdown), una consulta guardada con su tabla de resultados, o un gráfico
4. Ordena las secciones arrastrándolas a su lugar
5. Previsualiza el estudio de caso renderizado

### Publicar en el Blog

Los estudios de caso se pueden publicar directamente en tu blog de Crow:

```
"Publica mi estudio de caso del análisis de impuestos en el blog"
```

La IA convierte el estudio de caso en una entrada de blog, incrustando los gráficos como imágenes y los resultados de las consultas como tablas formateadas. El estudio de caso original sigue siendo editable — vuelve a publicarlo después de actualizarlo.

## Modelo de Seguridad

El Panel de Datos aplica límites de seguridad estrictos:

- **Solo lectura por defecto** — Solo se permiten consultas `SELECT`. Las sentencias `INSERT`, `UPDATE`, `DELETE` y DDL se bloquean a menos que habilites explícitamente el modo de escritura para una base de datos específica.
- **Restricciones de rutas** — Las bases de datos SQLite deben estar dentro de directorios permitidos (`~/.crow/data/`, rutas de backends registrados). Sin acceso a bases de datos del sistema ni a archivos fuera del sandbox.
- **Tiempos límite de consulta** — Las consultas se cancelan después de 30 segundos para prevenir operaciones desbocadas.
- **Sin ejecución remota** — Las consultas se ejecutan localmente contra los backends registrados. Las consultas de federación pasan por el proxy del gateway con las mismas verificaciones de seguridad del lado remoto.

## Próximos Pasos

- [Backends de Datos](/guide/data-backends) — Registra bases de datos externas
- [Compartir Datos](./data-sharing) — Comparte bases de datos con otros usuarios de Crow
- [Arquitectura del Panel de Datos](/architecture/data-dashboard) — Análisis técnico profundo
- [Extender el Dashboard](/developers/data-dashboard) — Agrega tipos de gráficos y exportadores
