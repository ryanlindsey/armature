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

  // Same question as parseRef's host check, and cheaper decided together: armature's client
  // talks to api.github.com only, so an origin on another host names a repository armature
  // cannot read — and would be reported as if it could.
  it('rejects a GitLab ssh remote', () => {
    expect(() => parseOriginUrl('git@gitlab.com:acme/web.git')).toThrow(ConfigError)
    expect(() => parseOriginUrl('git@gitlab.com:acme/web.git')).toThrow(/gitlab\.com/)
  })

  it('rejects a self-hosted Gitea https remote', () => {
    expect(() => parseOriginUrl('https://gitea.example/acme/web.git')).toThrow(ConfigError)
  })

  it('accepts an https remote that carries a credential', () => {
    expect(parseOriginUrl('https://user:ghp_SECRET@github.com/acme/web.git')).toEqual({
      owner: 'acme', name: 'web',
    })
  })

  // An ordinary GitHub URL with a trailing slash does not match, and the error interpolated the
  // raw remote — so a credential in the origin was echoed verbatim to stderr and to the MCP
  // client.
  it('never echoes a credential from an unparseable remote', () => {
    const error = (() => {
      try {
        parseOriginUrl('https://user:ghp_SECRET@github.com/acme/web/')
        return null
      } catch (e) {
        return e as Error
      }
    })()
    expect(error).toBeInstanceOf(ConfigError)
    expect(error!.message).not.toContain('ghp_SECRET')
    expect(error!.message).toContain('***@github.com')
  })

  it('never echoes a credential from a remote on the wrong host', () => {
    const error = (() => {
      try {
        parseOriginUrl('https://user:ghp_SECRET@gitea.example/acme/web.git')
        return null
      } catch (e) {
        return e as Error
      }
    })()
    expect(error).toBeInstanceOf(ConfigError)
    expect(error!.message).not.toContain('ghp_SECRET')
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

  it('uses the user config board when no repo config board and no environment', () => {
    const c = resolveConfig({
      originUrl: 'git@github.com:acme/web.git',
      repoConfig: {},
      userConfig: { board },
      env: {},
      boardsContainingRepo: [],
    })
    expect(c.board.number).toBe(1)
    expect(c.boardSource).toBe('user')
  })

  // Origin names the repository; it does not name the board when something else already does.
  // Requiring it unconditionally meant the server refused to start outside a git checkout even
  // when ARMATURE_BOARD fully determined which board to work.
  it('resolves without an origin when the environment names the board', () => {
    const c = resolveConfig({
      originUrl: null,
      repoConfig: {},
      userConfig: {},
      env: { ARMATURE_BOARD: 'github:acme/7' },
      boardsContainingRepo: [],
    })
    expect(c.board.number).toBe(7)
    expect(c.repo).toBeNull()
  })

  it('resolves without an origin when .armature.json names the board', () => {
    const c = resolveConfig({
      originUrl: null,
      repoConfig: { board },
      userConfig: {},
      env: {},
      boardsContainingRepo: [],
    })
    expect(c.board.number).toBe(1)
    expect(c.boardSource).toBe('repo')
  })

  it('explains the missing origin only when the board could not be resolved without it', () => {
    expect(() =>
      resolveConfig({
        originUrl: null,
        originProblem: 'Cannot read the "origin" remote in /tmp/nowhere',
        repoConfig: {},
        userConfig: {},
        env: {},
        boardsContainingRepo: [],
      }),
    ).toThrow(/origin/)
  })

  it('throws when no board is found anywhere', () => {
    expect(() =>
      resolveConfig({
        originUrl: 'git@github.com:acme/web.git',
        repoConfig: {},
        userConfig: {},
        env: {},
        boardsContainingRepo: [],
      }),
    ).toThrow(/acme\/web.*\.armature\.json.*ARMATURE_BOARD/)
  })
})
