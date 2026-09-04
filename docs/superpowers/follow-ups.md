# Follow-ups after v1

Distilled from the execution ledger of
`docs/superpowers/plans/2026-09-03-armature-plugin-github-provider.md`, after the whole-branch
review, one fix wave, and one scoped re-review. Everything here was found deliberately and
deferred deliberately — none of it is a known correctness defect in shipped code.

## Work to do

**`item_create` cannot link a parent.** v1 removed the parameter rather than ship one that was
resolved and then silently discarded; the spec carries a dated amendment explaining why. Adding it
back means an `addSubIssue` mutation plus read-back verification of the link, in the same shape as
every other verified write. Sub-project 2 needs this for cross-repo fan-out.

**The configuration gate for `parseEpicFromBody`.** The function and its 27 tests are intact and
exported, but nothing calls them and esbuild tree-shakes them out of the shipped bundle. The spec
describes this fallback as "an optional **declared** pattern", which is the gate that does not yet
exist. Before wiring it into any live path, close the two holes named in the comment above it:
tab-stop-expanded indentation, and HTML blocks such as `<pre>` or `<details>`. Three rounds of
tightening a heuristic failed before it was cut; a fourth should not start without that gate.

**Cross-epic prerequisite blocking.** `SKILL.md` carries the "Depends on" policy, but nothing
enforces it. The spec allocates judgment to skills and facts to the server, so this belongs in the
skill — enforcing it server-side would require parsing "Depends on" out of free prose, which is
the hazard that ended `parseEpicFromBody`.

## Residual coverage gaps

Code is correct in all four; only the tests are missing or misplaced.

| Where | Gap |
|---|---|
| `server/config-io.ts:56` | The redaction of git's stderr is untested — deleting it breaks nothing. Practically hard to reach, since `git remote get-url` failures do not quote the URL. |
| `server/providers/github/next.ts:47` | The item-side `.toLowerCase()` is unguarded because the fixture is all-lowercase; a future edit could delete it silently. |
| `tests/provider.test.ts:79` | A `currentStatus` helper is built and never called. The dry-run-does-not-mutate property is covered by `tests/items-write.test.ts:59`, which pre-dates the fix wave — this file is one unwritten assertion from covering it at the provider level. |
| `tests/integration/board.integration.test.ts` | The "claims nothing in dry run" test was repaired (it previously compared a memoised snapshot to itself and could not fail) but has never been executed, since the suite is env-gated. |

## Deferred, worth doing eventually

- **Typed GraphQL responses.** `client.graphql<any>` is used throughout `board.ts`, `items.ts`,
  `aliases.ts` and `config-io.ts` — a whole-codebase choice rather than a local lapse, and worth
  one typed pass.
- **A repeat-cursor guard in `collectAll`.** A server returning `hasNextPage: true` with an
  unchanging cursor would spin forever. It never returns partial data — a hang is the safer
  failure here — but it is unguarded.
- **`INSUFFICIENT_SCOPES` ordering.** The secondary-rate-limit check runs first, so a 403 carrying
  both a `retry-after` and a scopes error would be reported as a rate limit. GitHub does not send
  that shape today.
- **The "no Status field" message.** A board without one fails loud, but the wording implies its
  options are misnamed rather than absent.
- **`inferStatusSemantics` ties.** Same-category matches resolve first-wins with no comment and no
  signal that a second candidate was discarded. Defensible, since option order mirrors board
  column order.
- **`GraphQLError` is never asserted by class** — `client.test.ts` matches message text only.
- **`ResolvedConfig.verify`** is parsed and never read server-side. The skill reads
  `.armature.json` itself, so this is harmless; either expose it through a tool or drop the field.

## Considered and deliberately not doing

- **Validating the URL host in `parseRef` beyond GitHub.** Already restricted to GitHub hosts;
  broadening it would admit forges whose issue paths look identical.
- **Treating a 429 as anything other than a rate limit.** Broader than GitHub's documentation,
  correct in effect.
- **`__bold__` in the epic declaration grammar.** Applies only to the unwired
  `parseEpicFromBody`; revisit if that is ever gated in.
- **Ranking parentless items above epic children.** Deliberate "epics first" policy, and the
  `because` string states which rule applied.
- **Tie-breaking two epics with the same `epicOrder` by anything other than issue number.**
  Deterministic and sufficient.

## Two decisions worth not re-litigating

**`parseEpicFromBody` was descoped, not abandoned.** Three fix rounds each closed a hole in
parsing epics from arbitrary Markdown and a fourth found two more still open. Distinguishing
decorative content from prose has no fixed point, and the failure mode was a silent wrong-epic
attachment — which drives what work gets selected next. Epic detection uses GitHub's native
sub-issue parent links, which are unambiguous.

**Server-side prerequisite blocking was not implemented, and that is correct.** The plan's prose
said an epic with unfinished prerequisites should block rather than skip; the spec requires only
that a blocked result explain itself. Because ranking is by epic order, a later epic's child is
reached only when the earlier epic has no actionable children left — blocking there would stall a
user behind work already in flight.
