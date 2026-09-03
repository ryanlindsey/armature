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

  it('never puts the credential in the error', async () => {
    const err = await resolveCredential({ readCliToken: noCli, env: {} }).catch((e: Error) => e)
    expect((err as Error).message).not.toMatch(/from-cli|from-env/)
  })
})
