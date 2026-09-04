import { hostnameOf, isGitHubHost, redactCredentials } from './url.js'

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

// The host is captured on both branches, for the same reason parseRef captures it: /owner/repo is
// every forge's remote shape, and armature's client speaks to api.github.com alone.
const ORIGIN = /^(?:git@([^:/]+):|https?:\/\/([^/]+)\/)([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/

export function parseOriginUrl(url: string): { owner: string; name: string } {
  const trimmed = url.trim()
  // Every mention of the remote goes through this. An https remote may carry a credential —
  // `https://user:ghp_SECRET@github.com/acme/web/` is an ordinary GitHub URL that this pattern
  // happens not to match, thanks to the trailing slash — and these messages reach stderr and the
  // MCP client.
  const safe = redactCredentials(trimmed)

  const match = ORIGIN.exec(trimmed)
  if (!match) throw new ConfigError(`Cannot read an owner and repository from origin "${safe}".`)

  // hostnameOf, not the raw capture: the https branch's `[^/]+` takes userinfo with it.
  const host = hostnameOf(match[1] ?? match[2]!)
  if (!isGitHubHost(host)) {
    throw new ConfigError(
      `origin "${safe}" is on ${host}, which armature cannot read. Armature v1 talks to ` +
        `github.com only. Run it from a repository whose origin is on github.com, or name the ` +
        `board explicitly with ARMATURE_BOARD.`,
    )
  }

  return { owner: match[3]!, name: match[4]! }
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
