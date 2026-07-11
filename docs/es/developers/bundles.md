# Bundles — el contrato de bundle

Un **bundle** es la unidad modular de la capa de extensión de Crow: un directorio bajo `bundles/<id>/` descrito por un `manifest.json`. Un bundle puede proporcionar cualquier combinación de superficies — un **servicio** en contenedor (Docker), un **servidor MCP** (herramientas), un **panel** del dashboard y **skills** — de ahí que "bundle = servicio + herramientas + skills". El contrato es *por superficies*: un bundle solo está obligado a cumplir las reglas de las superficies que realmente declara.

## De dónde vienen los bundles

- Fuente de verdad: cada `bundles/<id>/manifest.json`.
- Catálogo de instalación: `registry/add-ons.json` se **genera** a partir de los manifiestos con `npm run build-registry` — nunca lo edites a mano. Está confirmado en git (modelo de lockfile) y una prueba falla si se desincroniza.

## Campos universales obligatorios

Todo manifiesto debe tener:

| Campo | Regla |
|---|---|
| `id` | debe ser igual al nombre del directorio |
| `name` | no vacío |
| `description` | no vacío |
| `type` | `bundle` \| `mcp-server` \| `skill` (una etiqueta de categoría general, no lo que determina los campos obligatorios) |
| `category` | no vacío |

`version` (semver) y `author` son **opcionales**, pero se valida su forma cuando están presentes (algunos bundles de primera parte de modelos/multimedia se publican sin ellos).

## Superficies (declara lo que provees)

Una superficie se "declara" por la presencia de su clave. Cada superficie declarada se valida tanto en su forma **como** en que los archivos que referencia existan bajo el directorio del bundle:

| Superficie | Forma | Integridad |
|---|---|---|
| `docker` | `{ "composefile": "docker-compose.yml" }` | el composefile existe |
| `server` | `{ "command": "node", "args": ["server/index.js"], "envKeys": [...] }`, o `null` | el archivo de entrada se verifica **solo** cuando `command` es `node` y `args[0]` es una ruta (los servidores externos `npx`/`uv` están exentos) |
| `panel` | `"panel/<id>.js"` **o** `{ "id": "...", "extends": "..." }` | forma de cadena: el archivo existe; forma de objeto: solo la forma (se resuelve en tiempo de ejecución) |
| `panelRoutes` | `"panel/routes.js"` | el archivo existe |
| `skills` | `["skills/<id>.md", ...]` | todas las rutas existen |
| `ports` / `port` / `webUI.port` | enteros (1–65535); `webUI` también puede ser `null` | — |
| `requires.bundles` / `optional_bundles` | `["<bundle-id>", ...]` | cada id es un directorio `bundles/<id>` con un `manifest.json` (un bundle real) |
| `env_vars` | `[{ "name": "X", "description": "...", "required": false, "secret": false, "default": "" }]` | cada entrada tiene un `name` |

Se permiten campos desconocidos (el esquema es permisivo) — los extras específicos de cada bundle como `capabilities`, `companion`, `storage`, `providers`, `sttProfileSeed` pasan sin tocarse. La forma canónica es `registry/manifest.schema.json`.

## Borrador / sin publicar

- `"draft": true` excluye un bundle del registro generado.
- Un directorio de bundle **sin seguimiento** (no confirmado en git) se trata como un borrador implícito — se excluye y se reporta, nunca se publica automáticamente. Esto mantiene el trabajo en progreso fuera del registro.

## Validar + generar

```bash
npm run build-registry -- --check   # valida todos los manifiestos + verifica desvíos (CI)
npm run build-registry              # regenera registry/add-ons.json
npm run test:bundle-contract        # la puerta de node:test
```

`--check` imprime una auditoría por bundle (id, tipo, superficies, estado) y sale con código distinto de cero ante cualquier manifiesto inválido o si el registro confirmado está desactualizado.

## Ejemplo mínimo

```
bundles/your-bundle/
├── manifest.json
├── docker-compose.yml      (si incluye un servicio)
├── server/index.js         (si provee herramientas MCP)
├── panel/your-bundle.js    (si agrega un panel del dashboard)
└── skills/your-bundle.md   (si agrega skills)
```

```json
{
  "id": "your-bundle",
  "name": "Your Bundle",
  "version": "1.0.0",
  "description": "What it does",
  "type": "bundle",
  "author": "You",
  "category": "utilities",
  "docker": { "composefile": "docker-compose.yml" },
  "server": { "command": "node", "args": ["server/index.js"], "envKeys": ["YOUR_API_KEY"] },
  "panel": "panel/your-bundle.js",
  "skills": ["skills/your-bundle.md"],
  "requires": { "env": ["YOUR_API_KEY"] },
  "env_vars": [
    { "name": "YOUR_API_KEY", "description": "API key", "required": true, "secret": true }
  ]
}
```

Después de agregar o editar un bundle, ejecuta `npm run build-registry` y confirma tanto el manifiesto como el `registry/add-ons.json` regenerado.

## Colecciones

`registry/collections.json` agrupa bundles oficiales en "colecciones iniciales" curadas de un clic (Servidor Doméstico, Educación, Investigación, Desarrollo) que aparecen en la vista Explorar de la página de Extensiones. Cada colección es `{ id, name, description, icon, members }`, donde cada miembro es `{ id, kind, you_need? }`.

La membresía está limitada por reglas obligatorias, aplicadas por `tests/extensions-collections.test.js`:

- **Oficial**: el `id` de cada miembro debe existir en `registry/add-ons.json` y tener un manifiesto bajo `bundles/<id>/`.
- **No privilegiado, sin consentimiento especial**: ningún miembro puede declarar `privileged: true` ni `consent_required: true` — una instalación de un clic nunca debe saltarse la puerta de consentimiento.
- **Sin GPU**: ningún miembro puede declarar `requires.gpu` ni `requires.min_vram_gb` — las colecciones son independientes del host, no ajustadas al hardware de una máquina en particular.
- **Sin red de host, sin socket de Docker**: el `docker-compose.yml` de ningún miembro puede usar `network_mode: host` ni montar `/var/run/docker.sock` — `validateComposeFile` rechaza ambos sin la puerta de privilegio/consentimiento, así que un miembro así haría fallar la instalación de un clic.
- **Cierre de dependencias y orden topológico**: toda dependencia `requires.bundles` de un miembro debe ser también miembro de la misma colección, y debe aparecer antes que el miembro que depende de ella en el arreglo `members`.
- **`kind` coincide con la presencia del compose**: un miembro con `docker-compose.yml` debe ser `kind: "deploys"`; un miembro sin él es `"builtin"` o `"connects"`.
- **Los miembros `connects` declaran `you_need`**: un miembro que se conecta a algo que el usuario ya ejecuta (por ejemplo, una instancia existente de Home Assistant) debe declarar `kind: "connects"` y una cadena `you_need` no vacía que describa qué debe aportar el usuario.

Al instalar, el gateway no confía ciegamente en el JSON cargado — vuelve a validar el manifiesto de cada miembro contra estas mismas reglas a partir de los archivos `bundles/<id>/manifest.json` en disco antes de ejecutar el trabajo de instalación, de modo que una colección no pueda usarse para introducir un bundle cuyo manifiesto haya cambiado (o se haya eliminado) desde que se escribió `collections.json`.

### Invariante de despliegue: los gateways coalojados necesitan `CROW_HOME` distintos

La ruta de instalación de un clic se protege contra instalaciones concurrentes con una bandera de ocupado en proceso más un archivo `installed.json` bajo `CROW_HOME`. Ambos son **por proceso**, no entre procesos: si dos procesos de gateway están coalojados y comparten el mismo `~/.crow` (el mismo `CROW_HOME`), pueden competir por `installed.json` y por la bandera de ocupado del conjunto de instalación, corrompiendo el registro de bundles instalados. Toda instancia de gateway — incluidas las de prueba/desechables levantadas para testing — debe ejecutarse con su propio `CROW_HOME` distinto.
