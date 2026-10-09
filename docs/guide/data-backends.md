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

There are two kinds of backend, chosen with `backend_type` on `crow_register_backend`:

| Kind | What it is | `connection_ref` |
|---|---|---|
| `mcp_server` (default) | An MCP server Crow starts as a local command | `{"command":"npx","args":["-y","mcp-server-postgres"],"envVars":["POSTGRES_URL"]}` |
| `sqlite` | A SQLite file Crow reads, read-only | `{"path":"/home/alex/.crow/data/datasets/enrollment.db"}` |

> "Register the Postgres MCP server as a data backend called 'course-database'"

### An `mcp_server` backend waits for your approval

An `mcp_server` backend is a command your Crow will run, so registering one is never enough to run it. The AI (or a bot) can only create it in **pending approval**. To start it, open **Crow's Nest › Projects**, open the backend's project, and look under **Data Backends**. The page shows exactly what would run: the command, every argument on its own line (invisible or non-ASCII characters appear as `\u{…}` codes), and the exact names of the environment variables it gets. Press **Approve and run exactly this** to approve it; **Stop running it** withdraws the approval.

`connection_ref` may contain only `command`, `args`, `envVars` and `command_sha256`. A registration with any other key, or too long to show in full, cannot be approved.

What an approval covers:

- **The command line.** Any later change to the registration sends it back to waiting.
- **The files it runs.** Approval pins the current contents of the launcher (when it is a file path) and of every argument that names an existing file, such as the script an interpreter runs, except root-owned system files. Editing one of those files stops it from starting until you approve it again.
- **Not** code the command downloads when it starts (for example `npx` or `uvx` packages), and not other files a script opens by itself.

The launcher is checked when you approve and again every time it starts, with the same rules as add-ons: `node`, `npm` and `npx` are the gateway's own; any other bare name (such as `uvx`) must be found in a root-owned system directory; a launcher anywhere else must be an absolute path with its SHA-256 in `command_sha256`; a `uv`/`uvx` `--from git+…` source must name a full commit SHA. A `command_sha256` in the registration was supplied by whoever registered it — the page says so, and says when the launcher is not owned by root.

**Environment.** The backend does not inherit the gateway's environment. It gets the same basic allowlist bots get (such as `PATH`, `HOME`, locale and proxy settings; nothing that looks like a credential) plus only the variables named in `envVars`, with their values from your `.env`. The page lists every name it will get.

### A `sqlite` backend is a dataset

The file must live in your data folder's `datasets/` folder (for example `~/.crow/data/datasets/`) or in a project's `databases/` folder (where the Data Dashboard creates databases). Crow opens it read-only and never writes to it. Crow's own databases (`crow.db`, `tasks.db`) can never be registered, including through a link.

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

> "Register the Postgres MCP server as a data backend called 'enrollment-db' -- it has student enrollment data"

Then approve it in Crow's Nest › Projects (see above); until then it does not run.

**2. Create a project:**

> "Create a data connector project called 'Enrollment Trends' linked to enrollment-db"

**3. Query and capture:**

> "Query the enrollment-db for total enrollments by department for the last 3 years, and save the results as a source in the Enrollment Trends project"

The AI queries the backend, formats the results, and stores them as a source with appropriate metadata.

## Security Considerations

- Registering an `mcp_server` backend never runs anything: only the owner, signed in to Crow's Nest, can approve a command, and an approval stops applying the moment the command or a file it runs changes
- An approved backend gets an allowlisted environment plus its declared variables, never the gateway's whole environment
- Backends are never copied from peers: a shared project carries a description of its backends, not a runnable registration
- `sqlite` datasets are opened read-only, one statement per query, with a row cap, a size cap and a time limit (a query runs in a separate process that is stopped at the limit)
- Credentials stay in `.env`; the database stores environment variable names only
- Removing a backend does not delete any sources or notes that were captured from it
