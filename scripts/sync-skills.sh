#!/usr/bin/env bash
#
# sync-skills.sh — Generate Claude Code skill files from Crow platform skills
#
# Creates .claude/skills/<name>/SKILL.md files with Claude Code frontmatter
# prepended to each Crow skill's content. Re-run after editing skills/*.md.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
SKILLS_DIR="$ROOT/.claude/skills"

# Mapping: crow_skill_filename|claude_code_name|description
SKILL_MAP=(
  "reflection.md|crow-reflection|Session reflection and friction analysis"
  "session-context.md|crow-session-context|Session start and end protocol"
  "memory-management.md|crow-memory-management|Memory storage best practices"
  "superpowers.md|crow-superpowers|Master routing and auto-activation"
  "plan-review.md|crow-plan-review|Checkpoint-based planning"
  "skill-writing.md|crow-skill-writing|Dynamic skill creation"
  "sharing.md|crow-sharing|P2P sharing workflows"
  "social.md|crow-social|Messaging and social interactions"
  "blog.md|crow-blog|Blog creation and publishing"
  "storage.md|crow-storage|File storage management"
  "project-management.md|crow-project-management|Project management workflows"
  "research-pipeline.md|crow-research|Research pipeline workflows"
  "data-backends.md|crow-data-backends|External data backend registration"
  "context-management.md|crow-context-management|Context window optimization"
  "crow-context.md|crow-context|Cross-platform behavioral context management"
  "i18n.md|crow-i18n|Multilingual output adaptation"
  "onboarding-tour.md|crow-tour|First-run platform tour"
  "bug-report.md|crow-bug-report|Bug and feature reporting"
  "add-ons.md|crow-add-ons|Add-on browsing and installation"
  "peer-network.md|crow-peer-network|Peer management and relay config"
  "onboarding.md|crow-onboarding|First-run sharing setup"
  "network-setup.md|crow-network-setup|Tailscale remote access guidance"
)

created=0
skipped=0

for entry in "${SKILL_MAP[@]}"; do
  IFS='|' read -r filename skillname description <<< "$entry"
  src="$ROOT/skills/$filename"
  dest_dir="$SKILLS_DIR/$skillname"
  dest="$dest_dir/SKILL.md"

  if [[ ! -f "$src" ]]; then
    echo "SKIP: skills/$filename not found"
    skipped=$((skipped + 1))
    continue
  fi

  mkdir -p "$dest_dir"

  # Write frontmatter + original content
  cat > "$dest" <<HEADER
---
name: $skillname
description: $description
---

HEADER
  cat "$src" >> "$dest"

  created=$((created + 1))
done

echo "Synced $created skills to .claude/skills/ ($skipped skipped)"
