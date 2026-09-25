import { describe, expect, it } from 'vitest'
import { EpicNotFoundError, TruncatedEpicError, surveyEpic } from '../server/providers/github/epic.js'
import type { BoardSnapshot } from '../server/providers/types.js'
import { GraphQLError, type GitHubClient } from '../server/providers/github/client.js'

const EPIC = { owner: 'acme', repo: 'web', number: 10 }

const snapshot: BoardSnapshot = {
  board: { provider: 'github', name: 'acme/1', source: 'repo' },
  id: 'PVT_1',
  statusFieldId: 'F_1',
  statusOptions: [
    { id: 'o1', name: 'Todo' },
    { id: 'o2', name: 'In Progress' },
    { id: 'o3', name: 'Done' },
  ],
  semantics: { todo: 'Todo', claimed: 'In Progress', review: null, done: 'Done' },
  repositories: ['acme/web', 'acme/api'],
  collisions: {},
  items: [
    { ref: EPIC, id: 'i0', title: 'Epic: ship it', status: 'Todo', state: 'OPEN', parent: null },
    { ref: { owner: 'acme', repo: 'web', number: 12 }, id: 'i2', title: '02 · second', status: 'Todo', state: 'OPEN', parent: EPIC },
    { ref: { owner: 'acme', repo: 'web', number: 11 }, id: 'i1', title: '01 · first', status: 'Done', state: 'CLOSED', parent: EPIC },
    { ref: { owner: 'acme', repo: 'api', number: 11 }, id: 'i3', title: '03 · other repo', status: 'Todo', state: 'OPEN', parent: EPIC },
  ],
}

function clientReturning(nodes: unknown[], hasNextPage = false): GitHubClient {
  // Every connection says it is complete unless a test says otherwise.
  nodes = (nodes as Record<string, any>[]).map((n) => ({
    ...n,
    labels: { pageInfo: { hasNextPage: false }, ...n.labels },
    blockedBy: { pageInfo: { hasNextPage: false }, ...n.blockedBy },
    closedByPullRequestsReferences: { pageInfo: { hasNextPage: false }, ...n.closedByPullRequestsReferences },
  }))
  return {
    graphql: async () => ({
      repository: { issue: { title: 'Epic: ship it', subIssues: { pageInfo: { hasNextPage }, nodes } } },
    }),
  } as unknown as GitHubClient
}

const node = (repo: string, number: number, extra: Record<string, unknown> = {}) => ({
  number,
  repository: { owner: { login: 'acme' }, name: repo },
  labels: { nodes: [] },
  blockedBy: { nodes: [] },
  closedByPullRequestsReferences: { nodes: [] },
  ...extra,
})

const standard = () => clientReturning([node('web', 11), node('web', 12), node('api', 11)])

describe('surveyEpic', () => {
  it('orders children by issue number and keeps repositories distinct', async () => {
    const result = await surveyEpic(standard(), snapshot, EPIC)
    expect(result.children.map((c) => `${c.ref.repo}#${c.ref.number}`)).toEqual([
      'api#11',
      'web#11',
      'web#12',
    ])
  })

  // A string sort over formatRef puts "#12" before "#9". Working order is numeric, as selectNext's.
  it('orders by the number as a number, not as text', async () => {
    const wide: BoardSnapshot = {
      ...snapshot,
      items: [
        ...snapshot.items,
        { ref: { owner: 'acme', repo: 'web', number: 9 }, id: 'i9', title: '00 · zeroth', status: 'Todo', state: 'OPEN', parent: EPIC },
      ],
    }
    const client = clientReturning([node('web', 12), node('web', 9), node('web', 11), node('api', 11)])
    const result = await surveyEpic(client, wide, EPIC)
    expect(result.children.map((c) => `${c.ref.repo}#${c.ref.number}`)).toEqual([
      'web#9',
      'api#11',
      'web#11',
      'web#12',
    ])
  })

  it('carries the board status, state and title through from the snapshot', async () => {
    const result = await surveyEpic(standard(), snapshot, EPIC)
    const first = result.children.find((c) => c.ref.repo === 'web' && c.ref.number === 11)!
    expect(first.status).toBe('Done')
    expect(first.state).toBe('CLOSED')
    expect(first.title).toBe('01 · first')
  })

  it('reports the epic itself', async () => {
    const result = await surveyEpic(standard(), snapshot, EPIC)
    expect(result.epic).toEqual({ ref: EPIC, title: 'Epic: ship it' })
  })

  it('resolves blockedBy to fully qualified refs', async () => {
    const client = clientReturning([
      node('web', 11),
      node('web', 12, {
        blockedBy: { nodes: [{ number: 11, repository: { owner: { login: 'acme' }, name: 'web' } }] },
      }),
      node('api', 11),
    ])
    const result = await surveyEpic(client, snapshot, EPIC)
    const second = result.children.find((c) => c.ref.number === 12)!
    expect(second.blockedBy).toEqual([{ owner: 'acme', repo: 'web', number: 11 }])
  })

  it('reports linked pull requests with their branches', async () => {
    const client = clientReturning([
      node('web', 11, {
        closedByPullRequestsReferences: {
          nodes: [
            { number: 40, state: 'MERGED', url: 'https://x/40', headRefName: 'issue-11-first', baseRefName: 'main' },
          ],
        },
      }),
      node('web', 12),
      node('api', 11),
    ])
    const result = await surveyEpic(client, snapshot, EPIC)
    expect(result.children.find((c) => c.ref.repo === 'web' && c.ref.number === 11)!.pullRequests).toEqual([
      { number: 40, state: 'MERGED', url: 'https://x/40', headRefName: 'issue-11-first', baseRefName: 'main' },
    ])
  })

  it('reports every linked pull request when a child has two', async () => {
    const prs = [
      { number: 40, state: 'CLOSED', url: 'https://x/40', headRefName: 'issue-12-a', baseRefName: 'main' },
      { number: 41, state: 'OPEN', url: 'https://x/41', headRefName: 'issue-12-b', baseRefName: 'issue-11-first' },
    ]
    const client = clientReturning([
      node('web', 11),
      node('web', 12, { closedByPullRequestsReferences: { nodes: prs } }),
      node('api', 11),
    ])
    const result = await surveyEpic(client, snapshot, EPIC)
    expect(result.children.find((c) => c.ref.number === 12)!.pullRequests).toEqual(prs)
  })

  it('reports an empty pullRequests array for a child with none', async () => {
    const result = await surveyEpic(standard(), snapshot, EPIC)
    expect(result.children.find((c) => c.ref.number === 12)!.pullRequests).toEqual([])
  })

  it('reports labels', async () => {
    const client = clientReturning([
      node('web', 11),
      node('web', 12),
      node('api', 11, { labels: { nodes: [{ name: 'needs-human' }] } }),
    ])
    const result = await surveyEpic(client, snapshot, EPIC)
    expect(result.children.find((c) => c.ref.repo === 'api')!.labels).toEqual(['needs-human'])
  })

  it('separates a sub-issue that is not on the board rather than dropping it', async () => {
    const client = clientReturning([node('web', 11), node('web', 12), node('api', 11), node('web', 99)])
    const result = await surveyEpic(client, snapshot, EPIC)
    expect(result.children.map((c) => c.ref.number)).not.toContain(99)
    expect(result.offBoard).toEqual([{ owner: 'acme', repo: 'web', number: 99 }])
  })

  it('matches the epic regardless of the casing it was asked for in', async () => {
    const result = await surveyEpic(standard(), snapshot, { owner: 'ACME', repo: 'Web', number: 10 })
    expect(result.children).toHaveLength(3)
    expect(result.offBoard).toEqual([])
  })

  it('delegates next to selectNext and keeps its reasoning', async () => {
    const result = await surveyEpic(standard(), snapshot, EPIC)
    expect(result.next.ref).toEqual({ owner: 'acme', repo: 'api', number: 11 })
    expect(result.next.because).toMatch(/lowest-numbered open "Todo" child/)
  })

  it('explains itself rather than returning a null ref when nothing is actionable', async () => {
    const done = { ...snapshot, items: snapshot.items.map((i) => (i.parent ? { ...i, status: 'Done' } : i)) }
    const result = await surveyEpic(standard(), done, EPIC)
    expect(result.next.ref).toBeNull()
    expect(result.next.because).toMatch(/Nothing is actionable/)
  })

  // The real client throws on GitHub's NOT_FOUND before any null reaches surveyEpic, so the fake
  // throws the way it does. A fake returning a bare null tested a path production never takes.
  it('raises a named error for an epic that does not exist', async () => {
    const client = {
      graphql: async () => {
        throw new GraphQLError('Could not resolve to an Issue with the number of 10.', ['NOT_FOUND'])
      },
    } as unknown as GitHubClient
    await expect(surveyEpic(client, snapshot, EPIC)).rejects.toThrow(EpicNotFoundError)
    await expect(surveyEpic(client, snapshot, EPIC)).rejects.toThrow(/acme\/web#10/)
  })

  it('still raises a named error if GitHub answers null without an error', async () => {
    const client = { graphql: async () => ({ repository: { issue: null } }) } as unknown as GitHubClient
    await expect(surveyEpic(client, snapshot, EPIC)).rejects.toThrow(EpicNotFoundError)
  })

  it('lets any other GraphQL failure through unchanged', async () => {
    const client = {
      graphql: async () => {
        throw new GraphQLError('Something went wrong', ['INTERNAL'])
      },
    } as unknown as GitHubClient
    await expect(surveyEpic(client, snapshot, EPIC)).rejects.toThrow(/Something went wrong/)
  })

  // Fifty is the page. A fifty-first child silently missing is a child nobody works and nobody is
  // told about — the same failure offBoard exists to prevent — so it refuses rather than truncates.
  it('refuses an epic with more sub-issues than one page holds', async () => {
    const client = clientReturning([node('web', 11), node('web', 12), node('api', 11)], true)
    await expect(surveyEpic(client, snapshot, EPIC)).rejects.toThrow(TruncatedEpicError)
  })

  // Each dropped entry is a wrong ledger row: a missing open PR reads "interrupted" and is worked
  // twice, a missing blocker picks the wrong base branch, a missing label claims a human's child.
  it.each([
    ['labels', 'labels'],
    ['blockedBy', 'blockers'],
    ['closedByPullRequestsReferences', 'linked pull requests'],
  ])('refuses a child whose %s overflow one page, naming the connection', async (field, words) => {
    const client = clientReturning([
      node('web', 11),
      node('web', 12, { [field]: { pageInfo: { hasNextPage: true }, nodes: [] } }),
      node('api', 11),
    ])
    const err = await surveyEpic(client, snapshot, EPIC).catch((e: Error) => e)
    expect(err).toBeInstanceOf(TruncatedEpicError)
    expect((err as Error).message).toContain('acme/web#12')
    expect((err as Error).message).toContain(words)
  })
})
