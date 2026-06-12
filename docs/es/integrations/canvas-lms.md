---
title: Canvas LMS
---

# Canvas LMS

Conecta Crow a Canvas LMS para acceder a cursos, tareas, calificaciones y entregas a través de tu asistente de IA.

## Qué obtienes

- Explorar cursos y su contenido
- Ver tareas, fechas de entrega y rúbricas
- Consultar calificaciones y el estado de las entregas
- Acceder a anuncios y discusiones de los cursos

## Configuración

### Paso 1: Encontrar la URL de tu instancia de Canvas

Tu URL base de Canvas es el dominio que usas para acceder a Canvas, por ejemplo:
- `https://canvas.instructure.com`
- `https://myschool.instructure.com`
- `https://canvas.myuniversity.edu`

### Paso 2: Generar un token de acceso

1. Inicia sesión en tu cuenta de Canvas
2. Haz clic en tu foto de perfil o avatar en la barra lateral izquierda
3. Haz clic en **Configuración**
4. Desplázate hasta **Integraciones aprobadas**
5. Haz clic en **+ Nuevo token de acceso**
6. Ingresa un propósito (ej., "Crow") y opcionalmente configura una fecha de expiración
7. Haz clic en **Generar token**
8. Copia el token — Canvas solo lo muestra una vez

### Paso 3: Agregar a Crow

Pega tu token y URL base en **Crow's Nest** → **Ajustes** → **Integraciones**,
o en la página de **Setup** en `/setup`.

Las variables de entorno son `CANVAS_API_TOKEN` y `CANVAS_BASE_URL`.

## Permisos requeridos

| Permiso | Por qué |
|---|---|
| Token de acceso a nivel de usuario | El token hereda los permisos de tu cuenta de Canvas |

El token puede acceder a todo lo que tu cuenta de Canvas puede acceder. Si eres estudiante, ve tus cursos y calificaciones. Si eres instructor, también ve las listas de alumnos y los detalles de las entregas.

## Solución de problemas

### Error "Invalid access token"

Los tokens pueden ser revocados por ti o por el administrador de Canvas de tu institución. Genera uno nuevo en **Configuración** → **Integraciones aprobadas**.

### "Not Found" (404) en las llamadas a la API

Verifica tu `CANVAS_BASE_URL`. Debe ser la URL completa incluyendo `https://` y sin barra final (ej., `https://canvas.instructure.com`).

### Faltan algunos cursos

Los tokens de Canvas solo otorgan acceso a los cursos activos. Los cursos concluidos o sin publicar pueden no aparecer en los resultados de la API según la configuración de tu institución.
