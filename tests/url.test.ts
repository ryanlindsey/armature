import { describe, expect, it } from 'vitest'
import { isGitHubHost, redactCredentials } from '../server/url.js'

describe('redactCredentials', () => {
  it('removes userinfo from a URL', () => {
    expect(redactCredentials('https://user:ghp_SECRET@github.com/acme/web/')).toBe(
      'https://***@github.com/acme/web/',
    )
  })

  it('removes a bare token used as the username', () => {
    expect(redactCredentials('https://ghp_SECRET@github.com/acme/web.git')).toBe(
      'https://***@github.com/acme/web.git',
    )
  })

  it('leaves a credential-free URL alone', () => {
    expect(redactCredentials('https://github.com/acme/web.git')).toBe('https://github.com/acme/web.git')
  })

  it('leaves an ssh remote alone, which carries a user but never a secret', () => {
    expect(redactCredentials('git@github.com:acme/web.git')).toBe('git@github.com:acme/web.git')
  })

  it('redacts a credential anywhere in a longer message, not only at the start', () => {
    const message = redactCredentials(
      "fatal: could not read from 'https://user:ghp_SECRET@github.com/acme/web.git'",
    )
    expect(message).not.toContain('ghp_SECRET')
    expect(message).toContain('***@github.com')
  })

  it('redacts every credential in a message that carries more than one', () => {
    const message = redactCredentials(
      'tried https://a:ghp_ONE@github.com/x and https://b:ghp_TWO@github.com/y',
    )
    expect(message).not.toMatch(/ghp_/)
  })
})

describe('isGitHubHost', () => {
  it('accepts github.com', () => {
    expect(isGitHubHost('github.com')).toBe(true)
    expect(isGitHubHost('www.github.com')).toBe(true)
    expect(isGitHubHost('GitHub.com')).toBe(true)
  })

  it('accepts a host carrying userinfo or a port', () => {
    expect(isGitHubHost('user:token@github.com')).toBe(true)
    expect(isGitHubHost('github.com:443')).toBe(true)
  })

  it('refuses the trackers that share GitHub URL and remote shapes', () => {
    expect(isGitHubHost('gitea.example')).toBe(false)
    expect(isGitHubHost('codeberg.org')).toBe(false)
    expect(isGitHubHost('gitlab.com')).toBe(false)
  })

  it('refuses a host that merely ends in github.com', () => {
    expect(isGitHubHost('evilgithub.com')).toBe(false)
    expect(isGitHubHost('github.com.evil.example')).toBe(false)
  })
})
