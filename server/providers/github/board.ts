import type { BoardRef, BoardSource } from '../../config.js'
import type { BoardItem, BoardSnapshot, StatusSemantics } from '../types.js'
import { GitHubClient } from './client.js'

export function computeCollisions(items: BoardItem[]): Record<number, string[]> {
  const byNumber = new Map<number, Set<string>>()
  for (const it of items) {
    const set = byNumber.get(it.ref.number) ?? new Set<string>()
    set.add(`${it.ref.owner}/${it.ref.repo}`)
    byNumber.set(it.ref.number, set)
  }
  const collisions: Record<number, string[]> = {}
  for (const [number, repos] of byNumber) {
    if (repos.size > 1) collisions[number] = [...repos].sort()
  }
  return collisions
}

const SYNONYMS = {
  todo: ['todo', 'to do', 'backlog', 'ready', 'open'],
  claimed: ['in progress', 'in-progress', 'doing', 'wip', 'started', 'active'],
  review: ['validation', 'review', 'in review', 'qa', 'verifying'],
  done: ['done', 'shipped', 'closed', 'complete', 'completed'],
} as const

function match(options: string[], candidates: readonly string[]): string | null {
  for (const option of options) {
    if (candidates.includes(option.trim().toLowerCase())) return option
  }
  return null
}

export function inferStatusSemantics(optionNames: string[]): StatusSemantics {
  const todo = match(optionNames, SYNONYMS.todo)
  const claimed = match(optionNames, SYNONYMS.claimed)
  const done = match(optionNames, SYNONYMS.done)
  const review = match(optionNames, SYNONYMS.review)

  if (!todo || !claimed || !done) {
    throw new Error(
      `Armature could not tell which of [${optionNames.join(', ')}] mean "todo", "claimed" and ` +
        `"done". Set them in ~/.config/armature/config.json under "statuses" for this board.`,
    )
  }
  return { todo, claimed, review, done }
}

const BOARD_QUERY = `
query($owner:String!,$number:Int!,$cursor:String){
  organization(login:$owner){
    projectV2(number:$number){
      id
      field(name:"Status"){ ... on ProjectV2SingleSelectField { id options { id name } } }
      items(first:100, after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id
          fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }
          content{
            ... on Issue {
              number title state
              repository{ owner{ login } name }
              parent{ number repository{ owner{ login } name } }
            }
          }
        }
      }
    }
  }
}`

export async function surveyBoard(
  client: GitHubClient,
  board: BoardRef,
  // Not derivable from the API: which layer of the config precedence chain pointed armature at
  // this board is a fact about how armature was started, and `/armature-doctor` reports it so a
  // user can check the inference before trusting it.
  boardSource: BoardSource,
): Promise<BoardSnapshot> {
  const head = await client.graphql<any>(BOARD_QUERY, { owner: board.owner, number: board.number, cursor: null })
  const project = head.organization?.projectV2
  if (!project) throw new Error(`No project ${board.owner}/${board.number} is visible to this credential.`)

  // The first page is deliberately fetched twice — once here for the project metadata, and again
  // in collectAll below. collectAll returns only nodes, so getting the project id and status
  // options without a separate head query would require widening its signature. This approach is
  // simpler: one extra request on a survey is acceptable to keep the API clean.
  const raw = await client.collectAll<any>(
    BOARD_QUERY,
    { owner: board.owner, number: board.number },
    (d) => d.organization.projectV2.items,
  )

  const items: BoardItem[] = raw
    .filter((n) => n.content?.number != null)
    .map((n) => ({
      id: n.id,
      title: n.content.title,
      state: n.content.state,
      status: n.fieldValueByName?.name ?? null,
      ref: {
        owner: n.content.repository.owner.login,
        repo: n.content.repository.name,
        number: n.content.number,
      },
      parent: n.content.parent
        ? {
            owner: n.content.parent.repository.owner.login,
            repo: n.content.parent.repository.name,
            number: n.content.parent.number,
          }
        : null,
    }))

  const statusOptions = project.field?.options ?? []

  return {
    board: {
      provider: board.provider,
      name: `${board.owner}/${board.number}`,
      source: boardSource,
    },
    id: project.id,
    statusFieldId: project.field?.id ?? '',
    statusOptions,
    semantics: inferStatusSemantics(statusOptions.map((o: { name: string }) => o.name)),
    items,
    repositories: [...new Set(items.map((i) => `${i.ref.owner}/${i.ref.repo}`))].sort(),
    collisions: computeCollisions(items),
  }
}
