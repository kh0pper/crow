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
| Montaje de volúmenes | Volúmenes con nombre + rutas en lista de permitidos | Solo volúmenes con nombre |
| Modo privilegiado | Caso por caso | Nunca permitido |

### Validación del archivo compose

Antes de instalar un complemento de la comunidad, Crow valida el `docker-compose.yml`:

- **Rechazado**: montajes a `/`, `/etc`, `~/.ssh`, `~/.crow/data` o cualquier ruta del host fuera de `~/.crow/bundles/<id>/data`
- **Rechazado**: `privileged: true`
- **Rechazado**: las capacidades `NET_ADMIN` o `SYS_ADMIN`
- **Permitido**: volúmenes de Docker con nombre, `~/.crow/bundles/<id>/data`

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
