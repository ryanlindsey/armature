import { describe, expect, it, vi } from 'vitest'
import { parseChecklist } from '../server/providers/github/checklist.js'
import {
  ConcurrentEditError,
  DependsOnDriftError,
  EmptyChangeError,
  getItem,
  type ItemDetail,
  NotOnBoardError,
  UPDATE_ISSUE,
  updateItem,
  UnverifiedWriteError,
} from '../server/providers/github/items.js'
import type { WorkItemRef } from '../server/ref.js'

const board = { provider: 'github' as const, owner: 'acme', number: 1 }
const ref = { owner: 'acme', repo: 'web', number: 278 }
const V1 = '2026-10-01T00:00:00Z'
const V2 = '2026-10-02T00:00:00Z'

function detail(overrides: Partial<ItemDetail> = {}): ItemDetail {
  const body = overrides.body ?? ''
  return {
    ref, id: 'I_1', title: 'old title', body, state: 'OPEN',
    checklist: parseChecklist(body), status: 'Todo', projectItemId: 'PVTI_1',
    parent: null, epic: null, blockedBy: [], version: V1,
    ...overrides,
  }
}

/** A reader that answers each call with the next detail, repeating the last. */
function reader(...reads: ItemDetail[]) {
  let call = 0
  return vi.fn(async () => reads[Math.min(call++, reads.length - 1)]!)
}

const blocker = (number: number, owner = 'acme', repo = 'web'): WorkItemRef => ({ owner, repo, number })

describe('getItem reports a version', () => {
  function clientFor(issue: { updatedAt: string; title?: string; body?: string | null }) {
    return {
      graphql: vi.fn().mockResolvedValue({
        repository: {
          issue: {
            id: 'I_1', number: 278, title: 't', body: '', state: 'OPEN', parent: null,
            projectItems: { nodes: [], pageInfo: { hasNextPage: false } },
            ...issue,
          },
        },
      }),
    } as any
  }

  it('derives version from issue.updatedAt', async () => {
    const client = clientFor({ updatedAt: V2 })

    const item = await getItem(client, board, ref)

    expect(item.version).toContain(V2)
    expect(client.graphql.mock.calls[0][0]).toMatch(/updatedAt/)
    expect((await getItem(clientFor({ updatedAt: V1 }), board, ref)).version).not.toBe(item.version)
  })

  // updatedAt is reported to the second: an edit in the same second as the read must still
  // change the version, or the check meant to protect that edit lets it be overwritten.
  it('changes when the title or body changes within the same updatedAt', async () => {
    const base = (await getItem(clientFor({ updatedAt: V1, body: 'a' }), board, ref)).version
    const body = (await getItem(clientFor({ updatedAt: V1, body: 'b' }), board, ref)).version
    const title = (await getItem(clientFor({ updatedAt: V1, body: 'a', title: 'u' }), board, ref)).version
    const same = (await getItem(clientFor({ updatedAt: V1, body: 'a' }), board, ref)).version

    expect(body).not.toBe(base)
    expect(title).not.toBe(base)
    expect(same).toBe(base)
  })

  it('treats a null body as an empty one', async () => {
    const empty = (await getItem(clientFor({ updatedAt: V1, body: '' }), board, ref)).version
    const missing = (await getItem(clientFor({ updatedAt: V1, body: null }), board, ref)).version
    expect(missing).toBe(empty)
  })
})

describe('updateItem refusals', () => {
  it('refuses a stale version with ConcurrentEditError and sends nothing', async () => {
    const client = { graphql: vi.fn() } as any
    const read = reader(detail({ version: V2 }))

    const error = await updateItem(client, board, ref, { title: 'new', expectVersion: V1 }, { read })
      .catch((e: Error) => e)

    expect(error).toBeInstanceOf(ConcurrentEditError)
    expect((error as Error).message).toContain(V1)
    expect((error as Error).message).toContain(V2)
    expect((error as Error).message).toContain('acme/web#278')
    expect((error as Error).message).toMatch(/item_get/)
    expect(client.graphql).not.toHaveBeenCalled()
  })

  it('refuses an off-board item with NotOnBoardError and sends nothing', async () => {
    const client = { graphql: vi.fn() } as any
    const read = reader(detail({ projectItemId: null }))

    await expect(
      updateItem(client, board, ref, { title: 'new', expectVersion: V1 }, { read }),
    ).rejects.toThrow(NotOnBoardError)
    expect(client.graphql).not.toHaveBeenCalled()
  })

  it('refuses a body that adds a Depends on line for an unlinked ref, naming it', async () => {
    const client = { graphql: vi.fn() } as any
    const read = reader(detail({ blockedBy: [] }))

    const error = await updateItem(
      client, board, ref,
      { body: 'Text.\n\nDepends on `acme/api#12`\n', expectVersion: V1 },
      { read },
    ).catch((e: Error) => e)

    expect(error).toBeInstanceOf(DependsOnDriftError)
    expect((error as Error).message).toContain('acme/api#12')
    expect((error as Error).message).toMatch(/item_link/)
    expect(client.graphql).not.toHaveBeenCalled()
  })

  it('refuses a body that drops the Depends on line for a linked ref, naming it', async () => {
    const client = { graphql: vi.fn() } as any
    const read = reader(
      detail({ body: 'Depends on `acme/web#9`\n', blockedBy: [blocker(9)] }),
    )

    const error = await updateItem(
      client, board, ref, { body: 'Rewritten, no prose.\n', expectVersion: V1 }, { read },
    ).catch((e: Error) => e)

    expect(error).toBeInstanceOf(DependsOnDriftError)
    expect((error as Error).message).toContain('acme/web#9')
    expect(client.graphql).not.toHaveBeenCalled()
  })

  it('names both sides when the body states one ref and the item is blocked by another', async () => {
    const client = { graphql: vi.fn() } as any
    const read = reader(detail({ blockedBy: [blocker(9)] }))

    const error = await updateItem(
      client, board, ref, { body: 'Depends on `acme/api#12`', expectVersion: V1 }, { read },
    ).catch((e: Error) => e)

    expect(error).toBeInstanceOf(DependsOnDriftError)
    expect((error as Error).message).toContain('acme/api#12')
    expect((error as Error).message).toContain('acme/web#9')
    expect((error as Error).message).toMatch(/item_link/)
    // A double-backtick span: a single one would end at the first inner backtick.
    expect((error as Error).message).toContain("the body's `` Depends on `owner/repo#N` `` lines")
  })

  it('names only the refs that differ when owner/repo case differs from the links', async () => {
    const client = { graphql: vi.fn() } as any
    const read = reader(detail({ blockedBy: [blocker(9), blocker(12, 'acme', 'api')] }))

    const error = await updateItem(
      client, board, ref, { body: 'Depends on `ACME/Web#9`\n', expectVersion: V1 }, { read },
    ).catch((e: Error) => e)

    expect(error).toBeInstanceOf(DependsOnDriftError)
    expect((error as Error).message).toContain('acme/api#12')
    expect((error as Error).message).not.toMatch(/web#9/i)
  })

  it('refuses a change that carries neither a title nor a body, before any read', async () => {
    const client = { graphql: vi.fn() } as any
    const read = reader(detail())

    await expect(updateItem(client, board, ref, { expectVersion: V1 }, { read })).rejects.toThrow(EmptyChangeError)
    expect(read).not.toHaveBeenCalled()
    expect(client.graphql).not.toHaveBeenCalled()
  })

  it('does not check Depends on lines for a title-only change', async () => {
    const read = reader(
      detail({ blockedBy: [blocker(9)] }),
      detail({ blockedBy: [blocker(9)], title: 'new' }),
    )
    const client = { graphql: vi.fn().mockResolvedValue({}) } as any

    const after = await updateItem(client, board, ref, { title: 'new', expectVersion: V1 }, { read })
    expect(after.title).toBe('new')
  })
})

describe('updateItem accepts a body whose Depends on set matches the links', () => {
  it('in a different order and owner/repo case', async () => {
    const body = 'Depends on `Acme/API#12`\nDepends on `ACME/web#9`\n'
    const blockedBy = [blocker(9), blocker(12, 'acme', 'api')]
    const read = reader(detail({ blockedBy }), detail({ blockedBy, body }))
    const client = { graphql: vi.fn().mockResolvedValue({}) } as any

    const after = await updateItem(client, board, ref, { body, expectVersion: V1 }, { read })
    expect(after.body).toBe(body)
    expect(client.graphql).toHaveBeenCalledTimes(1)
  })

  it('that adds the missing lines for an item whose old body had links but no prose', async () => {
    const old = 'Filed before prose sync.\n'
    const body = 'Filed before prose sync.\n\nDepends on `acme/web#9`\n'
    const blockedBy = [blocker(9)]
    const read = reader(detail({ body: old, blockedBy }), detail({ body, blockedBy }))
    const client = { graphql: vi.fn().mockResolvedValue({}) } as any

    const after = await updateItem(client, board, ref, { body, expectVersion: V1 }, { read })
    expect(after.body).toBe(body)
    expect(client.graphql).toHaveBeenCalledWith(UPDATE_ISSUE, { issue: 'I_1', body })
  })
})

describe('updateItem accepts a CRLF body', () => {
  it('reading its Depends on lines like any other', async () => {
    const body = 'Intro.\r\n\r\nDepends on `acme/web#9`\r\n'
    const blockedBy = [blocker(9)]
    const read = reader(detail({ blockedBy }), detail({ blockedBy, body }))
    const client = { graphql: vi.fn().mockResolvedValue({}) } as any

    const after = await updateItem(client, board, ref, { body, expectVersion: V1 }, { read })
    expect(after.body).toBe(body)
    expect(client.graphql).toHaveBeenCalledWith(UPDATE_ISSUE, { issue: 'I_1', body })
  })
})

describe('updateItem writes', () => {
  it('a title-only change sends { issue, title } with no body key', async () => {
    const read = reader(detail(), detail({ title: 'new title' }))
    const client = { graphql: vi.fn().mockResolvedValue({}) } as any

    await updateItem(client, board, ref, { title: 'new title', expectVersion: V1 }, { read })

    expect(client.graphql).toHaveBeenCalledTimes(1)
    const [document, variables] = client.graphql.mock.calls[0]
    expect(document).toBe(UPDATE_ISSUE)
    expect(variables).toEqual({ issue: 'I_1', title: 'new title' })
    expect('body' in variables).toBe(false)
  })

  it('sends title and body together when both change', async () => {
    const read = reader(detail(), detail({ title: 'T', body: 'B' }))
    const client = { graphql: vi.fn().mockResolvedValue({}) } as any

    await updateItem(client, board, ref, { title: 'T', body: 'B', expectVersion: V1 }, { read })

    expect(client.graphql).toHaveBeenCalledWith(UPDATE_ISSUE, { issue: 'I_1', title: 'T', body: 'B' })
  })

  it('sends no mutation when title and body are unchanged, and still returns the read-back', async () => {
    const before = detail({ body: 'same' })
    const readBack = detail({ body: 'same', status: 'In progress' })
    const read = reader(before, readBack)
    const client = { graphql: vi.fn() } as any

    const after = await updateItem(
      client, board, ref, { title: 'old title', body: 'same', expectVersion: V1 }, { read },
    )

    expect(client.graphql).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(2)
    expect(after).toBe(readBack)
  })

  it('says nothing was sent when an unchanged edit reads back different', async () => {
    const read = reader(detail(), detail({ title: 'moved on' }))
    const client = { graphql: vi.fn() } as any

    const error = await updateItem(
      client, board, ref, { title: 'old title', expectVersion: V1 }, { read },
    ).catch((e: Error) => e)

    expect(client.graphql).not.toHaveBeenCalled()
    expect(error).toBeInstanceOf(UnverifiedWriteError)
    expect((error as Error).message).toMatch(/was not sent/)
  })

  it('reads back the same ref it was asked to edit', async () => {
    const read = reader(detail(), detail({ title: 'new' }))
    const client = { graphql: vi.fn().mockResolvedValue({}) } as any

    await updateItem(client, board, ref, { title: 'new', expectVersion: V1 }, { read })
    expect(read.mock.calls).toEqual([[ref], [ref]])
  })

  it('raises UnverifiedWriteError with advice when the read-back title differs', async () => {
    const read = reader(detail(), detail({ title: 'someone else' }))
    const client = { graphql: vi.fn().mockResolvedValue({}) } as any

    const error = await updateItem(client, board, ref, { title: 'mine', expectVersion: V1 }, { read })
      .catch((e: Error) => e)

    expect(error).toBeInstanceOf(UnverifiedWriteError)
    expect((error as Error).message).toContain('mine')
    expect((error as Error).message).toContain('someone else')
    expect((error as Error).message).toMatch(/may or may not have landed/)
    expect((error as Error).message).toMatch(/item_get/)
  })

  it('raises UnverifiedWriteError without echoing either body when the read-back body differs', async () => {
    const read = reader(detail(), detail({ body: 'their secret draft' }))
    const client = { graphql: vi.fn().mockResolvedValue({}) } as any

    const error = await updateItem(client, board, ref, { body: 'my body', expectVersion: V1 }, { read })
      .catch((e: Error) => e)

    expect(error).toBeInstanceOf(UnverifiedWriteError)
    expect((error as Error).message).toContain('the requested body')
    expect((error as Error).message).toContain('a different body')
    expect((error as Error).message).not.toContain('their secret draft')
  })
})

describe('updateItem dry run', () => {
  it('sends nothing and returns the requested title and body', async () => {
    const read = reader(detail())
    const client = { graphql: vi.fn() } as any
    const body = '## Acceptance\n\n- [ ] it works\n'

    const result = await updateItem(
      client, board, ref, { title: 'T', body, expectVersion: V1 }, { dryRun: true, read },
    )

    expect(client.graphql).not.toHaveBeenCalled()
    expect(result.title).toBe('T')
    expect(result.body).toBe(body)
    expect(result.checklist).toEqual([{ text: 'it works', checked: false, heading: 'Acceptance' }])
  })

  it('keeps the current value of a field the change does not carry', async () => {
    const read = reader(detail({ body: 'kept' }))
    const client = { graphql: vi.fn() } as any

    const result = await updateItem(
      client, board, ref, { title: 'T', expectVersion: V1 }, { dryRun: true, read },
    )
    expect(result.body).toBe('kept')
  })

  it('still raises ConcurrentEditError on a stale version', async () => {
    const read = reader(detail({ version: V2 }))
    const client = { graphql: vi.fn() } as any

    await expect(
      updateItem(client, board, ref, { title: 'T', expectVersion: V1 }, { dryRun: true, read }),
    ).rejects.toThrow(ConcurrentEditError)
    expect(client.graphql).not.toHaveBeenCalled()
  })

  it('still raises NotOnBoardError and DependsOnDriftError', async () => {
    const client = { graphql: vi.fn() } as any

    await expect(
      updateItem(
        client, board, ref, { title: 'T', expectVersion: V1 },
        { dryRun: true, read: reader(detail({ projectItemId: null })) },
      ),
    ).rejects.toThrow(NotOnBoardError)
    await expect(
      updateItem(
        client, board, ref, { body: 'Depends on `acme/api#1`', expectVersion: V1 },
        { dryRun: true, read: reader(detail()) },
      ),
    ).rejects.toThrow(DependsOnDriftError)
    expect(client.graphql).not.toHaveBeenCalled()
  })
})
