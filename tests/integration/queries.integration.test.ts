import { describe, expect, it } from 'vitest'
import { readCliTokenFromGh, resolveCredential } from '../../server/auth.js'
import { REPO_BOARDS_QUERY } from '../../server/config-io.js'
import { BOARD_QUERY } from '../../server/providers/github/board.js'
import { EPIC_ENRICHMENT } from '../../server/providers/github/epic.js'
import { GitHubClient } from '../../server/providers/github/client.js'
import { ADD_SUB_ISSUE, PARENT_ID } from '../../server/providers/github/items.js'

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

// `repo` joins the skip guard rather than defaulting to `owner`. The fallback made an unset
// variable indistinguishable from a configured one, and sent `<owner>/<owner>` to the API — a
// repository nobody had named, failing on a message that pointed at the board rather than at the
// missing variable. Unconfigured now skips, in the same shape as the other three.
describe.skipIf(!enabled || !owner || !number || !repo)('queries GitHub actually accepts', () => {
  async function client() {
    const credential = await resolveCredential({ readCliToken: readCliTokenFromGh, env: process.env })
    return new GitHubClient(credential)
  }

  it('accepts REPO_BOARDS_QUERY against the live schema', async () => {
    const data = await (await client()).graphql<any>(REPO_BOARDS_QUERY, {
      owner: owner!,
      name: repo!,
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

  it('accepts PARENT_ID against the live schema and returns a node id for a real issue', async () => {
    const board = await (await client()).graphql<any>(BOARD_QUERY, {
      owner: owner!,
      number,
      cursor: null,
    })

    // Any issue on the configured board will do: this checks the document, not the issue.
    const content = board.repositoryOwner?.projectV2?.items?.nodes?.find(
      (n: any) => n?.content?.number != null,
    )?.content
    expect(content, 'the integration board must hold at least one issue').toBeDefined()

    const data = await (await client()).graphql<any>(PARENT_ID, {
      owner: content.repository.owner.login,
      name: content.repository.name,
      number: content.number,
    })
    expect(data.repository?.issue?.id).toMatch(/^I_/)
  })

  it('accepts EPIC_ENRICHMENT against the live schema', async () => {
    const board = await (await client()).graphql<any>(BOARD_QUERY, {
      owner: owner!,
      number,
      cursor: null,
    })
    const content = board.repositoryOwner?.projectV2?.items?.nodes?.find(
      (n: any) => n?.content?.number != null,
    )?.content
    expect(content, 'the integration board must hold at least one issue').toBeDefined()

    const data = await (await client()).graphql<any>(EPIC_ENRICHMENT, {
      owner: content.repository.owner.login,
      name: content.repository.name,
      number: content.number,
    })
    // Any issue will do: this checks the document, not the issue. subIssues may legitimately be empty.
    expect(data.repository?.issue?.subIssues?.nodes).toBeDefined()
  })

  // -------------------------------------------------------------------------------------------
  // The one mutation this suite can check without performing it.
  //
  // GraphQL validates a document in full before executing any of it, so a request that reaches
  // execution has already proved its field names, argument names and types against the live
  // schema. Sending ADD_SUB_ISSUE with node ids that resolve to nothing therefore exercises
  // exactly the half that matters here — is this document one GitHub accepts — and stops before
  // the half that would file a real issue under a real epic on somebody's board.
  //
  // The distinction the assertion rests on: a misspelled field or a renamed input argument comes
  // back as a validation error naming that field, never as NOT_FOUND. So NOT_FOUND is the pass.
  // Only this document's shape is covered — that `issueId` is the parent and `subIssueId` the
  // child is a semantic fact no schema check can see, and is asserted in items-create.test.ts.
  // -------------------------------------------------------------------------------------------
  it('accepts ADD_SUB_ISSUE against the live schema, without linking anything', async () => {
    const unresolvable = 'I_kwDOAAAAAAAAAAAAAAAAAA'

    const error = await (await client())
      .graphql<any>(ADD_SUB_ISSUE, { parent: unresolvable, child: unresolvable })
      .then(() => null)
      .catch((e: Error) => e)

    expect(error, 'a mutation on unresolvable ids must not succeed').not.toBeNull()
    // Execution was reached, so the document validated. A schema rejection reads very differently.
    expect(error!.message).toMatch(/could not resolve to a node/i)
    expect(error!.message).not.toMatch(/doesn't exist|does not exist on type|unknown argument/i)
  })
})
