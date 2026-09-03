import type { GitHubClient } from '../../server/providers/github/client.js'
import { GitHubBoardProvider } from '../../server/providers/github/provider.js'
import { describeBoardProvider } from './provider.contract.js'

function issue(repo: string, number: number) {
  return {
    id: `node-${repo}-${number}`,
    fieldValueByName: { name: 'Todo' },
    content: {
      number,
      title: `Item ${number}`,
      state: 'OPEN',
      repository: { owner: { login: 'acme' }, name: repo },
      parent: null,
    },
  }
}

// Two repositories both numbering an issue 278 — the collision the incident was made of.
const nodes = [issue('web', 278), issue('api', 278), issue('web', 12)]

const boardResponse = {
  organization: {
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

const client = {
  graphql: async () => boardResponse,
  collectAll: async () => nodes,
} as unknown as GitHubClient

const board = { provider: 'github' as const, owner: 'acme', number: 1 }

describeBoardProvider('GitHubBoardProvider', async () => new GitHubBoardProvider(client, board))
