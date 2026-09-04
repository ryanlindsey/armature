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

export type BoardSnapshot = {
  id: string
  statusFieldId: string
  statusOptions: { id: string; name: string }[]
  semantics: StatusSemantics
  items: BoardItem[]
  repositories: string[]
  collisions: Record<number, string[]>
}

// No `parent`: creating an issue and linking it to an epic are two operations, and v1 performs
// only the first. A provider that accepted a parent it could not attach would report a success
// the board does not show — see UnsupportedParentError in server/index.ts.
export type CreateInput = {
  owner: string
  repo: string
  title: string
  body: string
}

export interface BoardProvider {
  survey(): Promise<BoardSnapshot>
  getItem(ref: WorkItemRef): Promise<BoardItem>
  claim(ref: WorkItemRef): Promise<BoardItem>
  setStatus(ref: WorkItemRef, status: string): Promise<BoardItem>
  create(input: CreateInput): Promise<BoardItem>
}
