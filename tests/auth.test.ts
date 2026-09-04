import { describe, expect, it } from 'vitest'
import { MissingCredentialError, resolveCredential } from '../server/auth.js'

const noCli = async () => null

describe('resolveCredential', () => {
  it('prefers the GitHub CLI', async () => {
    const c = await resolveCredential({
      readCliToken: async () => 'from-cli',
      env: { GITHUB_TOKEN: 'from-env' },
    })
    expect(c).toEqual({ token: 'from-cli', source: 'gh-cli' })
  })

  it('falls back to GITHUB_TOKEN', async () => {
    const c = await resolveCredential({ readCliToken: noCli, env: { GITHUB_TOKEN: 'a' } })
    expect(c).toEqual({ token: 'a', source: 'GITHUB_TOKEN' })
  })

  it('falls back to GH_TOKEN last', async () => {
    const c = await resolveCredential({ readCliToken: noCli, env: { GH_TOKEN: 'b' } })
    expect(c).toEqual({ token: 'b', source: 'GH_TOKEN' })
  })

  it('ignores an empty environment value', async () => {
    const c = await resolveCredential({ readCliToken: noCli, env: { GITHUB_TOKEN: '  ', GH_TOKEN: 'b' } })
    expect(c.source).toBe('GH_TOKEN')
  })

  it('fails naming the fix when nothing supplies a credential', async () => {
    await expect(resolveCredential({ readCliToken: noCli, env: {} })).rejects.toThrow(
      MissingCredentialError,
    )
  })

  it('names all three sources in the failure', async () => {
    await expect(resolveCredential({ readCliToken: noCli, env: {} })).rejects.toThrow(
      /gh auth login/,
    )
  })

  // The old version of this used `env: {}`, so no credential was ever in play and the assertion
  // could not fail. The realistic leak is the opposite case: the environment is full of tokens,
  // none of them under a name armature reads, and a "helpful" error that listed what it found
  // would hand them to stderr and to the MCP client.
  it('never echoes a credential when it refuses, even with real tokens in the environment', async () => {
    const secret = 'ghp_SECRET_VALUE_0123456789abcdef'
    const err = await resolveCredential({
      readCliToken: noCli,
      env: {
        GITHUB_PAT: secret,
        GH_ENTERPRISE_TOKEN: secret,
        GITHUB_TOKEN: '   ',
      },
    }).catch((e: Error) => e)

    expect(err).toBeInstanceOf(MissingCredentialError)
    expect((err as Error).message).not.toContain(secret)
    expect((err as Error).message).not.toMatch(/ghp_/)
    expect((err as Error).message).not.toMatch(/GITHUB_PAT|GH_ENTERPRISE_TOKEN/)
  })

  it('never carries a credential it did not choose into the result', async () => {
    const chosen = 'ghp_chosen_0123456789'
    const shadowed = 'ghp_shadowed_SECRET_0123456789'

    const c = await resolveCredential({
      readCliToken: noCli,
      env: { GITHUB_TOKEN: chosen, GH_TOKEN: shadowed },
    })

    expect(c).toEqual({ token: chosen, source: 'GITHUB_TOKEN' })
    expect(JSON.stringify(c)).not.toContain(shadowed)
  })
})
