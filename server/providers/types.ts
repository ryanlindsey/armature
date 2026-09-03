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

export type CreateInput = {
  owner: string
  repo: string
  title: string
  body: string
  parent?: WorkItemRef
}

export interface BoardProvider {
  survey(): Promise<BoardSnapshot>
  getItem(ref: WorkItemRef): Promise<BoardItem>
  claim(ref: WorkItemRef): Promise<BoardItem>
  setStatus(ref: WorkItemRef, status: string): Promise<BoardItem>
  create(input: CreateInput): Promise<BoardItem>
}
