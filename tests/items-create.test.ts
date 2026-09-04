import { describe, expect, it, vi } from 'vitest'
import {
  createItem,
  OrphanedIssueError,
  StatuslessItemError,
} from '../server/providers/github/items.js'
import { selectNext } from '../server/providers/github/next.js'

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

    // The real path now sets the board's todo status before it returns, so predicting `null`
    // here would understate it — the same divergence as the overstatement this test was written
    // for, pointing the other way. Read from `semantics`, not the literal "Todo": the prediction
    // must track whatever this board calls todo.
    expect(result.status).toBe(snapshot.semantics.todo)
    // Nothing links the new issue to an epic — armature issues no sub-issue mutation.
    expect(result.parent).toBeNull()
    expect(result.epic).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// A fake board that records what the mutations actually did.
//
// The bug is not "the returned object carries the wrong status" — it is that a created item was
// invisible to the tool that finds work. An assertion reading `result.status` would pass on a tool
// that returns "Todo" while writing nothing. So the fake stores what the status mutation wrote,
// looked up by the option id the code sent, and the read-back reports that store: send the wrong
// option id and the item stays unset, exactly as the real board would leave it.
// ---------------------------------------------------------------------------------------------
function fakeBoard(options: { failStatusWrite?: boolean } = {}) {
  let status: string | null = null

  const client = {
    graphql: vi.fn(async (query: string, variables: Record<string, string>) => {
      if (query.includes('createIssue')) return { createIssue: { issue: { id: 'I_1', number: 42 } } }
      if (query.includes('addProjectV2ItemById')) {
        return { addProjectV2ItemById: { item: { id: 'PVTI_1' } } }
      }
      if (query.includes('updateProjectV2ItemFieldValue')) {
        if (options.failStatusWrite) throw new Error('status write failed')
        status = snapshot.statusOptions.find((o) => o.id === variables.option)?.name ?? null
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } }
      }
      return { repository: { id: 'R_1' } }
    }),
  } as any

  const read = async (ref: { owner: string; repo: string; number: number }) => ({
    ref,
    id: 'I_1',
    title: input.title,
    body: input.body,
    state: 'OPEN' as const,
    status,
    projectItemId: 'PVTI_1',
    parent: null,
    epic: null,
  })

  return { client, read }
}

describe('createItem lands the item where work is found', () => {
  it('is returned by the same selector board_next uses, with no second call', async () => {
    const { client, read } = fakeBoard()

    const created = await createItem(client, board, snapshot, input, { read })

    const next = selectNext({ ...snapshot, items: [created] }, {})
    expect(next.kind).toBe('item')
    expect((next as { item: { ref: unknown } }).item.ref).toEqual({
      owner: 'acme',
      repo: 'web',
      number: 42,
    })
  })

  // Two writes now stand between "create" and "findable", so there is a new way to land halfway:
  // the issue exists and is on the board, but statusless and invisible to every selector. Failing
  // loudly is not enough on its own — the error has to say which of those two states the board is
  // actually in, because the remedies are different.
  it('names the item and the remedy when the status write fails after the board add', async () => {
    const { client, read } = fakeBoard({ failStatusWrite: true })

    const err = await createItem(client, board, snapshot, input, { read }).catch((e: Error) => e)

    expect(err).toBeInstanceOf(StatuslessItemError)
    // Not the orphan error: that one says the issue is untracked and asks the reader to add it to
    // the board. Here the add succeeded, so that message would send them after the wrong repair.
    expect(err).not.toBeInstanceOf(OrphanedIssueError)
    expect((err as Error).message).toContain('acme/web#42')
    expect((err as Error).message).toContain('item_status')
    expect((err as Error).message).toContain('status write failed')
  })
})
