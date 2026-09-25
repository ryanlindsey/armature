import type { BoardRef } from '../../config.js'
import { formatRef, type WorkItemRef } from '../../ref.js'
import type { BoardItem, BoardSnapshot, ChecklistEntry, ChecklistRequest, CreateInput } from '../types.js'
import { applyChecks, codeMask, parseChecklist } from './checklist.js'
import { GitHubClient, GraphQLError } from './client.js'

export type ItemDetail = BoardItem & {
  body: string
  /** Task-list entries parsed from `body`. See parseChecklist for what counts as one. */
  checklist: ChecklistEntry[]
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
  /** Items this one is blocked by, from GitHub's native issue dependencies. Never null. */
  blockedBy: WorkItemRef[]
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
// tilde (~~~) fences, and indented code blocks (4+ columns of spaces and tabs, tab stops of 4). Round 2
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
// do. Any line indented 4+ columns is treated as code unconditionally,
// regardless of surrounding structure. Given the stated asymmetry (a false negative is free;
// a false positive is a silent wrong epic), stripping a superset of true indented code blocks
// is the safe direction, but it is an approximation, not a claim of full compliance.
function stripCodeBlocks(body: string): string {
  const lines = body.split(/\r?\n/)
  const mask = codeMask(body)
  return lines.filter((_, i) => !mask[i]).join('\n')
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
// prose" problem, and a fourth review found two more still open. One is now closed — codeMask
// counts indentation in CommonMark columns, so a space then a tab reaches column 4 as indented
// code. The other remains, and whoever wires this up behind the config gate must close it first:
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
//
// Exported for tests/integration/queries.integration.test.ts: `blockedBy` is new here, and a fake
// client accepts any document at all.
export const ITEM_QUERY = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      id number title body state
      parent{ number repository{ owner{ login } name } }
      blockedBy(first:50){ pageInfo{ hasNextPage } nodes{ number repository{ owner{ login } name } } }
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

  // Read tolerantly (`?.`) for the same reason epic.ts does, but never report a truncated page
  // as the whole answer: createItem verifies its blocker writes against this list.
  if (issue.blockedBy?.pageInfo?.hasNextPage) {
    throw new Error(
      `${formatRef(ref)} has more than 50 blockers, so its blockers could not be read in full.`,
    )
  }
  // A null node (an issue this credential cannot see) is dropped rather than crashing every read.
  const blockedBy: WorkItemRef[] = (issue.blockedBy?.nodes ?? []).filter(Boolean).map((n: any) => ({
    owner: n.repository.owner.login,
    repo: n.repository.name,
    number: n.number,
  }))

  return {
    ref,
    id: issue.id,
    title: issue.title,
    body: issue.body ?? '',
    checklist: parseChecklist(issue.body ?? ''),
    state: issue.state,
    status: projectItem?.fieldValueByName?.name ?? null,
    projectItemId: projectItem?.id ?? null,
    parent: epicFromLink,
    // Parent link only — see the comment above parseEpicFromBody for why the body fallback
    // is not called here in v1.
    epic: epicFromLink,
    blockedBy,
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
  /**
   * `advice` replaces the closing sentence, for a write whose target is not a board field. "Treat
   * the board as unchanged" is right for a status, where the read-back is the whole truth, and
   * wrong for an issue body, which a write may have rewritten even when the read-back disagrees.
   */
  constructor(
    ref: WorkItemRef,
    intended: string,
    observed: string | null,
    advice = 'Treat the board as unchanged and investigate before retrying.',
  ) {
    super(
      `Set ${formatRef(ref)} to "${intended}" but reading it back shows "${observed ?? 'unset'}". ` +
        advice,
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

// Exported for tests/integration/queries.integration.test.ts. A fake client accepts any document,
// so a query GitHub rejects passes the whole unit suite; only that file sends it to the real
// schema.
export const UPDATE_ISSUE_BODY = `
mutation($issue:ID!,$body:String!){
  updateIssue(input:{id:$issue,body:$body}){ issue{ id } }
}`

export async function setStatus(
  client: GitHubClient,
  board: BoardRef,
  snapshot: BoardSnapshot,
  ref: WorkItemRef,
  status: string,
  options: {
    expectStatus?: string
    dryRun?: boolean
    read?: ItemReader
    /**
     * The board item's id, for a caller that already holds the one GitHub just returned —
     * `createItem` is handed it by `addProjectV2ItemById`. Supplying it skips the read that
     * would otherwise re-derive an id the caller has, and which can be wrong: that read is
     * issue-rooted, so an add too recent to appear in the issue's project memberships reads as
     * "not on the board" for an item that is. Never skips the read-back that verifies the write.
     *
     * Refused together with `expectStatus`, which has nothing to compare without that read — a
     * staleness check silently skipped is worse than one that was never asked for.
     */
    projectItemId?: string
  } = {},
): Promise<ItemDetail> {
  const read: ItemReader = options.read ?? ((r) => getItem(client, board, r))

  const option = snapshot.statusOptions.find((o) => o.name === status)
  if (!option) {
    const names = snapshot.statusOptions.map((o) => o.name).join(', ')
    throw new Error(`This board has no status "${status}". It offers: ${names}.`)
  }

  if (options.projectItemId !== undefined && options.expectStatus !== undefined) {
    throw new Error(
      `setStatus cannot check that ${formatRef(ref)} is still "${options.expectStatus}" when it ` +
        `is given a projectItemId: the check reads the item, and supplying the id is what skips ` +
        `that read. Ask for one or the other.`,
    )
  }

  // A dry run always takes the reading path, whether or not an id was supplied: it has to report
  // the item as it stands, and nothing below this line may run without a read that returned.
  let itemId = options.projectItemId
  if (itemId === undefined || options.dryRun) {
    const before = await read(ref)
    if (before.projectItemId === null) throw new NotOnBoardError(ref, board)

    if (options.expectStatus !== undefined && before.status !== options.expectStatus) {
      throw new StaleItemError(ref, options.expectStatus, before.status)
    }

    if (options.dryRun) return { ...before, status }

    itemId = before.projectItemId
  }

  await client.graphql(SET_STATUS, {
    project: snapshot.id,
    item: itemId,
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

/**
 * Set the state of checklist entries on an item's body.
 *
 * The body is read here rather than taken from the caller, and that is the whole concurrency
 * story. GitHub has no per-entry API and updateIssue accepts no If-Match, so this is a
 * read-modify-write on prose a person also edits. Reading immediately before writing means an
 * edit made elsewhere in the body is preserved rather than clobbered, and an edit to a
 * criterion's own text fails loud through applyChecks instead of writing to the wrong line.
 * The residual read-to-write race is unpreventable; it is caught by the read-back below, not
 * prevented.
 *
 * The mutation is skipped entirely when no state differs, so an all-idempotent batch is two
 * reads and no write. The read-back still runs: "already held" is a claim about the first read,
 * and is verified like any other.
 */
export async function checkEntries(
  client: GitHubClient,
  board: BoardRef,
  ref: WorkItemRef,
  requests: ChecklistRequest[],
  options: { dryRun?: boolean; read?: ItemReader } = {},
): Promise<ItemDetail> {
  const read: ItemReader = options.read ?? ((r) => getItem(client, board, r))

  const before = await read(ref)
  // Runs on both paths, above the dry-run branch, so a dry run raises exactly what a real run
  // would. A dry-run prediction that does not match the real path is the recurring bug here.
  const { body, changed } = applyChecks(ref, before.body, requests)

  if (options.dryRun) return { ...before, body, checklist: parseChecklist(body) }

  if (changed > 0) await client.graphql(UPDATE_ISSUE_BODY, { issue: before.id, body })

  const after = await read(ref)
  const box = (checked: boolean) => (checked ? '[x]' : '[ ]')
  for (const request of requests) {
    const entry = after.checklist.find((e) => e.text === request.text)
    if (!entry || entry.checked !== request.checked) {
      throw new UnverifiedWriteError(
        ref,
        `${box(request.checked)} ${request.text}`,
        entry ? `${box(entry.checked)} ${entry.text}` : `no entry "${request.text}"`,
        `The body ${changed > 0 ? 'was sent, and may or may not have landed' : 'was not rewritten'}. ` +
          `Run item_get on ${formatRef(ref)} to see its checklist as it stands before retrying.`,
      )
    }
  }
  return after
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
// off the board entirely, while this item is on it and its status is the part in doubt. Telling
// a reader to "add it to the board" here would send them after a problem they do not have.
//
// Which is why the message stops at what armature did and does not say where the status ended
// up. This error is thrown precisely when that write could not be confirmed — the cause may be a
// refused mutation, or a read-back showing some other status entirely — and a sentence asserting
// "the item has no status" would be the same unobserved claim the tool is being fixed for. It
// names the read that settles it instead.
export class StatuslessItemError extends Error {
  constructor(ref: WorkItemRef, status: string, cause: string) {
    super(
      `Created ${formatRef(ref)} and added it to the board, but could not set its status to ` +
        `"${status}": ${cause} Its status is unconfirmed, so board_next may not return it. ` +
        `Read it with item_get, set it with item_status, or close the issue.`,
    )
    this.name = 'StatuslessItemError'
  }
}

// The parent could not be resolved, so nothing was attempted. Deliberately raised before
// CREATE_ISSUE rather than after: a mistyped epic is the likeliest way this argument goes wrong
// and it is knowable up front, so discovering it later would leave a real issue behind for a
// typo — and the repair for that is a deletion, not a retry.
export class MissingParentError extends Error {
  constructor(parent: WorkItemRef, into: { owner: string; repo: string }) {
    super(
      `Cannot link a new ${into.owner}/${into.repo} issue to ${formatRef(parent)}: that issue ` +
        `does not exist, or is not visible to this credential. Nothing was created. Check the ` +
        `reference, or create the epic first.`,
    )
    this.name = 'MissingParentError'
  }
}

// The fourth end state, and the one the other three do not describe. The issue exists, is on the
// board, and carries the status it was filed in — it is findable and workable, and every repair the
// other two errors name has already happened. The only thing missing is the epic link, so that is
// the only thing this message asks anyone to fix.
//
// It is emphatically not OrphanedIssueError, whose "orphan" is a different detachment entirely:
// that item is off the board and untracked. This one is tracked and merely parentless, which is
// why the word does not appear here.
//
// Like StatuslessItemError, the message stops at what armature observed. The link is exactly what
// is in doubt — the cause may be a refused mutation or a read-back showing some other parent — so
// `cause` carries whichever it was rather than this sentence asserting an end state nobody saw.
//
// `unwritten` is the blockers that were asked for too: they are written after the link, so a
// failed link means none of them was attempted, and "only its epic is unset" would be false.
export class UnlinkedItemError extends Error {
  constructor(ref: WorkItemRef, parent: WorkItemRef, cause: string, unwritten: WorkItemRef[] = []) {
    const also = unwritten.length
      ? `its epic is unset, and it is not yet marked blocked by ${unwritten.map(formatRef).join(', ')} ` +
        `— the blocker links come after the parent link and were not attempted. Until the parent ` +
        `is set it reads as a parentless item. Set the parent and add those blockers on the issue ` +
        `itself`
      : `only its epic is unset, so until it is set it reads as a parentless item. Set the parent ` +
        `on the issue itself`
    super(
      `Created ${formatRef(ref)}, added it to the board and set its status, but could not link ` +
        `it to ${formatRef(parent)}: ${cause} The item is real and workable; ${also} — do not ` +
        `call item_create again, which would create a second issue.`,
    )
    this.name = 'UnlinkedItemError'
  }
}

// Checked before anything is created, including under dry run: it needs no network, and a dry
// run that predicted success for a call the real path refuses would be the dry-run lie again.
export class UnknownStatusError extends Error {
  constructor(status: string, offered: string[]) {
    super(
      `This board has no status "${status}", so nothing was created. It offers: ` +
        `${offered.join(', ')}. Status names are matched exactly, including case.`,
    )
    this.name = 'UnknownStatusError'
  }
}

// MissingParentError's twin, for the same reason: a mistyped blocker is knowable before any write.
export class MissingBlockerError extends Error {
  constructor(blocker: WorkItemRef, into: { owner: string; repo: string }) {
    super(
      `Cannot mark a new ${into.owner}/${into.repo} issue as blocked by ${formatRef(blocker)}: ` +
        `that issue does not exist, or is not visible to this credential. Nothing was created. ` +
        `Check the reference, or create the blocker first.`,
    )
    this.name = 'MissingBlockerError'
  }
}

// The fifth end state. Everything before the blockers is confirmed, so this names only them —
// which landed and which did not — and, like UnlinkedItemError, asserts nothing it did not read.
export class UnsequencedItemError extends Error {
  constructor(
    ref: WorkItemRef,
    parent: WorkItemRef | null,
    missing: WorkItemRef[],
    confirmed: WorkItemRef[],
    cause: string,
  ) {
    const list = (refs: WorkItemRef[]) => (refs.length ? refs.map(formatRef).join(', ') : 'none')
    super(
      `Created ${formatRef(ref)}, added it to the board, set its status` +
        (parent ? ` and linked it to ${formatRef(parent)}` : '') +
        `, but could not confirm it is blocked by ${list(missing)}: ${cause} ` +
        `Confirmed blockers: ${list(confirmed)}. The item is real and on the board, but not yet ` +
        `sequenced: until the missing blockers are added, nothing marks it as waiting. Add them ` +
        `on the issue itself — do not call item_create again, which would create a second issue.`,
    )
    this.name = 'UnsequencedItemError'
  }
}

const REPO_ID = `query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ id } }`

// Rooted at repository(owner,name) for the same reason ITEM_QUERY is: it cannot return another
// repository's issue, so the node id it yields belongs to the reference the caller actually gave.
//
// Exported for tests/integration/queries.integration.test.ts. A fake client accepts any document
// at all, so nothing else in this repository can tell a query GitHub would reject from one it
// would not — which is how an invalid `owner{ login }` selection once shipped.
export const PARENT_ID = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ issue(number:$number){ id } }
}`

/**
 * An issue's node id, or null when it does not exist or is not visible.
 *
 * GitHub answers a missing repository or issue with a NOT_FOUND error, which GitHubClient raises
 * before any null reaches the caller — so checking the data for null alone left MissingParentError
 * and MissingBlockerError unreachable against the real API, surfacing a raw GraphQLError that names
 * neither the reference nor the fix. Translated here, as epic.ts does for EpicNotFoundError. Any
 * other failure passes through unchanged.
 */
async function issueNodeId(client: GitHubClient, ref: WorkItemRef): Promise<string | null> {
  try {
    const found = await client.graphql<any>(PARENT_ID, {
      owner: ref.owner,
      name: ref.repo,
      number: ref.number,
    })
    return (found.repository?.issue?.id as string | undefined) ?? null
  } catch (error) {
    if (error instanceof GraphQLError && error.types.includes('NOT_FOUND')) return null
    throw error
  }
}

const CREATE_ISSUE = `
mutation($repo:ID!,$title:String!,$body:String!){
  createIssue(input:{repositoryId:$repo,title:$title,body:$body}){ issue{ id number } }
}`

const ADD_TO_BOARD = `
mutation($project:ID!,$content:ID!){
  addProjectV2ItemById(input:{projectId:$project,contentId:$content}){ item{ id } }
}`

// `issueId` is the PARENT and `subIssueId` the child — the naming reads backwards, and swapping
// them is not an error GitHub reports: it files the epic underneath the ticket just created,
// inverting the hierarchy board_next ranks by. The variables are named for what they mean here.
//
// The payload is selected but never trusted as proof: verification is an independent read-back
// through `read`, exactly as setStatus does. A mutation that returns is not a link the board
// shows, and reporting the second from the first is the half-effect this capability was removed
// for in v1.
//
// `replaceParent` is not sent. It exists to move a sub-issue that already has a parent, and this
// issue was created moments ago — asking to replace a parent that cannot exist would be claiming
// a case this path does not have.
// Exported for the same reason as PARENT_ID above, and with more at stake: this is the only
// mutation document in the codebase no unit test can validate, because the fake client answers
// whatever it is sent. See queries.integration.test.ts for how it is checked without linking
// anything.
export const ADD_SUB_ISSUE = `
mutation($parent:ID!,$child:ID!){
  addSubIssue(input:{issueId:$parent,subIssueId:$child}){ subIssue{ id } }
}`

// `issueId` is the item that WAITS and `blockingIssueId` the one it waits on. Swapping them is
// not an error GitHub reports: it inverts the sequence. The variables are named for what they mean.
// Exported for queries.integration.test.ts, which checks it without blocking anything.
export const ADD_BLOCKED_BY = `
mutation($blocked:ID!,$blocker:ID!){
  addBlockedBy(input:{issueId:$blocked,blockingIssueId:$blocker}){ issue{ id } }
}`

/** Case-insensitive on owner and repository, like sameRef: GitHub canonicalises both. */
function distinctRefs(refs: WorkItemRef[]): WorkItemRef[] {
  const byKey = new Map<string, WorkItemRef>()
  for (const ref of refs) {
    const k = formatRef(ref).toLowerCase()
    if (!byKey.has(k)) byKey.set(k, ref)
  }
  return [...byKey.values()]
}

/**
 * Whether a read-back's parent is the one that was asked for.
 *
 * Owner and repository are compared case-insensitively because GitHub canonicalises them: a
 * caller who writes `Acme/Web#9` is answered with `acme/web#9`, and treating that as a different
 * epic would raise UnlinkedItemError over a link that landed perfectly. The number is exact —
 * it is the part that cannot be spelled two ways.
 */
function sameRef(a: WorkItemRef | null, b: WorkItemRef): boolean {
  if (!a) return false
  return (
    a.number === b.number &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  )
}

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
  // less. The real path creates the issue, adds it to the board, sets the requested status (the
  // board's todo status by default), links the parent and then the blockers if they were asked
  // for, and returns the verified read-back — so a fresh item has that status, the epic it was
  // asked for or none at all, and exactly the blockers it was asked for.
  //
  // This value has been wrong in both directions. It once reported `snapshot.semantics.todo` and
  // the requested parent as an attached epic, against a real path that set neither; the fix
  // pinned both to `null`, correct then and an understatement now that the real path does set the
  // status and does attach the epic. Whichever way it drifts, the failure is the same one: a
  // caller acts on a prediction of an effect that does not match what happens without the flag.
  //
  // Reporting the requested parent here is not the old lie returning. The old one predicted an
  // attachment against a path that issued no mutation; this one predicts an attachment the path
  // below performs and verifies — and the prediction is held to that by a test comparing the two
  // results directly, rather than by this comment.
  //
  // The requested status and blockers are predicted on the same footing: the real path sets and
  // verifies both, so the dry run reports what was asked for — and refuses an unknown status
  // exactly as the real path does, because that check needs no network.
  const status = input.status ?? snapshot.semantics.todo
  if (!snapshot.statusOptions.some((o) => o.name === status)) {
    throw new UnknownStatusError(status, snapshot.statusOptions.map((o) => o.name))
  }
  const blockers = distinctRefs(input.blockedBy ?? [])

  if (options.dryRun) {
    return {
      ref, id: '(dry-run)', title: input.title, body: input.body,
      checklist: parseChecklist(input.body), state: 'OPEN',
      status, projectItemId: '(dry-run)',
      parent: input.parent ?? null, epic: input.parent ?? null,
      blockedBy: blockers,
    }
  }

  const repo = await client.graphql<any>(REPO_ID, { owner: input.owner, name: input.repo })

  // Resolved before anything is created. The node id is needed either way, and asking for it
  // first turns the commonest mistake — a parent that does not exist — into a refusal that
  // leaves no issue behind. See MissingParentError.
  //
  // The reference and the id it resolved to are carried as one value rather than two nullables,
  // so the link step below cannot be reached holding one without the other.
  let link: { ref: WorkItemRef; id: string } | null = null
  if (input.parent) {
    const id = await issueNodeId(client, input.parent)
    if (!id) throw new MissingParentError(input.parent, input)
    link = { ref: input.parent, id }
  }

  // Resolved before anything is created, for the reason the parent is. See MissingBlockerError.
  const blocking: { ref: WorkItemRef; id: string }[] = []
  for (const blocker of blockers) {
    const id = await issueNodeId(client, blocker)
    if (!id) throw new MissingBlockerError(blocker, input)
    blocking.push({ ref: blocker, id })
  }

  const created = await client.graphql<any>(CREATE_ISSUE, {
    repo: repo.repository.id,
    title: input.title,
    body: input.body,
  })

  const number = created.createIssue.issue.number as number
  const contentId = created.createIssue.issue.id as string
  const madeRef = { owner: input.owner, repo: input.repo, number }

  let added: any
  try {
    added = await client.graphql<any>(ADD_TO_BOARD, { project: snapshot.id, content: contentId })
  } catch (error) {
    throw new OrphanedIssueError(madeRef, error instanceof Error ? error.message : String(error))
  }

  // Adding an item to a board sets no Status field, and `board_next` only ever returns items in
  // the board's todo status — so without this write the item armature just created is one no
  // selector can reach. `setStatus` rather than a bare mutation because a status this path does
  // not verify is the same silent half-effect in a new place.
  //
  // The board item's id comes from the add that just returned it, so `setStatus` is spared the
  // read that would otherwise re-derive it. That read is issue-rooted, and an issue's project
  // memberships need not reflect an add this recent: it can report the item GitHub has just
  // placed on the board as not being on it, which would surface here as advice to add an item
  // that is already added. The read-back that verifies the write still happens.
  let withStatus: ItemDetail
  try {
    withStatus = await setStatus(client, board, snapshot, madeRef, status, {
      read,
      projectItemId: added.addProjectV2ItemById.item.id as string,
    })
  } catch (error) {
    throw new StatuslessItemError(
      madeRef,
      status,
      error instanceof Error ? error.message : String(error),
    )
  }

  let landed = withStatus
  if (link) {
    // After the three writes that put the item on the board, and deliberately so: an item linked
    // to an epic but missing from the board is a worse half-landing than an unlinked one, and a
    // harder one to notice. By the time this runs the three states before it are confirmed, so
    // anything that goes wrong here leaves only the link unset, plus any blockers still to come —
    // which is what lets UnlinkedItemError be as specific as it is.
    //
    // Both the mutation and the read-back that proves it sit inside one try: a link armature could
    // not confirm is reported the same way as one the server refused, because the board is in the
    // same state either way — unknown. Returning `linked` rather than `withStatus` means the parent
    // a caller sees is the one the board reported, never the one they asked for.
    try {
      await client.graphql(ADD_SUB_ISSUE, { parent: link.id, child: contentId })
      const linked = await read(madeRef)
      if (!sameRef(linked.parent, link.ref)) {
        throw new Error(
          `reading it back shows ${linked.parent ? formatRef(linked.parent) : 'no parent'}.`,
        )
      }
      landed = linked
    } catch (error) {
      throw new UnlinkedItemError(
        madeRef,
        link.ref,
        error instanceof Error ? error.message : String(error),
        blockers,
      )
    }
  }

  if (blocking.length === 0) return landed

  // Fifth and last: a missing blocker link is the mildest half-landing — selectNext does not read
  // blockedBy, and working-the-board still reads the prose "Depends on" line. Every mutation is
  // attempted, then one read-back judges the whole set, so the error can say exactly which landed.
  const refused = new Map<WorkItemRef, string>()
  for (const b of blocking) {
    try {
      await client.graphql(ADD_BLOCKED_BY, { blocked: contentId, blocker: b.id })
    } catch (error) {
      refused.set(b.ref, error instanceof Error ? error.message : String(error))
    }
  }
  const refusals = [...refused].map(([r, why]) => `${formatRef(r)} was refused: ${why}`)

  let after: ItemDetail
  try {
    after = await read(madeRef)
  } catch (error) {
    const why = `reading it back failed: ${error instanceof Error ? error.message : String(error)}`
    throw new UnsequencedItemError(
      madeRef, link?.ref ?? null, blockers, [], `${[...refusals, why].join('; ')}.`,
    )
  }
  const confirmed = blockers.filter((b) => after.blockedBy.some((a) => sameRef(a, b)))
  const missing = blockers.filter((b) => !confirmed.includes(b))
  if (missing.length === 0) return after
  // Every missing blocker gets its own reason: refused outright, or accepted and then not shown.
  const unshown = missing.filter((b) => !refused.has(b))
  const reasons = [
    ...refusals,
    ...(unshown.length ? [`reading it back does not show ${unshown.map(formatRef).join(', ')}`] : []),
  ]
  throw new UnsequencedItemError(madeRef, link?.ref ?? null, missing, confirmed, `${reasons.join('; ')}.`)
}
