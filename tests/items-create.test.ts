import { describe, expect, it, vi } from 'vitest'
import {
  createItem,
  MissingParentError,
  OrphanedIssueError,
  StatuslessItemError,
  UnlinkedItemError,
} from '../server/providers/github/items.js'
import { selectNext } from '../server/providers/github/next.js'
import type { WorkItemRef } from '../server/ref.js'

const board = { provider: 'github' as const, owner: 'acme', number: 1 }
const snapshot = {
  board: { provider: 'github', name: 'acme/1', source: 'repo' as const },
  id: 'PVT_1', statusFieldId: 'F_1',
  statusOptions: [{ id: 'o-todo', name: 'Todo' }],
  semantics: { todo: 'Todo', claimed: 'In progress', review: null, done: 'Done' },
  items: [], repositories: [], collisions: {},
}
const input = { owner: 'acme', repo: 'web', title: 'A ticket', body: 'Body' }
const epic: WorkItemRef = { owner: 'acme', repo: 'platform', number: 9 }

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
    // No parent was asked for, so none is predicted.
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
//
// The parent link is stored the same way and for the same reason. A fake that reported the epic
// attached regardless of what was sent would pass an implementation that issues no sub-issue
// mutation at all — which is exactly the bug the capability was removed for in v1.
// ---------------------------------------------------------------------------------------------
function fakeBoard(
  options: {
    failStatusWrite?: boolean
    /** Something else won the field: the write lands, the read-back shows another status. */
    statusWriteLandsAs?: string
    /** Replication lag: the board add succeeded, the issue's memberships do not show it yet. */
    unreadableMembership?: boolean
    /** The sub-issue mutation is refused. */
    failLink?: boolean
    /** The link write returns, but the read-back shows this parent instead of the one asked for. */
    linkLandsAs?: WorkItemRef | null
    /** The parent issue does not resolve to a node — a wrong reference, or no access. */
    parentMissing?: boolean
  } = {},
) {
  let status: string | null = null
  let parent: WorkItemRef | null = null

  /** Which documents were sent, in order, so a test can assert what ran before what. */
  const sent: string[] = []
  /** The variables the sub-issue mutation was called with — the link's direction lives here. */
  let linkVariables: Record<string, string> | null = null

  const client = {
    graphql: vi.fn(async (query: string, variables: Record<string, string>) => {
      if (query.includes('createIssue')) {
        sent.push('createIssue')
        return { createIssue: { issue: { id: 'I_1', number: 42 } } }
      }
      if (query.includes('addProjectV2ItemById')) {
        sent.push('addToBoard')
        return { addProjectV2ItemById: { item: { id: 'PVTI_1' } } }
      }
      if (query.includes('updateProjectV2ItemFieldValue')) {
        sent.push('setStatus')
        if (options.failStatusWrite) throw new Error('status write failed')
        status =
          options.statusWriteLandsAs ??
          snapshot.statusOptions.find((o) => o.id === variables.option)?.name ??
          null
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } }
      }
      if (query.includes('addSubIssue')) {
        sent.push('addSubIssue')
        linkVariables = variables
        if (options.failLink) throw new Error('link failed')
        parent = options.linkLandsAs !== undefined ? options.linkLandsAs : epic
        return { addSubIssue: { subIssue: { id: 'I_1' } } }
      }
      if (query.includes('issue(number:$number){ id }')) {
        sent.push('parentNodeId')
        return { repository: { issue: options.parentMissing ? null : { id: 'I_epic' } } }
      }
      sent.push('repoNodeId')
      return { repository: { id: 'R_1' } }
    }),
  } as any

  const read = async (ref: WorkItemRef) => ({
    ref,
    id: 'I_1',
    title: input.title,
    body: input.body,
    state: 'OPEN' as const,
    status,
    projectItemId: options.unreadableMembership ? null : 'PVTI_1',
    parent,
    epic: parent,
  })

  return { client, read, sent, linkVariables: () => linkVariables }
}

describe('createItem lands the item where work is found', () => {
  it('is returned by the same selector board_next uses, with no second call', async () => {
    const { client, read } = fakeBoard()

    const created = await createItem(client, board, snapshot, input, { read })

    // Selected from a re-read of the board, not from the object the tool handed back. Asserting
    // on `created` is what makes this test miss: a createItem that performs no status write and
    // returns `{ ...read(ref), status: todo }` passes it, which is the exact bug wearing the
    // right answer as a hat. Verified by writing that implementation and watching this fail.
    const onBoard = await read(created.ref)

    const next = selectNext({ ...snapshot, items: [onBoard] }, {})
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

  // The status is exactly what is in doubt when this error is thrown, so the message may not
  // settle it. Reporting "the item has no status" after a read-back that showed a status is the
  // same class of error the tool is being fixed for: stating an effect nobody observed.
  it('does not claim to know the status it just failed to confirm', async () => {
    const { client, read } = fakeBoard({ statusWriteLandsAs: 'In progress' })

    const err = await createItem(client, board, snapshot, input, { read }).catch((e: Error) => e)

    expect(err).toBeInstanceOf(StatuslessItemError)
    // The read-back saw "In progress". Whatever the message says, it cannot say there is none.
    expect((err as Error).message).not.toMatch(/with no status/i)
    expect((err as Error).message).toContain('In progress')
  })

  // The lag path. `createItem` now hands setStatus the id the board add returned, so the
  // issue-rooted read that reports a just-added item as absent is out of the write path. If it
  // ever comes back, this fails: telling someone to add an item that is already on the board
  // sends them after a repair they do not need, which is what StatuslessItemError exists to stop.
  it('never advises adding an item the board add already placed', async () => {
    const { client, read } = fakeBoard({ failStatusWrite: true, unreadableMembership: true })

    const err = await createItem(client, board, snapshot, input, { read }).catch((e: Error) => e)

    expect(err).toBeInstanceOf(StatuslessItemError)
    expect((err as Error).message).not.toMatch(/add it (deliberately|to the board)/i)
  })
})

// ---------------------------------------------------------------------------------------------
// Linking the new issue to its epic (ryanlindsey/armature#47).
//
// v1 accepted a `parent`, resolved it, and discarded it. What replaces that is not "send the
// mutation" but "send it and prove it landed", in the same shape as every other write here.
// ---------------------------------------------------------------------------------------------
describe('createItem links the new issue to its parent epic', () => {
  it('reports the parent the read-back shows, not the one it was asked for', async () => {
    const { client, read } = fakeBoard()

    const created = await createItem(client, board, snapshot, { ...input, parent: epic }, { read })

    expect(created.parent).toEqual(epic)
    expect(created.epic).toEqual(epic)
  })

  // Direction is the whole mutation. `addSubIssue` takes the *parent* as `issueId` and the child
  // as `subIssueId`, so swapping them does not fail — it silently files the epic underneath the
  // ticket that was just created, inverting the hierarchy board_next ranks by.
  it('sends the epic as the parent and the new issue as the sub-issue, not the reverse', async () => {
    const fake = fakeBoard()

    await createItem(fake.client, board, snapshot, { ...input, parent: epic }, { read: fake.read })

    expect(fake.linkVariables()).toEqual({ parent: 'I_epic', child: 'I_1' })
  })

  it('issues no sub-issue mutation when no parent is asked for', async () => {
    const fake = fakeBoard()

    await createItem(fake.client, board, snapshot, input, { read: fake.read })

    expect(fake.sent).not.toContain('addSubIssue')
  })

  // The link is the last of the four writes, so it must not run until the three before it have
  // landed — an item linked to an epic but absent from the board is a worse half-landing than an
  // unlinked one, and harder to spot.
  it('links only after the issue is created, added to the board and given a status', async () => {
    const fake = fakeBoard()

    await createItem(fake.client, board, snapshot, { ...input, parent: epic }, { read: fake.read })

    expect(fake.sent.filter((s) => s !== 'repoNodeId' && s !== 'parentNodeId')).toEqual([
      'createIssue',
      'addToBoard',
      'setStatus',
      'addSubIssue',
    ])
  })
})

describe('createItem refuses a parent it cannot resolve, before creating anything', () => {
  // A mistyped epic is the likeliest way this argument goes wrong, and it is knowable before any
  // write. Discovering it after CREATE_ISSUE would leave a real issue behind for a typo.
  it('creates no issue when the parent does not resolve', async () => {
    const fake = fakeBoard({ parentMissing: true })

    const err = await createItem(
      fake.client, board, snapshot, { ...input, parent: epic }, { read: fake.read },
    ).catch((e: Error) => e)

    expect(err).toBeInstanceOf(MissingParentError)
    expect(fake.sent).not.toContain('createIssue')
  })

  it('names the parent it could not find and says nothing was created', async () => {
    const fake = fakeBoard({ parentMissing: true })

    const err = await createItem(
      fake.client, board, snapshot, { ...input, parent: epic }, { read: fake.read },
    ).catch((e: Error) => e)

    expect((err as Error).message).toContain('acme/platform#9')
    expect((err as Error).message).toMatch(/nothing was created/i)
  })
})

// The fourth end state. The item is real, on the board, and in the todo status — a caller can
// work it. Only its epic is missing, and only this error says so; reusing either of the other two
// would send the reader after a repair they do not need.
describe('createItem reports an unlinked item when the link is the part that fails', () => {
  it('raises UnlinkedItemError when the sub-issue mutation is refused', async () => {
    const { client, read } = fakeBoard({ failLink: true })

    const err = await createItem(
      client, board, snapshot, { ...input, parent: epic }, { read },
    ).catch((e: Error) => e)

    expect(err).toBeInstanceOf(UnlinkedItemError)
    expect(err).not.toBeInstanceOf(OrphanedIssueError)
    expect(err).not.toBeInstanceOf(StatuslessItemError)
    expect((err as Error).message).toContain('link failed')
  })

  // A mutation that returns is not a link that landed. This is the half-effect the v1 removal
  // existed to prevent, moved one step later: reporting the epic attached because the write was
  // sent, not because the board shows it.
  it('raises UnlinkedItemError when the read-back shows no parent', async () => {
    const { client, read } = fakeBoard({ linkLandsAs: null })

    const err = await createItem(
      client, board, snapshot, { ...input, parent: epic }, { read },
    ).catch((e: Error) => e)

    expect(err).toBeInstanceOf(UnlinkedItemError)
  })

  it('raises UnlinkedItemError when the read-back shows a different parent', async () => {
    const other = { owner: 'acme', repo: 'platform', number: 11 }
    const { client, read } = fakeBoard({ linkLandsAs: other })

    const err = await createItem(
      client, board, snapshot, { ...input, parent: epic }, { read },
    ).catch((e: Error) => e)

    expect(err).toBeInstanceOf(UnlinkedItemError)
    expect((err as Error).message).toContain('acme/platform#11')
  })

  // The item is workable. A message that told the reader to add it to the board or set its
  // status would describe a board it is not in.
  it('says the item is real and on the board, and points only at the missing link', async () => {
    const { client, read } = fakeBoard({ failLink: true })

    const err = await createItem(
      client, board, snapshot, { ...input, parent: epic }, { read },
    ).catch((e: Error) => e)

    const message = (err as Error).message
    expect(message).toContain('acme/web#42')
    expect(message).toContain('acme/platform#9')
    expect(message).not.toMatch(/add it (deliberately|to the board)/i)
    expect(message).not.toMatch(/item_status/)
  })
})

// The recurring bug in this file's history, in its newest place. `follow-ups.md` records that the
// dry-run branch has been wrong in both directions — overstating the parent once, understating
// the status later — so the prediction is compared against the real path rather than eyeballed.
describe('the dry-run prediction matches what the real path does with a parent', () => {
  it('predicts the parent and epic the real path actually produces', async () => {
    const { client, read } = fakeBoard()
    const withParent = { ...input, parent: epic }

    const predicted = await createItem(client, board, snapshot, withParent, { dryRun: true, read })
    const actual = await createItem(client, board, snapshot, withParent, { read })

    expect(predicted.parent).toEqual(actual.parent)
    expect(predicted.epic).toEqual(actual.epic)
    expect(predicted.status).toEqual(actual.status)
  })

  it('writes nothing when a parent is asked for under dry run', async () => {
    const fake = fakeBoard()

    await createItem(
      fake.client, board, snapshot, { ...input, parent: epic }, { dryRun: true, read: fake.read },
    )

    expect(fake.client.graphql).not.toHaveBeenCalled()
  })
})
