import { describe, expect, it } from 'vitest'
import { epicOrder, selectNext } from '../server/providers/github/next.js'
import type { BoardItem, BoardSnapshot } from '../server/providers/types.js'

const semantics = { todo: 'Todo', claimed: 'In progress', review: null, done: 'Done' }

function make(
  repo: string, number: number, status: string, title = 't',
  parent: BoardItem['parent'] = null,
): BoardItem {
  return {
    ref: { owner: 'acme', repo, number },
    id: `${repo}#${number}`, title, status, state: 'OPEN', parent,
  }
}

function snap(items: BoardItem[]): BoardSnapshot {
  return {
    id: 'P', statusFieldId: 'F', statusOptions: [], semantics,
    items, repositories: [], collisions: {},
  }
}

describe('epicOrder', () => {
  it('reads the epic number out of the title', () => {
    expect(epicOrder('Epic 4 · Telemetry', 900)).toBe(4)
  })

  it('falls back to the issue number', () => {
    expect(epicOrder('Untitled work', 900)).toBe(900)
  })
})

describe('selectNext', () => {
  const epic1 = make('platform', 10, 'Todo', 'Epic 1 · Foundations')
  const epic2 = make('platform', 20, 'Todo', 'Epic 2 · Telemetry')

  it('drops from an epic to its lowest-numbered actionable child', () => {
    const s = snap([
      epic1,
      make('web', 7, 'Todo', 'child b', epic1.ref),
      make('web', 5, 'Todo', 'child a', epic1.ref),
    ])
    const result = selectNext(s, {})
    expect(result.kind).toBe('item')
    if (result.kind === 'item') expect(result.item.ref.number).toBe(5)
  })

  it('takes the lower-numbered epic first', () => {
    const s = snap([
      epic1, epic2,
      make('web', 9, 'Todo', 'later', epic2.ref),
      make('web', 8, 'Todo', 'earlier', epic1.ref),
    ])
    const result = selectNext(s, {})
    if (result.kind === 'item') expect(result.item.ref.number).toBe(8)
  })

  it('restricts to one repository when asked', () => {
    const s = snap([
      epic1,
      make('api', 3, 'Todo', 'api work', epic1.ref),
      make('web', 4, 'Todo', 'web work', epic1.ref),
    ])
    const result = selectNext(s, { repo: 'acme/web' })
    if (result.kind === 'item') expect(result.item.ref.repo).toBe('web')
  })

  it('never returns an epic itself', () => {
    const s = snap([epic1, make('web', 5, 'Todo', 'child', epic1.ref)])
    const result = selectNext(s, {})
    if (result.kind === 'item') expect(result.item.ref.number).toBe(5)
  })

  it('reports why nothing is actionable rather than returning empty', () => {
    const s = snap([epic1, make('web', 5, 'Done', 'child', epic1.ref)])
    const result = selectNext(s, {})
    expect(result.kind).toBe('blocked')
    if (result.kind === 'blocked') expect(result.because).toMatch(/nothing/i)
  })

  it('explains why it chose what it chose', () => {
    const s = snap([epic1, make('web', 5, 'Todo', 'child', epic1.ref)])
    const result = selectNext(s, {})
    if (result.kind === 'item') expect(result.because).toContain('acme/platform#10')
  })

  it('matches repo filter case-insensitively', () => {
    const s = snap([
      epic1,
      make('api', 3, 'Todo', 'api work', epic1.ref),
      make('web', 4, 'Todo', 'web work', epic1.ref),
    ])
    const result = selectNext(s, { repo: 'ACME/WEB' })
    expect(result.kind).toBe('item')
    if (result.kind === 'item') expect(result.item.ref.repo).toBe('web')
  })

  it('distinguishes when repo filter matches no items on board', () => {
    const s = snap([
      epic1,
      make('web', 5, 'Todo', 'child', epic1.ref),
    ])
    const result = selectNext(s, { repo: 'acme/nonexistent' })
    expect(result.kind).toBe('blocked')
    if (result.kind === 'blocked') {
      expect(result.because).toMatch(/filter|matched nothing|nonexistent/)
      expect(result.because).not.toContain('0 item(s) were considered')
    }
  })

  it('reports item count when items exist but none are todo', () => {
    const s = snap([epic1, make('web', 5, 'Done', 'child', epic1.ref)])
    const result = selectNext(s, {})
    expect(result.kind).toBe('blocked')
    if (result.kind === 'blocked') {
      expect(result.because).toContain('1 item(s) were considered')
      expect(result.because).not.toMatch(/filter|matched nothing/)
    }
  })
})
