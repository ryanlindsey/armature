# Follow-ups after v1

Distilled from the execution ledger of
`docs/superpowers/plans/2026-09-03-armature-plugin-github-provider.md`, after the whole-branch
review, one fix wave, and one scoped re-review. Everything here was found deliberately and
deferred deliberately — none of it is a known correctness defect in shipped code.

## Work to do

~~**`item_create` cannot link a parent.**~~ **Done, 2026-09-12, in ryanlindsey/armature#47.** It
takes a `parent`, resolves it before creating anything, links it last, and verifies the link by
reading it back; `addSubIssue` turned out to be generally available on the scopes armature already
asks for. The spec's 2026-09-12 amendment says why it is shaped that way. Struck through rather
than deleted: this file is the record of what was deferred deliberately, and an entry that simply
vanishes reads as one that was never there.

**The configuration gate for `parseEpicFromBody`.** The function and its 27 tests are intact and
exported, but nothing calls them and esbuild tree-shakes them out of the shipped bundle. The spec
describes this fallback as "an optional **declared** pattern", which is the gate that does not yet
exist. Before wiring `parseEpicFromBody` into any live path, close the hole named in the comment
above it: HTML blocks such as `<pre>` or `<details>`. (`codeMask` itself now feeds `item_check`
through `parseChecklist`; the Deferred note on its HTML-block hole says why the hole is tolerable
there.) (Tab-stop-expanded indentation, the other hole, is closed:
`codeMask` counts CommonMark columns.) Three rounds of
tightening a heuristic failed before it was cut; a fourth should not start without that gate.

**Cross-epic prerequisite blocking.** `SKILL.md` carries the "Depends on" policy, but nothing
enforces it. The spec allocates judgment to skills and facts to the server, so this belongs in the
skill — enforcing it server-side would require parsing "Depends on" out of free prose, which is
the hazard that ended `parseEpicFromBody`.

**`working-the-board` still reads prerequisites out of prose.** `blockedBy` is a real GraphQL field
returning structured refs, and `epic_survey` already reports it, so the single-item skill's
prerequisite rule should probably read that instead of parsing "Depends on" out of English — the
same argument that ended `parseEpicFromBody`. Deferred from ryanlindsey/armature#58 because it
changes the existing skill rather than adding one.

**`working-the-board` has no clause for a stacked prerequisite.** Its step 3 stops on any
prerequisite not in the board's done status. Inside an epic run the blocker's PR is deliberately
unmerged, so `working-an-epic` carries the reachability ruling (`git merge-base --is-ancestor`) in
each child's brief, and the child relies on the brief overriding the skill's text. That works, but
it is an override the single-item skill never names. Naming it there — "unless the brief that
dispatched you rules the prerequisite reachable from your base" — would make the composition
explicit. Deferred from ryanlindsey/armature#62, whose epic forbids modifying `working-the-board`.

**A stacked child's PR may be invisible to `epic_survey`.** `pullRequests` comes from
`closedByPullRequestsReferences`, and GitHub honours a closing keyword only on a PR that targets the
default branch. Every stacked child's PR targets its blocker's branch, so it likely has no link, and
the ledger would read it as "claimed, no PR" — interrupted. Found in review of
ryanlindsey/armature#62 and **not yet confirmed live**. `working-an-epic` works around it with a
per-run record of each child's reported PR, which does not survive compaction; the durable fix is
server-side — find a child's PR by its head branch, or link it explicitly — and should be confirmed
on the integration board before `/armature-epic` (ryanlindsey/armature#63) is relied on.

**`humanLabel` is not read by any code.** ryanlindsey/armature#58 declares it in `.armature.json`
and `working-an-epic` consults it, but `server/config.ts` neither parses nor validates it, so a typo
in the key is silently a board with no human-only children. `/armature-doctor` reporting it would be
the cheap fix.

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
- **`parseChecklist` is narrower than GFM.** It misses entries rather than invent them, which
  leaves a box unreadable and unflippable but never writes into text GitHub does not render as a
  task. Three gaps: a nested task indented four or more columns is masked as indented code,
  because `codeMask` is not list-aware; ordered (`1. [ ]`) and blockquoted (`> - [ ]`) tasks are
  not read; and setext or empty ATX headings are not recognised as headings.
- **Checklist entries indented four or more columns are not tickable.** The first gap above, seen
  from the live path: a nested acceptance criterion is absent from `item_get`'s checklist, so it is
  neither tickable by `item_check` nor listed in the receipt. That is the cheap direction of the asymmetry the rule exists for, but nested task
  lists are common enough in real issue bodies to be worth recording rather than rediscovering.
- **`codeMask`'s HTML-block hole is now on a live path.** A `- [ ]` inside `<pre>` or `<details>`
  reads as a real entry. The instruction under *Work to do* — close the HTML hole before wiring
  `codeMask` into a live path — was written for `parseEpicFromBody`, whose failure mode was a
  silent wrong-epic attachment that steers what work is selected next. Here the worst case is one
  character changed inside a code sample, bounded by the byte-diff invariant, visible in the
  issue's edit history and named in the PR's acceptance receipt, and reachable only if the skill found real evidence for a criterion that is actually a
  code sample. Still worth closing; no longer blocking.
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
