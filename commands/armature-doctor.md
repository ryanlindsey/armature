---
description: Show what armature derived about your board and what you declared
allowed-tools: Read
---

Call `board_survey` and report, as a table:

- The board, and where its identity came from
- Every repository with items on it
- The status options, and which were inferred to mean todo, claimed, review and done
- Any issue number claimed by more than one repository
- The count of items in each status

Then state plainly whether the inferred status meanings look right, and if any look wrong, say that
they can be overridden in `~/.config/armature/config.json`.
