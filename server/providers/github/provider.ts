import type { BoardRef } from '../../config.js'
import type { WorkItemRef } from '../../ref.js'
import type { BoardItem, BoardProvider, BoardSnapshot, CreateInput } from '../types.js'
import { surveyBoard } from './board.js'
import type { GitHubClient } from './client.js'
import { claim, createItem, getItem, setStatus } from './items.js'

export class GitHubBoardProvider implements BoardProvider {
  private cached: BoardSnapshot | null = null

  constructor(
    private readonly client: GitHubClient,
    private readonly board: BoardRef,
    private readonly dryRun = false,
  ) {}

  // Derived facts are cached for the life of the process, never written to disk.
  async survey(): Promise<BoardSnapshot> {
    this.cached ??= await surveyBoard(this.client, this.board)
    return this.cached
  }

  /**
   * Dropped after every write. BoardSnapshot mixes two kinds of fact: the stable derived ones
   * (field identifiers, status options, status semantics) and `items`, which carries a live
   * status per item. Because they share one object, a snapshot cached across a write left
   * `board_next` returning the item it had just claimed and `board_survey` describing a board
   * that no longer existed.
   *
   * Invalidated in a `finally`, not only on success: OrphanedIssueError and
   * UnverifiedWriteError both report a write whose effect on the board is exactly what is in
   * doubt, so those are the last cases in which a cached view should be trusted. A dropped
   * cache costs one survey; a stale one costs a wrong answer delivered confidently.
   */
  private invalidate(): void {
    this.cached = null
  }

  async getItem(ref: WorkItemRef): Promise<BoardItem> {
    return getItem(this.client, this.board, ref)
  }

  async claim(ref: WorkItemRef): Promise<BoardItem> {
    const snapshot = await this.survey()
    try {
      return await claim(this.client, this.board, snapshot, ref, { dryRun: this.dryRun })
    } finally {
      this.invalidate()
    }
  }

  async setStatus(ref: WorkItemRef, status: string): Promise<BoardItem> {
    const snapshot = await this.survey()
    try {
      return await setStatus(this.client, this.board, snapshot, ref, status, { dryRun: this.dryRun })
    } finally {
      this.invalidate()
    }
  }

  async create(input: CreateInput): Promise<BoardItem> {
    const snapshot = await this.survey()
    try {
      return await createItem(this.client, this.board, snapshot, input, { dryRun: this.dryRun })
    } finally {
      this.invalidate()
    }
  }
}
