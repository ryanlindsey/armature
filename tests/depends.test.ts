import { describe, expect, it } from 'vitest'
import {
  UnclosedFenceError,
  dependsOnLine,
  parseDependsOn,
  sameRefSet,
  syncDependsOn,
} from '../server/providers/github/depends.js'
import type { WorkItemRef } from '../server/ref.js'

const ref = (owner: string, repo: string, number: number): WorkItemRef => ({ owner, repo, number })
const web1 = ref('acme', 'web', 1)
const web2 = ref('acme', 'web', 2)
const api1 = ref('acme', 'api', 1)
const line = (r: WorkItemRef) => dependsOnLine(r)

describe('dependsOnLine', () => {
  it('renders the canonical form', () => {
    expect(dependsOnLine(web1)).toBe('Depends on `acme/web#1`')
  })
})

describe('parseDependsOn', () => {
  it('reads canonical lines in body order', () => {
    expect(parseDependsOn('Depends on `acme/web#1`\nDepends on `acme/api#1`')).toEqual([web1, api1])
  })

  it('allows surrounding whitespace on a canonical line', () => {
    expect(parseDependsOn('  Depends on `acme/web#1`  ')).toEqual([web1])
  })

  it.each([
    ['a list marker before it', '- Depends on `acme/web#1`'],
    ['no code span', 'Depends on acme/web#1'],
    ['a bare number', 'Depends on `#1`'],
    ['two refs on one line', 'Depends on `acme/web#1` and `acme/web#2`'],
    ['other phrasing', 'blocked by `acme/web#1`'],
    ['issue zero', 'Depends on `acme/web#0`'],
    ['trailing prose', 'Depends on `acme/web#1`, then ship'],
  ])('ignores %s', (_why, body) => {
    expect(parseDependsOn(body)).toEqual([])
  })

  it('ignores canonical lines inside a backtick fence, a tilde fence and indented code', () => {
    const body = [
      '```',
      'Depends on `acme/web#1`',
      '```',
      '~~~',
      'Depends on `acme/web#2`',
      '~~~',
      '',
      '    Depends on `acme/api#1`',
    ].join('\n')
    expect(parseDependsOn(body)).toEqual([])
  })

  it('treats owner/repo case-insensitively, first spelling wins', () => {
    expect(parseDependsOn('Depends on `Acme/Web#9`\nDepends on `acme/web#9`')).toEqual([
      ref('Acme', 'Web', 9),
    ])
  })

  it('keeps refs that differ only in number distinct', () => {
    expect(parseDependsOn('Depends on `acme/web#1`\nDepends on `acme/web#2`')).toEqual([web1, web2])
  })

  it('reads CRLF bodies', () => {
    expect(parseDependsOn('Intro\r\nDepends on `acme/web#1`\r\n')).toEqual([web1])
  })
})

describe('syncDependsOn', () => {
  it('returns a body already in sync byte-for-byte', () => {
    const body = 'Intro\r\n\r\nDepends on `acme/web#1`\r\nDepends on `acme/api#1`\r\n\r\nOutro  \r\n'
    const result = syncDependsOn(body, [api1, web1])
    expect(result.body).toBe(body)
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
  })

  it('appends after a blank line when the body has no canonical lines', () => {
    expect(syncDependsOn('Intro\n\n', [web1])).toEqual({
      body: 'Intro\n\nDepends on `acme/web#1`\n',
      added: [web1],
      removed: [],
    })
  })

  it('trims trailing whitespace-only lines before appending', () => {
    expect(syncDependsOn('Intro\n  \n\t\n', [web1]).body).toBe('Intro\n\nDepends on `acme/web#1`\n')
  })

  it('keeps the absence of a final newline when appending', () => {
    expect(syncDependsOn('Intro', [web1, web2]).body).toBe(
      'Intro\n\nDepends on `acme/web#1`\nDepends on `acme/web#2`',
    )
  })

  it('turns an empty body into just the lines', () => {
    expect(syncDependsOn('', [web1]).body).toBe('Depends on `acme/web#1`')
    expect(syncDependsOn('', [web1, web2]).body).toBe(`${line(web1)}\n${line(web2)}`)
  })

  it('inserts directly after the last canonical line, before following prose', () => {
    const body = `Intro\n\n${line(web1)}\nMore prose\n`
    expect(syncDependsOn(body, [web1, api1])).toEqual({
      body: `Intro\n\n${line(web1)}\n${line(api1)}\nMore prose\n`,
      added: [api1],
      removed: [],
    })
  })

  it('inserts after a canonical last line that has no line ending', () => {
    expect(syncDependsOn(`Intro\n${line(web1)}`, [web1, api1]).body).toBe(
      `Intro\n${line(web1)}\n${line(api1)}`,
    )
  })

  it('adds in the order the blockers are given', () => {
    expect(syncDependsOn('', [web2, web1]).added).toEqual([web2, web1])
  })

  it('removes a line and its line ending, leaving the rest intact', () => {
    const body = `Intro\n${line(web1)}\n${line(api1)}\nOutro\n`
    expect(syncDependsOn(body, [api1])).toEqual({
      body: `Intro\n${line(api1)}\nOutro\n`,
      added: [],
      removed: [web1],
    })
  })

  it('removes every canonical line when there are no blockers', () => {
    expect(syncDependsOn(`Intro\n${line(web1)}\nOutro`, [])).toEqual({
      body: 'Intro\nOutro',
      added: [],
      removed: [web1],
    })
  })

  it('repairs drift both ways in one call', () => {
    const result = syncDependsOn(`Intro\n${line(web1)}\nOutro\n`, [web2])
    expect(result.removed).toEqual([web1])
    expect(result.added).toEqual([web2])
    // The anchor was removed, so the new line is appended at the end.
    expect(result.body).toBe(`Intro\nOutro\n\n${line(web2)}\n`)
  })

  it('collapses duplicate canonical lines for one ref to the first', () => {
    const body = `${line(web1)}\nMiddle\nDepends on \`ACME/web#1\`\nEnd\n`
    const result = syncDependsOn(body, [web1])
    expect(result.body).toBe(`${line(web1)}\nMiddle\nEnd\n`)
    expect(result.added).toEqual([])
    // The ref is still a blocker: a repeat dropped is not a dependency removed.
    expect(result.removed).toEqual([])
  })

  it('adds a blocker listed twice only once', () => {
    expect(syncDependsOn('', [web1, ref('ACME', 'Web', 1)])).toEqual({
      body: line(web1),
      added: [web1],
      removed: [],
    })
  })

  it('keeps CRLF line endings throughout', () => {
    const body = `Intro\r\n${line(web1)}\r\n${line(api1)}\r\nOutro\r\n`
    const result = syncDependsOn(body, [web1, web2])
    expect(result.body).toBe(`Intro\r\n${line(web1)}\r\n${line(web2)}\r\nOutro\r\n`)
    expect(result.body.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
  })

  it('keeps CRLF line endings when appending', () => {
    const result = syncDependsOn('Intro\r\n\r\n', [web1, web2])
    expect(result.body).toBe(`Intro\r\n\r\n${line(web1)}\r\n${line(web2)}\r\n`)
  })

  it('neither removes nor anchors on a canonical-looking line inside a fence', () => {
    const fenced = ['```', line(web1), '```'].join('\n')
    const body = `Intro\n\n${fenced}\n\nOutro\n`
    const result = syncDependsOn(body, [api1])
    expect(result.body).toBe(`Intro\n\n${fenced}\n\nOutro\n\n${line(api1)}\n`)
    expect(result.removed).toEqual([])
    expect(result.added).toEqual([api1])
  })

  it('leaves non-canonical dependency prose untouched', () => {
    const body = `blocked by \`acme/web#1\`\n- Depends on \`acme/web#1\`\n`
    expect(syncDependsOn(body, []).body).toBe(body)
  })

  it('treats owner/repo case as the same ref', () => {
    const body = 'Depends on `Acme/Web#9`'
    const result = syncDependsOn(body, [ref('acme', 'web', 9)])
    expect(result).toEqual({ body, added: [], removed: [] })
  })

  it('returns a body whose canonical set equals the blockers', () => {
    const body = `Intro\n${line(web1)}\n\`\`\`\n${line(web2)}\n\`\`\`\n${line(api1)}\n${line(web1)}\nOutro`
    const blockers = [web2, api1, ref('other', 'repo', 7)]
    expect(sameRefSet(parseDependsOn(syncDependsOn(body, blockers).body), blockers)).toBe(true)
  })

  it('refuses to append into a fence that never closes', () => {
    // GitHub renders an unclosed fence to the end of the body, so an appended line would be code
    // and the result would not say what the links say.
    expect(() => syncDependsOn('Intro\n```\ncode\n', [web1])).toThrow(UnclosedFenceError)
  })

  it('does not refuse an unclosed fence when nothing needs appending', () => {
    const body = `${line(web1)}\n\`\`\`\ncode\n`
    expect(syncDependsOn(body, [web1, api1]).body).toBe(`${line(web1)}\n${line(api1)}\n\`\`\`\ncode\n`)
  })
})

describe('sameRefSet', () => {
  it('ignores order', () => {
    expect(sameRefSet([web1, api1], [api1, web1])).toBe(true)
  })

  it('ignores owner/repo case', () => {
    expect(sameRefSet([ref('Acme', 'Web', 1)], [web1])).toBe(true)
  })

  it('respects the number', () => {
    expect(sameRefSet([web1], [web2])).toBe(false)
  })

  it('compares as sets', () => {
    expect(sameRefSet([web1, web1], [web1])).toBe(true)
    expect(sameRefSet([web1], [web1, api1])).toBe(false)
    expect(sameRefSet([], [])).toBe(true)
  })
})
