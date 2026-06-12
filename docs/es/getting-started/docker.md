# Configuración con Docker

::: tip ¿No quieres administrar infraestructura?
Prueba el [hosting administrado](./managed-hosting) — $15/mes, sin configuración requerida.
:::

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

## Conectar Tu IA

Una vez que el gateway esté funcionando, conecta tu plataforma de IA:

[Claude](/es/platforms/claude) · [ChatGPT](/es/platforms/chatgpt) · [Todas las plataformas](/es/platforms/)

**Pruébalo** — después de conectar, di:

> "Recuerda que hoy es mi primer día usando Crow"
> "¿Qué recuerdas?"

::: tip Sincronización multi-instancia
Esta instancia de Docker puede sincronizarse con otras instalaciones de Crow en máquinas distintas. Configura una segunda instancia en [Oracle Cloud](./oracle-cloud) o [Google Cloud](./google-cloud), y luego [encadénalas](./multi-device) para redundancia y acceso remoto.
:::
