import { describe, expect, it } from 'vitest'
import { GitHubClient, MissingScopeError, RateLimitError } from '../server/providers/github/client.js'

const credential = { token: 'secret-value', source: 'gh-cli' as const }

function respond(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

describe('GitHubClient.collectAll', () => {
  it('follows every page without being asked to', async () => {
    const pages = [
      { data: { items: { nodes: ['a', 'b'], pageInfo: { hasNextPage: true, endCursor: 'c1' } } } },
      { data: { items: { nodes: ['c'], pageInfo: { hasNextPage: false, endCursor: null } } } },
    ]
    let call = 0
    const client = new GitHubClient(credential, async () => respond(pages[call++]!))

    const all = await client.collectAll<string>('query', {}, (d) => d.items)

    expect(all).toEqual(['a', 'b', 'c'])
    expect(call).toBe(2)
  })

  it('passes the cursor of the previous page', async () => {
    const seen: unknown[] = []
    const pages = [
      { data: { items: { nodes: ['a'], pageInfo: { hasNextPage: true, endCursor: 'c1' } } } },
      { data: { items: { nodes: ['b'], pageInfo: { hasNextPage: false, endCursor: null } } } },
    ]
    let call = 0
    const client = new GitHubClient(credential, async (_url, init) => {
      seen.push(JSON.parse(String(init.body)).variables.cursor)
      return respond(pages[call++]!)
    })

    await client.collectAll<string>('query', {}, (d) => d.items)

    expect(seen).toEqual([null, 'c1'])
  })
})

describe('GitHubClient error mapping', () => {
  it('raises on a rate limit', async () => {
    const client = new GitHubClient(credential, async () =>
      respond({ message: 'API rate limit exceeded' }, {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1780000000' },
      }),
    )
    await expect(client.graphql('query', {})).rejects.toThrow(RateLimitError)
  })

  it('raises a scope error naming the remedy', async () => {
    const client = new GitHubClient(credential, async () =>
      respond({ errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'needs project scope' }] }),
    )
    await expect(client.graphql('query', {})).rejects.toThrow(/gh auth refresh -s project/)
  })

  it('raises rather than returning partial data on a graphql error', async () => {
    const client = new GitHubClient(credential, async () =>
      respond({ data: { partial: true }, errors: [{ message: 'boom' }] }),
    )
    await expect(client.graphql('query', {})).rejects.toThrow(/boom/)
  })

  it('never puts the credential in an error message', async () => {
    const client = new GitHubClient(credential, async () => respond({ errors: [{ message: 'boom' }] }))
    const err = await client.graphql('query', {}).catch((e: Error) => e)
    expect((err as Error).message).not.toContain('secret-value')
  })

  it('raises on a secondary rate limit (403 with message)', async () => {
    const client = new GitHubClient(credential, async () =>
      respond(
        { message: 'You have exceeded a secondary rate limit. Please wait a few moments before you try again.' },
        { status: 403 },
      ),
    )
    await expect(client.graphql('query', {})).rejects.toThrow(RateLimitError)
  })

  it('raises on a 429 response with retry-after', async () => {
    const client = new GitHubClient(credential, async () =>
      respond({ message: 'Too many requests' }, {
        status: 429,
        headers: { 'retry-after': '60' },
      }),
    )
    await expect(client.graphql('query', {})).rejects.toThrow(RateLimitError)
  })

  it('includes GitHub message in error for non-rate-limit 403', async () => {
    const client = new GitHubClient(credential, async () =>
      respond({ message: 'Bad credentials' }, { status: 403 }),
    )
    const err = await client.graphql('query', {}).catch((e: Error) => e)
    expect((err as Error).message).toContain('Bad credentials')
    expect((err as Error).message).toContain('403')
  })

  it('includes GitHub message in error for other non-ok responses', async () => {
    const client = new GitHubClient(credential, async () =>
      respond({ message: 'Internal Server Error' }, { status: 500 }),
    )
    const err = await client.graphql('query', {}).catch((e: Error) => e)
    expect((err as Error).message).toContain('Internal Server Error')
    expect((err as Error).message).toContain('500')
  })

  it('never includes credentials in secondary rate limit error', async () => {
    const client = new GitHubClient(credential, async () =>
      respond(
        { message: 'You have exceeded a secondary rate limit.' },
        { status: 403, headers: { 'retry-after': '60' } },
      ),
    )
    const err = await client.graphql('query', {}).catch((e: Error) => e)
    expect((err as Error).message).not.toContain('secret-value')
  })

  it('never includes credentials in non-rate-limit error messages', async () => {
    const client = new GitHubClient(credential, async () =>
      respond({ message: 'Bad credentials' }, { status: 403 }),
    )
    const err = await client.graphql('query', {}).catch((e: Error) => e)
    expect((err as Error).message).not.toContain('secret-value')
  })
})
