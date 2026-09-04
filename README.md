# armature

A Claude Code plugin that drives epics and tickets across many repositories from one GitHub
Projects board, over a typed MCP tool surface — so "what's next" and "close this out" have one
implementation instead of a slash command copy-pasted into every repo.

[Superpowers](https://github.com/obra/superpowers) models one repository, one worktree, one branch —
and none of its skills knows what a ticket is. Armature is the layer above: it decides which work is
next across every repository on the board, and hands the doing to Superpowers. Together they are the
whole path from "what's next" to an open PR — see [Better with Superpowers](#better-with-superpowers).

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
 1  armature      board_next                       picks pixelsonly/apex#278, and says why it won
 2  armature      item_get                         reads it — and its epic, which lives in
                                                     pixelsonly/race-engineer, not apex
 3  armature      item_claim                       → In Progress, verified before and after
 4  Superpowers   using-git-worktrees              an isolated worktree, green baseline
 5  Superpowers   test-driven-development          red → green → refactor
 6  Superpowers   requesting-code-review           a fresh subagent reads the diff
 7  armature      verify                           the .armature.json verify list
 8  Superpowers   finishing-a-development-branch   pushes, opens the PR — never merges
 9  armature      item_status                      → the board's review status
```

Step 2 is the reason armature exists. `#278` names a different issue in every repository on the
board, and the epic for apex's `#278` is a `race-engineer` number that means something else in apex.
Every reference in and out is qualified for exactly that reason.

Armature reimplements none of Superpowers and requires none of it. Without it the same nine steps
run, with a plain feature branch, a hand-written failing test, a re-read of the diff, and
`gh pr create` standing in for steps 4, 5, 6 and 8 — the skill's
[Without Superpowers](./skills/working-the-board/SKILL.md#without-superpowers) table says which.

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
in-body convention to declare it.

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

The MCP server exposes six tools:

| tool | does |
| --- | --- |
| `board_next` | The next actionable item, with the reason it won — or a blocked explanation. Narrow it with `repo` or `epic`. |
| `board_survey` | A normalized snapshot of the whole board: items, repositories, statuses, collisions. |
| `item_get` | One work item's body, status, and epic (with the repository the epic lives in). |
| `item_claim` | Move an item to the board's claimed status. Verified before and after the write. |
| `item_status` | Move an item to any status the board offers. Verified before and after the write. |
| `item_create` | Create an issue and add it to the board together. Reports an orphan loudly if the add fails. It does not link the new issue to a parent epic — set that on the issue afterwards. |

Every reference in and out is `owner/repo#number`, or a `github.com` issue URL. A bare number is
refused, and armature never emits one.

## Commands

- **`/armature-next [owner/repo#number or issue URL]`** — work the next actionable item on the
  board, on a branch, ending in a PR. Given a reference, works that item instead.
- **`/armature-doctor`** — reports what armature derived about your board (its identity,
  repositories, inferred status meanings, any colliding issue numbers) so you can check it
  before trusting it.

## Skill

`working-the-board` is the judgment layer on top of the tools: choose, read, claim, isolate,
implement, review, verify, open a PR, hand back — and it never merges. It composes with Superpowers
where that is installed and falls back to plain instructions where it is not, as
[above](#better-with-superpowers). Either way it refuses to fall back to raw `gh` commands if the
armature tools are unavailable — it stops and says so.

## License

MIT — see [LICENSE](./LICENSE).
