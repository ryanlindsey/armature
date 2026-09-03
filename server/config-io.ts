import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  ConfigError,
  parseOriginUrl,
  resolveConfig,
  type BoardRef,
  type RepoConfig,
  type ResolvedConfig,
} from './config.js'
import type { GitHubClient } from './providers/github/client.js'

const run = promisify(execFile)

// The IO gathering resolveConfig itself deliberately can't do — resolveConfig stays pure and
// injectable (see config.ts), so every filesystem read, git invocation and API call needed to
// feed it lives here instead.

async function readJsonConfig(path: string): Promise<RepoConfig> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  try {
    return JSON.parse(text) as RepoConfig
  } catch (error) {
    throw new ConfigError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** `.armature.json` at the repository root. Absent is fine; malformed is not. */
export async function readRepoConfig(cwd = process.cwd()): Promise<RepoConfig> {
  return readJsonConfig(join(cwd, '.armature.json'))
}

/** `~/.config/armature/config.json`. Absent is fine; malformed is not. */
export async function readUserConfig(home = homedir()): Promise<RepoConfig> {
  return readJsonConfig(join(home, '.config', 'armature', 'config.json'))
}

/** The `origin` remote URL, read from the git repository at `cwd`. */
export async function readOriginUrl(cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await run('git', ['remote', 'get-url', 'origin'], { cwd })
    return stdout.trim()
  } catch (error) {
    throw new ConfigError(
      `Cannot read the "origin" remote in ${cwd}: ` +
        `${error instanceof Error ? error.message.trim() : String(error)}. ` +
        `Run armature from inside a git repository with an "origin" remote configured.`,
    )
  }
}

// One cheap query on the repository itself, not a survey of every project the owner has:
// this is what keeps the spec's zero-config path at a single request. It reports the boards
// linked to the repository so resolveConfig can derive one when exactly one is found, and
// name the candidates when several are.
const REPO_BOARDS_QUERY = `
query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    projectsV2(first:100){
      nodes{ number owner{ login } }
    }
  }
}`

type RepoBoardsResponse = {
  repository: { projectsV2: { nodes: { number: number; owner: { login: string } }[] } } | null
}

/**
 * The boards linked to a repository, via `repository.projectsV2`. Never throws: with no
 * client (no credential resolved yet) or a failed query, it reports no candidates and lets
 * `resolveConfig` produce its explicit "no board found" error naming the fix.
 */
export async function boardsContainingRepo(
  client: GitHubClient | undefined,
  repo: { owner: string; name: string },
): Promise<BoardRef[]> {
  if (!client) return []
  try {
    const data = await client.graphql<RepoBoardsResponse>(REPO_BOARDS_QUERY, {
      owner: repo.owner,
      name: repo.name,
    })
    const nodes = data.repository?.projectsV2.nodes ?? []
    return nodes.map((n) => ({ provider: 'github' as const, owner: n.owner.login, number: n.number }))
  } catch {
    return []
  }
}

export type ConfigIODeps = {
  env: Record<string, string | undefined>
  /** Omit when no credential has been resolved yet; the board-derivation query is then skipped. */
  client?: GitHubClient
  cwd?: string
  home?: string
}

/** Gathers every input `resolveConfig` needs and resolves it. The one impure entry point. */
export async function loadResolvedConfig(deps: ConfigIODeps): Promise<ResolvedConfig> {
  const cwd = deps.cwd ?? process.cwd()
  const home = deps.home ?? homedir()

  const [repoConfig, userConfig, originUrl] = await Promise.all([
    readRepoConfig(cwd),
    readUserConfig(home),
    readOriginUrl(cwd),
  ])

  // If origin can't even be parsed, boardsContainingRepo has no owner/repo to ask about —
  // resolveConfig below raises the same ConfigError, so this just avoids a doomed query.
  let candidates: BoardRef[] = []
  try {
    candidates = await boardsContainingRepo(deps.client, parseOriginUrl(originUrl))
  } catch {
    candidates = []
  }

  return resolveConfig({
    originUrl,
    repoConfig,
    userConfig,
    env: deps.env,
    boardsContainingRepo: candidates,
  })
}
