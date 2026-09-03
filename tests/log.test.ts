import { describe, expect, it } from 'vitest'
import { logMutation } from '../server/log.js'

describe('logMutation', () => {
  it('writes ref, field, before and after', () => {
    const lines: string[] = []
    logMutation(
      { ref: 'acme/web#278', field: 'Status', before: 'Todo', after: 'In progress' },
      (l) => lines.push(l),
    )
    const entry = JSON.parse(lines[0]!)
    expect(entry).toMatchObject({
      ref: 'acme/web#278', field: 'Status', before: 'Todo', after: 'In progress',
    })
    expect(entry.at).toBeTruthy()
  })

  it('never writes a credential', () => {
    const lines: string[] = []
    logMutation(
      { ref: 'acme/web#1', field: 'Status', before: null, after: 'Done', token: 'secret-value' } as never,
      (l) => lines.push(l),
    )
    expect(lines[0]).not.toContain('secret-value')
  })
})
