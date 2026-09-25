import { describe, expect, it, vi } from 'vitest'
import {
  ChecklistUnsupportedError, dispatch, EpicUnsupportedError, InvalidArgumentError, makeRefResolver, TOOLS,
} from '../server/index.js'
import { AliasConflictError } from '../server/providers/github/aliases.js'
import type { SiblingConfigReader } from '../server/providers/github/aliases.js'
import type { BoardProvider, BoardSnapshot, EpicSurvey } from '../server/providers/types.js'
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
// and returned an orphan. What makes the argument safe to accept again is not that it is resolved
// — it was resolved before — but that the provider now attaches it and verifies the attachment.
// Everything below holds the boundary to the same standard as every other reference dispatch
// takes: resolved through the resolver, and refused as a bare number.
describe('dispatch: item_create resolves a parent and hands it to the provider', () => {
  it('passes the resolved reference through rather than the raw token', async () => {
    const create = vi.fn().mockResolvedValue({
      ref: { owner: 'acme', repo: 'web', number: 42 },
      id: 'I_1', title: 't', body: 'b', state: 'OPEN',
      status: 'Todo', projectItemId: 'PVTI_1',
      parent: { owner: 'acme', repo: 'platform', number: 9 },
      epic: { owner: 'acme', repo: 'platform', number: 9 },
    })
    const resolveRef = vi.fn().mockResolvedValue({ owner: 'acme', repo: 'platform', number: 9 })
    const provider = makeProvider({ create })

    await dispatch(
      provider,
      'item_create',
      { repo: 'acme/web', title: 't', body: 'b', parent: 'platform#9' },
      { dryRun: false, resolveRef, logWrite: () => {} },
    )

    expect(resolveRef).toHaveBeenCalledWith('platform#9')
    expect(create).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'web',
      title: 't',
      body: 'b',
      parent: { owner: 'acme', repo: 'platform', number: 9 },
    })
  })

  // The production incident, in the one argument that had been exempt from it: a JSON number is
  // the most natural way a model reproduces it, and `parent: 9` names a different epic in every
  // repository on the board.
  it('refuses a bare number parent with BareRefError and creates nothing', async () => {
    const create = vi.fn()
    const provider = makeProvider({ create })

    await expect(
      dispatch(
        provider,
        'item_create',
        { repo: 'acme/web', title: 't', body: 'b', parent: 9 },
        { dryRun: false, logWrite: () => {} },
      ),
    ).rejects.toThrow(BareRefError)

    expect(create).not.toHaveBeenCalled()
  })

  it('creates without a parent when none is asked for', async () => {
    const create = vi.fn().mockResolvedValue({
      ref: { owner: 'acme', repo: 'web', number: 42 },
      id: 'I_1', title: 't', body: 'b', state: 'OPEN',
      status: 'Todo', projectItemId: 'PVTI_1', parent: null, epic: null,
    })
    const resolveRef = vi.fn()
    const provider = makeProvider({ create })

    await dispatch(
      provider,
      'item_create',
      { repo: 'acme/web', title: 't', body: 'b' },
      { dryRun: false, resolveRef, logWrite: () => {} },
    )

    expect(resolveRef).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledWith({ owner: 'acme', repo: 'web', title: 't', body: 'b' })
  })

  // A dry run may now report an epic, which is the exact shape of the old lie — so what keeps it
  // honest is that the prediction comes from the provider, which is held to matching its own real
  // path. Dispatch's job is only to not invent a `ref` alongside it.
  it('reports the predicted epic in a dry run while still omitting the fake ref', async () => {
    const provider = makeProvider({
      create: vi.fn().mockResolvedValue({
        ref: { owner: 'acme', repo: 'web', number: 0 },
        id: '(dry-run)', title: 't', body: 'b', state: 'OPEN',
        status: 'Todo', projectItemId: '(dry-run)',
        parent: { owner: 'acme', repo: 'platform', number: 9 },
        epic: { owner: 'acme', repo: 'platform', number: 9 },
      }),
    })

    const result = await dispatch(
      provider,
      'item_create',
      { repo: 'acme/web', title: 't', body: 'b', parent: 'acme/platform#9' },
      { dryRun: true, logWrite: () => {} },
    )

    const body = textOf(result) as Record<string, unknown>
    expect(body).not.toHaveProperty('ref')
    expect(body.dryRun).toBe(true)
    expect(body.epic).toEqual({ owner: 'acme', repo: 'platform', number: 9 })
  })
})

describe('the declared tool surface', () => {
  it('offers a parent on item_create, described as a qualified reference', () => {
    const create = TOOLS.find((t) => t.name === 'item_create')!
    const parent = (create.inputSchema.properties as Record<string, { description?: string }>).parent
    expect(parent).toBeDefined()
    expect(parent!.description).toMatch(/owner\/repo#number/)
    // Optional: creating a standalone item is still the common case.
    expect(create.inputSchema.required).not.toContain('parent')
  })

  // The description is where a caller learns what the tool does. Leaving the old sentence in
  // place would advertise the absence of a capability the handler now delivers — the same
  // schema/handler divergence, pointing the other way.
  it('no longer says item_create cannot link a parent', () => {
    const create = TOOLS.find((t) => t.name === 'item_create')!
    expect(create.description).not.toMatch(/set the parent on the issue afterwards/i)
    expect(create.description).not.toMatch(/does not link/i)
  })

  // "Adds it to the board" was true before and is still true, but it was never the whole answer:
  // an item can be on the board and unreachable by board_next. The description is where a caller
  // finds out whether creating an item is enough to make it workable, so it has to say.
  it('says on item_create where the new item lands', () => {
    const create = TOOLS.find((t) => t.name === 'item_create')!
    expect(create.description).toMatch(/todo status/i)
  })
})

describe('epic_survey', () => {
  const survey: EpicSurvey = {
    epic: { ref: { owner: 'acme', repo: 'web', number: 10 }, title: 'Epic: ship it' },
    children: [],
    offBoard: [],
    next: { ref: null, because: 'Nothing is actionable.' },
  }
  const withEpic = () => makeProvider({ epic: vi.fn().mockResolvedValue(survey) })

  it('is advertised with exactly the argument the handler accepts', () => {
    const tool = TOOLS.find((t) => t.name === 'epic_survey')
    expect(tool).toBeDefined()
    expect(Object.keys(tool!.inputSchema.properties)).toEqual(['ref'])
    expect(tool!.inputSchema.required).toEqual(['ref'])
  })

  it('refuses a bare issue number', async () => {
    await expect(dispatch(withEpic(), 'epic_survey', { ref: 10 }, { dryRun: false })).rejects.toThrow(
      BareRefError,
    )
  })

  it('refuses a missing ref', async () => {
    await expect(dispatch(withEpic(), 'epic_survey', {}, { dryRun: false })).rejects.toThrow(
      InvalidArgumentError,
    )
  })

  it("returns the provider's survey unchanged, for the ref it was asked about", async () => {
    const provider = withEpic()
    const result = await dispatch(provider, 'epic_survey', { ref: 'acme/web#10' }, { dryRun: false })
    expect(provider.epic).toHaveBeenCalledWith({ owner: 'acme', repo: 'web', number: 10 })
    expect(textOf(result)).toEqual(survey)
  })

  it('reports by name when the provider has no epic support', async () => {
    const error = await dispatch(makeProvider(), 'epic_survey', { ref: 'acme/web#10' }, { dryRun: false })
      .catch((e: Error) => e)
    expect(error).toBeInstanceOf(EpicUnsupportedError)
    expect((error as Error).message).toMatch(/one at a time/)
  })

  // A malformed call is reported as malformed, not as unsupported.
  it('validates the argument before checking the capability', async () => {
    await expect(dispatch(makeProvider(), 'epic_survey', { ref: 10 }, { dryRun: false })).rejects.toThrow(
      BareRefError,
    )
  })

  it('writes no mutation log, because it writes nothing', async () => {
    const lines: string[] = []
    await dispatch(withEpic(), 'epic_survey', { ref: 'acme/web#10' }, {
      dryRun: false,
      logWrite: (l) => lines.push(l),
    })
    expect(lines).toEqual([])
  })
})

describe('dispatch: item_create takes a status and blockers', () => {
  const created = {
    ref: { owner: 'acme', repo: 'web', number: 42 }, id: 'I_1', title: 't', body: 'b',
    state: 'OPEN', status: 'In progress', projectItemId: 'PVTI_1',
    parent: null, epic: null, blockedBy: [{ owner: 'acme', repo: 'web', number: 5 }],
  }

  it('passes the status and each resolved blocker to the provider', async () => {
    const create = vi.fn().mockResolvedValue(created)
    const resolveRef = vi.fn(async (token: string) => parseRef(token))
    await dispatch(
      makeProvider({ create }), 'item_create',
      { repo: 'acme/web', title: 't', body: 'b', status: 'In progress', blockedBy: ['acme/web#5'] },
      { dryRun: false, resolveRef, logWrite: () => {} },
    )
    expect(resolveRef).toHaveBeenCalledWith('acme/web#5')
    expect(create).toHaveBeenCalledWith({
      owner: 'acme', repo: 'web', title: 't', body: 'b',
      status: 'In progress', blockedBy: [{ owner: 'acme', repo: 'web', number: 5 }],
    })
  })

  it('refuses a bare number inside blockedBy and creates nothing', async () => {
    const create = vi.fn()
    await expect(dispatch(
      makeProvider({ create }), 'item_create',
      { repo: 'acme/web', title: 't', body: 'b', blockedBy: [60] },
      { dryRun: false, logWrite: () => {} },
    )).rejects.toThrow(BareRefError)
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses a blockedBy that is not an array', async () => {
    await expect(dispatch(
      makeProvider(), 'item_create',
      { repo: 'acme/web', title: 't', body: 'b', blockedBy: 'acme/web#5' },
      { dryRun: false, logWrite: () => {} },
    )).rejects.toThrow(InvalidArgumentError)
  })

  it('refuses an empty status rather than treating it as the default', async () => {
    await expect(dispatch(
      makeProvider(), 'item_create',
      { repo: 'acme/web', title: 't', body: 'b', status: '' },
      { dryRun: false, logWrite: () => {} },
    )).rejects.toThrow(InvalidArgumentError)
  })

  it('omits both keys when neither is asked for', async () => {
    const create = vi.fn().mockResolvedValue(created)
    await dispatch(
      makeProvider({ create }), 'item_create', { repo: 'acme/web', title: 't', body: 'b' },
      { dryRun: false, logWrite: () => {} },
    )
    expect(create.mock.calls[0]![0]).not.toHaveProperty('status')
    expect(create.mock.calls[0]![0]).not.toHaveProperty('blockedBy')
  })

  it('advertises both, optional, and stops saying it always sets todo', () => {
    const tool = TOOLS.find((t) => t.name === 'item_create')!
    const props = tool.inputSchema.properties as Record<string, { type?: string; description?: string }>
    expect(props.status?.type).toBe('string')
    expect(props.blockedBy?.type).toBe('array')
    expect(props.blockedBy?.description).toMatch(/owner\/repo#number/)
    expect(tool.inputSchema.required).not.toContain('status')
    expect(tool.inputSchema.required).not.toContain('blockedBy')
    expect(tool.description).toMatch(/blocked/i)
    expect(tool.description).not.toMatch(/set it to the board's todo status, and/)
  })
})

describe('item_check', () => {
  const REF = { owner: 'acme', repo: 'web', number: 7 }
  const item = (first: boolean) => ({
    ref: REF, title: 'Item 7', status: 'In progress',
    checklist: [
      { text: 'first', checked: first, heading: 'Acceptance' },
      { text: 'second', checked: true, heading: 'Acceptance' },
    ],
  })
  const withCheck = () =>
    makeProvider({
      getItem: vi.fn().mockResolvedValue(item(false)),
      check: vi.fn().mockResolvedValue(item(true)),
    })
  const opts = { dryRun: false, logWrite: () => {} }
  const one = [{ text: 'first', checked: true }]

  it('is advertised with exactly the arguments the handler accepts', () => {
    const tool = TOOLS.find((t) => t.name === 'item_check')
    expect(tool).toBeDefined()
    expect(Object.keys(tool!.inputSchema.properties)).toEqual(['ref', 'entries'])
    expect(tool!.inputSchema.required).toEqual(['ref', 'entries'])
  })

  it('refuses a bare issue number', async () => {
    await expect(dispatch(withCheck(), 'item_check', { ref: 7, entries: one }, opts)).rejects.toThrow(BareRefError)
  })

  it('refuses a missing ref', async () => {
    await expect(dispatch(withCheck(), 'item_check', { entries: one }, opts)).rejects.toThrow(InvalidArgumentError)
  })

  it.each([
    ['entries that are not an array', 'first'],
    ['missing entries', undefined],
    ['an empty entries array', []],
    ['an element that is not an object', ['first']],
    ['a null element', [null]],
    ['an element missing checked', [{ text: 'a' }]],
    ['a non-boolean checked', [{ text: 'a', checked: 'yes' }]],
    ['an element missing text', [{ checked: true }]],
    ['a blank text', [{ text: '  ', checked: true }]],
  ])('refuses %s, and writes nothing', async (_label, entries) => {
    const provider = withCheck()
    await expect(
      dispatch(provider, 'item_check', { ref: 'acme/web#7', entries }, opts),
    ).rejects.toThrow(InvalidArgumentError)
    expect(provider.check).not.toHaveBeenCalled()
  })

  it('names the offending element by its index', async () => {
    await expect(
      dispatch(withCheck(), 'item_check', {
        ref: 'acme/web#7', entries: [{ text: 'a', checked: true }, { text: 'b', checked: 'yes' }],
      }, opts),
    ).rejects.toThrow(/entries\[1\]\.checked/)
  })

  it('tells the caller what to do when the provider cannot do checklists', async () => {
    const error = await dispatch(makeProvider(), 'item_check', { ref: 'acme/web#7', entries: one }, opts)
      .catch((e: Error) => e)
    expect((error as Error).message).toMatch(/instead/)
  })

  it('hands the provider the ref and only the text and state of each entry', async () => {
    const provider = withCheck()
    await dispatch(
      provider, 'item_check',
      { ref: 'acme/web#7', entries: [{ text: 'first', checked: true, heading: 'Acceptance' }] },
      opts,
    )
    expect(provider.check).toHaveBeenCalledWith(REF, [{ text: 'first', checked: true }])
  })

  it('returns what the provider read back', async () => {
    const result = await dispatch(withCheck(), 'item_check', { ref: 'acme/web#7', entries: one }, opts)
    expect(textOf(result)).toEqual(item(true))
  })

  it('logs one line carrying the before and after counts', async () => {
    const lines: string[] = []
    await dispatch(withCheck(), 'item_check', { ref: 'acme/web#7', entries: one }, {
      ...opts, logWrite: (l) => lines.push(l),
    })
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      ref: 'acme/web#7', field: 'Checklist', before: '1 of 2', after: '2 of 2', dryRun: false,
    })
  })

  it('reports by name when the provider cannot do checklists', async () => {
    const error = await dispatch(makeProvider(), 'item_check', { ref: 'acme/web#7', entries: one }, opts)
      .catch((e: Error) => e)
    expect(error).toBeInstanceOf(ChecklistUnsupportedError)
    expect((error as Error).message).toMatch(/Nothing was written/)
  })

  // A malformed call is reported as malformed, not as unsupported.
  it('validates the arguments before checking the capability', async () => {
    await expect(dispatch(makeProvider(), 'item_check', { ref: 7, entries: one }, opts)).rejects.toThrow(BareRefError)
    await expect(
      dispatch(makeProvider(), 'item_check', { ref: 'acme/web#7', entries: [] }, opts),
    ).rejects.toThrow(InvalidArgumentError)
  })

  it('marks a dry run, in the result and in the log line', async () => {
    const lines: string[] = []
    const result = await dispatch(withCheck(), 'item_check', { ref: 'acme/web#7', entries: one }, {
      dryRun: true, logWrite: (l) => lines.push(l),
    })
    expect((textOf(result) as Record<string, unknown>).dryRun).toBe(true)
    expect(JSON.parse(lines[0]!).dryRun).toBe(true)
  })

  it('leaves a real result unmarked', async () => {
    const result = await dispatch(withCheck(), 'item_check', { ref: 'acme/web#7', entries: one }, opts)
    expect((textOf(result) as Record<string, unknown>).dryRun).toBeUndefined()
  })
})
