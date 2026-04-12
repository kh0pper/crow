# Maker Lab — Lesson JSON Schema

Lessons live as JSON files under `bundles/maker-lab/curriculum/age-<band>/`.

Teachers and parents can add custom lessons without touching code. Place the
file at `~/.crow/bundles/maker-lab/curriculum/custom/<id>.json`. The kiosk
will pick them up at request time (no restart).

Validate a lesson via the MCP tool `maker_validate_lesson`. It returns specific
errors like `missing: canned_hints[]` or `reading_level must be a number <= 3`.

## Required fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable unique id. Used in URLs and progress logs. Alphanumeric + dash. |
| `title` | string | Short human title, spoken to the kid. |
| `surface` | string | Which maker surface: `"blockly"`, `"scratch"`, `"kolibri"`. |
| `age_band` | enum | One of `"5-9"`, `"10-13"`, `"14+"`. |
| `steps` | array | One or more `{ prompt, solution_hint? }` objects. |
| `canned_hints` | array of strings | Fallback hints when the LLM is unavailable or filtered. At least one required. |

## Optional fields

| Field | Type | Notes |
|---|---|---|
| `goal` | string | Short description for the tutor's system prompt. |
| `reading_level` | number | Self-declared grade. For `5-9`, must be `<= 3`. |
| `starter_workspace` | string | Blockly XML to prefill the workspace. |
| `success_check` | object | Lightweight pattern-match against submitted workspace XML. |
| `background` | string | Lesson cover image filename in the bundle's assets dir. |
| `tags` | array of strings | For organization. |

## Example

```json
{
  "id": "blockly-01-move-cat",
  "title": "Move the Cat",
  "surface": "blockly",
  "age_band": "5-9",
  "reading_level": 2,
  "goal": "Drag a move block and run it to move the cat across the screen.",
  "steps": [
    { "prompt": "Drag the 'move' block into the workspace." },
    { "prompt": "Click the green play button!" }
  ],
  "canned_hints": [
    "Look for the block shaped like a little arrow!",
    "Try dragging it right under the 'when start' block.",
    "The green play button is at the top!"
  ],
  "tags": ["sequences", "starter"]
}
```

## Authoring tips

- Keep `canned_hints` short and warm. They're the safety net when everything else fails.
- `steps[].prompt` is **not** spoken verbatim. The tutor paraphrases it through the persona filter.
- Prefer **questions** over directives for the 5-9 band: "What do you think this block does?" beats "Drag this block."
- If a lesson needs words the blocklist rejects ("hell", "damn", "kill", etc. in anything other than a programming sense), find softer synonyms. The filter doesn't check context.
