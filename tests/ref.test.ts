import { describe, expect, it } from 'vitest'
import { BareRefError, formatRef, parseRef } from '../server/ref.js'

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
})

describe('formatRef', () => {
  it('round-trips', () => {
    const ref = parseRef('acme/web#278')
    expect(formatRef(ref)).toBe('acme/web#278')
  })
})
