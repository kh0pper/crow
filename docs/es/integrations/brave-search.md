---
title: Brave Search
---

# Brave Search

Conecta Crow a Brave Search para obtener capacidades de búsqueda web, de noticias y local a través de tu asistente de IA.

## Qué obtienes

- Búsqueda web con resultados resumidos
- Búsqueda de negocios y lugares locales
- Búsqueda de artículos de noticias

## Configuración

### Paso 1: Crear una cuenta de la API de Brave Search

Ve a [brave.com/search/api](https://brave.com/search/api/) y haz clic en **Get Started**.

### Paso 2: Obtener tu clave de API

1. Inicia sesión o crea una cuenta de Brave
2. Suscríbete al plan **Free** (2,000 consultas/mes) o a un plan de pago
3. Ve a tu [panel de API Keys](https://api.search.brave.com/app/keys)
4. Copia tu clave de API

### Paso 3: Agregar a Crow

Pega tu clave en **Crow's Nest** → **Ajustes** → **Integraciones**,
o en la página de **Setup** en `/setup`.

La variable de entorno es `BRAVE_API_KEY`.

## Permisos requeridos

| Permiso | Por qué |
|---|---|
| Acceso a la Web Search API | Realizar búsquedas web, de noticias y locales |

No se necesitan scopes adicionales — la clave de API otorga acceso a todos los endpoints de búsqueda incluidos en tu plan.

## Solución de problemas

### Error "No autorizado" (401)

Verifica que tu clave de API esté copiada correctamente, sin espacios extra. Regenérala desde el [panel de API Keys](https://api.search.brave.com/app/keys) si es necesario.

### Límite de tasa excedido (429)

El plan gratuito permite 1 solicitud por segundo y 2,000 consultas por mes. Mejora tu plan en [brave.com/search/api](https://brave.com/search/api/) para obtener límites más altos.
