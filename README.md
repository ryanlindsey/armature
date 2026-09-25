# armature

Project-driven agentic engineering. Armature answers "what should I work on next?" across every
repository on one GitHub Projects board, then holds the agent to a loop that ends in a reviewable
pull request: pick, claim, work, verify, hand back. The facts live in a typed MCP tool surface; the
judgment lives in a skill — so "what's next" and "close this out" mean the same thing in every
repository on the board, run after run.

An agent working alone re-decides the shape of the work every session. Armature makes that shape a
fixture: one item at a time, claimed on the board before a line is written, every reference
qualified as `owner/repo#number`, and a human — never the agent — merging the result.

[Superpowers](https://github.com/obra/superpowers) models one repository, one worktree, one branch —
and none of its skills knows what a ticket is. Armature is the layer above: it decides which work is
next across every repository on the board, and hands the doing to Superpowers. Together they are the
whole path from "what's next" to an open PR — see [Better with Superpowers](#better-with-superpowers)
— and armature can walk a whole epic that way, one stacked PR per child — see
[Working a whole epic](#working-a-whole-epic).

## Install

```
/plugin marketplace add ryanlindsey/armature
/plugin install armature
```

That's it for most repositories — see [Configuration](#configuration) below for the zero-config
path and when you need to say more.

## Better with Superpowers

Armature works alone. It is better paired with Superpowers, which is installed the same way:

```
/plugin marketplace add obra/superpowers
/plugin install superpowers
```

One `/armature-next` run then crosses both plugins. Armature brackets the work — it picks, claims,
verifies and hands back; Superpowers does everything in between:

```
  1  armature     board_next                       picks acme/checkout#278, with its reason
  2  armature     item_get                         reads it — its epic is in acme/platform
  3  armature     prerequisites                    a stated "Depends on" stops the claim
  4  armature     item_claim                       → In Progress, verified either side
  5  Superpowers  using-git-worktrees              an isolated worktree, green baseline
  6  Superpowers  test-driven-development          red → green → refactor
  7  Superpowers  requesting-code-review           a fresh subagent reads the diff
  8  armature     verify                           runs the .armature.json verify list
  9  Superpowers  finishing-a-development-branch   pushes and opens the pull request
 10  armature     item_status                      → the board's review status
```

Step 2 is the reason armature exists. `#278` names a different issue in every repository on the
board, and the epic for `acme/checkout#278` is an `acme/platform` number that means something else
in checkout. Every reference in and out is qualified for exactly that reason.

Step 9 is where the two plugins have to be told apart. `finishing-a-development-branch` offers to
merge the branch locally; armature takes its push-and-open-a-PR option instead and never asks. The
never-merge rule is armature's, not that skill's — a human merges.

Armature reimplements none of Superpowers and requires none of it. Without it the same ten steps
run, with a plain feature branch, a hand-written failing test, a re-read of the diff, and
`gh pr create` standing in for steps 5, 6, 7 and 9 — the skill's
[Without Superpowers](./skills/working-the-board/SKILL.md#without-superpowers) table says which.

## Working a whole epic

`/armature-next` works one item. `/armature-epic` works every actionable child of one epic, in
order, without stopping between them:

```
/armature-epic acme/web#10

  #11  claim → worktree → TDD → review → PR #A → main
  #12  claim → worktree(base issue-11-…) → … → PR #B → issue-11-…
  #13  claim → worktree(base issue-12-…) → … → PR #C → issue-12-…

  3 PRs stacked A ← B ← C. Merge bottom-up.
```

A child that declares a blocker branches from **that blocker's branch**, not from the default
branch, so its pull request contains the work it depends on. A child with no blocker branches from
the default branch and gets an independent PR. Armature never merges the stack — you do, bottom-up.
Delete each branch as its PR merges, so GitHub retargets the next PR onto the default branch. If you
squash-merge, rebase the next PR onto the default branch before merging it: it still carries the
commits the squash replaced.

Each child is worked by its own subagent running the `/armature-next` loop from step 2 — the
controller has already chosen the item — so the run survives an epic of any length: the controlling
session never reads the implementation, and it re-reads its place from the board every iteration
rather than remembering it.

The run stops for three things and nothing else: a cross-child file collision, a review that cannot
be satisfied, and a red verify. A child that needs a person is skipped rather than claimed, and when
skipping leaves nothing actionable the run ends and tells you what it left behind — running out of
work is the run finishing, not a failure.

Two things to know before a long unattended run:

- **The children's tools need approving at the session level.** A command's `allowed-tools` do not
  reach the subagents it dispatches, so each child's tools — file edits, `git`, `npm`, `gh pr`, the
  worktree tool and the armature tools themselves — prompt unless your permission mode or
  `settings.json` already allows them.
- **Stacked PRs may not show up on the board.** GitHub links a `Closes #N` only on a PR that
  targets the default branch, so a stacked child's PR is likely invisible to `epic_survey` until
  its base merges. The run keeps its own record of each child's PR to cope, which a resumed session
  does not have — see [follow-ups](./docs/superpowers/follow-ups.md).

## Configuration

Armature derives as much as it can and asks you to state only what it can't. The one file you
might write is `.armature.json` at a repository's root:

| key | required | meaning |
| --- | --- | --- |
| `board` | sometimes | `{ "provider": "github", "owner": "...", "number": N }`. Skip it if the repository sits on exactly one GitHub Projects board — armature finds it by asking the repository which boards link to it. Required only when a repo is on zero or several boards. |
| `alias` | no | A short name this repository claims for itself, so other repos on the board can reference its issues as `alias#42` instead of `owner/repo#42`. |
| `verify` | no | Commands to run before opening a PR. Falls back to the project's own test suite when absent. |

`ARMATURE_BOARD=github:owner/number` overrides `.armature.json` from the environment, and
`~/.config/armature/config.json` (same shape) supplies a default for repositories that declare
neither. Everything else — which repositories are on the board, what its statuses mean, which
item is whose epic, whether two repos collide on the same issue number — is derived by querying
the board itself, not configured.

Epic membership comes from GitHub's native sub-issue parent links. There is no separate
in-body convention to declare it. `item_create` sets that link when you pass it a `parent`, and the blocking links when you pass
`blockedBy`, so a fan-out of new issues lands under its epic, in sequence, rather than as a flat list
somebody has to re-parent by hand afterwards.

## Credential

Armature borrows a credential rather than asking for one of its own: it tries `gh auth token`
first, then the `GITHUB_TOKEN` and `GH_TOKEN` environment variables, in that order. Whichever it
finds needs the `repo` and `project` scopes to read and write issues and board items — which
means a **classic** token. A fine-grained personal access token cannot reach a board owned by a
user account at any permission level: GitHub offers no account-level Projects permission for one,
and the API answers `Resource not accessible by personal access token`. A board owned by an
organization is reachable with a fine-grained token's organization Projects permission.

## Try it against a real board safely

Set `ARMATURE_DRY_RUN=1` before pointing armature at a board for the first time. Every read
still runs for real; every write is computed and reported but never sent. A dry run says so: the
tool result carries `dryRun: true`, and so does the structured line every write emits to stderr,
so a computed effect is never mistaken for one that landed. Drop the variable once you trust what
it's about to do.

## Tools

The MCP server exposes seven tools:

| tool | does |
| --- | --- |
| `board_next` | The next actionable item, with the reason it won — or a blocked explanation. Narrow it with `repo` or `epic`. Never returns an item titled `Spec:` or `Epic:`, and names the todo items it skipped for that title. |
| `board_survey` | A normalized snapshot of the whole board: items, repositories, statuses, collisions. |
| `item_get` | One work item's body, status, task-list checklist (each entry's text, state and nearest heading), and epic (with the repository the epic lives in). |
| `item_claim` | Move an item to the board's claimed status. Verified before and after the write. |
| `item_status` | Move an item to any status the board offers. Verified before and after the write. |
| `item_create` | Create an issue, add it to the board, and set its status — todo unless `status` names another — then optionally file it under a `parent` and mark it blocked by `blockedBy`, so `board_next` can return it, correctly ranked, without a second call. Each step is verified, and a failure says exactly which steps landed. |
| `epic_survey` | An epic and its children in working order: each child's status, labels, blockers, and linked pull requests with their branches, plus which child is next and why — the same answer `board_next` gives. A sub-issue that is not on the board is reported separately, never dropped. |

Every reference in and out is `owner/repo#number`, or a `github.com` issue URL. A bare number is
refused, and armature never emits one.

## Commands

- **`/armature-next [owner/repo#number or issue URL]`** — work the next actionable item on the
  board, on a branch, ending in a PR. Given a reference, works that item instead. With Superpowers
  it isolates the work in a git worktree without asking; add `no worktree` to the arguments to
  branch in the current checkout for that run.
- **`/armature-epic <owner/repo#number or issue URL>`** — work every actionable child of that epic,
  each on a branch stacked on its blocker, each ending in its own PR — see
  [Working a whole epic](#working-a-whole-epic). Takes `no worktree` the same way, once for every
  child.
- **`/armature-doctor`** — reports what armature derived about your board (its identity,
  repositories, inferred status meanings, any colliding issue numbers) so you can check it
  before trusting it.

## Skill

`working-the-board` is the judgment layer on top of the tools: choose, read, claim, isolate,
implement, review, verify, open a PR, hand back — and it never merges. It composes with Superpowers
where that is installed and falls back to plain instructions where it is not, as
[above](#better-with-superpowers). Either way it refuses to fall back to raw `gh` commands to read
or write the board if the armature tools are unavailable — it stops and says so.

`working-an-epic` is the controller above it: it surveys an epic with `epic_survey`, picks each
child's base branch, and dispatches one subagent per child to run `working-the-board` — never
implementing anything itself.

`filing-a-plan` is where a plan starts: it files a design spec as a `Spec:` issue in the board's
claimed status, then its plan as an `Epic:` with one child per task — or as a single issue — each
linked to its parent and to what it waits on, through `item_create` alone.

## License

MIT — see [LICENSE](./LICENSE).
