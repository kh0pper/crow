# Superpowers — Auto-Activation & Routing Skill

## Description
This is the master routing skill. Consult this **before every task** to determine which skills and tools to activate. It maps user intent to the right combination of MCP servers, skills, and workflows.

## Always-On Rules
1. **Memory first**: Before any task, check `crow_recall_by_context` for relevant prior context
2. **Behavioral context**: crow.md defines cross-platform behavioral instructions. Skills that modify behavior should check if crow.md sections need updating too (via `crow_update_context_section`)
3. **Language adaptation**: Check stored language preference (see `skills/i18n.md`). All user-facing output in user's language.
4. **Multi-tool by default**: Most tasks benefit from combining 2-3 tools
5. **Document as you go**: Important findings → `crow_store_memory`; external sources → `crow_add_source`
6. **Reflect when needed**: If friction accumulates, trigger the reflection skill
7. **Surface skill activation**: When a skill activates from the trigger table, show: *[crow: activated skill — \<skill-name\>.md]*
8. **Surface friction signals**: When noting a friction signal, show: *[crow: friction signal — \<description\> (\<N\> of 2 threshold)]*
9. **Transparency protocol**: Follow the Transparency Rules in crow.md (`transparency_rules` section) for all autonomous actions
10. **Skill loading**: When loading a skill, resolve it in this order: (1) `~/.crow/skills/<name>.md` — user overrides and marketplace-installed skills, (2) `skills/<name>.md` — built-in repo skills. If a user override exists, use it exclusively (do not merge with the repo version). This applies to all skill references in the trigger table below.
11. **Safety guardrails**: Before destructive, resource-intensive, or network-altering operations, follow the checkpoint protocol in `skills/safety-guardrails.md`. This applies to all tools across all skills.

---

## Trigger Table

**Multilingual matching**: The trigger phrases below are examples in English and Spanish. Match user intent in **ANY language** — these are illustrative, not exhaustive. See `skills/i18n.md` for the full language protocol.

| User Intent (EN) | User Intent (ES) | Activate Skills | Primary Tools |
|---|---|---|---|
| "remember", "store", "recall", "what did we..." | "recordar", "guardar", "recuperar", "qué hicimos..." | memory-management | crow-memory |
| "research", "find papers", "cite", "bibliography" | "investigar", "buscar artículos", "citar", "bibliografía" | research-pipeline, web-search | crow-projects, brave-search, arxiv |
| "connect to database", "data backend", "register backend" | "conectar base de datos", "backend de datos", "registrar backend" | data-backends | crow-projects |
| "show my backends", "list backends" | "mostrar backends", "listar backends" | data-backends | crow-projects |
| "query [backend name]", "data from [source]" | "consultar [backend]", "datos de [fuente]" | data-backends | crow-projects, crow-tools |
| "email", "calendar", "schedule", "meeting", "gmail" | "correo", "calendario", "agendar", "reunión" | google-workspace | google-workspace |
| "google chat", "chat space", "send chat" | "google chat", "espacio de chat", "enviar chat" | google-chat | google-workspace (chat tools) |
| "task", "board", "card", "sprint", "trello" | "tarea", "tablero", "tarjeta", "sprint" | project-management | trello |
| "assignment", "grade", "course", "canvas" | "tarea", "calificación", "curso", "canvas" | project-management | canvas-lms |
| "wiki", "notion", "page", "database" | "wiki", "notion", "página", "base de datos" | notion | notion |
| "slack", "slack message", "slack channel" | "slack", "mensaje de slack", "canal de slack" | slack | slack |
| "discord", "server", "guild" | "discord", "servidor" | discord | discord |
| "teams", "microsoft teams" | "teams", "microsoft teams" | microsoft-teams | microsoft-teams |
| "repo", "issue", "PR", "commit", "github" | "repositorio", "issue", "PR", "commit" | github | github |
| "search", "look up", "find out", "what is" | "buscar", "averiguar", "qué es" | web-search | brave-search |
| "file", "download", "document", "folder" | "archivo", "descargar", "documento", "carpeta" | filesystem | filesystem |
| "citation", "zotero", "library", "reference" | "cita", "zotero", "biblioteca", "referencia" | research-pipeline | zotero |
| "who are you", "crow.md", "customize behavior", "set up platform" | "quién eres", "crow.md", "personalizar", "configurar plataforma" | crow-context | crow-memory |
| "plan", "outline", "how would you", "what's your approach" | "planear", "esquematizar", "cómo lo harías", "cuál es tu enfoque" | plan-review | (depends on task) |
| "create a skill", "automate", "every time I..." | "crear una habilidad", "automatizar", "cada vez que..." | skill-writing | filesystem, crow-memory |
| "share with", "send to", "invite", "add contact" | "compartir con", "enviar a", "invitar", "agregar contacto" | sharing, onboarding | crow-sharing |
| "message", "chat", "DM", "send message to" | "mensaje", "chat", "DM", "enviar mensaje a" | social | crow-sharing |
| "my Crow ID", "network status", "block", "contacts" | "mi Crow ID", "estado de red", "bloquear", "contactos" | peer-network | crow-sharing |
| "inbox", "what did they share", "new shares" | "bandeja", "qué compartieron", "nuevos compartidos" | sharing, social | crow-sharing |
| "set up sharing", "export identity", "new device" | "configurar sharing", "exportar identidad", "nuevo dispositivo" | onboarding, peer-network | crow-sharing |
| "upload file", "store file", "storage", "download file" | "subir archivo", "almacenar", "descargar archivo" | storage | crow-storage |
| "blog post", "write a post", "publish", "blog settings" | "publicar", "escribir un post", "blog", "configuración del blog" | blog | crow-blog, crow-storage |
| "chord chart", "song", "songbook", "chords", "transpose", "setlist", "chord diagram", "music theory" | "acordes", "canción", "cancionero", "transponer", "setlist", "diagrama de acordes", "teoría musical" | songbook | crow-blog, crow-storage |
| "knowledge base", "resource guide", "KB", "community resources", "verify resources", "flag outdated" | "base de conocimiento", "guía de recursos", "recursos comunitarios", "verificar recursos" | knowledge-base (add-on) | crow-knowledge-base, crow-sharing |
| "news", "articles", "feed", "RSS", "briefing", "podcast", "youtube" | "noticias", "artículos", "podcast", "youtube" | media (add-on) | crow-media |
| "calibre", "ebook", "read book", "ebook library" | "calibre", "libro electrónico", "leer libro" | calibre-server, calibre-web (add-on) | crow-calibre-server, crow-calibre-web |
| "miniflux", "RSS reader", "subscribe feed", "news reader" | "miniflux", "lector RSS", "suscribir feed" | miniflux (add-on) | crow-miniflux |
| "audiobook", "audiobookshelf", "listen to book" | "audiolibro", "audiobookshelf", "escuchar libro" | audiobookshelf (add-on) | crow-audiobookshelf |
| "paperless", "scan document", "OCR", "document archive" | "paperless", "escanear documento", "OCR", "archivo documental" | paperless (add-on) | crow-paperless |
| "bookmark", "save link", "linkding", "shiori" | "marcador", "guardar enlace", "linkding", "shiori" | linkding, shiori (add-on) | crow-linkding, crow-shiori |
| "vikunja", "todo list", "task manager", "kanban" | "vikunja", "lista de tareas", "gestor de tareas", "kanban" | vikunja (add-on) | crow-vikunja |
| "actual budget", "personal finance", "budget tracking" | "actual budget", "finanzas personales", "presupuesto" | actual-budget (add-on) | crow-actual-budget |
| "crow's nest", "dashboard", "settings", "control panel" | "panel", "configuración", "panel de control" | network-setup | (dashboard routes) |
| "add-on", "extension", "install plugin", "browse extensions" | "complemento", "extensión", "instalar plugin" | add-ons | crow-memory, filesystem |
| "build extension", "create bundle", "develop panel", "new add-on for crow", "publish extension" | "crear extensión", "desarrollar panel", "nuevo complemento para crow" | extension-dev | crow-memory, filesystem |
| "developer kit", "build extension for crow", "submit add-on", "create crow extension", "publish to registry" | "kit de desarrollador", "crear extensión para crow", "enviar complemento", "publicar en registro" | developer-kit | crow-memory, filesystem |
| "what can you do", "getting started", "new to crow" | "qué puedes hacer", "cómo empezar", "nuevo en crow" | onboarding-tour | crow-memory |
| "tailscale", "remote access", "network setup", "private access", "VPN" | "tailscale", "acceso remoto", "configurar red", "acceso privado", "red privada" | network-setup, tailscale | (documentation) |
| "report bug", "file issue", "feature request", "found a bug" | "reportar bug", "crear issue", "solicitar función" | bug-report | crow-memory, github |
| "help my kid learn", "teach Ada coding", "start a STEM session", "maker lab", "classroom session", "tutor session", "try it without saving" | "ayuda a mi hijo aprender", "enseñar programación a Ada", "sesión STEM", "laboratorio creativo", "modo aula" | maker-lab | maker-lab, companion, crow-memory |
| "find a lesson", "teach me about X", "i want to learn", "homework help", "math practice", "reading practice", "science video", "khan academy", "kolibri" | "busca una lección", "enséñame sobre X", "quiero aprender", "ayuda con la tarea", "práctica de matemáticas", "video de ciencias", "kolibri" | kolibri | kolibri, crow-memory |
| "scratch", "scratch project", "step up from blockly", "make a game", "sprite", "block coding" | "scratch", "proyecto de scratch", "hacer un juego", "sprite", "programación con bloques" | scratch-offline | crow-memory |
| "vllm", "classroom engine", "scale to 25 learners", "gpu inference", "openai-compatible endpoint" | "vllm", "motor para aula", "escalar a 25 estudiantes", "inferencia con gpu" | vllm | crow-memory |
| "maker lab advanced", "jupyterhub", "jupyter notebook", "pair programmer", "teach me python", "python error", "debug my notebook" | "maker lab avanzado", "jupyterhub", "cuaderno jupyter", "programación en pareja", "enséñame python", "error de python", "depurar cuaderno" | maker-lab-advanced | maker-lab, crow-memory |
| "obsidian", "vault", "daily note", "sync to obsidian" | "obsidian", "bóveda", "nota diaria" | obsidian | obsidian, crow-projects |
| "lights", "temperature", "smart home", "turn on/off" | "luces", "temperatura", "hogar inteligente" | home-assistant | home-assistant |
| "ollama", "local model", "run locally", "embeddings" | "ollama", "modelo local", "ejecutar local" | ollama | crow-memory |
| "nextcloud", "nextcloud files" | "nextcloud", "archivos nextcloud" | nextcloud | filesystem |
| "photos", "pictures", "album", "immich" | "fotos", "imágenes", "álbum" | immich | immich |
| "camera", "security cam", "motion", "doorbell", "NVR", "who was at", "surveillance", "frigate" | "cámara", "vigilancia", "movimiento", "timbre", "quién estuvo en" | frigate (add-on) | crow-frigate |
| "back up", "backup", "restore data", "export data" | "respaldar", "backup", "restaurar datos", "exportar datos" | backup | filesystem |
| "delete", "remove", "bulk delete", "is this safe" | "eliminar", "borrar", "eliminar en masa", "es seguro" | safety-guardrails | (depends on action) |
| "test round", "run tests on", "test on claude.ai", "iterative testing" | "ronda de pruebas", "probar en claude.ai", "pruebas iterativas" | iterative-testing | crow-memory |
| "organize notes", "brain dump", "sort these ideas", "help me plan from these" | "organizar notas", "ideas sueltas", "ordenar estas ideas", "aquí están mis notas" | ideation | crow-memory, crow-projects |
| "schedule", "remind me", "every day at", "recurring" | "programar", "recuérdame", "cada día a las" | scheduling | crow-memory |
| "toot", "post to fediverse", "follow @user@...", "mastodon", "gotosocial", "activitypub" | "publicar en fediverso", "tootear", "seguir @usuario@...", "mastodon", "gotosocial" | gotosocial | crow-gotosocial |
| "writefreely", "federated blog", "long-form post", "publish article", "blog to fediverse" | "writefreely", "blog federado", "artículo largo", "publicar al fediverso" | writefreely | crow-writefreely |
| "matrix", "dendrite", "join #room:server", "send @user:server", "e2ee chat", "matrix room" | "matrix", "dendrite", "unirse a #sala:servidor", "mensaje a @usuario:servidor", "chat e2ee" | matrix-dendrite | crow-matrix-dendrite |
| "funkwhale", "federated music", "upload track", "follow channel", "music library", "fediverse audio", "podcast", "playlist" | "funkwhale", "música federada", "subir pista", "seguir canal", "biblioteca musical", "audio fediverso", "podcast", "lista de reproducción" | funkwhale | crow-funkwhale |
| "pixelfed", "post photo", "share picture", "photo feed", "fediverse photo", "instagram alternative" | "pixelfed", "publicar foto", "compartir imagen", "feed de fotos", "foto fediverso", "alternativa instagram" | pixelfed | crow-pixelfed |
| "lemmy", "link aggregator", "reddit alternative", "subscribe community", "post link", "fediverse discussion", "upvote" | "lemmy", "agregador enlaces", "alternativa reddit", "suscribir comunidad", "publicar enlace", "discusión fediverso" | lemmy | crow-lemmy |
| "mastodon", "toot", "fediverse", "activitypub", "@user@server", "federated timeline", "boost", "mastodon instance" | "mastodon", "tootear", "fediverso", "activitypub", "@usuario@servidor", "linea temporal federada", "reblog" | mastodon | crow-mastodon |
| "peertube", "upload video", "federated video", "video channel", "fediverse video", "youtube alternative", "webtorrent" | "peertube", "subir video", "video federado", "canal video", "video fediverso", "alternativa youtube" | peertube | crow-peertube |
| "attest identity", "prove I am", "link my mastodon", "verify handle", "keyoxide", "crow identity attestation", "revoke attestation" | "atestar identidad", "probar que soy", "vincular mi mastodon", "verificar handle", "keyoxide", "atestación identidad crow" | crow-identity | crow-sharing |
| "matrix bridge", "bridge signal", "bridge telegram", "bridge whatsapp", "mautrix", "signal to matrix", "telegram to matrix" | "puente matrix", "puente signal", "puente telegram", "puente whatsapp", "mautrix", "signal a matrix" | matrix-bridges | crow-matrix-dendrite |
| "cross-post", "crosspost", "mirror post to", "publish to both", "mastodon and", "share my post to" | "publicación cruzada", "crosspost", "replicar publicación", "publicar en ambos" | crow-crosspost | crow-sharing |
| "tutor me", "teach me", "quiz me", "help me understand" | "enséñame", "explícame", "evalúame" | tutoring | crow-memory |
| "wrap up", "summarize session", "what did we do" | "resumir sesión", "qué hicimos" | session-summary | crow-memory |
| "change language", "speak in..." | "cambiar idioma", "háblame en..." | i18n | crow-memory |
| Session start / Inicio de sesión | — | session-summary, i18n, skill-writing (deferred gap check) | crow-memory |
| High friction detected / Fricción detectada | — | reflection → skill-writing (handoff) | crow-memory, filesystem |
| Reflection identifies skill gap | — | reflection Phase 7 → skill-writing | crow-memory, filesystem |
| Multi-step task (3+ steps or 2+ files) | — | plan-review (auto-activate) | (depends on task) |
| Skill activated during session | — | skill-writing (usage logging) | crow-memory |

---

## Compound Workflows

### Transparency for Compound Workflows
Before running any compound workflow, show a checkpoint listing the steps:

**[crow checkpoint: Running "\<workflow name\>". Steps: 1) Gmail 2) Calendar 3) Trello 4) Memory. Say "skip" to cancel or "skip step N" to omit a step.]**

Then show FYI lines as each step completes:
*[crow: step 1/N — checked Gmail, 3 unread]*
*[crow: step 2/N — checked Calendar, 2 events today]*

This lets the user see progress and customize which steps run.

### "Daily briefing" / "What's going on?"
1. **Gmail** — Check for important/unread emails
2. **Calendar** — Today's and tomorrow's events
3. **Slack/Discord/Teams** — Recent messages in key channels
4. **Trello** — Cards assigned to user, due soon
5. **Canvas** — Upcoming assignments (if student)
6. **Memory** — Recall any stored reminders or pending items
7. Present a consolidated briefing

### "Prepare for meeting about X"
1. **Calendar** — Get meeting details and attendees
2. **Gmail** — Search for related email threads
3. **Memory** — Recall prior context about X
4. **Research** — Check for relevant sources and notes
5. **Slack/Chat** — Search for recent discussions about X
6. Summarize all context for the user

### "Start research on X"
1. **Memory** — Check for any existing context on X
2. **Research** — Create a research project with `crow_create_project`
3. **Brave Search** — Initial web search for overview
4. **arXiv** — Search arXiv for academic papers and retrieve full text
5. **Zotero** — Check if user already has relevant references
6. For each valuable source → `crow_add_source` with APA citation
7. Store initial findings in memory

### "Send update to the team about X"
1. **Memory** — Recall project context for X
2. **Research** — Check for recent findings if applicable
3. **Trello** — Check card status for related tasks
4. Compose the update message
5. Send via the appropriate channel (Slack, Discord, Teams, Gmail, or Google Chat)
6. Store that the update was sent in memory

### "Organize project X"
1. **Memory** — Recall all context about X
2. **Trello** — Check/create board and cards
3. **Notion** — Create wiki pages for project documentation
4. **GitHub** — Check repo status, open issues
5. **Research** — Link any research projects
6. Store the organizational structure in memory

---

## Auto-Detection Patterns

### Detect and adapt to user context
- If the user mentions a person → check memory for person context, check contacts
- If the user mentions a date → check calendar for conflicts
- If the user mentions a source/paper → check research pipeline and Zotero
- If the user mentions a project name → check memory, Trello, GitHub, and Notion
- If the user seems frustrated or corrects approach → note friction for reflection
- If the user switches languages mid-session (2+ messages) → ask if they want to update their language preference

### Friction Detection (feeds into reflection skill)
Track these signals during the session:
- Tool call failures (API errors, authentication issues)
- User corrections ("no, I meant...", "that's not right")
- Repeated attempts at the same task
- Long chains of tool calls without producing results
- User explicitly expressing frustration

**Friction Visibility**: Every friction signal is surfaced to the user immediately:
*[crow: friction signal — \<what happened\> (\<current count\> of 2 threshold)]*

When 2+ friction signals accumulate, show a checkpoint before triggering reflection:
**[crow checkpoint: 2+ friction signals accumulated. Will run reflection skill to analyze. Say "skip reflection" to cancel.]**

### Skill Improvement Cycle
The reflection, crow.md, and skill-writing skills form a continuous improvement loop:
```
Session work → Reflection (friction analysis) →
  crow.md updates (behavioral context fixes) →
  Skill-writing (propose/apply skill fixes) →
    Metrics (track effectiveness) →
      Reflection (evaluate if fix worked) → ...
```
- **Reflection** detects problems and classifies fixes as minor or major, distinguishing between skill issues and behavioral context issues
- **crow.md updates** (via `crow_update_context_section`) fix behavioral instructions that caused friction across platforms — see reflection Phase 7b
- **Skill-writing** applies minor skill fixes automatically, asks for major ones
- **Metrics** (stored in memory with `skill-metrics` tag) track usage counts, friction rates, and refinement history
- **Watch items** (`skill-watch` tag) monitor newly created/modified skills for early feedback
