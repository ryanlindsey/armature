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
| Open, claimed or review status, open PR (in `pullRequests` or the run record) | worked and handed back; it is in the stack | skip — it is a base candidate |
| Open, claimed status, **no PR** | **interrupted mid-flight** — unless the run record says otherwise | **re-dispatch it** |
| Open, review status, no PR in either place | handed back with nothing to review | report it; do not re-dispatch |
| Open, todo status | not started — unless the run record holds a ruling on it | dispatch when its turn comes |

The third row is the one nothing else distinguishes. A child whose subagent died leaves the board
reading "In Progress" with nothing to show, which is indistinguishable from work in flight until
you look for the PR. Look for the PR — in `pullRequests`, and then in the run record.

## The run record

The board holds status and pull requests. It cannot hold a ruling. So keep one short record for
this run, and nothing else, of what only you know:

- **Children ruled as needing a person**, and children stopped by a prerequisite outside this
  epic that their issue states in prose. They stay in the todo status, so `epic_survey` reports
  them as todo — and its `next` names the same one again every iteration. Without this record you
  re-dispatch it forever and never reach the terminal condition. Record only these rulings: a child
  waiting on a blocker inside this epic is **not** recorded, because that answer changes as the run
  goes — re-derive it from `blockedBy` every iteration, or a blocker listed after its dependant
  leaves the dependant skipped for good.
- **Each child's PR url and head branch**, as the child reported them. A PR that targets another
  child's branch rather than the default branch may not appear in that child's `pullRequests` at
  all — GitHub links a closing keyword only on the default branch — so this is how you find a base
  and tell a stacked child from an interrupted one.
- **The files touched by each child**, as reported, for the collision check.

The record is rulings, not position. Position still comes from `epic_survey`: where the two
disagree about status, the board wins; where the board is silent — a ruling, or a PR it cannot see
— the record fills in.

This record does not survive compaction, and it does not need to. A lost ruling costs one repeat
dispatch — the child reads the issue again and reports again — and a lost PR reads as an
interrupted child, whose re-dispatch finds its own branch and picks it up.

## Before the first dispatch

1. **Survey.** `epic_survey` on the epic. If it reports `offBoard` children, say so — they are
   children of this epic that nobody will work, because an item that is not on the board is not
   work. Ask before adding them.
2. **Settle the worktree answer once.** `armature:working-the-board` treats invoking armature as
   consent to a worktree, unless the human said otherwise — "no worktree", "work in place", in any
   wording. Settle that **once**, for the whole epic, from what the human said when invoking this
   skill, and pass the same answer down in every brief. Do not ask it again per child: in a loop
   that is one identical prompt per child, and a missed one stalls the run. Dispatch from the main
   checkout, not from inside a linked worktree: `working-the-board` refuses to reuse a worktree
   whose branch has commits of its own, and under stacking every child's would.
3. **Announce the run.** Name the children you will work, in order, and any you will not — a child
   carrying the `humanLabel` declared in its own repository's `.armature.json`, if one is declared,
   needs a person, and a child blocked by one cannot proceed. Saying so now beats discovering it at
   child four.

## The loop

Walk `epic_survey`'s `children` in the order it reports them, and dispatch the first one the ledger
and the run record leave actionable — rather than simply taking `next`, which cannot see the run
record's rulings. For that child:

1. **Choose the base branch.**
   - No `blockedBy`, or every blocker closed with its PR merged: the repository's default branch.
   - One open blocker in this epic with a PR: that PR's `headRefName`, from `pullRequests` or from
     the run record.
   - An open blocker with no PR yet, or one ruled as needing a person: this child cannot proceed
     this iteration — skip it without recording it, and look at it again next iteration.
   - More than one open blocker, or a blocker in another repository: a branch has one base, and
     another repository's branch cannot be it. Skip the child and report it as needing a person to
     sequence.
2. **Dispatch one subagent**, with a brief that names:
   - the child's fully qualified ref, and that it **starts at step 2 of `working-the-board` with
     that ref** — it does not run `board_next`, which would choose some other item;
   - **the base branch, explicitly** — branch from it, answer `finishing-a-development-branch`'s
     "which branch did this split from" with it rather than the default branch, and open the PR
     against it (see the rule below);
   - on a re-dispatch of an interrupted child, that this run already claimed it — skip
     `item_claim`, which would refuse an item no longer in todo — and that an existing
     `issue-<number>-*` branch or worktree for it is its own to inspect and continue;
   - the worktree answer from the setup step;
   - the instruction to use `armature:working-the-board` for that one item;
   - **the prerequisite ruling:** inside this run a prerequisite is satisfied when its work is
     reachable from the base branch — name the blocker's ref and head branch, and the child checks
     `git merge-base --is-ancestor` against it — even though the board does not yet show it done,
     so step 3 of `working-the-board` passes a stacked blocker rather than stopping on it;
   - that if the issue needs a person, it reports so **without claiming and without
     implementing**;
   - that if verify is red, it stops before opening the PR and reports that instead;
   - the reporting contract: PR url, head branch, **files touched**, criteria settled, the verify
     outcome, how many review rounds it took with any finding still open, and whether it stopped
     without claiming and why.
3. **Adjudicate.** Record the report in the run record. If it carries a red flag, stop and ask.
   Otherwise continue.
4. **Loop**, starting again from `epic_survey`.

When no child is left actionable, stop and report the whole stack with its merge order. If the
epic's own parent is titled `Spec:`, end the report with:
"after the stack merges, close the epic, then the spec" — naming both refs. Armature closes neither.

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
  outside this epic still stops **that child**: it is not claimed, it is recorded and skipped, and
  so is anything blocked by it. One inside this epic that is not yet worked only defers it — skip
  it this iteration, unrecorded, and come back once the blocker has a PR. That is a ruling, not a red flag, and it
  feeds the terminal condition.
- **Never claim a child that needs a person.** Claiming asserts armature is working it, which is
  false. Leave it in the board's todo status, record it, skip it, and carry on to the next
  actionable child. When skipping leaves nothing actionable — the rest need a person, or are
  blocked by one that does — **end the run** and report what needs doing. That is a terminal
  condition, not a red flag: no ruling you could make would produce the work. A child is known to
  need a person either by the `humanLabel` declared in its own repository's `.armature.json`, or because the subagent
  read the issue and reported so before claiming anything.
- **One child at a time.** Not because parallelism is wrong, but because the cross-child collision
  check is a sequence and would become a race, and a pause mid-fan-out is not resumable.
- **Never merge.** Armature opens pull requests; people merge them. You hand back a stack and its
  merge order, bottom-up.
- **If `epic_survey` is unavailable, STOP.** Do not rebuild it from `board_next` and `item_get`,
  and do not fall back to `gh`. Say so and let a human decide.
