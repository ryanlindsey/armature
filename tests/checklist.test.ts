import { describe, expect, it } from 'vitest'
import {
  AmbiguousEntryError,
  ConflictingRequestError,
  NoSuchEntryError,
  applyChecks,
  codeMask,
  parseChecklist,
} from '../server/providers/github/checklist.js'

describe('codeMask', () => {
  it('marks backtick-fenced lines, delimiters included', () => {
    const body = ['prose', '```', 'code', '```', 'more'].join('\n')
    expect(codeMask(body)).toEqual([false, true, true, true, false])
  })

  it('marks tilde-fenced lines', () => {
    const body = ['prose', '~~~', 'code', '~~~', 'more'].join('\n')
    expect(codeMask(body)).toEqual([false, true, true, true, false])
  })

  it('marks indented code, by four spaces or by a tab', () => {
    const body = ['prose', '    indented', '\ttabbed', 'more'].join('\n')
    expect(codeMask(body)).toEqual([false, true, true, false])
  })

  it('treats a fence indented four spaces as indented code, not an opener', () => {
    const body = ['    ```', 'prose'].join('\n')
    expect(codeMask(body)).toEqual([true, false])
  })

  it('marks to the end of the body when a fence never closes', () => {
    const body = ['prose', '```', 'code', 'still code'].join('\n')
    expect(codeMask(body)).toEqual([false, true, true, true])
  })

  it('does not let a shorter delimiter close a longer fence', () => {
    const body = ['````', '```', 'still code', '````', 'prose'].join('\n')
    expect(codeMask(body)).toEqual([true, true, true, true, false])
  })

  it('returns one entry per line, trailing empty line included', () => {
    expect(codeMask('a\n\n')).toHaveLength(3)
  })

  it('does not close a fence on a delimiter line with trailing text', () => {
    const body = ['```', '```js', 'still code', '```', 'prose'].join('\n')
    expect(codeMask(body)).toEqual([true, true, true, true, false])
  })

  it('does not close a backtick fence with tildes, or a tilde fence with backticks', () => {
    expect(codeMask(['```', '~~~', 'code', '```', 'prose'].join('\n'))).toEqual([
      true, true, true, true, false,
    ])
    expect(codeMask(['~~~', '```', 'code', '~~~', 'prose'].join('\n'))).toEqual([
      true, true, true, true, false,
    ])
  })

  it('opens a fence indented by fewer than four spaces', () => {
    const body = ['prose', '   ```', 'code', '```', 'more'].join('\n')
    expect(codeMask(body)).toEqual([false, true, true, true, false])
  })

  it('does not treat a three-space indent as code', () => {
    expect(codeMask(['prose', '   three', 'more'].join('\n'))).toEqual([false, false, false])
  })

  it('gives CRLF input the same mask as LF input', () => {
    const lines = ['prose', '```', 'code', '```', '    indented', 'more']
    expect(codeMask(lines.join('\r\n'))).toEqual(codeMask(lines.join('\n')))
  })
  it('does not close a fence on a closer indented four or more spaces', () => {
    // CommonMark: a closer may be indented 0-3 spaces. `    ```` inside a fence is content.
    expect(codeMask('```\n    ```\n- [ ] x\n```\n')).toEqual([true, true, true, true, false])
  })

  it('closes a fence on a closer indented up to three spaces, with trailing whitespace', () => {
    expect(codeMask(['```', 'code', '   ```  \t', 'prose'].join('\n'))).toEqual([
      true, true, true, false,
    ])
  })

  it('closes a fence on a longer closer of the same character', () => {
    expect(codeMask(['```', 'code', '`````', 'prose'].join('\n'))).toEqual([true, true, true, false])
  })

  it('does not close a fence on a closer followed by non-ASCII whitespace', () => {
    expect(codeMask(['```', '``` ', 'code', '```', 'prose'].join('\n'))).toEqual([
      true, true, true, true, false,
    ])
  })

  it('does not close a fence on a closer trailed by the other fence character', () => {
    expect(codeMask(['```', '```~~', 'code', '```', 'prose'].join('\n'))).toEqual([
      true, true, true, true, false,
    ])
  })

  it('does not close a fence on a tab-indented closer', () => {
    expect(codeMask(['```', '\t```', 'code', '```', 'prose'].join('\n'))).toEqual([
      true, true, true, true, false,
    ])
  })

  it('marks indentation that reaches column four through spaces and a tab, as a tab stop', () => {
    expect(codeMask(['prose', ' \t- [ ] z', '  \tz', '   \tz', 'more'].join('\n'))).toEqual([
      false, true, true, true, false,
    ])
  })

  it('treats a fence reaching column four through a tab as indented code, not an opener', () => {
    expect(codeMask([' \t```', '- [ ] x'].join('\n'))).toEqual([true, false])
    expect(codeMask(['\t```', '- [ ] x'].join('\n'))).toEqual([true, false])
  })

  it('does not count non-ASCII whitespace as indentation', () => {
    expect(codeMask(['    text', '　```', 'more'].join('\n'))).toEqual([
      false, false, false,
    ])
  })
  it('does not mask HTML comments, which are a parseChecklist concern', () => {
    expect(codeMask(['<!--', '- [ ] x', '-->'].join('\n'))).toEqual([false, false, false])
  })
})

describe('parseChecklist', () => {
  it('reads every task-list marker GFM allows', () => {
    const body = ['- [ ] dash', '* [ ] star', '+ [ ] plus'].join('\n')
    expect(parseChecklist(body).map((e) => e.text)).toEqual(['dash', 'star', 'plus'])
  })

  it('reads both cases of a ticked box', () => {
    expect(parseChecklist('- [x] lower\n- [X] upper').map((e) => e.checked)).toEqual([true, true])
  })

  it('ignores entries inside a backtick fence', () => {
    const body = ['- [ ] real', '```', '- [ ] sample', '```'].join('\n')
    expect(parseChecklist(body).map((e) => e.text)).toEqual(['real'])
  })

  it('ignores entries inside a tilde fence', () => {
    const body = ['- [ ] real', '~~~', '- [ ] sample', '~~~'].join('\n')
    expect(parseChecklist(body).map((e) => e.text)).toEqual(['real'])
  })

  // After a paragraph, four spaces are indented code. After a list item, GFM would instead read
  // a nested item, which codeMask conservatively masks too; see docs/superpowers/follow-ups.md.
  it('ignores entries inside indented code', () => {
    expect(parseChecklist('- [ ] real\n\nprose\n\n    - [ ] sample').map((e) => e.text)).toEqual(['real'])
  })

  it('does not let an indented fence swallow the entries after it', () => {
    const body = ['    ```', '- [ ] after'].join('\n')
    expect(parseChecklist(body).map((e) => e.text)).toEqual(['after'])
  })

  it('requires a space or tab after the marker, as GFM does', () => {
    expect(parseChecklist('-\u00a0[ ] nbsp\n- [ ]\u00a0nbsp')).toEqual([])
  })

  it('attributes each entry to its nearest preceding heading', () => {
    const body = ['## Notes', '- [ ] a', '## Acceptance', '- [ ] b', '- [ ] c'].join('\n')
    expect(parseChecklist(body).map((e) => e.heading)).toEqual(['Notes', 'Acceptance', 'Acceptance'])
  })

  it('strips an ATX closing sequence but keeps a trailing hash that is part of the text', () => {
    const body = ['## Acceptance ##', '- [ ] a', '## C#', '- [ ] b'].join('\n')
    expect(parseChecklist(body).map((e) => e.heading)).toEqual(['Acceptance', 'C#'])
  })

  it('does not take a heading from inside code', () => {
    const body = ['## Real', '```', '## Sample', '```', '- [ ] a'].join('\n')
    expect(parseChecklist(body)[0]!.heading).toBe('Real')
  })

  it('reports a null heading for an entry with nothing above it', () => {
    expect(parseChecklist('- [ ] orphan')[0]!.heading).toBeNull()
  })

  it('trims the entry text', () => {
    expect(parseChecklist('- [ ]   spaced   ')[0]!.text).toBe('spaced')
  })

  it('returns an empty list for a body with no checklist', () => {
    expect(parseChecklist('just prose\n\n## Heading\n\nmore prose')).toEqual([])
  })
  it('counts only ASCII spaces and tabs as indentation before the marker', () => {
    expect(parseChecklist(' - [ ] y')).toEqual([])
    expect(parseChecklist('　- [ ] y\n * [x] z')).toEqual([])
    expect(parseChecklist('   - [ ] three\n \t- [ ] tab')).toEqual([
      { text: 'three', checked: false, heading: null },
    ])
  })

  it('does not take a heading from a line led by non-ASCII whitespace', () => {
    expect(parseChecklist('## Real\n ## Fake\n- [ ] a')[0]!.heading).toBe('Real')
  })

  it('ignores entries inside a single-line HTML comment block', () => {
    expect(parseChecklist('<!-- - [ ] hidden -->\n- [ ] real').map((e) => e.text)).toEqual(['real'])
  })

  it('ignores entries inside a multi-line HTML comment, closer line included', () => {
    const body = ['- [ ] before', '<!--', '- [ ] sample', '* [x] sample two', '--> - [ ] tail', '- [ ] after']
    expect(parseChecklist(body.join('\n')).map((e) => e.text)).toEqual(['before', 'after'])
  })

  it('ignores entries after a comment that never closes', () => {
    expect(parseChecklist('- [ ] real\n<!--\n- [ ] sample').map((e) => e.text)).toEqual(['real'])
  })

  it('reads an entry that carries a trailing comment of its own', () => {
    expect(parseChecklist('- [ ] real <!-- why -->\n- [ ] next').map((e) => e.text)).toEqual([
      'real <!-- why -->',
      'next',
    ])
  })

  it('masks the lines after an entry that opens a comment it does not close', () => {
    expect(parseChecklist('- [ ] real <!--\n- [ ] sample\n-->\n- [ ] after').map((e) => e.text)).toEqual([
      'real <!--',
      'after',
    ])
  })

  it('does not take a heading from inside an HTML comment', () => {
    const body = ['## Real', '<!--', '## Sample', '-->', '- [ ] a'].join('\n')
    expect(parseChecklist(body)[0]!.heading).toBe('Real')
  })

  it('treats a comment opener inside code as code, not as a comment', () => {
    const body = ['```', '<!--', '```', '- [ ] after', '    <!--', '- [ ] also'].join('\n')
    expect(parseChecklist(body).map((e) => e.text)).toEqual(['after', 'also'])
  })

  it('treats a comment closer inside code as code, leaving the comment open', () => {
    const body = ['<!--', '```', '-->', '```', '- [ ] sample'].join('\n')
    expect(parseChecklist(body)).toEqual([])
  })

  it('reads an entry after a comment closes, and after two comments on one line', () => {
    const body = ['<!-- a --> <!-- b', '- [ ] sample', 'c -->', '- [ ] after'].join('\n')
    expect(parseChecklist(body).map((e) => e.text)).toEqual(['after'])
  })
})

const REF = { owner: 'acme', repo: 'web', number: 7 }

const BODY = [
  '## Acceptance',
  '',
  '- [ ] first',
  '- [x] second',
  '- [ ] third',
  '',
  '```',
  '- [ ] sample',
  '```',
].join('\n')

describe('applyChecks', () => {
  it('changes exactly one character per entry whose state differs, and nothing else', () => {
    const { body, changed } = applyChecks(REF, BODY, [
      { text: 'first', checked: true },
      { text: 'second', checked: true }, // already ticked — no byte may move
      { text: 'third', checked: true },
    ])

    expect(changed).toBe(2)
    expect(body).toHaveLength(BODY.length)

    const differing = [...body].filter((c, i) => c !== BODY[i])
    expect(differing).toEqual(['x', 'x'])

    // Reverting those two characters yields the original, byte for byte.
    expect(body.replace('- [x] first', '- [ ] first').replace('- [x] third', '- [ ] third')).toBe(BODY)
  })

  it('leaves an entry inside a fence alone', () => {
    const { body } = applyChecks(REF, BODY, [{ text: 'first', checked: true }])
    expect(body).toContain('- [ ] sample')
  })

  it('does not match an entry that exists only inside a fence', () => {
    expect(() => applyChecks(REF, BODY, [{ text: 'sample', checked: true }])).toThrow(NoSuchEntryError)
  })

  it('resolves text that also appears inside a fence to the entry outside it', () => {
    const body = ['- [ ] twin', '```', '- [ ] twin', '```'].join('\n')
    expect(applyChecks(REF, body, [{ text: 'twin', checked: true }]).body).toBe(
      ['- [x] twin', '```', '- [ ] twin', '```'].join('\n'),
    )
  })

  it('says "1 entry", not "1 entries"', () => {
    expect(() => applyChecks(REF, '- [ ] only', [{ text: 'nope', checked: true }])).toThrow(/It has 1 entry\./)
  })

  it('is idempotent: a state an entry already holds moves no bytes', () => {
    const { body, changed } = applyChecks(REF, BODY, [{ text: 'second', checked: true }])
    expect(changed).toBe(0)
    expect(body).toBe(BODY)
  })

  it('preserves an uppercase box it was not asked to change', () => {
    const upper = '- [X] shouty'
    const { body, changed } = applyChecks(REF, upper, [{ text: 'shouty', checked: true }])
    expect(changed).toBe(0)
    expect(body).toBe(upper)
  })

  it('unticks as readily as it ticks', () => {
    const { body, changed } = applyChecks(REF, BODY, [{ text: 'second', checked: false }])
    expect(changed).toBe(1)
    expect(body).toContain('- [ ] second')
  })

  // GitHub stores bodies edited in a browser with CRLF. Splitting on \r?\n and rejoining on \n
  // would move one byte per line and break the invariant on the very bodies it exists for.
  it('keeps CRLF line endings byte for byte', () => {
    const crlf = BODY.split('\n').join('\r\n')
    const { body, changed } = applyChecks(REF, crlf, [{ text: 'first', checked: true }])
    expect(changed).toBe(1)
    expect(body).toHaveLength(crlf.length)
    expect(body.replace('- [x] first', '- [ ] first')).toBe(crlf)
  })

  it('touches only the box, not a bracket pair in the entry text', () => {
    const { body } = applyChecks(REF, '- [ ] keep [ ] this', [{ text: 'keep [ ] this', checked: true }])
    expect(body).toBe('- [x] keep [ ] this')
  })

  it('raises NoSuchEntryError, naming the text and the count, and returns no body', () => {
    expect(() => applyChecks(REF, BODY, [{ text: 'nope', checked: true }])).toThrow(NoSuchEntryError)
    expect(() => applyChecks(REF, BODY, [{ text: 'nope', checked: true }])).toThrow(/"nope".*3 entries/s)
  })

  it('raises AmbiguousEntryError with 1-indexed line numbers', () => {
    const dupe = ['- [ ] same', '- [ ] same'].join('\n')
    expect(() => applyChecks(REF, dupe, [{ text: 'same', checked: true }])).toThrow(AmbiguousEntryError)
    expect(() => applyChecks(REF, dupe, [{ text: 'same', checked: true }])).toThrow(/lines 1, 2/)
  })

  it('counts an entry requested twice with the same state once', () => {
    const { body, changed } = applyChecks(REF, BODY, [
      { text: 'first', checked: true },
      { text: 'first', checked: true },
    ])
    expect(changed).toBe(1)
    expect(body.replace('- [x] first', '- [ ] first')).toBe(BODY)
  })

  // Honouring the last would be a guess, and counting both would report two changes for zero
  // moved bytes, which is exactly the lie the caller's read-back would then trust.
  it('refuses a batch that asks for one entry in both states', () => {
    const conflicting = () =>
      applyChecks(REF, BODY, [
        { text: 'first', checked: true },
        { text: 'first', checked: false },
      ])
    expect(conflicting).toThrow(ConflictingRequestError)
    expect(conflicting).toThrow(/"first".*Nothing was written/s)
  })

  it('is all-or-nothing: one bad request in a batch returns no body at all', () => {
    expect(() =>
      applyChecks(REF, BODY, [
        { text: 'first', checked: true },
        { text: 'nope', checked: true },
      ]),
    ).toThrow(NoSuchEntryError)
  })
})
