import type { Credential } from '../../auth.js'

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

export type PageOf<T> = {
  nodes: T[]
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
}

export class GraphQLError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GraphQLError'
  }
}

export class RateLimitError extends Error {
  constructor(public readonly resetAt: Date | null) {
    super(
      `GitHub rate limit reached${resetAt ? `; resets at ${resetAt.toISOString()}` : ''}. ` +
        `Armature stopped rather than returning part of the board.`,
    )
    this.name = 'RateLimitError'
  }
}

export class MissingScopeError extends Error {
  constructor() {
    super(
      'The GitHub credential lacks the `project` scope, which reading a board requires. ' +
        'Run `gh auth refresh -s project`, or reissue the token with `repo` and `project`.',
    )
    this.name = 'MissingScopeError'
  }
}

const ENDPOINT = 'https://api.github.com/graphql'

export class GitHubClient {
  constructor(
    private readonly credential: Credential,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetcher(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.credential.token}`,
        'content-type': 'application/json',
        'user-agent': 'armature',
      },
      body: JSON.stringify({ query, variables }),
    })

    // Primary rate limit: 403 with x-ratelimit-remaining: 0
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      const reset = response.headers.get('x-ratelimit-reset')
      throw new RateLimitError(reset ? new Date(Number(reset) * 1000) : null)
    }

    const payload = (await response.json()) as {
      data?: T
      errors?: { type?: string; message: string }[]
      message?: string
      documentation_url?: string
    }

    // Check for secondary rate limit before processing GraphQL errors
    // Secondary rate limit: 403/429 with retry-after header or message mentioning rate limit
    const retryAfter = response.headers.get('retry-after')
    const isSecondaryRateLimit =
      response.status === 429 ||
      (response.status === 403 && (retryAfter || /secondary rate limit|abuse detection/i.test(payload.message || '')))

    if (isSecondaryRateLimit) {
      const resetAt = retryAfter ? new Date(Date.now() + Number(retryAfter) * 1000) : null
      throw new RateLimitError(resetAt)
    }

    if (payload.errors?.length) {
      if (payload.errors.some((e) => e.type === 'INSUFFICIENT_SCOPES')) throw new MissingScopeError()
      // Partial data alongside errors is the failure mode that hides corruption. Refuse it.
      throw new GraphQLError(payload.errors.map((e) => e.message).join('; '))
    }

    // If response is not ok and has a message, include it in the error
    if (!response.ok && payload.message) {
      throw new GraphQLError(`GitHub API error (${response.status}): ${payload.message}`)
    }

    if (!payload.data) throw new GraphQLError('GitHub returned no data and no error.')
    return payload.data
  }

  async collectAll<T>(
    query: string,
    variables: Record<string, unknown>,
    extract: (data: any) => PageOf<T>,
  ): Promise<T[]> {
    const all: T[] = []
    let cursor: string | null = null

    // No page-size parameter is exposed anywhere. Under-fetching is not requestable.
    for (;;) {
      const data = await this.graphql<any>(query, { ...variables, cursor })
      const page = extract(data)
      all.push(...page.nodes)
      if (!page.pageInfo.hasNextPage) return all
      cursor = page.pageInfo.endCursor
      if (cursor === null) {
        throw new GraphQLError('GitHub reported another page but returned no cursor.')
      }
    }
  }
}
