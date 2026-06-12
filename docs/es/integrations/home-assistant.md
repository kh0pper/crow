---
title: Home Assistant
---

# Home Assistant

Conecta Crow a Home Assistant para controlar dispositivos de hogar inteligente, automatizaciones y escenas a través de tu asistente de IA.

## Qué obtienes

- Controlar luces, interruptores y otros dispositivos
- Activar automatizaciones y escenas
- Leer valores de sensores (temperatura, humedad, movimiento, etc.)
- Ver estados y atributos de los dispositivos

## Configuración

### Paso 1: Encontrar tu URL de Home Assistant

Tu URL de Home Assistant es la dirección que usas para acceder a él, por ejemplo:
- `http://homeassistant.local:8123` (red local)
- `http://192.168.1.100:8123` (IP local)
- `https://tu-instancia.duckdns.org` (acceso remoto vía DuckDNS)
- `https://tu-instancia.ui.nabu.casa` (nube de Nabu Casa)

### Paso 2: Crear un token de acceso de larga duración

1. Abre la interfaz web de Home Assistant
2. Haz clic en el ícono de tu perfil en la esquina inferior izquierda de la barra lateral
3. Desplázate hasta la sección **Tokens de acceso de larga duración**
4. Haz clic en **Crear token**
5. Ponle un nombre (ej., "Crow")
6. Haz clic en **OK**
7. Copia el token — Home Assistant solo lo muestra una vez

### Paso 3: Agregar a Crow

Pega tu URL y token en **Crow's Nest** → **Ajustes** → **Integraciones**,
o en la página de **Setup** en `/setup`.

Las variables de entorno son `HA_URL` y `HA_TOKEN`.

## Permisos requeridos

| Permiso | Por qué |
|---|---|
| Token de acceso de larga duración | Autentica las solicitudes a la API con los permisos de tu cuenta de usuario de HA |

El token hereda todos los permisos del usuario de Home Assistant que lo creó. Para un acceso más restringido, crea un usuario de HA dedicado con permisos limitados y genera el token desde esa cuenta.

## Solución de problemas

### "Conexión rechazada" o tiempo de espera agotado

Asegúrate de que la `HA_URL` sea accesible desde la máquina que ejecuta Crow. Si Home Assistant está en otra red, necesitarás tener configurado el acceso remoto (DuckDNS, Nabu Casa, Tailscale, etc.).

### "401 No autorizado"

Es posible que el token haya sido eliminado. Crea un nuevo token de acceso de larga duración desde la página de tu perfil en Home Assistant.

### Los dispositivos no aparecen

La API de Home Assistant expone todas las entidades. Si falta un dispositivo, verifica primero que esté correctamente integrado en Home Assistant (Ajustes → Dispositivos y servicios).
