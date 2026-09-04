# armature

A Claude Code plugin that drives epics and tickets across many repositories from one GitHub
Projects board, over a typed MCP tool surface — so "what's next" and "close this out" have one
implementation instead of a slash command copy-pasted into every repo.

## Install

```
/plugin marketplace add ryanlindsey/armature
/plugin install armature
```

That's it for most repositories — see [Configuration](#configuration) below for the zero-config
path and when you need to say more.

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
finds needs the `repo` and `project` scopes to read and write issues and board items.

## Try it against a real board safely

Set `ARMATURE_DRY_RUN=1` before pointing armature at a board for the first time. Every read
still runs for real; every write is computed and reported but never sent. Drop the variable once
you trust what it's about to do.

## Tools

The MCP server exposes six tools:

| tool | does |
| --- | --- |
| `board_next` | The next actionable item, with the reason it won — or a blocked explanation. Narrow it with `repo` or `epic`. |
| `board_survey` | A normalized snapshot of the whole board: items, repositories, statuses, collisions. |
| `item_get` | One work item's body, status, and epic (with the repository the epic lives in). |
| `item_claim` | Move an item to the board's claimed status. Verified before and after the write. |
| `item_status` | Move an item to any status the board offers. Verified before and after the write. |
| `item_create` | Create an issue and add it to the board together. Reports an orphan loudly if the add fails. |

## Commands

- **`/armature-next [owner/repo#number or issue URL]`** — work the next actionable item on the
  board, on a branch, ending in a PR. Given a reference, works that item instead.
- **`/armature-doctor`** — reports what armature derived about your board (its identity,
  repositories, inferred status meanings, any colliding issue numbers) so you can check it
  before trusting it.

## Skill

`working-the-board` is the judgment layer on top of the tools: choose, read, claim, isolate,
implement, verify, open a PR, hand back — and it never merges. When
[Superpowers](https://github.com/obra/superpowers) is installed, it uses
`superpowers:using-git-worktrees` and `superpowers:test-driven-development` for isolation and
TDD; without Superpowers it falls back to a plain feature branch and write-the-test-first by
hand. Either way, it refuses to fall back to raw `gh` commands if the armature tools are
unavailable — it stops and says so.

## License

MIT — see [LICENSE](./LICENSE).
