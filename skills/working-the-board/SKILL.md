---
name: working-the-board
description: Use when working a roadmap, board, epic, ticket, issue, sprint or "what's next" - selects the next actionable item across repositories, claims it, and opens a PR that closes it
---

# Working the Board

Armature's MCP tools hold the facts. This skill holds the judgment.

**Announce at start:** "I'm using armature:working-the-board to work the next item."

## The loop

Armature brackets the work; Superpowers does the work. Steps 5, 6, 7 and 9 belong to Superpowers
when it is installed — see [Without Superpowers](#without-superpowers) when it is not.

1. **Choose.** Run `board_next` (add `repo` or `epic` to narrow it). It returns the item and why it
   won, or a blocked explanation. If it is blocked, say what is blocking and STOP.
2. **Read.** Run `item_get` on the chosen ref. Read the body and every document it cites. If the item
   has an epic, read that too — `item_get` reports which repository the epic lives in, which is often
   not this one.
3. **Check its prerequisites.** See the prerequisite rule below. Do this before claiming, not after.
4. **Claim.** Run `item_claim`. It refuses if someone else moved the item first.
5. **Isolate.** Use `superpowers:using-git-worktrees`. It asks before creating a worktree unless a
   preference is already on record; that question is the human's to answer, so let it be asked.
6. **Implement.** Use `superpowers:test-driven-development` — the failing test first, watched
   failing, then the implementation.
7. **Review.** Use `superpowers:requesting-code-review`. Fix Critical and Important findings before
   the PR exists; carry Minor ones into the PR body so the human reviewer sees them.
8. **Verify.** Run every command in this repository's `.armature.json` `verify` list. If there is no
   such list, run the project's test suite.
9. **Open a PR.** Use `superpowers:finishing-a-development-branch`, taking the option that pushes
   and creates a pull request — by its text, never its number; see the rule below. Title is a
   Conventional Commit. Body contains `Closes #<number>`. **Do not merge.**
10. **Hand back.** Move the item to the board's review status with `item_status` if the board has one.
    Report the PR link and STOP.

## Without Superpowers

Most installs will not have it. Every step above still happens; only what carries it changes.

| Step | Instead |
| --- | --- |
| 5. Isolate | Branch as `issue-<number>-<slug>`. |
| 6. Implement | Write the failing test first, watch it fail, then write the implementation. |
| 7. Review | Re-read the whole diff against the item's acceptance criteria before opening the PR. |
| 9. Open a PR | `git push -u origin <branch>`, then `gh pr create`. |

Armature's own steps — 1 to 4, 8 and 10 — do not change, and neither does the never-merge rule.

## Rules

- **Never pass a bare issue number to any tool.** Numbers repeat across repositories on one board.
  Always `owner/repo#number`. The tools refuse anything else.
- **If the armature tools are unavailable, STOP.** Do not fall back to `gh` commands to read or write
  the board. Say the server is unavailable and let a human decide.
- **An item that is not on the board is not work.** `item_get` reports this. Ask before adding it.
- **Work epics in order, and honour a stated prerequisite.** `board_next` already orders by epic and
  then by issue number, so take what it gives you rather than shopping the board for something more
  appealing. Then read the chosen item's body — and its epic's — for a prerequisite it states in
  prose: "Depends on `owner/repo#N`", "blocked by", "after". Run `item_get` on every item named.
  If any of them is not in the board's done status, say which item is waiting on which, and STOP
  without claiming. The server does not check prerequisites — it reports facts and effects, and
  "this should wait" is a judgment — so this rule is the only place that check exists.
- **`finishing-a-development-branch` does not get to ask its menu.** Take the option whose text is
  **push and create a Pull Request**, and skip the question. Name it by its text, never its number:
  that skill shows a different menu on a detached HEAD — the state `using-git-worktrees` reports for
  an externally managed worktree — where the numbering shifts and option 2 is instead "Keep as-is",
  which pushes nothing and opens no PR while step 10 goes on to report a review status and a link
  that does not exist. Never take the standard menu's first option, a local merge: armature never
  merges. Keep the worktree; the human iterates on review feedback there. That skill also asks which
  branch the work split from — answer with the repository's default branch — and re-runs the suite
  step 8 has just run, which is wasteful but harmless.
- **Never merge.** Armature opens PRs; people merge them.
