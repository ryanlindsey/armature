import { describe, expect, it, vi } from 'vitest'
import { NoSuchEntryError, parseChecklist } from '../server/providers/github/checklist.js'
import type { GitHubClient } from '../server/providers/github/client.js'
import {
  checkEntries,
  claim,
  type ItemReader,
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
    checklist: [], status, projectItemId: 'PVTI_1', parent: null, epic: null, blockedBy: [],
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

describe('checkEntries', () => {
  const REF = { owner: 'acme', repo: 'web', number: 7 }

  // One harness for every case below. `body` is the live issue body: the fake read derives its
  // checklist from it, and the fake write replaces it, so a read-back sees what a write left.
  function harness(initial: string, opts: { swallowWrite?: boolean } = {}) {
    const sent: { query: string; variables: Record<string, unknown> }[] = []
    let body = initial
    const read: ItemReader = async () => ({
      ref: REF, id: 'I_1', title: 't', body, state: 'OPEN' as const,
      status: 'Todo', projectItemId: 'PVTI_1', parent: null, epic: null, blockedBy: [],
      checklist: parseChecklist(body),
    })
    const client = {
      graphql: async (query: string, variables: Record<string, unknown>) => {
        sent.push({ query, variables })
        if (!opts.swallowWrite) body = variables.body as string
        return {}
      },
    } as unknown as GitHubClient
    return { client, read, sent, body: () => body }
  }

  const TWO = ['## Acceptance', '- [ ] first', '- [ ] second'].join('\n')

  it('writes the transformed body and verifies every requested entry by reading back', async () => {
    const { client, read, sent } = harness(TWO)

    const after = await checkEntries(client, board, REF, [{ text: 'first', checked: true }], { read })

    expect(sent).toHaveLength(1)
    expect(sent[0]!.variables).toEqual({ issue: 'I_1', body: TWO.replace('- [ ] first', '- [x] first') })
    expect(after.checklist.find((e) => e.text === 'first')!.checked).toBe(true)
    expect(after.checklist.find((e) => e.text === 'second')!.checked).toBe(false)
  })

  it('unticks as well as ticks', async () => {
    const { client, read, body } = harness(['- [x] first', '- [X] second'].join('\n'))

    await checkEntries(client, board, REF, [
      { text: 'first', checked: false },
      { text: 'second', checked: false },
    ], { read })

    expect(body()).toBe(['- [ ] first', '- [ ] second'].join('\n'))
  })

  it('sends no mutation at all when every requested state already holds', async () => {
    const { client, read, sent } = harness(['- [x] first', '- [ ] second'].join('\n'))

    const after = await checkEntries(client, board, REF, [
      { text: 'first', checked: true },
      { text: 'second', checked: false },
    ], { read })

    expect(sent).toHaveLength(0)
    expect(after.checklist[0]!.checked).toBe(true)
  })

  it('still verifies by reading back when it sends nothing', async () => {
    const { client, sent } = harness('- [ ] first')
    let reads = 0
    const flipping: ItemReader = async () => {
      // The first read sees the box ticked; by the read-back someone has unticked it.
      const body = reads++ === 0 ? '- [x] first' : '- [ ] first'
      return {
        ref: REF, id: 'I_1', title: 't', body, state: 'OPEN' as const,
        status: 'Todo', projectItemId: 'PVTI_1', parent: null, epic: null, blockedBy: [],
        checklist: parseChecklist(body),
      }
    }

    await expect(
      checkEntries(client, board, REF, [{ text: 'first', checked: true }], { read: flipping }),
    ).rejects.toThrow(UnverifiedWriteError)
    expect(sent).toHaveLength(0)
  })

  it('sends no mutation when one entry in the batch is unmatched', async () => {
    const { client, read, sent } = harness(TWO)

    await expect(
      checkEntries(client, board, REF, [
        { text: 'first', checked: true },
        { text: 'nope', checked: true },
      ], { read }),
    ).rejects.toThrow(NoSuchEntryError)

    expect(sent).toHaveLength(0)
  })

  it('raises UnverifiedWriteError naming the entry when the read-back disagrees', async () => {
    // swallowWrite: the mutation is accepted and changes nothing, which is exactly the shape of a
    // write that lands somewhere other than where it was aimed.
    const { client, read } = harness(TWO, { swallowWrite: true })

    const error = await checkEntries(client, board, REF, [{ text: 'first', checked: true }], { read })
      .then(() => null)
      .catch((e: Error) => e)

    expect(error).toBeInstanceOf(UnverifiedWriteError)
    expect(error!.message).toContain('acme/web#7')
    expect(error!.message).toContain('[x] first')
    expect(error!.message).toContain('[ ] first')
    // A body write is not a board write: the advice must not claim the board is unchanged.
    expect(error!.message).not.toMatch(/board as unchanged/)
    expect(error!.message).toMatch(/item_get/)
  })

  it('names an entry the read-back no longer holds at all', async () => {
    const { client, sent } = harness('- [ ] first')
    let reads = 0
    const vanishing: ItemReader = async () => {
      const body = reads++ === 0 ? '- [ ] first' : '- [x] renamed'
      return {
        ref: REF, id: 'I_1', title: 't', body, state: 'OPEN' as const,
        status: 'Todo', projectItemId: 'PVTI_1', parent: null, epic: null, blockedBy: [],
        checklist: parseChecklist(body),
      }
    }

    const error = await checkEntries(client, board, REF, [{ text: 'first', checked: true }], { read: vanishing })
      .then(() => null)
      .catch((e: Error) => e)

    expect(sent).toHaveLength(1)
    expect(error).toBeInstanceOf(UnverifiedWriteError)
    expect(error!.message).toContain('shows "no such entry"')
  })

  it('refuses a read-back that now holds the entry twice, rather than trusting the first', async () => {
    const { client, sent } = harness('- [ ] first')
    let reads = 0
    const doubling: ItemReader = async () => {
      // A concurrent edit adds a second "first" before the read-back; the ticked one comes first.
      const body = reads++ === 0 ? '- [ ] first' : '- [x] first\n- [ ] first'
      return {
        ref: REF, id: 'I_1', title: 't', body, state: 'OPEN' as const,
        status: 'Todo', projectItemId: 'PVTI_1', parent: null, epic: null, blockedBy: [],
        checklist: parseChecklist(body),
      }
    }

    const error = await checkEntries(client, board, REF, [{ text: 'first', checked: true }], { read: doubling })
      .then(() => null)
      .catch((e: Error) => e)

    expect(sent).toHaveLength(1)
    expect(error).toBeInstanceOf(UnverifiedWriteError)
    expect(error!.message).toContain('2 entries with this text')
  })

  it('computes and reports without sending under dryRun', async () => {
    const { client, read, sent } = harness(TWO)

    const after = await checkEntries(client, board, REF, [{ text: 'first', checked: true }], { read, dryRun: true })

    expect(sent).toHaveLength(0)
    expect(after.body).toBe(TWO.replace('- [ ] first', '- [x] first'))
    expect(after.checklist.find((e) => e.text === 'first')!.checked).toBe(true)
  })

  it('raises the same error under dryRun as it does for real', async () => {
    const { client, read, sent } = harness(TWO)

    await expect(
      checkEntries(client, board, REF, [{ text: 'nope', checked: true }], { read, dryRun: true }),
    ).rejects.toThrow(NoSuchEntryError)

    expect(sent).toHaveLength(0)
  })
})
