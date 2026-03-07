# GitHub Skill

## Description
Interact with GitHub — repositories, issues, pull requests, code — through the GitHub MCP server. Track development work, review code, and link commits to research and project management.

## When to Use
- When the user mentions "github", "repo", "issue", "PR", "pull request", or "commit"
- When reviewing code or checking CI/CD status
- When creating issues or pull requests
- When linking development work to research projects

## Tools Available
The GitHub MCP server provides:
- **Repositories** — List, search, create repos; get file contents
- **Issues** — Create, read, update, comment on issues
- **Pull Requests** — Create, review, merge PRs; get diffs
- **Branches** — List, create branches
- **Search** — Search code, issues, repos across GitHub
- **Actions** — Check workflow runs and status

## Workflow: Issue Tracking
1. List open issues for the relevant repo
2. Prioritize based on labels, milestones, and user input
3. Store active issue context in memory for cross-session tracking
4. Link issues to Trello cards when they overlap with project tasks

## Workflow: Code Review
1. Get the PR diff and description
2. Review changes for correctness and style
3. Check if related issues are referenced
4. Post review comments or approval

## Workflow: Research-to-Code
When research findings should become code:
1. Recall research sources and notes on the topic
2. Create a GitHub issue describing the implementation
3. Reference research sources in the issue body
4. Store the issue link in memory with research project tags

## Workflow: Development Status
1. Check recent commits and open PRs
2. Review CI/CD workflow status
3. Summarize development progress
4. Store status update in memory

## Best Practices
- Always link issues to relevant research when applicable
- Store important PR decisions and code review outcomes in memory
- Use consistent labels across GitHub and Trello for discoverability
- Reference commit hashes when storing development decisions in memory
