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

  async getItem(ref: WorkItemRef): Promise<BoardItem> {
    return getItem(this.client, this.board, ref)
  }

  async claim(ref: WorkItemRef): Promise<BoardItem> {
    return claim(this.client, this.board, await this.survey(), ref, { dryRun: this.dryRun })
  }

  async setStatus(ref: WorkItemRef, status: string): Promise<BoardItem> {
    return setStatus(this.client, this.board, await this.survey(), ref, status, { dryRun: this.dryRun })
  }

  async create(input: CreateInput): Promise<BoardItem> {
    return createItem(this.client, this.board, await this.survey(), input, { dryRun: this.dryRun })
  }
}
