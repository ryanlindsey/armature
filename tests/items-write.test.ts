import { describe, expect, it, vi } from 'vitest'
import { setStatus, StaleItemError, UnverifiedWriteError } from '../server/providers/github/items.js'

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
})
