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
En la copia de Crow solo cambia el empaquetado: estos README están reescritos
para Crow y las fixtures de las pruebas están limpiadas de datos personales.

## Qué puede hacer

| Familia | Ejemplos |
|---|---|
| Docs | leer un documento o una sección, agregar markdown, insertar en un encabezado, buscar y reemplazar, leer y responder comentarios |
| Sheets | listar y crear, leer (incluidas fórmulas), escribir y agregar, pestañas, formato numérico y visual |
| Slides | leer una presentación, crearla, agregar u ordenar diapositivas, cuadros de texto e imágenes, exportar |
| Drive | buscar, listar, copiar, mover, renombrar, enviar a la papelera, compartir, exportar, leer contenido sin formato |
| Gmail | buscar y leer hilos, redactar respuestas, etiquetas y filtros — enviar es opcional y solo a ti |
| Calendar | listar calendarios y eventos, crear eventos, responder invitaciones |
| Apps Script | leer, editar y ejecutar el código de un proyecto |
| Forms | leer la estructura de un formulario, agregar o editar preguntas en el lugar; enlazar respuestas a una hoja con el shim |
| BigQuery | ejecutar SQL, sincronizar un rango de una Hoja a una tabla, listar conjuntos y tablas |
| Looker Studio | solo lectura: buscar activos y auditar cómo están compartidos |

Las protecciones están en el servidor, no en el prompt: no existe una
herramienta de «reemplazar el documento entero» (las ediciones son quirúrgicas)
y la única herramienta que envía correo está limitada a una lista blanca que
está **vacía por defecto**: todo lo demás crea borradores.

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
`GDOCS_DEFAULT_FONT`, `GWS_FORMS_SHIM_SCRIPT_ID`.

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