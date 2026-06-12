---
title: Zotero
---

# Zotero

Conecta Crow a Zotero para buscar en tu biblioteca de referencias y gestionar citas a través de tu asistente de IA.

## Qué obtienes

- Buscar en tu biblioteca de Zotero por título, autor o etiqueta
- Explorar colecciones y subcolecciones
- Recuperar metadatos completos de citas para generar bibliografías
- Acceder a archivos PDF adjuntos y notas

## Requisitos previos

Esta integración requiere **uvx** (ejecutor de paquetes de Python). Instálalo con:

```bash
# macOS
brew install uv

# Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

## Configuración

### Paso 1: Encontrar tu User ID

1. Ve a [zotero.org/settings/keys](https://www.zotero.org/settings/keys)
2. Tu **User ID** se muestra en la parte superior de la página (un valor numérico)

### Paso 2: Crear una clave de API

1. En la misma página, haz clic en **Create new private key**
2. Ponle un nombre (ej., "Crow")
3. Bajo **Personal Library**, marca:
   - **Allow library access**
   - **Allow notes access**
4. Bajo **Default Group Permissions**, selecciona **Read Only** si quieres acceso a bibliotecas de grupo
5. Haz clic en **Save Key**
6. Copia la clave de API desde la página de confirmación

### Paso 3: Agregar a Crow

Pega ambos valores en **Crow's Nest** → **Ajustes** → **Integraciones**,
o en la página de **Setup** en `/setup`.

Las variables de entorno son `ZOTERO_API_KEY` y `ZOTERO_USER_ID`.

## Permisos requeridos

| Permiso | Por qué |
|---|---|
| **Allow library access** | Leer elementos, colecciones y metadatos de tu biblioteca |
| **Allow notes access** | Leer las notas adjuntas a los elementos de la biblioteca |

## Solución de problemas

### Error "403 Forbidden"

Es posible que tu clave de API no tenga habilitado el acceso a la biblioteca. Ve a [zotero.org/settings/keys](https://www.zotero.org/settings/keys), haz clic en tu clave y asegúrate de que **Allow library access** esté marcado.

### "uvx: command not found"

Instala uv primero (ver Requisitos previos más arriba) y luego reinicia tu terminal.

### User ID incorrecto

El User ID es un número, no tu nombre de usuario. Encuéntralo en la parte superior de [zotero.org/settings/keys](https://www.zotero.org/settings/keys).
