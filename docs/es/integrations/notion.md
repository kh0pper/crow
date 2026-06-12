---
title: Notion
---

# Notion

Conecta Crow a Notion para buscar, leer y crear páginas y bases de datos a través de tu asistente de IA.

## Qué obtienes

- Buscar en todo tu workspace de Notion
- Leer y crear páginas
- Consultar y actualizar bases de datos
- Agregar y leer comentarios en páginas

## Configuración

### Paso 1: Crear una integración interna

1. Ve a [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Haz clic en **Nueva integración**
3. Ponle un nombre (ej., "Crow") y selecciona tu workspace
4. Bajo **Tipo**, deja seleccionado **Interna**
5. Haz clic en **Guardar**
6. Copia el **secreto de integración interna** (empieza con `ntn_`)

### Paso 2: Compartir páginas con la integración

Las integraciones de Notion solo pueden acceder a las páginas que se hayan compartido explícitamente con ellas:

1. Abre una página o base de datos de Notion a la que quieras que Crow acceda
2. Haz clic en el menú **...** en la esquina superior derecha
3. Haz clic en **Conexiones** → **Conectar con** → busca y selecciona tu integración
4. Repite para cada página o base de datos

Las páginas hijas heredan la conexión, así que compartir una página de nivel superior otorga acceso a todas sus subpáginas.

### Paso 3: Agregar a Crow

Pega tu secreto de integración en **Crow's Nest** → **Ajustes** → **Integraciones**,
o en la página de **Setup** en `/setup`.

La variable de entorno es `NOTION_TOKEN`.

## Permisos requeridos

Los permisos se configuran en la página de ajustes de la integración en [notion.so/my-integrations](https://www.notion.so/my-integrations):

| Permiso | Por qué |
|---|---|
| **Leer contenido** | Buscar y leer páginas y bases de datos |
| **Actualizar contenido** | Editar páginas y entradas de bases de datos existentes |
| **Insertar contenido** | Crear nuevas páginas y entradas de bases de datos |
| **Leer comentarios** | Ver los comentarios en las páginas |
| **Insertar comentarios** | Agregar comentarios a las páginas |

## Solución de problemas

### Error "object_not_found"

La página o base de datos no se ha compartido con tu integración. Abre la página en Notion, haz clic en **...** → **Conexiones** y agrega tu integración.

### No se encuentran páginas en la búsqueda

La búsqueda de Notion solo devuelve páginas que se hayan conectado explícitamente a la integración. Comparte la página padre para otorgar acceso a todas las subpáginas.

### El token empieza con "secret_" en lugar de "ntn_"

Las integraciones más antiguas de Notion usaban el prefijo `secret_`. Ambos formatos funcionan — simplemente pega el token completo tal cual.
