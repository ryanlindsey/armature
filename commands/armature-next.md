---
description: Work the next actionable item on the board, on a branch, ending in a PR
argument-hint: "[owner/repo#number or issue URL] [instructions, e.g. \"no worktree\"]"
allowed-tools: mcp__plugin_armature_armature__*, Skill, Agent, Task, EnterWorktree, Bash(git:*), Bash(npm:*), Bash(gh pr:*), Read, Edit, Write, Grep, Glob
---

Use the `armature:working-the-board` skill.

`$ARGUMENTS` may hold a reference, instructions, or both. A reference is a token of the form
`owner/repo#number` or a `github.com` issue URL; anything else — including a bare number such as
`#12` — is not one.

If there is a reference, work that item: pass it to `item_get` exactly as given, and nothing else
with it. Without one, call `board_next` and work what it returns.

Treat the rest of `$ARGUMENTS` as the human's instructions for this run — "no worktree", for
example, which the skill's rules honour.
