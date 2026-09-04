import { describe, expect, it } from 'vitest'
import { readCliTokenFromGh, resolveCredential } from '../../server/auth.js'
import { REPO_BOARDS_QUERY } from '../../server/config-io.js'
import { BOARD_QUERY } from '../../server/providers/github/board.js'
import { GitHubClient } from '../../server/providers/github/client.js'

// ---------------------------------------------------------------------------------------------
// The test that would have caught the shipped `owner{ login }`.
//
// Every other test in this repository hands these queries to a fake client, which answers any
// document at all — so a query GitHub rejects outright passes the whole suite. These two send
// the real document to the real schema and assert only that it is accepted; the data itself is
// whatever the configured board happens to hold. Gated like the rest of the integration suite.
// ---------------------------------------------------------------------------------------------

const enabled = process.env.ARMATURE_INTEGRATION === '1'
const owner = process.env.ARMATURE_IT_OWNER
const repo = process.env.ARMATURE_IT_REPO
const number = Number(process.env.ARMATURE_IT_BOARD ?? '0')

describe.skipIf(!enabled || !owner || !number)('queries GitHub actually accepts', () => {
  async function client() {
    const credential = await resolveCredential({ readCliToken: readCliTokenFromGh, env: process.env })
    return new GitHubClient(credential)
  }

  it('accepts REPO_BOARDS_QUERY against the live schema', async () => {
    const data = await (await client()).graphql<any>(REPO_BOARDS_QUERY, {
      owner: owner!,
      name: repo ?? owner!,
    })
    expect(data).toHaveProperty('repository')
  })

  it('accepts BOARD_QUERY against the live schema, for whichever account type owns the board', async () => {
    const data = await (await client()).graphql<any>(BOARD_QUERY, {
      owner: owner!,
      number,
      cursor: null,
    })
    expect(data.repositoryOwner?.projectV2?.id).toMatch(/^PVT_/)
  })
})
