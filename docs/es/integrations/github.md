---
title: GitHub
---

# GitHub

Conecta Crow a GitHub para gestionar repositorios, issues y pull requests, y buscar código directamente a través de tu asistente de IA.

## Qué obtienes

- Explorar y buscar repositorios, issues y pull requests
- Leer y crear issues, comentarios y pull requests
- Buscar código en tus repositorios y organizaciones
- Ver el historial de commits y el contenido de archivos

## Configuración

### Paso 1: Iniciar sesión en GitHub

Ve a [github.com](https://github.com) e inicia sesión en tu cuenta.

### Paso 2: Crear un Personal Access Token

1. Navega a [Settings → Developer settings → Personal access tokens → Fine-grained tokens](https://github.com/settings/tokens?type=beta) (o usa los [tokens clásicos](https://github.com/settings/tokens))
2. Haz clic en **Generate new token**
3. Ponle un nombre descriptivo como "Crow MCP"
4. Configura una expiración (se recomiendan 90 días — siempre puedes regenerarlo)
5. Selecciona los scopes listados abajo en **Permisos requeridos**
6. Haz clic en **Generate token**
7. Copia el token de inmediato — GitHub solo lo muestra una vez

### Paso 3: Agregar a Crow

Pega tu token en **Crow's Nest** → **Ajustes** → **Integraciones**,
o en la página de **Setup** en `/setup`.

La variable de entorno es `GITHUB_PERSONAL_ACCESS_TOKEN`.

## Permisos requeridos

Para tokens clásicos:

| Scope | Por qué |
|---|---|
| `repo` | Acceso completo a repositorios públicos y privados |
| `read:org` | Leer la membresía y los equipos de la organización |
| `read:user` | Leer la información del perfil de usuario |

Para tokens fine-grained, otorga acceso de **Lectura** a los repositorios específicos a los que quieres que Crow acceda, con permisos para Contents, Issues, Pull requests y Metadata.

## Solución de problemas

### Error "Bad credentials"

Tu token puede haber expirado o sido revocado. Genera uno nuevo en [github.com/settings/tokens](https://github.com/settings/tokens) y actualízalo en los Ajustes del Crow's Nest.

### No se ven los repositorios privados

Asegúrate de que el scope `repo` esté seleccionado (tokens clásicos) o de que el repositorio específico tenga acceso otorgado (tokens fine-grained).

### Límite de tasa (errores 403)

GitHub permite 5,000 solicitudes por hora para usuarios autenticados. Si alcanzas el límite, espera la ventana de restablecimiento (mostrada en la respuesta de error) o reduce la frecuencia de las solicitudes.
