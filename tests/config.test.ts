import { describe, expect, it } from 'vitest'
import { ConfigError, parseOriginUrl, resolveConfig } from '../server/config.js'

const board = { provider: 'github' as const, owner: 'acme', number: 1 }

describe('parseOriginUrl', () => {
  it('parses an ssh remote', () => {
    expect(parseOriginUrl('git@github.com:acme/web.git')).toEqual({ owner: 'acme', name: 'web' })
  })

  it('parses an https remote', () => {
    expect(parseOriginUrl('https://github.com/acme/web.git')).toEqual({ owner: 'acme', name: 'web' })
  })

  it('parses a remote with no .git suffix', () => {
    expect(parseOriginUrl('https://github.com/acme/site.example')).toEqual({
      owner: 'acme', name: 'site.example',
    })
  })

  it('rejects an unparseable remote', () => {
    expect(() => parseOriginUrl('not-a-remote')).toThrow(ConfigError)
  })
})

describe('resolveConfig', () => {
  it('derives the repository from origin', () => {
    const c = resolveConfig({
      originUrl: 'git@github.com:acme/web.git',
      repoConfig: { board },
      userConfig: {},
      env: {},
      boardsContainingRepo: [],
    })
    expect(c.repo).toEqual({ owner: 'acme', name: 'web' })
  })

  it('prefers the repo config board over the user config board', () => {
    const c = resolveConfig({
      originUrl: 'git@github.com:acme/web.git',
      repoConfig: { board },
      userConfig: { board: { provider: 'github', owner: 'other', number: 9 } },
      env: {},
      boardsContainingRepo: [],
    })
    expect(c.board.number).toBe(1)
    expect(c.boardSource).toBe('repo')
  })

  it('prefers the environment over every file', () => {
    const c = resolveConfig({
      originUrl: 'git@github.com:acme/web.git',
      repoConfig: { board },
      userConfig: {},
      env: { ARMATURE_BOARD: 'github:acme/7' },
      boardsContainingRepo: [],
    })
    expect(c.board.number).toBe(7)
    expect(c.boardSource).toBe('env')
  })

  it('derives the board when exactly one contains the repository', () => {
    const c = resolveConfig({
      originUrl: 'git@github.com:acme/web.git',
      repoConfig: {},
      userConfig: {},
      env: {},
      boardsContainingRepo: [board],
    })
    expect(c.board.number).toBe(1)
    expect(c.boardSource).toBe('derived')
  })

  it('names the candidates when several boards contain the repository', () => {
    expect(() =>
      resolveConfig({
        originUrl: 'git@github.com:acme/web.git',
        repoConfig: {},
        userConfig: {},
        env: {},
        boardsContainingRepo: [board, { provider: 'github', owner: 'acme', number: 4 }],
      }),
    ).toThrow(/acme\/1.*acme\/4/s)
  })

  it('defaults verify to an empty list', () => {
    const c = resolveConfig({
      originUrl: 'git@github.com:acme/web.git',
      repoConfig: { board },
      userConfig: {},
      env: {},
      boardsContainingRepo: [],
    })
    expect(c.verify).toEqual([])
  })
})
