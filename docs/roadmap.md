# Roadmap

Crow's development follows a milestone-based roadmap. Each milestone builds on the previous one, expanding the platform's project types, skills, and data backend integrations.

## Milestone 1: Project Type System + Data Backend Registry (Current)

The foundation for everything that follows. The research server has been generalized into a project server that supports typed projects and pluggable data backends.

**What shipped:**

- **Project types** -- Projects now have a `type` field (`research`, `data_connector`) that determines their workflow
- **Data backend registry** -- Register external MCP servers as queryable data sources (`crow_register_backend`, `crow_list_backends`, `crow_remove_backend`, `crow_backend_schema`)
- **`data_backends` table** -- New database table for storing backend registrations
- **Backward compatibility** -- `crow-research` server name, `/research/mcp` endpoints, `createResearchServer` factory, and `crow_research` router category all continue to work as aliases
- **Renamed server** -- `crow-projects` is the canonical server name; `crow_project_stats` replaces `crow_research_stats`

**Prerequisites for next milestones:**

- Stable data backend protocol (register, query, capture)
- Project type system extensible for new verticals

## Milestone 2: LMS Vertical

Bring learning management system data into Crow through purpose-built project types and backends.

**Planned:**

- **`lms_course` project type** -- Projects scoped to a specific course, with semester, section, and enrollment metadata
- **Canvas LMS backend** -- Pre-built data backend for Canvas (assignments, grades, modules, announcements, student submissions)
- **LMS skill** -- Behavioral prompt that teaches the AI how to work with course data, generate reports, and track student progress
- **Grade analysis tools** -- Tools for computing statistics, identifying at-risk students, and generating grade distribution reports
- **Assignment workflow** -- Create assignments, rubrics, and feedback drafts from project notes

**Prerequisites:**

- Milestone 1 complete
- Canvas MCP server operational (already listed as an external integration)

## Milestone 3: Instructional Tools

Tools for course design, content creation, and pedagogical workflows.

**Planned:**

- **`curriculum` project type** -- Projects for designing course sequences, learning objectives, and assessment strategies
- **Syllabus generator** -- Skill that produces formatted syllabi from project notes and institutional templates
- **Learning objective alignment** -- Tools to map assignments to learning outcomes (Bloom's taxonomy tagging)
- **Content scaffolding** -- Break lecture topics into scaffolded learning sequences with suggested activities
- **Assessment builder** -- Generate quiz and exam items from source material, tagged by difficulty and objective

**Prerequisites:**

- Milestone 2 complete (LMS data informs curriculum decisions)
- Stable knowledge capture workflow from data backends

## Milestone 4: Administrative and Institutional

Expand beyond individual courses to department-level and institutional workflows.

**Planned:**

- **`program_review` project type** -- Projects for accreditation, program assessment, and institutional reporting
- **Multi-course analytics** -- Aggregate data across courses for department-level insights (retention, DFW rates, enrollment trends)
- **Accreditation evidence** -- Tools to collect and organize evidence for accreditation standards (mapped to common frameworks like HLC, SACSCOC)
- **Faculty workload** -- Track teaching loads, committee assignments, and service obligations
- **Institutional data backends** -- Pre-built backends for SIS (Student Information System), HR, and financial systems

**Prerequisites:**

- Milestones 2 and 3 complete
- Institutional data access agreements and backend implementations
- Multi-user sharing workflows stable (Milestone 1 sharing already supports project collaboration)
