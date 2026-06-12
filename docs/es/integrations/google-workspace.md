---
title: Google Workspace
---

# Google Workspace

Conecta Crow a Google Workspace para acceder a Gmail, Google Calendar, Docs, Sheets y Slides a través de tu asistente de IA.

## Qué obtienes

- Leer y buscar mensajes de Gmail
- Ver y crear eventos de Google Calendar
- Acceder a Google Docs, Sheets y Slides
- Buscar en todo tu Google Drive
- Enviar y leer mensajes de Google Chat

## Requisitos previos

Esta integración requiere **uvx** (ejecutor de paquetes de Python). Instálalo con:

```bash
# macOS
brew install uv

# Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

## Configuración

### Paso 1: Crear un proyecto de Google Cloud

1. Ve a la [Consola de Google Cloud](https://console.cloud.google.com/)
2. Haz clic en el menú desplegable de proyectos en la parte superior y selecciona **Nuevo proyecto**
3. Ponle un nombre (ej., "Crow") y haz clic en **Crear**
4. Selecciona tu nuevo proyecto desde el menú desplegable de proyectos

### Paso 2: Habilitar las APIs

1. Ve a **APIs y servicios** → **Biblioteca**
2. Busca y habilita cada API que quieras usar:
   - **Gmail API**
   - **Google Calendar API**
   - **Google Docs API**
   - **Google Sheets API**
   - **Google Slides API**
   - **Google Drive API**
   - **Google Chat API** (opcional)

### Paso 3: Crear credenciales de OAuth

1. Ve a **APIs y servicios** → **Credenciales**
2. Haz clic en **Crear credenciales** → **ID de cliente de OAuth**
3. Si se te solicita, configura primero la **Pantalla de consentimiento de OAuth**:
   - Elige **Externo** (o Interno si usas Google Workspace)
   - Completa el nombre de la app y tu correo electrónico
   - Agrega tu correo en **Usuarios de prueba**
   - Haz clic en **Guardar y continuar** en los pasos restantes
4. De vuelta en **Credenciales**, haz clic en **Crear credenciales** → **ID de cliente de OAuth**
5. Selecciona **App de escritorio** como tipo de aplicación
6. Ponle un nombre (ej., "Crow Desktop")
7. Haz clic en **Crear**
8. Copia el **ID de cliente** y el **Secreto de cliente**

### Paso 4: Agregar a Crow

Pega ambos valores en **Crow's Nest** → **Ajustes** → **Integraciones**,
o en la página de **Setup** en `/setup`.

Las variables de entorno son `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.

En el primer uso, se abrirá una ventana del navegador para autorizar la app. Inicia sesión con tu cuenta de Google y otorga los permisos solicitados.

## Permisos requeridos

Los scopes se solicitan durante el flujo de autorización de OAuth:

| Scope | Por qué |
|---|---|
| `gmail.readonly` | Leer y buscar mensajes de correo |
| `calendar.events` | Leer y crear eventos de calendario |
| `drive.readonly` | Buscar y leer archivos en Drive |
| `documents` | Leer Google Docs |
| `spreadsheets` | Leer Google Sheets |
| `presentations` | Leer Google Slides |

## Solución de problemas

### "Acceso bloqueado: la solicitud de esta app no es válida"

Es posible que tu pantalla de consentimiento de OAuth no tenga tu correo en la lista de usuarios de prueba. Ve a **APIs y servicios** → **Pantalla de consentimiento de OAuth** → **Usuarios de prueba** y agrega el correo de tu cuenta de Google.

### "uvx: command not found"

Instala uv primero (ver Requisitos previos arriba) y luego reinicia tu terminal.

### El flujo de autorización no se completa

Asegúrate de haber seleccionado **App de escritorio** (no Aplicación web) como tipo de cliente OAuth. Las apps de escritorio usan una redirección local para el callback de autorización.
