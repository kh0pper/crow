# {{SKILL_NAME}} Skill

## Description
{{DESCRIPTION}} — a compound workflow that combines multiple tools and integrations.

## When to Use
- When the user says "{{TRIGGER_PHRASE_1}}"
- When the user says "{{TRIGGER_PHRASE_2}}"
- {{ADDITIONAL_CONDITION}}

## Tools Used
- `crow_store_memory` / `crow_search_memories` — Memory persistence
- `{{tool_1}}` — {{Purpose}}
- `{{tool_2}}` — {{Purpose}}

## Workflow: {{WORKFLOW_NAME}}

### Transparency Checkpoint
**[crow checkpoint: Running "{{WORKFLOW_NAME}}". Steps: 1) {{Step1}} 2) {{Step2}} 3) {{Step3}}. Say "skip" to cancel or "skip step N" to omit a step.]**

### Steps
1. **{{Step1}}** — {{Description}}
   - Call `{{tool}}` with {{parameters}}
   - *[crow: step 1/N — {{status}}]*

2. **{{Step2}}** — {{Description}}
   - Call `{{tool}}` with {{parameters}}
   - *[crow: step 2/N — {{status}}]*

3. **{{Step3}}** — {{Description}}
   - Call `{{tool}}` with {{parameters}}
   - *[crow: step 3/N — {{status}}]*

4. **Store** — Save the workflow result
   - Call `crow_store_memory` with summary and tags

## Error Handling
- If {{tool}} fails: {{fallback action}}
- If no results found: {{alternative approach}}

## Best Practices
- Always show the transparency checkpoint before starting
- Let users skip individual steps
- Store workflow results in memory for future reference
- Tag memories with "{{SKILL_ID}}" for easy retrieval
