---
title: Registro de complementos
---

# Registro de complementos

El registro de complementos de Crow es una lista curada de extensiones creadas por la comunidad — paneles, servidores MCP, skills y bundles.

## ¿Qué es esto?

El registro es un archivo JSON alojado en el repositorio de Crow que lista los complementos disponibles con sus metadatos, URLs de descarga y checksums de integridad. No es un gestor de paquetes — es un directorio que apunta a repositorios Git.

## ¿Por qué querría esto?

- **Descubrir complementos** — Explora lo que la comunidad ha construido
- **Verificación de confianza** — Cada complemento listado tiene un checksum SHA-256 y está fijado a un commit específico
- **Línea base de calidad** — Los envíos son revisados por los mantenedores antes de listarse

## Formato del registro

El registro es un archivo JSON en `registry/add-ons.json`:

```json
{
  "version": 2,
  "add-ons": [
    {
      "id": "my-addon",
      "name": "My Add-on",
      "description": "What this add-on does",
      "type": "bundle",
      "version": "1.0.0",
      "author": "contributor-handle",
      "category": "productivity",
      "tags": ["keyword1", "keyword2"],
      "icon": "book",
      "requires": {
        "env": ["API_KEY"],
        "min_ram_mb": 256,
        "min_disk_mb": 100
      },
      "env_vars": [
        {
          "name": "API_KEY",
          "description": "Your API key for the service",
          "required": true,
          "secret": true
        }
      ],
      "ports": [8080],
      "notes": "Optional notes shown in the Extensions panel"
    }
  ]
}
```

### Campos de la entrada

| Campo | Obligatorio | Descripción |
|---|---|---|
| `id` | Sí | Identificador único (minúsculas, solo guiones) |
| `name` | Sí | Nombre legible por humanos |
| `description` | Sí | Descripción de una línea |
| `type` | Sí | `panel`, `mcp-server`, `skill` o `bundle` |
| `version` | Sí | Versión semver |
| `author` | Sí | Nombre de usuario o handle de GitHub |
| `category` | Sí | Categoría: `ai`, `media`, `productivity`, `storage`, `smart-home`, `networking`, `social`, `gaming`, `data`, `finance`, `other` |
| `tags` | No | Arreglo de etiquetas buscables (máx. 10) |
| `icon` | No | Clave de ícono: `brain`, `cloud`, `image`, `book`, `home`, `rss`, `mic`, `music`, `message-circle`, `gamepad`, `archive`, `file-text`, `phone-video` |
| `requires.env` | No | Nombres de variables de entorno requeridas |
| `requires.min_ram_mb` | No | RAM mínima en MB |
| `requires.min_disk_mb` | No | Espacio mínimo en disco en MB |
| `requires.gpu` | No | Establece `true` si el complemento necesita una GPU |
| `requires.bundles` | No | Arreglo de IDs de bundles que deben instalarse primero. El endpoint de instalación se niega si falta alguno; la desinstalación se bloquea mientras haya dependientes instalados. |
| `privileged` | No | Establece `true` para bundles que necesitan NET_ADMIN, NET_RAW, SYS_ADMIN o `network_mode: host`. Activa el flujo de consentimiento del modal de instalación con un token de un solo uso validado por el servidor. |
| `consent_required` | No | Establece `true` para bundles con un costo operativo significativo o con acceso de lectura al socket de Docker (netdata, dozzle). Activa el modal de consentimiento aunque no sean `privileged`. |
| `install_consent_messages` | No | Objeto indexado por código de idioma (`en`, `es`, ...) con el texto de advertencia mostrado en el modal de confirmación de instalación. Recurre a `install_consent_message` y luego a una cadena genérica. |
| `install_consent_message` | No | Alternativa de un solo idioma para `install_consent_messages`. |
| `env_vars` | No | Descripciones detalladas de las variables de entorno (name, description, required, secret, default) |
| `ports` | No | Puertos usados por el complemento |
| `webUI` | No | Interfaz web: `{ "port", "path", "label" }` o `null` para complementos sin interfaz |
| `server` | No | Configuración del servidor MCP: `{ "command", "args", "envKeys" }` |
| `panel` | No | Ruta al módulo de panel del Crow's Nest |
| `skills` | No | Arreglo de rutas de archivos de skills |
| `docker` | No | Configuración de Docker: `{ "composefile": "docker-compose.yml" }` |
| `notes` | No | Notas adicionales (se muestran en cursiva en la tarjeta de Extensiones) |

## Proceso de envío

### 1. Construye y prueba

- Crea tu complemento siguiendo la guía [Crear complementos](/es/developers/creating-addons)
- Pruébalo a fondo con tu propia instancia de Crow
- Verifica que funcione tanto con el tema oscuro como con el claro (para paneles)

### 2. Publica tu repositorio

- Súbelo a un repositorio público de GitHub
- Incluye un `manifest.json`, una `LICENSE` y un `README.md`
- Etiqueta un release que coincida con la versión de tu manifiesto:

```bash
git tag v1.0.0
git push origin v1.0.0
```

### 3. Genera el checksum

Descarga el archivo de tu release y genera el checksum SHA-256:

```bash
curl -L -o addon.tar.gz https://github.com/you/your-addon/archive/v1.0.0.tar.gz
sha256sum addon.tar.gz
```

### 4. Abre un issue

Abre un issue en el repositorio de Crow usando la plantilla **Add-on Submission**. Incluye:

- Nombre y descripción del complemento
- URL del repositorio
- Versión y SHA del commit
- Checksum SHA-256
- Una breve explicación de qué hace y por qué es útil

### 5. Revisión

Un mantenedor revisa tu envío evaluando:

- **Seguridad** — Sin secretos codificados en el código, sin llamadas de red sin el consentimiento del usuario, sin acceso al sistema de archivos fuera de `~/.crow/`
- **Calidad** — Sigue las convenciones de Crow (patrón factory, restricciones de Zod, etc.)
- **Completitud** — Tiene manifiesto, licencia y documentación razonable
- **Funcionalidad** — Realmente funciona al instalarse

### 6. Listado

Una vez aprobado, el mantenedor agrega tu complemento a `registry/add-ons.json` y hace el merge. Tu complemento ahora puede ser descubierto por todos los usuarios de Crow.

::: warning Lista de verificación del mantenedor
Agregar la entrada al registro por sí sola no basta. El mantenedor debe completar **todos** estos pasos o el complemento quedará invisible o roto en la interfaz:

1. **Entrada del registro** — Agrega la entrada JSON a `registry/add-ons.json`
2. **Mapa de íconos** — Si el valor de `icon` es nuevo, agrégalo a `ICON_MAP` en `servers/gateway/dashboard/panels/extensions.js`
3. **Color de categoría** — Si la `category` es nueva, agrégala a `CATEGORY_COLORS` en `extensions.js`
4. **Etiqueta de categoría** — Si la `category` es nueva, agrégala a `CATEGORY_LABELS` en `extensions.js`
5. **Clave i18n** — Si la `category` es nueva, agrega una clave `extensions.category*` a `servers/gateway/dashboard/shared/i18n.js`
6. **Mapeo de grupo de navegación** — Si la `category` es nueva, agrégala a `CATEGORY_TO_GROUP` en `servers/gateway/dashboard/nav-registry.js` (determina en qué grupo de la barra lateral aparece el panel)
7. **Reinicio del gateway** — Requerido después de cualquier cambio en el registro o en los paneles
:::

## Tiempos de respuesta

Los mantenedores procuran revisar los envíos en un plazo de 72 horas. Si se necesitan cambios, recibirás retroalimentación en el issue.

## Actualizar un complemento listado

Para actualizar tu complemento:

1. Sube los cambios y etiqueta una nueva versión
2. Abre un nuevo issue con la versión actualizada, el SHA del commit y el checksum
3. El mantenedor actualiza la entrada del registro

## Gobernanza

El registro es curado por los mantenedores. Los mantenedores pueden:

- Aprobar o rechazar envíos
- Eliminar complementos que dejen de mantenerse o que planteen problemas de seguridad
- Solicitar cambios antes de listarlos

El objetivo es un directorio pequeño y de alta calidad, en lugar de un índice de paquetes grande y sin revisar.

## Verificación de integridad

Al instalar un complemento, verifica el checksum:

```bash
curl -L -o addon.tar.gz <download_url>
echo "<expected_sha256>  addon.tar.gz" | sha256sum -c
```

Una discrepancia significa que el archivo fue alterado o que la URL cambió. No lo instales.
