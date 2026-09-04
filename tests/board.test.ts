import { describe, expect, it } from 'vitest'
import { computeCollisions, inferStatusSemantics } from '../server/providers/github/board.js'
import type { BoardItem } from '../server/providers/types.js'

function item(owner: string, repo: string, number: number): BoardItem {
  return {
    ref: { owner, repo, number },
    id: `${owner}/${repo}#${number}`,
    title: 't',
    status: 'Todo',
    state: 'OPEN',
    parent: null,
  }
}

describe('computeCollisions', () => {
  it('finds a number claimed by two repositories', () => {
    const c = computeCollisions([item('acme', 'web', 278), item('acme', 'api', 278)])
    expect(c[278]).toEqual(['acme/api', 'acme/web'])
  })

  it('ignores a number used once', () => {
    const c = computeCollisions([item('acme', 'web', 1), item('acme', 'api', 2)])
    expect(c).toEqual({})
  })
})

describe('inferStatusSemantics', () => {
  it('reads a conventional board', () => {
    const s = inferStatusSemantics(['Todo', 'In progress', 'Validation', 'Done', 'On hold'])
    expect(s).toEqual({ todo: 'Todo', claimed: 'In progress', review: 'Validation', done: 'Done' })
  })

  it('accepts alternative wording', () => {
    const s = inferStatusSemantics(['Backlog', 'Doing', 'In Review', 'Shipped'])
    expect(s).toEqual({ todo: 'Backlog', claimed: 'Doing', review: 'In Review', done: 'Shipped' })
  })

  it('leaves review null when the board has no review column', () => {
    const s = inferStatusSemantics(['Todo', 'WIP', 'Done'])
    expect(s.review).toBeNull()
    expect(s.claimed).toBe('WIP')
  })

  it('raises when no option resembles a claimed status', () => {
    expect(() => inferStatusSemantics(['Alpha', 'Beta'])).toThrow(/could not tell/i)
  })
})
