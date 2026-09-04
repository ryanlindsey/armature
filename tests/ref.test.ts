import { describe, expect, it } from 'vitest'
import { BareRefError, ForeignHostError, formatRef, parseRef } from '../server/ref.js'

describe('parseRef', () => {
  it('accepts a fully qualified reference', () => {
    expect(parseRef('acme/web#278')).toEqual({ owner: 'acme', repo: 'web', number: 278 })
  })

  it('accepts a repository name containing dots', () => {
    expect(parseRef('acme/site.example#12')).toEqual({
      owner: 'acme', repo: 'site.example', number: 12,
    })
  })

  it('accepts an issue URL', () => {
    expect(parseRef('https://github.com/acme/web/issues/278')).toEqual({
      owner: 'acme', repo: 'web', number: 278,
    })
  })

  // The incident: one number names a different issue in every repository on a board.
  it('refuses a bare number', () => {
    expect(() => parseRef('278')).toThrow(BareRefError)
  })

  it('refuses a hash-prefixed bare number', () => {
    expect(() => parseRef('#278')).toThrow(BareRefError)
  })

  it('explains why a bare number is refused', () => {
    expect(() => parseRef('278')).toThrow(/not unique across repositories/)
  })

  it('refuses a repository with no number', () => {
    expect(() => parseRef('acme/web')).toThrow(BareRefError)
  })

  it('refuses a URL with trailing garbage attached to the number', () => {
    expect(() => parseRef('https://github.com/acme/web/issues/278abc')).toThrow(BareRefError)
  })

  it('accepts a URL with a trailing path (e.g., /comments)', () => {
    expect(parseRef('https://github.com/acme/web/issues/278/comments')).toEqual({
      owner: 'acme', repo: 'web', number: 278,
    })
  })

  it('accepts a URL with a fragment (e.g., #issuecomment-12345)', () => {
    expect(parseRef('https://github.com/acme/web/issues/278#issuecomment-12345')).toEqual({
      owner: 'acme', repo: 'web', number: 278,
    })
  })

  it('accepts a URL with a query string', () => {
    expect(parseRef('https://github.com/acme/web/issues/278?x=1')).toEqual({
      owner: 'acme', repo: 'web', number: 278,
    })
  })

  it('accepts the www host', () => {
    expect(parseRef('https://www.github.com/acme/web/issues/278')).toEqual({
      owner: 'acme', repo: 'web', number: 278,
    })
  })
})

// Gitea and Forgejo serve issues at exactly /owner/repo/issues/N, and armature's client talks to
// api.github.com and nothing else. Accepting any host meant a Gitea URL silently became a GitHub
// reference naming a different tracker's issue — the collision the whole ref type exists to make
// inexpressible, arriving through the front door.
describe('parseRef and foreign hosts', () => {
  it('refuses a Gitea issue URL rather than reading it as a GitHub reference', () => {
    expect(() => parseRef('https://gitea.example/acme/web/issues/278')).toThrow(ForeignHostError)
  })

  it('refuses a GitLab issue URL', () => {
    expect(() => parseRef('https://gitlab.com/acme/web/issues/278')).toThrow(ForeignHostError)
  })

  it('refuses a host that merely ends in github.com', () => {
    expect(() => parseRef('https://evilgithub.com/acme/web/issues/278')).toThrow(ForeignHostError)
  })

  it('names the host it refused, and says what armature accepts', () => {
    expect(() => parseRef('https://gitea.example/acme/web/issues/278')).toThrow(/gitea\.example/)
    expect(() => parseRef('https://gitea.example/acme/web/issues/278')).toThrow(/github\.com/)
  })

  it('does not echo a credential embedded in the refused URL', () => {
    const error = (() => {
      try {
        parseRef('https://user:ghp_SECRET@gitea.example/acme/web/issues/278')
        return null
      } catch (e) {
        return e as Error
      }
    })()
    expect(error).toBeInstanceOf(ForeignHostError)
    expect(error!.message).not.toContain('ghp_SECRET')
  })
})

describe('formatRef', () => {
  it('round-trips', () => {
    const ref = parseRef('acme/web#278')
    expect(formatRef(ref)).toBe('acme/web#278')
  })
})
