import { describe, expect, it, vi } from 'vitest'
import {
  claim,
  NotOnBoardError,
  setStatus,
  StaleItemError,
  UnverifiedWriteError,
} from '../server/providers/github/items.js'

const board = { provider: 'github' as const, owner: 'acme', number: 1 }
const ref = { owner: 'acme', repo: 'web', number: 278 }

const snapshot = {
  board: { provider: 'github', name: 'acme/1', source: 'repo' as const },
  id: 'PVT_1',
  statusFieldId: 'F_1',
  statusOptions: [
    { id: 'o-todo', name: 'Todo' },
    { id: 'o-doing', name: 'In progress' },
  ],
  semantics: { todo: 'Todo', claimed: 'In progress', review: null, done: 'Done' },
  items: [],
  repositories: [],
  collisions: {},
}

function detail(status: string) {
  return {
    ref, id: 'I_1', title: 't', body: '', state: 'OPEN' as const,
    status, projectItemId: 'PVTI_1', parent: null, epic: null,
  }
}

describe('setStatus', () => {
  it('refuses when the pre-state is not what the caller expected', async () => {
    const read = async () => detail('In progress')
    const client = { graphql: vi.fn() } as any

    await expect(
      setStatus(client, board, snapshot, ref, 'In progress', { expectStatus: 'Todo', read }),
    ).rejects.toThrow(StaleItemError)
    expect(client.graphql).not.toHaveBeenCalled()
  })

  it('raises when the read-back does not show the new status', async () => {
    const reads = [detail('Todo'), detail('Todo')]
    let call = 0
    const read = async () => reads[call++]!
    const client = { graphql: vi.fn().mockResolvedValue({}) } as any

    await expect(setStatus(client, board, snapshot, ref, 'In progress', { read })).rejects.toThrow(
      UnverifiedWriteError,
    )
  })

  it('returns the observed state when the write lands', async () => {
    const reads = [detail('Todo'), detail('In progress')]
    let call = 0
    const read = async () => reads[call++]!
    const client = { graphql: vi.fn().mockResolvedValue({}) } as any

    const result = await setStatus(client, board, snapshot, ref, 'In progress', { read })
    expect(result.status).toBe('In progress')
  })

  it('mutates nothing in dry run and reports the intended effect', async () => {
    const read = async () => detail('Todo')
    const client = { graphql: vi.fn() } as any

    const result = await setStatus(client, board, snapshot, ref, 'In progress', { dryRun: true, read })
    expect(client.graphql).not.toHaveBeenCalled()
    expect(result.status).toBe('In progress')
  })

  it('rejects a status the board does not offer', async () => {
    const read = async () => detail('Todo')
    const client = { graphql: vi.fn() } as any

    await expect(setStatus(client, board, snapshot, ref, 'Nonsense', { read })).rejects.toThrow(
      /Todo, In progress/,
    )
  })

  // The spec: "not on the board, ask before adding" survives as policy, and detection is the
  // server's. SKILL.md builds a rule on it — and nothing exercised it, so deleting the guard
  // broke no test and the string appeared in no test file.
  it('refuses to write to an item that is not on the board', async () => {
    const read = async () => ({ ...detail('Todo'), projectItemId: null })
    const client = { graphql: vi.fn() } as any

    await expect(setStatus(client, board, snapshot, ref, 'In progress', { read })).rejects.toThrow(
      NotOnBoardError,
    )
    expect(client.graphql).not.toHaveBeenCalled()
  })

  it('says which board the item is missing from, and that creating an issue does not add it', async () => {
    const read = async () => ({ ...detail('Todo'), projectItemId: null })
    const client = { graphql: vi.fn() } as any

    const error = await setStatus(client, board, snapshot, ref, 'In progress', { read }).catch(
      (e: Error) => e,
    )
    expect((error as Error).message).toContain('acme/1')
    expect((error as Error).message).toMatch(/does not add it to a board/i)
  })

  // A caller supplying the board item id skips the read, and the staleness check is a comparison
  // against what that read returned. Honouring both would mean quietly not checking — the failure
  // mode `expectStatus` exists to prevent, reintroduced by the option that was meant to be safe.
  it('refuses a projectItemId and an expectStatus together rather than skipping the check', async () => {
    const read = vi.fn(async () => detail('Todo'))
    const client = { graphql: vi.fn() } as any

    await expect(
      setStatus(client, board, snapshot, ref, 'In progress', {
        read,
        projectItemId: 'PVTI_1',
        expectStatus: 'Todo',
      }),
    ).rejects.toThrow(/one or the other/i)
    expect(client.graphql).not.toHaveBeenCalled()
  })

  it('writes with a supplied board item id without reading to re-derive it', async () => {
    const read = vi.fn(async () => detail('In progress'))
    const client = { graphql: vi.fn().mockResolvedValue({}) } as any

    const result = await setStatus(client, board, snapshot, ref, 'In progress', {
      read,
      projectItemId: 'PVTI_supplied',
    })

    // One read only — the read-back that verifies the write, which is never skipped.
    expect(read).toHaveBeenCalledTimes(1)
    expect(client.graphql.mock.calls[0]![1].item).toBe('PVTI_supplied')
    expect(result.status).toBe('In progress')
  })

  // The id says a write is possible; it does not say a write was asked for. A dry run that fell
  // through to the mutation because it had an id would be the worst failure this flag can have.
  it('performs no write under dry run even when handed a board item id', async () => {
    const read = vi.fn(async () => detail('Todo'))
    const client = { graphql: vi.fn() } as any

    const result = await setStatus(client, board, snapshot, ref, 'In progress', {
      read,
      projectItemId: 'PVTI_supplied',
      dryRun: true,
    })

    expect(client.graphql).not.toHaveBeenCalled()
    expect(result.status).toBe('In progress')
  })
})

// The spec names this guarantee explicitly: "Item claimed by another actor between board_next
// and item_claim → pre-state verified; fail reporting what was found". No test imported `claim`,
// so deleting `expectStatus: snapshot.semantics.todo` from it broke nothing.
describe('claim', () => {
  it("moves an item from the board's todo status to its claimed status", async () => {
    const reads = [detail('Todo'), detail('In progress')]
    let call = 0
    const read = async () => reads[call++]!
    const client = { graphql: vi.fn().mockResolvedValue({}) } as any

    const result = await claim(client, board, snapshot, ref, { read })

    expect(result.status).toBe('In progress')
    expect(client.graphql).toHaveBeenCalledTimes(1)
  })

  it('refuses when someone else moved the item first, and writes nothing', async () => {
    const read = async () => detail('In progress')
    const client = { graphql: vi.fn() } as any

    await expect(claim(client, board, snapshot, ref, { read })).rejects.toThrow(StaleItemError)
    expect(client.graphql).not.toHaveBeenCalled()
  })

  it('reports what it expected and what it found, so the caller knows the board moved', async () => {
    const read = async () => detail('Done')
    const client = { graphql: vi.fn() } as any

    const error = await claim(client, board, snapshot, ref, { read }).catch((e: Error) => e)
    expect((error as Error).message).toContain('"Todo"')
    expect((error as Error).message).toContain('"Done"')
    expect((error as Error).message).toMatch(/made no change/i)
  })

  it('claims into the status the board itself calls claimed, not a hardcoded name', async () => {
    const alternative = {
      ...snapshot,
      statusOptions: [
        { id: 'o-backlog', name: 'Backlog' },
        { id: 'o-wip', name: 'WIP' },
      ],
      semantics: { todo: 'Backlog', claimed: 'WIP', review: null, done: 'Shipped' },
    }
    const reads = [detail('Backlog'), detail('WIP')]
    let call = 0
    const read = async () => reads[call++]!
    const client = { graphql: vi.fn().mockResolvedValue({}) } as any

    const result = await claim(client, board, alternative, ref, { read })
    expect(result.status).toBe('WIP')
  })

  it('refuses to claim an item that is not on the board', async () => {
    const read = async () => ({ ...detail('Todo'), projectItemId: null })
    const client = { graphql: vi.fn() } as any

    await expect(claim(client, board, snapshot, ref, { read })).rejects.toThrow(NotOnBoardError)
  })
})
