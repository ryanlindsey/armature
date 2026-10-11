import type { BoardSource } from '../config.js'
import type { WorkItemRef } from '../ref.js'

export type BoardItem = {
  ref: WorkItemRef
  id: string
  title: string
  status: string | null
  state: 'OPEN' | 'CLOSED'
  parent: WorkItemRef | null
  checklist?: ChecklistEntry[]
  /**
   * An opaque token that changes whenever the item's content changes, for a caller to hand back
   * to an edit as "only if nothing has changed since I read it". Compared for equality and never
   * parsed. Optional because a tracker that reports no such token has none to give; required on
   * ItemDetail. GitHub: `Issue.updatedAt`.
   */
  version?: string
  /**
   * Items this one is blocked by. Optional because the board survey does not read them and a
   * tracker without dependencies has none to report; required on ItemDetail, and on LinkedItem,
   * since the blockers are the point of a link change's result.
   */
  blockedBy?: WorkItemRef[]
}

/**
 * An edit to an item's title and/or body. A field left out is left unchanged.
 *
 * `expectVersion` is the `version` the caller read: the edit is refused, with nothing written,
 * if the item has changed since. Required because an edit composed against an old body would
 * otherwise overwrite whatever a person wrote in between.
 */
export type ItemChange = { title?: string; body?: string; expectVersion: string }

/**
 * A change to an existing item's links.
 *
 * `parent` undefined means leave it, a ref means set or replace it, null means clear it. Not
 * guarded by a version: a link write is idempotent, so a repeat is a no-op rather than an
 * overwrite, and the prose that follows it is recomputed from the latest read.
 */
export type LinkChange = {
  addBlockedBy?: WorkItemRef[]
  removeBlockedBy?: WorkItemRef[]
  parent?: WorkItemRef | null
}

/**
 * An item after a link change, with every canonical `Depends on` line the call added or removed.
 * Lines beyond the refs the caller named are drift it repaired.
 */
export type LinkedItem = BoardItem & {
  blockedBy: WorkItemRef[]
  dependsOn: { added: WorkItemRef[]; removed: WorkItemRef[] }
}

/**
 * One task-list entry in a work item's body.
 *
 * `heading` is the nearest preceding ATX heading, and is context for the caller's judgment, not
 * a claim about meaning: the server does not decide which heading means "acceptance". Optional
 * on BoardItem because a tracker whose items are not Markdown has none to report; required on
 * ItemDetail, which is the GitHub adapter's enriched read.
 */
export type ChecklistEntry = { text: string; checked: boolean; heading: string | null }

/** One requested checklist state change, addressed by the entry's exact text. */
export type ChecklistRequest = { text: string; checked: boolean }

export type StatusSemantics = {
  todo: string
  claimed: string
  review: string | null
  done: string
}

/**
 * Which board this snapshot describes, and how armature came to be pointed at it.
 *
 * Deliberately tracker-neutral: `name` is the board as a person would say it — "acme/6" for a
 * GitHub Projects board, a project key elsewhere — because a Jira adapter has no owner and
 * number to report. `/armature-doctor`'s first line asks for exactly this pair, and without it
 * the command asked for data no tool exposed.
 */
export type BoardIdentity = {
  provider: string
  name: string
  /** Which layer of the config precedence chain supplied the board's identity. */
  source: BoardSource
}

export type BoardSnapshot = {
  board: BoardIdentity
  id: string
  statusFieldId: string
  statusOptions: { id: string; name: string }[]
  semantics: StatusSemantics
  items: BoardItem[]
  repositories: string[]
  collisions: Record<number, string[]>
}

export type CreateInput = {
  owner: string
  repo: string
  title: string
  body: string
  /**
   * The epic to file the new issue under, already resolved to a reference.
   *
   * The reasoning that kept this field off the type for v1 stands and is worth keeping in view:
   * creating an issue and linking it to an epic are two operations, and a provider that accepted
   * a parent it could not attach would report a success the board does not show. That is what
   * happened — the field was resolved through the alias resolver and then discarded, with the
   * dry run reporting an epic the real path never attached. The field returns now because the
   * second operation exists, not because the objection was wrong: an adapter implementing this
   * must attach the parent and verify the attachment by reading it back, or raise rather than
   * return. See UnlinkedItemError in providers/github/items.ts for the shape of that refusal.
   *
   * A tracker with no parent-child relation of its own has no honest way to honour this, and
   * must refuse it for the same reason v1 did rather than accept and drop it.
   */
  parent?: WorkItemRef
  /** The status to file the new item in, by name. Absent means the board's todo status. */
  status?: string
  /**
   * Items the new one is blocked by, already resolved to references. Written last of every step
   * and verified by read-back, under the same rule as `parent`: never report a link the board
   * does not show.
   */
  blockedBy?: WorkItemRef[]
}

export type LinkedPullRequest = {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  url: string
  headRefName: string
  baseRefName: string
}

export type EpicChild = {
  ref: WorkItemRef
  title: string
  status: string | null
  state: 'OPEN' | 'CLOSED'
  labels: string[]
  blockedBy: WorkItemRef[]
  pullRequests: LinkedPullRequest[]
}

export type EpicSurvey = {
  epic: { ref: WorkItemRef; title: string }
  children: EpicChild[]
  /**
   * Sub-issues of the epic that the board does not hold. Kept apart from `children` because an
   * item that is not on the board is not work, and reported at all because a child that silently
   * vanishes is a child nobody ever works and nobody is told about.
   */
  offBoard: WorkItemRef[]
  /**
   * Never null as a whole: `ref` is null when nothing is actionable, and `because` still says why.
   * A blocked result that explains itself is the reason board_next is useful.
   */
  next: { ref: WorkItemRef | null; because: string }
}

export interface BoardProvider {
  survey(): Promise<BoardSnapshot>
  getItem(ref: WorkItemRef): Promise<BoardItem>
  claim(ref: WorkItemRef): Promise<BoardItem>
  setStatus(ref: WorkItemRef, status: string): Promise<BoardItem>
  create(input: CreateInput): Promise<BoardItem>
  /**
   * An epic and its children in working order.
   *
   * Optional. An adapter that cannot report linked pull requests cannot support the epic loop
   * honestly: empty arrays would make the loop's resumption table read "interrupted" for a child
   * that is actually in flight. Declining is the correct answer.
   */
  epic?(ref: WorkItemRef): Promise<EpicSurvey>
  /**
   * Set the state of entries on the item's checklist.
   *
   * Optional, unlike every other write. A checklist embedded in Markdown prose is a GFM shape;
   * an adapter for a tracker without one should decline to implement this rather than implement
   * and throw. This differs from CreateInput.parent, which models a relation most trackers have
   * and so is a field an adapter must honour or refuse. dispatch reports the absence by name.
   */
  check?(ref: WorkItemRef, entries: ChecklistRequest[]): Promise<BoardItem>
  /**
   * Edit the item's title and/or body, only if it is still at `change.expectVersion`, and read it
   * back to verify.
   *
   * Required, unlike `check`: every tracker can edit an item's title and description, so there
   * is no honest reason for an adapter to decline. A refusal for a stale version must leave the
   * item unchanged.
   */
  update(ref: WorkItemRef, change: ItemChange): Promise<BoardItem>
  /**
   * Add or remove blockers and set, replace or clear the parent, then bring the item's
   * `Depends on` lines into step with all of its blockers, reading every change back.
   *
   * Optional, like `check` and unlike `update`: keeping prose in step with links is a
   * Markdown-body shape, and an adapter for a tracker that cannot do that declines the method
   * rather than half-implementing it — links changed with the prose left behind would make the
   * prerequisite check read a sequence that is not there. dispatch reports the absence by name.
   *
   * An adapter that implements this must report `blockedBy` from `getItem`: dispatch logs the
   * blocker change against it, and an absent list would log a change on every call.
   */
  link?(ref: WorkItemRef, change: LinkChange): Promise<LinkedItem>
}
