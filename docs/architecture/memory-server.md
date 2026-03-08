# Memory Server

The memory server (`servers/memory/`) provides persistent, searchable memory across AI sessions.

## Tools

### crow_store_memory

Store a new piece of information in persistent memory.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string | Yes | The information to remember |
| `category` | string | No | Category: general, project, preference, person, process, decision, learning, goal |
| `context` | string | No | Additional context about when/why this was stored |
| `tags` | string | No | Comma-separated tags for filtering |
| `source` | string | No | Where this information came from |
| `importance` | number | No | 1-10 importance score (default: 5) |

### crow_search_memories

Search memories using full-text search (FTS5).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Search query |
| `category` | string | No | Filter by category |
| `min_importance` | number | No | Minimum importance threshold (1-10) |
| `limit` | number | No | Max results (default: 10) |

### crow_recall_by_context

Recall memories relevant to a given context. Uses FTS5 ranking to find the most relevant memories.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `context` | string | Yes | The context to match against |
| `limit` | number | No | Max results (default: 5) |

### crow_list_memories

List memories with optional filtering and sorting.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `category` | string | No | Filter by category |
| `tag` | string | No | Filter by tag (partial match) |
| `min_importance` | number | No | Minimum importance threshold (1-10) |
| `sort_by` | string | No | Sort order: recent, importance, accessed (default: recent) |
| `limit` | number | No | Max results (default: 20) |

### crow_update_memory

Update an existing memory.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | number | Yes | Memory ID to update |
| `content` | string | No | New content |
| `category` | string | No | New category |
| `tags` | string | No | New tags |
| `importance` | number | No | New importance score |

### crow_delete_memory

Delete a memory by ID.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | number | Yes | Memory ID to delete |

### crow_memory_stats

Get statistics about stored memories. No parameters — returns counts by category, tag distribution, and total memory count.

## Resources

### memory://categories

Returns the list of valid memory categories.

## Database

Memories are stored in the `memories` table with a companion `memories_fts` FTS5 virtual table for full-text search. SQLite triggers keep the FTS index in sync on insert, update, and delete.
