# Tiendas de complementos de la comunidad

Crow admite tiendas de complementos mantenidas por la comunidad, similares a las tiendas de apps comunitarias de Umbrel. Cualquier repositorio de GitHub que siga la plantilla de tienda puede agregarse como fuente de complementos.

## Cómo funciona

1. Los miembros de la comunidad crean un repositorio de GitHub siguiendo la plantilla de tienda
2. Los usuarios agregan la URL de la tienda en la configuración del panel de Extensiones
3. El panel de Extensiones combina los complementos de todas las tiendas configuradas
4. Los complementos de la comunidad muestran una insignia "Community" (no verificados por Crow)

## Plantilla de tienda

Una tienda de la comunidad es un repositorio de GitHub con esta estructura:

```
my-crow-store/
├── crow-store.json          # Metadatos de la tienda
├── my-addon/
│   ├── manifest.json        # Metadatos del complemento (mismo formato que el oficial)
│   ├── docker-compose.yml   # Para el tipo bundle
│   └── server/              # Para el tipo mcp-server
├── another-addon/
│   ├── manifest.json
│   └── ...
└── README.md
```

### `crow-store.json`

```json
{
  "id": "my-store",
  "name": "My Community Store",
  "author": "your-github-username",
  "description": "A collection of add-ons for data analysis",
  "url": "https://github.com/your-username/my-crow-store"
}
```

### Manifiestos de complementos

Cada complemento en una tienda de la comunidad usa el mismo formato de `manifest.json` que el [registro oficial](/es/developers/addon-registry). El panel de Extensiones lee estos manifiestos para mostrar las tarjetas de los complementos.

## Modelo de seguridad

Las tiendas de la comunidad tienen restricciones adicionales en comparación con el registro oficial:

| | Oficial | Comunidad |
|---|---|---|
| Insignia de verificado | Sí | No (insignia "Community") |
| Actualizaciones automáticas | Compatibles | Requieren confirmación manual |
| Red de Docker | Red del host disponible | Solo red aislada |
| Montaje de volúmenes | Volúmenes con nombre, las carpetas propias del complemento, carpetas que permitiste | Volúmenes con nombre, las carpetas propias del complemento, carpetas que permitiste |
| Modo privilegiado | Caso por caso | Nunca permitido |

### Validación del archivo compose

Antes de instalar un complemento de la comunidad, y de nuevo cada vez que Crow inicia sus contenedores, Crow revisa el proyecto compose. Le pide a Docker Compose la configuración que de verdad aplicará (`docker compose config`: anclas, `include`, `extends`, archivos override y valores `${VAR}` resueltos) y revisa eso, siguiendo los enlaces simbólicos. Si Compose no puede leer el proyecto, la instalación se rechaza.

- **Fuera de las carpetas de Crow, solo carpetas que permitiste**: una carpeta del host fuera de la carpeta de Crow y de su carpeta de datos se monta solo si la escribiste para esta extensión en su formulario de instalación o en Configurar, desde el panel de esta misma máquina (con su contraseña: no desde una instancia emparejada ni con un inicio de sesión de otra instancia). Al instalar, un valor por defecto o de ejemplo de la extensión nunca cuenta (el formulario lo rellena); guardar el ajuste en Configurar sí. Una carpeta permitida cuenta solo mientras ese ajuste la siga nombrando, así que una edición a mano del `.env` vuelve a mostrar el ajuste en Configurar. Una instancia emparejada no puede cambiar ajustes de carpetas. Una carpeta permitida no puede estar dentro de la de otra extensión, ni contenerla, y si dos extensiones comparten una, ninguna puede montar una subcarpeta suya. Las únicas entradas fijas del host son `/etc/localtime` en solo lectura, `/proc` y `/sys` en solo lectura con consentimiento, y el socket de Docker en solo lectura con consentimiento.
- **Rechazado**: montajes del host de `/`, tu carpeta personal, `/etc`, `/root`, `/boot`, `/run`, `/dev`, `~/.ssh`, los datos propios de Docker, la carpeta de Crow, su carpeta de datos, su carpeta de secretos y su `.env`, las carpetas de otras extensiones, o cualquier carpeta que contenga a estas. Excepciones: `/etc/localtime` en solo lectura; la subcarpeta propia del complemento `<carpeta de datos>/<id>`
- **Rechazado**: `env_file`, archivos de `secrets`/`configs` y el contexto de build fuera de la carpeta propia del complemento
- **Rechazado**: un segundo archivo compose (`compose.yaml`, `docker-compose.override.yml`, …) junto a `docker-compose.yml`, `include:`/`extends: file:` y ajustes `COMPOSE_*` en su `.env`
- **Rechazado para complementos de la comunidad, y solo con consentimiento para los propios**: `privileged`, capacidades peligrosas (`NET_ADMIN`, `SYS_ADMIN`, `ALL`, …), la red del host o la de otro contenedor, los espacios de nombres PID/IPC/de usuario del host, opciones de seguridad `unconfined`, `volumes_from` y dispositivos del host que no sean los nodos de render de la GPU
- **Permitido**: volúmenes de Docker con nombre y rutas dentro de la carpeta del complemento

### Aislamiento de red

Los contenedores de los complementos de la comunidad corren por defecto en una red de Docker aislada. Solo pueden acceder a los puertos declarados explícitamente en su `manifest.json`. El acceso a la red del host (`network_mode: host`) está bloqueado para los complementos de la comunidad.

## Gestionar tiendas

### Agregar una tienda

En la configuración del panel de Extensiones, ingresa la URL del repositorio de GitHub:

```
https://github.com/your-username/my-crow-store
```

Las tiendas se guardan en `~/.crow/stores.json`:

```json
{
  "stores": [
    {
      "id": "my-store",
      "url": "https://github.com/your-username/my-crow-store",
      "enabled": true,
      "addedAt": "2026-03-12T00:00:00Z"
    }
  ]
}
```

### Eliminar una tienda

Desactiva o elimina una tienda desde la configuración del panel de Extensiones. Los complementos instalados desde esa tienda siguen funcionando, pero no recibirán actualizaciones.

## Crear una tienda de la comunidad

1. Usa la plantilla [crow-community-store-template](https://github.com/kh0pper/crow-community-store-template) como punto de partida
2. Agrega tus complementos siguiendo el formato de manifiesto
3. Prueba cada complemento localmente con `crow bundle install`
4. Súbela a un repositorio público de GitHub
5. Comparte la URL con la comunidad

## Buenas prácticas

- Fija las versiones de las imágenes de Docker (no uses `:latest`)
- Documenta todas las variables de entorno requeridas
- Incluye los requisitos de recursos en el manifiesto
- Prueba en Raspberry Pi si tu público objetivo incluye dispositivos ARM
- Mantén los complementos enfocados — un servicio por complemento
