# AGENTS.md

Guidance for any coding agent working in this repository. Agent-agnostic by design: `CLAUDE.md`
imports this file, and other agents read it directly.

## Commands

```bash
npm test                              # vitest run — the whole suite
npm run typecheck                     # tsc --noEmit
npm run build                         # esbuild → dist/server.js (COMMITTED, see below)

npx vitest run tests/next.test.ts     # one file
npx vitest run -t 'never emits a reference'   # one test by name
npx vitest                            # watch mode
```

Integration tests are env-gated and skipped by default. They hit a real scratch board and a real
credential; the second file exists to send the GraphQL documents to the live schema, which no
other test does:

```bash
ARMATURE_INTEGRATION=1 ARMATURE_IT_OWNER=<owner> ARMATURE_IT_BOARD=<n> ARMATURE_IT_REPO=<repo> \
  npx vitest run tests/integration
```

`ARMATURE_DRY_RUN=1` makes every write compute-and-report without sending. Reads still run.

## What this is

An agentic engineering harness, packaged as a plugin: an MCP server (`server/`), two slash commands
(`commands/`), and one skill (`skills/working-the-board/`). It drives GitHub Projects board items
across many repositories. The server holds **facts and effects**; the skill holds **judgment**
(prerequisite checks, "work epics in order", never-merge). Do not move judgment into the server or
facts into the skill — the split is deliberate and `tests/packaging.test.ts` asserts parts of it.

## Architecture

**Layering, outermost first:**

- `server/index.ts` — MCP tool surface. `TOOLS` is the advertised schema; `dispatch()` is the
  pure, provider-agnostic handler, exported so tests drive it with a fake `BoardProvider` and no
  network. The low-level MCP `Server` does **not** validate arguments against `inputSchema`, so
  every argument is re-checked here (`refArgument`/`requiredString`/`requiredText`/
  `optionalString`) and raises a domain error. `main()` is the only thing that wires real IO.
- `server/config.ts` / `server/config-io.ts` — a deliberate pure/impure split. `resolveConfig()`
  is a total function over an injected `ResolveInput`; every filesystem read, `git` invocation and
  API call that feeds it lives in `config-io.ts`. Board precedence: `ARMATURE_BOARD` env → repo
  `.armature.json` → `~/.config/armature/config.json` → derived from the one board linked to the
  repo. Which layer won is carried as `boardSource` because `/armature-doctor` reports it.
- `server/providers/types.ts` — `BoardProvider` is the tracker-neutral seam. Anything GitHub-shaped
  (owner, number, GraphQL) must stay behind it; `BoardIdentity.name` is a string for that reason.
- `server/providers/github/` — the only adapter. `client.ts` (GraphQL + pagination + rate limits),
  `board.ts` (`survey`, status-semantics inference), `items.ts` (read/claim/setStatus/create),
  `next.ts` (`selectNext` ranking), `aliases.ts` (sibling `.armature.json` lookup),
  `provider.ts` (caching + invalidation).
- `server/ref.ts` + `server/url.ts` — reference parsing and host/credential hygiene.

**Two caches, both `??= await` on purpose.** `GitHubBoardProvider.survey()` and
`makeRefResolver`'s alias map both use `cached ??= await build()` so a *rejected* build leaves the
cache null and the next call retries cleanly instead of replaying the first failure forever. Keep
that idiom if you touch either.

**The snapshot cache is dropped in a `finally` after every write.** `BoardSnapshot` mixes stable
derived facts (field ids, status options, semantics) with live per-item `status`; sharing one
object meant a cached snapshot made `board_next` return the item it had just claimed. Invalidation
is in `finally`, not on success, because `OrphanedIssueError` / `UnverifiedWriteError` are exactly
the cases where the board state is most in doubt.

**Startup must not require configuration.** `main()` connects the stdio transport *before* any
credential or board resolution; `makeServiceLoader` defers that to the first tool call. A freshly
installed plugin has no board by definition, and a `ConfigError` thrown before `connect()` reaches
a stderr the MCP client discards. Never hoist config resolution back above `server.connect()`.

## Invariants that break things quietly

- **`dist/server.js` is committed.** CI runs `npm run build` and `git diff --exit-code dist/server.js`.
  Run `npm run build` and commit the bundle in the same change as any `server/**` edit.
- **The version lives in six places** (`package.json`, `.claude-plugin/plugin.json`,
  `.claude-plugin/marketplace.json` ×2, `server/version.ts`, `dist/server.js`) and
  `tests/packaging.test.ts` pins them equal. release-please bumps all six via `extra-files`.
  The bundle is in that list only because `esbuild.config.mjs` re-attaches the
  `x-release-please-version` marker after building — esbuild inlines `VERSION` as a bare literal and
  drops the comment, and without the marker release-please skips the file in silence. The build
  asserts the anchor matches exactly one line rather than trusting it. Don't hand-edit versions.
- **`tests/packaging.test.ts` asserts on prose.** It reads `README.md`, `skills/working-the-board/SKILL.md`,
  `commands/*.md` frontmatter, and both workflow files — section ordering, the Superpowers step
  numbering shared between README and SKILL, `allowed-tools` covering the tools each command calls.
  Editing docs or workflows can turn the suite red; run `npm test` after doc changes too.
- **`tests/setup.ts` throws if a mutation log line reaches the real stderr.** Pass `logWrite` in
  `DispatchOptions` and assert on what was captured.
- **Never emit or accept a bare issue number.** Numbers repeat across repositories on one board —
  that collision is the production incident the whole codebase is shaped around (see
  `docs/superpowers/specs/`). Refs are `owner/repo#number` or a `github.com` issue URL; a JSON
  number argument raises `BareRefError`, not a type error.
- **Every write is read back and verified.** `setStatus` compares the read-back to the intent and
  raises `UnverifiedWriteError` otherwise; `claim` additionally asserts the prior status
  (`StaleItemError`). A half-landed `item_create` gets its own error per end state —
  `OrphanedIssueError` (off the board) vs `StatuslessItemError` (on it, status unconfirmed).
  New mutations follow the same shape; don't add an unverified one.
- **Dry-run results must be marked and must not invent data.** `presentMutation` adds
  `dryRun: true`; `presentCreated` drops `ref` entirely, because a created item has no number yet
  and `acme/web#0` reads as real. A dry-run prediction that doesn't match the real path is the
  recurring bug here (`createItem`'s dry-run branch has been wrong in both directions).
- **Errors carry the fix, and never carry a credential.** Every failure mode is a named `Error`
  subclass whose message says what happened, what state the board is in, and what to do. Any
  message that interpolates a remote, a URL, or git's stderr goes through
  `redactCredentials()`/`hostnameOf()` — `https://user:TOKEN@github.com/...` is an ordinary remote.

## Testing shape

- Unit tests inject fakes: a `BoardProvider` object for `dispatch`, a `{ graphql, collectAll }`
  duck-typed `GitHubClient` for the adapter, explicit `read`/`logWrite`/`env`/`cwd` deps elsewhere.
  Nothing in `tests/*.test.ts` touches the network.
- `tests/contract/provider.contract.ts` is the backend-agnostic suite every future adapter must
  pass (a Jira adapter's definition of done). Its first test is a precondition on the *fixture* —
  the board must contain a real number collision, or the rest is vacuous.
- **A fake client accepts any GraphQL document.** That is how an invalid `owner{ login }` selection
  shipped and broke board derivation everywhere. Query changes are only really validated by
  `tests/integration/queries.integration.test.ts`; export a new document and add it there.

## Deliberate non-features

Read `docs/superpowers/follow-ups.md` before "fixing" something that looks incomplete.
`parseEpicFromBody` in `items.ts` is fully tested, exported, and intentionally not called — it
needs a config gate and two unclosed parsing holes first. `item_create` takes no `parent` on
purpose and refuses one loudly (`UnsupportedParentError`) rather than discarding it silently.
Epic membership comes from GitHub's native sub-issue parent links only.
