import { describe, expect, it, vi } from 'vitest'
import { dispatch, InvalidArgumentError, makeRefResolver, TOOLS } from '../server/index.js'
import { AliasConflictError } from '../server/providers/github/aliases.js'
import type { SiblingConfigReader } from '../server/providers/github/aliases.js'
import type { BoardProvider, BoardSnapshot } from '../server/providers/types.js'
import { BareRefError, parseRef } from '../server/ref.js'

const snapshot: BoardSnapshot = {
  board: { provider: 'github', name: 'acme/1', source: 'repo' },
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

// A dry run's result describes an intended effect that was never written. Returned unmarked it is
// indistinguishable from a real write, and a mutation log line asserting a transition that never
// happened is worse than no line at all — the log is the forensic record. item_create already
// disclosed this; every mutating tool must.
describe('dispatch: dry runs disclose themselves', () => {
  function claimingProvider() {
    const getItem = vi.fn().mockResolvedValue({ ref: { owner: 'acme', repo: 'web', number: 5 }, status: 'Todo' })
    const claim = vi.fn().mockResolvedValue({ ref: { owner: 'acme', repo: 'web', number: 5 }, status: 'In progress' })
    const setStatus = vi.fn().mockResolvedValue({ ref: { owner: 'acme', repo: 'web', number: 5 }, status: 'Done' })
    return makeProvider({ getItem, claim, setStatus })
  }

  it('marks a dry-run item_claim result', async () => {
    const result = await dispatch(claimingProvider(), 'item_claim', { ref: 'acme/web#5' }, {
      dryRun: true, logWrite: () => {},
    })
    expect((textOf(result) as Record<string, unknown>).dryRun).toBe(true)
  })

  it('marks a dry-run item_status result', async () => {
    const result = await dispatch(claimingProvider(), 'item_status', { ref: 'acme/web#5', status: 'Done' }, {
      dryRun: true, logWrite: () => {},
    })
    expect((textOf(result) as Record<string, unknown>).dryRun).toBe(true)
  })

  it('leaves a real item_claim result unmarked', async () => {
    const result = await dispatch(claimingProvider(), 'item_claim', { ref: 'acme/web#5' }, {
      dryRun: false, logWrite: () => {},
    })
    expect((textOf(result) as Record<string, unknown>).dryRun).toBeUndefined()
  })

  it('marks the mutation log line of a dry-run claim, so the record never asserts a transition that did not happen', async () => {
    const lines: string[] = []
    await dispatch(claimingProvider(), 'item_claim', { ref: 'acme/web#5' }, {
      dryRun: true, logWrite: (l) => lines.push(l),
    })
    expect(JSON.parse(lines[0]!).dryRun).toBe(true)
  })

  it('marks the mutation log line of a dry-run status change', async () => {
    const lines: string[] = []
    await dispatch(claimingProvider(), 'item_status', { ref: 'acme/web#5', status: 'Done' }, {
      dryRun: true, logWrite: (l) => lines.push(l),
    })
    expect(JSON.parse(lines[0]!).dryRun).toBe(true)
  })

  it('marks a real write as not a dry run, so a reader never has to infer it from an absent field', async () => {
    const lines: string[] = []
    await dispatch(claimingProvider(), 'item_claim', { ref: 'acme/web#5' }, {
      dryRun: false, logWrite: (l) => lines.push(l),
    })
    expect(JSON.parse(lines[0]!).dryRun).toBe(false)
  })

  it('marks a dry-run creation log line as well as its "(dry-run)" ref', async () => {
    const provider = makeProvider({
      create: vi.fn().mockResolvedValue({
        ref: { owner: 'acme', repo: 'web', number: 0 },
        id: '(dry-run)', title: 'A ticket', body: 'Body', state: 'OPEN',
        status: 'Todo', projectItemId: '(dry-run)', parent: null, epic: null,
      }),
    })
    const lines: string[] = []
    await dispatch(provider, 'item_create', { repo: 'acme/web', title: 'A ticket', body: 'Body' }, {
      dryRun: true, logWrite: (l) => lines.push(l),
    })
    expect(JSON.parse(lines[0]!).dryRun).toBe(true)
  })
})

// The low-level SDK Server performs no inputSchema validation, so whatever JSON a caller sends
// arrives untouched. `ref: 278` — a JSON number, the most natural way a model reproduces the
// original incident — used to reach parseRef and die as "input.trim is not a function", so the
// carefully written BareRefError never fired for the one case it was written for.
describe('dispatch: arguments are validated at the boundary', () => {
  it('reads a JSON number in `ref` as the bare number it is', async () => {
    const provider = makeProvider({ getItem: vi.fn() })
    await expect(dispatch(provider, 'item_get', { ref: 278 }, { dryRun: false })).rejects.toThrow(
      BareRefError,
    )
  })

  it('reads a JSON number in `epic` as a bare number too', async () => {
    const provider = makeProvider()
    await expect(dispatch(provider, 'board_next', { epic: 9 }, { dryRun: false })).rejects.toThrow(
      BareRefError,
    )
  })

  it('names the missing argument instead of failing inside the parser', async () => {
    const provider = makeProvider({ getItem: vi.fn() })
    const error = await dispatch(provider, 'item_get', {}, { dryRun: false }).catch((e: Error) => e)

    expect(error).toBeInstanceOf(InvalidArgumentError)
    expect((error as Error).message).toContain('ref')
    expect((error as Error).message).not.toMatch(/is not a function/)
  })

  it('refuses a null ref', async () => {
    const getItem = vi.fn()
    const provider = makeProvider({ getItem })
    await expect(
      dispatch(provider, 'item_claim', { ref: null }, { dryRun: false, logWrite: () => {} }),
    ).rejects.toThrow(InvalidArgumentError)
    expect(getItem).not.toHaveBeenCalled()
  })

  it('refuses item_create with no title rather than creating an untitled issue', async () => {
    const create = vi.fn()
    const provider = makeProvider({ create })
    await expect(
      dispatch(provider, 'item_create', { repo: 'acme/web', body: 'b' }, { dryRun: false, logWrite: () => {} }),
    ).rejects.toThrow(InvalidArgumentError)
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses an empty title', async () => {
    const create = vi.fn()
    const provider = makeProvider({ create })
    await expect(
      dispatch(provider, 'item_create', { repo: 'acme/web', title: '  ', body: 'b' }, {
        dryRun: false, logWrite: () => {},
      }),
    ).rejects.toThrow(InvalidArgumentError)
    expect(create).not.toHaveBeenCalled()
  })

  it('allows an empty body, which is a legitimate issue', async () => {
    const create = vi.fn().mockResolvedValue({
      ref: { owner: 'acme', repo: 'web', number: 42 },
      id: 'I_1', title: 't', body: '', state: 'OPEN',
      status: null, projectItemId: 'PVTI_1', parent: null, epic: null,
    })
    const provider = makeProvider({ create })
    await dispatch(provider, 'item_create', { repo: 'acme/web', title: 't', body: '' }, {
      dryRun: false, logWrite: () => {},
    })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ body: '' }))
  })

  it('refuses a non-string status', async () => {
    const setStatus = vi.fn()
    const provider = makeProvider({ getItem: vi.fn(), setStatus })
    await expect(
      dispatch(provider, 'item_status', { ref: 'acme/web#5', status: 3 }, {
        dryRun: false, logWrite: () => {},
      }),
    ).rejects.toThrow(InvalidArgumentError)
    expect(setStatus).not.toHaveBeenCalled()
  })

  it('refuses a non-string repo filter', async () => {
    const provider = makeProvider()
    await expect(dispatch(provider, 'board_next', { repo: 7 }, { dryRun: false })).rejects.toThrow(
      InvalidArgumentError,
    )
  })

  it('refuses a repo with more than one slash rather than silently truncating it', async () => {
    const create = vi.fn()
    const provider = makeProvider({ create })
    await expect(
      dispatch(provider, 'item_create', { repo: 'acme/web/extra', title: 't', body: 'b' }, {
        dryRun: false, logWrite: () => {},
      }),
    ).rejects.toThrow(/owner\/name/)
    expect(create).not.toHaveBeenCalled()
  })

  // An empty string is what a model passes for an optional string it has nothing to say about.
  // It used to be silently dropped, so board_next answered about the whole board while the
  // caller believed it had asked about one repository.
  it('passes an empty repo filter through, so it is answered rather than ignored', async () => {
    const provider = makeProvider()
    const result = await dispatch(provider, 'board_next', { repo: '' }, { dryRun: false })
    const body = textOf(result) as { kind: string }
    expect(body.kind).toBe('blocked')
  })

  it('refuses an empty epic filter rather than answering about the whole board', async () => {
    const provider = makeProvider()
    await expect(dispatch(provider, 'board_next', { epic: '' }, { dryRun: false })).rejects.toThrow(
      BareRefError,
    )
  })
})

describe('makeRefResolver', () => {
  const snapshotWithSiblings: BoardSnapshot = {
    ...snapshot,
    repositories: ['acme/web', 'acme/site.example'],
  }

  function siblingReader(configs: Record<string, { alias?: string } | null>): SiblingConfigReader {
    return async (owner, repo) => configs[`${owner}/${repo}`] ?? null
  }

  it('resolves an already-qualified ref without reading any sibling config', async () => {
    const read = vi.fn().mockResolvedValue(null)
    const provider = makeProvider()
    const resolveRef = makeRefResolver(provider, read)

    await expect(resolveRef('acme/web#5')).resolves.toEqual({ owner: 'acme', repo: 'web', number: 5 })
    expect(read).not.toHaveBeenCalled()
    expect(provider.survey).not.toHaveBeenCalled()
  })

  it("expands a known alias by building the map from the board's repositories", async () => {
    const provider = makeProvider({ survey: vi.fn().mockResolvedValue(snapshotWithSiblings) })
    const read = vi.fn(
      siblingReader({ 'acme/site.example': { alias: 'site' }, 'acme/web': null }),
    )
    const resolveRef = makeRefResolver(provider, read)

    await expect(resolveRef('site#272')).resolves.toEqual({
      owner: 'acme',
      repo: 'site.example',
      number: 272,
    })
  })

  it('builds the alias map at most once, on first use, and never for a qualified ref', async () => {
    const provider = makeProvider({ survey: vi.fn().mockResolvedValue(snapshotWithSiblings) })
    const read = vi.fn(siblingReader({ 'acme/site.example': { alias: 'site' } }))
    const resolveRef = makeRefResolver(provider, read)

    await resolveRef('site#272')
    await resolveRef('site#900')
    await resolveRef('acme/web#1')

    expect(provider.survey).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(2) // once per repository on the board, not per call
  })

  it('never builds the map for a bare number, and still refuses it', async () => {
    const provider = makeProvider({ survey: vi.fn().mockResolvedValue(snapshotWithSiblings) })
    const read = vi.fn().mockResolvedValue(null)
    const resolveRef = makeRefResolver(provider, read)

    await expect(resolveRef('278')).rejects.toThrow(BareRefError)
    await expect(resolveRef('#278')).rejects.toThrow(BareRefError)
    expect(provider.survey).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it('fails loud, naming the known aliases, when the alias is unrecognised', async () => {
    const provider = makeProvider({ survey: vi.fn().mockResolvedValue(snapshotWithSiblings) })
    const read = vi.fn(
      siblingReader({ 'acme/site.example': { alias: 'site' }, 'acme/web': { alias: 'api' } }),
    )
    const resolveRef = makeRefResolver(provider, read)

    await expect(resolveRef('tools#293')).rejects.toThrow(/tools/)
    await expect(resolveRef('tools#293')).rejects.toThrow(/site/)
    await expect(resolveRef('tools#293')).rejects.toThrow(/api/)
  })

  it('says plainly that no repository declares an alias when the map is empty', async () => {
    const provider = makeProvider({ survey: vi.fn().mockResolvedValue(snapshotWithSiblings) })
    const read = vi.fn().mockResolvedValue(null)
    const resolveRef = makeRefResolver(provider, read)

    await expect(resolveRef('tools#293')).rejects.toThrow(/no repository/i)
  })

  it('propagates a conflicting alias declaration as AliasConflictError', async () => {
    const provider = makeProvider({ survey: vi.fn().mockResolvedValue(snapshotWithSiblings) })
    const read = vi.fn(
      siblingReader({ 'acme/site.example': { alias: 'site' }, 'acme/web': { alias: 'site' } }),
    )
    const resolveRef = makeRefResolver(provider, read)

    await expect(resolveRef('site#272')).rejects.toThrow(AliasConflictError)
  })

  it('retries a failed map build on the next lookup rather than replaying the stale rejection', async () => {
    const provider = makeProvider({ survey: vi.fn().mockResolvedValue(snapshotWithSiblings) })
    let shouldFail = true
    const read = vi.fn(async (owner: string, repo: string) => {
      if (shouldFail) throw new Error('transient network error')
      return siblingReader({ 'acme/site.example': { alias: 'site' } })(owner, repo)
    })
    const resolveRef = makeRefResolver(provider, read)

    await expect(resolveRef('site#272')).rejects.toThrow('transient network error')

    shouldFail = false
    await expect(resolveRef('site#272')).resolves.toEqual({
      owner: 'acme',
      repo: 'site.example',
      number: 272,
    })
  })
})

describe('dispatch: ref resolution', () => {
  it('uses parseRef alone when no resolver is supplied, so an alias token is still refused', async () => {
    const provider = makeProvider()
    await expect(
      dispatch(provider, 'item_get', { ref: 'site#272' }, { dryRun: false }),
    ).rejects.toThrow(BareRefError)
  })

  it('retries item_get through the injected resolver', async () => {
    const resolveRef = vi.fn(async (token: string) =>
      token === 'site#272' ? { owner: 'acme', repo: 'site.example', number: 272 } : parseRef(token),
    )
    const getItem = vi.fn().mockResolvedValue({
      ref: { owner: 'acme', repo: 'site.example', number: 272 },
      status: 'Todo',
    })
    const provider = makeProvider({ getItem })

    await dispatch(provider, 'item_get', { ref: 'site#272' }, { dryRun: false, resolveRef })

    expect(getItem).toHaveBeenCalledWith({ owner: 'acme', repo: 'site.example', number: 272 })
  })

  it("resolves board_next's epic through the injected resolver", async () => {
    const resolveRef = vi.fn().mockResolvedValue({ owner: 'acme', repo: 'site.example', number: 9 })
    const provider = makeProvider()

    await dispatch(provider, 'board_next', { epic: 'site#9' }, { dryRun: false, resolveRef })

    expect(resolveRef).toHaveBeenCalledWith('site#9')
  })

})

// item_create used to accept a `parent`, resolve it, and then discard it: the dry run reported
// the epic attached and a Todo status, while the real path issued no sub-issue mutation at all
// and returned an orphan. The capability was never real, so it is gone rather than implemented —
// and a caller who passes `parent` must be told, not quietly ignored.
describe('dispatch: item_create refuses a parent rather than discarding it', () => {
  it('fails loud, creates nothing, and says the parent must be set afterwards', async () => {
    const create = vi.fn()
    const resolveRef = vi.fn()
    const provider = makeProvider({ create })

    await expect(
      dispatch(
        provider,
        'item_create',
        { repo: 'acme/web', title: 't', body: 'b', parent: 'acme/platform#9' },
        { dryRun: false, resolveRef, logWrite: () => {} },
      ),
    ).rejects.toThrow(/parent/i)

    expect(create).not.toHaveBeenCalled()
    expect(resolveRef).not.toHaveBeenCalled()
  })

  it('names sub-issue linking as unsupported and states that nothing was created', async () => {
    const provider = makeProvider()
    const error = await dispatch(
      provider,
      'item_create',
      { repo: 'acme/web', title: 't', body: 'b', parent: 'acme/platform#9' },
      { dryRun: false, logWrite: () => {} },
    ).catch((e: Error) => e)

    expect((error as Error).message).toMatch(/sub-issue/i)
    expect((error as Error).message).toMatch(/nothing was created/i)
  })

  it('refuses in a dry run too, rather than reporting an attachment it could not make', async () => {
    const create = vi.fn()
    const provider = makeProvider({ create })

    await expect(
      dispatch(
        provider,
        'item_create',
        { repo: 'acme/web', title: 't', body: 'b', parent: 'acme/platform#9' },
        { dryRun: true, logWrite: () => {} },
      ),
    ).rejects.toThrow(/parent/i)
    expect(create).not.toHaveBeenCalled()
  })
})

describe('the declared tool surface', () => {
  it('does not offer a parent on item_create', () => {
    const create = TOOLS.find((t) => t.name === 'item_create')!
    expect(Object.keys(create.inputSchema.properties)).not.toContain('parent')
    expect(JSON.stringify(create.inputSchema)).not.toMatch(/parent/i)
    // The description still mentions the parent, so a caller learns what to do instead.
    expect(create.description).toMatch(/set the parent on the issue afterwards/i)
  })

  // "Adds it to the board" was true before and is still true, but it was never the whole answer:
  // an item can be on the board and unreachable by board_next. The description is where a caller
  // finds out whether creating an item is enough to make it workable, so it has to say.
  it('says on item_create where the new item lands', () => {
    const create = TOOLS.find((t) => t.name === 'item_create')!
    expect(create.description).toMatch(/todo status/i)
  })
})
