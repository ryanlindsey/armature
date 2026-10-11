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
5. **Isolate.** First look for an existing `issue-<number>-*` branch or worktree for this item:
   if there is one, it holds this item's own work in progress — reuse it and rebase it onto the
   blocker's head branch, or the default branch once the blocker has merged (inside an epic run,
   the base the brief names), as the mid-work rule below says. Otherwise use `superpowers:using-git-worktrees`, and
   create the worktree without asking — invoking armature is the consent. If the human said not to
   use a worktree, work in place instead; see the rule below.
6. **Implement.** Use `superpowers:test-driven-development` — the failing test first, watched
   failing, then the implementation.
7. **Review.** Use `superpowers:requesting-code-review`. Fix Critical and Important findings before
   the PR exists; carry Minor ones into the PR body so the human reviewer sees them.
8. **Verify, then settle the item's acceptance criteria.** Run every command in this repository's
   `.armature.json` `verify` list. If there is no such list, run the project's test suite. Then take
   the item's checklist from `item_get`. Its criteria are the entries whose `heading` names
   acceptance ("Acceptance", "Acceptance criteria", "Definition of done"), and entries under other
   headings, such as plan steps, are left alone. Only if no heading names acceptance, treat the
   whole checklist as the criteria and say so in the receipt. Decide, criterion by criterion,
   whether evidence from this run settles it — see the evidence rule below. Tick the settled ones
   with `item_check`, in one call, and leave the rest.
9. **Open a PR.** Use `superpowers:finishing-a-development-branch`, taking the option that pushes
   and creates a pull request — by its text, never its number; see the rule below. Title is a
   Conventional Commit. Body contains `Closes #<number>` and the acceptance receipt: each settled
   entry with the evidence that settled it, each unsettled entry with why. Next to the receipt goes
   a **Board repairs** section — see the repair rule below — or "none". **Do not merge.**
10. **Hand back.** Move the item to the board's review status with `item_status` if the board has one.
    Report the PR link and the Board repairs section, which the session report always carries. If
    the item's parent — read in step 2 — is titled `Spec:`, a one-task plan filed with no epic, end
    the report with: "after this merges, close `<spec ref>`." Then STOP.

## Without Superpowers

Most installs will not have it. Every step above still happens; only what carries it changes.

| Step | Instead |
| --- | --- |
| 5. Isolate | If `git status --porcelain` shows anything — uncommitted or untracked changes — say so and STOP rather than branching over them. Otherwise `git fetch`, then check out this item's existing `issue-<number>-*` branch and rebase it, or, if there is none, branch as `issue-<number>-<slug>` from `origin/<default-branch>`. |
| 6. Implement | Write the failing test first, watch it fail, then write the implementation. |
| 7. Review | Re-read the whole diff before opening the PR. |
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
  without claiming. An epic or parent titled `Spec:` is a design document: read it for context,
  not for prerequisites, since its prose describes the whole design rather than this item's order.
  The server does not check prerequisites — it reports facts and effects, and "this should wait"
  is a judgment — so this rule is the only place that check exists.
- **A dependency found mid-work stops the work.** If work on `A` reveals that it depends on `B`,
  add the blocker with `item_link` (`addBlockedBy: ["B"]`), which writes the `Depends on` line too.
  Then apply the prerequisite test above (inside an epic run, the ruling your brief gives you
  instead). If `B` passes it, carry on. If not, commit the work in progress on `A`'s branch without pushing, set `A` back to the board's
  `semantics.todo` status with `item_status`, report "`A` is waiting on `B`" with the branch name
  and the Board repairs section, and STOP — no PR is opened. When `A` is picked up again, it finds
  its own `issue-<number>-*` branch and rebases that work onto the blocker's head branch, or onto
  the default branch once the blocker has merged, rather than starting over.
- **Repair any open item you find a defect in, then report it.** The item being worked, a sibling,
  the epic, a blocker — a wrong step, broken text, a missing or wrong blocker or parent. No
  per-edit approval, and never `gh`:
  - title or body: `item_update`, passing the `version` from a fresh `item_get` as
    `expectVersion`. On `ConcurrentEditError` someone changed the item since you read it:
    `item_get` it again and re-apply the edit to what is there now. An `item_update` must carry `title`, `body`, or both.
  - blockers or parent: `item_link` (`addBlockedBy`, `removeBlockedBy`, `parent`, or
    `clearParent: true` — `parent: null` means "not asked"), never by editing `Depends on` lines
    through `item_update`. `item_link` keeps the canonical lines — ``Depends on `owner/repo#N` ``,
    alone on a line, outside code blocks — in step with every blocker link, and its result's
    `dependsOn.added`/`removed` entries beyond the refs you named are drift it repaired.
    `item_update` refuses a body whose `Depends on` lines disagree with the links
    (`DependsOnDriftError`): change the link with `item_link`, or make the lines match `blockedBy`.
    Rewriting a non-canonical prerequisite ("blocked by …", several refs on a line) into canonical
    lines is an `item_update`, with lines matching `blockedBy`.
  - when `item_link` raises, its message says what landed. `MissingLinkTargetError` or
    `ConflictingLinkError`, or an argument refusal such as `BareRefError` or
    `InvalidArgumentError`: nothing changed — fix the ref or the request and call again.
    `UnclosedFenceError`: nothing was written — close the code fence with `item_update` first.
    `PartialLinkError`: run `item_get`, then repeat the same `item_link` call; the prose was not
    touched. `ProseOutOfStepError`: the links are right and the prose is not — `item_get`, then
    `item_update` with lines matching `blockedBy`. `LinkUnsupportedError`: this board cannot link;
    report the defect instead.
  - a **closed or done** item is reported, not edited: changing finished work's ticket rewrites
    history.
  - **never edit a `Spec:` item's body or give a spec a blocker**, which would write prose into it;
    report the defect instead. Setting or clearing a spec's parent is fine.
  - any other `item_update` or `item_link` error, such as `UnverifiedWriteError`, leaves the outcome
    unknown: do not call again; report it and let the human check.

  Every repair, and every defect reported instead of repaired, goes in a **Board repairs**
  section: in the session report always, and in the PR body next to the acceptance receipt when
  there is a PR. It separates the worked item from other items, one line per item — the ref, then
  what changed: `title`, `body: <one-line description>`, `+blocker owner/repo#N`,
  `-blocker owner/repo#N`, `parent → owner/repo#N` or `parent cleared`, `drift repaired` where
  `item_link` reconciled the prose, and `reported, not fixed: <one-line description>` for a defect
  left in a closed, done or `Spec:` item.
- **`using-git-worktrees` does not get to ask for consent.** It asks before creating a worktree
  unless a preference is on record, and a missed prompt stalls the whole run. Invoking armature is
  that preference: treat consent as given and do not ask. Name the worktree `issue-<number>-<slug>`.
  If it reports you are already in a linked worktree, reuse it only when its branch has no commits
  of its own beyond the default branch, or when it is named for this item's own number; otherwise
  it holds another item's work — say which, and STOP, or leave it with `ExitWorktree` (keeping it) before creating this item's worktree. The
  exception is the human saying otherwise, for this run or in their standing instructions — "no
  worktree", "don't use a worktree", "work in place", in any wording. Then answer *no* and branch
  in place, exactly as the *Without Superpowers* row for step 5 does. An override given with the
  invocation lasts for this run only. Its other question stays the human's: if the baseline tests
  fail, report them and let the human decide whether to go on.
- **`finishing-a-development-branch` does not get to ask its menu.** Take the option whose text is
  **push and create a Pull Request**, and skip the question. Name it by its text, never its number:
  that skill shows a different menu on a detached HEAD — the state `using-git-worktrees` reports for
  an externally managed worktree — where the numbering shifts and option 2 is instead "Keep as-is",
  which pushes nothing and opens no PR while step 10 goes on to report a review status and a link
  that does not exist. Never take the standard menu's first option, a local merge: armature never
  merges. Keep the worktree; the human iterates on review feedback there. That skill also asks which
  branch the work split from — answer with the repository's default branch — and re-runs the suite
  step 8 has just run, which is wasteful but harmless.
- **Tick a box only on evidence, and never untick one.** `item_check` sets whatever state it is
  handed; deciding which boxes deserve it is this rule. An entry is settled only by something
  observed in this run: a command the criterion names, run and passed; a test in the diff that
  asserts it, with the suite green; a `verify` command whose success is what the criterion asks for;
  or a filesystem fact read directly. It is **not** settled by an implementer's report that it did
  it, by a plausible reading of the diff, or by a test whose name merely suggests it. Never tick an
  entry you did not observe evidence for, however obviously true it looks, and **never untick** one
  a person ticked — if you cannot confirm it, leave it and say so in the receipt. An unticked box
  costs nothing. A wrongly ticked one launders an unverified assertion into a record a reviewer will
  trust, which is the failure that ended `parseEpicFromBody`. Unsettled criteria never block the PR:
  armature reports the gap and hands back, because a person reads every PR anyway.
- **Send `item_check` only what it can land.** Only ever pass `checked: true`, with each entry's
  text copied verbatim from `item_get`; if nothing is settled, skip the call. The batch is
  all-or-nothing, so one bad entry writes nothing, and each refusal names only the first bad entry
  it met. If it raises, run `item_get` again, drop the entry the error names as missing or ambiguous
  — it is unsettled, with that reason — and retry; repeat until the call lands or nothing is left to
  send. On any other failure, go on to step 9 and say in the receipt that nothing was ticked, and
  why. Under a dry run the result is marked `dryRun` and nothing was written: say the ticks were
  predicted, not made.
- **Never merge.** Armature opens PRs; people merge them.
