# Backends de datos

Los backends de datos te permiten conectar fuentes de datos externas -- bases de datos, APIs y otros servidores MCP -- a los proyectos de Crow. En lugar de importar datos manualmente, registras un backend y Crow puede consultarlo bajo demanda, capturar conocimiento de él y seguirlo junto al resto de tu trabajo de proyecto.

## ¿Qué es un backend de datos?

Un backend de datos es un servidor MCP que Crow sabe cómo alcanzar. Cuando registras uno, Crow almacena sus detalles de conexión y puede inspeccionar su esquema (herramientas disponibles) y enrutarle consultas a través de tus proyectos.

Piénsalo como la diferencia entre copiar datos dentro de Crow y conectar Crow al lugar donde viven los datos. El backend sigue siendo la fuente autoritativa; Crow aporta la capa de proyecto por encima -- notas, fuentes, organización y acceso multiplataforma.

## Cuándo usar backends de datos

Los backends de datos son útiles cuando:

- Tienes una base de datos existente (Postgres, MySQL, SQLite) con datos que quieres consultar a través de tu IA
- Ejecutas un servidor MCP que expone herramientas de dominio específico (p. ej., un servidor de Canvas LMS, un servidor de datos financieros)
- Quieres capturar hallazgos de datos externos como fuentes de investigación o notas sin copiar y pegar manualmente
- Necesitas trabajar con datos vivos que cambian con el tiempo, en lugar de capturas estáticas

## Registrar un backend

Usa la herramienta `crow_register_backend` para conectar un servidor MCP como backend de datos:

> "Registra mi servidor MCP de Postgres en `http://localhost:5433/mcp` como un backend de datos llamado 'course-database'"

Esto almacena el nombre, la URL y la descripción del backend en la tabla `data_backends`. Después puedes asociarlo a un proyecto de tipo `data_connector`.

### Información requerida

| Campo | Descripción |
|---|---|
| `name` | Un nombre corto para el backend (p. ej., "course-database", "student-records") |
| `server_url` | La URL del servidor MCP (endpoint Streamable HTTP) |
| `description` | Qué datos provee este backend (ayuda a la IA a saber cuándo usarlo) |

## Gestionar backends

### Listar los backends registrados

> "Muéstrame mis backends de datos"

La herramienta `crow_list_backends` devuelve todos los backends registrados con sus nombres, URLs y descripciones.

### Inspeccionar el esquema de un backend

> "¿Qué herramientas provee el backend course-database?"

La herramienta `crow_backend_schema` se conecta al backend y devuelve sus herramientas disponibles y los esquemas de sus parámetros. Esto te ayuda a entender qué consultas son posibles.

### Eliminar un backend

> "Elimina el backend course-database"

La herramienta `crow_remove_backend` borra el registro. Esto no afecta al servidor MCP externo en sí -- solo elimina la referencia que Crow tenía de él.

## Proyectos de conector de datos

Cuando creas un proyecto con `type: "data_connector"`, está diseñado para trabajar con backends registrados:

> "Crea un proyecto de conector de datos llamado 'Análisis de Cursos Otoño 2026' y vincúlalo al backend course-database"

Los proyectos de conector de datos soportan las mismas fuentes, notas y etiquetado que los proyectos de investigación. La diferencia es el flujo de trabajo: en lugar de agregar fuentes manualmente desde búsquedas web, consultas un backend y capturas los resultados como fuentes o notas.

## Flujo de captura de conocimiento

Un flujo de trabajo típico con backends de datos:

1. **Registra el backend** -- Conecta el servidor MCP externo
2. **Crea un proyecto de conector de datos** -- Dale un hogar a tu trabajo
3. **Consulta el backend** -- Usa las herramientas del backend para extraer datos
4. **Captura los hallazgos** -- Almacena los resultados interesantes como fuentes o notas en el proyecto
5. **Analiza entre proyectos** -- Busca en las notas, genera reportes, comparte con colaboradores

La IA maneja los pasos 3-4 de forma natural durante la conversación. Cuando haces una pregunta que involucra datos del backend, la IA puede consultar el backend y ofrecerte guardar los resultados en tu proyecto.

## Ejemplo: conectar a Postgres

Supón que tienes un servidor MCP de Postgres corriendo localmente que expone las herramientas `query` y `list_tables`.

**1. Regístralo:**

> "Registra un backend de datos llamado 'enrollment-db' en `http://localhost:5433/mcp` -- tiene datos de inscripción de estudiantes"

**2. Crea un proyecto:**

> "Crea un proyecto de conector de datos llamado 'Tendencias de Inscripción' vinculado a enrollment-db"

**3. Consulta y captura:**

> "Consulta en enrollment-db el total de inscripciones por departamento de los últimos 3 años, y guarda los resultados como una fuente en el proyecto Tendencias de Inscripción"

La IA consulta el backend, formatea los resultados y los almacena como una fuente con los metadatos apropiados.

## Consideraciones de seguridad

- Las URLs de los backends se almacenan en la base de datos local de Crow -- no se comparten con peers ni se exponen a través del gateway
- La autenticación ante el servidor MCP del backend la maneja el propio servidor (tokens bearer, OAuth, etc.)
- Crow no cachea los datos del backend a menos que los captures explícitamente como fuente o nota
- Eliminar un backend no borra las fuentes ni las notas que se capturaron de él
