---
name: working-the-board
description: Use when working a roadmap, board, epic, ticket, issue, sprint or "what's next" - selects the next actionable item across repositories, claims it, and opens a PR that closes it
---

# Working the Board

Armature's MCP tools hold the facts. This skill holds the judgment.

**Announce at start:** "I'm using armature:working-the-board to work the next item."

## The loop

1. **Choose.** Run `board_next` (add `repo` or `epic` to narrow it). It returns the item and why it
   won, or a blocked explanation. If it is blocked, say what is blocking and STOP.
2. **Read.** Run `item_get` on the chosen ref. Read the body and every document it cites. If the item
   has an epic, read that too — `item_get` reports which repository the epic lives in, which is often
   not this one.
3. **Check its prerequisites.** See the prerequisite rule below. Do this before claiming, not after.
4. **Claim.** Run `item_claim`. It refuses if someone else moved the item first.
5. **Isolate and implement.** Use `superpowers:using-git-worktrees` and
   `superpowers:test-driven-development` if they are installed. Otherwise: branch as
   `issue-<number>-<slug>`, write the failing test first, then the implementation.
6. **Verify.** Run every command in this repository's `.armature.json` `verify` list. If there is no
   such list, run the project's test suite.
7. **Open a PR.** Title is a Conventional Commit. Body contains `Closes #<number>`. **Do not merge.**
8. **Hand back.** Move the item to the board's review status with `item_status` if the board has one.
   Report the PR link and STOP.

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
- **Never merge.** Armature opens PRs; people merge them.
