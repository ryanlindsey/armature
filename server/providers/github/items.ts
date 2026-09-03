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

// A declared body convention (round 2), not inference over free English prose (round 1).
// Round 1 tested whether the word "epic" co-occurred with a reference on a line; the
// re-reviewer broke that with a line where "epic" and an unrelated reference legitimately
// share a sentence. Testing co-occurrence can't be patched incrementally — any co-occurrence
// test admits some sentence that merely mentions both. So this recognises exactly one shape:
// the entire trimmed line reads "Epic: owner/repo#N" or "Part of: owner/repo#N"
// (case-insensitive label), with an optional leading markdown list marker and an optional
// bold wrapper around the label and/or the whole declaration. Nothing else on the line.
const DECLARATION =
  /^(?:[-*+]\s+)?(?:\*\*)?(epic|part of):(?:\*\*)?\s*([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)(?:\*\*)?$/i

// CommonMark's code-block syntaxes are a closed, enumerable set: triple-backtick fences,
// tilde (~~~) fences, and indented code blocks (4+ leading spaces, or a leading tab). Round 2
// stripped only the first; the re-reviewer reproduced the same silent wrong-epic attachment
// through the other two ("a fenced line carries no backticks of its own" applies just as
// much to a tilde fence, and .trim()-ing a line before checking indentation erases the very
// signal that marks it as code). All three are stripped before matching — an example in any
// of them is not a declaration.
//
// An unterminated fence (backtick or tilde) strips to the end of the body. The asymmetry is
// deliberate: a false negative here costs nothing — the native parent link is unaffected and
// the body fallback simply declines — while treating an unclosed fence's remainder as prose
// risks a silent wrong-epic attachment.
//
// Inline spans (single backticks) still don't need stripping: under a whole-line match, a
// backtick either sits at the very start (blocking the required label whether or not it's
// stripped, since stripping only ever turns it into nothing) or sits elsewhere (leaving
// "nothing else on the line" violated either way) — it never changes the outcome.
//
// LIMITATION: the indented-code check is a conservative per-line approximation, not full
// CommonMark. A real indented code block is a property of block *context* — for example, a
// line indented 4+ spaces inside a list item is ordinarily list-item content, not code,
// relative to the list marker's own indentation — and correctly telling those apart requires
// tracking container structure (list items, blockquotes) across lines, which this does not
// do. Any line starting with 4+ spaces or a tab is treated as code unconditionally,
// regardless of surrounding structure. Given the stated asymmetry (a false negative is free;
// a false positive is a silent wrong epic), stripping a superset of true indented code blocks
// is the safe direction, but it is an approximation, not a claim of full compliance.
function stripCodeBlocks(body: string): string {
  const kept: string[] = []
  let fence: { char: '`' | '~'; len: number } | null = null

  for (const rawLine of body.split(/\r?\n/)) {
    if (fence) {
      const closed = new RegExp(`^\\${fence.char}{${fence.len},}$`).test(rawLine.trim())
      if (closed) fence = null
      continue // fence content (and the closing delimiter itself) is never a declaration line
    }

    const open = /^(`{3,}|~{3,})/.exec(rawLine.trimStart())
    if (open) {
      const marker = open[1]!
      fence = { char: marker[0] as '`' | '~', len: marker.length }
      continue
    }

    if (/^( {4,}|\t)/.test(rawLine)) continue // indented code — checked before any trimming

    kept.push(rawLine)
  }

  return kept.join('\n')
}

function dedupe(refs: WorkItemRef[]): WorkItemRef[] {
  const byKey = new Map<string, WorkItemRef>()
  for (const ref of refs) byKey.set(`${ref.owner}/${ref.repo}#${ref.number}`, ref)
  return [...byKey.values()]
}

// The native sub-issue parent link (see getItem) always wins over this; this only runs when
// there is no parent. More than one distinct declaration disagreeing is ambiguous: refuse to
// guess and return null rather than picking one.
export function parseEpicFromBody(body: string): WorkItemRef | null {
  const found: WorkItemRef[] = []
  for (const rawLine of stripCodeBlocks(body).split('\n')) {
    const match = DECLARATION.exec(rawLine.trim())
    if (match) found.push({ owner: match[2]!, repo: match[3]!, number: Number(match[4]!) })
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
