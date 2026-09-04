---
description: Work the next actionable item on the board, on a branch, ending in a PR
argument-hint: "[owner/repo#number or issue URL]"
allowed-tools: Bash(git:*), Bash(npm:*), Bash(gh pr:*), Read, Edit, Write, Grep, Glob
---

Use the `armature:working-the-board` skill.

With `$ARGUMENTS`, work that item: pass it to `item_get` exactly as given — it is already a qualified
reference or a URL, and the tools will reject it if it is neither.

Without `$ARGUMENTS`, call `board_next` and work what it returns.
