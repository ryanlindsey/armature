import type { RepoConfig } from '../../config.js'
import type { WorkItemRef } from '../../ref.js'
import type { GitHubClient } from './client.js'

export type AliasMap = Map<string, { owner: string; repo: string }>
export type SiblingConfigReader = (owner: string, repo: string) => Promise<RepoConfig | null>

export class AliasConflictError extends Error {
  constructor(alias: string, first: string, second: string) {
    super(
      `Both ${first} and ${second} declare the alias "${alias}". An alias is a fact a repository ` +
        `states about itself, so exactly one may claim it. Change one .armature.json.`,
    )
    this.name = 'AliasConflictError'
  }
}

const CONFIG_QUERY = `
query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    object(expression:"HEAD:.armature.json"){ ... on Blob { text } }
  }
}`

export function readSiblingConfigFrom(client: GitHubClient): SiblingConfigReader {
  return async (owner, repo) => {
    const data = await client.graphql<any>(CONFIG_QUERY, { owner, name: repo })
    const text = data.repository?.object?.text
    if (!text) return null
    try {
      return JSON.parse(text) as RepoConfig
    } catch {
      return null
    }
  }
}

export async function buildAliasMap(
  read: SiblingConfigReader,
  repositories: string[],
): Promise<AliasMap> {
  const map: AliasMap = new Map()
  const claimedBy = new Map<string, string>()

  for (const full of repositories) {
    const [owner, repo] = full.split('/')
    if (!owner || !repo) continue

    const config = await read(owner, repo)
    const alias = config?.alias
    if (!alias) continue

    const existing = claimedBy.get(alias)
    if (existing && existing !== full) throw new AliasConflictError(alias, existing, full)

    claimedBy.set(alias, full)
    map.set(alias, { owner, repo })
  }
  return map
}

const ALIAS_REF = /^([A-Za-z0-9._-]+)#(\d+)$/

export function resolveAlias(map: AliasMap, token: string): WorkItemRef | null {
  const match = ALIAS_REF.exec(token.trim())
  if (!match) return null
  const target = map.get(match[1]!)
  if (!target) return null
  return { owner: target.owner, repo: target.repo, number: Number(match[2]!) }
}
