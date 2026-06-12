---
title: Personalización
---

# Personalización

Haz que Crow se comporte como tú quieras — en todas las plataformas — con solo pedirlo.

## ¿Qué es crow.md?

Cada instancia de Crow tiene un conjunto de instrucciones llamado **crow.md** que le dice a tu IA cómo comportarse. Piensa en él como un archivo de personalidad y preferencias. Controla cosas como:

- Cómo se presenta Crow
- Cómo se guardan y recuperan las memorias
- Qué sucede al inicio y al final de cada sesión
- Las reglas de transparencia (lo que Crow te cuenta sobre las acciones tras bambalinas)
- Qué skills y herramientas están disponibles

A diferencia de un archivo de configuración enterrado en alguna carpeta, crow.md vive en tu base de datos. Eso significa que viaja con tus datos — ya sea que hables con Crow a través de Claude, ChatGPT, Gemini o cualquier otra plataforma soportada.

## Por qué importa

Sin crow.md, cada plataforma de IA trataría a Crow como una hoja en blanco. Con él, Crow se comporta de forma consistente sin importar desde dónde te conectes:

- **La misma personalidad** — Tus preferencias de tono, idioma y nivel de detalle aplican en todas partes
- **Los mismos protocolos** — El manejo de la memoria, los saludos de sesión y las reglas de transparencia se mantienen iguales
- **Portátil** — Cambia de plataforma o de dispositivo y tus personalizaciones te acompañan

## Cómo personalizar

No necesitas abrir ningún archivo ni escribir código. Solo habla con tu IA. Crow tiene herramientas que actualizan tu contexto tras bambalinas — específicamente `crow_update_context_section` y `crow_add_context_section` — pero nunca necesitas llamarlas directamente. Basta con una petición simple.

### Establecer una preferencia de idioma

> "Crow, actualiza mi contexto para preferir respuestas en español"

Crow actualiza tu contexto para que cada sesión futura — en cualquier plataforma — use español por defecto. También puedes ser más específico:

> "Crow, responde en español pero mantén los términos técnicos en inglés"

### Agregar contexto sobre tu trabajo

> "Crow, agrega una sección de contexto sobre mi trabajo. Soy profesor de biología de secundaria y uso Crow principalmente para planear clases y dar seguimiento a los proyectos de mis estudiantes."

Esto crea una sección personalizada en tu crow.md que Crow consultará al ayudarte, para poder adaptar sus sugerencias a tu situación sin que tengas que repetirte.

### Ajustar la transparencia

> "Crow, no necesito los avisos sobre qué herramientas estás usando. Mantenlo al mínimo."

Crow actualizará las reglas de transparencia para reducir los mensajes informativos durante tus sesiones.

### Agregar contexto específico de un proyecto

> "Crow, agrega una sección de contexto para mi proyecto de renovación de la casa. Estamos remodelando la cocina — el presupuesto es de $15,000, el contratista empieza en abril y estoy llevando registro de materiales y recibos."

Ahora, cuando le preguntes a Crow sobre tu renovación, ya conoce los detalles clave.

### Pedir respuestas concisas

> "Crow, actualiza mi contexto para preferir respuestas cortas y concisas. Sáltate el preámbulo."

Esto ajusta cómo Crow se comunica contigo en todas las plataformas.

## Ver tu contexto

Para ver cómo luce tu crow.md actualmente, solo pregunta:

> "Muéstrame mi crow.md"

También puedes pedir secciones específicas:

> "¿Cuáles son mis reglas de transparencia actuales?"

Bajo el capó, esto usa la herramienta `crow_get_context`, pero no necesitas recordarlo.

### Secciones predeterminadas

Cada instancia de Crow comienza con estas secciones:

| Sección | Qué controla |
|---|---|
| **identity** | Cómo se presenta Crow y cómo te llama |
| **memory_protocol** | Reglas para guardar, recuperar y gestionar memorias |
| **session_protocol** | Qué sucede al inicio y al final de cada conversación |
| **transparency_rules** | Cuándo y cómo Crow te informa sobre las acciones tras bambalinas |
| **skills_reference** | Qué skills están disponibles y cómo se activan |

## Secciones protegidas vs personalizadas

Las cinco secciones predeterminadas listadas arriba están **protegidas**. Puedes editar su contenido libremente, pero no puedes eliminarlas — proporcionan el marco de comportamiento central que mantiene a Crow funcionando correctamente.

Las **secciones personalizadas** son las que tú mismo creas (como los ejemplos de arriba sobre el contexto de trabajo o el proyecto de renovación). Estas se pueden agregar, actualizar y eliminar en cualquier momento:

> "Crow, elimina la sección de contexto sobre mi proyecto de renovación"

No hay límite en cuántas secciones personalizadas puedes agregar.

## Skills personalizadas

El comportamiento de Crow está impulsado por **skills** — archivos markdown que definen flujos de trabajo para tareas específicas. Puedes personalizar skills o crear nuevas sin escribir código.

### Ver las skills

Desde el **Crow's Nest**, abre el panel de **Skills** para explorar todas las skills disponibles. Verás dos tipos:

- **Skills integradas** — Vienen con Crow y se actualizan cuando actualizas Crow. Son de solo lectura en el panel de Skills.
- **Skills de usuario** — Tus skills personalizadas o sobrescritas, guardadas en `~/.crow/skills/`. Tienen prioridad sobre las skills integradas y las actualizaciones nunca las sobrescriben.

### Personalizar una skill integrada

Si una skill integrada no te funciona del todo, sobrescríbela:

> "Crow, quiero personalizar la skill de compartir para saltarme el paso de confirmación al compartir con mis contactos"

Crow copiará la skill integrada a tu directorio de usuario (`~/.crow/skills/sharing.md`) y aplicará tus cambios. Tu versión tendrá prioridad de ahí en adelante.

También puedes hacerlo manualmente desde el panel de Skills — haz clic en una skill integrada y luego en **Sobrescribir con copia personalizada**.

### Crear una nueva skill

Describe lo que quieres automatizar:

> "Crow, crea una skill para mi rutina matutina. Revisa mi correo, resume el calendario de hoy y lista las tarjetas de Trello que vencen esta semana."

Crow propondrá la skill, pedirá tu aprobación y luego la guardará en `~/.crow/skills/`. La skill se activa automáticamente cuando dices algo como "rutina matutina" o "resumen diario".

### Eliminar una skill personalizada

> "Crow, elimina mi skill personalizada de compartir"

Esto borra la sobrescritura de `~/.crow/skills/`, restaurando la versión integrada. También puedes eliminar skills desde el panel de Skills en el Crow's Nest.

### Instalar skills de la comunidad

Explora las skills de la comunidad en el panel de **Extensiones**. Las skills instaladas se colocan automáticamente en `~/.crow/skills/`, así que están a salvo de las actualizaciones.

---

## Contexto por dispositivo

Crow soporta **sobrescrituras por dispositivo** para que puedas tener preferencias distintas según desde dónde lo uses. Por ejemplo, respuestas detalladas en tu escritorio pero respuestas cortas en tu teléfono, o español en un dispositivo e inglés en otro.

### Cómo funciona

Cada dispositivo puede tener su propia versión de cualquier sección de crow.md. Cuando Crow se conecta desde un dispositivo específico, combina:

1. **Secciones globales** — tu configuración base (aplica en todas partes)
2. **Sobrescrituras específicas del dispositivo** — reemplazos de secciones específicas en un dispositivo en particular

Si una sección tiene una versión específica del dispositivo, se usa esa versión en lugar de la global. Las secciones sin sobrescrituras de dispositivo usan la versión global como de costumbre.

### Establecer preferencias por dispositivo

Solo dile a Crow en qué dispositivo estás y qué quieres:

> "Crow, en mi teléfono prefiero respuestas cortas. Agrega una sobrescritura de dispositivo para 'phone'."

> "Crow, cuando esté en mi laptop del trabajo (dispositivo: 'work-laptop'), responde con un tono más formal."

> "Crow, en la Raspberry Pi (dispositivo: 'colibri'), sáltate las secciones de contexto dinámicas para ahorrar ancho de banda."

Bajo el capó, esto crea una sección específica del dispositivo usando la herramienta `crow_add_context_section` con un parámetro `device_id`.

### Gestionar las sobrescrituras de dispositivo

Puedes ver qué sobrescrituras de dispositivo existen:

> "Lista mis secciones de crow.md y muestra cuáles tienen sobrescrituras de dispositivo"

Elimina una sobrescritura de dispositivo para restaurar la versión global en ese dispositivo:

> "Elimina la sobrescritura de identity para mi teléfono"

### Detalles técnicos

- Los **IDs de dispositivo** son cadenas de texto libres que tú eliges (p. ej., `"phone"`, `"grackle"`, `"work-laptop"`)
- Las secciones globales tienen `device_id = NULL`; las secciones de dispositivo tienen un `device_id` no nulo
- Las secciones protegidas (identity, memory_protocol, etc.) pueden tener sobrescrituras de dispositivo, pero la versión global no se puede eliminar
- Eliminar una sobrescritura de dispositivo restaura la versión global — no elimina la sección por completo
- El campo `instructions` de MCP (contexto auto-inyectado) también soporta `deviceId` para el contexto condensado por dispositivo

### Configurar un ID de dispositivo

Para habilitar el contexto por dispositivo, establece la variable de entorno `CROW_DEVICE_ID` antes de iniciar el gateway:

```bash
# En tu archivo .env
CROW_DEVICE_ID=grackle
```

Esto le dice a Crow en qué dispositivo está corriendo. El gateway y los servidores stdio aplican automáticamente las sobrescrituras de dispositivo correspondientes a las instrucciones MCP y a `crow.md`.

---

## Navegación de la barra lateral

La barra lateral del Crow's Nest organiza los paneles en grupos plegables. Puedes personalizar la agrupación, los nombres y el orden para que se ajusten a tu flujo de trabajo.

### Grupos predeterminados

La barra lateral viene con estos grupos:

| Grupo | Paneles |
|---|---|
| **Núcleo** | Inicio, Memoria, Mensajes, Contactos |
| **Contenido** | Blog, Podcasts, Skills |
| **Medios** | Media Hub (más las pestañas de los complementos de medios) |
| **Herramientas** | Archivos, Extensiones, Panel de Datos |
| **Sistema** | Configuración |

### Renombrar grupos

Cambia el nombre de un grupo desde **Crow's Nest** > **Configuración** > **Apariencia**, o pídelo:

> "Crow, renombra el grupo 'Contenido' de la barra lateral a 'Creativo'"

### Crear grupos nuevos

Agrega un grupo personalizado para organizar los paneles a tu manera:

> "Crow, crea un grupo en la barra lateral llamado 'Investigación' y mueve Memoria y Archivos ahí"

Los grupos personalizados aparecen en la barra lateral en el orden que especifiques.

### Mover paneles entre grupos

Reorganiza los paneles entre grupos:

> "Crow, mueve el panel de Blog de Contenido a un grupo nuevo llamado 'Publicaciones'"

También puedes arrastrar paneles entre grupos en la configuración del Crow's Nest.

### Plegar grupos

Haz clic en el encabezado de un grupo en la barra lateral para plegarlo o expandirlo. El estado plegado se recuerda por sesión.

### Cómo se autocategorizan los complementos

Cuando instalas un complemento (bundle) — como Jellyfin, Kodi o IPTV — su panel aparece automáticamente en el grupo apropiado:

- Los **complementos de medios** (Jellyfin, Plex, Kodi, IPTV) agregan pestañas al panel Media Hub del grupo **Medios**
- Los **complementos de conocimiento** (TriliumNext, Obsidian) aparecen en el grupo **Herramientas**
- Los **complementos de infraestructura** (Ollama, LocalAI) aparecen en el grupo **Sistema**

Puedes mover los paneles de los complementos a otros grupos después de la instalación.

---

## Puntos de control de seguridad

Crow usa un sistema de seguridad por niveles que pide confirmación antes de realizar acciones riesgosas. Esto sucede automáticamente — no necesitas habilitarlo.

### Nivel 1 — Acciones destructivas

Crow confirmará antes de publicar, eliminar o enviar cualquier cosa irreversible. Verás lo que está a punto de suceder y podrás cancelar:

- Eliminar archivos, entradas o memorias
- Publicar o despublicar entradas del blog
- Enviar mensajes (no se pueden retirar de los relays de Nostr)
- Compartir elementos con contactos
- Operaciones masivas que afectan 3 o más elementos

### Nivel 2 — Operaciones intensivas en recursos

Antes de instalar add-ons o complementos pesados, Crow verifica si tu dispositivo puede manejarlos. En dispositivos con recursos limitados (como una Raspberry Pi), recibirás una advertencia sobre el uso de recursos esperado.

### Nivel 3 — Cambios de red y seguridad

Cualquier cambio en la configuración de relays, reglas de firewall, visibilidad o ajustes de VPN requiere aprobación explícita. Crow mostrará exactamente qué cambiaría y esperará un "sí" claro.

### Personalizar el comportamiento de seguridad

Puedes ajustar estos puntos de control según tus preferencias:

> "Crow, sáltate la confirmación al eliminar borradores de entradas"

> "Crow, confirma siempre antes de cualquier acción de publicación"

Las personalizaciones de seguridad se guardan en tu crow.md y aplican en todas las plataformas.

---

## Ejemplos comunes de personalización

Aquí tienes algunas ideas más de lo que puedes hacer:

### Uso académico

> "Crow, agrega una sección de contexto para mi investigación. Soy estudiante de doctorado en lingüística computacional. Cuando agregue fuentes, incluye siempre los enlaces DOI. Prefiere citas en APA 7ª edición."

### Instancia familiar compartida

> "Crow, actualiza la sección de identidad. Somos la familia García. Usamos Crow para planear comidas, listas de compras y dar seguimiento a los eventos escolares."

### Hogar bilingüe

> "Crow, en la tableta de la cocina (dispositivo: 'kitchen'), responde siempre en español. En mi laptop, mantén el inglés."

### Enfocado en la privacidad

> "Crow, actualiza el protocolo de memoria. Nunca guardes información financiera personal ni contraseñas. Pregunta siempre antes de guardar datos relacionados con la salud."

### Flujo de trabajo de desarrollo

> "Crow, agrega una sección de contexto para mi entorno de desarrollo. Uso VS Code, prefiero TypeScript y despliego en Vercel. Cuando pregunte sobre código, asume Node.js 20+ a menos que diga lo contrario."

---

## Preguntas frecuentes

### ¿La personalización se sincroniza entre plataformas?

Sí. Como crow.md vive en tu base de datos (no en un archivo en un solo dispositivo), tus personalizaciones aplican ya sea que uses Claude, ChatGPT, Gemini o cualquier otra plataforma compatible con MCP.

### ¿Puedo romper algo al personalizar?

Las cinco secciones protegidas (identity, memory_protocol, session_protocol, transparency_rules, skills_reference) no se pueden eliminar, solo editar. Incluso si las editas con algo poco útil, siempre puedes restablecerlas:

> "Crow, restablece la sección memory_protocol a su valor predeterminado"

### ¿En qué se diferencia de CLAUDE.md?

**CLAUDE.md** es un archivo en el repositorio de Crow que les dice a los desarrolladores cómo construir y extender Crow. **crow.md** es tu configuración personal de comportamiento guardada en la base de datos. Sirven a audiencias completamente distintas — CLAUDE.md es para quienes construyen, crow.md es para quienes usan.

### ¿Puedo exportar mis personalizaciones?

Tu crow.md es parte de tu base de datos de Crow. Cuando respaldas tu base de datos (`npm run backup`), todas las personalizaciones se incluyen. También puedes ver tu contexto completo en cualquier momento:

> "Muéstrame mi crow.md completo"
