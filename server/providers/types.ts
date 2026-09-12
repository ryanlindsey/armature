import type { BoardSource } from '../config.js'
import type { WorkItemRef } from '../ref.js'

export type BoardItem = {
  ref: WorkItemRef
  id: string
  title: string
  status: string | null
  state: 'OPEN' | 'CLOSED'
  parent: WorkItemRef | null
}

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
}

export interface BoardProvider {
  survey(): Promise<BoardSnapshot>
  getItem(ref: WorkItemRef): Promise<BoardItem>
  claim(ref: WorkItemRef): Promise<BoardItem>
  setStatus(ref: WorkItemRef, status: string): Promise<BoardItem>
  create(input: CreateInput): Promise<BoardItem>
}
