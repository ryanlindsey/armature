import { GraphQLError } from '../../server/providers/github/client.js'
import type { GitHubClient } from '../../server/providers/github/client.js'
import { GitHubBoardProvider } from '../../server/providers/github/provider.js'
import { describeBoardProvider } from './provider.contract.js'

// Titles carry the repository, so an item fetched for the wrong repository is detectable — see
// the contract's precondition, which requires colliding items to be distinguishable.
function issue(repo: string, number: number, parent: { repo: string; number: number } | null = null) {
  return {
    id: `PVTI-${repo}-${number}`,
    fieldValueByName: { name: 'Todo' },
    content: {
      number,
      title: `${repo} item ${number}`,
      state: 'OPEN',
      repository: { owner: { login: 'acme' }, name: repo },
      parent: parent && {
        number: parent.number,
        repository: { owner: { login: 'acme' }, name: parent.repo },
      },
    },
  }
}

// Two repositories both numbering an issue 278 — the collision the incident was made of. Both are
// children of one epic, so the epic block also sees a same-numbered pair it must keep distinct.
const EPIC = { owner: 'acme', repo: 'web', number: 1 }

// Every issue the create path's fake has filed, counted at the mutation itself — so a refusal
// that let CREATE_ISSUE through and failed afterwards still shows up as one created.
let created = 0
// An item whose body carries a task list, for the checklist block. Two entries unticked, because
// the block ticks one and then needs another to attempt a refused batch with.
const CHECKLIST = { owner: 'acme', repo: 'web', number: 40 }
const nodes = [
  issue('web', 1),
  issue('web', 278, EPIC),
  issue('api', 278, EPIC),
  issue('web', 12),
  {
    ...issue('web', 40),
    body: '## Acceptance\n\n- [ ] first criterion\n- [x] second criterion\n- [ ] third criterion\n',
  },
]

// Rooted at repositoryOwner, matching BOARD_QUERY: it resolves a user account and an
// organization alike, where `organization(login:)` fails outright on the former.
const boardResponse = {
  repositoryOwner: {
    __typename: 'Organization',
    projectV2: {
      id: 'PVT_1',
      field: {
        id: 'F_1',
        options: [
          { id: 'o1', name: 'Todo' },
          { id: 'o2', name: 'In progress' },
          { id: 'o3', name: 'Done' },
        ],
      },
      items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
    },
  },
}

// Answers the single-issue query as GitHub does — rooted at repository(owner,name) — so the
// contract's collision-resolution assertion has something real to resolve against. A fake that
// returned the board for every query could not distinguish acme/web#278 from acme/api#278.
const client = {
  graphql: async (query: string, variables: Record<string, unknown>) => {
    // --- create path: a stateful fake, so read-backs report what the mutations did ---------
    // Each handler changes `nodes` and nothing else; every read below derives from `nodes`, so a
    // read-back can only ever show what a mutation wrote, never what the caller asked for.
    const nodeId = (n: (typeof nodes)[number]) => `I-${n.content.repository.name}-${n.content.number}`

    if (query.includes('createIssue')) {
      created += 1
      // Offset so a created issue can never collide with a fixture number and change the
      // collisions the precondition and resolution tests depend on.
      const number = 1000 + created
      nodes.push({
        id: `PVTI-web-${number}`,
        fieldValueByName: null as any,
        content: {
          number, title: variables.title as string, state: 'OPEN',
          repository: { owner: { login: 'acme' }, name: 'web' }, parent: null,
        },
      } as any)
      return { createIssue: { issue: { id: `I-web-${number}`, number } } }
    }
    // UPDATE_ISSUE_BODY: the checklist write. Rewrites the body a later read reports.
    if (query.includes('updateIssue(')) {
      const node = nodes.find((n) => nodeId(n) === variables.issue)!
      ;(node as any).body = variables.body
      return { updateIssue: { issue: { id: variables.issue } } }
    }
    if (query.includes('addProjectV2ItemById')) {
      const node = nodes.find((n) => nodeId(n) === variables.content)!
      return { addProjectV2ItemById: { item: { id: node.id } } }
    }
    if (query.includes('updateProjectV2ItemFieldValue')) {
      const node = nodes.find((n) => n.id === variables.item)!
      const option = boardResponse.repositoryOwner.projectV2.field.options.find((o) => o.id === variables.option)
      ;(node as any).fieldValueByName = option ? { name: option.name } : null
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: node.id } } }
    }
    if (query.includes('addBlockedBy')) {
      const blocked = nodes.find((n) => nodeId(n) === variables.blocked)!
      const blocker = nodes.find((n) => nodeId(n) === variables.blocker)!
      ;(blocked as any).blockedBy = [
        ...((blocked as any).blockedBy ?? []),
        { number: blocker.content.number, repository: blocker.content.repository },
      ]
      return { addBlockedBy: { issue: { id: variables.blocked } } }
    }
    // REPO_ID: the repository's own node id.
    if (/repository\(owner:\$owner,name:\$name\)\{ id \}/.test(query)) {
      return { repository: { id: `R-${variables.name}` } }
    }
    // PARENT_ID, also used to resolve blockers. The real client raises GitHub's NOT_FOUND for an
    // issue that does not exist rather than returning a null, so this fake does the same.
    if (query.includes('issue(number:$number){ id }')) {
      const node = nodes.find(
        (n) => n.content.repository.name === variables.name && n.content.number === variables.number,
      )
      if (!node) {
        throw new GraphQLError(
          `Could not resolve to an Issue with the number of ${variables.number}.`,
          ['NOT_FOUND'],
        )
      }
      return { repository: { issue: { id: nodeId(node) } } }
    }

    if (!query.includes('issue(number:$number)')) return boardResponse

    // EPIC_ENRICHMENT: the epic's sub-issues, read from the same nodes the board holds.
    if (query.includes('subIssues')) {
      const epic = nodes.find(
        (n) => n.content.repository.name === variables.name && n.content.number === variables.number,
      )
      if (!epic) return { repository: { issue: null } }
      const children = nodes.filter(
        (n) =>
          n.content.parent?.repository.name === variables.name &&
          n.content.parent?.number === variables.number,
      )
      return {
        repository: {
          issue: {
            title: epic.content.title,
            subIssues: {
              nodes: children.map((n) => ({
                number: n.content.number,
                repository: n.content.repository,
                labels: { nodes: [] },
                blockedBy: { nodes: [] },
                closedByPullRequestsReferences: { nodes: [] },
              })),
            },
          },
        },
      }
    }

    const node = nodes.find(
      (n) => n.content.repository.name === variables.name && n.content.number === variables.number,
    )
    if (!node) return { repository: { issue: null } }

    return {
      repository: {
        issue: {
          id: `I-${node.content.repository.name}-${node.content.number}`,
          number: node.content.number,
          title: node.content.title,
          body: (node as any).body ?? '',
          state: node.content.state,
          parent: node.content.parent,
          blockedBy: { pageInfo: { hasNextPage: false }, nodes: (node as any).blockedBy ?? [] },
          projectItems: {
            nodes: [
              { id: node.id, project: { number: 1 }, fieldValueByName: node.fieldValueByName },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    }
  },
  collectAll: async () => nodes,
} as unknown as GitHubClient

const board = { provider: 'github' as const, owner: 'acme', number: 1 }

describeBoardProvider(
  'GitHubBoardProvider',
  async () => new GitHubBoardProvider(client, board, { boardSource: 'repo' }),
  {
    epic: EPIC,
    writes: { owner: 'acme', repo: 'web', issuesCreated: () => created },
    checklist: CHECKLIST,
  },
)
