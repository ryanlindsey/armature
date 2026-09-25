import { formatRef, type WorkItemRef } from '../../ref.js'
import type { BoardSnapshot, EpicChild, EpicSurvey, LinkedPullRequest } from '../types.js'
import type { GitHubClient } from './client.js'
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
          labels(first:20){ nodes{ name } }
          blockedBy(first:10){ nodes{ number repository{ owner{ login } name } } }
          closedByPullRequestsReferences(first:10,includeClosedPrs:true){
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
      `${formatRef(ref)} does not exist, or is not visible to this credential. Nothing was read ` +
        `from the board. Check the reference, and that the credential can read that repository.`,
    )
    this.name = 'EpicNotFoundError'
  }
}

export class TruncatedEpicError extends Error {
  constructor(ref: WorkItemRef) {
    super(
      `${formatRef(ref)} has more than ${SUB_ISSUE_PAGE} sub-issues, more than one page of the ` +
        `survey holds. Reporting the first ${SUB_ISSUE_PAGE} would silently drop the rest, so ` +
        `nothing is reported. Split the epic into smaller ones.`,
    )
    this.name = 'TruncatedEpicError'
  }
}

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
  const data = await client.graphql<any>(EPIC_ENRICHMENT, {
    owner: ref.owner,
    name: ref.repo,
    number: ref.number,
  })

  const issue = data.repository?.issue
  if (!issue) throw new EpicNotFoundError(ref)
  if (issue.subIssues.pageInfo?.hasNextPage) throw new TruncatedEpicError(ref)

  const onBoard = new Map(snapshot.items.map((i) => [keyOf(i.ref), i]))

  const children: EpicChild[] = []
  const offBoard: WorkItemRef[] = []

  for (const node of issue.subIssues.nodes as any[]) {
    const childRef = refOf(node)
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

  // Working order is selectNext's: by number, numerically. The ref breaks ties so that
  // same-numbered issues in different repositories still land in a deterministic order.
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
