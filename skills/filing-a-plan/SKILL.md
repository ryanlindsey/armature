---
name: filing-a-plan
description: Use when a design spec or implementation plan is ready to be filed — instead of writing it to docs/superpowers/ — puts the spec, its epic and every child on the board as one linked graph through armature's own tools
---

# Filing a Plan

Armature's MCP tools hold the facts and effects. This skill holds the judgment of which writes to
make, and in what order.

**Announce at start:** "I'm using armature:filing-a-plan to file this on the board."

`superpowers:brainstorming` and `superpowers:writing-plans` save to `docs/superpowers/` unless a
preference says otherwise. This skill is that preference. The spec is an issue, the plan is an
epic with one child per task, or a single issue, and all of it lives on the board, where the
human reviews it.

## The spec

Filed at the end of brainstorming, so it can be reviewed on GitHub before any plan exists.

1. Run `board_survey` and read `semantics.claimed`. Never hard-code a status name; boards differ.
2. `item_create` with:
   - `title`: `Spec: <imperative summary>`
   - `body`: the whole spec
   - `status`: that `semantics.claimed` value

The spec is **never** filed in todo. Design is under way from the moment it is written, and a todo
spec is something `board_next` could offer as work. The `Spec: ` prefix keeps it out as well; the
status is what makes the board read correctly.

## The plan

Filed after the human approves the spec. It takes one of two shapes.

**One task: a single issue.** One `item_create` with a conventional title, the plan as its body,
and `parent: <spec>`. No epic.

**More than one task: an epic.**

1. `item_create` with `title: Epic: <summary>`, the plan's header and Global Constraints as its
   body, and `parent: <spec>`. Leave `status` unset, so it is in todo; the `Epic: ` prefix and its
   children keep `board_next` from offering it.
2. Then each child **in dependency order**, because a blocker must exist before `blockedBy` can
   name it. Each child is an `item_create` with:
   - `parent: <epic>`
   - `blockedBy`: the refs of the children it waits on, which you just created
   - a body that includes, for each of them, the canonical line ``Depends on `owner/repo#N` ``
     in exactly that form: alone on its line, one ref per line, outside code blocks.
     `working-the-board` still reads prerequisites from that line, so write both. Any other
     phrasing is prose the server ignores, and `item_update` and `item_link` read only canonical
     lines when they keep the prose in step with the links.

Work too small for a spec — a bounded change, a bug fix — is one `item_create` and does not need
this skill.

## Rules

- **Never pass a bare issue number.** Every ref is `owner/repo#number`, in `parent`, in
  `blockedBy`, and in the prose `Depends on` line.
- **Never retry `item_create` after an error that means the issue exists.** Calling again creates
  a second issue. What reaches you is the error's message, not its class name, so read the message:
  one that begins `Created <ref>` means that issue exists. The four such errors, by how far each
  got (writes run in the order: create, add to board, set status, link parent, add blockers):
  - `OrphanedIssueError` — created, but not on the board. Status, parent and blockers were not
    attempted.
  - `StatuslessItemError` — on the board, its status unconfirmed. Parent and blockers were not
    attempted, and its message does not say so.
  - `UnlinkedItemError` — on the board with its status, but not linked to its parent. If you also
    passed `blockedBy`, none of those links was attempted either; the message lists them.
  - `UnsequencedItemError` — status set and parent linked if one was given, but some blockers
    unconfirmed; the message names which landed.

  Stop and report the error to the human. These four, and the unknown-outcome errors below, stay
  the human's, because the item's state is in doubt: a repair built on a guess about what landed
  compounds it. Carry on filing only once the human confirms that issue is whole, since later
  children may name it.
- **Repair every other defect yourself, then report it.** A defect found during or after filing — a
  wrong step, broken text, a missing or wrong blocker or parent — is repaired through armature, and
  you never reach for `gh` to do it:
  - title or body: `item_update`, passing the `version` from a fresh `item_get` as
    `expectVersion`. On `ConcurrentEditError` someone changed the item since you read it:
    `item_get` it again and re-apply the edit to what is there now.
  - blockers or parent: `item_link` (`addBlockedBy`, `removeBlockedBy`, `parent`, or
    `clearParent: true`), never by editing `Depends on` lines through `item_update` — `item_link`
    keeps those lines in step with the links, and `item_update` refuses a body that disagrees with
    them (`DependsOnDriftError`).
  - when `item_link` raises, its message says what landed. `MissingLinkTargetError` or
    `ConflictingLinkError`, or an argument refusal such as `BareRefError` or
    `InvalidArgumentError`: nothing changed — fix the ref or the request and call again.
    `UnclosedFenceError`: nothing was written — close the code fence with `item_update` first.
    `PartialLinkError`: run `item_get`, then repeat the same `item_link` call; the prose was not
    touched. `ProseOutOfStepError`: the links are right and the prose is not — `item_get`, then
    `item_update` with lines matching `blockedBy`. `LinkUnsupportedError`: this board cannot link;
    report the defect instead. Any other `item_update` or `item_link` error, such as
    `UnverifiedWriteError`, leaves the outcome unknown: do not call again; report it.
  - a closed or done item is reported, not edited: changing finished work's ticket rewrites
    history.
  - never edit a `Spec:` item's body or give a spec a blocker, which would write prose into it;
    report the defect instead. Setting or clearing a spec's parent is fine.

  Every repair goes in the report's Board repairs section.
- **Some `item_create` errors mean nothing was created.** A message saying nothing was created —
  `UnknownStatusError` (status names match exactly, including case), `MissingParentError`,
  `MissingBlockerError` — or an argument refusal such as `BareRefError` ("is not a work item
  reference") or `InvalidArgumentError` ("needs … to be") is raised before any write: fix the
  argument, then call again.
- **Any other `item_create` error leaves the outcome unknown.** Do not call again; report it, and
  let the human check whether the issue exists.
- **A dry run cannot file a whole graph.** Under `ARMATURE_DRY_RUN` a created item has no ref, so
  nothing after the first `item_create` can name it as `parent` or in `blockedBy`. Predict the
  first write, report the rest as planned, and stop.
- **Bodies go through `body` directly.** No scratch files, and never `gh` to read or write the
  board. If the armature tools are unavailable, STOP and say so.
- **Bodies travel as JSON strings, so escapes are decoded.** A backslash escape such as `\uXXXX`
  in a `body` is decoded before GitHub sees it, which can blank or corrupt the text. Write the
  literal character, or spell a code point as `U+XXXX`.
- **Report what was filed.** End with the spec, the epic if there is one, and each child, as refs,
  with each child's blockers. Then a **Board repairs** section: one line per item, the ref then
  what changed — `title`, `body: <one-line description>`, `+blocker owner/repo#N`,
  `-blocker owner/repo#N`, `parent → owner/repo#N` or `parent cleared`, `drift repaired` where
  `item_link` reconciled the prose, and `reported, not fixed: <one-line description>` for a defect
  left in a closed, done or `Spec:` item. Write "none" if there is nothing to list.
- **Closing is the human's.** Armature never closes a spec or an epic. The run that finishes the
  work reminds them.
