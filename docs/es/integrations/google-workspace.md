---
title: Google Workspace
---

# Google Workspace

Google Workspace es uno de los complementos propios de Crow (un bundle). Le da
al asistente herramientas sobre **tu** cuenta de Google —Drive, Docs, Sheets,
Slides, Gmail, Calendar, Forms, Apps Script, BigQuery y Looker Studio— y corre en
tu computadora, iniciando sesión con tu propio cliente OAuth. Nada pasa por un
tercero.

## Qué puede hacer

| Familia | Ejemplos |
|---|---|
| Docs | leer un documento o una sección, añadir markdown, insertar en un encabezado, buscar y reemplazar, leer y responder comentarios |
| Sheets | listar, crear, leer (fórmulas incluidas), escribir, añadir, pestañas, formato numérico y visual |
| Slides | leer una presentación, crearla, añadir o reordenar diapositivas, cajas de texto e imagen, exportar |
| Drive | buscar, listar, copiar, mover, renombrar, enviar a la papelera, compartir, exportar, leer el contenido crudo de un archivo |
| Gmail | buscar y leer hilos, crear borradores de respuesta, etiquetas y filtros — el envío es opcional y solo a ti |
| Calendar | listar calendarios y eventos, crear eventos, responder a invitaciones |
| Forms | leer las preguntas de un formulario, añadirlas o editarlas en sitio, enlazar respuestas a una hoja |
| Apps Script | leer, editar y ejecutar el script de un proyecto (editar y ejecutar se rechazan mientras el tope de salida está encendido) |
| BigQuery | ejecutar SQL, sincronizar un rango de Sheets a una tabla, listar conjuntos de datos y tablas |
| Looker Studio | solo lectura: encontrar recursos y auditar cómo están compartidos |

Dos reglas viven en el servidor y no en el prompt: no existe una herramienta que
«reemplace el documento entero» (las ediciones son quirúrgicas), y la única
herramienta que envía correo está limitada a una lista que viene **vacía hasta
que tú la llenes**: todo lo demás escribe borradores.

## Configuración

### 1. Crea el inicio de sesión en Google Cloud (una vez)

1. Abre la [Consola de Google Cloud](https://console.cloud.google.com/) y elige o crea un proyecto.
2. En **APIs y servicios → Biblioteca**, habilita las APIs que vas a usar: Drive, Docs, Sheets, Slides, Gmail, Calendar, Apps Script, Forms, BigQuery, Looker Studio.
3. En **APIs y servicios → Credenciales**, elige **Crear credenciales → ID de cliente de OAuth**. Si te pide configurar primero la pantalla de consentimiento, complétala y agrega tu propia dirección en **Usuarios de prueba**.
4. Elige **App de escritorio**, créala y pulsa **Descargar JSON**. Ese archivo es tu `credentials.json`.

### 2. Ponlo donde el complemento lo va a buscar

Haz una carpeta para el inicio de sesión y deja los dos archivos ahí:

```bash
mkdir -p ~/.config/google-workspace-mcp
mv ~/Downloads/client_secret_*.json ~/.config/google-workspace-mcp/credentials.json
```

### 3. Instala el complemento

En **Crow's Nest → Extensiones**, busca **Google Workspace** e instálalo. Hay dos
campos obligatorios:

| Campo | Qué poner |
|---|---|
| `GOOGLE_CREDENTIALS_FILE` | el `credentials.json` que acabas de mover, p. ej. `~/.config/google-workspace-mcp/credentials.json` |
| `GOOGLE_TOKEN_FILE` | dónde vivirá el token de sesión, p. ej. `~/.config/google-workspace-mcp/token.json` |

Apunta los dos a `~/.config/google-workspace-mcp/`: la carpeta que contiene el
token es la única carpeta que este complemento puede escribir para su inicio de
sesión, y una ruta por defecto nunca se monta: solo se monta una que hayas
escrito tú.

### 4. Autoriza una vez, en tu propia terminal

El primer inicio de sesión ocurre fuera de Crow, en tu propia terminal, así que
el complemento nunca recibe un navegador ni una pantalla de consentimiento
propia. Desde la copia instalada:

```bash
cd ~/.crow/bundles/google-workspace
uv run google-workspace-mcp-authorize            # abre un navegador
uv run google-workspace-mcp-authorize --manual   # flujo de copiar y pegar, sin navegador
```

El comando lee `GOOGLE_CREDENTIALS_FILE` y `GOOGLE_TOKEN_FILE` del shell en el
que corre, no del formulario de Extensiones, y por defecto usa esa carpeta
(`~/.config/google-workspace-mcp/credentials.json` y
`~/.config/google-workspace-mcp/token.json`). Si elegiste otras rutas en el paso
3, corre `export GOOGLE_CREDENTIALS_FILE=… GOOGLE_TOKEN_FILE=…` en la misma
terminal antes.

Inicia sesión con tu cuenta de Google y otorga los permisos. Esto escribe
`token.json` junto a las credenciales. Es un paso único: después el servidor
renueva el token solo.

### 5. Enciéndelo

En Extensiones, activa el complemento. `uv` tiene que estar instalado en todo el
sistema —Crow se niega a instalar el complemento hasta que lo esté— y `uv` trae
su propio Python.

## Ajustes opcionales

Todos son opcionales. La primera columna es el nombre del campo en el formulario
de Extensiones.

| Ajuste | Qué hace |
|---|---|
| `GOOGLE_BIGQUERY_PROJECT` | El id del proyecto de Google Cloud que usan las herramientas de BigQuery cuando una llamada no nombra ninguno. |
| `GDOCS_DEFAULT_FONT` | Fuente del texto que insertan las herramientas de escritura de Docs (p. ej. `Arial`); vacío mantiene la fuente propia del documento. |
| `GMAIL_SEND_TO_SELF_ALLOWLIST` | Direcciones separadas por comas a las que puede escribir la única herramienta de envío; vacía (por defecto) mantiene el envío apagado y todo lo demás queda como borrador. |
| `GWS_FORMS_SHIM_SCRIPT_ID` | El id del proyecto de Apps Script para el shim de Forms (los pasos de despliegue están en `apps-script-shim/` del complemento); sin definir, la herramienta devuelve esos pasos en vez de fallar. |
| `GWS_CALENDAR_NO_INVITES` | Encendido: los eventos van solo a tu calendario `primary`, sin invitados, Google nunca recibe la orden de escribirle a nadie y responder a una invitación se rechaza. |
| `GWS_OAUTH_SCOPES` | Reduce lo que el servidor le pide a Google (p. ej. `gmail.compose,drive.file`); sin definir pide el conjunto completo. Cambiarlo exige volver a autorizar. |
| `GWS_OUTBOUND_GUARD` | Apagado salvo que se defina. Encendido: toda acción que haga que Google contacte a alguien se rechaza si su dirección no está en `GWS_OUTBOUND_ALLOWLIST` (ver abajo). |
| `GWS_OUTBOUND_ALLOWLIST` | Direcciones y dominios a los que se puede escribir, p. ej. `tu@example.com,example.org`; solo se lee mientras el tope está encendido, y vacía entonces no envía nada. |
| `GWS_FILES_DIR` | La única carpeta que pueden usar las herramientas que leen o escriben un archivo local; vacía acepta cualquier ruta salvo la carpeta de inicio de sesión y las carpetas y archivos de credenciales del operador (`~/.ssh`, `~/.gnupg`, `~/.config/gcloud`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.config/gh`, `~/.terraform.d`, y los archivos `~/.docker/config.json`, `~/.netrc`, `~/.npmrc`, `~/.pgpass`, `~/.config/containers/auth.json`) — salvo que el tope esté encendido, que entonces rechaza todo archivo local. |

## Dentro del muro del complemento

Crow puede correr el complemento dentro de su
[muro de complementos](../../architecture/addon-walls.md). Amurallado, alcanza
exactamente tres cosas:

- **internet por HTTPS** — las APIs públicas de Google y nada más. Sin
  contenedor y sin puerto en este equipo;
- **su carpeta de inicio de sesión, con lectura y escritura** — la *carpeta* que
  contiene `GOOGLE_TOKEN_FILE`. Una renovación del token escribe un archivo
  temporal y luego lo renombra, así que la carpeta misma tiene que ser escribible.
  Esa carpeta es un permiso revisado de primera parte (`ADDON_TOKEN_DIRS` en el
  propio código de Crow): una carpeta exacta, solo para este complemento;
- **la carpeta de archivos** — `GWS_FILES_DIR`, con lectura y escritura, cuando
  defines una. Sin definir, no se monta ninguna carpeta de archivos.

**La primera autorización se queda fuera del muro a propósito.** El paso de
autorización lo corres tú en tu propia terminal (paso 4 arriba), así que el
complemento nunca recibe un navegador ni una pantalla de consentimiento propia;
dentro del muro solo renueva el token que ya recibió.

### El tope de salida: qué cubre

Las acciones que hacen que *Google* le escriba a otra persona se deciden antes de
salir. Con `GWS_OUTBOUND_GUARD` encendido, cada una se rechaza si su destinatario
no está en `GWS_OUTBOUND_ALLOWLIST` — y rechazar no envía nada ni le pide nada a
Google:

- **Calendar** — los invitados de un evento y el calendario en el que se escribe,
  y responder a una invitación (que le escribe al organizador). Un `calendar_id`
  distinto de `primary` tiene sus propios dueños a los que notificar, y un id de
  calendario parece una dirección, así que se revisa como tal.
- **Drive** — compartir un recurso y una transferencia de propiedad. Darle acceso
  a alguien *es* el efecto de salida, y el correo de «compartido contigo» solo le
  suma la notificación de Google, así que el destinatario se revisa haya o no
  correo.
- **Carpetas de Drive** — aquello *dentro de lo que* cae una escritura: subir,
  copiar, mover, crear carpeta, crear acceso directo y la carpeta de destino de
  una hoja, un documento, una presentación o un formulario nuevos. No se envía
  ningún correo, pero el archivo nuevo queda legible para todo el que pueda leer
  esa carpeta, así que primero se leen sus dueños y permisos (una llamada a
  Drive) y la escritura se rechaza si alguien de esa lista no está en la lista
  blanca. Tu propia dirección siempre cuenta como permitida, y una escritura sin
  carpeta (la raíz de Mi unidad) no necesita comprobación. Una carpeta compartida
  por enlace (cualquiera con el enlace) o con un dominio entero se rechaza
  siempre —ninguna lista blanca admite eso— y una escritura se rechaza cuando no
  se puede leer con quién está compartida la carpeta.
- **Gmail** — la dirección de reenvío de un filtro.
- **Apps Script** — escribir o ejecutar el script de un proyecto se rechaza sin
  más: el código publicado puede enviar correo, compartir archivos de Drive o
  llamar a cualquier API que alcance el token, y este servidor no puede ver lo que
  hará. Leer el script sigue funcionando.

### Lo que el tope no cubre

El tope levanta un muro sobre los canales que hacen que Google contacte a alguien
o que dejan un archivo donde otra persona puede leerlo. No es una caja de arena
de la cuenta. En concreto **no** cubre:

- **ediciones y comentarios en archivos de otras personas** — el archivo de un
  colaborador se puede cambiar, o comentar, sin ninguna llamada del tipo de
  arriba;
- **quién podrá leer la carpeta después** — el destino se revisa en el momento de
  la escritura; quien reciba acceso a esa carpeta más tarde (incluido un miembro
  añadido después a su unidad compartida) podrá leer lo que quedó allí.

Si eso importa en una cuenta, reduce lo que la cuenta puede hacer con
`GWS_OAUTH_SCOPES` en vez de confiar solo en el tope.

## Mover una instalación existente

Una instalación hecha antes de que existiera este bundle sigue lanzando el
servidor viejo `uvx --from git+…`, y su carpeta es poco más que un resto. Hay un
script de migración que la pasa al bundle. Córrelo desde el checkout del propio
gateway. Detén el gateway primero (recomendado): el script no lo comprueba, pero
un gateway en marcha podría reescribir los mismos archivos.

```bash
node scripts/addon-sandbox/migrate-gws-firstparty.mjs --dry-run   # imprime el plan, no cambia nada
node scripts/addon-sandbox/migrate-gws-firstparty.mjs             # hazlo
```

- Se niega si el checkout del que copia no es el del propio gateway: un checkout
  real, en `main` y con `bundles/google-workspace` limpio. `--repo-root <path>`
  nombra otro checkout que pasa las mismas tres comprobaciones, así que la
  carpeta del script puede ser un worktree.
- Se niega si la entrada existente del complemento no lleva ya un valor para
  `GOOGLE_CREDENTIALS_FILE` y para `GOOGLE_TOKEN_FILE` (ponlos primero en
  Extensiones); con uno sin definir se niega y no cambia nada.
- Primero respalda todo, en
  `<CROW_HOME>/addon-walls-migrate/google-workspace-<stamp>/`, copia la carpeta
  vieja a un lado como
  `<CROW_HOME>/bundles/google-workspace.pre-firstparty-<stamp>` y después copia el
  bundle del repo a `<CROW_HOME>/bundles/google-workspace` igual que lo hace una
  instalación. No enciende ningún tope ni añade ajustes propios.
- `--dry-run` imprime lo que respaldaría, copiaría y escribiría, y no cambia nada.
- Códigos de salida: `0` hecho — migrado, ya migrado o un dry-run impreso; `1`
  rechazado o fallido, con el home de Crow tal como estaba; `2` uso incorrecto;
  `3` un undo rechazado porque el home cambió desde la migración.
- El primer arranque después crea el entorno virtual, lo que tarda un minuto.
  Para prepararlo tú antes, corre `uv sync --frozen` en la carpeta instalada con
  el mismo entorno que lleva la entrada migrada:
  ```bash
  cd ~/.crow/bundles/google-workspace
  UV_PROJECT_ENVIRONMENT=~/.crow/data/google-workspace/.venv uv sync --frozen
  ```
  Las dos rutas son las de por defecto: `CROW_HOME` y `CROW_DATA_DIR` las mueven,
  y la carpeta de datos es `<CROW_DATA_DIR>/google-workspace`, que por defecto es
  `<CROW_HOME>/data/google-workspace`.
- Para volver atrás: `node scripts/addon-sandbox/migrate-gws-firstparty.mjs --undo`
  (la copia más nueva) o `--undo <stamp>`. Devuelve la entrada, la carpeta vieja e
  `installed.json` byte por byte, y se niega con código `3` cuando el home cambió
  desde la migración; `--force` restaura igual, de forma quirúrgica. Un respaldo
  ya usado se renombra, nunca se borra.
- **Nunca corras `migrate-linked --undo google-workspace`.** La migración
  renombra los respaldos viejos de `migrate-linked` a
  `*.superseded-by-firstparty.json` justamente para que ese undo no devuelva un
  enlace simbólico al checkout versionado. Usa el `--undo` de arriba.

## Solución de problemas

### «Acceso bloqueado: la solicitud de esta app no es válida»

Probablemente tu pantalla de consentimiento de OAuth no tiene tu dirección de
Google como usuario de prueba. Agrégala en **APIs y servicios → Pantalla de
consentimiento de OAuth → Usuarios de prueba**.

### «uv: command not found»

Instala `uv` en todo el sistema primero y luego abre una terminal nueva.

### El flujo de autorización no se completa

Asegúrate de que el cliente OAuth sea de tipo **App de escritorio**, no
**Aplicación web**. Las apps de escritorio usan una redirección local para el
callback.

### «not authenticated» después de cambiar `GWS_OAUTH_SCOPES`

El token que está en disco conserva el permiso con el que se emitió. Revoca el
acceso de la app en tu cuenta de Google y corre el paso de autorización de nuevo.