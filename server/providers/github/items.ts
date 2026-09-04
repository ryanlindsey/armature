import type { BoardRef } from '../../config.js'
import { formatRef, type WorkItemRef } from '../../ref.js'
import type { BoardItem, BoardSnapshot, CreateInput } from '../types.js'
import { GitHubClient } from './client.js'

export type ItemDetail = BoardItem & {
  body: string
  projectItemId: string | null
  /**
   * The epic this item belongs to.
   *
   * In v1 this is always identical to `parent`, by design rather than by accident: the epic is
   * derived from GitHub's native sub-issue parent link and from nothing else, because
   * parseEpicFromBody — the spec's declared body-convention fallback — is deliberately not
   * wired in (see the comment above it). The two fields stay separate because they answer
   * different questions: `parent` is whatever the tracker links, `epic` is what armature
   * considers the owning epic. They diverge as soon as the body fallback is gated behind
   * configuration, and under a tracker with no sub-issues `parent` would be null while `epic`
   * is not.
   */
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

// SPEC FALLBACK — NOT WIRED INTO getItem IN v1.
//
// This implements the spec's "optional declared pattern": a body-convention fallback for
// locating an item's epic when there is no native sub-issue parent link. It is deliberately
// not called from getItem below. The spec describes this fallback as opt-in, and v1 has no
// configuration plumbing to gate it behind — that arrives with config-io.ts in Task 12.
// Shipping it always-on was tried and rejected: three rounds of review each narrowed a
// different hole in what turned out to be an unbounded "distinguish decorative content from
// prose" problem, and a fourth review found two more still open, which whoever wires this up
// behind the config gate must close first:
//   - indentation that only reaches 4+ columns after CommonMark's tab-stop expansion (e.g. a
//     line starting with two spaces then a tab) is not recognised as indented code — the
//     current check is the literal `/^( {4,}|\t)/` in stripCodeBlocks, not a tab-stop-aware
//     column count.
//   - HTML blocks (e.g. `<pre>Epic: acme/web#1</pre>`) are not stripped at all; only the three
//     Markdown code-block syntaxes (fenced by backticks, fenced by tildes, indented) are.
// Until that gate exists, do not call this from getItem or any other live read path.
//
// The grammar itself is sound and fully reviewed: the entire trimmed line must read
// "Epic: owner/repo#N" or "Part of: owner/repo#N" (see DECLARATION above), and more than one
// distinct declaration disagreeing is ambiguous — refuse to guess and return null rather than
// picking one.
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
    // Parent link only — see the comment above parseEpicFromBody for why the body fallback
    // is not called here in v1.
    epic: epicFromLink,
  }
}

export type ItemReader = (ref: WorkItemRef) => Promise<ItemDetail>

export class StaleItemError extends Error {
  constructor(ref: WorkItemRef, expected: string, found: string | null) {
    super(
      `${formatRef(ref)} was expected to be "${expected}" but is "${found ?? 'unset'}". ` +
        `Someone or something else moved it. Armature made no change.`,
    )
    this.name = 'StaleItemError'
  }
}

export class UnverifiedWriteError extends Error {
  constructor(ref: WorkItemRef, intended: string, observed: string | null) {
    super(
      `Set ${formatRef(ref)} to "${intended}" but reading it back shows "${observed ?? 'unset'}". ` +
        `Treat the board as unchanged and investigate before retrying.`,
    )
    this.name = 'UnverifiedWriteError'
  }
}

const SET_STATUS = `
mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){
  updateProjectV2ItemFieldValue(input:{
    projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}
  }){ projectV2Item { id } }
}`

export async function setStatus(
  client: GitHubClient,
  board: BoardRef,
  snapshot: BoardSnapshot,
  ref: WorkItemRef,
  status: string,
  options: { expectStatus?: string; dryRun?: boolean; read?: ItemReader } = {},
): Promise<ItemDetail> {
  const read: ItemReader = options.read ?? ((r) => getItem(client, board, r))

  const option = snapshot.statusOptions.find((o) => o.name === status)
  if (!option) {
    const names = snapshot.statusOptions.map((o) => o.name).join(', ')
    throw new Error(`This board has no status "${status}". It offers: ${names}.`)
  }

  const before = await read(ref)
  if (before.projectItemId === null) throw new NotOnBoardError(ref, board)

  if (options.expectStatus !== undefined && before.status !== options.expectStatus) {
    throw new StaleItemError(ref, options.expectStatus, before.status)
  }

  if (options.dryRun) return { ...before, status }

  await client.graphql(SET_STATUS, {
    project: snapshot.id,
    item: before.projectItemId,
    field: snapshot.statusFieldId,
    option: option.id,
  })

  const after = await read(ref)
  if (after.status !== status) throw new UnverifiedWriteError(ref, status, after.status)
  return after
}

export async function claim(
  client: GitHubClient,
  board: BoardRef,
  snapshot: BoardSnapshot,
  ref: WorkItemRef,
  options: { dryRun?: boolean; read?: ItemReader } = {},
): Promise<ItemDetail> {
  return setStatus(client, board, snapshot, ref, snapshot.semantics.claimed, {
    expectStatus: snapshot.semantics.todo,
    dryRun: options.dryRun,
    read: options.read,
  })
}

export class OrphanedIssueError extends Error {
  constructor(ref: WorkItemRef, cause: string) {
    super(
      `Created ${formatRef(ref)} but could not add it to the board: ${cause}. ` +
        `The issue exists and is not tracked. Add it to the board or close it.`,
    )
    this.name = 'OrphanedIssueError'
  }
}

// The half-landing that OrphanedIssueError does not describe. Both mean "created, then something
// failed", but they leave the board in different states and want different repairs: an orphan is
// off the board entirely, while this item is on it and merely statusless — which is invisible to
// board_next but perfectly visible to board_survey. Telling a reader to "add it to the board"
// here would send them after a problem they do not have, so it gets its own error and names the
// tool that fixes the one they do.
export class StatuslessItemError extends Error {
  constructor(ref: WorkItemRef, status: string, cause: string) {
    super(
      `Created ${formatRef(ref)} and added it to the board, but could not set its status to ` +
        `"${status}": ${cause}. The item is on the board with no status, so board_next will not ` +
        `return it. Set it with item_status, or close the issue.`,
    )
    this.name = 'StatuslessItemError'
  }
}

const REPO_ID = `query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ id } }`

const CREATE_ISSUE = `
mutation($repo:ID!,$title:String!,$body:String!){
  createIssue(input:{repositoryId:$repo,title:$title,body:$body}){ issue{ id number } }
}`

const ADD_TO_BOARD = `
mutation($project:ID!,$content:ID!){
  addProjectV2ItemById(input:{projectId:$project,contentId:$content}){ item{ id } }
}`

export async function createItem(
  client: GitHubClient,
  board: BoardRef,
  snapshot: BoardSnapshot,
  input: CreateInput,
  options: { dryRun?: boolean; read?: ItemReader } = {},
): Promise<ItemDetail> {
  const read: ItemReader = options.read ?? ((r) => getItem(client, board, r))
  const ref = { owner: input.owner, repo: input.repo, number: 0 }

  // The dry run must describe what the real path below would actually produce — no more and no
  // less. The real path creates the issue, adds it to the board, then sets the board's todo
  // status and returns the verified read-back, so a fresh item has that status and no parent.
  //
  // This value has been wrong in both directions. It once reported `snapshot.semantics.todo` and
  // the requested parent as an attached epic, against a real path that set neither; the fix
  // pinned it to `null`, correct then and an understatement now that the real path does set the
  // status. Whichever way it drifts, the failure is the same one: a caller acts on a prediction
  // of an effect that does not match what happens without the flag.
  if (options.dryRun) {
    return {
      ref, id: '(dry-run)', title: input.title, body: input.body, state: 'OPEN',
      status: snapshot.semantics.todo, projectItemId: '(dry-run)', parent: null, epic: null,
    }
  }

  const repo = await client.graphql<any>(REPO_ID, { owner: input.owner, name: input.repo })
  const created = await client.graphql<any>(CREATE_ISSUE, {
    repo: repo.repository.id,
    title: input.title,
    body: input.body,
  })

  const number = created.createIssue.issue.number as number
  const contentId = created.createIssue.issue.id as string
  const madeRef = { owner: input.owner, repo: input.repo, number }

  try {
    await client.graphql(ADD_TO_BOARD, { project: snapshot.id, content: contentId })
  } catch (error) {
    throw new OrphanedIssueError(madeRef, error instanceof Error ? error.message : String(error))
  }

  // Adding an item to a board sets no Status field, and `board_next` only ever returns items in
  // the board's todo status — so without this write the item armature just created is one no
  // selector can reach. `setStatus` rather than a bare mutation because a status this path does
  // not verify is the same silent half-effect in a new place.
  try {
    return await setStatus(client, board, snapshot, madeRef, snapshot.semantics.todo, { read })
  } catch (error) {
    throw new StatuslessItemError(
      madeRef,
      snapshot.semantics.todo,
      error instanceof Error ? error.message : String(error),
    )
  }
}
