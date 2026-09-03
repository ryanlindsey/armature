import { describe, expect, it } from 'vitest'
import { AliasConflictError, buildAliasMap, resolveAlias } from '../server/providers/github/aliases.js'
import type { RepoConfig } from '../server/config.js'

const board = { provider: 'github' as const, owner: 'acme', number: 1 }

function reader(configs: Record<string, RepoConfig | null>) {
  return async (owner: string, repo: string) => configs[`${owner}/${repo}`] ?? null
}

describe('buildAliasMap', () => {
  it('collects an alias declared by each repository about itself', async () => {
    const map = await buildAliasMap(
      reader({ 'acme/site.example': { board, alias: 'apex' }, 'acme/api': { board, alias: 'engine' } }),
      ['acme/site.example', 'acme/api'],
    )
    expect(map.get('apex')).toEqual({ owner: 'acme', repo: 'site.example' })
    expect(map.get('engine')).toEqual({ owner: 'acme', repo: 'api' })
  })

  it('skips a repository with no config', async () => {
    const map = await buildAliasMap(reader({ 'acme/web': null }), ['acme/web'])
    expect(map.size).toBe(0)
  })

  it('refuses two repositories claiming one alias', async () => {
    await expect(
      buildAliasMap(
        reader({ 'acme/web': { board, alias: 'apex' }, 'acme/api': { board, alias: 'apex' } }),
        ['acme/web', 'acme/api'],
      ),
    ).rejects.toThrow(AliasConflictError)
  })
})

describe('resolveAlias', () => {
  const map = new Map([['apex', { owner: 'acme', repo: 'site.example' }]])

  it('expands an alias reference', () => {
    expect(resolveAlias(map, 'apex#272')).toEqual({ owner: 'acme', repo: 'site.example', number: 272 })
  })

  it('returns null for an unknown alias', () => {
    expect(resolveAlias(map, 'racing#293')).toBeNull()
  })

  it('returns null for a bare number', () => {
    expect(resolveAlias(map, '272')).toBeNull()
  })
})
