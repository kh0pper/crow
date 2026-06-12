---
title: Actual Budget
---

# Actual Budget

Conecta Crow a Actual Budget, una herramienta de finanzas personales con privacidad ante todo, para hacer seguimiento de gastos, gestionar presupuestos y ver reportes financieros a través de tu asistente de IA. Todos los datos permanecen en tu servidor.

## Qué obtienes

- Ver los saldos de todas tus cuentas
- Explorar y buscar transacciones por cuenta, fecha, categoría o beneficiario
- Crear nuevas transacciones desde lenguaje natural
- Ver las categorías del presupuesto y los montos asignados por mes
- Actualizar las asignaciones del presupuesto para cualquier categoría
- Generar reportes de gastos por categoría, beneficiario o periodo de tiempo

## Configuración

Crow soporta dos modos para Actual Budget: autoalojamiento vía Docker o conexión a una instancia existente.

### Opción A: Docker (autoalojado)

Instala Actual Budget como un bundle de Crow. Esto ejecuta Actual Budget en Docker junto a tu gateway de Crow.

> "Crow, instala el bundle de Actual Budget"

O instálalo desde el panel de **Extensiones** en el Crow's Nest.

Después de la instalación, Actual Budget estará disponible en `http://tu-servidor:5006`. En tu primera visita a la interfaz web, se te pedirá establecer una contraseña del servidor. Usa la misma contraseña que `ACTUAL_PASSWORD` en tu archivo `.env`:

```bash
# En tu archivo .env
ACTUAL_PASSWORD=tu-contrasena-del-servidor
```

Reinicia el bundle para que los cambios surtan efecto:

> "Crow, reinicia el bundle de Actual Budget"

### Opción B: Conectar a Actual Budget existente

Si ya tienes un servidor Actual Budget funcionando, conecta Crow directamente a él.

Configura lo siguiente en tu archivo `.env` o vía **Crow's Nest** > **Ajustes** > **Integraciones**:

```bash
ACTUAL_URL=http://tu-servidor-actual:5006
ACTUAL_PASSWORD=tu-contrasena-del-servidor
```

Opcionalmente, configura `ACTUAL_SYNC_ID` para autoseleccionar un archivo de presupuesto específico (útil si tienes varios presupuestos):

```bash
ACTUAL_SYNC_ID=tu-sync-id-de-presupuesto
```

Puedes encontrar el sync ID en los ajustes de Actual, en **Avanzado** > **Mostrar ID del presupuesto**.

## Herramientas de IA

Una vez conectado, puedes gestionar tus finanzas a través de tu IA:

> "¿Cuáles son los saldos de mis cuentas?"

> "Muéstrame las transacciones del mes pasado"

> "Agrega una transacción: $45.99 en Whole Foods, categoría supermercado"

> "¿Cuál es mi presupuesto para comer fuera este mes?"

> "¿Cuánto gasté en transporte en marzo?"

> "Establece el presupuesto de supermercado en $500 para este mes"

## Privacidad

Actual Budget está diseñado con la privacidad ante todo. Todos los datos financieros permanecen en tu servidor. Sin sincronización en la nube, sin acceso de terceros. El asistente de IA accede a tus datos solo a través de la API local.

## Una nota sobre los montos

Internamente, Actual almacena los montos en centavos. Crow los convierte automáticamente a dólares para mostrarlos. Al crear transacciones, usa montos normales en dólares (ej., 45.99) en lugar de valores en centavos (ej., 4599).

## Solución de problemas

### "Conexión rechazada" o tiempo de espera agotado

Asegúrate de que la `ACTUAL_URL` sea accesible desde la máquina que ejecuta Crow. Si Actual Budget está en otra máquina, usa la IP o el nombre de host correcto. Verifica que el servidor esté funcionando.

### "Login fallido" o error de autenticación

La `ACTUAL_PASSWORD` debe coincidir con la contraseña del servidor que estableciste durante la configuración inicial en la interfaz web de Actual. Si cambiaste la contraseña en la interfaz web, actualiza tu archivo `.env` para que coincida.

### No aparecen datos del presupuesto

Actual Budget requiere que abras y selecciones un archivo de presupuesto antes de que la API pueda acceder a él. Abre la interfaz web de Actual y crea o selecciona un archivo de presupuesto. Alternativamente, configura `ACTUAL_SYNC_ID` en tu `.env` para autoseleccionar un presupuesto específico.

### Los montos se ven mal

Asegúrate de usar montos en dólares (ej., 45.99) al crear transacciones a través de la IA, no valores en centavos (ej., 4599). Crow maneja la conversión automáticamente.
