---
title: Historial, papelera y deshacer
---

# Historial, papelera y deshacer

Crow conserva las versiones anteriores de lo que guardas en él. Si tú, un bot o una de tus otras máquinas cambia algo, puedes ver quién lo cambió y cuándo, y reponer la versión anterior. Está activado de forma predeterminada en cada instalación.

## Qué se conserva

- Recuerdos y secciones de contexto (de todos los ámbitos)
- Entradas del blog y borradores
- Notas de proyecto, fuentes de investigación y artículos de la base de conocimiento
- Ajustes e instrucciones de los bots. Los campos de credenciales de un bot nunca se conservan. En cualquier cosa que el Historial conserve, un valor que parece una clave o un token se guarda con el secreto tapado.
- Tarjetas del tablero: título, descripción y plan
- Artefactos, mediante su propia lista de versiones. Restaurar agrega una versión nueva hecha a partir de la anterior.
- Archivos de proyecto: todo lo que hay en la carpeta de trabajo de un proyecto

Las canciones de Studio conservan su propio deshacer dentro de Studio. Aquí solo aparecen, en modo de solo lectura, en la lista de lo que tocó un trabajo, con su nombre.

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

Abre el botón **Historial** en un recuerdo, una sección de contexto o una entrada del blog y verás sus versiones, de la más reciente a la más antigua, con la hora, el autor y qué cambió: texto agregado y texto quitado en lo escrito, antes y después en ajustes y números. Los guardados del mismo autor con pocos minutos de diferencia cuentan como una sola versión.

Otros tipos de elementos (notas, fuentes de investigación, artículos, bots, tarjetas, artefactos) también conservan sus versiones, pero todavía no todos aparecen en las páginas **Trabajos** y **Papelera**. Allí se listan las notas, las fuentes de investigación, los artículos y los ajustes de bots, junto con los recuerdos, las secciones de contexto y las entradas del blog. Los artefactos conservan su propia lista de versiones en la vista del artefacto. Las versiones de una tarjeta se conservan, pero todavía no hay una página para explorarlas. Por ahora solo los recuerdos, las secciones de contexto y las entradas del blog tienen un enlace Historial en su propia pantalla.

## Restaurar

**Restaurar** repone una versión anterior. La restauración es a su vez una versión nueva al principio de la lista, así que restaurar nunca pierde nada, y puedes restaurar otra vez para volver.

- Una versión cuyo secreto se tapó no se puede restaurar; elige otra.
- Restaurar una **tarjeta** devuelve solo su contenido (título, descripción, plan). La tarjeta conserva su estado actual y su bot, así que reponer palabras viejas no mueve el trabajo de lugar.
- Una **tarjeta borrada** vuelve sin asignar, en la primera columna del tablero, esperando tu visto bueno. No regresa al bot que la tenía. La papelera todavía no lista tarjetas.

## Deshacer este trabajo

Un trabajo es una pieza de trabajo: una tarjeta del tablero, un encargo de voz, un turno de chat, una programación o tu propio inicio de sesión. **Deshacer este trabajo**, en la página Trabajos, repone los recuerdos, las secciones de contexto, las entradas del blog, las notas, las fuentes de investigación, los artículos y los ajustes de bots que ese trabajo cambió. Los archivos de proyecto, las tarjetas del tablero y los artefactos todavía no forman parte de un deshacer; restáuralos uno por uno.

Deshacer puede ser parcial. Si algo más cambió un elemento después (tú u otro trabajo), deshacer lo deja como está, así que nunca sobrescribe trabajo más nuevo, y enumera lo que omitió, por tipo y número; la lista del trabajo en la página Trabajos muestra cada uno por su nombre. Los recuerdos, las secciones de contexto y las entradas del blog se pueden restaurar desde el enlace Historial de su propia pantalla, y las notas, las fuentes de investigación, los artículos y los ajustes de bots desde la lista del trabajo en la página Trabajos. Un deshacer no se puede deshacer desde esa página; restaura los elementos uno por uno.

## Papelera y borrado

Un elemento borrado va a la **papelera** con todo su historial. Puedes restaurarlo desde allí. Permanece **30 días** de forma predeterminada, y puedes cambiar los días en Ajustes, en Historial. Pasado ese tiempo se **borra para siempre**, junto con su historial, del almacén en uso. También puedes vaciar la papelera antes. Las ediciones nunca se borran de esta manera. Todavía no todos los tipos de elementos aparecen en la papelera: las notas, las fuentes de investigación, los artículos y los ajustes de bots sí, las tarjetas no.

Los respaldos son aparte. Las copias de tus respaldos desaparecen cuando esos respaldos caducan, y cuánto tarda depende de tu calendario de respaldos.

### Borrado en las máquinas emparejadas

Cada máquina borra con su propio reloj. **Avisar a los Crows emparejados cuando algo se borra** (`history.erase_sync`) está desactivado de forma predeterminada, y un Crow emparejado solo aplica un borrado si también tiene este ajuste activado. Actívalo solo cuando todos los Crow emparejados ejecuten Crow desde la actualización del historial de versiones que agregó notas, artículos, bots, tarjetas y artefactos; una máquina más antigua no entendería el mensaje. El ajuste pertenece a esta máquina y nunca se envía a las demás.

### Archivos de proyecto

Los archivos de proyecto borrados esperan en el historial de archivos. Borrarlos de forma programada es un ajuste aparte, `history.workspace_auto_erase`; está desactivado de forma predeterminada y todavía no tiene un interruptor en Ajustes. Todavía no hay una página del panel para explorar y restaurar archivos de proyecto, así que mientras tanto el historial de archivos es la única copia de un archivo que borró un bot. Cuando un proyecto se borra para siempre, su historial de archivos se borra con él.

## Qué se omite

El historial de archivos registra lo que tú o un bot dejan en la carpeta de un proyecto, salvo:

- archivos de credenciales y claves (por ejemplo `.env`, `.mcp.json`, `*.pem`, `*.key`, claves SSH), los archivos privados de sesión de un bot y los almacenes de contraseñas
- cachés y dependencias (por ejemplo `node_modules`, `.venv`, `__pycache__`, `dist`, `target`)
- bases de datos locales (`*.db`)
- archivos de más de 25 MB, porque el historial no es una segunda copia de un video o un modelo

El archivo de exclusión propio de un proyecto no oculta nada del historial.

Un propietario técnico puede clonar el historial de archivos de un proyecto desde el `repo_path` del proyecto.

## Retención

Ajustes, en Historial, muestra la línea de retención. Hoy es **para siempre**: las versiones permanecen hasta que su elemento se borra desde la papelera, y todavía no hay un control para cambiarla. Cuando lleguen otras opciones de retención, se aplicarán al historial existente a partir de ese momento.

## La línea de tamaño

El historial ocupa espacio en disco, así que Ajustes, en Historial, muestra cuánto: el número de versiones y su tamaño para notas, entradas, tarjetas y lo demás, y el tamaño del historial de archivos de proyecto. Si una parte no se puede medir en ese momento, lo dice y el total puede ser mayor.

Cuando todo el historial supera una décima parte del espacio libre que queda en la máquina, la página muestra una advertencia. Como la advertencia depende del espacio libre, llega antes en una máquina pequeña como una Raspberry Pi y se mantiene callada en un disco grande. Si la ves, libera espacio o reduce cuántos días se quedan en la papelera los elementos borrados.

## Una advertencia sobre los bots

Los bots que pueden escribir directamente en la base de datos de Crow todavía podrían cambiar este historial. Esa brecha se cierra cuando se activa el confinamiento de bots. Las páginas del Historial muestran este aviso hasta entonces.
