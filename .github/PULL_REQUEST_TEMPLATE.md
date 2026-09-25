<!--
The title is the commit release-please reads, because pull requests are squash-merged:
`type(scope): summary`. `feat` and `fix` bump the version; an untyped title ships nothing.
See CONTRIBUTING.md.
-->

## What and why

<!-- What this changes, and why. Link the issue in full: numbers repeat across repositories. -->

Closes ryanlindsey/armature#

## Checklist

- [ ] The title is a Conventional Commit (`feat`, `fix`, `docs`, …)
- [ ] `npm test` and `npm run typecheck` pass locally
- [ ] If `server/**` changed: ran `npm run build` and committed `dist/server.js` in this change
- [ ] If the README, the skill, a command or a workflow changed: ran `npm test` anyway — `tests/packaging.test.ts` asserts on prose
- [ ] Anything that looked unfinished was checked against `docs/superpowers/follow-ups.md` first

## Harness port

<!--
Only for a port under ryanlindsey/armature#30; delete this section otherwise. The maintainer cannot
install most harnesses, so this evidence stands in for verification. A port without all three
cannot be merged.
-->

- **Harness and target tier:** <!-- e.g. Codex, Tier 2 -->
- **Harness version:** <!-- the exact version you ran -->
- **Install command:** <!-- exactly what a user types, in one command -->
- [ ] `tests/<harness>/` is added and green in CI
- [ ] `scripts/conformance <harness>` passes both scenarios; output below

<details>
<summary><code>scripts/conformance</code> output</summary>

```
<!-- paste the full output here -->
```

</details>
