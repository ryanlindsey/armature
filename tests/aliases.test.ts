import { describe, expect, it } from 'vitest'
import {
  AliasConflictError,
  buildAliasMap,
  readSiblingConfigFrom,
  resolveAlias,
} from '../server/providers/github/aliases.js'
import { ConfigError, type RepoConfig } from '../server/config.js'
import type { GitHubClient } from '../server/providers/github/client.js'

const board = { provider: 'github' as const, owner: 'acme', number: 1 }

function reader(configs: Record<string, RepoConfig | null>) {
  return async (owner: string, repo: string) => configs[`${owner}/${repo}`] ?? null
}

describe('buildAliasMap', () => {
  it('collects an alias declared by each repository about itself', async () => {
    const map = await buildAliasMap(
      reader({ 'acme/site.example': { board, alias: 'site' }, 'acme/api': { board, alias: 'api' } }),
      ['acme/site.example', 'acme/api'],
    )
    expect(map.get('site')).toEqual({ owner: 'acme', repo: 'site.example' })
    expect(map.get('api')).toEqual({ owner: 'acme', repo: 'api' })
  })

  it('skips a repository with no config', async () => {
    const map = await buildAliasMap(reader({ 'acme/web': null }), ['acme/web'])
    expect(map.size).toBe(0)
  })

  it('refuses two repositories claiming one alias', async () => {
    await expect(
      buildAliasMap(
        reader({ 'acme/web': { board, alias: 'site' }, 'acme/api': { board, alias: 'site' } }),
        ['acme/web', 'acme/api'],
      ),
    ).rejects.toThrow(AliasConflictError)
  })
})

// The same file format was read two ways: config-io.ts raises naming the local .armature.json,
// while this swallowed the parse error and returned null. A sibling with a typo therefore lost
// its alias, and the loss then surfaced as a confident wrong diagnosis — "Unknown alias …, known
// aliases: …" — for a repository that does declare one.
describe('readSiblingConfigFrom', () => {
  function clientReturning(text: string | null) {
    return {
      graphql: async () => ({ repository: { object: text === null ? null : { text } } }),
    } as unknown as GitHubClient
  }

  it('reads a sibling alias declaration', async () => {
    const read = readSiblingConfigFrom(clientReturning(JSON.stringify({ alias: 'site' })))
    expect(await read('acme', 'site.example')).toEqual({ alias: 'site' })
  })

  it('returns null when a sibling has no .armature.json at all', async () => {
    const read = readSiblingConfigFrom(clientReturning(null))
    expect(await read('acme', 'web')).toBeNull()
  })

  it('surfaces a malformed sibling file instead of silently losing its alias', async () => {
    const read = readSiblingConfigFrom(clientReturning('{ not json'))
    await expect(read('acme', 'web')).rejects.toThrow(ConfigError)
  })

  it('names the repository and the file, so the typo can be found', async () => {
    const read = readSiblingConfigFrom(clientReturning('{ not json'))
    await expect(read('acme', 'web')).rejects.toThrow(/acme\/web/)
    await expect(read('acme', 'web')).rejects.toThrow(/\.armature\.json/)
  })
})

describe('resolveAlias', () => {
  const map = new Map([['site', { owner: 'acme', repo: 'site.example' }]])

  it('expands an alias reference', () => {
    expect(resolveAlias(map, 'site#272')).toEqual({ owner: 'acme', repo: 'site.example', number: 272 })
  })

  it('returns null for an unknown alias', () => {
    expect(resolveAlias(map, 'tools#293')).toBeNull()
  })

  it('returns null for a bare number', () => {
    expect(resolveAlias(map, '272')).toBeNull()
  })
})
