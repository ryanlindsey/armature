import { describe, expect, it, vi } from 'vitest'
import { dispatch } from '../server/index.js'
import type { BoardProvider, BoardSnapshot } from '../server/providers/types.js'

const snapshot: BoardSnapshot = {
  id: 'PVT_1',
  statusFieldId: 'F_1',
  statusOptions: [
    { id: 'o1', name: 'Todo' },
    { id: 'o2', name: 'In progress' },
    { id: 'o3', name: 'Done' },
  ],
  semantics: { todo: 'Todo', claimed: 'In progress', review: null, done: 'Done' },
  items: [
    {
      ref: { owner: 'acme', repo: 'web', number: 5 },
      id: 'i5', title: 'Item 5', status: 'Todo', state: 'OPEN', parent: null,
    },
  ],
  repositories: ['acme/web'],
  collisions: {},
}

function makeProvider(overrides: Partial<BoardProvider> = {}): BoardProvider {
  return {
    survey: vi.fn().mockResolvedValue(snapshot),
    getItem: vi.fn(),
    claim: vi.fn(),
    setStatus: vi.fn(),
    create: vi.fn(),
    ...overrides,
  }
}

function textOf(result: { content: { type: 'text'; text: string }[] }): unknown {
  return JSON.parse(result.content[0]!.text)
}

describe('dispatch: item_create dry run', () => {
  it('omits ref and flags the response as a dry run rather than emitting owner/repo#0', async () => {
    const provider = makeProvider({
      create: vi.fn().mockResolvedValue({
        ref: { owner: 'acme', repo: 'web', number: 0 },
        id: '(dry-run)',
        title: 'A ticket',
        body: 'Body',
        state: 'OPEN',
        status: 'Todo',
        projectItemId: '(dry-run)',
        parent: null,
        epic: null,
      }),
    })

    const result = await dispatch(
      provider,
      'item_create',
      { repo: 'acme/web', title: 'A ticket', body: 'Body' },
      { dryRun: true, logWrite: () => {} },
    )

    const body = textOf(result) as Record<string, unknown>
    expect(body).not.toHaveProperty('ref')
    expect(body.dryRun).toBe(true)
    expect(body.title).toBe('A ticket')
    // The whole serialized response must never contain a plausible-looking fake reference.
    expect(JSON.stringify(body)).not.toMatch(/acme\/web#0\b/)
  })

  it('logs "(dry-run)" for ref rather than a fabricated owner/repo#0', async () => {
    const provider = makeProvider({
      create: vi.fn().mockResolvedValue({
        ref: { owner: 'acme', repo: 'web', number: 0 },
        id: '(dry-run)', title: 'A ticket', body: 'Body', state: 'OPEN',
        status: 'Todo', projectItemId: '(dry-run)', parent: null, epic: null,
      }),
    })
    const lines: string[] = []

    await dispatch(
      provider,
      'item_create',
      { repo: 'acme/web', title: 'A ticket', body: 'Body' },
      { dryRun: true, logWrite: (l) => lines.push(l) },
    )

    const entry = JSON.parse(lines[0]!)
    expect(entry.ref).toBe('(dry-run)')
    expect(entry.ref).not.toMatch(/#0\b/)
  })
})

describe('dispatch: item_create real run', () => {
  it('includes the real ref and logs its formatted reference', async () => {
    const provider = makeProvider({
      create: vi.fn().mockResolvedValue({
        ref: { owner: 'acme', repo: 'web', number: 42 },
        id: 'I_1', title: 'A ticket', body: 'Body', state: 'OPEN',
        status: 'Todo', projectItemId: 'PVTI_1', parent: null, epic: null,
      }),
    })
    const lines: string[] = []

    const result = await dispatch(
      provider,
      'item_create',
      { repo: 'acme/web', title: 'A ticket', body: 'Body' },
      { dryRun: false, logWrite: (l) => lines.push(l) },
    )

    const body = textOf(result) as Record<string, unknown>
    expect(body.ref).toEqual({ owner: 'acme', repo: 'web', number: 42 })
    expect(body.dryRun).toBeUndefined()
    expect(JSON.parse(lines[0]!).ref).toBe('acme/web#42')
  })

  it('rejects a malformed repo argument', async () => {
    const provider = makeProvider()
    await expect(
      dispatch(provider, 'item_create', { repo: 'not-owner-slash-name', title: 't', body: 'b' }, { dryRun: false }),
    ).rejects.toThrow(/owner\/name/)
  })
})

describe('dispatch: reads', () => {
  it('board_survey returns the provider survey', async () => {
    const provider = makeProvider()
    const result = await dispatch(provider, 'board_survey', {}, { dryRun: false })
    expect(textOf(result)).toEqual(snapshot)
  })

  it('board_next selects from the survey snapshot', async () => {
    const provider = makeProvider()
    const result = await dispatch(provider, 'board_next', {}, { dryRun: false })
    const body = textOf(result) as { kind: string; item?: { ref: unknown } }
    expect(body.kind).toBe('item')
    expect(body.item?.ref).toEqual({ owner: 'acme', repo: 'web', number: 5 })
  })

  it('item_get parses the ref and delegates to the provider', async () => {
    const getItem = vi.fn().mockResolvedValue({ ref: { owner: 'acme', repo: 'web', number: 5 }, title: 'x' })
    const provider = makeProvider({ getItem })
    await dispatch(provider, 'item_get', { ref: 'acme/web#5' }, { dryRun: false })
    expect(getItem).toHaveBeenCalledWith({ owner: 'acme', repo: 'web', number: 5 })
  })

  it('rejects an unknown tool name', async () => {
    const provider = makeProvider()
    await expect(dispatch(provider, 'gh_frobnicate', {}, { dryRun: false })).rejects.toThrow(/Unknown tool/)
  })
})

describe('dispatch: writes log the before/after status transition', () => {
  it('item_claim logs the status change', async () => {
    const getItem = vi.fn().mockResolvedValue({ ref: { owner: 'acme', repo: 'web', number: 5 }, status: 'Todo' })
    const claim = vi.fn().mockResolvedValue({ ref: { owner: 'acme', repo: 'web', number: 5 }, status: 'In progress' })
    const provider = makeProvider({ getItem, claim })
    const lines: string[] = []

    await dispatch(provider, 'item_claim', { ref: 'acme/web#5' }, { dryRun: false, logWrite: (l) => lines.push(l) })

    const entry = JSON.parse(lines[0]!)
    expect(entry).toMatchObject({ ref: 'acme/web#5', field: 'Status', before: 'Todo', after: 'In progress' })
  })

  it('item_status logs the requested status change', async () => {
    const getItem = vi.fn().mockResolvedValue({ ref: { owner: 'acme', repo: 'web', number: 5 }, status: 'Todo' })
    const setStatus = vi.fn().mockResolvedValue({ ref: { owner: 'acme', repo: 'web', number: 5 }, status: 'Done' })
    const provider = makeProvider({ getItem, setStatus })
    const lines: string[] = []

    await dispatch(
      provider,
      'item_status',
      { ref: 'acme/web#5', status: 'Done' },
      { dryRun: false, logWrite: (l) => lines.push(l) },
    )

    expect(setStatus).toHaveBeenCalledWith({ owner: 'acme', repo: 'web', number: 5 }, 'Done')
    const entry = JSON.parse(lines[0]!)
    expect(entry).toMatchObject({ ref: 'acme/web#5', field: 'Status', before: 'Todo', after: 'Done' })
  })
})
