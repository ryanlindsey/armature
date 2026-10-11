import { describe, expect, it, vi } from 'vitest'
import { parseChecklist } from '../server/providers/github/checklist.js'
import { GraphQLError } from '../server/providers/github/client.js'
import { UnclosedFenceError } from '../server/providers/github/depends.js'
import {
  ADD_BLOCKED_BY,
  ConflictingLinkError,
  type ItemDetail,
  linkItem,
  MissingLinkTargetError,
  NotOnBoardError,
  ISSUE_IDENTITY,
  PartialLinkError,
  ProseOutOfStepError,
  REMOVE_BLOCKED_BY,
  REMOVE_SUB_ISSUE,
  SET_PARENT,
  UPDATE_ISSUE_BODY,
} from '../server/providers/github/items.js'
import type { WorkItemRef } from '../server/ref.js'

const board = { provider: 'github' as const, owner: 'acme', number: 1 }
const ref = { owner: 'acme', repo: 'web', number: 278 }
const r = (number: number, owner = 'acme', repo = 'web'): WorkItemRef => ({ owner, repo, number })
const line = (x: WorkItemRef) => `Depends on \`${x.owner}/${x.repo}#${x.number}\``

function detail(overrides: Partial<ItemDetail> = {}): ItemDetail {
  const body = overrides.body ?? 'Intro.\n'
  return {
    ref, id: 'I_item', title: 't', body, state: 'OPEN',
    checklist: parseChecklist(body), status: 'Todo', projectItemId: 'PVTI_1',
    parent: null, epic: null, blockedBy: [], version: 'v1',
    ...overrides,
  }
}

/** A reader that answers each call with the next detail, repeating the last. */
function reader(...reads: ItemDetail[]) {
  let call = 0
  return vi.fn(async () => reads[Math.min(call++, reads.length - 1)]!)
}

/**
 * A client that resolves node ids for the issues it is told exist (NOT_FOUND otherwise, as GitHub
 * answers) and records every other document as a mutation. `refuse` makes a mutation throw.
 */
function fakeClient(existing: number[], refuse: string[] = []) {
  const mutations: { doc: string; vars: any }[] = []
  const graphql = vi.fn(async (doc: string, vars: any) => {
    if (doc === ISSUE_IDENTITY) {
      // GitHub answers in its own spelling, whatever the caller typed.
      if (vars.owner.toLowerCase() === 'acme' && vars.name.toLowerCase() === 'web' && existing.includes(vars.number)) {
        return {
          repository: {
            issue: { id: `I_${vars.number}`, number: vars.number, repository: { owner: { login: 'acme' }, name: 'web' } },
          },
        }
      }
      throw new GraphQLError('Could not resolve to an Issue', ['NOT_FOUND'])
    }
    mutations.push({ doc, vars })
    if (refuse.includes(doc)) throw new Error('refused by GitHub')
    return {}
  })
  return { client: { graphql } as any, mutations }
}

const docs = (mutations: { doc: string }[]) => mutations.map((m) => m.doc)

describe('linkItem: blockers', () => {
  it('adds a blocker, then writes its canonical line, and reports it added', async () => {
    const { client, mutations } = fakeClient([3])
    const before = detail()
    const mid = detail({ blockedBy: [r(3)] })
    const after = detail({ blockedBy: [r(3)], body: `Intro.\n\n${line(r(3))}\n` })
    const read = reader(before, mid, after)

    const result = await linkItem(client, board, ref, { addBlockedBy: [r(3)] }, { read })

    expect(docs(mutations)).toEqual([ADD_BLOCKED_BY, UPDATE_ISSUE_BODY])
    expect(mutations[0]!.vars).toEqual({ blocked: 'I_item', blocker: 'I_3' })
    expect(mutations[1]!.vars).toEqual({ issue: 'I_item', body: `Intro.\n\n${line(r(3))}\n` })
    expect(result.dependsOn).toEqual({ added: [r(3)], removed: [] })
    expect(result.blockedBy).toEqual([r(3)])
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('removes a blocker and its line', async () => {
    const { client, mutations } = fakeClient([3])
    const body = `Intro.\n\n${line(r(3))}\n`
    const before = detail({ blockedBy: [r(3)], body })
    const mid = detail({ blockedBy: [], body })
    const after = detail({ blockedBy: [], body: 'Intro.\n\n' })
    const read = reader(before, mid, after)

    const result = await linkItem(client, board, ref, { removeBlockedBy: [r(3)] }, { read })

    expect(docs(mutations)).toEqual([REMOVE_BLOCKED_BY, UPDATE_ISSUE_BODY])
    expect(mutations[0]!.vars).toEqual({ blocked: 'I_item', blocker: 'I_3' })
    expect(mutations[1]!.vars.body).not.toContain(line(r(3)))
    expect(result.dependsOn).toEqual({ added: [], removed: [r(3)] })
  })

  it('repairs drift on blockers the call did not name', async () => {
    const { client, mutations } = fakeClient([1, 2, 3])
    const body = `Intro.\n\n${line(r(1))}\n`
    const before = detail({ blockedBy: [r(1), r(2)], body })
    const mid = detail({ blockedBy: [r(1), r(2), r(3)], body })
    const fixed = `Intro.\n\n${line(r(1))}\n${line(r(2))}\n${line(r(3))}\n`
    const after = detail({ blockedBy: [r(1), r(2), r(3)], body: fixed })

    const result = await linkItem(
      client, board, ref, { addBlockedBy: [r(3)] }, { read: reader(before, mid, after) },
    )

    expect(docs(mutations)).toEqual([ADD_BLOCKED_BY, UPDATE_ISSUE_BODY])
    expect(mutations[1]!.vars.body).toBe(fixed)
    expect(result.dependsOn.added).toEqual([r(2), r(3)])
  })

  it('sends no mutation at all for an already-linked add with matching prose, and still verifies', async () => {
    const { client, mutations } = fakeClient([3])
    const item = detail({ blockedBy: [r(3)], body: `Intro.\n\n${line(r(3))}\n` })
    const read = reader(item)

    const result = await linkItem(client, board, ref, { addBlockedBy: [r(3)] }, { read })

    expect(mutations).toEqual([])
    expect(read).toHaveBeenCalledTimes(3)
    expect(result.dependsOn).toEqual({ added: [], removed: [] })
  })

  it('treats Acme/Web#9 as the linked acme/web#9: no mutation, no new line', async () => {
    const { client, mutations } = fakeClient([9])
    const item = detail({ blockedBy: [r(9)], body: `Intro.\n\n${line(r(9))}\n` })

    const result = await linkItem(
      client, board, ref, { addBlockedBy: [r(9, 'Acme', 'Web')] }, { read: reader(item) },
    )

    expect(mutations).toEqual([])
    expect(result.blockedBy).toEqual([r(9)])
    expect(result.dependsOn).toEqual({ added: [], removed: [] })
  })
})

describe('linkItem: parent', () => {
  it('sets a parent over an existing one with SET_PARENT (replaceParent)', async () => {
    const { client, mutations } = fakeClient([94, 50])
    const before = detail({ parent: r(50), epic: r(50) })
    const after = detail({ parent: r(94), epic: r(94) })

    const result = await linkItem(client, board, ref, { parent: r(94) }, { read: reader(before, after) })

    expect(docs(mutations)).toEqual([SET_PARENT])
    expect(SET_PARENT).toMatch(/replaceParent:\s*true/)
    expect(mutations[0]!.vars).toEqual({ parent: 'I_94', child: 'I_item' })
    expect(result.parent).toEqual(r(94))
  })

  it('clears a parent with REMOVE_SUB_ISSUE, naming the current parent', async () => {
    const { client, mutations } = fakeClient([50])
    const before = detail({ parent: r(50), epic: r(50) })
    const after = detail()

    const result = await linkItem(client, board, ref, { parent: null }, { read: reader(before, after) })

    expect(docs(mutations)).toEqual([REMOVE_SUB_ISSUE])
    expect(mutations[0]!.vars).toEqual({ parent: 'I_50', child: 'I_item' })
    expect(result.parent).toBeNull()
  })

  it('leaves the parent alone when the call does not name one', async () => {
    const { client, mutations } = fakeClient([3, 50])
    const before = detail({ parent: r(50), epic: r(50) })
    const mid = detail({ parent: r(50), epic: r(50), blockedBy: [r(3)] })
    const after = detail({ parent: r(50), epic: r(50), blockedBy: [r(3)], body: `Intro.\n\n${line(r(3))}\n` })

    await linkItem(client, board, ref, { addBlockedBy: [r(3)] }, { read: reader(before, mid, after) })

    expect(docs(mutations)).toEqual([ADD_BLOCKED_BY, UPDATE_ISSUE_BODY])
  })
})

describe('linkItem refusals before anything is changed', () => {
  it('refuses add and remove of the same ref, differing only in case, with no read', async () => {
    const { client } = fakeClient([3])
    const read = reader(detail())

    const error = await linkItem(
      client, board, ref,
      { addBlockedBy: [r(3)], removeBlockedBy: [r(3, 'ACME', 'web')] },
      { read },
    ).catch((e: Error) => e)

    expect(error).toBeInstanceOf(ConflictingLinkError)
    expect((error as Error).message).toContain('acme/web#3')
    expect((error as Error).message).toMatch(/Nothing was changed/)
    expect(read).not.toHaveBeenCalled()
    expect(client.graphql).not.toHaveBeenCalled()
  })

  it('refuses the item as its own blocker or parent, with no read', async () => {
    const { client } = fakeClient([278])
    const read = reader(detail())

    await expect(linkItem(client, board, ref, { addBlockedBy: [r(278)] }, { read }))
      .rejects.toThrow(ConflictingLinkError)
    await expect(linkItem(client, board, ref, { parent: r(278, 'Acme') }, { read }))
      .rejects.toThrow(ConflictingLinkError)
    expect(read).not.toHaveBeenCalled()
    expect(client.graphql).not.toHaveBeenCalled()
  })

  it('refuses an off-board item', async () => {
    const { client, mutations } = fakeClient([3])
    await expect(
      linkItem(client, board, ref, { addBlockedBy: [r(3)] }, { read: reader(detail({ projectItemId: null })) }),
    ).rejects.toThrow(NotOnBoardError)
    expect(mutations).toEqual([])
  })

  for (const dryRun of [false, true]) {
    it(`refuses an unknown blocker with MissingLinkTargetError${dryRun ? ' in dry run too' : ''}`, async () => {
      const { client, mutations } = fakeClient([3])
      const error = await linkItem(
        client, board, ref, { addBlockedBy: [r(3), r(404)] }, { read: reader(detail()), dryRun },
      ).catch((e: Error) => e)

      expect(error).toBeInstanceOf(MissingLinkTargetError)
      expect((error as Error).message).toContain('acme/web#404')
      expect((error as Error).message).toMatch(/blocked by/)
      expect((error as Error).message).toMatch(/Nothing was changed/)
      expect(mutations).toEqual([])
    })

    it(`refuses an unknown parent with MissingLinkTargetError${dryRun ? ' in dry run too' : ''}`, async () => {
      const { client, mutations } = fakeClient([])
      const error = await linkItem(
        client, board, ref, { parent: r(404) }, { read: reader(detail()), dryRun },
      ).catch((e: Error) => e)

      expect(error).toBeInstanceOf(MissingLinkTargetError)
      expect((error as Error).message).toMatch(/parent/)
      expect(mutations).toEqual([])
    })

    // The prose is synced from the first read as a check: a body that cannot take a new line is
    // refused before any link is written, so it is never left half-linked.
    it(`refuses a body ending in an unclosed fence before any link write${dryRun ? ' in dry run too' : ''}`, async () => {
      const { client, mutations } = fakeClient([3])
      const before = detail({ body: 'Intro.\n\n```\ncode never closed\n' })

      await expect(
        linkItem(client, board, ref, { addBlockedBy: [r(3)] }, { read: reader(before), dryRun }),
      ).rejects.toThrow(UnclosedFenceError)
      expect(mutations).toEqual([])
    })
  }
})

describe('linkItem partial end states', () => {
  it('raises PartialLinkError when the read-back lacks an added blocker, and leaves the prose alone', async () => {
    const { client, mutations } = fakeClient([3, 4])
    const before = detail()
    const mid = detail({ blockedBy: [r(3)] })

    const error = await linkItem(
      client, board, ref, { addBlockedBy: [r(3), r(4)] }, { read: reader(before, mid) },
    ).catch((e: Error) => e)

    expect(error).toBeInstanceOf(PartialLinkError)
    const e = error as PartialLinkError
    expect(e.landed).toEqual(['blocked by acme/web#3'])
    expect(e.unconfirmed).toEqual(['blocked by acme/web#4'])
    expect(e.message).toMatch(/Depends on/)
    expect(e.message).toMatch(/item_get/)
    expect(docs(mutations)).toEqual([ADD_BLOCKED_BY, ADD_BLOCKED_BY])
  })

  it('names a refused mutation in PartialLinkError', async () => {
    const { client, mutations } = fakeClient([50], [REMOVE_SUB_ISSUE])
    const before = detail({ parent: r(50), epic: r(50) })

    const error = await linkItem(client, board, ref, { parent: null }, { read: reader(before) })
      .catch((e: Error) => e)

    expect(error).toBeInstanceOf(PartialLinkError)
    expect((error as PartialLinkError).unconfirmed).toEqual(['parent acme/web#50 cleared'])
    expect((error as Error).message).toMatch(/refused by GitHub/)
    expect(docs(mutations)).toEqual([REMOVE_SUB_ISSUE])
  })

  it('keeps a person\'s edit made between the first read and the link read-back', async () => {
    const { client, mutations } = fakeClient([3])
    const before = detail({ body: 'Intro.\n' })
    const mid = detail({ blockedBy: [r(3)], body: 'Intro, edited by a person.\n' })
    const written = `Intro, edited by a person.\n\n${line(r(3))}\n`
    const after = detail({ blockedBy: [r(3)], body: written })

    await linkItem(client, board, ref, { addBlockedBy: [r(3)] }, { read: reader(before, mid, after) })

    expect(mutations[1]!.vars).toEqual({ issue: 'I_item', body: written })
  })

  it('raises ProseOutOfStepError when the final read-back\'s lines disagree with its links', async () => {
    const { client } = fakeClient([3])
    const before = detail()
    const mid = detail({ blockedBy: [r(3)] })
    const after = detail({ blockedBy: [r(3)], body: 'Intro.\n' })

    const error = await linkItem(
      client, board, ref, { addBlockedBy: [r(3)] }, { read: reader(before, mid, after) },
    ).catch((e: Error) => e)

    expect(error).toBeInstanceOf(ProseOutOfStepError)
    expect((error as Error).message).toMatch(/item_update/)
    expect((error as Error).message).toMatch(/item_get/)
  })

  it('raises ProseOutOfStepError, not a raw error, when the latest body cannot take the line', async () => {
    const { client, mutations } = fakeClient([3])
    const before = detail()
    const mid = detail({ blockedBy: [r(3)], body: 'Intro.\n\n```\nopened since\n' })

    await expect(
      linkItem(client, board, ref, { addBlockedBy: [r(3)] }, { read: reader(before, mid) }),
    ).rejects.toThrow(ProseOutOfStepError)
    expect(docs(mutations)).toEqual([ADD_BLOCKED_BY])
  })

  it('raises ProseOutOfStepError when the body write is refused', async () => {
    const { client } = fakeClient([3], [UPDATE_ISSUE_BODY])
    const before = detail()
    const mid = detail({ blockedBy: [r(3)] })

    await expect(
      linkItem(client, board, ref, { addBlockedBy: [r(3)] }, { read: reader(before, mid) }),
    ).rejects.toThrow(ProseOutOfStepError)
  })
})

describe('linkItem dry run', () => {
  it('sends no mutation and reports the desired blockers, parent and body', async () => {
    const { client, mutations } = fakeClient([1, 3, 94])
    const before = detail({ blockedBy: [r(1)], body: `Intro.\n\n${line(r(1))}\n` })
    const read = reader(before)

    const result = await linkItem(
      client, board, ref,
      { addBlockedBy: [r(3)], removeBlockedBy: [r(1)], parent: r(94) },
      { read, dryRun: true },
    )

    expect(mutations).toEqual([])
    expect(read).toHaveBeenCalledTimes(1)
    expect(result.blockedBy).toEqual([r(3)])
    expect(result.parent).toEqual(r(94))
    expect(result.epic).toEqual(r(94))
    expect(result.body).toBe(`Intro.\n\n${line(r(3))}\n`)
    expect(result.dependsOn).toEqual({ added: [r(3)], removed: [r(1)] })
  })
})

describe('linkItem no-ops and spelling', () => {
  it('treats removing an unlinked blocker as a no-op: nothing resolved, nothing sent', async () => {
    const { client, mutations } = fakeClient([])
    const item = detail()

    const result = await linkItem(client, board, ref, { removeBlockedBy: [r(404)] }, { read: reader(item) })

    expect(client.graphql).not.toHaveBeenCalled()
    expect(mutations).toEqual([])
    expect(result.dependsOn).toEqual({ added: [], removed: [] })
  })

  it('resolves and sends nothing for a parent already set, or a clear with no parent', async () => {
    const { client } = fakeClient([])

    await linkItem(client, board, ref, { parent: r(50, 'ACME') }, { read: reader(detail({ parent: r(50), epic: r(50) })) })
    await linkItem(client, board, ref, { parent: null }, { read: reader(detail()) })

    expect(client.graphql).not.toHaveBeenCalled()
  })

  it('writes the Depends on line in GitHub\'s spelling, not the caller\'s', async () => {
    const { client, mutations } = fakeClient([3])
    const before = detail()
    const mid = detail({ blockedBy: [r(3)] })
    const after = detail({ blockedBy: [r(3)], body: `Intro.\n\n${line(r(3))}\n` })

    const result = await linkItem(
      client, board, ref, { addBlockedBy: [r(3, 'Acme', 'Web')] }, { read: reader(before, mid, after) },
    )

    expect(mutations[1]!.vars.body).toContain(line(r(3)))
    expect(result.dependsOn.added).toEqual([r(3)])
  })

  // The recurring bug here is a dry run that predicts something the real path does not do.
  it('predicts in dry run exactly what the real path returns', async () => {
    const change = { addBlockedBy: [r(3, 'Acme', 'Web')], removeBlockedBy: [r(1)], parent: r(94) }
    const before = detail({ blockedBy: [r(1)], parent: r(50), epic: r(50), body: `Intro.\n\n${line(r(1))}\n` })
    const body = `Intro.\n\n${line(r(3))}\n`
    const mid = detail({ blockedBy: [r(3)], parent: r(94), epic: r(94), body: before.body })
    const after = detail({ blockedBy: [r(3)], parent: r(94), epic: r(94), body })

    const dry = await linkItem(fakeClient([1, 3, 94]).client, board, ref, change, { read: reader(before), dryRun: true })
    const real = await linkItem(fakeClient([1, 3, 94]).client, board, ref, change, { read: reader(before, mid, after) })

    for (const key of ['blockedBy', 'parent', 'epic', 'body', 'checklist', 'dependsOn'] as const) {
      expect(dry[key], key).toEqual(real[key])
    }
  })

  it('predicts a cleared parent in dry run', async () => {
    const { client, mutations } = fakeClient([50])
    const result = await linkItem(
      client, board, ref, { parent: null }, { read: reader(detail({ parent: r(50), epic: r(50) })), dryRun: true },
    )
    expect(mutations).toEqual([])
    expect(result.parent).toBeNull()
    expect(result.epic).toBeNull()
  })
})

describe('linkItem read-back failures', () => {
  it('raises PartialLinkError with every write unconfirmed when the link read-back fails', async () => {
    const { client } = fakeClient([3])
    let call = 0
    const read = vi.fn(async () => {
      if (call++ === 0) return detail()
      throw new Error('network down')
    })

    const error = await linkItem(client, board, ref, { addBlockedBy: [r(3)] }, { read }).catch((e: Error) => e)

    expect(error).toBeInstanceOf(PartialLinkError)
    expect((error as PartialLinkError).landed).toEqual([])
    expect((error as PartialLinkError).unconfirmed).toEqual(['blocked by acme/web#3'])
    expect((error as Error).message).toMatch(/^No link change on acme\/web#278 was confirmed/)
    expect((error as Error).message).toMatch(/network down/)
  })

  it('raises PartialLinkError when someone else changed the blockers meanwhile, though every write landed', async () => {
    const { client, mutations } = fakeClient([3])
    const before = detail()
    const mid = detail({ blockedBy: [r(3), r(7)] })

    const error = await linkItem(
      client, board, ref, { addBlockedBy: [r(3)] }, { read: reader(before, mid) },
    ).catch((e: Error) => e)

    expect(error).toBeInstanceOf(PartialLinkError)
    expect((error as PartialLinkError).landed).toEqual(['blocked by acme/web#3'])
    expect((error as Error).message).toContain('acme/web#7')
    expect(docs(mutations)).toEqual([ADD_BLOCKED_BY])
  })

  it('says the call sent nothing when the links moved under a no-op call', async () => {
    const { client, mutations } = fakeClient([])
    const before = detail()
    const mid = detail({ blockedBy: [r(7)] })

    const error = await linkItem(client, board, ref, {}, { read: reader(before, mid) }).catch((e: Error) => e)

    expect(error).toBeInstanceOf(PartialLinkError)
    expect((error as Error).message).toMatch(/this call sent nothing/)
    expect(mutations).toEqual([])
  })

  it('does not call a write refused when the read-back shows it landed', async () => {
    const { client } = fakeClient([3, 4], [ADD_BLOCKED_BY])
    const before = detail()
    // #3 threw but landed; #4 threw and did not.
    const mid = detail({ blockedBy: [r(3)] })

    const error = await linkItem(
      client, board, ref, { addBlockedBy: [r(3), r(4)] }, { read: reader(before, mid) },
    ).catch((e: Error) => e)

    expect((error as PartialLinkError).landed).toEqual(['blocked by acme/web#3'])
    expect((error as Error).message).not.toMatch(/acme\/web#3 was refused/)
    expect((error as Error).message).toMatch(/acme\/web#4 was refused/)
  })

  it('raises ProseOutOfStepError when the links move after they were confirmed', async () => {
    const { client } = fakeClient([3])
    const before = detail()
    const mid = detail({ blockedBy: [r(3)] })
    const after = detail({ blockedBy: [], body: `Intro.\n\n${line(r(3))}\n` })

    await expect(
      linkItem(client, board, ref, { addBlockedBy: [r(3)] }, { read: reader(before, mid, after) }),
    ).rejects.toThrow(/links changed again/)
  })

  it('names a missing current parent as one being removed from', async () => {
    const { client } = fakeClient([])
    const error = await linkItem(
      client, board, ref, { parent: null }, { read: reader(detail({ parent: r(50), epic: r(50) })) },
    ).catch((e: Error) => e)
    expect(error).toBeInstanceOf(MissingLinkTargetError)
    expect((error as Error).message).toMatch(/remove acme\/web#278 from its parent acme\/web#50/)
  })
})
