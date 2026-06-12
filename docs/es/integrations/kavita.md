---
title: Kavita
---

# Kavita

Conecta Crow a Kavita para explorar manga, cómics y ebooks, hacer seguimiento de tu progreso de lectura y gestionar tu lista de lectura a través de tu asistente de IA.

## Qué obtienes

- Buscar manga, cómics y ebooks
- Explorar series con filtros y paginación
- Hacer seguimiento del progreso de lectura por serie
- Gestionar una lista de pendientes por leer
- Ver contenido agregado recientemente
- Consultar estadísticas de la biblioteca

## Configuración

Crow soporta dos modos para Kavita: autoalojamiento vía Docker o conexión a una instancia existente.

### Opción A: Docker (autoalojado)

Instala Kavita como un bundle de Crow. Esto ejecuta Kavita en Docker junto a tu gateway de Crow.

> "Crow, instala el bundle de Kavita"

O instálalo desde el panel de **Extensiones** en el Crow's Nest.

Después de la instalación, configura la ruta a tu biblioteca:

```bash
# En tu archivo .env
KAVITA_LIBRARY_PATH=/ruta/a/tus/manga-comics-ebooks
```

Reinicia el bundle para que los cambios surtan efecto:

> "Crow, reinicia el bundle de Kavita"

Kavita estará disponible en `http://tu-servidor:5000`. Crea una cuenta de administrador a través de la interfaz web en el primer arranque.

::: tip Nota sobre el puerto
El puerto 5000 es usado comúnmente por otros servicios. Si tienes un conflicto, reasigna el puerto en el `docker-compose.yml` del bundle.
:::

### Opción B: Conectar a Kavita existente

Si ya tienes una instancia de Kavita funcionando, conecta Crow directamente a ella.

#### Paso 1: Tener a mano tus credenciales

Crow se autentica con Kavita usando tu nombre de usuario y contraseña. La gestión del token JWT se maneja automáticamente.

#### Paso 2: Agregar a Crow

Configura lo siguiente en tu archivo `.env` o vía **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
KAVITA_URL=http://tu-servidor-kavita:5000
KAVITA_USERNAME=tu-nombre-de-usuario
KAVITA_PASSWORD=tu-contraseña
```

## Herramientas de IA

Una vez conectado, puedes interactuar con Kavita a través de tu IA:

> "Busca One Piece en mi manga"

> "¿Qué he estado leyendo últimamente?"

> "Agrega esta serie a mi lista de pendientes por leer"

> "Muéstrame los cómics agregados recientemente"

> "¿Cuál es mi progreso de lectura en esa serie?"

## Solución de problemas

### "Conexión rechazada" o tiempo de espera agotado

Asegúrate de que la `KAVITA_URL` sea accesible desde la máquina que ejecuta Crow. Si Kavita está en otra máquina, usa la IP o el nombre de host correcto.

### Error de inicio de sesión

Verifica que `KAVITA_USERNAME` y `KAVITA_PASSWORD` sean correctos. Intenta iniciar sesión en la interfaz web de Kavita con las mismas credenciales para confirmar que funcionan.

### Conflicto con el puerto 5000

Si otro servicio ya está usando el puerto 5000, edita el `docker-compose.yml` del bundle para reasignar el puerto (ej., `5001:5000`) y luego actualiza la `KAVITA_URL` en consecuencia.
