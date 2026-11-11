---
title: Historial, papelera y deshacer
---

# Historial, papelera y deshacer

Crow conserva las versiones anteriores de lo que guardas en él. Si tú, un bot o una de tus otras máquinas cambia algo, puedes ver quién lo cambió y cuándo, y reponer la versión anterior. Está activado de forma predeterminada en cada instalación.

## Qué se conserva

- Recuerdos y secciones de contexto (de todos los ámbitos)
- Entradas del blog y borradores
- Notas de proyecto y artículos de la base de conocimiento
- Ajustes e instrucciones de los bots. Las credenciales de un bot nunca se conservan: un valor que parece una clave o un token se guarda con el secreto tapado.
- Tarjetas del tablero: título, descripción y plan
- Artefactos, mediante su propia lista de versiones. Restaurar agrega una versión nueva hecha a partir de la anterior.
- Archivos de proyecto: todo lo que hay en la carpeta de trabajo de un proyecto

Las canciones de Studio conservan su propio deshacer dentro de Studio. Aquí solo aparecen, en modo de solo lectura, en la lista de lo que tocó un trabajo, con un enlace a la canción.

Los mensajes, las notificaciones y los Ajustes no se conservan: son conversación y configuración, no trabajo.

## Quién lo cambió

Cada versión dice quién la hizo:

- **Tú**: un cambio desde tu propia sesión iniciada
- **Un bot con nombre**: el bot que hizo el cambio
- **Otra máquina**: un cambio que llegó desde uno de tus Crow emparejados
- **Sistema**: algo que Crow hizo por sí mismo
- **Sin atribuir**: un cambio que llegó sin autor, por ejemplo un archivo editado fuera de Crow

Un cambio nunca se registra a nombre de otra persona, y un autor desconocido nunca se muestra como si fueras tú.

## Ver el Historial de un elemento

Abre el botón **Historial** en un recuerdo o una entrada del blog y verás sus versiones, de la más reciente a la más antigua, con la hora, el autor y qué cambió: texto agregado y texto quitado en lo escrito, antes y después en ajustes y números. Los guardados del mismo autor con pocos minutos de diferencia cuentan como una sola versión.

Otros tipos de elementos (notas, artículos, bots, tarjetas, artefactos) también conservan sus versiones, y lo que cambió aparece en las páginas **Trabajos** y **Papelera**. Por ahora solo los recuerdos y las entradas del blog tienen un botón Historial en su propia pantalla.

## Restaurar

**Restaurar** repone una versión anterior. La restauración es a su vez una versión nueva al principio de la lista, así que restaurar nunca pierde nada, y puedes restaurar otra vez para volver.

- Una versión cuyo secreto se tapó no se puede restaurar; elige otra.
- Restaurar una **tarjeta** devuelve solo su contenido (título, descripción, plan). La tarjeta conserva su estado actual y su bot, así que reponer palabras viejas no mueve el trabajo de lugar.
- Una **tarjeta borrada** vuelve como una tarea pendiente sin asignar que espera tu visto bueno. No regresa al bot que la tenía.

## Deshacer este trabajo

Un trabajo es una pieza de trabajo: una tarjeta del tablero, un encargo de voz, un turno de chat, una programación o tu propio inicio de sesión. **Deshacer este trabajo**, en la página Trabajos, repone todo lo que ese trabajo cambió.

Deshacer puede ser parcial. Si otra persona o trabajo cambió un elemento después (tú u otro trabajo), deshacer lo deja como está, así que nunca sobrescribe trabajo más nuevo, y enumera lo que omitió con un enlace Restaurar en cada uno. Un deshacer no se puede deshacer desde esa página; restaura los elementos uno por uno.

## Papelera y borrado

Un elemento borrado va a la **papelera** con todo su historial. Puedes restaurarlo desde allí. Permanece **30 días** de forma predeterminada, y puedes cambiar los días en Ajustes, en Historial. Pasado ese tiempo se **borra para siempre**, junto con su historial, del almacén en uso. También puedes vaciar la papelera antes. Las ediciones nunca se borran de esta manera.

Los respaldos son aparte. Los respaldos nocturnos conservan las 14 copias más recientes y la primera copia de cada uno de los últimos seis meses, así que la copia de un elemento borrado desaparece cuando caducan los respaldos que la contienen, lo que puede tardar hasta unos seis meses en las copias mensuales de archivos de proyecto.

### Borrado en las máquinas emparejadas

Cada máquina borra con su propio reloj. **Avisar a los Crows emparejados cuando algo se borra** (`history.erase_sync`) está desactivado de forma predeterminada. Actívalo solo cuando todos los Crow emparejados tengan esta versión o una posterior; una máquina más antigua no entendería el mensaje. El ajuste pertenece a esta máquina y nunca se envía a las demás.

### Archivos de proyecto

Los archivos de proyecto borrados esperan en el historial de archivos. Borrarlos de forma programada es un ajuste aparte, `history.workspace_auto_erase`, y está desactivado de forma predeterminada. Todavía no hay una página del panel para explorar y restaurar archivos de proyecto, así que mientras tanto el historial de archivos es la única copia de un archivo que borró un bot. Cuando un proyecto se borra para siempre, su historial de archivos se borra con él.

## Qué se omite

El historial de archivos registra lo que tú o un bot dejan en la carpeta de un proyecto, salvo:

- archivos de credenciales y claves (por ejemplo `.env`, `.mcp.json`, `*.pem`, `*.key`, claves SSH), los archivos privados de sesión de un bot y los almacenes de contraseñas
- cachés y dependencias (por ejemplo `node_modules`, `.venv`, `__pycache__`, `dist`, `target`)
- bases de datos locales (`*.db`)
- archivos de más de 25 MB, porque el historial no es una segunda copia de un video o un modelo

Un `.gitignore` dentro de un proyecto no oculta nada del historial.

Un propietario técnico puede clonar el historial de archivos de un proyecto desde el `repo_path` del proyecto.

## Retención

Ajustes, en Historial, muestra la línea de retención. Hoy es **para siempre**: las versiones permanecen hasta que su elemento se borra desde la papelera. Si cambias la retención más adelante, se aplica al historial existente a partir de ese momento.

## La línea de tamaño

El historial ocupa espacio en disco, así que Ajustes, en Historial, muestra cuánto: el número de versiones y su tamaño para notas, entradas, tarjetas y lo demás, y el tamaño del historial de archivos de proyecto. Si una parte no se puede medir en ese momento, lo dice y el total puede ser mayor.

Cuando todo el historial supera una décima parte del espacio libre que queda en la máquina, la página muestra una advertencia. Como la advertencia depende del espacio libre, llega antes en una máquina pequeña como una Raspberry Pi y se mantiene callada en un disco grande. Si la ves, libera espacio o reduce cuántos días se quedan en la papelera los elementos borrados.

## Una advertencia sobre los bots

Los bots que pueden escribir directamente en la base de datos de Crow todavía podrían cambiar este historial. Esa brecha se cierra cuando se activa el confinamiento de bots. Las páginas del Historial muestran este aviso hasta entonces.
