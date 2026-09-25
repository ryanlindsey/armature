---
name: working-an-epic
description: Use when working a whole epic, roadmap slice or set of child tickets in one run - works every actionable child, each on a branch stacked on its blocker, each ending in its own pull request
---

# Working an Epic

`armature:working-the-board` works one item. This works all of them, and uses that skill as its
loop body rather than reimplementing any of it.

**Announce at start:** "I'm using armature:working-an-epic to work every actionable child of
&lt;epic&gt;."

## What you are

You are a controller. You never implement anything — you never enter a worktree, never read a diff,
never run a test, never edit a file. You survey, choose a base branch, dispatch one subagent,
adjudicate what it reports, and loop.

That is not modesty, it is the mechanism. A controller that reads implementation output is a
controller whose context fills up and which then loses its place in the epic. Staying out of the
work is what lets you finish one.

## The ledger is the board, not your memory

Run `epic_survey` at the top of **every iteration**. Never carry the epic's state between
iterations in your head — re-derive it. Compaction cannot lose what you never stored.

| Child's state | Means | Do |
| --- | --- | --- |
| Closed, PR merged | finished | skip |
| Open, claimed status, open PR | worked and handed back; it is in the stack | skip — it is a base candidate |
| Open, claimed status, **no PR** | **interrupted mid-flight** | **re-dispatch it** |
| Open, todo status | not started | dispatch when its turn comes |

The third row is the one nothing else distinguishes. A child whose subagent died leaves the board
reading "In Progress" with nothing to show, which is indistinguishable from work in flight until
you look for the PR. Look for the PR.

## Before the first dispatch

1. **Survey.** `epic_survey` on the epic. If it reports `offBoard` children, say so — they are
   children of this epic that nobody will work, because an item that is not on the board is not
   work. Ask before adding them.
2. **Settle the worktree answer once.** `armature:working-the-board` treats invoking armature as
   consent to a worktree, unless the human said otherwise — "no worktree", "work in place", in any
   wording. Settle that **once**, for the whole epic, from what the human said when invoking this
   skill, and pass the same answer down in every brief. Do not ask it again per child: in a loop
   that is one identical prompt per child, and a missed one stalls the run.
3. **Announce the run.** Name the children you will work, in order, and any you will not — a child
   carrying the `humanLabel` declared in `.armature.json`, if one is declared, needs a person, and
   a child blocked by one cannot proceed. Saying so now beats discovering it at child four.

## The loop

For each child, in the order `epic_survey` reports:

1. **Choose the base branch.** If the child has `blockedBy`, the base is that blocker's open PR
   `headRefName`. If it has none, the base is the repository's default branch.
2. **Dispatch one subagent**, with a brief that names:
   - the child's fully qualified ref,
   - **the base branch, explicitly** — branch from it and open the PR against it (see the rule
     below),
   - the worktree answer from the setup step,
   - the instruction to use `armature:working-the-board` for that one item,
   - **the prerequisite ruling:** inside this run a prerequisite is satisfied when its work is
     reachable from the base branch (`git merge-base --is-ancestor`), even though the board does
     not yet show it done — so step 3 of `working-the-board` passes a stacked blocker rather than
     stopping on it,
   - that if the issue needs a person, it reports so **without claiming and without
     implementing**,
   - the reporting contract: PR url, head branch, **files touched**, criteria settled, and any red
     flag it hit.
3. **Adjudicate.** If the report carries a red flag, stop and ask. Otherwise record it and continue.
4. **Loop**, starting again from `epic_survey`.

When `epic_survey` reports no actionable child, stop and report the whole stack with its merge
order.

## Red flags

`superpowers:subagent-driven-development` is right that a running plan should make rulings rather
than stall, and this skill overrides that narrowly. These three stop the run. Nothing else does —
everything else is a ruling you make, record, and carry on from.

1. **Cross-child file collision.** A child touched a file an earlier child in this run already
   changed. That is evidence about the epic's decomposition rather than about one child, so it
   invalidates the remaining plan too.
2. **A review that cannot be satisfied.** Use `superpowers:subagent-driven-development`'s breaker
   unmodified: up to **five** fix rounds, then adjudicate each open finding, rule and carry on, and
   stop only if every path forward is a guess. Set no tighter threshold of your own.
3. **Verify failed.** The repository's `verify` list, or its test suite, is red after the child's
   work.

Running out of work is **not** a red flag. When skipping children that need a person leaves nothing
actionable, that is a **terminal condition**: the run is finished, not stalled. Report the stack, its
merge order, and what needs a person.

## Rules

- **Name the base branch explicitly in every brief.** `superpowers:using-git-worktrees` branches
  from the default branch unless told otherwise, and `working-the-board` answers "which branch did
  this split from" with the default branch too. A brief that omits the base produces a child
  branched from the default branch that silently lacks its blocker's work: the stack looks right
  and is not. This is the easiest thing in this skill to get wrong and the hardest to notice.
- **A prerequisite is satisfied when its work is in the base branch, not when the board says
  done.** Stacking means the blocker's PR is never merged while you work — judging by board status
  would stop the run at the second child, every time. The child checks reachability
  (`git merge-base --is-ancestor`), not status, and the brief is where it learns to. A prerequisite
  outside this epic, or one not yet worked, still stops the run.
- **Never claim a child that needs a person.** Claiming asserts armature is working it, which is
  false. Leave it in the board's todo status, skip it, and carry on to the next actionable child.
  When skipping leaves nothing actionable — the rest need a person, or are blocked by one that does
  — **end the run** and report what needs doing. That is a terminal condition, not a red flag: no
  ruling you could make would produce the work. A child is known to need a person either by the
  `humanLabel` declared in `.armature.json`, or because the subagent read the issue and reported so
  before claiming anything.
- **One child at a time.** Not because parallelism is wrong, but because the cross-child collision
  check is a sequence and would become a race, and a pause mid-fan-out is not resumable.
- **Never merge.** Armature opens pull requests; people merge them. You hand back a stack and its
  merge order, bottom-up.
- **If `epic_survey` is unavailable, STOP.** Do not rebuild it from `board_next` and `item_get`,
  and do not fall back to `gh`. Say so and let a human decide.
