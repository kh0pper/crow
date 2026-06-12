# Escribir Skills

Los skills son archivos markdown que le enseñan a la IA flujos de trabajo específicos. Son la forma más simple de contribuir a Crow — no se requiere código.

## ¿Qué es un skill?

Un skill es un prompt de comportamiento almacenado en `skills/`. Cuando la intención de un usuario coincide con un patrón disparador, la IA carga el archivo del skill relevante y sigue sus instrucciones. Los skills definen **qué hacer** y **qué herramientas usar**.

## Anatomía de un skill

Cada archivo de skill sigue esta estructura:

```markdown
# Nombre del skill

## Description
Resumen de un párrafo sobre lo que hace este skill.

## When to Use
- Lista de condiciones disparadoras
- Cuando el usuario dice "..."
- Cuando se detecta una condición específica

## Tools Available
- **tool_name** — Qué hace
- **another_tool** — Qué hace

## Workflow: Nombre del flujo de trabajo
1. Primer paso
2. Segundo paso — llama a `tool_name` con parámetros
3. Tercer paso — almacena los resultados con `crow_store_memory`

## Best Practices
- Consejos para un uso efectivo
- Errores comunes a evitar
```

## Agregar disparadores

Después de crear tu archivo de skill, agrega una fila a la tabla de disparadores en `skills/superpowers.md`:

```
| "english trigger", "another trigger" | "spanish trigger" | your-skill | primary-tools |
```

### Disparadores multilingües

Crow soporta detección de intención multilingüe. Proporciona frases disparadoras al menos en inglés. Agregar español (u otros idiomas) es recomendable pero opcional. La IA detecta la intención en **cualquier** idioma — los ejemplos son ilustrativos.

## Flujos de trabajo compuestos

Los skills pueden combinar varias herramientas de distintos servidores:

```markdown
## Workflow: Correo con resumen de investigación
1. Busca memorias sobre el tema con `crow_search_memories`
2. Lista las fuentes del proyecto con `crow_list_sources`
3. Redacta un resumen
4. Envíalo vía `send_gmail_message`
5. Almacena la acción en memoria con `crow_store_memory`
```

## Transparencia

Los skills deben incluir líneas de transparencia para que los usuarios puedan ver lo que está sucediendo:

```markdown
*[crow: paso 1/3 — busqué en las memorias, encontré 5 elementos relevantes]*
*[crow: paso 2/3 — redacté un resumen a partir de 3 fuentes]*
```

## Directorio de skills del usuario

Los skills en `skills/` forman parte del repo y se sobrescriben con `git pull` o con las actualizaciones. Para proteger tus personalizaciones:

- **Directorio de overrides del usuario**: `~/.crow/skills/` — Los skills que están aquí tienen precedencia sobre los de `skills/` del repo. Si existen tanto `~/.crow/skills/sharing.md` como `skills/sharing.md`, gana la versión del usuario.
- **Skills instalados desde el marketplace**: Los skills instalados desde el panel de Extensiones se colocan automáticamente en `~/.crow/skills/`, así que están a salvo de las actualizaciones.
- **Skills personalizados**: Coloca cualquier skill personalizado que escribas en `~/.crow/skills/` para conservarlo entre actualizaciones.

La IA revisa primero `~/.crow/skills/` al cargar un skill. Si un skill no se encuentra ahí, recurre al directorio `skills/` del repo.

::: tip
Para personalizar un skill integrado sin perder tus cambios al actualizar, cópialo a `~/.crow/skills/` y edita la copia:
```bash
mkdir -p ~/.crow/skills
cp skills/sharing.md ~/.crow/skills/sharing.md
# Edita ~/.crow/skills/sharing.md según necesites
```
:::

## Pruebas

Los skills son markdown — no hay paso de build. Para probar:
1. Coloca el archivo en `skills/` o en `~/.crow/skills/`
2. Agrega la fila del disparador a `skills/superpowers.md`
3. Inicia una conversación y usa una de las frases disparadoras
4. Verifica que la IA siga el flujo de trabajo correctamente

## Enviar

1. Abre un issue de [Propuesta de Skill](https://github.com/kh0pper/crow/issues/new?template=skill-proposal.md)
2. Haz un fork del repo, agrega tu archivo de skill y envía un PR
