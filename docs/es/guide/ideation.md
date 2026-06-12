---
title: Ideación — De notas a planes
---

# Ideación — De notas a planes

Convierte notas sin estructura, volcados mentales e ideas dispersas en planes organizados y accionables.

## Cómo funciona

Pega tus notas en bruto en una conversación con Crow y pídele que las organice. Crow va a:

1. **Analizar** tus notas y separarlas en elementos discretos
2. **Agrupar** los elementos relacionados por tema
3. **Cruzar referencias** con tus proyectos y memorias existentes
4. **Resolver** contradicciones o ambigüedades preguntándote
5. **Organizar** el resultado como tú prefieras

## Primeros pasos

Solo pega tus notas y di algo como:

> "Aquí están mis notas de la reunión de hoy — organízalas"

> "Volcado mental: [tus notas]. Ayúdame a ordenarlas en un plan"

> "Tengo un montón de ideas para el proyecto. Aquí están: [notas]"

Crow maneja entradas desordenadas — fragmentos, errores de tipeo, temas mezclados, incluso idiomas mezclados.

## Opciones de salida

Después de organizar tus notas, Crow puede:

- **Distribuirlas en proyectos** — adjuntar notas a proyectos de investigación existentes de Crow
- **Crear proyectos nuevos** — abrir proyectos para los temas nuevos que identificó
- **Guardarlas en memoria** — conservar decisiones clave o contexto para sesiones futuras
- **Generar un plan** — producir un plan de implementación estructurado y por fases
- **Devolver una lista limpia** — solo entregarte los grupos organizados sin guardar nada

Puedes combinar estas opciones — por ejemplo, distribuir algunas notas en proyectos y generar un plan para el resto.

## Ejemplo

**Entrada:**
```
- hay que arreglar el bug del login
- ¿quizás agregar modo oscuro?
- hablar con Maria sobre el cronograma del Q3
- el modo oscuro debería funcionar también en móvil
- el límite de tasa de la API es muy bajo para producción
- la fecha límite del Q3 es el 15 de julio
- el bug del login podría estar relacionado con el cambio del token de sesión de la semana pasada
```

**Salida:**

Crow identifica tres grupos:
1. **Bug del login** (elementos 1, 7) — conectado con el trabajo previo sobre el token de sesión
2. **Modo oscuro** (elementos 2, 4) — funcionalidad nueva, requiere considerar el móvil
3. **Planificación del Q3** (elementos 3, 6) — sensible a la fecha límite, involucra a Maria

Luego te pregunta qué quieres hacer: crear tareas, guardarlas en un proyecto o generar un plan por fases.

## Consejos

- Para volcados mentales grandes (20+ elementos), Crow te muestra primero los grupos antes de preguntar qué hacer
- Si ya has organizado notas antes, Crow recuerda tu estilo preferido
- Las notas sobre personas se cruzan con tus contactos
- Los elementos sensibles al tiempo se marcan de forma destacada
