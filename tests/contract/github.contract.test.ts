import type { GitHubClient } from '../../server/providers/github/client.js'
import { GitHubBoardProvider } from '../../server/providers/github/provider.js'
import { describeBoardProvider } from './provider.contract.js'

// Titles carry the repository, so an item fetched for the wrong repository is detectable — see
// the contract's precondition, which requires colliding items to be distinguishable.
function issue(repo: string, number: number) {
  return {
    id: `PVTI-${repo}-${number}`,
    fieldValueByName: { name: 'Todo' },
    content: {
      number,
      title: `${repo} item ${number}`,
      state: 'OPEN',
      repository: { owner: { login: 'acme' }, name: repo },
      parent: null,
    },
  }
}

// Two repositories both numbering an issue 278 — the collision the incident was made of.
const nodes = [issue('web', 278), issue('api', 278), issue('web', 12)]

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
    if (!query.includes('issue(number:$number)')) return boardResponse

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
          body: '',
          state: node.content.state,
          parent: node.content.parent,
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
)
