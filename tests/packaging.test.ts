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
// the others behind — failing the very first test in this file, and shipping a bundle whose
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

  // dist/server.js is the one declaration release-please cannot regenerate from source, and the
  // only one CI rebuilds and diffs. Covering it here is what lets a release PR be green on its
  // first run instead of opening stale and needing a rebuilt bundle pushed on top of it.
  it('covers dist/server.js, the built copy nothing else can bump', () => {
    expect(pathsOf()).toContain('dist/server.js')
  })
})

// esbuild inlines VERSION as a bare literal and drops the annotation comment, so a plain bundle
// offers the generic updater nothing to find. The build re-attaches the marker, which is the only
// reason the extra-file above does anything. These assert on the committed artifact rather than on
// esbuild.config.mjs: what release-please reads at release time is the file on the branch, and a
// build that quietly stopped annotating would leave it unmarked, unbumped, and green here.
describe('the committed bundle is markable by the generic updater', () => {
  const marked = readText('dist/server.js').match(/^.*x-release-please-version.*$/gm) ?? []

  // Exactly one. Zero is the silent failure the annotation exists to prevent; a second marked
  // line would be a second place to keep in step, which is the problem this file is about.
  it('marks exactly one line for the generic updater', () => {
    expect(marked).toHaveLength(1)
  })

  it('marks the line carrying the inlined version', () => {
    expect(marked[0]).toMatch(/^var VERSION = "\d+\.\d+\.\d+"; \/\/ x-release-please-version$/)
  })

  // Catches a stale bundle at test time. CI catches it too, by rebuilding and diffing, but only
  // after a full install and build — and on a release PR that check used to be expected to fail.
  it('embeds the same version every other declaration is pinned to', () => {
    expect(marked[0]).toContain(`"${VERSION}"`)
  })
})

// The rebuild used to live here as a second job: check out the release branch, rebuild the bundle,
// push it back. It worked, but it made every release PR red on its first CI run — the branch was
// opened with a stale bundle and only went green once the push landed — and it had a failure mode
// that did not self-heal, since a push that failed left the PR merge-ready with a stale bundle and
// nothing but a red job in the Actions tab to say so. Marking the bundle removes the job outright:
// release-please bumps dist/server.js in the same commit as everything else.
describe('the release workflow leaves the bundle to release-please', () => {
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

  // Authority comes from the ryanlindsey-bot app installation, not from the workflow token. That
  // moves the easy-to-omit thing rather than removing it: a step not handed the minted token falls
  // back to a GITHUB_TOKEN granted nothing, which fails at run time rather than at review time.
  // The app's own installation permissions cannot be checked from in here; they are documented at
  // the top of the workflow.
  it('mints an app token and hands it to release-please', () => {
    expect(release).toMatch(/actions\/create-github-app-token@v\d/)
    expect(release).toMatch(/client-id:\s*\$\{\{\s*secrets\.BOT_APP_CLIENT_ID\s*\}\}/)
    // The deprecated input, not merely absent from the assertions above: passing it still works
    // and still warns, so nothing else would notice a revert.
    expect(release, 'app-id is deprecated in favour of client-id').not.toMatch(/^\s*app-id:/m)
    expect(release).toMatch(/private-key:\s*\$\{\{\s*secrets\.BOT_APP_PRIVATE_KEY\s*\}\}/)
    expect(release.match(/steps\.app-token\.outputs\.token/g)).toHaveLength(1)
  })

  // The counterpart to the above: nothing is left leaning on the workflow token, so a dropped
  // `token:` cannot quietly half-work on inherited permissions.
  it('leaves the workflow token with nothing granted', () => {
    expect(release).toMatch(/^permissions:\s*\{\}\s*$/m)
    expect(release).not.toMatch(/contents:\s*write/)
  })

  // The whole point of the marker is that no second actor writes to the release branch. Re-adding
  // a job that does brings back both the red first CI run and the push that fails in silence.
  it('never writes to the release branch itself', () => {
    expect(release).not.toContain('git push')
    expect(release).not.toContain('git commit')
    expect(release).not.toContain('headBranchName')
  })

  // A token routed between jobs through `outputs:` is written into the run unmasked. With the
  // rebuild gone there is one job and nothing to route — pinned so the next job added here has to
  // mint its own rather than reach for this one's.
  it('routes nothing through job outputs', () => {
    expect(release).not.toMatch(/^\s*outputs:/m)
  })

  // The marker is only worth maintaining because CI enforces that the committed bundle matches its
  // source. If that check ever goes, revisit the annotation rather than leaving the build
  // decorating a file nothing verifies.
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

  // The loop's review step invokes superpowers:requesting-code-review, whose whole mechanic is
  // dispatching a subagent. Claude Code accepts either name for that tool — the binary guards on
  // `e !== "Agent" && e !== "Task"` — so declare both and the command works across versions.
  it('/armature-next pre-approves the subagent dispatch its review step needs', () => {
    const fm = frontmatter(readText('commands/armature-next.md'))
    expect(fm).toMatch(/\bAgent\b/)
    expect(fm).toMatch(/\bTask\b/)
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

// Anchored on the whole heading, not a substring: a substring match would silently start reading
// a different section the moment a heading like "## Using the skill" appeared above "## Skill" —
// a false green in the very tests meant to catch drift.
function section(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^#{2,3} +${escaped} *$`, 'm').exec(markdown)
  expect(match, `expected a heading exactly "## ${heading}"`).not.toBeNull()
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
  // armature's central rule, so the menu must never be asked. But it presents *two* menus: on a
  // detached HEAD the options are only "1. Push as new branch and create a Pull Request" and
  // "2. Keep as-is". Pre-selecting by ordinal picks "Keep as-is" there — nothing pushed, no PR,
  // and step 10 then reports a link that does not exist. Name the option by its text.
  it('refuses finishing-a-development-branch its merge option', () => {
    const rules = section(skill, 'Rules')
    expect(rules).toMatch(/finishing-a-development-branch/)
    expect(rules, 'names the option by text').toMatch(/create a Pull Request/i)
    expect(rules, 'covers the detached-HEAD menu too').toMatch(/detached/i)
    expect(rules).toMatch(/menu/i)
  })

  // The hazard explanation belongs in Rules; the loop is what gets followed literally. An ordinal
  // there is the same detached-HEAD trap by another route, and fixing only the rule leaves it.
  it('pre-selects that option by text in the loop too, never by ordinal', () => {
    const loop = section(skill, 'The loop')
    expect(loop, 'the loop must name the option').toMatch(/pull request/i)
    expect(loop, 'the loop must not pre-select by ordinal').not.toMatch(/option \d/i)
  })

  // The loop declares which steps it delegates. Every one of them must have a fallback row, keyed
  // by the same number — otherwise an install without Superpowers hits a step with no instructions.
  it('gives an install without Superpowers a fallback for every step it delegates', () => {
    const declared = /Steps? ([\d,\s and]+?) belong to Superpowers/i.exec(section(skill, 'The loop'))
    expect(declared, 'the loop must declare which steps Superpowers owns').not.toBeNull()

    const steps = declared![1]!.match(/\d+/g) ?? []
    expect(steps.length, 'expected at least one delegated step').toBeGreaterThan(0)

    const fallback = section(skill, 'Without Superpowers')
    for (const step of steps) {
      expect(fallback, `no fallback row for step ${step}`).toMatch(new RegExp(`^\\| ${step}\\.`, 'm'))
    }
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

  it('puts that section immediately after Install', () => {
    const headings = [...readme.matchAll(/^## .+$/gm)].map((m) => m[0])
    const install = headings.indexOf('## Install')
    expect(install, 'README has no ## Install heading').toBeGreaterThan(-1)
    expect(headings[install + 1]).toMatch(/Superpowers/)
  })

  it('traces one run, naming both the armature tools and the Superpowers skills', () => {
    const trace = section(readme, 'Better with Superpowers')
    for (const name of SUPERPOWERS_CHAIN) {
      expect(trace, `trace omits ${name}`).toContain(name.replace('superpowers:', ''))
    }
    for (const tool of ['board_next', 'item_get', 'item_claim', 'item_status']) {
      expect(trace, `trace omits ${tool}`).toContain(tool)
    }
  })

  // The point of the trace is the attribution, not the list of names — a prose paragraph naming
  // all of them would satisfy the test above while showing nobody which layer owns what.
  it('labels every row of the trace with the layer that owns it', () => {
    const rows = section(readme, 'Better with Superpowers')
      .split('\n')
      .filter((line) => /^\s*\d+\s/.test(line))

    expect(rows.length, 'expected a numbered trace').toBeGreaterThanOrEqual(9)
    for (const row of rows) {
      expect(row, `trace row is unattributed: ${row}`).toMatch(/\barmature\b|\bSuperpowers\b/)
    }
  })

  // The spec's thesis is that prose duplicated N times rots in N directions. A trace in the README
  // and a loop in the skill that must stay numerically aligned are exactly that risk, so CI owns
  // the alignment rather than two documents a human keeps in step by hand.
  it('traces the same steps the skill loops over, numbered the same way', () => {
    const loop = section(readText('skills/working-the-board/SKILL.md'), 'The loop')
    const steps = [...loop.matchAll(/^(\d+)\. \*\*/gm)].map((m) => m[1])
    const rows = [...section(readme, 'Better with Superpowers').matchAll(/^\s*(\d+)\s{2,}/gm)].map(
      (m) => m[1],
    )

    expect(steps.length, 'the skill must number its loop').toBeGreaterThan(0)
    expect(rows).toEqual(steps)
  })

  it('cites the delegated step numbers the skill actually uses', () => {
    const loop = section(readText('skills/working-the-board/SKILL.md'), 'The loop')
    const declared = /Steps? ([\d,\s and]+?) belong to Superpowers/i.exec(loop)
    expect(declared, 'the loop must declare which steps Superpowers owns').not.toBeNull()

    const cited = /standing in for steps? ([\d,\s and]+?)[—.]/i.exec(
      section(readme, 'Better with Superpowers'),
    )
    expect(cited, 'the README must cite the steps its fallback sentence defers to').not.toBeNull()
    expect(cited![1]!.match(/\d+/g)).toEqual(declared![1]!.match(/\d+/g))
  })

  // One statement of the relationship, not two that rot in different directions — the same
  // failure the spec diagnoses in the four diverging copies of the prior slash command.
  it('states the relationship in one place rather than twice', () => {
    expect(section(readme, 'Skill')).not.toContain('github.com/obra/superpowers')
  })
})
