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
//
// NOTE for whoever adds the release workflow (recorded as a follow-up; there is none yet):
// dist/server.js inlines VERSION, so a release PR that bumps server/version.ts must also run
// `npm run build` and commit the bundle, or CI's "bundle is current" step fails on the release PR.
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
