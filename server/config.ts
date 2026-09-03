export type BoardRef = { provider: 'github'; owner: string; number: number }

export type RepoConfig = {
  board?: BoardRef
  alias?: string
  verify?: string[]
  commit?: { convention: string; types?: string }
}

export type ResolvedConfig = {
  repo: { owner: string; name: string }
  board: BoardRef
  alias?: string
  verify: string[]
  boardSource: 'env' | 'repo' | 'user' | 'derived'
}

export type ResolveInput = {
  originUrl: string
  repoConfig: RepoConfig
  userConfig: RepoConfig
  env: Record<string, string | undefined>
  boardsContainingRepo: BoardRef[]
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const ORIGIN = /^(?:git@[^:]+:|https?:\/\/[^/]+\/)([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/

export function parseOriginUrl(url: string): { owner: string; name: string } {
  const match = ORIGIN.exec(url.trim())
  if (!match) throw new ConfigError(`Cannot read an owner and repository from origin "${url}".`)
  return { owner: match[1]!, name: match[2]! }
}

function parseEnvBoard(value: string): BoardRef {
  const match = /^github:([A-Za-z0-9._-]+)\/(\d+)$/.exec(value.trim())
  if (!match) {
    throw new ConfigError(`ARMATURE_BOARD must look like "github:owner/number", got "${value}".`)
  }
  return { provider: 'github', owner: match[1]!, number: Number(match[2]!) }
}

export function resolveConfig(input: ResolveInput): ResolvedConfig {
  const repo = parseOriginUrl(input.originUrl)

  let board: BoardRef
  let boardSource: ResolvedConfig['boardSource']

  const envBoard = input.env.ARMATURE_BOARD
  if (envBoard) {
    board = parseEnvBoard(envBoard)
    boardSource = 'env'
  } else if (input.repoConfig.board) {
    board = input.repoConfig.board
    boardSource = 'repo'
  } else if (input.userConfig.board) {
    board = input.userConfig.board
    boardSource = 'user'
  } else if (input.boardsContainingRepo.length === 1) {
    board = input.boardsContainingRepo[0]!
    boardSource = 'derived'
  } else if (input.boardsContainingRepo.length === 0) {
    throw new ConfigError(
      `No board found for ${repo.owner}/${repo.name}. Add .armature.json with a "board" key, ` +
        `or set ARMATURE_BOARD to "github:owner/number".`,
    )
  } else {
    const names = input.boardsContainingRepo.map((b) => `${b.owner}/${b.number}`).join(', ')
    throw new ConfigError(
      `${repo.owner}/${repo.name} appears on several boards (${names}). ` +
        `Name one in .armature.json under "board".`,
    )
  }

  return {
    repo,
    board,
    alias: input.repoConfig.alias,
    verify: input.repoConfig.verify ?? [],
    boardSource,
  }
}
