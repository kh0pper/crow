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
sección que puede terminar en tabla, y los topes de invitaciones, correo y
carpetas de abajo.

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
sección del muro). Opcionales: `GWS_FILES_DIR` (la carpeta que pueden usar las
herramientas que leen o escriben un archivo local — ver «Archivos locales»),
`GMAIL_SEND_TO_SELF_ALLOWLIST` (separada por comas; vacía mantiene el envío
apagado), `GOOGLE_BIGQUERY_PROJECT`, `GDOCS_DEFAULT_FONT`,
`GWS_FORMS_SHIM_SCRIPT_ID`, `GWS_OAUTH_SCOPES`, `GWS_CALENDAR_NO_INVITES`,
`GWS_OUTBOUND_GUARD`, `GWS_OUTBOUND_ALLOWLIST`.

## Qué sale de la cuenta

Cinco canales pueden hacer que Google le entregue algo a una dirección que eligió
el asistente y no tú, dejar tu contenido donde otra persona puede leerlo, o
correr código que puede hacerlo. Dos ajustes deciden qué puede pasar:

- **Calendar** — los invitados de un evento y el calendario en el que se escribe,
  y responder a una invitación (que le escribe al organizador). Un `calendar_id`
  distinto de `primary` tiene sus propios dueños a los que notificar —un id de
  calendario parece una dirección (`team@group.example.net`)—, así que se revisa
  como tal;
- **Drive** — compartir un recurso, y una transferencia de propiedad. Darle
  acceso a alguien *es* el efecto de salida; el correo de «compartido contigo»
  (`notify=true`) solo le suma la notificación de Google, así que con el tope
  encendido el destinatario se revisa haya o no correo;
- **Carpetas de Drive** — aquello *dentro de lo que* cae una escritura:
  `gdrive_upload_file`, `gdrive_copy_file`, `gdrive_move_file`,
  `gdrive_create_folder`, `gdrive_create_shortcut` y el `folder_id` de
  `sheets_create`, `gdocs_create`, `gslides_create` y `forms_create`. No se envía
  ningún correo, pero el archivo nuevo queda legible para todo el que pueda leer
  esa carpeta. Con el tope encendido se leen primero los dueños y permisos de la
  carpeta de destino (una llamada a Drive) y la escritura se rechaza si alguien de
  esa lista no está en la lista blanca, si la carpeta tiene un permiso «cualquiera
  con el enlace» o de dominio entero, o si esa comprobación no se puede hacer.
  Tu propia dirección siempre cuenta como permitida, y una escritura sin carpeta
  (la raíz de Mi unidad) no necesita comprobación;
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
| `GWS_OUTBOUND_GUARD` | **apagado** | Encendido, todo canal de arriba cuyo destinatario no esté en `GWS_OUTBOUND_ALLOWLIST` se rechaza —y, en una escritura en carpeta, si algún dueño o alguien con quien está compartida la carpeta de destino no lo está— y no se hace ninguna llamada a Google. `gdocs_insert_image` con una imagen **local** se rechaza; con una imagen alojada en Drive, esta tiene que estar ya compartida como «cualquiera con el enlace» (con el tope encendido este servidor nunca añade un permiso `anyone`/`domain`); y las herramientas de escritura/ejecución de Apps Script se rechazan sin importar la dirección. |
| `GWS_OUTBOUND_ALLOWLIST` | vacía | Direcciones y dominios a los que se puede escribir, p. ej. `tu@example.com,example.org` (un dominio cubre exactamente ese dominio, sin subdominios). En el formulario de Extensiones las entradas se separan con comas; un punto y coma o un espacio también sirve si pones la variable fuera de él. Solo se lee mientras el tope está encendido; vacía entonces significa que no se puede enviar nada (y solo se puede escribir en carpetas tuyas). |

Un destinatario tiene que ser **una** dirección bien formada: un único `@`, solo
ASCII, sin espacios y sin ninguno de `, ; < > " ' ( )`. Un valor que en realidad
son dos direcciones (`x@evil.com,y@example.com`), una forma con nombre visible
(`Nombre <x@example.com>`) o con dos `@` se rechaza antes de mirar la lista: la
mitad que sí estuviera permitida no lo salva.

Una carpeta es la misma pregunta sobre una lista entera: solo se escribe en ella
si todos sus dueños y todos con quienes está compartida están en la lista blanca,
y se rechaza sin más cuando tiene un permiso `anyone` (cualquiera con el enlace)
o `domain` (un dominio entero de Workspace). Tu propia dirección siempre vale
—una carpeta tuya está compartida contigo— y se averigua una vez con el endpoint
de cuenta de Drive y queda recordada mientras viva el proceso del servidor (así
que un cambio de cuenta solo se nota tras reiniciarlo); cuando esa consulta no
responde, solo la lista blanca deja pasar una carpeta. Una carpeta cuya forma de
compartir no se puede leer se rechaza en vez de darla por segura, y también una
que no declara ningún dueño. En ninguno de estos casos se escribe nada, y el
rechazo nombra la carpeta y lo que tiene de malo.

Una carpeta en una **unidad compartida** se juzga por los permisos *efectivos* de
la unidad — `permissions().list`, que incluye los miembros que la carpeta hereda
de ella, porque allí un elemento no tiene dueño propio y su lista de permisos no
los menciona — con la misma regla, y se rechaza si esa consulta falla o vuelve
vacía. Un archivo cuyo contenido se reemplaza en sitio
(`gdrive_upload_new_version`) recibe la misma comprobación sobre cómo está
compartido él mismo, porque el contenido nuevo queda legible para quien ya podía
leer ese archivo.

`gdocs_insert_image` es la única herramienta que *hacía* público un archivo justo
el tiempo necesario para funcionar: la API de Docs solo descarga una imagen que
pueda leer de forma anónima, así que el insertado compartía el archivo como
«cualquiera con el enlace» y después lo descompartía. Los permisos `anyone` (y
`domain`) ahora se crean **solo con el tope apagado**. Con el tope encendido, una
imagen **local** se rechaza sin más (habría que publicarla para poder subirla y
incrustarla), y una imagen alojada en Drive se incrusta solo si **ya** está
compartida como «cualquiera con el enlace»: súbela tú, compártela exactamente como
quieras y pasa su id de archivo. Una imagen que no está compartida así (o cuya
forma de compartir no se puede leer) se rechaza sin insertar nada y sin cambiar
nada: con el tope encendido, las imágenes ya tienen que estar compartidas para
poder incrustarlas; Crow no hará público un archivo. En todos los modos el permiso
temporal se revoca por el id exacto que devolvió Drive al crearlo, y una revocación
que falla se informa como un **fallo** que nombra el archivo que sigue siendo
público — nunca como un éxito.

El tope viene **apagado** para que una instalación existente siga igual que
antes; está pensado para un asistente que además lee correo que no controlas,
donde un mensaje preparado podría convencerlo de invitar o reenviar a un
desconocido. Encenderlo exige llenar la lista (si no, no se puede enviar nada y
solo se puede escribir en carpetas tuyas).

### Lo que el tope no cubre

Levanta un muro sobre los canales que *hacen que Google contacte a alguien* o que
*dejan un archivo donde otra persona puede leerlo*; no es una caja de arena de la
cuenta. En concreto **no** cubre:

- **ediciones y comentarios en archivos de otras personas** — el archivo de un
  colaborador se puede cambiar, o comentar, sin ninguna llamada del tipo de
  arriba;
- **quién podrá leer la carpeta después** — el destino se revisa en el momento
  de la escritura; quien reciba acceso a esa carpeta más tarde —incluido un
  miembro añadido después a su unidad compartida— podrá leer lo que quedó allí.

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

## Archivos locales: la carpeta de archivos

Seis herramientas reciben una **ruta local**: `gdrive_upload_file` y
`gdrive_upload_new_version` (leer un archivo para subirlo), `gdrive_download_file`,
`gdrive_export` y `gslides_export` (escribir un archivo), y `gdocs_insert_image`
cuando `image` es un archivo local y no un id de Drive. Una ruta que llega de
quien llama es una capacidad —a un asistente que además lee correo no confiable
se le puede convencer de subir `~/.config/google-workspace-mcp/token.json` a
Drive y compartirlo—, así que se decide en un solo sitio (`local_paths.py`) y en
ningún otro.

**`GWS_FILES_DIR`** es la única carpeta tuya que esas herramientas pueden usar:

- si la defines, toda ruta tiene que quedar **estrictamente dentro** de ella
  tras resolver los enlaces simbólicos; una ruta relativa lo es respecto a ella y
  un `~` inicial es tu carpeta personal. `..`, una ruta absoluta en otro sitio y un
  enlace simbólico que apunte fuera se rechazan;
- si la dejas vacía, decide el tope de salida: con `GWS_OUTBOUND_GUARD` encendido
  se rechaza **toda** ruta local («define una carpeta de archivos»). Con el tope
  apagado, una instalación actualizada puede seguir usando cualquier ruta que
  reciba fuera de las carpetas que siempre se rechazan —así que nada de lo que
  funcionaba deja de funcionar—, pero «apagado» solo quita la exigencia de
  carpeta, no el manejo de archivos. Incluso con el tope apagado: una descarga o
  exportación nunca sobrescribe un archivo que ya existe (y el nombre por defecto
  es único, así que exportar dos veces crea dos archivos), una carpeta contenedora
  que falta se rechaza, un archivo que no es regular (carpeta, dispositivo,
  tubería) se rechaza al leer, los primeros bytes de una imagen local tienen que
  ser de verdad PNG/JPEG/GIF/WebP, y la carpeta de inicio de sesión, `~/.ssh`,
  `~/.gnupg` y `~/.config/gcloud` se rechazan siempre;
- las descargas y exportaciones se **crean**, nunca se sobrescriben: un destino
  que ya existe, o que es un enlace simbólico, se rechaza (da otro nombre); los
  archivos se crean con modo 0600. El nombre por defecto se arma con el id de
  Google sustituyendo todo carácter fuera de `[A-Za-z0-9._-]` (así que un id nunca
  puede colar un separador de ruta) más una marca de tiempo UTC, de modo que
  exportar otra vez sin ruta crea un archivo nuevo. La ubicación por defecto es la
  carpeta de archivos cuando existe, y `/tmp` solo para una instalación sin
  carpeta y sin tope;
- una imagen local para `gdocs_insert_image` tiene que ser de verdad PNG, JPEG,
GIF o WebP (se revisan sus primeros bytes), no un archivo con nombre de imagen.

**Siempre rechazado, digas lo que digas** —con tope o sin él, con carpeta o sin
ella—: cualquier cosa dentro de la **carpeta de inicio de sesión de Google** (las
carpetas que contienen `GOOGLE_TOKEN_FILE` y `GOOGLE_CREDENTIALS_FILE`, y
cualquier hermana `~/.config/google-workspace-mcp*`), el propio token y las
credenciales, `~/.ssh`, `~/.gnupg` y `~/.config/gcloud` (las credenciales del CLI
de Google Cloud: `application_default_credentials.json`, `credentials.db`,
`access_tokens.db`, `legacy_credentials/`). La comparación es sobre la ruta real, así que
un enlace simbólico que apunte ahí también se rechaza, y si esas carpetas no se
pueden resolver no se permite nada local (falla cerrado). Una llamada rechazada
no hace ninguna petición a Google: la ruta se decide antes de crear cualquier
cliente.

## Dentro del muro de complementos de Crow

El manifiesto declara `"sandbox": { "network": "internet", "files": {
"write": ["env:GWS_FILES_DIR"], "oauthDir": "env:GOOGLE_TOKEN_FILE" } }`:

- **red `internet`** — HTTPS hacia las APIs públicas de Google y nada más, sin
  contenedor y sin puerto en el equipo;
- **un solo permiso de carpeta** — la *carpeta* que contiene `GOOGLE_TOKEN_FILE`,
  con lectura y escritura. Una renovación de OAuth escribe un archivo temporal y
  lo renombra, así que el servidor necesita escribir en su propia carpeta. Esa
  carpeta es el permiso revisado de primera parte de Crow (`ADDON_TOKEN_DIRS` en
  `servers/shared/addon-doors.js`) y aplica solo a este complemento;
- **la carpeta de archivos** — `GWS_FILES_DIR`, si la defines, también se monta
  con lectura y escritura, para leer de ella lo que se sube y escribir en ella
  descargas y exportaciones. Sin definir no se monta ninguna: con el tope apagado
  las herramientas de ruta local siguen aceptando cualquier ruta que reciban fuera
  de las carpetas que siempre se rechazan (como antes de la 1.2.0), aunque siguen
  sin sobrescribir un archivo, siguen rechazando una carpeta contenedora que falta
  o un archivo no regular al leer, y siguen revisando la magia de las imágenes;
  con el tope encendido se rechaza toda ruta local.

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