import { describe, expect, it } from 'vitest'
import { parseEpicFromBody } from '../server/providers/github/items.js'

describe('parseEpicFromBody', () => {
  it('reads a cross-repository epic reference', () => {
    const body = 'Part of the telemetry epic in acme/platform (Epic 4, issue #339).'
    expect(parseEpicFromBody(body)).toEqual({ owner: 'acme', repo: 'platform', number: 339 })
  })

  it('reads a shorthand reference', () => {
    expect(parseEpicFromBody('Part of acme/platform#339.')).toEqual({
      owner: 'acme', repo: 'platform', number: 339,
    })
  })

  // A bare number in a body names an issue in some other repository. Refuse to guess.
  it('returns null for a bare number', () => {
    expect(parseEpicFromBody('Part of the epic, issue #339.')).toBeNull()
  })

  it('returns null when there is no reference', () => {
    expect(parseEpicFromBody('No epic here.')).toBeNull()
  })
})
