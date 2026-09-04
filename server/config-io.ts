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
import { redactCredentials } from './url.js'

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
    // git's stderr is echoed verbatim, and git quotes the remote URL in several of its own
    // failure messages — so this is a credential-leak path too, not just parseOriginUrl's.
    throw new ConfigError(
      `Cannot read the "origin" remote in ${cwd}: ` +
        redactCredentials(error instanceof Error ? error.message.trim() : String(error)) +
        `. Run armature from inside a git repository with an "origin" remote configured.`,
    )
  }
}

// One cheap query on the repository itself, not a survey of every project the owner has:
// this is what keeps the spec's zero-config path at a single request. It reports the boards
// linked to the repository so resolveConfig can derive one when exactly one is found, and
// name the candidates when several are.
// `owner` here is a ProjectV2Owner, an interface that declares no `login` of its own — only the
// User and Organization that implement it do. Selecting `owner{ login }` directly, as this query
// did through v0.2.0, made the whole document invalid: GitHub answered every call with
// `undefinedField`, boardsContainingRepo swallowed it, and resolveConfig reported "No board
// found" in every repository on earth. Exported so a live-schema test can send the real document
// to the real schema; a fake client accepts anything, which is how this shipped.
export const REPO_BOARDS_QUERY = `
query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    projectsV2(first:100){
      nodes{
        number
        owner{
          ... on User { login }
          ... on Organization { login }
        }
      }
    }
  }
}`

type RepoBoardsResponse = {
  repository: { projectsV2: { nodes: { number: number; owner: { login: string } }[] } } | null
}

/**
 * What asking GitHub which boards contain a repository produced.
 *
 * `problem` separates "the repository is on no board" from "armature never got an answer". They
 * were indistinguishable before — both arrived as an empty list — which is how a query GitHub
 * rejected outright presented for a whole release as ordinary missing configuration.
 */
export type BoardCandidates = { boards: BoardRef[]; problem?: string }

/**
 * The boards linked to a repository, via `repository.projectsV2`. Never throws: with no client
 * (no credential resolved yet) it reports no candidates, and a failed query is reported as a
 * `problem` for `resolveConfig` to attach to its "no board found" error rather than hide.
 */
export async function boardsContainingRepo(
  client: GitHubClient | undefined,
  repo: { owner: string; name: string },
): Promise<BoardCandidates> {
  if (!client) return { boards: [] }
  try {
    const data = await client.graphql<RepoBoardsResponse>(REPO_BOARDS_QUERY, {
      owner: repo.owner,
      name: repo.name,
    })
    const nodes = data.repository?.projectsV2.nodes ?? []
    return {
      boards: nodes.map((n) => ({
        provider: 'github' as const,
        owner: n.owner.login,
        number: n.number,
      })),
    }
  } catch (error) {
    return {
      boards: [],
      problem:
        `Armature could not ask GitHub which boards contain ${repo.owner}/${repo.name}: ` +
        redactCredentials(error instanceof Error ? error.message : String(error)),
    }
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

  // The origin failure is carried, not thrown. Origin names this repository; it does not name
  // the board when ARMATURE_BOARD or a declared board already does, and refusing to start
  // outside a git checkout in that case is a requirement armature does not actually have.
  // resolveConfig raises it — with this explanation attached — only if the board turns out to
  // need it.
  const [repoConfig, userConfig, origin] = await Promise.all([
    readRepoConfig(cwd),
    readUserConfig(home),
    readOriginUrl(cwd).then(
      (url) => ({ url, problem: undefined as string | undefined }),
      (error: unknown) => ({
        url: null,
        problem: error instanceof Error ? error.message : String(error),
      }),
    ),
  ])

  // If origin is absent or can't be parsed, boardsContainingRepo has no owner/repo to ask
  // about — resolveConfig below raises the same ConfigError, so this just avoids a doomed query.
  let candidates: BoardCandidates = { boards: [] }
  if (origin.url !== null) {
    try {
      candidates = await boardsContainingRepo(deps.client, parseOriginUrl(origin.url))
    } catch {
      // parseOriginUrl rejected the remote; resolveConfig raises the same error below.
      candidates = { boards: [] }
    }
  }

  return resolveConfig({
    originUrl: origin.url,
    originProblem: origin.problem,
    repoConfig,
    userConfig,
    env: deps.env,
    boardsContainingRepo: candidates.boards,
    boardsProblem: candidates.problem,
  })
}
