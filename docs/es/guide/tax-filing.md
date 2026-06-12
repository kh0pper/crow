---
title: Asistente de Declaración de Impuestos
---

# Asistente de Declaración de Impuestos

Prepara impuestos federales sobre la renta con ingesta de documentos, cálculo automatizado, generación de PDF y presentación guiada a través de los Free File Fillable Forms del IRS.

## Qué obtienes

- **20 herramientas MCP** para gestionar declaraciones de impuestos
- **Extracción de documentos PDF** — sube PDFs de W-2, 1099 y 1098 y Crow lee los valores
- **Motor de cálculo de impuestos** — tablas de impuestos federales de 2024 y 2025
- **Panel del dashboard** — sube, verifica y gestiona documentos fiscales
- **PDFs del IRS rellenados** — genera el 1040, Schedule 1, Form 8889 y Form 8863 completados
- **Soporte de presentación por FFFF** — presentación guiada paso a paso vía Free File Fillable Forms

## Instalación

1. Abre la página de **Extensiones** en tu dashboard del Crow's Nest
2. Busca **Tax Filing Assistant** y haz clic en **Install**
3. Ingresa una clave de cifrado cuando se te solicite (esto cifra la PII en reposo)
4. El gateway se reinicia automáticamente — el panel de Tax Filing aparece en la barra lateral

## Subida de documentos

Ve a **Tax Filing → Documents** en la barra lateral.

### Subir

1. Selecciona el tipo de documento (W-2, 1099-SA, 1098-T, etc.)
2. Selecciona el propietario: **Taxpayer** (contribuyente), **Spouse** (cónyuge) o **Joint** (conjunto)
3. Elige el archivo PDF y haz clic en **Upload & Extract**

Crow extrae los valores automáticamente usando una pipeline de extracción dual:
- **Parser estructural** — para W-2 con texto concatenado (p. ej., el formato de Austin ISD)
- **Parser posicional** — para PDFs donde los valores están en capas de texto separadas (p. ej., el formato de ILTexas)

El sistema prueba ambos métodos y elige el que extrae más campos.

### Verificar

Después de subirlo, cada documento muestra un formulario editable con los valores extraídos. Los campos con baja confianza se resaltan en naranja.

**Verifica siempre los valores extraídos contra tu documento real antes de confirmar.** La extracción de PDF no es perfecta — algunos campos pueden estar mal o faltar.

Para los W-2, el formulario muestra:
- Nombre y SSN del empleado (se usan para autocompletar la declaración)
- Todos los valores de las casillas (1-6, 16-17)
- EIN y nombre del empleador

### Gestionar documentos

- **Confirm Values** — guarda los datos verificados
- **Edit** — devuelve un documento confirmado al estado editable
- **Delete** — elimina el documento (con diálogo de confirmación)

## Tipos de documentos soportados

| Tipo | Qué extrae |
|------|-----------------|
| **W-2** | Salarios, retenciones, SS/Medicare, empleador, EIN, nombre/SSN del empleado, códigos de la casilla 12 |
| **1099-SA** | Distribuciones de HSA, código de distribución, pagador |
| **1098-T** | Matrícula pagada, becas, institución, nombre del estudiante, estatus de posgrado/medio tiempo |
| **1098-E** | Intereses de préstamos estudiantiles, prestamista |
| **1098** | Intereses hipotecarios |
| **1099-INT/DIV/NEC/G/MISC** | Varios tipos de ingresos |

## Preparar una declaración

### Por chat BYOAI

La forma más simple — dile a tu asistente de IA:

> "Prepara mi declaración de impuestos. Declaración conjunta, 2025."

La herramienta `crow_tax_prepare_from_documents` de Crow crea la declaración en una sola llamada:
- Agrega todos los W-2, 1099 y 1098 confirmados
- Autocompleta los nombres/SSN del contribuyente y del cónyuge a partir de los documentos W-2
- Autoconfigura la HSA a partir del código W del W-2 + los datos del 1099-SA
- Calcula la declaración

La IA luego hará preguntas aclaratorias:
- **Tipo de programa** — pregrado, posgrado, profesional o técnico (afecta el crédito educativo)
- **Gastos de educador** — quién es el educador y cuánto
- **Cobertura de HSA** — individual o familiar
- **Situaciones especiales** — elección 6013(h) para cónyuge no residente

### Por herramientas MCP directamente

Para Claude Code u otros clientes MCP, usa las herramientas en secuencia:

```
crow_tax_new_return → crow_tax_add_w2 → crow_tax_add_1099 →
crow_tax_add_1098 → crow_tax_set_hsa → crow_tax_add_education_credit →
crow_tax_add_deduction → crow_tax_calculate → crow_tax_generate_pdfs
```

## Referencia de herramientas MCP

| Herramienta | Descripción |
|------|-------------|
| `crow_tax_prepare_from_documents` | De una sola vez: crea la declaración a partir de todos los documentos confirmados |
| `crow_tax_get_documents` | Lista los documentos subidos/confirmados |
| `crow_tax_new_return` | Crea una nueva declaración |
| `crow_tax_add_w2` | Agrega un W-2 |
| `crow_tax_add_1099` | Agrega un 1099 (SA, INT, DIV, NEC, G, MISC) |
| `crow_tax_add_1098` | Agrega un 1098 (E para préstamo estudiantil, principal para hipoteca) |
| `crow_tax_add_deduction` | Agrega deducciones (educador, caritativas, médicas, SALT, IRA) |
| `crow_tax_add_dependent` | Agrega un dependiente |
| `crow_tax_set_hsa` | Configura los detalles de la HSA |
| `crow_tax_set_self_employment` | Agrega ingresos del Schedule C |
| `crow_tax_set_capital_gains` | Agrega transacciones del Schedule D |
| `crow_tax_add_education_credit` | Agrega el crédito educativo del 1098-T (AOTC o LLC) |
| `crow_tax_set_special` | Configura la elección 6013(h), 65+ años, ceguera |
| `crow_tax_calculate` | Ejecuta el cálculo completo con registro de auditoría |
| `crow_tax_validate` | Revisa errores y advertencias |
| `crow_tax_get_form` | Obtiene los valores línea por línea de un formulario específico |
| `crow_tax_generate_pdfs` | Rellena los formularios PDF del IRS |
| `crow_tax_filing_guide` | Genera instrucciones de presentación por FFFF |
| `crow_tax_ingest_document` | Lee un PDF y extrae los datos |
| `crow_tax_purge_return` | Elimina de forma segura los datos de la declaración |

## Créditos educativos

El sistema soporta dos créditos educativos:

| Crédito | Elegibilidad | Crédito máximo | Reembolsable |
|--------|------------|------------|------------|
| **AOTC** (American Opportunity) | Pregrado, primeros 4 años | $2,500 | 40% ($1,000) |
| **LLC** (Lifetime Learning) | Cualquier educación postsecundaria (posgrado, técnica, profesional) | $2,000 | No |

El tipo de crédito se determina por el tipo de programa, no solo por la casilla 9 del 1098-T. La IA te preguntará en qué tipo de programa estás inscrito.

## Seguridad

- **La PII se cifra en reposo** usando AES-256-GCM con una frase de contraseña proporcionada por el usuario
- **Los SSN se extraen de los documentos** y se almacenan cifrados — nunca se envían a la IA en texto plano
- **Los PDFs de los documentos** se guardan localmente en `~/.crow/tax-documents/` (no se suben a la nube)
- **La IA nunca ve tu SSN** — la herramienta compuesta lo autocompleta desde el almacenamiento cifrado

## Limitaciones

- **Solo declaraciones federales** — no cubre impuestos estatales sobre la renta
- **No sustituye la asesoría fiscal profesional**
- **La extracción de PDF puede ser inexacta** — verifica siempre los valores extraídos
- **Años fiscales 2024 y 2025** soportados
