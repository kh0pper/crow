---
title: Render
---

# Render

Conecta Crow a Render para gestionar despliegues y monitorear el estado de los servicios a través de tu asistente de IA.

## Qué obtienes

- Ver y gestionar servicios web, sitios estáticos y bases de datos
- Activar despliegues manuales
- Monitorear el estado de los servicios y el historial reciente de despliegues
- Ver variables de entorno y la configuración de los servicios

## Configuración

### Paso 1: Inicia sesión en Render

Ve a [dashboard.render.com](https://dashboard.render.com) e inicia sesión en tu cuenta.

### Paso 2: Crear una clave de API

1. Haz clic en el avatar de tu perfil en la esquina superior derecha
2. Selecciona **Account Settings**
3. Ve a la sección [API Keys](https://dashboard.render.com/account/api-keys)
4. Haz clic en **Create API Key**
5. Ponle un nombre (ej., "Crow")
6. Copia la clave de API

### Paso 3: Agregar a Crow

Pega tu clave en **Crow's Nest** → **Ajustes** → **Integraciones**,
o en la página de **Setup** en `/setup`.

La variable de entorno es `RENDER_API_KEY`.

## Permisos requeridos

| Permiso | Por qué |
|---|---|
| Acceso con clave de API | Acceso completo a los servicios, despliegues y configuración de tu cuenta de Render |

Las claves de API de Render otorgan acceso completo a la cuenta. No hay scopes granulares — la clave puede hacer todo lo que tu cuenta puede hacer.

## Solución de problemas

### Error "401 Unauthorized"

Es posible que tu clave de API haya sido revocada o eliminada. Crea una nueva en [dashboard.render.com/account/api-keys](https://dashboard.render.com/account/api-keys).

### No se ve un servicio

Las claves de API tienen acceso a todos los servicios de tu cuenta de Render. Si falta un servicio, verifica que exista en tu dashboard de Render.

### Despliegue atascado en "In Progress"

Esto es un problema de la plataforma Render, no de Crow. Revisa los logs del despliegue en el dashboard de Render para el servicio específico.
