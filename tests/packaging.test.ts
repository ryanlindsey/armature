import { readFileSync } from 'node:fs'
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

  // The repository's default workflow token is read-only, so a workflow that does not ask for
  // these fails at run time with a permissions error rather than at review time.
  it('grants the write permissions the default token does not carry', () => {
    expect(release).toMatch(/contents:\s*write/)
    expect(release).toMatch(/pull-requests:\s*write/)
  })

  it('rebuilds the bundle and commits it', () => {
    expect(release).toContain('npm run build')
    expect(release).toMatch(/git add .*dist\/server\.js/)
  })

  // The rebuild belongs on the release branch. Pushing it straight to main would leave the release
  // PR still stale and put an unreviewed commit on the branch the tag is cut from.
  it('commits onto the release branch rather than main', () => {
    expect(release).toContain('headBranchName')
  })

  // The release PR gets no pull_request checks -- PRs opened by GITHUB_TOKEN do not trigger
  // workflows — so this job is the only signal before the merge that cuts the tag.
  it('typechecks and tests the bumped tree, since nothing else will', () => {
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
