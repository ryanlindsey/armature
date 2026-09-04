import { describe, expect, it } from 'vitest'
import { computeCollisions, inferStatusSemantics, surveyBoard } from '../server/providers/github/board.js'
import type { GitHubClient } from '../server/providers/github/client.js'
import type { BoardItem } from '../server/providers/types.js'

function item(owner: string, repo: string, number: number): BoardItem {
  return {
    ref: { owner, repo, number },
    id: `${owner}/${repo}#${number}`,
    title: 't',
    status: 'Todo',
    state: 'OPEN',
    parent: null,
  }
}

describe('computeCollisions', () => {
  it('finds a number claimed by two repositories', () => {
    const c = computeCollisions([item('acme', 'web', 278), item('acme', 'api', 278)])
    expect(c[278]).toEqual(['acme/api', 'acme/web'])
  })

  it('ignores a number used once', () => {
    const c = computeCollisions([item('acme', 'web', 1), item('acme', 'api', 2)])
    expect(c).toEqual({})
  })
})

describe('inferStatusSemantics', () => {
  it('reads a conventional board', () => {
    const s = inferStatusSemantics(['Todo', 'In progress', 'Validation', 'Done', 'On hold'])
    expect(s).toEqual({ todo: 'Todo', claimed: 'In progress', review: 'Validation', done: 'Done' })
  })

  it('accepts alternative wording', () => {
    const s = inferStatusSemantics(['Backlog', 'Doing', 'In Review', 'Shipped'])
    expect(s).toEqual({ todo: 'Backlog', claimed: 'Doing', review: 'In Review', done: 'Shipped' })
  })

  it('leaves review null when the board has no review column', () => {
    const s = inferStatusSemantics(['Todo', 'WIP', 'Done'])
    expect(s.review).toBeNull()
    expect(s.claimed).toBe('WIP')
  })

  it('raises when no option resembles a claimed status', () => {
    expect(() => inferStatusSemantics(['Alpha', 'Beta'])).toThrow(/could not tell/i)
  })
})

// ---------------------------------------------------------------------------------------------
// surveyBoard's root field.
//
// BOARD_QUERY was rooted at `organization(login:$owner)` alone, so a board owned by a user
// account was not merely absent from the result — GitHub answers that query with
// `{"data":{"organization":null},"errors":[{"type":"NOT_FOUND", ...}]}`, and GitHubClient throws
// on any `errors` entry. A personal board therefore failed with "Could not resolve to an
// Organization", naming a thing the user never asked for, rather than being read.
//
// `repositoryOwner(login:)` resolves either account type in one request and returns no error for
// the shape it isn't, so both owners go down the same path.
// ---------------------------------------------------------------------------------------------

function projectResponse(typename: 'User' | 'Organization') {
  const nodes = [
    {
      id: 'PVTI_1',
      fieldValueByName: { name: 'Todo' },
      content: {
        number: 7,
        title: 'An item',
        state: 'OPEN',
        repository: { owner: { login: 'ryanlindsey' }, name: 'armature' },
        parent: null,
      },
    },
  ]
  return {
    repositoryOwner: {
      __typename: typename,
      projectV2: {
        id: 'PVT_1',
        field: {
          id: 'F_1',
          options: [
            { id: 'o1', name: 'Todo' },
            { id: 'o2', name: 'In Progress' },
            { id: 'o3', name: 'Done' },
          ],
        },
        items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
      },
    },
  }
}

function ownerClient(typename: 'User' | 'Organization'): GitHubClient {
  const response = projectResponse(typename)
  return {
    graphql: async () => response,
    collectAll: async (_q: string, _v: unknown, extract: (d: any) => { nodes: unknown[] }) =>
      extract(response).nodes,
  } as unknown as GitHubClient
}

describe('surveyBoard', () => {
  const board = { provider: 'github' as const, owner: 'ryanlindsey', number: 1 }

  it('reads a board owned by a user account', async () => {
    const snapshot = await surveyBoard(ownerClient('User'), board, 'repo')
    expect(snapshot.id).toBe('PVT_1')
    expect(snapshot.items.map((i) => i.ref.number)).toEqual([7])
  })

  it('reads a board owned by an organization', async () => {
    const snapshot = await surveyBoard(ownerClient('Organization'), board, 'repo')
    expect(snapshot.id).toBe('PVT_1')
    expect(snapshot.items.map((i) => i.ref.number)).toEqual([7])
  })

  it('asks GitHub for the owner without assuming it is an organization', async () => {
    const seen: string[] = []
    const response = projectResponse('User')
    const client = {
      graphql: async (query: string) => {
        seen.push(query)
        return response
      },
      collectAll: async () => response.repositoryOwner.projectV2.items.nodes,
    } as unknown as GitHubClient

    await surveyBoard(client, board, 'repo')

    expect(seen[0]).toContain('repositoryOwner(login:$owner)')
    expect(seen[0]).not.toMatch(/organization\(login:/)
  })

  it('says the board is not visible when the owner resolves to nothing', async () => {
    const client = {
      graphql: async () => ({ repositoryOwner: null }),
      collectAll: async () => [],
    } as unknown as GitHubClient

    await expect(surveyBoard(client, board, 'repo')).rejects.toThrow(/not visible|no project/i)
  })
})
