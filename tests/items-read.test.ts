import { describe, expect, it } from 'vitest'
import { getItem, parseEpicFromBody } from '../server/providers/github/items.js'
import { GitHubClient } from '../server/providers/github/client.js'

describe('parseEpicFromBody', () => {
  it('reads a cross-repository epic reference', () => {
    const body = 'Part of the telemetry epic in acme/platform (Epic 4, issue #339).'
    expect(parseEpicFromBody(body)).toEqual({ owner: 'acme', repo: 'platform', number: 339 })
  })

  // NOTE: this input was changed from the original plan's 'Part of acme/platform#339.'
  // That body carries no "epic" marker, and the controller's ruling for Finding 1 requires
  // one on the same line as any reference (prose or shorthand) before it counts. The original
  // wording directly contradicts the new policy, so the wording was changed rather than the
  // policy; see the fix report for the explicit call-out.
  it('reads a shorthand reference', () => {
    expect(parseEpicFromBody('Part of the epic, acme/platform#339.')).toEqual({
      owner: 'acme', repo: 'platform', number: 339,
    })
  })

  // A bare number in a body names an issue in some other repository. Refuse to guess.
  it('returns null for a bare number', () => {
    expect(parseEpicFromBody('Part of the epic, issue #339.')).toBeNull()
  })

  it('returns null when there is no reference', () => {
    expect(parseEpicFromBody('No epic here.')).toBeNull()
  })

  // --- Finding 1 regression suite: the reviewer's known-bad inputs ---
  // These three are the exact (or, for the second, a faithful reconstruction of the described)
  // inputs the reviewer used to disprove the prior implementation's self-assessment.

  it('does not attach an unrelated parenthetical reference (reviewer case 1)', () => {
    const body = 'Filed in acme/support (ticket #123) for tracking, unrelated to this issue.'
    expect(parseEpicFromBody(body)).toBeNull()
  })

  it('does not parse a reference out of a fenced code example (reviewer case 2)', () => {
    // The reviewer's report described "a markdown code fence containing acme/web#1 as an
    // example" without quoting the exact body, so this reconstructs it. The "epic" word is
    // placed inside the fence, on the same line as the reference, so this test actually
    // exercises code-stripping: without it, the epic-marker rule alone would already pass
    // this line and the old bug would resurface.
    const body = [
      'Reference examples for the epic:',
      '```',
      '# cite an epic like this: acme/web#1',
      '```',
      'Nothing else here.',
    ].join('\n')
    expect(parseEpicFromBody(body)).toBeNull()
  })

  it('refuses to pick the leftmost of two candidates (reviewer case 3)', () => {
    const body = 'Blocks acme/web#10, part of acme/platform#339.'
    expect(parseEpicFromBody(body)).toBeNull()
  })

  // --- Additional coverage for the controller's specific rulings ---

  it('strips an inline code span before matching', () => {
    const body = 'Reference example: `acme/web#1` is how you cite the epic.'
    expect(parseEpicFromBody(body)).toBeNull()
  })

  it('refuses when two distinct qualified references share an epic-marked line', () => {
    const body = 'Part of the epic in acme/web#10 or maybe acme/platform#339.'
    expect(parseEpicFromBody(body)).toBeNull()
  })

  it('accepts a repeated reference to the same epic (not ambiguous, just duplicated)', () => {
    const body = 'The epic is acme/platform#339, also tracked as acme/platform#339.'
    expect(parseEpicFromBody(body)).toEqual({ owner: 'acme', repo: 'platform', number: 339 })
  })

  it('still refuses a bare #339 even when "epic" is present', () => {
    expect(parseEpicFromBody('Part of the epic (#339), no repository named.')).toBeNull()
  })
})

describe('getItem project membership pagination', () => {
  const credential = { token: 'secret-value', source: 'gh-cli' as const }
  const board = { provider: 'github' as const, owner: 'acme', number: 1 }
  const ref = { owner: 'acme', repo: 'web', number: 278 }

  function issueResponse(opts: { nodes: unknown[]; hasNextPage: boolean }) {
    return {
      data: {
        repository: {
          issue: {
            id: 'I_1',
            number: 278,
            title: 't',
            body: '',
            state: 'OPEN',
            parent: null,
            projectItems: {
              nodes: opts.nodes,
              pageInfo: { hasNextPage: opts.hasNextPage },
            },
          },
        },
      },
    }
  }

  function otherProjectNodes(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `PVTI_${i}`,
      project: { number: 999 },
      fieldValueByName: null,
    }))
  }

  it('requests up to 100 project memberships per page', async () => {
    let seenQuery = ''
    const client = new GitHubClient(credential, async (_url, init) => {
      seenQuery = JSON.parse(String(init.body)).query
      return new Response(JSON.stringify(issueResponse({ nodes: [], hasNextPage: false })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    await getItem(client, board, ref)

    expect(seenQuery).toMatch(/projectItems\(first:\s*100\)/)
  })

  it('throws a loud error when the project is not found and more pages exist', async () => {
    const client = new GitHubClient(credential, async () =>
      new Response(
        JSON.stringify(issueResponse({ nodes: otherProjectNodes(100), hasNextPage: true })),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    await expect(getItem(client, board, ref)).rejects.toThrow(/truncat/i)
  })

  it('does not throw when the project is genuinely absent and there are no more pages', async () => {
    const client = new GitHubClient(credential, async () =>
      new Response(
        JSON.stringify(issueResponse({ nodes: otherProjectNodes(5), hasNextPage: false })),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    const detail = await getItem(client, board, ref)
    expect(detail.projectItemId).toBeNull()
  })

  it('does not throw when the project is found even if more pages exist', async () => {
    const nodes = [
      ...otherProjectNodes(99),
      { id: 'PVTI_target', project: { number: 1 }, fieldValueByName: { name: 'Todo' } },
    ]
    const client = new GitHubClient(credential, async () =>
      new Response(JSON.stringify(issueResponse({ nodes, hasNextPage: true })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const detail = await getItem(client, board, ref)
    expect(detail.projectItemId).toBe('PVTI_target')
    expect(detail.status).toBe('Todo')
  })
})
