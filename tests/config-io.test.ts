import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError } from '../server/config.js'
import type { GitHubClient } from '../server/providers/github/client.js'
import {
  boardsContainingRepo,
  loadResolvedConfig,
  readOriginUrl,
  readRepoConfig,
  readUserConfig,
} from '../server/config-io.js'

const run = promisify(execFile)

async function mkTemp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'armature-config-io-'))
}

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

function fakeClient(impl: (query: string, variables: Record<string, unknown>) => Promise<unknown>): GitHubClient {
  return { graphql: impl } as unknown as GitHubClient
}

describe('readRepoConfig', () => {
  it('returns an empty config when .armature.json is absent', async () => {
    const dir = await mkTemp()
    dirs.push(dir)
    expect(await readRepoConfig(dir)).toEqual({})
  })

  it('reads a declared board from .armature.json', async () => {
    const dir = await mkTemp()
    dirs.push(dir)
    await writeFile(
      join(dir, '.armature.json'),
      JSON.stringify({ board: { provider: 'github', owner: 'acme', number: 1 }, alias: 'apex' }),
    )
    expect(await readRepoConfig(dir)).toEqual({
      board: { provider: 'github', owner: 'acme', number: 1 },
      alias: 'apex',
    })
  })

  it('names the file when .armature.json is malformed', async () => {
    const dir = await mkTemp()
    dirs.push(dir)
    await writeFile(join(dir, '.armature.json'), '{ not json')
    await expect(readRepoConfig(dir)).rejects.toThrow(ConfigError)
    await expect(readRepoConfig(dir)).rejects.toThrow(/\.armature\.json/)
  })
})

describe('readUserConfig', () => {
  it('returns an empty config when the user file is absent', async () => {
    const dir = await mkTemp()
    dirs.push(dir)
    expect(await readUserConfig(dir)).toEqual({})
  })

  it('reads a declared board from ~/.config/armature/config.json', async () => {
    const dir = await mkTemp()
    dirs.push(dir)
    const board = { provider: 'github', owner: 'acme', number: 9 }
    await mkdir(join(dir, '.config', 'armature'), { recursive: true })
    await writeFile(join(dir, '.config', 'armature', 'config.json'), JSON.stringify({ board }))
    expect(await readUserConfig(dir)).toEqual({ board })
  })

  it('names the file when the user config is malformed', async () => {
    const dir = await mkTemp()
    dirs.push(dir)
    await mkdir(join(dir, '.config', 'armature'), { recursive: true })
    await writeFile(join(dir, '.config', 'armature', 'config.json'), 'not json at all')
    await expect(readUserConfig(dir)).rejects.toThrow(ConfigError)
    await expect(readUserConfig(dir)).rejects.toThrow(/config\.json/)
  })
})

describe('readOriginUrl', () => {
  it('reads the origin remote url', async () => {
    const dir = await mkTemp()
    dirs.push(dir)
    await run('git', ['init'], { cwd: dir })
    await run('git', ['remote', 'add', 'origin', 'git@github.com:acme/web.git'], { cwd: dir })
    expect(await readOriginUrl(dir)).toBe('git@github.com:acme/web.git')
  })

  it('fails naming the fix when there is no origin remote', async () => {
    const dir = await mkTemp()
    dirs.push(dir)
    await run('git', ['init'], { cwd: dir })
    await expect(readOriginUrl(dir)).rejects.toThrow(ConfigError)
    await expect(readOriginUrl(dir)).rejects.toThrow(/origin/)
  })
})

describe('boardsContainingRepo', () => {
  it('returns an empty list when no client is available yet', async () => {
    expect(await boardsContainingRepo(undefined, { owner: 'acme', name: 'web' })).toEqual([])
  })

  it('maps linked projects to board references', async () => {
    const client = fakeClient(async () => ({
      repository: {
        projectsV2: {
          nodes: [
            { number: 6, owner: { login: 'acme' } },
            { number: 9, owner: { login: 'acme' } },
          ],
        },
      },
    }))
    expect(await boardsContainingRepo(client, { owner: 'acme', name: 'web' })).toEqual([
      { provider: 'github', owner: 'acme', number: 6 },
      { provider: 'github', owner: 'acme', number: 9 },
    ])
  })

  it('returns an empty list when the query errors', async () => {
    const client = fakeClient(async () => {
      throw new Error('boom')
    })
    expect(await boardsContainingRepo(client, { owner: 'acme', name: 'web' })).toEqual([])
  })

  it('never lets a query error escape', async () => {
    const client = fakeClient(async () => {
      throw new Error('network down')
    })
    await expect(boardsContainingRepo(client, { owner: 'acme', name: 'web' })).resolves.toEqual([])
  })
})

describe('loadResolvedConfig', () => {
  it('resolves from .armature.json without ever calling the client', async () => {
    const repoDir = await mkTemp()
    const homeDir = await mkTemp()
    dirs.push(repoDir, homeDir)
    await run('git', ['init'], { cwd: repoDir })
    await run('git', ['remote', 'add', 'origin', 'git@github.com:acme/web.git'], { cwd: repoDir })
    await writeFile(
      join(repoDir, '.armature.json'),
      JSON.stringify({ board: { provider: 'github', owner: 'acme', number: 1 } }),
    )
    const client = fakeClient(async () => {
      throw new Error('should not be called')
    })

    const config = await loadResolvedConfig({ cwd: repoDir, home: homeDir, env: {}, client })
    expect(config.board).toEqual({ provider: 'github', owner: 'acme', number: 1 })
    expect(config.boardSource).toBe('repo')
  })

  it('prefers the environment over every file', async () => {
    const repoDir = await mkTemp()
    const homeDir = await mkTemp()
    dirs.push(repoDir, homeDir)
    await run('git', ['init'], { cwd: repoDir })
    await run('git', ['remote', 'add', 'origin', 'git@github.com:acme/web.git'], { cwd: repoDir })

    const config = await loadResolvedConfig({
      cwd: repoDir,
      home: homeDir,
      env: { ARMATURE_BOARD: 'github:acme/7' },
    })
    expect(config.board.number).toBe(7)
    expect(config.boardSource).toBe('env')
  })

  it('derives the board from the one linked project when nothing else is configured', async () => {
    const repoDir = await mkTemp()
    const homeDir = await mkTemp()
    dirs.push(repoDir, homeDir)
    await run('git', ['init'], { cwd: repoDir })
    await run('git', ['remote', 'add', 'origin', 'git@github.com:acme/web.git'], { cwd: repoDir })
    const client = fakeClient(async () => ({
      repository: { projectsV2: { nodes: [{ number: 6, owner: { login: 'acme' } }] } },
    }))

    const config = await loadResolvedConfig({ cwd: repoDir, home: homeDir, env: {}, client })
    expect(config.board).toEqual({ provider: 'github', owner: 'acme', number: 6 })
    expect(config.boardSource).toBe('derived')
  })

  it('gives the explicit no-board error when there is no client yet and no configured board', async () => {
    const repoDir = await mkTemp()
    const homeDir = await mkTemp()
    dirs.push(repoDir, homeDir)
    await run('git', ['init'], { cwd: repoDir })
    await run('git', ['remote', 'add', 'origin', 'git@github.com:acme/web.git'], { cwd: repoDir })

    await expect(loadResolvedConfig({ cwd: repoDir, home: homeDir, env: {} })).rejects.toThrow(
      /No board found for acme\/web/,
    )
  })

  // End to end: git happily reports an origin carrying a credential, and the whole failure path
  // from there to the MCP client must not carry it along.
  it('never echoes a credential in the origin remote', async () => {
    const repoDir = await mkTemp()
    const homeDir = await mkTemp()
    dirs.push(repoDir, homeDir)
    await run('git', ['init'], { cwd: repoDir })
    await run(
      'git',
      ['remote', 'add', 'origin', 'https://user:ghp_SECRET@github.com/acme/web/'],
      { cwd: repoDir },
    )

    const error = await loadResolvedConfig({ cwd: repoDir, home: homeDir, env: {} }).catch(
      (e: Error) => e,
    )
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as Error).message).not.toContain('ghp_SECRET')
  })

  it('starts outside a git repository when ARMATURE_BOARD names the board', async () => {
    const repoDir = await mkTemp()
    const homeDir = await mkTemp()
    dirs.push(repoDir, homeDir)
    // Deliberately not a git repository: origin is only needed to name this repository.

    const config = await loadResolvedConfig({
      cwd: repoDir,
      home: homeDir,
      env: { ARMATURE_BOARD: 'github:acme/7' },
    })
    expect(config.board.number).toBe(7)
    expect(config.repo).toBeNull()
  })

  it('starts outside a git repository when .armature.json names the board', async () => {
    const repoDir = await mkTemp()
    const homeDir = await mkTemp()
    dirs.push(repoDir, homeDir)
    await writeFile(
      join(repoDir, '.armature.json'),
      JSON.stringify({ board: { provider: 'github', owner: 'acme', number: 1 } }),
    )

    const config = await loadResolvedConfig({ cwd: repoDir, home: homeDir, env: {} })
    expect(config.boardSource).toBe('repo')
  })

  it('still explains the missing origin when nothing else names a board', async () => {
    const repoDir = await mkTemp()
    const homeDir = await mkTemp()
    dirs.push(repoDir, homeDir)

    await expect(loadResolvedConfig({ cwd: repoDir, home: homeDir, env: {} })).rejects.toThrow(
      /origin/,
    )
  })

  it('surfaces a malformed repo config file by name', async () => {
    const repoDir = await mkTemp()
    const homeDir = await mkTemp()
    dirs.push(repoDir, homeDir)
    await run('git', ['init'], { cwd: repoDir })
    await run('git', ['remote', 'add', 'origin', 'git@github.com:acme/web.git'], { cwd: repoDir })
    await writeFile(join(repoDir, '.armature.json'), '{ not json')

    await expect(loadResolvedConfig({ cwd: repoDir, home: homeDir, env: {} })).rejects.toThrow(
      /\.armature\.json/,
    )
  })
})
