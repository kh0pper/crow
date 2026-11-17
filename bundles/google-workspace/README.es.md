# Google Workspace

Un servidor MCP de stdio que le da al asistente herramientas sobre **tu propia**
cuenta de Google Workspace: Docs, Sheets, Slides, Drive, Gmail, Calendar, Apps
Script, Forms, BigQuery y Looker Studio. Corre en este equipo como un proyecto
`uv` desde la copia instalada —sin contenedor y sin puerto— y se identifica con
tu propio cliente OAuth, así que nada pasa por un tercero.

El código procede del proyecto upstream MIT del mismo nombre, incluido desde
él (ver `LICENSE`): `google_workspace_mcp/` es el servidor, `apps-script-shim/`
es un ayudante opcional de Apps Script para una herramienta de Forms, y `tests/`
tiene las pruebas unitarias de Python (`python3 -m unittest discover -s tests`).
En la copia de Crow solo cambia el empaquetado —estos README están reescritos
para Crow y las fixtures de las pruebas están limpiadas de datos personales— y
una serie pequeña de arreglos propios: conversión nativa a Docs/Sheets/Slides al
subir, enlaces markdown que salen como hipervínculos reales (también dentro de
celdas de tabla, y solo para http/https/mailto — cualquier otro esquema queda
como texto), ediciones de Docs que entienden las tablas, un reemplazo de
sección que puede terminar en tabla, y los topes de invitaciones y correo de
abajo.

## Qué puede hacer

| Familia | Ejemplos |
|---|---|
| Docs | leer un documento o una sección, agregar markdown, insertar en un encabezado, buscar y reemplazar, leer y responder comentarios |
| Sheets | listar y crear, leer (incluidas fórmulas), escribir y agregar, pestañas, formato numérico y visual |
| Slides | leer una presentación, crearla, agregar u ordenar diapositivas, cuadros de texto e imágenes, exportar |
| Drive | buscar, listar, copiar, mover, renombrar, enviar a la papelera, compartir, exportar, leer contenido sin formato |
| Gmail | buscar y leer hilos, redactar respuestas, etiquetas y filtros — enviar es opcional y solo a ti |
| Calendar | listar calendarios y eventos, crear eventos, responder invitaciones |
| Apps Script | leer, editar y ejecutar el código de un proyecto (editar/ejecutar se rechaza mientras `GWS_OUTBOUND_GUARD` está encendido) |
| Forms | leer la estructura de un formulario, agregar o editar preguntas en el lugar; enlazar respuestas a una hoja con el shim |
| BigQuery | ejecutar SQL, sincronizar un rango de una Hoja a una tabla, listar conjuntos y tablas |
| Looker Studio | solo lectura: buscar activos y auditar cómo están compartidos |

Las protecciones están en el servidor, no en el prompt: no existe una
herramienta de «reemplazar el documento entero» (las ediciones son quirúrgicas)
y la única herramienta que envía correo está limitada a una lista blanca que
está **vacía por defecto**: todo lo demás crea borradores. Las acciones que hacen
que *Google* le escriba a otra persona también tienen tope; ver «Qué sale de la
cuenta» más abajo.

## Instalación

1. **En Google Cloud** (una vez): crea o elige un proyecto, habilita las APIs que
   vas a usar (Drive, Docs, Sheets, Slides, Gmail, Calendar, Apps Script, Forms,
   BigQuery, Looker Studio) y crea un **Credentials → OAuth client ID** de tipo
   **Desktop app**; descarga su JSON.
2. **Guarda el JSON** en `~/.config/google-workspace-mcp/credentials.json` (o
   donde quieras: las dos rutas de abajo lo señalan).
3. **Autoriza una vez**, desde la copia instalada:

   ```bash
   cd ~/.crow/bundles/google-workspace
   uv run google-workspace-mcp-authorize            # abre el navegador
   uv run google-workspace-mcp-authorize --manual   # sin navegador: enlace para copiar y pegar
   ```

   Esto escribe `token.json` junto a las credenciales. Es un paso único: después
   el servidor renueva el token solo.
4. **Instala el complemento** desde la página Extensiones de Crow y completa los
   dos campos: `GOOGLE_CREDENTIALS_FILE` (el JSON del cliente OAuth) y
   `GOOGLE_TOKEN_FILE` (el token que escribió la autorización).

Los dos son obligatorios y ninguno tiene valor por defecto, a propósito (ver la
sección del muro). Opcionales: `GMAIL_SEND_TO_SELF_ALLOWLIST` (separada por
comas; vacía mantiene el envío apagado), `GOOGLE_BIGQUERY_PROJECT`,
`GDOCS_DEFAULT_FONT`, `GWS_FORMS_SHIM_SCRIPT_ID`, `GWS_OAUTH_SCOPES`,
`GWS_CALENDAR_NO_INVITES`, `GWS_OUTBOUND_GUARD`, `GWS_OUTBOUND_ALLOWLIST`.

## Qué sale de la cuenta

Cuatro canales pueden hacer que Google le entregue algo a una dirección que
eligió el asistente y no tú, o correr código que puede hacerlo. Dos ajustes
deciden qué puede pasar:

- **Calendar** — los invitados de un evento, y responder a una invitación (que
  le escribe al organizador);
- **Drive** — compartir un recurso, y una transferencia de propiedad. Darle
  acceso a alguien *es* el efecto de salida; el correo de «compartido contigo»
  (`notify=true`) solo le suma la notificación de Google, así que con el tope
  encendido el destinatario se revisa haya o no correo;
- **Gmail** — la dirección de reenvío de un filtro;
- **Apps Script** — `apps_script_update_file`, `apps_script_update_content` y
  `apps_script_run`. El código publicado puede enviar correo (`MailApp`,
  `GmailApp`), compartir archivos de Drive o llamar a cualquier API que alcance
  el token, y este servidor no puede inspeccionar lo que hará. Con el tope
  encendido esas tres herramientas se rechazan, y también un `shim_script_id`
  distinto del configurado en `GWS_FORMS_SHIM_SCRIPT_ID` para
  `forms_set_destination`. `apps_script_get_content` (solo lectura) sigue
  funcionando.

| Ajuste | Por defecto | Efecto |
|---|---|---|
| `GWS_CALENDAR_NO_INVITES` | apagado | Los eventos van solo al calendario `primary`: cualquier otro `calendar_id` se rechaza (otro calendario tiene su propio dueño al que notificar), los invitados se rechazan, Google nunca recibe la orden de escribirle a nadie y responder a una invitación se rechaza. |
| `GWS_OUTBOUND_GUARD` | **apagado** | Encendido, todo canal de arriba cuyo destinatario no esté en `GWS_OUTBOUND_ALLOWLIST` se rechaza y no se hace ninguna llamada a Google. Las herramientas de escritura/ejecución de Apps Script se rechazan sin importar la dirección. |
| `GWS_OUTBOUND_ALLOWLIST` | vacía | Direcciones y dominios a los que se puede escribir, p. ej. `tu@example.com,example.org` (un dominio cubre exactamente ese dominio, sin subdominios). En el formulario de Extensiones las entradas se separan con comas; un punto y coma o un espacio también sirve si pones la variable fuera de él. Solo se lee mientras el tope está encendido; vacía entonces significa que no se puede enviar nada. |

Un destinatario tiene que ser **una** dirección bien formada: un único `@`, solo
ASCII, sin espacios y sin ninguno de `, ; < > " ' ( )`. Un valor que en realidad
son dos direcciones (`x@evil.com,y@example.com`), una forma con nombre visible
(`Nombre <x@example.com>`) o con dos `@` se rechaza antes de mirar la lista: la
mitad que sí estuviera permitida no lo salva.

El tope viene **apagado** para que una instalación existente siga igual que
antes; está pensado para un asistente que además lee correo que no controlas,
donde un mensaje preparado podría convencerlo de invitar o reenviar a un
desconocido. Encenderlo exige llenar la lista (si no, no se puede enviar nada).

### Lo que el tope no cubre

Levanta un muro sobre los canales que *hacen que Google contacte a alguien*; no
es una caja de arena de la cuenta. En concreto **no** cubre:

- **mover o copiar un archivo a una carpeta que otra persona compartió contigo**
  — tu contenido queda donde esa persona puede leerlo, y para eso no hace falta
  ninguna notificación;
- **ediciones y comentarios en archivos de otras personas** — el archivo de un
  colaborador se puede cambiar, o comentar, sin ninguna llamada del tipo de
  arriba.

Si eso importa en una cuenta, reduce lo que la cuenta puede hacer con
`GWS_OAUTH_SCOPES` (abajo) en vez de confiar solo en el tope.

`GWS_OAUTH_SCOPES` reduce lo que el servidor le pide a Google: sin valor se piden
todos los permisos, y con valor (p. ej. `gmail.readonly,gmail.compose,calendar.events`)
se piden solo esos — vale la pena para una cuenta con la que un asistente no
debería poder borrar cosas. Cada nombre se comprueba contra los permisos que este
servidor conoce (un nombre corto como `gmail.compose`, o la URL completa
`https://www.googleapis.com/auth/gmail.compose`); un nombre desconocido es un
error de arranque que nombra la entrada mala, en vez de un permiso que se cuela en
la renovación y falla después como un confuso «not authenticated». La reducción
se aplica en la **siguiente renovación del token** (y en el paso de autorización):
el refresh token que ya está en disco conserva la concesión completa con la que se
emitió, así que quitar un permiso aquí no se lo quita a la concesión de Google
—para eso revoca el acceso de la aplicación en tu cuenta de Google y vuelve a
autorizar.

## Dentro del muro de complementos de Crow

El manifiesto declara `"sandbox": { "network": "internet", "files": {
"oauthDir": "env:GOOGLE_TOKEN_FILE" } }`:

- **red `internet`** — HTTPS hacia las APIs públicas de Google y nada más, sin
  contenedor y sin puerto en el equipo;
- **un solo permiso de carpeta** — la *carpeta* que contiene `GOOGLE_TOKEN_FILE`,
  con lectura y escritura. Una renovación de OAuth escribe un archivo temporal y
  lo renombra, así que el servidor necesita escribir en su propia carpeta. Esa
  carpeta es el permiso revisado de primera parte de Crow (`ADDON_TOKEN_DIRS` en
  `servers/shared/addon-doors.js`) y aplica solo a este complemento.

Mantén `credentials.json` en la misma carpeta que el token para que el servidor
pueda leerlo, y apunta las dos rutas a `~/.config/google-workspace-mcp/` en vez
de a tu carpeta personal: una ruta por defecto nunca se monta, solo una que
hayas escrito tú.

## Requisitos

`uv` instalado para todo el sistema, de modo que sea propiedad de root (por
ejemplo `/usr/local/bin/uv`); Crow no instala el complemento hasta que lo sea.
`uv` trae su propio Python.

## Licencia

MIT — ver `LICENSE` para el aviso de copyright del proyecto upstream incluido.