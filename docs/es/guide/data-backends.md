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

Hay dos tipos de backend, elegidos con `backend_type` en `crow_register_backend`:

| Tipo | Qué es | `connection_ref` |
|---|---|---|
| `mcp_server` (predeterminado) | Un servidor MCP que Crow inicia como comando local | `{"command":"npx","args":["-y","mcp-server-postgres"],"envVars":["POSTGRES_URL"]}` |
| `sqlite` | Un archivo SQLite que Crow lee en modo solo lectura | `{"path":"/home/alex/.crow/data/datasets/matricula.db"}` |

### Un backend `mcp_server` espera tu aprobación

Un backend `mcp_server` es un comando que tu Crow ejecutará, así que registrarlo nunca basta para ejecutarlo. La IA (o un bot) solo puede crearlo **pendiente de aprobación**. Para iniciarlo, abre **Crow's Nest › Proyectos**, abre el proyecto del backend y busca **Data Backends**. La página muestra exactamente lo que se ejecutaría: el comando, cada argumento en su propia línea (los caracteres invisibles o no ASCII aparecen como códigos `\u{…}`) y los nombres exactos de las variables de entorno que recibe.

`connection_ref` solo puede contener `command`, `args`, `envVars` y `command_sha256`. Crow lo guarda en una única forma canónica, y la página, la aprobación y el inicio leen ese mismo texto; un registro con cualquier otra clave, claves duplicadas, o demasiado largo para mostrarse completo, no se puede aprobar. Los archivos fijados se inician por su ruta real, comprobada justo antes del inicio.

La aprobación cubre la línea de comando y el contenido actual de los archivos que ejecuta (el lanzador, si es una ruta, y cada argumento que nombra un archivo existente, como el script que ejecuta un intérprete), salvo archivos del sistema propiedad de root. Si se edita uno de esos archivos, deja de iniciarse hasta que lo apruebes de nuevo. **No** cubre el código que el comando descarga al iniciarse (por ejemplo paquetes de `npx` o `uvx`) ni otros archivos que un script abra por su cuenta.

El lanzador se comprueba al aprobar y cada vez que se inicia, con las mismas reglas que los complementos; un `command_sha256` incluido en el registro lo aportó quien lo registró, y la página lo indica.

**Entorno.** El backend no hereda el entorno del gateway: recibe la misma lista básica permitida que los bots (como `PATH`, `HOME`, idioma y proxy; nada que parezca una credencial) más solo las variables nombradas en `envVars`, con sus valores de tu `.env`. La página lista todos los nombres que recibirá.

### Un backend `sqlite` es un conjunto de datos

El archivo debe estar en la carpeta `datasets/` de tu carpeta de datos (por ejemplo `~/.crow/data/datasets/`) o en la carpeta `databases/` de un proyecto. Crow lo abre en solo lectura y nunca escribe en él. Las bases de datos propias de Crow (`crow.db`, `tasks.db`) nunca se pueden registrar, ni siquiera mediante un enlace.

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

- Registrar un backend `mcp_server` nunca ejecuta nada: solo el propietario, con sesión iniciada en Crow's Nest, puede aprobar un comando, y la aprobación deja de valer en cuanto el comando cambia
- Los backends nunca se copian desde otras instancias: un proyecto compartido lleva una descripción de sus backends, no un registro ejecutable
- Los conjuntos de datos `sqlite` se abren en solo lectura, una sentencia por consulta, con límites de filas, de tamaño y de tiempo (cada consulta corre en un proceso aparte que se detiene al llegar al límite)
- Un backend aprobado recibe un entorno con lista permitida más sus variables declaradas, nunca todo el entorno del gateway
- Las credenciales quedan en `.env`; la base de datos solo guarda nombres de variables
- Eliminar un backend no borra las fuentes ni las notas capturadas de él
