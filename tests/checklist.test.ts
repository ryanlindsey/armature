import { describe, expect, it } from 'vitest'
import { codeMask, parseChecklist } from '../server/providers/github/checklist.js'

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

  it('ignores entries inside indented code', () => {
    expect(parseChecklist('- [ ] real\n\n    - [ ] sample')).toHaveLength(1)
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
})
