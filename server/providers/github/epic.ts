import { formatRef, type WorkItemRef } from '../../ref.js'
import type { BoardSnapshot, EpicChild, EpicSurvey, LinkedPullRequest } from '../types.js'
import { GraphQLError, type GitHubClient } from './client.js'
import { selectNext } from './next.js'

const SUB_ISSUE_PAGE = 50

// Exported for tests/integration/queries.integration.test.ts. Everything the board itself can
// answer — membership, status, state, title — comes from the snapshot; this asks only for what it
// cannot. Verified against the live schema on 2026-09-15: blockedBy and
// closedByPullRequestsReferences both exist and both return what the loop needs.
export const EPIC_ENRICHMENT = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      title
      subIssues(first:${SUB_ISSUE_PAGE}){
        pageInfo{ hasNextPage }
        nodes{
          number
          repository{ owner{ login } name }
          labels(first:20){ pageInfo{ hasNextPage } nodes{ name } }
          blockedBy(first:10){ pageInfo{ hasNextPage } nodes{ number repository{ owner{ login } name } } }
          closedByPullRequestsReferences(first:10,includeClosedPrs:true){
            pageInfo{ hasNextPage }
            nodes{ number state url headRefName baseRefName }
          }
        }
      }
    }
  }
}`

export class EpicNotFoundError extends Error {
  constructor(ref: WorkItemRef) {
    super(
      `${formatRef(ref)} does not exist, or is not visible to this credential. Nothing on the ` +
        `board was changed. Check the reference, and that the credential can read that repository.`,
    )
    this.name = 'EpicNotFoundError'
  }
}

/**
 * One page of any connection the survey reads overflowed. Refused rather than truncated: each
 * connection feeds a row of the epic loop's ledger, and a dropped entry is a wrong row — a missing
 * open PR reads "interrupted" and the child is worked twice, a missing blocker picks the wrong base
 * branch, a missing label claims a child that needs a person.
 */
export class TruncatedEpicError extends Error {
  constructor(ref: WorkItemRef, what: string, page: number, fix: string) {
    super(
      `${formatRef(ref)} has more ${what} than one page of the epic survey holds (${page}). ` +
        `Reporting the first ${page} would silently drop the rest, so nothing is reported. ${fix}`,
    )
    this.name = 'TruncatedEpicError'
  }
}

const NESTED = [
  { field: 'labels', what: 'labels', page: 20, fix: 'Remove labels it does not need.' },
  { field: 'blockedBy', what: 'blockers', page: 10, fix: 'Remove blockers it does not need.' },
  {
    field: 'closedByPullRequestsReferences',
    what: 'linked pull requests',
    page: 10,
    fix: 'Unlink the pull requests that no longer close it.',
  },
] as const

type RefNode = { number: number; repository: { owner: { login: string }; name: string } }

const refOf = (n: RefNode): WorkItemRef => ({
  owner: n.repository.owner.login,
  repo: n.repository.name,
  number: n.number,
})

// Lower-cased for the same reason selectNext lower-cases: the ref arrives from a person or a
// model, and GitHub's own casing is what the board reports.
const keyOf = (ref: WorkItemRef) => formatRef(ref).toLowerCase()

export async function surveyEpic(
  client: GitHubClient,
  snapshot: BoardSnapshot,
  ref: WorkItemRef,
): Promise<EpicSurvey> {
  let data: any
  try {
    data = await client.graphql<any>(EPIC_ENRICHMENT, {
      owner: ref.owner,
      name: ref.repo,
      number: ref.number,
    })
  } catch (error) {
    // GitHub answers a missing repository or issue with a NOT_FOUND error, which the client raises
    // before any null reaches the check below. Translated here so a typo'd epic says what to do.
    if (error instanceof GraphQLError && error.types.includes('NOT_FOUND')) throw new EpicNotFoundError(ref)
    throw error
  }

  const issue = data.repository?.issue
  if (!issue) throw new EpicNotFoundError(ref)
  if (issue.subIssues.pageInfo?.hasNextPage) {
    throw new TruncatedEpicError(ref, 'sub-issues', SUB_ISSUE_PAGE, 'Split the epic into smaller ones.')
  }

  const onBoard = new Map(snapshot.items.map((i) => [keyOf(i.ref), i]))

  const children: EpicChild[] = []
  const offBoard: WorkItemRef[] = []

  for (const node of issue.subIssues.nodes as any[]) {
    const childRef = refOf(node)
    for (const { field, what, page, fix } of NESTED) {
      if (node[field]?.pageInfo?.hasNextPage) throw new TruncatedEpicError(childRef, what, page, fix)
    }
    const item = onBoard.get(keyOf(childRef))
    // A sub-issue the board does not hold is still a child of this epic. Reported separately
    // rather than dropped: an item that is not on the board is not work, but a child that
    // silently disappears is a child nobody ever works and nobody is told about.
    if (!item) {
      offBoard.push(childRef)
      continue
    }
    children.push({
      ref: childRef,
      title: item.title,
      status: item.status,
      state: item.state,
      labels: (node.labels?.nodes ?? []).map((l: { name: string }) => l.name),
      blockedBy: (node.blockedBy?.nodes ?? []).map(refOf),
      pullRequests: (node.closedByPullRequestsReferences?.nodes ?? []) as LinkedPullRequest[],
    })
  }

  // By number, numerically, as selectNext ranks within an epic. The ref breaks ties so that
  // same-numbered issues in different repositories land in a deterministic order — a tie-break
  // selectNext does not share, so on a tie `next` need not be `children`'s first open item.
  children.sort((a, b) => a.ref.number - b.ref.number || keyOf(a.ref).localeCompare(keyOf(b.ref)))

  // next is selectNext's answer, not a second ranking. Two rankings that could disagree is a bug
  // waiting to be written; the `because` string is the reason board_next is useful and it survives
  // into here unchanged, including when nothing is actionable.
  const chosen = selectNext(snapshot, { epic: ref })

  return {
    epic: { ref, title: issue.title },
    children,
    offBoard,
    next:
      chosen.kind === 'item'
        ? { ref: chosen.item.ref, because: chosen.because }
        : { ref: null, because: chosen.because },
  }
}
