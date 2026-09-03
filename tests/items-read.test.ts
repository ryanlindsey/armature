import { describe, expect, it } from 'vitest'
import { getItem, parseEpicFromBody } from '../server/providers/github/items.js'
import { GitHubClient } from '../server/providers/github/client.js'

describe('parseEpicFromBody', () => {
  // --- Round 2 policy ---
  // Round 1 required "epic" to co-occur on the line with a reference, inferred from free
  // prose. The re-reviewer broke that with a fourth counterexample (see below) where "epic"
  // and an unrelated reference legitimately share a line. Rather than add a fourth heuristic,
  // the controller replaced inference with an explicit DECLARATION line: the entire trimmed
  // line must be "Epic: owner/repo#N" or "Part of: owner/repo#N" (case-insensitive label),
  // with an optional leading markdown list marker and an optional bold wrapper, and nothing
  // else. Prose is never parsed, no matter what it says.

  it('reads an "Epic:" declaration line', () => {
    expect(parseEpicFromBody('Epic: acme/platform#339')).toEqual({
      owner: 'acme', repo: 'platform', number: 339,
    })
  })

  it('reads a "Part of:" declaration line', () => {
    expect(parseEpicFromBody('Part of: acme/platform#339')).toEqual({
      owner: 'acme', repo: 'platform', number: 339,
    })
  })

  it('accepts a leading markdown list marker', () => {
    expect(parseEpicFromBody('- Epic: acme/platform#339')).toEqual({
      owner: 'acme', repo: 'platform', number: 339,
    })
  })

  it('accepts a bold label', () => {
    expect(parseEpicFromBody('**Epic:** acme/platform#339')).toEqual({
      owner: 'acme', repo: 'platform', number: 339,
    })
  })

  it('accepts the whole declaration bolded', () => {
    expect(parseEpicFromBody('**Epic: acme/platform#339**')).toEqual({
      owner: 'acme', repo: 'platform', number: 339,
    })
  })

  it('accepts a bolded label combined with a list marker', () => {
    expect(parseEpicFromBody('* **Epic:** acme/platform#339')).toEqual({
      owner: 'acme', repo: 'platform', number: 339,
    })
  })

  it('finds the declaration line among surrounding prose', () => {
    const body = [
      'This fixes a crash under load.',
      '',
      'Epic: acme/platform#339',
      '',
      'Also see the discussion above.',
    ].join('\n')
    expect(parseEpicFromBody(body)).toEqual({ owner: 'acme', repo: 'platform', number: 339 })
  })

  it('returns null when there is no reference', () => {
    expect(parseEpicFromBody('No epic here.')).toBeNull()
  })

  it('returns null for a bare number', () => {
    expect(parseEpicFromBody('Part of the epic, issue #339.')).toBeNull()
  })

  it('returns null when the line carries anything else ("nothing else on the line")', () => {
    expect(parseEpicFromBody('Epic: acme/platform#339.')).toBeNull()
  })

  it('returns null and does not guess when two declarations disagree', () => {
    const body = 'Epic: acme/platform#339\nEpic: acme/other#42'
    expect(parseEpicFromBody(body)).toBeNull()
  })

  it('accepts a repeated declaration of the same epic (not a disagreement)', () => {
    const body = 'Epic: acme/platform#339\nPart of: acme/platform#339'
    expect(parseEpicFromBody(body)).toEqual({ owner: 'acme', repo: 'platform', number: 339 })
  })

  it('does not parse a declaration out of a fenced code example', () => {
    // This is why code-stripping still earns its place under the strict line format: a
    // fenced line carries no backticks of its own, so a fenced block whose only content is
    // exactly "Epic: acme/web#1" would otherwise satisfy the format verbatim.
    const body = ['Convention example:', '```', 'Epic: acme/web#1', '```'].join('\n')
    expect(parseEpicFromBody(body)).toBeNull()
  })

  it('does not un-wrap an inline code span (inline stripping was dropped as redundant)', () => {
    // Under the strict full-line match, an inline-code-wrapped declaration fails whether or
    // not the span is stripped: stripped, the line becomes empty; unstripped, the backtick
    // blocks the required "Epic:"/"Part of:" prefix. Either way this must be null — this
    // test pins that "fails closed" behavior now that inline-span stripping is gone.
    expect(parseEpicFromBody('`Epic: acme/web#1`')).toBeNull()
  })

  // --- Regression suite: every input previously shown to produce a wrong, silent epic ---

  it('reviewer case 1: an unrelated parenthetical is not a declaration', () => {
    const body = 'Filed in acme/support (ticket #123) for tracking, unrelated to this issue.'
    expect(parseEpicFromBody(body)).toBeNull()
  })

  it('reviewer case 2: a reference inside a fenced example is not a declaration', () => {
    const body = [
      'Reference examples for the epic:',
      '```',
      '# cite an epic like this: acme/web#1',
      '```',
      'Nothing else here.',
    ].join('\n')
    expect(parseEpicFromBody(body)).toBeNull()
  })

  it('reviewer case 3: neither of two bare mentions in a sentence is a declaration', () => {
    const body = 'Blocks acme/web#10, part of acme/platform#339.'
    expect(parseEpicFromBody(body)).toBeNull()
  })

  it('re-reviewer case 4: "epic" co-occurring with a reference is not a declaration', () => {
    // The exact input that broke round 1's "epic co-occurs with the reference" heuristic:
    // "epic" is on the line, and the PROSE pattern matched the unrelated ticket reference as
    // the only (and therefore, after dedupe, the winning) candidate.
    const body = 'Filed in acme/support (ticket #123) for tracking, unrelated to this epic.'
    expect(parseEpicFromBody(body)).toBeNull()
  })

  it('round 1 contract, now superseded: a shorthand reference embedded in a sentence no longer counts', () => {
    // Round 1 accepted this (after co-opting the plan's original 'reads a shorthand
    // reference' test to add an "epic" marker). Round 2 replaces inference over prose with
    // an explicit declaration line, so this is no longer a match — see the positive
    // "Epic:"/"Part of:" declaration tests above for the replacement contract.
    expect(parseEpicFromBody('Part of the epic, acme/platform#339.')).toBeNull()
  })

  it('round 1 contract, now superseded: the original prose form no longer counts', () => {
    // This was the plan's original 'reads a cross-repository epic reference' test.
    const body = 'Part of the telemetry epic in acme/platform (Epic 4, issue #339).'
    expect(parseEpicFromBody(body)).toBeNull()
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
