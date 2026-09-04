---
description: Show what armature derived about your board and what you declared
allowed-tools: mcp__plugin_armature_armature__board_survey
---

Call `board_survey` and report, as a table:

- The board it surveyed — `board.name` and `board.provider` — and where that identity came from
  (`board.source`: `env` for `ARMATURE_BOARD`, `repo` for this repository's `.armature.json`,
  `user` for `~/.config/armature/config.json`, `derived` for the single board found to link to
  this repository)
- Every repository with items on it
- The status options, and which were inferred to mean todo, claimed, review and done
- Any issue number claimed by more than one repository
- The count of items in each status

Then state plainly whether the inferred status meanings look right, and if any look wrong, say that
they can be overridden in `~/.config/armature/config.json`.
