# Configuración con Docker

Ejecuta el gateway de Crow en Docker para despliegues autoalojados.

## Requisitos previos

- [Docker](https://docs.docker.com/get-docker/) y Docker Compose instalados
- Usa SQLite local — no se necesita configurar ninguna base de datos.

## Perfil Cloud

Expone el gateway en el puerto 3001:

```bash
docker compose --profile cloud up --build
```

Define las variables de entorno en un archivo `.env` o pásalas directamente. No se necesita configuración de base de datos — Crow usa SQLite local automáticamente. Un `.env` mínimo:

```env
# URL pública de esta instancia (requerida para clientes MCP remotos + OAuth)
CROW_GATEWAY_URL=https://tu-dominio.example
# Claves de integraciones opcionales, una por servicio (consulta .env.example)
# GITHUB_TOKEN=...
```

## Perfil Local

Ejecuta el gateway con un Cloudflare Tunnel para acceso remoto:

```bash
docker compose --profile local up --build
```

Esto crea una URL pública vía Cloudflare que puedes usar para conectarte desde clientes de IA móviles o web.

## Variables de Entorno

El gateway lee todas las claves de API de integraciones desde variables de entorno. Consulta la página de [Integraciones](/es/integrations/) para la lista completa.

> **Nota de seguridad**: Si vas a exponer el gateway a internet, usa siempre un proxy inverso (nginx, Caddy o Cloudflare Tunnel) con HTTPS. Nunca expongas el puerto 3001 directamente a internet sin cifrado TLS. La bandera `--no-auth` nunca debe usarse en despliegues expuestos a internet.

## Verificación de Salud

Verifica que el gateway esté funcionando:

```bash
curl http://localhost:3001/health
```

Visita `http://localhost:3001/setup` para ver el estado de las integraciones y las URLs de los endpoints.

## Contraseña del Crow's Nest

La primera vez que visites `/dashboard`, se te pedirá establecer una contraseña. También puedes establecerla desde la página `/setup` o pidiéndoselo a tu IA: "Establece mi contraseña del Crow's Nest."

::: tip Enlace de configuración inicial
Mientras no exista una contraseña, las páginas de configuración inicial piden un token de un solo uso, para que nadie más en tu red pueda establecer la contraseña primero.

Con Docker la página se sirve desde dentro del contenedor `crow-gateway`, así que una petición que hagas desde el host llega desde la red bridge de Docker y no desde la máquina misma: el token es obligatorio, incluso cuando abres la página desde el host.

El token está dentro del contenedor, en el directorio home de Crow allí — léelo con:

```bash
docker compose exec crow-gateway cat /root/.crow/setup-token
```

Luego abre `http://localhost:3001/setup?token=<ese valor>`. El archivo compose publica el gateway solo en `127.0.0.1`, así que esa dirección es el mapeo de puerto del propio host, no un puerto abierto a tu red. El token deja de funcionar en cuanto estableces la contraseña.
:::

## Conectar Tu IA

Una vez que el gateway esté funcionando, conecta tu plataforma de IA:

[Claude](/es/platforms/claude) · [ChatGPT](/es/platforms/chatgpt) · [Todas las plataformas](/es/platforms/)

**Pruébalo** — después de conectar, di:

> "Recuerda que hoy es mi primer día usando Crow"
> "¿Qué recuerdas?"

::: tip Sincronización multi-instancia
Esta instancia de Docker puede sincronizarse con otras instalaciones de Crow en máquinas distintas. Configura una segunda instancia en [Oracle Cloud](./oracle-cloud) o [Google Cloud](./google-cloud), y luego [encadénalas](./multi-device) para redundancia y acceso remoto.
:::
