import type { BoardRef } from '../../config.js'
import { formatRef, type WorkItemRef } from '../../ref.js'
import type { BoardItem } from '../types.js'
import { GitHubClient } from './client.js'

export type ItemDetail = BoardItem & {
  body: string
  projectItemId: string | null
  epic: WorkItemRef | null
}

export class NotOnBoardError extends Error {
  constructor(ref: WorkItemRef, board: BoardRef) {
    super(
      `${formatRef(ref)} is not on board ${board.owner}/${board.number}. Creating an issue does ` +
        `not add it to a board. Add it deliberately before working it.`,
    )
    this.name = 'NotOnBoardError'
  }
}

const QUALIFIED = /\b([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)\b/g
const PROSE = /\bin\s+([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\s*\([^)]*?#(\d+)\)/g
const EPIC_WORD = /\bepic\b/i

// An example inside a code block is not a declaration. Strip fenced blocks (which may span
// several lines) and inline spans before looking for references at all.
function stripCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
}

function referencesOnLine(line: string): WorkItemRef[] {
  const refs: WorkItemRef[] = []
  for (const m of line.matchAll(PROSE)) refs.push({ owner: m[1]!, repo: m[2]!, number: Number(m[3]!) })
  for (const m of line.matchAll(QUALIFIED)) refs.push({ owner: m[1]!, repo: m[2]!, number: Number(m[3]!) })
  return refs
}

function dedupe(refs: WorkItemRef[]): WorkItemRef[] {
  const byKey = new Map<string, WorkItemRef>()
  for (const ref of refs) byKey.set(`${ref.owner}/${ref.repo}#${ref.number}`, ref)
  return [...byKey.values()]
}

// Policy (controller's ruling on Finding 1 — a wrong epic silently reorders the work queue,
// which is worse than no epic):
//  1. Code examples don't count — strip fenced blocks and inline spans first.
//  2. A reference only counts when the word "epic" appears on the same line as it.
//  3. More than one distinct qualified reference surviving those filters is ambiguous:
//     refuse to guess and return null rather than picking one (e.g. the leftmost).
// The native sub-issue parent link (see getItem) always wins over this; this only runs when
// there is no parent.
export function parseEpicFromBody(body: string): WorkItemRef | null {
  const found: WorkItemRef[] = []
  for (const line of stripCode(body).split(/\r?\n/)) {
    if (!EPIC_WORD.test(line)) continue
    found.push(...referencesOnLine(line))
  }
  const distinct = dedupe(found)
  return distinct.length === 1 ? distinct[0]! : null
}

// Rooted at repository(owner,name): structurally unable to return another repository's item.
// projectItems is paged at 100 (GitHub's max) with pageInfo so getItem can tell a genuine
// absence from a truncated page — see the hasNextPage check below.
const ITEM_QUERY = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      id number title body state
      parent{ number repository{ owner{ login } name } }
      projectItems(first:100){
        nodes{
          id
          project{ number }
          fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }
        }
        pageInfo{ hasNextPage }
      }
    }
  }
}`

export async function getItem(
  client: GitHubClient,
  board: BoardRef,
  ref: WorkItemRef,
): Promise<ItemDetail> {
  const data = await client.graphql<any>(ITEM_QUERY, {
    owner: ref.owner,
    name: ref.repo,
    number: ref.number,
  })

  const issue = data.repository?.issue
  if (!issue) throw new Error(`${formatRef(ref)} does not exist, or is not visible to this credential.`)

  const projectItem = issue.projectItems.nodes.find(
    (n: { project: { number: number } }) => n.project.number === board.number,
  )

  // The target project can be absent from this page for two different reasons: the item
  // genuinely isn't on the board, or the item belongs to more than 100 projects and the
  // board's membership fell on a page we didn't fetch. Only the first is a real answer —
  // silently returning "not on board" for the second would be a wrong answer delivered
  // quietly. Once the project is found, further pages are irrelevant.
  if (!projectItem && issue.projectItems.pageInfo.hasNextPage) {
    throw new Error(
      `${formatRef(ref)}'s project memberships were truncated at 100 entries, so whether it is ` +
        `on board ${board.owner}/${board.number} could not be determined.`,
    )
  }

  const epicFromLink: WorkItemRef | null = issue.parent
    ? {
        owner: issue.parent.repository.owner.login,
        repo: issue.parent.repository.name,
        number: issue.parent.number,
      }
    : null

  return {
    ref,
    id: issue.id,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    status: projectItem?.fieldValueByName?.name ?? null,
    projectItemId: projectItem?.id ?? null,
    parent: epicFromLink,
    epic: epicFromLink ?? parseEpicFromBody(issue.body ?? ''),
  }
}
