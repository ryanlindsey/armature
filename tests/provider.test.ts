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
function makeClient(initialBody = '') {
  let status = 'Todo'
  let body = initialBody
  let title = 'Item 5'
  // acme/web#5's blockers, as GitHub's issue dependencies report them.
  const blockers: { number: number; repository: { owner: { login: string }; name: string } }[] = []
  // Bumped by every issue edit, as GitHub's updatedAt is, so a version read before an edit is
  // stale after it.
  let edits = 0
  const updatedAt = () => new Date(Date.UTC(2026, 0, 1, 0, 0, edits)).toISOString()
  const surveys = { count: 0 }

  const boardNodes = () => [
    {
      id: 'PVTI_1',
      fieldValueByName: { name: status },
      content: {
        number: 5,
        title,
        state: 'OPEN',
        repository: { owner: { login: 'acme' }, name: 'web' },
        parent: null,
      },
    },
  ]

  const client = {
    graphql: vi.fn(async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes('updateIssue(')) {
        if (variables!.title !== undefined) title = variables!.title as string
        if (variables!.body !== undefined) body = variables!.body as string
        edits++
        return { updateIssue: { issue: { id: 'I_1' } } }
      }
      if (query.includes('addBlockedBy')) {
        const number = Number(String(variables!.blocker).replace('I_', ''))
        blockers.push({ number, repository: { owner: { login: 'acme' }, name: 'web' } })
        return { addBlockedBy: { issue: { id: 'I_1' } } }
      }
      if (query.includes('updateProjectV2ItemFieldValue')) {
        status = 'In progress'
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } }
      }
      // Before the single-issue branch: EPIC_ENRICHMENT also selects issue(number:$number).
      if (query.includes('subIssues')) {
        return {
          repository: {
            issue: { title: 'Epic', subIssues: { pageInfo: { hasNextPage: false }, nodes: [] } },
          },
        }
      }
      // ISSUE_IDENTITY, resolving a link target. Only acme/web#9 exists besides the item itself.
      if (query.includes('issue(number:$number){ id number repository')) {
        const number = variables!.number as number
        if (variables!.name !== 'web' || (number !== 9 && number !== 5)) return { repository: { issue: null } }
        return {
          repository: {
            issue: { id: `I_${number}`, number, repository: { owner: { login: 'acme' }, name: 'web' } },
          },
        }
      }
      if (query.includes('issue(number:$number)')) {
        return {
          repository: {
            issue: {
              id: 'I_1',
              number: 5,
              title,
              body,
              updatedAt: updatedAt(),
              state: 'OPEN',
              parent: null,
              blockedBy: { pageInfo: { hasNextPage: false }, nodes: blockers },
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
      // Rooted at repositoryOwner, as BOARD_QUERY is: the board's owner may be a user account,
      // and `organization(login:)` answers a personal account with a NOT_FOUND error.
      return {
        repositoryOwner: {
          __typename: 'User',
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

  return {
    client: client as unknown as GitHubClient,
    surveys,
    currentStatus: () => status,
    currentBody: () => body,
    currentTitle: () => title,
  }
}

describe('GitHubBoardProvider.survey', () => {
  it('memoises the board for the life of the provider', async () => {
    const { client, surveys } = makeClient()
    const provider = new GitHubBoardProvider(client, board, { boardSource: 'repo' })

    await provider.survey()
    await provider.survey()

    expect(surveys.count).toBe(1)
  })

  // /armature-doctor is how a user checks armature's inferences before trusting them, and its
  // first line asks for "the board, and where its identity came from". Neither was reachable:
  // BoardSnapshot had no board at all, and main() computed config.boardSource and dropped it.
  it('names the board and the precedence layer that supplied it', async () => {
    const { client } = makeClient()
    const provider = new GitHubBoardProvider(client, board, { boardSource: 'env' })

    const snapshot = await provider.survey()

    expect(snapshot.board).toEqual({ provider: 'github', name: 'acme/1', source: 'env' })
  })

  it('reports the source it was actually given, not a default', async () => {
    const { client } = makeClient()
    const provider = new GitHubBoardProvider(client, board, { boardSource: 'derived' })

    expect((await provider.survey()).board.source).toBe('derived')
  })
})

// BoardSnapshot.items carries live per-item statuses in the same object as the stable derived
// facts. Cached for the life of the provider and never invalidated, one item_claim left
// board_next returning the same item forever and board_survey describing a board that no longer
// existed.
describe('GitHubBoardProvider invalidates its snapshot after a write', () => {
  it('re-reads the board after a claim, and reports the new status', async () => {
    const { client, surveys } = makeClient()
    const provider = new GitHubBoardProvider(client, board, { boardSource: 'repo' })

    const before = await provider.survey()
    expect(before.items[0]!.status).toBe('Todo')

    await provider.claim(ref)

    const after = await provider.survey()
    expect(surveys.count).toBeGreaterThan(1)
    expect(after.items[0]!.status).toBe('In progress')
  })

  it('re-reads the board after a status change', async () => {
    const { client, surveys } = makeClient()
    const provider = new GitHubBoardProvider(client, board, { boardSource: 'repo' })

    await provider.survey()
    const surveysBefore = surveys.count
    await provider.setStatus(ref, 'In progress')
    await provider.survey()

    expect(surveys.count).toBe(surveysBefore + 1)
  })

  it('re-reads the board after a creation, which adds an item to it', async () => {
    const { client, surveys } = makeClient()
    const provider = new GitHubBoardProvider(client, board, { boardSource: 'repo', dryRun: true })

    await provider.survey()
    const surveysBefore = surveys.count
    await provider.create({ owner: 'acme', repo: 'web', title: 't', body: 'b' })
    await provider.survey()

    expect(surveys.count).toBe(surveysBefore + 1)
  })

  it('re-reads the board even when the write fails, because a failed write may still have landed', async () => {
    const { client, surveys } = makeClient()
    const provider = new GitHubBoardProvider(client, board, { boardSource: 'repo' })

    await provider.survey()
    const surveysBefore = surveys.count
    await expect(provider.setStatus(ref, 'Nonsense')).rejects.toThrow(/no status/i)
    await provider.survey()

    expect(surveys.count).toBe(surveysBefore + 1)
  })
})

// A checklist is not part of BoardSnapshot, so a checklist write cannot stale the cache today.
// It invalidates anyway, like every other write: cheap to keep, expensive to reintroduce if
// `checklist` ever reaches the snapshot.
describe('GitHubBoardProvider.check', () => {
  it('writes the entry and re-reads the board afterwards', async () => {
    const { client, surveys, currentBody } = makeClient('- [ ] first\n- [ ] second')
    const provider = new GitHubBoardProvider(client, board, { boardSource: 'repo' })

    await provider.survey()
    const surveysBefore = surveys.count
    const after = await provider.check!(ref, [{ text: 'first', checked: true }])
    await provider.survey()

    expect(currentBody()).toBe('- [x] first\n- [ ] second')
    expect(after.checklist?.[0]).toMatchObject({ text: 'first', checked: true })
    expect(surveys.count).toBe(surveysBefore + 1)
  })

  it('re-reads the board even when the write is refused', async () => {
    const { client, surveys, currentBody } = makeClient('- [ ] first')
    const provider = new GitHubBoardProvider(client, board, { boardSource: 'repo' })

    await provider.survey()
    const surveysBefore = surveys.count
    await expect(provider.check!(ref, [{ text: 'nope', checked: true }])).rejects.toThrow(/nope/)
    await provider.survey()

    expect(currentBody()).toBe('- [ ] first')
    expect(surveys.count).toBe(surveysBefore + 1)
  })

  it('sends nothing under dry run, and reports the predicted checklist', async () => {
    const { client, currentBody } = makeClient('- [ ] first')
    const provider = new GitHubBoardProvider(client, board, { boardSource: 'repo', dryRun: true })

    const after = await provider.check!(ref, [{ text: 'first', checked: true }])

    expect(currentBody()).toBe('- [ ] first')
    expect(after.checklist?.[0]).toMatchObject({ text: 'first', checked: true })
  })
})

// Unlike a checklist, a title IS part of BoardSnapshot, so a cached snapshot across this write
// would report the old title from board_survey.
describe('GitHubBoardProvider.update', () => {
  it('writes the edit and re-reads the board afterwards', async () => {
    const { client, surveys, currentTitle } = makeClient()
    const provider = new GitHubBoardProvider(client, board, { boardSource: 'repo' })

    await provider.survey()
    const surveysBefore = surveys.count
    const { version } = await provider.getItem(ref)
    const after = await provider.update(ref, { title: 'Renamed', expectVersion: version! })
    const snapshot = await provider.survey()

    expect(currentTitle()).toBe('Renamed')
    expect(after.title).toBe('Renamed')
    expect(after.version).not.toBe(version)
    expect(snapshot.items[0]!.title).toBe('Renamed')
    expect(surveys.count).toBe(surveysBefore + 1)
  })

  it('re-reads the board even when the write is refused', async () => {
    const { client, surveys, currentTitle } = makeClient()
    const provider = new GitHubBoardProvider(client, board, { boardSource: 'repo' })

    await provider.survey()
    const surveysBefore = surveys.count
    await expect(
      provider.update(ref, { title: 'Renamed', expectVersion: 'not-the-version' }),
    ).rejects.toThrow(/has changed since it was read/)
    await provider.survey()

    expect(currentTitle()).toBe('Item 5')
    expect(surveys.count).toBe(surveysBefore + 1)
  })

  it('sends nothing under dry run, and reports the predicted item', async () => {
    const { client, currentBody } = makeClient('old')
    const provider = new GitHubBoardProvider(client, board, { boardSource: 'repo', dryRun: true })

    const { version } = await provider.getItem(ref)
    const after = await provider.update(ref, { body: 'new', expectVersion: version! })

    expect(currentBody()).toBe('old')
    expect((after as { body?: string }).body).toBe('new')
    expect(after.version).toBe(version)
  })
})

describe('GitHubBoardProvider.link', () => {
  const blocker = { owner: 'acme', repo: 'web', number: 9 }

  it('writes the link and its Depends on line, and re-reads the board afterwards', async () => {
    const { client, surveys, currentBody } = makeClient()
    const provider = new GitHubBoardProvider(client, board, { boardSource: 'repo' })

    await provider.survey()
    const surveysBefore = surveys.count
    const after = await provider.link(ref, { addBlockedBy: [blocker] })
    await provider.survey()

    expect(after.blockedBy).toEqual([blocker])
    expect(after.dependsOn).toEqual({ added: [blocker], removed: [] })
    expect(currentBody()).toContain('Depends on `acme/web#9`')
    expect(surveys.count).toBe(surveysBefore + 1)
  })

  it('re-reads the board even when the change is refused', async () => {
    const { client, surveys, currentBody } = makeClient()
    const provider = new GitHubBoardProvider(client, board, { boardSource: 'repo' })

    await provider.survey()
    const surveysBefore = surveys.count
    await expect(
      provider.link(ref, { addBlockedBy: [{ owner: 'acme', repo: 'web', number: 404 }] }),
    ).rejects.toThrow(/does not exist/)
    await provider.survey()

    expect(currentBody()).toBe('')
    expect(surveys.count).toBe(surveysBefore + 1)
  })

  it('sends nothing under dry run, and reports the predicted links', async () => {
    const { client, currentBody } = makeClient()
    const provider = new GitHubBoardProvider(client, board, { boardSource: 'repo', dryRun: true })

    const after = await provider.link(ref, { addBlockedBy: [blocker] })

    expect(currentBody()).toBe('')
    expect(after.blockedBy).toEqual([blocker])
    expect(after.dependsOn.added).toEqual([blocker])
    expect(client.graphql).not.toHaveBeenCalledWith(expect.stringContaining('addBlockedBy'), expect.anything())
  })
})

describe('GitHubBoardProvider.epic', () => {
  it('reuses the cached snapshot rather than surveying the board per call', async () => {
    const { client, surveys } = makeClient()
    const provider = new GitHubBoardProvider(client, board, { boardSource: 'repo' })

    await provider.epic({ owner: 'acme', repo: 'web', number: 1 })
    await provider.epic({ owner: 'acme', repo: 'web', number: 1 })

    expect(surveys.count).toBe(1)
  })

  it('performs no write', async () => {
    const { client, currentStatus } = makeClient()
    const provider = new GitHubBoardProvider(client, board, { boardSource: 'repo' })

    await provider.epic({ owner: 'acme', repo: 'web', number: 1 })

    const documents = (client.graphql as unknown as { mock: { calls: [string][] } }).mock.calls.map((c) => c[0])
    expect(documents.some((d) => /\bmutation\b/.test(d))).toBe(false)
    expect(currentStatus()).toBe('Todo')
  })
})
