---
title: Trello
---

# Trello

Conecta Crow a Trello para gestionar tableros, listas y tarjetas a través de tu asistente de IA.

## Qué obtienes

- Ver y gestionar tableros, listas y tarjetas
- Crear, mover y archivar tarjetas
- Gestionar etiquetas y checklists
- Asignar miembros a tarjetas

## Configuración

### Paso 1: Obtener tu clave de API

1. Ve a [trello.com/power-ups/admin](https://trello.com/power-ups/admin)
2. Haz clic en **New** para crear un nuevo Power-Up (o usa uno existente)
3. Completa los campos requeridos (nombre, workspace; la URL del iframe connector puede ser cualquier URL)
4. Después de crearlo, haz clic en tu Power-Up y ve a la pestaña **API Key**
5. Haz clic en **Generate a new API Key**
6. Copia la **API Key**

### Paso 2: Generar un token

1. En la misma página de la API Key, haz clic en el enlace **Token** junto a tu clave de API
2. Esto abre una página de autorización — haz clic en **Allow**
3. Copia el token que se muestra en la página siguiente

### Paso 3: Agregar a Crow

Pega ambos valores en **Crow's Nest** → **Ajustes** → **Integraciones**,
o en la página de **Setup** en `/setup`.

Las variables de entorno son `TRELLO_API_KEY` y `TRELLO_TOKEN`.

## Permisos requeridos

| Permiso | Por qué |
|---|---|
| Acceso de lectura | Ver tableros, listas, tarjetas y miembros |
| Acceso de escritura | Crear, actualizar, mover y archivar tarjetas |
| Acceso a la cuenta | Leer la información de tu cuenta y tu membresía en tableros |

La página de autorización del token solicita estos permisos durante el paso de "Allow".

## Solución de problemas

### Error "invalid key"

Asegúrate de estar usando la API Key (no el secret) de la página de administración del Power-Up. La clave es una cadena hexadecimal de 32 caracteres.

### Error "invalid token"

Los tokens pueden expirar o ser revocados. Genera uno nuevo haciendo clic en el enlace **Token** en la página de la API Key de tu Power-Up.

### No puedes ver un tablero específico

El token otorga acceso a todos los tableros visibles para tu cuenta de Trello. Si falta un tablero, verifica que seas miembro de ese tablero en Trello.
