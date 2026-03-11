# Data Backends

Data backends let you connect external data sources -- databases, APIs, and other MCP servers -- to Crow projects. Instead of manually importing data, you register a backend and Crow can query it on demand, capture knowledge from it, and track it alongside your other project work.

## What is a Data Backend?

A data backend is an MCP server that Crow knows how to reach. When you register one, Crow stores its connection details and can inspect its schema (available tools) and route queries to it through your projects.

Think of it as the difference between copying data into Crow versus connecting Crow to where the data lives. The backend stays authoritative; Crow provides the project layer on top -- notes, sources, organization, and cross-platform access.

## When to Use Data Backends

Data backends are useful when:

- You have an existing database (Postgres, MySQL, SQLite) with data you want to query through your AI
- You run an MCP server that exposes domain-specific tools (e.g., a Canvas LMS server, a financial data server)
- You want to capture findings from external data as research sources or notes without manually copy-pasting
- You need to work with live data that changes over time, rather than static snapshots

## Registering a Backend

Use the `crow_register_backend` tool to connect an MCP server as a data backend:

> "Register my Postgres MCP server at http://localhost:5433/mcp as a data backend called 'course-database'"

This stores the backend's name, URL, and description in the `data_backends` table. You can then associate it with a `data_connector` type project.

### Required Information

| Field | Description |
|---|---|
| `name` | A short name for the backend (e.g., "course-database", "student-records") |
| `server_url` | The MCP server URL (Streamable HTTP endpoint) |
| `description` | What data this backend provides (helps the AI know when to use it) |

## Managing Backends

### List registered backends

> "Show me my data backends"

The `crow_list_backends` tool returns all registered backends with their names, URLs, and descriptions.

### Inspect a backend's schema

> "What tools does the course-database backend provide?"

The `crow_backend_schema` tool connects to the backend and returns its available tools and their parameter schemas. This helps you understand what queries are possible.

### Remove a backend

> "Remove the course-database backend"

The `crow_remove_backend` tool deletes the registration. This does not affect the external MCP server itself -- it only removes Crow's reference to it.

## Data Connector Projects

When you create a project with `type: "data_connector"`, it is designed to work with registered backends:

> "Create a data connector project called 'Fall 2026 Course Analysis' and link it to the course-database backend"

Data connector projects support the same sources, notes, and tagging as research projects. The difference is workflow: instead of manually adding sources from web searches, you query a backend and capture the results as sources or notes.

## Knowledge Capture Workflow

A typical workflow with data backends:

1. **Register the backend** -- Connect the external MCP server
2. **Create a data connector project** -- Give your work a home
3. **Query the backend** -- Use the backend's tools to pull data
4. **Capture findings** -- Store interesting results as sources or notes in the project
5. **Analyze across projects** -- Search notes, generate reports, share with collaborators

The AI handles steps 3-4 naturally during conversation. When you ask a question that involves backend data, the AI can query the backend and offer to save the results to your project.

## Example: Connecting to Postgres

Suppose you have a Postgres MCP server running locally that exposes `query` and `list_tables` tools.

**1. Register it:**

> "Register a data backend called 'enrollment-db' at http://localhost:5433/mcp -- it has student enrollment data"

**2. Create a project:**

> "Create a data connector project called 'Enrollment Trends' linked to enrollment-db"

**3. Query and capture:**

> "Query the enrollment-db for total enrollments by department for the last 3 years, and save the results as a source in the Enrollment Trends project"

The AI queries the backend, formats the results, and stores them as a source with appropriate metadata.

## Security Considerations

- Backend URLs are stored in Crow's local database -- they are not shared with peers or exposed through the gateway
- Authentication to the backend MCP server is handled by the server itself (bearer tokens, OAuth, etc.)
- Crow does not cache backend data unless you explicitly capture it as a source or note
- Removing a backend does not delete any sources or notes that were captured from it
