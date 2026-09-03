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

const QUALIFIED = /\b([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)\b/
const PROSE = /\bin\s+([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\s*\([^)]*?#(\d+)\)/

export function parseEpicFromBody(body: string): WorkItemRef | null {
  const match = PROSE.exec(body) ?? QUALIFIED.exec(body)
  if (!match) return null
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]!) }
}

// Rooted at repository(owner,name): structurally unable to return another repository's item.
const ITEM_QUERY = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      id number title body state
      parent{ number repository{ owner{ login } name } }
      projectItems(first:20){
        nodes{
          id
          project{ number }
          fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }
        }
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
