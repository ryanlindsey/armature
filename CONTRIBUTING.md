# Contributing to armature

Thanks for looking. This file is the human process: how to pick something up, how to run the
suite, and what a pull request has to carry. The engineering rules — the architecture, the
invariants, the testing shape — live in [`AGENTS.md`](./AGENTS.md), and this file links there
rather than repeating them, so there is one copy to keep current instead of two that drift.

By taking part you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Before you start: three things CI will otherwise teach you

This repository has a committed build artifact, tests that assert on prose, and some code that
looks unfinished on purpose. Each of these turns a reasonable-looking pull request red with no
explanation attached, so read them first.

1. **`dist/server.js` is committed.** Any change under `server/**` needs `npm run build`, and the
   rebuilt bundle committed in the same change. CI rebuilds and runs
   `git diff --exit-code dist/server.js`; a stale bundle fails there.
2. **`tests/packaging.test.ts` asserts on prose.** It reads the README, the skill, each command's
   frontmatter and both workflow files — section order, step numbering, which tools a command
   pre-approves. Editing any of them can turn the suite red, so run `npm test` after doc changes
   too, not only after code changes.
3. **Read [`docs/superpowers/follow-ups.md`](./docs/superpowers/follow-ups.md) before "fixing"
   something that looks incomplete.** Several gaps are decisions, not oversights.
   `parseEpicFromBody`, for one, is fully tested, exported and deliberately not called; the file
   says why, and what has to be true before it is wired in.

Two more worth knowing: never hand-edit a version (release-please owns all six copies), and never
emit or accept a bare issue number. [`AGENTS.md`](./AGENTS.md#invariants-that-break-things-quietly)
has the full list and the reasons.

## Picking something up

Issues labelled
[`help wanted`](https://github.com/ryanlindsey/armature/issues?q=is%3Aopen+label%3A%22help+wanted%22)
or [`good first issue`](https://github.com/ryanlindsey/armature/issues?q=is%3Aopen+label%3A%22good+first+issue%22)
are open for outside contributions; the harness ports under ryanlindsey/armature#30 are the main
ones, labelled `harness:<id>` and `tier-1` or `tier-2` by the tier they target.

To claim an issue, comment on it saying you are taking it. That is the whole mechanism — a
maintainer will assign it to you and move it to In Progress on the project board they track work
on. If an issue says
"Depends on `owner/repo#N`", check that item is done first; the prerequisite is real.

For anything without an issue yet, open an issue before a pull request so the approach can be
agreed before the work is done. Every template asks for references as `owner/repo#number`, not
`#number`: numbers repeat across the repositories one board tracks, and that collision is the
problem armature exists to solve.

## Running the suite

```bash
npm ci
npm test            # the whole suite; nothing in tests/*.test.ts touches the network
npm run typecheck
npm run build       # only needed after a server/** change — then commit dist/server.js
```

Integration tests are skipped by default because they need a real board and a real credential.
[`AGENTS.md`](./AGENTS.md#commands) shows how to run them, and one test by name.

## What a pull request must carry

- **A Conventional Commit title**, as `type(scope): summary`. Pull requests are squash-merged, so
  the title becomes the commit subject release-please reads to decide the version bump and write
  the changelog. A title without a recognized type ships nothing and says nothing about why. The
  types are the ones in [`release-please-config.json`](./release-please-config.json): `feat`,
  `fix` and `perf` bump the version; `docs`, `deps`, `refactor`, `chore`, `ci` and `test` do not.
- **A closing reference**: `Closes ryanlindsey/armature#<number>`.
- **A green suite**: `npm test` and `npm run typecheck`, plus a rebuilt and committed
  `dist/server.js` if you touched `server/**`.
- **For a harness port, the evidence.** The maintainer cannot install most harnesses, so what you
  paste stands in for verification: the `scripts/conformance <harness>` output, `tests/<harness>/`
  green in CI, and the install command and harness version you used. The pull request template has
  a block for all three; ryanlindsey/armature#30 explains the tiers.

A maintainer merges; nothing else does.
