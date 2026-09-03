# Armature — Plugin Skeleton and GitHub Provider (Design)

**Date:** 2026-09-03
**Scope:** Sub-project 1 of 5. The plugin package, its MCP server, and the GitHub Projects provider.
**Status:** Approved design, pending implementation plan.

## Goal

Ship a Claude Code plugin that drives work items on a project board across many repositories, where
the board API is a typed MCP tool surface rather than instructions a model must remember. Version 1
replaces a slash command that currently exists as four diverging copies, and does so in a package
built to be published, installed by strangers, and extended to other trackers.

## Why this exists

Superpowers 6.3.0 ships fourteen skills. None of them knows what a ticket is: a search across every
skill for `gh`, "github issue", "multi-repo", and "cross-repo" returns nothing. Its model is one
repo, one worktree, one branch, with plans on disk at `docs/superpowers/plans/` and a per-workspace
`progress.md` ledger. The layer above — a roadmap, its epics, and their tickets spread over many
repositories — is unoccupied, and it is the layer every mature engineering organisation runs on
regardless of how much agentic work happens beneath it.

The prior art is a single slash command, `roadmap-next`, copied into four repositories in the
`pixelsonly` organisation. It is unusually good: it encodes an actual production incident, three
distinct GitHub API footguns, and a correctness-by-construction principle. It is also the proof that
prose cannot hold this knowledge.

**The incident.** From the command's own text:

> ISSUE NUMBERS ARE NOT UNIQUE ON THIS BOARD. Project 6 spans four repos, each numbering its issues
> from 1, so one number names a different issue in each … a run that matched on number alone set
> THIS repo's #278 to "In progress" while working apex's #278, and the wrong item was a closed issue
> in a finished epic. **Nothing errored, and nothing would have.**

**The drift.** Four copies, four distinct checksums, 66 / 68 / 78 / 98 lines. The knowledge is not
evenly distributed: only the `pixelsonly-racing-harness` copy learned that

> **Epics do not live in this repo.** Harness issues are leaves of cross-repo epics owned by
> `pixelsonly/race-engineer` … note the parent's `repository{nameWithOwner}`, because that "#NNN" is
> a race-engineer number and means something else here.

The other three copies do not know this. Meanwhile all four still assert the board is "past 110
items"; it holds 38. Prose duplicated N times rots in N directions.

**The same failure, one layer up.** `docs/CONTRACTS.md` exists twice in the same organisation —
812 lines in `race-engineer`, 400 in `pixelsonly-racing-harness`, edited a day apart. And
`race-engineer/docs/paddock.md` names `paddock_session` "a three-repo contract (broker, apex, and
the engine Worker), so renaming it breaks all three", with enforcement supplied entirely by human
memory. Those problems belong to sub-projects 2 and 3; they are recorded here because they are why
the package must be built to grow.

## Non-goals

- **No second provider.** Jira and Asana adapters are sub-project 4. Every good line in the prior
  command came from running it into a wall; adapters written from imagination would be the weakest
  and least supportable part of the plugin. The seam is designed here, one side is implemented.
- **No cross-repo fan-out.** Turning one design into N per-repo plans and an epic with sub-issues is
  sub-project 2.
- **No contract registry or drift checking.** Sub-project 3.
- **No launch.** `marketplace.json` ships in v1 so the plugin is installable by URL, but announcing
  it, listing it anywhere, and writing the documentation a public audience needs are sub-project 5.
- **Nothing organisation-specific.** Pixelsonly Racing is consumer number one, not the schema. No
  repository name, board number, alias, or convention from that organisation may be hardcoded.

## Package and distribution

Public repository `ryanlindsey/armature`, MIT licensed, released with release-please over
Conventional Commits.

```
armature/
  .claude-plugin/
    plugin.json          name, version, commands, skills, mcpServers
    marketplace.json     self-hosted; /plugin marketplace add ryanlindsey/armature
  commands/              /armature-next, /armature-doctor
  skills/                armature:working-the-board
  server/                TypeScript MCP server (source)
  dist/server.js         committed single-file bundle
  tests/
```

**MCP is declared in `plugin.json` under `mcpServers`**, following the `cq` plugin, which launches
its server as `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.py`. The official `github` plugin's
`.mcp.json` is the remote-HTTP pattern and does not apply to a server we ship.

```json
{
  "name": "armature",
  "license": "MIT",
  "commands": "./commands/",
  "skills": "./skills/",
  "mcpServers": {
    "armature": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server.js"] }
  }
}
```

**The bundle is committed.** Installing a plugin does not run `npm install`, so a `server/` of
TypeScript beside a `package.json` would simply fail to start. `cq` solves this by fetching a
versioned Go binary at launch; for TypeScript the simpler answer is esbuild to one file, committed,
run by `node`. No network at startup, no cache directory, works offline, and release-please already
versions it.

**Authentication is borrowed, never invented.** The server resolves a credential in order: the
GitHub CLI's `gh auth token`, then the `GITHUB_TOKEN` environment variable, then `GH_TOKEN`. This
adds nothing for the user to create, export, or forget, and inherits scopes they already hold. When
all three sources miss, the
server fails at startup with a message naming the fix. The failure mode being avoided is concrete:
in the session that produced this design, the official `github` MCP server failed to connect with
`"Authorization header is badly formatted"` because it interpolates an unset variable into a header.
A missing credential must read as a missing credential, not as a malformed request.

## The MCP tool surface

Six tools. Names are tracker-neutral — `board_*` and `item_*`, never `gh_*` — so the sub-project 4
adapters implement this surface instead of forking it.

| Tool | Takes | Returns / effect |
|---|---|---|
| `board_next` | `repo?`, `epic?` | the next actionable item, and why it won and what blocked the rest |
| `item_get` | `ref` | body, status, board fields, parent epic with its repository, sub-issues |
| `item_claim` | `ref` | transition to the claimed status; returns the observed post-state |
| `item_status` | `ref`, `status` | any transition, read-after-write verified |
| `item_create` | `repo`, `title`, `body`, `parent?` | issue, board membership, and fields together |
| `board_survey` | `filter?` | normalized snapshot of the whole board |

### The `ref` type

There is exactly one work-item reference and it is always fully qualified:
`pixelsonly/race-engineer#339`. The server refuses a bare number as input and never emits one as
output, so a number cannot be lifted from one response into a later call. The `#278` incident is not
guarded against — it becomes inexpressible. Under a Jira provider the same field carries `PROJ-123`:
opaque to the model, parsed by the provider, surface unchanged.

### Guarantees

- **No pagination parameter exists.** Not defaulted generously — absent. The server pages to
  exhaustion internally. This retires the `--limit` warning, the 30-item default, and the
  100-per-page cap on `projectV2 { items }` in one stroke, because under-fetching is not a thing a
  caller can request.
- **Item resolution is rooted at the issue**, `repository(owner,name){issue(number){projectItems}}`.
  One request, nothing to paginate, structurally unable to return another repository's item. This is
  the prior command's own rule, promoted from prose the model must obey into the only code path.
- **Writes are verified.** `item_claim` reads the status back and returns what it observed; a
  mutation that reports success without landing is an error. This is the precise failure that let
  the `#278` corruption pass unnoticed.
- **`item_create` cannot orphan an issue.** It creates, adds to the board, and sets fields. A failed
  board-add is reported loudly rather than leaving an issue that `gh issue create` never added.
- **Errors are data.** `board_next` with nothing actionable returns
  `blocked: epic pixelsonly/race-engineer#339 is not Done`, not an empty result.
- **The model never writes a query.** The `repository` field being a URL rather than `owner/name` —
  a trap that makes a filter silently match nothing — stops being reachable.

Tools supply facts and effects. Judgment stays in skills: the server never decides what is worth
doing, only what is true and what changed.

## Config and discovery

**The governing rule: a repository declares only facts about itself.** No file anywhere contains a
fact about a different repository. This is what makes drift structurally impossible rather than
merely discouraged.

### Declared — `.armature.json`, repository root

```json
{
  "board":  { "provider": "github", "owner": "pixelsonly", "number": 6 },
  "alias":  "engine",
  "verify": ["npm test", "npm run typecheck"],
  "commit": { "convention": "conventional", "types": "release-please-config.json" }
}
```

Four keys. `repo` is deliberately absent — it is read from the `origin` remote, so a fork or rename
cannot desynchronise it. `alias` is consumed by cross-repository reference resolution; `verify` and
`commit` are read by the skill rather than the server — the first supplies the commands run before a
PR is opened, the second determines the PR title convention. The server executes neither.

### Derived — written down nowhere

Repositories on the board; status option names and identifiers; field identifiers; which items are
epics; number collisions; and which repository an item's epic lives in. Cached in memory for the
server's lifetime and never persisted — a derived fact written to disk is a declared fact with extra
steps.

### Aliases

Resolving `apex#272` to `pixelsonly/pixelsonly.racing#272` is the one genuinely cross-repository
need. Placing that mapping in a per-repo file would rebuild the four-copy problem in JSON.

Instead: **each repository declares its own alias, and the server reads its siblings' `.armature.json`
over the API.** The sibling list comes from the board, which is derived. Every alias is declared
exactly once, in the repository it names, and no file mentions another repository. The fetch is lazy,
triggered only by an unrecognised alias, and cached.

This also resolves an existing collision: `apex#272` and `racing#293` currently both denote
`pixelsonly/pixelsonly.racing`. Under this scheme a repository declares one alias about itself.

### Epic location

Harness's rule does not become configuration; it stops being a rule. GitHub's sub-issue parent link
carries `repository{nameWithOwner}`, so an item's epic location is a **derived property of that
item**, resolved per lookup. Prose needed a hardcoded fact because prose cannot compute. Where
sub-issues are not in use, an optional declared pattern parses a body convention such as
`Part of the … epic in pixelsonly/race-engineer (Epic N, issue #NNN)`; the native link always wins.

### Status semantics

Status *names* are derivable; status *meanings* are not. Nothing in the API says which of
`Todo | In progress | Validation | Done | On hold | Canceled` means "claimed".

This cannot live in `.armature.json`, because it is a fact about the board, and ten repositories
restating it is the drift this design exists to prevent. Resolution: infer from a synonym table
(`in progress`, `doing`, `wip`, `started`), override in the user-level config keyed by board —
declared once per person, never per repository — and print the inference in `/armature-doctor`.

### Precedence and the zero-config path

Environment overrides, then the repository's `.armature.json`, then `~/.config/armature/config.json`,
then derivation.

With no configuration at all: derive the repository from `origin`; if exactly one board contains it,
use that board; if several do, error naming them. Armature therefore works on install for the common
case, which matters for a plugin nobody has configured yet.

## Skills and commands

**Ships in v1:** one skill, `armature:working-the-board`, and two commands, `/armature-next [ref]`
and `/armature-doctor`. `/armature-plan` and `/armature-check` arrive with sub-projects 2 and 3.

The skill's `description` carries the full tracker vocabulary — roadmap, board, epic, ticket, issue,
sprint, next task — so it triggers for a Jira user who has never said "board".

**What the prior command loses.** Every deleted line encoded API behaviour, and every deleted line
was duplicated four times and drifted:

| Prior command | Fate |
|---|---|
| number-collision warning and incident report | deleted — bare refs are inexpressible |
| `--limit`, 30-item default, 100-per-page cap | deleted — no pagination parameter exists |
| `repository`-is-a-URL filter trap | deleted — the model never writes a filter |
| three GraphQL queries and item-id resolution | deleted — `item_claim` |
| read-back verification command | deleted — `item_claim` returns observed state |
| epic to lowest-numbered Todo sub-issue query | deleted — `board_next` |
| "porting this to another repo" footer | deleted — one install, no copies |
| order by epic, honour "Depends on" | survives — policy |
| not on the board, ask before adding | survives — policy; detection is the server's |
| branch, implement, verify | survives — and defers, below |
| PR title is a Conventional Commit, `Closes #n`, do not merge | survives — policy |
| report the PR link and stop | survives — policy |

Roughly 68 lines become 20. What survives is judgment, which does not rot.

**Composition with Superpowers is soft.** Armature picks and claims; Superpowers executes:
`using-git-worktrees` → `test-driven-development` → `requesting-code-review` →
`finishing-a-development-branch`, after which armature opens the PR and moves the item to the review
status. Armature reimplements none of it and requires none of it — most installers will not have
Superpowers — so it names those skills when present and falls back to plain instructions otherwise.

`Validation` is the status an item takes when its PR opens. Armature never merges.

## Failure modes and degradation

The governing rule is drawn from the incident: **fail loud, never partial.** Any condition that could
produce a partially-correct answer raises rather than returns.

| Condition | Behaviour |
|---|---|
| No credential from `gh auth token`, `GITHUB_TOKEN`, or `GH_TOKEN` | fail at startup naming the fix |
| Credential lacks the `project` scope | name the remedy: `gh auth refresh -s project` |
| MCP server unavailable | the skill detects absent tools and refuses board writes |
| Rate limited | back off, surface remaining quota, never return partial pages |
| Item claimed by another actor between `board_next` and `item_claim` | pre-state verified; fail reporting what was found |
| Repository on multiple boards with no config | error naming them |
| Unknown alias | error naming candidates; never guess |

**There is deliberately no prose fallback for board writes.** Degrading to raw `gh` commands would
route every write through exactly the traps this design removes — the pagination default, the URL
filter, the bare number — making the plugin safest when it works and most dangerous when it breaks.
Refusal is the correct posture. MCP servers do fail: the session that produced this design had one
dead on arrival.

Every write emits a structured stderr line carrying ref, field, before, and after. Given a corruption
that went unnoticed, a mutation log is the difference between "something is off" and "here is the
write that did it". Credentials are never logged.

## Testing

1. **Fixtures.** Sanitized recorded API responses, replayed offline. Ordering, epic resolution,
   pagination assembly, and status inference become pure functions over recorded JSON. The `#278`
   regression test lives here: a fixture in which two repositories both hold `#278`, asserting that a
   bare number is refused.
2. **Provider contract suite.** A backend-agnostic set of guarantees every adapter must satisfy. This
   is what makes sub-project 4 tractable — a Jira adapter's definition of done becomes "pass these"
   rather than "read the GitHub adapter and imitate it".
3. **Disposable board.** A real project created in a scratch account, seeded and torn down in CI
   under its own credential. Never a production board.
4. **Read-only dogfood.** `board_survey` against a live board with writes disabled, asserting the
   derived view matches reality.

`ARMATURE_DRY_RUN` makes every mutation return its intended effect without performing it — required
by the tests, and the safe way to point armature at a real board the first time.

CI asserts that the version in `.claude-plugin/plugin.json` equals its `marketplace.json` entry. A
drift there silently serves a stale plugin: the same class of bug as everything else designed out
here, one layer up.

## Recorded for later sub-projects

Decisions reached alongside this design that bind sub-project 2, recorded so they are not
re-litigated:

- **Artifact ownership.** Durable architecture documents hold the present tense and live centrally;
  epic issues are append-only history; plans are per-repository; the board is the cross-repo index.
  To know what is true, read the document; to know why, read the epic.
- **Epic placement.** An epic lives in the repository doing the most work, measured by plan task
  count rather than judged. Ties break to the repository owning the contract under change, then to
  the platform hub. `gh issue transfer` makes a wrong call recoverable.
