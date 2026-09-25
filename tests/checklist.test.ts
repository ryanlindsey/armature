import { describe, expect, it } from 'vitest'
import { codeMask } from '../server/providers/github/checklist.js'

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
