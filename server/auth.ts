import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type CredentialSource = 'gh-cli' | 'GITHUB_TOKEN' | 'GH_TOKEN'
export type Credential = { token: string; source: CredentialSource }

export type CredentialDeps = {
  readCliToken: () => Promise<string | null>
  env: Record<string, string | undefined>
}

export class MissingCredentialError extends Error {
  constructor() {
    super(
      'No GitHub credential available. Armature reads one from the GitHub CLI first, then ' +
        'GITHUB_TOKEN, then GH_TOKEN. Run `gh auth login`, or export one of those variables. ' +
        'The credential needs the `repo` and `project` scopes, so it must be a classic token: ' +
        'a fine-grained one cannot reach a user-owned board at any permission level.',
    )
    this.name = 'MissingCredentialError'
  }
}

export async function readCliTokenFromGh(): Promise<string | null> {
  try {
    const { stdout } = await run('gh', ['auth', 'token'])
    const value = stdout.trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

export async function resolveCredential(deps: CredentialDeps): Promise<Credential> {
  const fromCli = await deps.readCliToken()
  if (fromCli && fromCli.trim().length > 0) return { token: fromCli.trim(), source: 'gh-cli' }

  for (const source of ['GITHUB_TOKEN', 'GH_TOKEN'] as const) {
    const value = deps.env[source]
    if (value && value.trim().length > 0) return { token: value.trim(), source }
  }

  throw new MissingCredentialError()
}
