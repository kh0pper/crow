---
title: Descubrimiento de contactos
---

# Descubrimiento de contactos

Facilita que otros usuarios de Crow te encuentren y se conecten contigo.

## ¿Qué es esto?

De forma predeterminada, conectar dos instancias de Crow requiere compartir un código de invitación por un canal externo (correo, mensajería, etc.). El descubrimiento de contactos agrega un endpoint público **opcional** que permite a otros usuarios consultar tu Crow ID y tus claves públicas si conocen la URL de tu gateway.

Piénsalo como una tarjeta de presentación digital pegada en tu puerta: muestra tu nombre y cómo contactarte, pero nada más.

## Cómo activarlo

Abre el Crow's Nest y ve a **Settings**. En la sección **Contact Discovery**:

1. Establece el menú desplegable en **Enabled**
2. Opcionalmente ingresa un **nombre para mostrar** (p. ej., "Alice", "Crow de Investigación de Kevin")
3. Haz clic en **Save**

O pídeselo a tu IA:

> "Crow, activa el descubrimiento de contactos con el nombre para mostrar 'Alice'"

## Qué se expone

Cuando el descubrimiento está activado, hay disponible un endpoint JSON público en:

```
GET /discover/profile
```

Devuelve:

```json
{
  "crow_discovery": true,
  "crow_id": "crow:k3x7f9m2q4",
  "display_name": "Alice",
  "ed25519_pubkey": "a1b2c3...",
  "secp256k1_pubkey": "d4e5f6..."
}
```

### Qué NO se expone

- Claves privadas (nunca se comparten)
- Memorias, proyectos o cualquier dato almacenado
- Lista de contactos o elementos compartidos
- Correo, ubicación o información personal
- Entradas de blog (esas tienen sus propios controles de visibilidad)
- Claves de API o configuración

Las claves públicas son material criptográfico diseñado precisamente para compartirse -- se usan para el cifrado de extremo a extremo y la verificación de identidad.

## Cómo lo usan los demás

1. Otro usuario de Crow (o su IA) consulta tu endpoint `/discover/profile`
2. Obtiene tu Crow ID y tus claves públicas
3. Genera una invitación y te la envía (el sistema de invitaciones sigue requiriendo aceptación mutua)
4. Aceptas la invitación, verificas el número de seguridad y la conexión queda establecida

El descubrimiento facilita el **primer paso**, pero no omite el intercambio de invitación. Ambos usuarios deben seguir aceptando la conexión de forma explícita.

## Cómo desactivarlo

Ve a **Settings** en el Crow's Nest, establece Contact Discovery en **Disabled** y guarda. El endpoint devuelve 404 de inmediato.

O pídeselo a tu IA:

> "Crow, desactiva el descubrimiento de contactos"

## Consideraciones de privacidad

- El descubrimiento es **completamente opcional** y está **desactivado de forma predeterminada**
- Solo se comparten tu Crow ID, tu nombre para mostrar y tus claves públicas
- No hay un directorio central -- alguien debe conocer de antemano la URL de tu gateway
- Desactivar el descubrimiento surte efecto de inmediato
- El endpoint no requiere autenticación y es accesible públicamente (cuando está activado), así que tenlo en cuenta al decidir si activarlo
