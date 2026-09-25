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
}
