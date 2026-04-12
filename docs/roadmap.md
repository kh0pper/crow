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

## Extension Ecosystem: Bundle MVP Follow-ups

Parallel track to the vertical milestones above. The 15-bundle MVP expansion merged 2026-04-12 across 7 PRs (PR 0 through PR 5; see git history on `main`). 13 bundles shipped; these are the remaining threads.

### PR 4.5 -- crowdsec-firewall-bouncer (blocked on Pi availability)

The only MVP bundle that didn't ship. CrowdSec upstream does not publish a Docker image for their firewall-bouncer -- `cs-firewall-bouncer`, `firewall-bouncer`, and the iptables/nftables variants all 404 on Docker Hub. Their install path is a host apt package + systemd service.

**Plan when resumed:**

- Custom `Dockerfile` in `bundles/crowdsec-firewall-bouncer/` using the statically compiled binary from GitHub releases
- `network_mode: host`, `cap_add: [NET_ADMIN, NET_RAW]`, `privileged: true` in the manifest
- First bundle to exercise PR 0's privileged install path and the typed-INSTALL consent gate
- **Must include a tested unwind command** verified end-to-end on a throwaway host (colibri or mockingbird). A broken install can lock the operator out of iptables; dry-running the unwind before any grackle deploy is non-negotiable

### Async install job silent-failure

During the consent-modal smoke test on the `--no-auth` gateway (port 3004), a Netdata install returned `{ok: true, job_id: "1"}` but nothing appeared in `installed.json` or `docker ps`. Dozzle installed fine on the auth'd gateway (3002), so it may be specific to the `--no-auth` configuration -- but worth diagnosing before adding more bundles.

### End-to-end consent-modal UX coverage

Dozzle was verified manually through the browser; Netdata's token round-trip was verified via curl (token mint → consent check → atomic single-consume → replay rejection). Still want eyes on:

- **Caddy** -- ports 80/443 may conflict on a host already running a web server; test on a clean VM
- **Vaultwarden** -- requires generating `VAULTWARDEN_ADMIN_TOKEN` before install succeeds
- **CrowdSec** -- requires `docker exec crow-crowdsec cscli bouncers add crow-mcp` post-install to produce the bouncer API key

Each should render the EN/ES localized consent message and the checkbox-only gate.

### Typed-INSTALL gate coverage

Zero bundle-level exercise today. The gate is only shown for `privileged: true` manifests, and no MVP bundle declares that yet. First real exercise lands with PR 4.5.

### Registry mirror automation

The `crow-addons` registry is mirrored manually per PR today (flagged for Phase 2 in the plan hand-off). 13 bundles accumulated across the MVP merge are still pending mirror: caddy, uptime-kuma, stirling-pdf, changedetection, homepage, netdata, dozzle, adguard-home, crowdsec, gitea, forgejo, vaultwarden, searxng.
