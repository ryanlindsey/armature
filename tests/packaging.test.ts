import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { VERSION } from '../server/version.js'

const readText = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const read = (p: string) => JSON.parse(readText(p))

function frontmatter(markdown: string): string {
  const match = /^---\n([\s\S]*?)\n---/.exec(markdown)
  expect(match, 'the command file must open with YAML frontmatter').not.toBeNull()
  return match![1]!
}

describe('packaging', () => {
  it('keeps every declared version in step', () => {
    const pkg = read('package.json')
    const plugin = read('.claude-plugin/plugin.json')
    const market = read('.claude-plugin/marketplace.json')
    const entry = market.plugins.find((p: { name: string }) => p.name === 'armature')

    expect(plugin.version).toBe(pkg.version)
    expect(entry.version).toBe(pkg.version)
    expect(VERSION).toBe(pkg.version)
  })

  it('launches the committed bundle', () => {
    const plugin = read('.claude-plugin/plugin.json')
    expect(plugin.mcpServers.armature.args[0]).toBe('${CLAUDE_PLUGIN_ROOT}/dist/server.js')
  })

  it('is MIT licensed', () => {
    expect(read('.claude-plugin/plugin.json').license).toBe('MIT')
  })
})

// The versions above are pinned equal to each other, and release-please only bumps package.json
// and the manifest by default. Without extra-files a release would move package.json and leave
// the other three behind — failing the very first test in this file, and shipping a bundle whose
// embedded VERSION disagrees with the plugin a user installed.
describe('release-please updates every file the version check pins together', () => {
  const config = read('release-please-config.json')
  const extraFiles: unknown[] = config.packages['.']['extra-files'] ?? []

  function pathsOf(): string[] {
    return extraFiles.map((e) => (typeof e === 'string' ? e : (e as { path: string }).path))
  }

  it('covers .claude-plugin/plugin.json', () => {
    expect(pathsOf()).toContain('.claude-plugin/plugin.json')
  })

  it('covers both version fields in .claude-plugin/marketplace.json', () => {
    const jsonpaths = extraFiles
      .filter((e): e is { path: string; jsonpath?: string } => typeof e === 'object' && e !== null)
      .filter((e) => e.path === '.claude-plugin/marketplace.json')
      .map((e) => e.jsonpath)

    expect(jsonpaths).toContain('$.metadata.version')
    expect(jsonpaths).toContain('$.plugins[0].version')
  })

  // The jsonpath above addresses the first entry by index, so that entry must be armature's.
  it('keeps armature as the first marketplace entry the jsonpath addresses', () => {
    const market = read('.claude-plugin/marketplace.json')
    expect(market.plugins[0].name).toBe('armature')
  })

  it('covers server/version.ts, which the committed bundle embeds', () => {
    expect(pathsOf()).toContain('server/version.ts')
  })

  it('marks the version line in server/version.ts for the generic updater', () => {
    expect(readText('server/version.ts')).toContain('x-release-please-version')
  })
})

// extra-files covers server/version.ts, but not the bundle built from it: esbuild inlines VERSION
// as a bare literal and strips the annotation comment, so there is no marker left for a `generic`
// updater to find. Only a rebuild closes that gap. Without one the release PR carries a bundle
// reporting the previous version, and CI's "bundle is current" step fails on the release commit
// itself — the one commit that must be green.
describe('the release workflow rebuilds the bundle release-please cannot patch', () => {
  const release = readText('.github/workflows/release.yml')

  it('runs release-please', () => {
    expect(release).toMatch(/googleapis\/release-please-action@v\d/)
  })

  // Named explicitly rather than left to the action's defaults, so renaming either file breaks a
  // test here instead of silently orphaning the workflow from the config it is supposed to read.
  it('points release-please at the config and manifest this repo has', () => {
    expect(release).toContain('release-please-config.json')
    expect(release).toContain('.release-please-manifest.json')
  })

  // Authority comes from the ryanlindsey-bot app installation now, not from the workflow token.
  // That moves the easy-to-omit thing rather than removing it: a step that is not handed the
  // minted token falls back to a GITHUB_TOKEN granted nothing, which fails at run time rather
  // than at review time — the same trap the old per-job `permissions:` block set. So both
  // consumers are asserted: release-please, and the checkout whose stored credential does the
  // push. The app's own installation permissions (contents, pull-requests, issues) cannot be
  // checked from in here; they are documented at the top of the workflow.
  it('mints an app token and hands it to both consumers', () => {
    expect(release).toMatch(/actions\/create-github-app-token@v\d/)
    expect(release).toMatch(/client-id:\s*\$\{\{\s*secrets\.BOT_APP_CLIENT_ID\s*\}\}/)
    // The deprecated input, not merely absent from the assertions above: passing it still works
    // and still warns, so nothing else would notice a revert.
    expect(release, 'app-id is deprecated in favour of client-id').not.toMatch(/^\s*app-id:/m)
    expect(release).toMatch(/private-key:\s*\$\{\{\s*secrets\.BOT_APP_PRIVATE_KEY\s*\}\}/)
    expect(release.match(/steps\.app-token\.outputs\.token/g)).toHaveLength(2)
  })

  // A token routed from one job to another through `outputs:` is written into the run unmasked,
  // so each job mints its own from the same secrets.
  it('mints the token in each job rather than routing it through job outputs', () => {
    expect(release.match(/actions\/create-github-app-token@v\d/g)).toHaveLength(2)
  })

  // The counterpart to the above: nothing is left leaning on the workflow token, so a dropped
  // `token:` cannot quietly half-work on inherited permissions.
  it('leaves the workflow token with nothing granted', () => {
    expect(release).toMatch(/^permissions:\s*\{\}\s*$/m)
    expect(release).not.toMatch(/contents:\s*write/)
  })

  it('rebuilds the bundle and commits it', () => {
    expect(release).toContain('npm run build')
    expect(release).toMatch(/git add .*dist\/server\.js/)
  })

  // The rebuild belongs on the release branch. Pushing it straight to main would leave the release
  // PR still stale and put an unreviewed commit on the branch the tag is cut from. The refspec is
  // spelled out rather than left to a bare `git push`, which would depend on checkout having set
  // upstream tracking — and would fail at release time, the worst moment to find out.
  it('pushes onto the release branch rather than main', () => {
    expect(release).toContain('headBranchName')
    expect(release).toMatch(/git push origin ["']?HEAD:/)
  })

  // A PR opened by the app does trigger `pull_request`, so ci.yml now runs against the release PR
  // — it did not under GITHUB_TOKEN, when this job was the only signal before the merge that cuts
  // the tag. These steps stay as the gate on this job's own push, so a failing tree never gets a
  // rebuilt bundle committed on top of it.
  it('typechecks and tests the bumped tree before pushing to it', () => {
    expect(release).toContain('npm run typecheck')
    expect(release).toContain('npm test')
  })

  // The rebuild is only worth doing because CI enforces that the bundle matches its source. If
  // that check ever goes, revisit this job rather than leaving it running for a reason that no
  // longer holds.
  it('serves a check CI still makes', () => {
    expect(readText('.github/workflows/ci.yml')).toContain('git diff --exit-code dist/server.js')
  })
})

// The integration job runs a suite whose configuration lives entirely in the job's env block, so
// the two drift silently: the suite reads a variable, the workflow never passes it, and every
// test still runs — against whatever the missing value defaulted to. That is not hypothetical.
// ARMATURE_IT_REPO was read by queries.integration.test.ts and never passed, and the fallback
// sent `<owner>/<owner>` to the API for as long as the job was enabled.
describe('the integration job stays in step with the suite it runs', () => {
  const ci = readText('.github/workflows/ci.yml')

  // Derived from the suite's own source rather than listed here. A hard-coded list would need
  // updating by the same person who forgot the env block, which is the failure being guarded.
  const readByTheSuite = () => {
    const dir = new URL('../tests/integration/', import.meta.url)
    const names = new Set<string>()
    for (const file of readdirSync(dir)) {
      const src = readFileSync(new URL(file, dir), 'utf8')
      for (const m of src.matchAll(/process\.env\.(ARMATURE_[A-Z_]+)/g)) names.add(m[1]!)
    }
    return names
  }

  it('passes the suite every variable it reads', () => {
    const names = readByTheSuite()
    expect(names.size, 'no ARMATURE_* reads found — the scan is broken, not the workflow')
      .toBeGreaterThan(0)
    for (const name of names) expect(ci, `ci.yml must pass ${name}`).toContain(`${name}:`)
  })

  // The other half of the same drift. A variable passed but left out of the guard lets the job
  // run half-configured, which is how it fails on a real board rather than skipping — the exact
  // state the guard's own comment says it exists to prevent.
  it('gates the job on every board variable it passes', () => {
    const used = new Set([...ci.matchAll(/vars\.(ARMATURE_IT_[A-Z_]+)/g)].map((m) => m[1]!))
    expect(used.size).toBeGreaterThan(0)
    for (const name of used) {
      expect(ci, `the guard must require ${name}`).toContain(`vars.${name} != ''`)
    }
  })
})

// allowed-tools is a pre-approval list, not a restriction: Claude Code grants the listed tools
// for the turn that invokes the command and leaves everything else to the normal permission
// flow. So an omission does not break the command — it just prompts the user for the one tool
// the command exists to call, and documents the command as doing something it does not do.
describe('the commands declare the tools they actually use', () => {
  const ARMATURE_TOOLS = 'mcp__plugin_armature_armature__'

  it('/armature-doctor pre-approves the board tool it calls', () => {
    const fm = frontmatter(readText('commands/armature-doctor.md'))
    expect(fm).toContain(`${ARMATURE_TOOLS}board_survey`)
  })

  it('/armature-next pre-approves the armature tools and the Skill tool', () => {
    const fm = frontmatter(readText('commands/armature-next.md'))
    expect(fm).toContain(ARMATURE_TOOLS)
    expect(fm).toMatch(/\bSkill\b/)
  })

  it('names the MCP server the plugin actually declares', () => {
    const plugin = read('.claude-plugin/plugin.json')
    expect(Object.keys(plugin.mcpServers)).toEqual(['armature'])
    expect(plugin.name).toBe('armature')
  })
})

// The spec's table of what survives from the prior slash command marks "order by epic, honour
// 'Depends on'" as a surviving *skill-side* policy. Server-side prerequisite blocking was
// correctly not implemented — which left the policy with nowhere to live.
describe('the skill carries the policies the server deliberately does not enforce', () => {
  const skill = readText('skills/working-the-board/SKILL.md')

  it('tells the model to honour a stated prerequisite', () => {
    expect(skill).toMatch(/depends on/i)
  })

  it('says what to do when a prerequisite is not done', () => {
    expect(skill).toMatch(/prerequisite/i)
  })
})

// The spec states the composition as a four-skill chain — using-git-worktrees →
// test-driven-development → requesting-code-review → finishing-a-development-branch — with
// armature bracketing it: picking and claiming before, opening the PR and moving the item after.
// The skill named only the first two, so the relationship the design describes and the one that
// ships had drifted apart. These tests pin the chain to the spec.
const SUPERPOWERS_CHAIN = [
  'superpowers:using-git-worktrees',
  'superpowers:test-driven-development',
  'superpowers:requesting-code-review',
  'superpowers:finishing-a-development-branch',
]

function section(markdown: string, heading: string): string {
  const match = new RegExp(`^#{2,3} .*${heading}.*$`, 'im').exec(markdown)
  expect(match, `expected a heading matching /${heading}/`).not.toBeNull()
  const rest = markdown.slice(match!.index + match![0].length)
  const next = /^#{2,3} /m.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

describe('the skill composes with Superpowers rather than reimplementing it', () => {
  const skill = readText('skills/working-the-board/SKILL.md')

  for (const name of SUPERPOWERS_CHAIN) {
    it(`names ${name}`, () => {
      expect(skill).toContain(name)
    })
  }

  it('orders the chain isolate, implement, review, finish', () => {
    const positions = SUPERPOWERS_CHAIN.map((name) => skill.indexOf(name))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  // That skill's Step 4 offers "1. Merge back to <base-branch> locally" first, which contradicts
  // armature's central rule. Its option 2 — push, open the PR, keep the worktree — is armature's
  // own step, so the two compose only if the menu is never asked.
  it('refuses finishing-a-development-branch its merge option', () => {
    const rules = section(skill, 'Rules')
    expect(rules).toMatch(/finishing-a-development-branch/)
    expect(rules).toMatch(/option 2/i)
    expect(rules).toMatch(/menu/i)
  })

  it('gives an install without Superpowers a fallback for every link in the chain', () => {
    const fallback = section(skill, 'Without Superpowers')
    expect(fallback, 'isolation fallback').toMatch(/branch/i)
    expect(fallback, 'TDD fallback').toMatch(/test/i)
    expect(fallback, 'review fallback').toMatch(/review/i)
    expect(fallback, 'finish fallback').toMatch(/pull request|\bPR\b/)
  })
})

describe('the README surfaces the Superpowers relationship above the fold', () => {
  const readme = readText('README.md')

  it('names Superpowers before it explains how to install', () => {
    const mention = readme.indexOf('Superpowers')
    expect(mention, 'README never mentions Superpowers').toBeGreaterThan(-1)
    expect(mention).toBeLessThan(readme.indexOf('## Install'))
  })

  it('gives the relationship a section of its own', () => {
    expect(readme).toMatch(/^## .*Superpowers.*$/im)
  })

  it('traces one run, labelling which layer owns each step', () => {
    const trace = section(readme, 'Superpowers')
    for (const name of SUPERPOWERS_CHAIN) {
      expect(trace, `trace omits ${name}`).toContain(name.replace('superpowers:', ''))
    }
    for (const tool of ['board_next', 'item_claim', 'item_status']) {
      expect(trace, `trace omits ${tool}`).toContain(tool)
    }
  })

  // One statement of the relationship, not two that rot in different directions — the same
  // failure the spec diagnoses in the four diverging copies of the prior slash command.
  it('states the relationship in one place rather than twice', () => {
    expect(section(readme, 'Skill')).not.toContain('github.com/obra/superpowers')
  })
})
