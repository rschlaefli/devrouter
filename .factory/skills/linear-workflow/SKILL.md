---
name: linear-workflow
description: Use Linear as the persistent system of record for milestone planning and cross-session execution
user-invocable: false
---

# linear-workflow

Use this skill when planning or executing large milestones that span multiple sessions, contributors, or agents.

## Required policy

- Large milestones must be planned and tracked in Linear before implementation.
- Linear is the source of truth for plan status, scope changes, and progress.
- Keep issue status/assignee/priority current while work is active.
- Post progress comments after meaningful implementation checkpoints.

## Issue structure (canonical)

Every implementation issue should include:

1. Problem
2. Goal / expected outcome
3. Scope (in / out)
4. Technical approach
5. Acceptance criteria
6. Validation plan
7. Dependencies / blockers
8. Rollout risks

See templates:
- references/LINEAR_ISSUE_TEMPLATE.md
- references/MILESTONE_PLAN_TEMPLATE.md
- references/PROGRESS_UPDATE_TEMPLATE.md

## Milestone workflow

1. Create one tracker issue for the milestone.
2. Create child issues for implementation slices.
3. Link dependencies and blockers between issues.
4. Order execution explicitly in tracker comments.
5. Update tracker progress as child issues move.

## Session cadence

- Start of session:
  - confirm active issue + current status
  - confirm scope and acceptance criteria
- During session:
  - update status when moving phases
  - add progress comments with what changed and what is next
- End of session:
  - leave handoff comment with remaining tasks/risks
  - ensure next issue is clear and linked

## Cross-agent continuity

- Always link active work to a parent tracker issue.
- Keep latest plan/progress in Linear comments (not only local notes).
- If ownership changes, update assignee/delegate explicitly.

## Prioritization guidance

- Use Linear priority consistently across related issues.
- Runtime reliability and user-facing regressions should be prioritized above polish.
- Capture tradeoffs in issue body when deferring work.

## Reference guidance (official)

- Linear issue templates: https://linear.app/docs/issue-templates
- Linear parent/sub-issues: https://linear.app/docs/parent-and-sub-issues
- Linear issue relations: https://linear.app/docs/issue-relations
- Linear priorities: https://linear.app/docs/priorities
- GitHub issue forms syntax: https://docs.github.com/en/enterprise-server@3.17/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms

## Devrouter-specific note

If the repository uses devrouter, read `CHANGELOG.md` independently before planning implementation and use the latest Agent Adaptation Prompt as required upgrade context.
