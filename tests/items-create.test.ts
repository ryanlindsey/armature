import { describe, expect, it, vi } from 'vitest'
import { createItem, OrphanedIssueError } from '../server/providers/github/items.js'

const board = { provider: 'github' as const, owner: 'acme', number: 1 }
const snapshot = {
  board: { provider: 'github', name: 'acme/1', source: 'repo' as const },
  id: 'PVT_1', statusFieldId: 'F_1',
  statusOptions: [{ id: 'o-todo', name: 'Todo' }],
  semantics: { todo: 'Todo', claimed: 'In progress', review: null, done: 'Done' },
  items: [], repositories: [], collisions: {},
}
const input = { owner: 'acme', repo: 'web', title: 'A ticket', body: 'Body' }

describe('createItem', () => {
  it('reports the orphan when the board add fails after the issue exists', async () => {
    const client = {
      graphql: vi
        .fn()
        .mockResolvedValueOnce({ repository: { id: 'R_1' } })
        .mockResolvedValueOnce({ createIssue: { issue: { id: 'I_1', number: 42 } } })
        .mockRejectedValueOnce(new Error('board add failed')),
    } as any

    const err = await createItem(client, board, snapshot, input).catch((e: Error) => e)
    expect(err).toBeInstanceOf(OrphanedIssueError)
    expect((err as Error).message).toContain('acme/web#42')
  })

  it('creates nothing in dry run', async () => {
    const client = { graphql: vi.fn() } as any
    const result = await createItem(client, board, snapshot, input, { dryRun: true })
    expect(client.graphql).not.toHaveBeenCalled()
    expect(result.title).toBe('A ticket')
  })

  // The dry run's whole value is that it predicts the real path. Reporting a status the real
  // path never sets, or an epic it never attaches, is a lie a caller acts on.
  it('claims no effect in dry run that the real path does not produce', async () => {
    const client = { graphql: vi.fn() } as any
    const result = await createItem(client, board, snapshot, input, { dryRun: true })

    // Adding an issue to a board sets no Status field: the real path's read-back reports
    // whatever the board shows, which for a fresh item is unset.
    expect(result.status).toBeNull()
    // Nothing links the new issue to an epic — armature issues no sub-issue mutation.
    expect(result.parent).toBeNull()
    expect(result.epic).toBeNull()
  })
})
