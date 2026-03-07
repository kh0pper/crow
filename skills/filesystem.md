# Filesystem Skill

## Description
Access and manage local files and directories through the Filesystem MCP server. Read documents, organize research materials, and manage downloads.

## When to Use
- When the user mentions "file", "folder", "directory", "download", or "document"
- When reading local documents (PDFs, text files, etc.)
- When organizing research materials on disk
- When checking what files exist in a directory

## Tools Available
The Filesystem MCP server provides:
- **Read file** — Read contents of any file in the allowed path
- **Write file** — Create or overwrite files
- **List directory** — Browse directory contents
- **Create directory** — Make new directories
- **Move/rename** — Move or rename files and directories
- **Search** — Find files by name pattern
- **Get file info** — File metadata (size, modified date, etc.)

## Workflow: Import Local Documents
When the user wants to incorporate local files into research:
1. List the directory to find the file
2. Read the file contents
3. Extract key information
4. Add as a research source with `crow_add_source` (use file path as URL)
5. Create research notes from the content
6. Store reference in memory

## Workflow: Organize Research Downloads
1. List the downloads or target directory
2. Identify research-related files
3. Create organized subdirectories by project or topic
4. Move files into appropriate directories
5. Store the organizational scheme in memory

## Workflow: Export Research
When exporting research to local files:
1. Gather sources and notes from research pipeline
2. Generate bibliography
3. Write a formatted document to the filesystem
4. Store the file path in memory for reference

## Best Practices
- The server can only access paths under CROW_FILES_PATH (default: /home)
- Always verify file existence before reading
- Store important file paths in memory for cross-session access
- Use consistent naming conventions for research files
- Back up important files before overwriting
