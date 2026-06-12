---
title: Microsoft Teams
---

# Microsoft Teams

Conecta Crow a Microsoft Teams para leer y enviar mensajes en tus canales y chats de Teams a través de tu asistente de IA.

::: warning Experimental
Esta integración es experimental. Tu organización puede requerir el registro de una app en Azure AD y el consentimiento de un administrador.
:::

## Qué obtienes

- Leer mensajes de canales y chats de Teams
- Enviar mensajes a canales
- Listar equipos y canales
- Explorar hilos de mensajes

## Configuración

### Paso 1: Registrar una aplicación de Azure AD

1. Ve al [Portal de Azure — Registros de aplicaciones](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. Haz clic en **Nuevo registro**
3. Ponle un nombre (ej., "Crow")
4. En **Tipos de cuenta admitidos**, selecciona **Inquilino único** (solo tu organización)
5. Deja el **URI de redirección** en blanco por ahora
6. Haz clic en **Registrar**
7. En la página de información general de la app, copia el **Id. de aplicación (cliente)** y el **Id. de directorio (inquilino)**

### Paso 2: Crear un secreto de cliente

1. En el registro de tu app, ve a **Certificados y secretos**
2. Haz clic en **Nuevo secreto de cliente**
3. Agrega una descripción (ej., "Crow MCP") y elige una fecha de expiración
4. Haz clic en **Agregar**
5. Copia el **Valor** de inmediato — Azure solo lo muestra una vez

### Paso 3: Agregar permisos de API

1. Ve a **Permisos de API** en la barra lateral izquierda
2. Haz clic en **Agregar un permiso** → **Microsoft Graph**
3. Selecciona **Permisos de aplicación**
4. Busca y agrega cada permiso listado en **Permisos requeridos** más abajo
5. Haz clic en **Conceder consentimiento de administrador para [tu organización]** (requiere rol de administrador)

### Paso 4: Agregar a Crow

Pega los tres valores en **Crow's Nest** → **Ajustes** → **Integraciones**,
o en la página de **Setup** en `/setup`.

Las variables de entorno son `TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET` y `TEAMS_TENANT_ID`.

## Permisos requeridos

| Permiso | Tipo | Por qué |
|---|---|---|
| `Chat.Read` | Aplicación | Leer mensajes de chat |
| `ChannelMessage.Read.All` | Aplicación | Leer mensajes en todos los canales |
| `ChannelMessage.Send` | Aplicación | Enviar mensajes a canales |
| `Team.ReadBasic.All` | Aplicación | Listar equipos |
| `Channel.ReadBasic.All` | Aplicación | Listar canales dentro de los equipos |

## Solución de problemas

### Error "Privilegios insuficientes"

Un administrador de Azure AD debe hacer clic en **Conceder consentimiento de administrador** en la página de permisos de API. Sin el consentimiento de administrador, la app no puede usar permisos a nivel de aplicación.

### "AADSTS700016: Application not found"

Verifica que tu `TEAMS_CLIENT_ID` y `TEAMS_TENANT_ID` sean correctos. El ID de cliente es el **Id. de aplicación (cliente)** de la página de información general de la app, no el Id. de objeto.

### Secreto de cliente expirado

Los secretos de cliente de Azure tienen una vida útil máxima (normalmente 24 meses). Crea un nuevo secreto en **Certificados y secretos** y actualízalo en Crow.
