---
description: Work every actionable child of an epic, each on a stacked branch ending in its own PR
argument-hint: "<owner/repo#number or issue URL of the epic> [instructions, e.g. \"no worktree\"]"
allowed-tools: mcp__plugin_armature_armature__*, Skill, Agent, Task
---

Use the `armature:working-an-epic` skill.

`$ARGUMENTS` holds the epic and, optionally, instructions. The epic is a token of the form
`owner/repo#number` or a `github.com` issue URL: pass it to `epic_survey` exactly as given, and
nothing else with it. A bare number such as `59` or `#59` is not a reference — STOP and ask for
`owner/repo#number`.

Treat the rest of `$ARGUMENTS` as the human's instructions for this run — "no worktree", for
example, which the skill settles once for every child.

Without an epic, ask which epic. Do not guess, and do not survey the board looking for one: which
epic to work is the human's decision, not a ranking.
