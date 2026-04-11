---
name: vikunja
description: Manage Vikunja tasks — create projects, track tasks, set priorities and due dates, organize with labels
triggers:
  - vikunja
  - tasks
  - todo list
  - kanban
  - task manager
  - create task
  - project management
tools:
  - crow-vikunja
  - crow-memory
---

# Vikunja Task Management

## When to Activate

- User asks to create, update, or manage tasks
- User mentions Vikunja, todo list, or task manager
- User asks about project progress, overdue tasks, or priorities
- User wants to organize work into projects
- User asks to check what tasks are due or pending

## Workflow 1: List and Review Tasks

1. Use `crow_vikunja_projects` to list available projects
2. Use `crow_vikunja_tasks` with the project ID to show tasks
   - Filter by `done: false` for open tasks
   - Sort by `priority`, `due_date`, or `updated`
   - Use pagination for projects with many tasks
3. Present tasks with their status, priority, due date, and labels
4. For details on a specific task, use `crow_vikunja_get_task`

## Workflow 2: Create Tasks

1. If no project is specified, use `crow_vikunja_projects` and ask the user which project
2. Use `crow_vikunja_create_task` with:
   - `project_id` (required)
   - `title` (required)
   - `description` (optional, markdown)
   - `priority` (0=unset, 1=low, 2=medium, 3=high, 4=urgent, 5=do now)
   - `due_date` in ISO 8601 format (e.g., "2026-04-15T17:00:00Z")
3. Confirm the task was created with its ID

## Workflow 3: Update Tasks

1. Use `crow_vikunja_get_task` to fetch current state
2. Use `crow_vikunja_update_task` with the changes:
   - Mark complete: `done: true`
   - Change priority: `priority: 3` (high)
   - Set due date: `due_date: "2026-04-20T00:00:00Z"`
   - Clear due date: `due_date: ""`
3. Only send fields that changed
4. Confirm the update

## Workflow 4: Create Projects

1. Use `crow_vikunja_create_project` with:
   - `title` (required)
   - `description` (optional)
2. Confirm the project was created with its ID
3. Offer to create initial tasks for the project

## Workflow 5: Check Overdue and Priority

1. Use `crow_vikunja_tasks` with `done: false` and `sort_by: "due_date"`
2. Identify overdue tasks (due_date in the past)
3. Highlight urgent/high priority items
4. Suggest next actions or offer to update status

## Workflow 6: Delete Tasks

1. Always confirm with the user before deletion (this is irreversible)
2. Use `crow_vikunja_delete_task` with:
   - `id` of the task
   - `confirm` set to "yes"
3. Confirm the deletion

## Tips

- Vikunja priority scale: 0=unset, 1=low, 2=medium, 3=high, 4=urgent, 5=do now
- Due dates must be in ISO 8601 format (e.g., "2026-04-15T17:00:00Z")
- Use `crow_vikunja_labels` to see available labels for context
- Store the user's default project ID in memory for quick task creation
- When creating multiple tasks, batch them efficiently
- Vikunja projects support kanban views in the web UI

## Error Handling

- If Vikunja is unreachable: "Can't connect to Vikunja at the configured URL. Make sure the server is running."
- If auth fails (401): "Vikunja rejected the API token. Check VIKUNJA_API_TOKEN in settings. You can create a new token in Vikunja under Settings > API Tokens."
- If permission denied (403): "The API token doesn't have access to this resource."
- If not found (404): the task or project may have been deleted
