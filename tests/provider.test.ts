import { describe, expect, it, vi } from 'vitest'
import type { GitHubClient } from '../server/providers/github/client.js'
import { GitHubBoardProvider } from '../server/providers/github/provider.js'

const board = { provider: 'github' as const, owner: 'acme', number: 1 }
const ref = { owner: 'acme', repo: 'web', number: 5 }

const OPTIONS = [
  { id: 'o-todo', name: 'Todo' },
  { id: 'o-doing', name: 'In progress' },
  { id: 'o-done', name: 'Done' },
]

// A client faithful enough to move an item: the board query, the single-issue query and the
// status mutation all read and write one shared `status`, so a second survey reports what the
// first write actually did. Without that, a cache-invalidation test cannot tell a re-read from
// a replayed cache.
function makeClient() {
  let status = 'Todo'
  const surveys = { count: 0 }

  const boardNodes = () => [
    {
      id: 'PVTI_1',
      fieldValueByName: { name: status },
      content: {
        number: 5,
        title: 'Item 5',
        state: 'OPEN',
        repository: { owner: { login: 'acme' }, name: 'web' },
        parent: null,
      },
    },
  ]

  const client = {
    graphql: vi.fn(async (query: string) => {
      if (query.includes('updateProjectV2ItemFieldValue')) {
        status = 'In progress'
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } }
      }
      if (query.includes('issue(number:$number)')) {
        return {
          repository: {
            issue: {
              id: 'I_1',
              number: 5,
              title: 'Item 5',
              body: '',
              state: 'OPEN',
              parent: null,
              projectItems: {
                nodes: [
                  { id: 'PVTI_1', project: { number: 1 }, fieldValueByName: { name: status } },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        }
      }
      // The board head query, fetched for the project metadata before collectAll pages it.
      return {
        organization: {
          projectV2: {
            id: 'PVT_1',
            field: { id: 'F_1', options: OPTIONS },
            items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: boardNodes() },
          },
        },
      }
    }),
    collectAll: vi.fn(async () => {
      surveys.count++
      return boardNodes()
    }),
  }

  return { client: client as unknown as GitHubClient, surveys, currentStatus: () => status }
}

describe('GitHubBoardProvider.survey', () => {
  it('memoises the board for the life of the provider', async () => {
    const { client, surveys } = makeClient()
    const provider = new GitHubBoardProvider(client, board)

    await provider.survey()
    await provider.survey()

    expect(surveys.count).toBe(1)
  })
})

// BoardSnapshot.items carries live per-item statuses in the same object as the stable derived
// facts. Cached for the life of the provider and never invalidated, one item_claim left
// board_next returning the same item forever and board_survey describing a board that no longer
// existed.
describe('GitHubBoardProvider invalidates its snapshot after a write', () => {
  it('re-reads the board after a claim, and reports the new status', async () => {
    const { client, surveys } = makeClient()
    const provider = new GitHubBoardProvider(client, board)

    const before = await provider.survey()
    expect(before.items[0]!.status).toBe('Todo')

    await provider.claim(ref)

    const after = await provider.survey()
    expect(surveys.count).toBeGreaterThan(1)
    expect(after.items[0]!.status).toBe('In progress')
  })

  it('re-reads the board after a status change', async () => {
    const { client, surveys } = makeClient()
    const provider = new GitHubBoardProvider(client, board)

    await provider.survey()
    const surveysBefore = surveys.count
    await provider.setStatus(ref, 'In progress')
    await provider.survey()

    expect(surveys.count).toBe(surveysBefore + 1)
  })

  it('re-reads the board after a creation, which adds an item to it', async () => {
    const { client, surveys } = makeClient()
    const provider = new GitHubBoardProvider(client, board, true)

    await provider.survey()
    const surveysBefore = surveys.count
    await provider.create({ owner: 'acme', repo: 'web', title: 't', body: 'b' })
    await provider.survey()

    expect(surveys.count).toBe(surveysBefore + 1)
  })

  it('re-reads the board even when the write fails, because a failed write may still have landed', async () => {
    const { client, surveys } = makeClient()
    const provider = new GitHubBoardProvider(client, board)

    await provider.survey()
    const surveysBefore = surveys.count
    await expect(provider.setStatus(ref, 'Nonsense')).rejects.toThrow(/no status/i)
    await provider.survey()

    expect(surveys.count).toBe(surveysBefore + 1)
  })
})
